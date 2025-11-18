# Errors & Testing

[CONV:ERR-GENERIC]

- Generic errors live in `src/Errors/GenericErrors.sol`. Descriptive PascalCase; no strings.

- New generic errors: bump `@custom:version`.

[CONV:ERR-FACET]

- Facet-specific errors live in the facet files; use for protocol-specific logic.

[CONV:TESTS]

- Tests under `test/solidity/`, mirroring `src/`.

- Function names: `test_` (success), `testRevert_` (failure), `testBase_` (base).

- Always assert specific revert reasons; use `vm.expectEmit(true,true,true,true,<addr>)`.

- Structure: setup → execute → assert; use `vm.startPrank` / `vm.stopPrank`, labels, base inits.
