# LI.FI Earn Vault Wrapper

Reference overview for the LI.FI Earn Vault Wrapper subsystem
(`src/VaultWrapper/`) — the entry point to the project, and a suitable starting
point for an audit. It ties the components together, states the roles, trust
model, and invariants in one place, and links to the per-contract references.
Read it first, then the contract docs for detail.

## What it is

The Vault Wrapper is a **standalone product**, not part of the LI.FI Diamond
(EIP-2535). It is not a facet, not periphery, not called by the Diamond, and does
not use `diamondCut` or any shared selector/storage layout. Do not assume
Diamond conventions apply.

It wraps an underlying yield source (an ERC-4626 vault today, other sources via
future adapters) in a **per-integrator ERC-4626 vault** that adds a four-type fee
split between the integrator and LI.FI. A single factory deploys instances as
deterministic beacon proxies, so the same integrator gets the same instance
address on every chain. The subsystem has its own governance — an owner that is a
dedicated 48h `TimelockController`, an emergency pauser, and an onboarding
manager.

The subsystem builds on **OpenZeppelin v5** (see
[`108-vault-wrapper`](../../.agents/rules/108-vault-wrapper.md) for the
path-scoped remapping and the `^0.8.29` pragma), while the Diamond stays on the
vendored v4.9.2 core.

## Architecture

```
                        48h TimelockController                emergencyPauser
                (owns factory proxy admin + beacon)       onboardingManager
                                |                                   |
                                v                                   v
   UpgradeableBeacon  <----  LiFiVaultWrapperFactory  ----  global circuit breaker,
                             (TransparentUpgradeableProxy)
   (shared impl)             - underlying allowlist          fee bounds, splits,
        |                    - approved adapters             lifiFeeRecipient
        | upgradeTo          - CREATE2 deploy (namespace)
        v                              |
   LiFiVaultWrapper                    | deploy() -> BeaconProxy per (namespace, adapter, underlying, nonce)
   (implementation)                    v
        ^                    LiFiVaultWrapper instance (ERC-4626 vault, custodies funds)
        | delegatecall                 |
   BeaconProxy instances               |  routes deposit/withdraw/valuation
                                       v
                                  IYieldAdapter  ---- delegatecalled by the instance
                                  (ERC4626Adapter)         |
                                       |                    v
                                  optional IAccessGate   underlying yield source
                                  (ReferenceAccessGate)  (ERC-4626 vault)
```

Every instance reads its factory (an **implementation immutable**, `FACTORY`,
bound to the factory **proxy**) live for the global pause flag, fee bounds, and
`lifiFeeRecipient`. A beacon `upgradeTo` repoints every live instance's logic at
once; a factory-logic upgrade goes through the proxy's `ProxyAdmin` (also
timelock-owned) and is invisible to instances because they hold the stable proxy
address.

## Contracts

