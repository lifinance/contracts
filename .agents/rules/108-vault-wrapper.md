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
  not extend `DeployScriptBase` or read the Diamond config files
  (`networks.json`/`global.json`/`deployRequirements.json`); plain env vars only.
- They are run by explicit path (`forge script script/deploy/vaultWrapper/<Name>.s.sol`),
  and the contract is named after the file so it resolves without a `:Contract` suffix.
- Consequence (intended): the Diamond's interactive deploy tooling
  (`deploySingleContract.sh`, `scriptMaster.sh`) only `ls`-es `script/deploy/facets/`,
  so it will not list these — deploy the subsystem by explicit path. Do not move
  these scripts into `facets/` to gain that auto-discovery; the subsystem's deploy
  flow is deliberately separate (full integration tracked in S14).

## Beacon and clones ([CONV:VW-BEACON])

- The implementation sits behind an OZ `UpgradeableBeacon` (the locked choice —
  not a custom beacon). Instances are Solady `LibClone` ERC-1967 beacon proxies
  that re-read the impl every call; per-clone identity is set write-once in
  `initialize` (bytecode-immutable CWIA identity is a later concern).
- Beacon `upgradeTo` is owner-gated and the owner is the subsystem governance
  (a dedicated 48h timelock). Never add an upgrade path that bypasses it.

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
  `lifiFeeRecipient` read live, so integrators cannot redirect it via initData.

## Yield adapters ([CONV:VW-ADAPTERS])

- Asset/runtime logic for a yield source is abstracted behind `IYieldAdapter`
  (`ERC4626Adapter` is the first). New yield sources are added via new adapters,
  not by changing the factory or adding a second beacon.

Stage status, ticket breakdown, and branch topology are intentionally NOT here
(they rot) — the Linear project "Vault Wrapper V1 Implementation" is the source
of truth.
