---
name: Architectural principles
description: Core architectural principles for Diamond, separation of concerns, and governance
globs:
  - '**/*'
alwaysApply: true
---

## Diamond Architecture ([CONV:ARCH-DIAMOND])

- Single Diamond (EIP-2535) as main entrypoint for all protocol interactions.
- Facets provide modular functionality grouped by concern (bridges, swaps, receivers, admin, etc.).
- Libraries centralize cross-cutting logic, storage, and validation.
- Periphery contracts handle specialized flows that don't belong directly in the Diamond.
- Maintain clear mapping from external actions to specific facets and events.
- Treat selector layout and storage as critical invariants for upgrades.

## Separation of Concerns ([CONV:ARCH-SEPARATION])

- **Facets** (`src/Facets/`): Diamond entrypoints - thin, integration-specific logic only.
- **Periphery** (`src/Periphery/`): Standalone helper contracts called by Diamond.
- **Helpers** (`src/Helpers/`): Inheritable utility contracts.
- **Security** (`src/Security/`): Governance/timelock contracts.
- Do not move logic across layers without clear architectural reason.
- Delegate complex logic to libraries (`LibAsset`, `LibSwap`, `LibAllowList`, `SwapperV2`, `Validatable`) and helper contracts.

## Governance and Security ([CONV:ARCH-GOVERNANCE])

- Safe multisigs and timelock controllers are mandatory security mechanisms that cannot be bypassed or weakened.
- Never add upgrade or admin shortcuts that bypass existing governance flows (e.g., direct owner functions, emergency upgrade paths that skip timelock).
- Upgrades must respect selector layout, storage layout, timelock delay, and quorum/approval rules.

## Protocol Events ([CONV:EVENTS])

- `LiFiTransferStarted`: must be emitted at the end of the internal `_startBridge` function in facets, after all validations and external bridge calls have completed successfully.
- `LiFiTransferCompleted`: only in Executor (`src/Periphery/Executor.sol`).
- `LiFiTransferRecovered`: only in Receiver contracts (`src/Periphery/Receiver*.sol`).
- `GenericSwapCompleted`: for same-chain swaps.
- For non-EVM chains (`bridgeData.receiver == NON_EVM_ADDRESS`), emit `BridgeToNonEVMChainBytes32` with transactionId, destinationChainId, and non-EVM receiver (bytes32).

## Implementation Guidelines

- When introducing new facets/periphery contracts, mirror existing directory and naming patterns and prefer using `plop` templates and documented patterns over bespoke structures.
- For any change that could affect selector layout, upgrade flows, or storage layout, cross-check relevant rules and documentation and call out the impact explicitly before editing.