| Contract | Path | Custodies funds | Reference |
| --- | --- | --- | --- |
| `LiFiVaultWrapper` | `LiFiVaultWrapper.sol` | **Yes** — holds the yield-source position and transiently the asset | [LiFiVaultWrapper.md](./LiFiVaultWrapper.md) |
| `LiFiVaultWrapperFactory` | `LiFiVaultWrapperFactory.sol` | No | [LiFiVaultWrapperFactory.md](./LiFiVaultWrapperFactory.md) |
| `ERC4626Adapter` | `adapters/ERC4626Adapter.sol` | No (stateless, delegatecalled) | [ERC4626Adapter.md](./ERC4626Adapter.md) |
| `ReferenceAccessGate` | `access/ReferenceAccessGate.sol` | No | see [access gate trust model](./LiFiVaultWrapper.md#access-gate--trust-model) |
| `LibVaultWrapperMath` | `libraries/LibVaultWrapperMath.sol` | No (stateless library) | fee arithmetic — see [LiFiVaultWrapper.md](./LiFiVaultWrapper.md) |
| `LiFiVaultWrapperTypes` | `LiFiVaultWrapperTypes.sol` | No | shared enums/structs/errors/events |
| `IAccessGate` | `interfaces/IAccessGate.sol` | — | access-control boundary |
| `ILiFiVaultWrapper` | `interfaces/ILiFiVaultWrapper.sol` | — | wrapper interface |
| `ILiFiVaultWrapperFactory` | `interfaces/ILiFiVaultWrapperFactory.sol` | — | factory interface |
| `IYieldAdapter` | `interfaces/IYieldAdapter.sol` | — | yield-source abstraction |

`ReferenceAccessGate` is a **template**: each integrator deploys or forks its own
gate. LI.FI does not operate it and does not guarantee its safety.

Tests live under `test/solidity/VaultWrapper/**` (unit, fork, and invariant
suites, plus `mocks/`); the Foundry deploy scripts live under
`script/deploy/vaultWrapper/`.

## Roles and governance

| Role | Held by | Can do | Constraints |
| --- | --- | --- | --- |
| Factory owner | dedicated 48h `TimelockController` | every factory setter (allowlist, adapter approvals, fee bounds, default split, `lifiFeeRecipient`, role rotation), beacon `upgradeTo`, factory-logic upgrade via the proxy `ProxyAdmin` | all changes pass the 48h delay |
| Emergency pauser | EOA/Safe set by the owner | `globalPause` / `globalUnpause` (deposit circuit breaker) | no delay; cannot block withdrawals |
| Onboarding manager | EOA/Safe set by the owner | assign/revoke an integrator's deployer; may deploy any instance | — |
| Approved integrator deployer | per-namespace, set by onboarding manager | `deploy` under its namespace | integrator share ≤ factory default (can give LI.FI more, never less) |
| Instance owner (integrator) | per-vault, set at deploy | `setFeeRate`, `setAccessGate`, receivers, `transferOwnership` | rates ≤ live factory bounds; `renounceOwnership` disabled |

Withdrawals are never gated by pause; the global and per-instance controls only
close the deposit/mint path.

## Fee model (summary)

Four fee types, each split between LI.FI and the integrator at accrual time and
paid out by a permissionless `distributeFees`. **Every fee type is optional** — a
zero rate disables it, so an instance can enable any subset (or none). Each type
is bounded by a bytecode `constant` cap; governance sets adjustable bounds within
it. Because the factory is upgradeable, that cap is a guarantee of the current
factory logic only — a future timelocked factory-logic upgrade could change it.

| Fee type | Cap | Kind |
| --- | --- | --- |
| performance | 50% | high-water-mark dilution (shares) |
| management | 10% | time-based dilution (shares) |
| deposit | 20% | asset-side |
| withdrawal | 20% | asset-side |

LI.FI's share always routes to the factory's live `lifiFeeRecipient`; an
integrator cannot redirect it. The integrator/LI.FI split is validated `< 100%`
only. Full mechanics: [LiFiVaultWrapper.md](./LiFiVaultWrapper.md).

## Trust model

Consolidated from the per-contract docs; each links to its full treatment.

- **Governance is trusted within the 48h delay.** The timelock owns the factory
  (through its proxy `ProxyAdmin`) and the beacon. Two upgrade vectors sit behind
  the delay: a beacon `upgradeTo` replaces instance logic arbitrarily, and a
  factory-logic upgrade through the proxy can rewrite factory rules — including the
  fee caps and split validation that are otherwise fixed in bytecode. The timelock
  is therefore the ultimate authority over every live instance and over the factory
  rules themselves. Every impl the beacon points to must be constructed with the
  same `FACTORY` address (the factory proxy) — see
  [upgradeability](./LiFiVaultWrapper.md#upgradeability-and-the-factory-binding).
- **The per-vault owner (integrator) is trusted not to act against its own
  depositors or against LI.FI's fee recipient.** It installs arbitrary access-gate
  code (no factory allowlist behind the gate) and can move the withdrawal rate
  within the factory bound for a single block; its gate could also sanction the
  live `lifiFeeRecipient` and freeze LI.FI's share-side fees after they are minted
  (deposit and withdrawal fees settle in the asset, which the gate never touches).
  Every such lever is confined to that integrator's own product and is reversible.
  See [access gate trust model](./LiFiVaultWrapper.md#access-gate--trust-model)
  and [fee rate changes](./LiFiVaultWrapper.md#fee-rate-changes--trust-model).
- **Yield sources and adapters are curated by governance.** A wrapper can only be
  deployed over an underlying on the factory allowlist and an approved adapter,
  both set by the factory owner (the 48h timelock) via `setUnderlyingAllowed` /
  `setAdapterApproved`. Integrators cannot introduce their own yield source.
- **Yield sources must be standard ERC-4626** over a non-fee-on-transfer asset.
  Sources that charge deposit/exit fees or credit fewer shares than assets are
  unsupported and require a dedicated adapter — see
  [ERC4626Adapter assumptions](./ERC4626Adapter.md#assumptions).
- **No enforced minimum share supply.** Inflation/donation defense is the
  virtual-share decimals offset (floored at 6) plus a `ZeroSharesMinted` revert.
  Accepted bounds: [donation griefing](./LiFiVaultWrapper.md#donation-griefing--accepted-bounds).

## System invariants

The stateful invariant suite
(`test/solidity/VaultWrapper/invariant/VaultWrapperInvariant.t.sol`) runs these
over both an unlimited source and a fuzzed-liquidity source, with
`fail-on-revert = true`:

- Idle asset balance equals exactly the deposit/withdrawal fees booked but not
  yet distributed.
- The wrapper's own share balance equals exactly the performance/management
  fee-shares booked but not yet distributed.
- Depositors can never extract, in aggregate, more than was ever deposited plus
  injected yield.
- Total share supply is fully accounted across the known holder set — no shares
  minted or burned elsewhere.
- Liquidity-aware `maxRedeem` never over-reports what the source can currently
  pay, and a `redeem` bounded to `maxRedeem` never reverts.
- The performance high-water mark never regresses.

## External dependencies

- **OpenZeppelin v5** — `@openzeppelin/contracts` core and
  `@openzeppelin/contracts-upgradeable` (`ERC4626Upgradeable`,
  `Ownable2StepUpgradeable`, `UpgradeableBeacon`, `BeaconProxy`,
  `TransparentUpgradeableProxy`, `ProxyAdmin`, `TimelockController`, `Create2`).
- **Solady** — `MetadataReaderLib` (reads underlying token metadata defensively).
- **Optional, integrator-side** — `ReferenceAccessGate` can back `isSanctioned`
  with an external Chainalysis `SanctionsList` (identical signature); the bundled
  template uses owner-managed flags.

## Deployment and upgrade model

- Instances are OZ `BeaconProxy` contracts deployed via `CREATE2`; the salt is
  seeded by the chain-independent `bytes32 namespace`, giving cross-chain address
  parity when the factory and beacon sit at matching addresses per chain (the
  CREATE3 system deploy provides this).
- A wrapper's `adapter` (like `underlying` and `owner`) is bound once in
  `initialize` and has **no per-instance setter** — it cannot be re-pointed on a
  live instance. Changing the adapter a wrapper routes through is only reachable
  through a beacon `upgradeTo` to new implementation logic, i.e. under the 48h
  timelock.
- The factory is deployed behind a `TransparentUpgradeableProxy`; its logic is
  upgradeable through the proxy's `ProxyAdmin`, owned by the 48h timelock (the
  same authority that owns the factory and beacon). The logic contract's
  initializers are disabled at construction; factory state is set once through
  `initialize` on the proxy at deploy. Instances bind to the proxy address, so a
  factory-logic upgrade is transparent to them.
- The factory (proxy + logic) and beacon are deployed and wired by
  `script/deploy/vaultWrapper/DeployLiFiVaultWrapperFactory.s.sol` and owned by
  the 48h timelock. Per-network parameters come from `config/vaultWrapper.json`.
- Factory config is timelock-owned: `UpdateVaultWrapperConfig.s.sol` does not
  broadcast; it emits idempotent `scheduleBatch`/`executeBatch` calldata for the
  multisig. No wrapper can deploy until the first batch (one approved adapter +
  one allowed underlying) executes after the 48h delay.
- Subsystem-specific deploy conventions:
  [`108-vault-wrapper`](../../.agents/rules/108-vault-wrapper.md).

## Per-contract references

- [LiFiVaultWrapper](./LiFiVaultWrapper.md) — the per-instance ERC-4626 vault
  (entry/exit semantics, fees, access gate, inflation protection).
- [LiFiVaultWrapperFactory](./LiFiVaultWrapperFactory.md) — deploys and configures
  instances.
- [ERC4626Adapter](./ERC4626Adapter.md) — the first yield adapter.
