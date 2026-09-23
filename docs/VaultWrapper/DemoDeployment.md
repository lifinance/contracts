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
- `MAINNET_ETHERSCAN_API_KEY` set — `foundry.toml` uses it for Base verification.
- `DEV_WALLET` set to the devWallet address (step 3 passes it as the per-vault admin).
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

**`--verify` will fail on this subsystem.** The OpenZeppelin version routing is a
context-dependent remapping (`src/VaultWrapper/:@openzeppelin/contracts/=…-v5/…`,
see `[CONV:VW-OZ-VERSION]`), and `forge verify-contract` ignores the context prefix
when it builds the standard-json input. It re-resolves the v5 import graph through
the global v4.9.2 remapping, drops the files that only exist in v5, and Etherscan
rejects the result with `Source "lib/openzeppelin-contracts-v5/…" not found`.

Work around it by pointing the global remapping at v5 for the duration of the
verification, then restoring it:

```bash
sed -i.bak 's|^@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/$|@openzeppelin/contracts/=lib/openzeppelin-contracts-v5/contracts/|' remappings.txt
forge verify-contract <address> <path:ContractName> --chain base --watch \
  --constructor-args <abi-encoded-args>
git checkout -- remappings.txt && forge build
```

The rebuild matters: the verification runs recompile `out/` under the override.

`--guess-constructor-args` is not an option — it needs Etherscan's
`getcontractcreation` endpoint, which is a paid plan on Base. Pass args explicitly.
Because CREATE3 deploys through an inner call, the args are the tail of the
`deploy(bytes32,bytes)` payload in `broadcast/…/8453/run-latest.json` rather than
the tail of the transaction's own creation code.

## 2. Change the factory config later (not needed for a fresh deploy)

Step 1 already seeded adapter approval, the underlying allowlist, fee bounds, and the
default split from `config/vaultWrapper.json` — the deploy script passes them to
`initialize` and then asserts them back, so a fresh system can deploy wrappers
immediately. Skip to step 3 unless you need to change something after the fact.

Every later change is timelock-owned. Edit the `basedemo` entry, then build the batch
(this script does not broadcast — it prints calldata):

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

The script diffs desired config against live state, so right after step 1 it reports
the config is already in sync and emits nothing.

## 3. Deploy the two wrappers

The devWallet is the onboarding manager, which may deploy under any namespace, so no
`setApprovedIntegratorDeployer` call is needed. Both wrappers carry identical config
and differ only in `underlying`.

Fee rates are `[performance, management, deposit, withdrawal]` in bps:
`[1000, 100, 0, 0]` — 10% of gains above the high-water mark and 1%/yr on AUM, with
entry and exit free. `integratorShareBps` is `65535` (`type(uint16).max`) per fee
type, which means "use the factory default" — `defaultIntegratorShareBps` in the
`basedemo` config, 8000 — so the integrator
wallet takes 80% of each fee and `lifiFeeRecipient` takes 20%. `accessGate` is the
zero address, i.e. permissionless.

```bash
NAMESPACE=$(cast format-bytes32-string "LiFiDemo")
SIG='deploy((bytes32,address,address,address,uint256,(uint16[4]),uint16[4],address,(address,uint16)[]))'

# Morpho leg
cast send <factory> "$SIG" \
  "($NAMESPACE,$DEV_WALLET,<erc4626Adapter>,0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A,0,([1000,100,0,0]),[65535,65535,65535,65535],0x0000000000000000000000000000000000000000,[($INTEGRATOR_WALLET,10000)])" \
  --rpc-url base --private-key $PRIVATE_KEY

# Fluid leg — identical except the underlying
cast send <factory> "$SIG" \
  "($NAMESPACE,$DEV_WALLET,<erc4626Adapter>,0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169,0,([1000,100,0,0]),[65535,65535,65535,65535],0x0000000000000000000000000000000000000000,[($INTEGRATOR_WALLET,10000)])" \
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
