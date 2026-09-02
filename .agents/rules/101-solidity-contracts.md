---
name: Solidity contracts
description: Production Solidity contracts/interfaces in src
globs:
  - 'src/**/*.sol'
  - '!src/**/*.s.sol'
  - '!src/**/*.t.sol'
paths:
  - 'src/**/*.sol'
---

- Do not modify production contracts in `src/` unless explicitly requested; changes to production logic could introduce bugs and may be overlooked.
- NatSpec required on contracts/interfaces in `src/`: `@title`, `@author LI.FI (https://li.fi)`, `@notice`, `@custom:version X.Y.Z`; document all public/external functions with params/returns.
- Bug bounty clarity: In contract NatSpec, explicitly document whether the contract is intended to hold/custody funds. If it is **not** designed to hold funds, state that clearly (e.g., “This contract is not intended to custody user funds / hold balances; any funds held are incidental (e.g., transient during execution) and should not persist.”). If it _is_ designed to hold funds (e.g., `FeeCollector`), describe what funds it holds and under what conditions.
- Apply Diamond patterns with existing libs (LibAsset/LibSwap/LibAllowList, Validatable/SwapperV2); prefer parameters over `msg.sender` for refund addresses.
- Events: In Solidity 0.8.17, you **must not** emit events using `ContractName.EventName` syntax (e.g., `emit SomeContract.SomeEvent(...)`). Events must be defined in the same contract where they're emitted, or defined in an interface that the contract uses, and then emitted using just the event name (e.g., `emit SomeEvent(...)`). This prevents compilation errors and ensures 0.8.17 compatibility.
- When adding a new deployable contract that has constructor arguments, add/update its entry in `script/deploy/resources/deployRequirements.json` so deploy scripts validate the presence of required constructor args.
- Constructor args that bind an **external protocol address** (spoke pool, vault, router, portal) must be stored in a `public immutable` and annotated with `getter` in that same `deployRequirements.json` entry, so `immutable-bindings-match-config` compares the bound address against config on every chain. A `private`/`internal` immutable exposes nothing to read and leaves the binding permanently unverifiable — immutably, since only a redeploy can change it. `immutableGetterCoverage.test.ts` fails on a public immutable address getter that is neither annotated nor recorded as exempt; see `601-healthcheck-invariants`.
- When adding a new deployable contract, create a corresponding documentation page in `docs/` (mirroring existing docs conventions for new integrations/contracts).
