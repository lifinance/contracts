# Vault Wrapper Demo Deployment (Base)

> **Unaudited, demo-only.** This deployment exists to showcase the vault wrapper
> flow to a prospect (EXSC-1036). It is governed by a dev EOA behind a 10-second
> timelock and its wrappers are permissionless — anyone who knows an address can
> deposit real funds into unaudited code. Do not reference these addresses from
> production systems.

Live addresses, demo-day notes, and the prospect context live on
[EXSC-1036](https://linear.app/lifi-linear/issue/EXSC-1036). This file is the
durable procedure.

## Configuration

Everything per-network is in `config/vaultWrapper.json` under `basedemo`:
`timelockDelaySeconds` is 10 (production networks use 172800), and all four role
addresses are the devWallet, so one key proposes, executes, onboards, and pauses.
`NETWORK=basedemo` selects that entry; the RPC is still Base mainnet.

The two allowed underlyings are ERC-4626 vaults over the same USDC
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), so one `ERC4626Adapter` covers both
and a splitter has a single input token:

| Leg    | Vault            | Address                                      |
| ------ | ---------------- | -------------------------------------------- |
| Morpho | Spark USDC Vault | `0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A` |
| Fluid  | fUSDC            | `0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169` |

## Prerequisites

- `ETH_NODE_URI_BASE` set, and `PRIVATE_KEY` holding the devWallet key with Base ETH.
- An `INTEGRATOR_WALLET` address, distinct from the devWallet, to receive the
  integrator fee share — with both on the same address the 80/20 split is invisible.

## 1. Deploy the system

```bash
NETWORK=basedemo PRIVATE_KEY=$PRIVATE_KEY \
  forge script script/deploy/vaultWrapper/DeployLiFiVaultWrapperFactory.s.sol \
  --rpc-url base --broadcast --verify
```

Records `Timelock`, `Implementation`, `Beacon`, `FactoryLogic`, `Factory`,
`ProxyAdmin`, and `ERC4626Adapter` in the run log. The `Factory` (proxy) address is
the one everything else uses.

Contracts are created through the CREATE3 factory rather than directly by the
script's transactions, so `--verify` may skip them. Verify any that were missed:

```bash
forge verify-contract <address> <path:ContractName> \
  --chain base --watch --constructor-args "$(cast abi-encode 'c(...)' ...)"
```

## 2. Seed the factory config through the timelock

The factory is timelock-owned, so adapter approval, the underlying allowlist, fee
bounds, and the default split cannot be set directly. Build the batch (this script
does not broadcast — it prints calldata):

```bash
NETWORK=basedemo FACTORY=<factory> ADAPTER=<erc4626Adapter> \
  forge script script/deploy/vaultWrapper/UpdateVaultWrapperConfig.s.sol \
  --rpc-url base
```

Send the emitted `scheduleBatch` calldata to the timelock, wait out the 10-second
delay, then send the emitted `executeBatch` calldata:

```bash
cast send <timelock> <scheduleCalldata> --rpc-url base --private-key $PRIVATE_KEY
sleep 11
cast send <timelock> <executeCalldata>  --rpc-url base --private-key $PRIVATE_KEY
```

Re-running the script is safe: it diffs desired config against live state and emits
a smaller batch, or reports the config is already in sync.

## 3. Deploy the two wrappers

The devWallet is the onboarding manager, which may deploy under any namespace, so no
`setApprovedIntegratorDeployer` call is needed. Both wrappers carry identical config
and differ only in `underlying`.

Fee rates are `[performance, management, deposit, withdrawal]` in bps:
`[1000, 100, 10, 10]` — 10% of gains above the high-water mark, 1%/yr on AUM, and
0.1% on entry and exit. `integratorShareBps` is `65535` (`type(uint16).max`) per fee
type, which means "use the factory default", currently 8000 — so the integrator
wallet takes 80% of each fee and `lifiFeeRecipient` takes 20%. `accessGate` is the
zero address, i.e. permissionless.

```bash
NAMESPACE=$(cast format-bytes32-string "LiFiDemo")
SIG='deploy((bytes32,address,address,address,uint256,(uint16[4]),uint16[4],address,(address,uint16)[]))'

# Morpho leg
cast send <factory> "$SIG" \
  "($NAMESPACE,$DEV_WALLET,<erc4626Adapter>,0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A,0,([1000,100,10,10]),[65535,65535,65535,65535],0x0000000000000000000000000000000000000000,[($INTEGRATOR_WALLET,10000)])" \
  --rpc-url base --private-key $PRIVATE_KEY

# Fluid leg — identical except the underlying
cast send <factory> "$SIG" \
  "($NAMESPACE,$DEV_WALLET,<erc4626Adapter>,0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169,0,([1000,100,10,10]),[65535,65535,65535,65535],0x0000000000000000000000000000000000000000,[($INTEGRATOR_WALLET,10000)])" \
  --rpc-url base --private-key $PRIVATE_KEY
```

Each call emits `WrapperDeployed` with the instance address. Record both on EXSC-1036.

## 4. Teardown

After the demo, stop deposits across every instance. Withdrawals stay open, so
anyone holding shares can still exit:

```bash
cast send <factory> "globalPause()" --rpc-url base --private-key $PRIVATE_KEY
```

The `basedemo` config entry stays in the repo so the deployment remains reproducible
and this procedure keeps working for a repeat demo.
