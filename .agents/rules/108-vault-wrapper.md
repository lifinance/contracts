---
name: Vault Wrapper subsystem
description: Constraints for the standalone LI.FI Earn Vault Wrapper; activates when editing its source, tests, or deploy scripts.
globs:
  - 'src/VaultWrapper/**'
  - 'test/solidity/VaultWrapper/**'
  - 'script/deploy/vaultWrapper/**'
paths:
  - 'src/VaultWrapper/**'
  - 'test/solidity/VaultWrapper/**'
  - 'script/deploy/vaultWrapper/**'
---

The LI.FI Earn Vault Wrapper is a standalone product, not part of the Diamond
(see `[CONV:ARCH-VAULTWRAPPER]`). The constraints below are subsystem-specific
and counter-intuitive against the repo's Diamond-era conventions.

## Deploy scripts ([CONV:VW-DEPLOY-DIR])

- Vault-wrapper Foundry deploy scripts live in their own `script/deploy/vaultWrapper/`,
  NOT in `script/deploy/facets/`. They are standalone `forge-std/Script`s — they do
  not extend `DeployScriptBase` and do not read the Diamond config files
  (`networks.json`/`global.json`/`deployRequirements.json`).
- Per-network parameters come from the subsystem's own scoped config file,
  `config/vaultWrapper.json` (network-first per `[CONV:CONFIG-STRUCTURE]`), read by
  `NETWORK` key; the only env vars are `PRIVATE_KEY`, `NETWORK`, and `DEPLOYSALT`
  (plus optional per-script inputs like `FACTORY`/`TIMELOCK`/`ADAPTER`). Duplicating
  the CREATE3 factory address into `vaultWrapper.json` (rather than reading
  `networks.json`) is the intended cost of keeping the subsystem self-contained.
- Deploy deterministically through the shared CREATE3 factory so mainnets sharing a
  factory get matching system addresses (aligns with the namespace/address-parity
  identity design). Deploying via the CREATE3 proxy is safe only because every
  ownership/role is set from a constructor argument, never `msg.sender`.
- Factory config is timelock-owned: the seeding/reconcile script does not broadcast;
  it emits `scheduleBatch`/`executeBatch` calldata for the multisig, and is
  idempotent (diffs desired config against live state). No wrapper can deploy until
  the first batch (adapter approval + one allowed underlying) is executed after 48h.
- They are run by explicit path (`forge script script/deploy/vaultWrapper/<Name>.s.sol`),
  and the contract is named after the file so it resolves without a `:Contract` suffix.
- Consequence (intended): the Diamond's interactive deploy tooling
  (`deploySingleContract.sh`, `scriptMaster.sh`) only `ls`-es `script/deploy/facets/`,
  so it will not list these — deploy the subsystem by explicit path. Do not move
  these scripts into `facets/` to gain that auto-discovery; the subsystem's deploy
  flow is deliberately separate. MongoDB deployment-log sync
  (`update-deployment-logs.ts`) stays part of an actual production rollout, not these
  scripts.

## Beacon and clones ([CONV:VW-BEACON])

- The implementation sits behind an OZ `UpgradeableBeacon`, instantiated as
  `UpgradeableBeacon(implementation, initialOwner)` (v5's two-arg constructor —
  set the owner at construction, not via a follow-up `transferOwnership`). This is
  the locked choice — not a custom beacon. Instances are OZ `BeaconProxy`
  contracts deployed deterministically via OZ `Create2` (`_proxyInitCode()` is
  shared by `deploy` and `predictAddress` so the init-code hash matches on both
  paths); they re-read the impl every call, and per-instance identity is set
  write-once in `initialize`.
- Beacon `upgradeTo` is owner-gated and the owner is the subsystem governance
  (a dedicated 48h timelock). Never add an upgrade path that bypasses it.

## OpenZeppelin version ([CONV:VW-OZ-VERSION])

- The subsystem builds on **OpenZeppelin v5** — `@openzeppelin/contracts-upgradeable`
  plus a dedicated v5 core in `lib/openzeppelin-contracts-v5` — while the Diamond
  stays on the vendored **v4.9.2** core. Use v5's surface (core `ReentrancyGuard`,
  plain `IERC20`/`SafeERC20`/`Initializable`); don't mix the two majors.
- Version routing is by **path-scoped remappings** in `remappings.txt`:
  `@openzeppelin/contracts/` resolves to v5 for `src/VaultWrapper/`,
  `test/solidity/VaultWrapper/`, `script/deploy/vaultWrapper/`, and the upgradeable
  lib itself; the global stays v4.9.2. A subsystem file moved outside these prefixes
  silently picks up v4 — keep VaultWrapper code under the scoped paths.
- The repo does not enable `via_ir`; v5's namespaced-storage accessors raise stack
  pressure, so keep `initialize`/large functions shallow rather than enabling it.
- **Pragma floor is `^0.8.24`, not the repo-wide `^0.8.17`** (a deliberate override of
  `[CONV:LICENSE]`'s pragma rule for this subsystem only): OZ v5.6.1's
  `ERC4626Upgradeable` itself requires `^0.8.24` and the toolchain emits `mcopy`, so
  declaring `^0.8.17` would be a provably false floor. Every file under `src/VaultWrapper/`,
  `test/solidity/VaultWrapper/`, and `script/deploy/vaultWrapper/` pins `^0.8.24`. The
  honesty of this floor is enforced by the `solc_floor_vaultwrapper` Foundry profile
  (solc 0.8.24 + evm cancun), a second build step in `solc-floor-build.yml`.

## Identity and onboarding ([CONV:VW-IDENTITY])

- Integrator identity is a chain-independent `bytes32 namespace` (e.g.
  "Coinbase") that seeds the CREATE2 salt, giving address parity across chains.
- `approvedIntegratorDeployer[namespace]` (set by the onboarding manager) binds
  a namespace to its deployer — anti-squatting. The per-vault controller is a
  separate, rotatable `vaultWrapperAdmin` kept OUT of the salt (opsec).

## Fees ([CONV:VW-FEES])

- Four fee types — performance, management, deposit, withdrawal — each bounded
  by an immutable bytecode cap (50% / 10% / 20% / 20%); governance sets
  adjustable bounds within the cap; disabled fee types carry a zero rate.
- The integrator/LI.FI split is validated `< 100%` only — there is deliberately
  no additional ceiling. LI.FI's share routes to a factory-governed
  `lifiFeeRecipient` read live, so integrators cannot redirect it via deploy params.

## Yield adapters ([CONV:VW-ADAPTERS])

- Asset/runtime logic for a yield source is abstracted behind `IYieldAdapter`
  (`ERC4626Adapter` is the first). New yield sources are added via new adapters,
  not by changing the factory or adding a second beacon.

Stage status, ticket breakdown, and branch topology are intentionally NOT here
(they rot) — the Linear project "Vault Wrapper V1 Implementation" is the source
of truth.
