---
name: Solidity tests
description: Foundry test structure, naming, and expectations
globs:
  - 'test/**/*.t.sol'
paths:
  - 'test/**/*.t.sol'
---

## Test Structure ([CONV:TESTS])

- Tests under `test/solidity/`, mirroring `src/`.
- Require `setUp()`; mirror `src/` layout; call `initTestBase()` when inheriting `TestBase` directly or indirectly; label actors with `vm.label`.
- For facet tests, inherit from `TestBaseFacet` rather than `TestBase`, since standard facet functions need to be overridden.
- Import ordering: system libraries first (e.g., `forge-std`, `ds-test`), then project files (e.g., `lifi/`, `test/`).

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
