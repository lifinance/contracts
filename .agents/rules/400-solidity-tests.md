---
name: Solidity tests
description: Foundry test structure, naming, and expectations
globs:
  - 'test/**/*.sol'
paths:
  - 'test/**/*.sol'
---

## Test Structure ([CONV:TESTS])

- Tests under `test/solidity/`, mirroring `src/`.
- Require `setUp()`; mirror `src/` layout; call `initTestBase()` when inheriting `TestBase` directly or indirectly; label actors with `vm.label`.
- When tests do not need mainnet state, inherit `TestBaseLocal` and call `initTestBaseLocal()` instead of `initTestBase()`.
- For facet tests, inherit from `TestBaseFacet` rather than `TestBase`, since standard facet functions need to be overridden.
- Import ordering: system libraries first (e.g., `forge-std`, `ds-test`), then project files (e.g., `lifi/`, `test/`).

## Real Contracts vs Mocks ([CONV:FORK-FIRST])

- Facet tests run on a mainnet fork (`TestBase`): call the **real deployed third-party contract** on that fork. Mocking the counterparty defeats the point of forking — a fork test against a mock proves nothing the same test would not prove on a plain local node. Mocks are a **last resort**, permitted only after the gate-lifting techniques below have been tried and shown infeasible.
- If the counterparty verifies signatures produced by **our own backend** (facet has a configurable signer), that is NOT a reason to mock — set a test signer and sign in-test (`TestEIP712` + `Test<Protocol>BackendSig` helper pattern) against the counterparty's real, live-computed domain.
- If the real contract gates calls on third-party-controlled state (a trusted signer, an allowlist, a permissioned caller, missing route/config), **lift the gate on the fork** instead of mocking. The toolbox, in order of preference:
  - `vm.prank` the contract's owner/admin and call its real setter (e.g. rotate its quote signer to a test key, approve a route, set a gas limit),
  - override storage directly via `stdstore`/`vm.store` when no setter exists (signer slots, allowlist mappings, balance slots; `deal()` for token balances),
  - pin `customBlockNumberForForking` to a block at which the contract is deployed and configured — the suite's default fork block is never a reason to mock,
  - derive live parameters from the protocol's own view/quote functions (messaging fees, rates) instead of inventing constants.
- Replacing the counterparty's code counts as mocking and falls under the same bar: no `vm.etch` over the real contract, no `vm.mockCall` on its functions, no "real address, fake behavior" hybrids.
- When setUp depends on pinned on-chain config (an approved route, a set gas limit, a rotated signer), assert that config in `setUp()` so a future re-pin fails loudly there instead of deep inside a funds-flow assert.
- Mocking the third-party contract is acceptable **only** when real calls stay infeasible after exhausting the toolbox above, e.g.:
  - the gate is `immutable`/hardcoded in bytecode with no settable or storage-writable path,
  - its behavior depends on live off-chain state that cannot be pinned at a fork block (auctions, oracle-priced fees),
  - no forkable network has the contract deployed.
- Every mock must:
  - live in `test/solidity/utils/Mock<Name>.sol` and implement the real interface from `src/Interfaces/`,
  - mirror the real contract's **funds flow and reverts** (pull tokens the same way, enforce the same `msg.value` gating) — not merely record calls or emit events,
  - state in its NatSpec why the real contract cannot be used **and which gate-lifting techniques were ruled out**.
- When a facet's unit tests mock the counterparty, the PR must document why gate-lifting was infeasible, and real-contract coverage must exist elsewhere (e.g. a demo script executed against the deployed contract) with the PR referencing it.

## Test Naming

- Function names: `test_` (success), `testRevert_` (failure — **required** for any test that calls `vm.expectRevert`), `testBase_` (base).
- Segments after the prefix must be PascalCase (e.g. `test_SucceedsWhenSwappingExactInput`).
- No underscores within a segment — the only underscore is the one after the prefix.
- Name the user- or protocol-meaningful case first (asset, chain, outcome) rather than echoing implementation details. Prefer `testRevert_NativeTransferFailed` over `testRevert_FailsIfExternalCallFails`.
- When editing a test file, align any ambiguous or inconsistently-named existing tests to this convention.

## Test Structure and Assertions

- Structure: setup → execute → assert; use `vm.startPrank` / `vm.stopPrank`, labels, base inits.
- Always assert specific revert reasons; use `vm.expectRevert` with specific reason.
- Use `vm.expectEmit(true, true, true, true, <addr>)` for events.
- Apply [CONV:BLANKLINES] test rules (gap after `vm.expectRevert` before call, gap before assertions/events).

## Test Helpers

- For whitelist flows inherit `TestWhitelistManagerBase` and use `addToWhitelist` / `setFunctionWhitelistBySelector` helpers.
- If a facet does not support native tokens, it must override tests such as `testBase_CanSwapAndBridgeNativeTokens` and `testBase_CanBridgeNativeTokens` with `public override` and include a comment explaining why the test is intentionally skipped (e.g., "facet does not support native tokens").
- Before writing new tests, check existing base tests (e.g. `TestBaseFacet`) to ensure no duplicate tests are created.

## Error Testing

- Generic errors live in `src/Errors/GenericErrors.sol`. Descriptive PascalCase; no strings.
- New generic errors: bump `@custom:version`.
- Facet-specific errors live in the facet files; use for protocol-specific logic.

## Post-Test Actions

- After test changes, run `forge test` (or narrowed scope) or state which suites remain.
