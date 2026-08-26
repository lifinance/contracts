# Recomputing diamondCut calldata

`UpdateScriptBase` can rebuild the `diamondCut` calldata for a facet without broadcasting, so a
signer can compare a pending Safe proposal against the calldata this repository's own scripts
produce from the config on `main`. Nothing here changes how a normal deploy or proposal run
behaves: with every variable below unset, the script runs exactly as before.

## Why the inputs are overridable

Three inputs of a normal update run are chosen by whoever prepared the proposal, so a verifier
cannot take them from the local checkout:

| Input | Normal source | Verification source |
| --- | --- | --- |
| Facet address | `deployments/<network>.<suffix>json` | `FACET_ADDRESS_OVERRIDE` — the address the proposal claims, whose bytecode is attested separately |
| Diamond address | `deployments/<network>.<suffix>json` | same file, but pinned with `EXPECTED_DIAMOND_ADDRESS` and bound to the chain the RPC serves via `config/networks.json` |
| Selectors | `out/` on the machine that ran the script | `SELECTOR_ARTIFACTS_DIR` pointing at a build of `main` |

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `FACET_ADDRESS_OVERRIDE` | `address(0)` | Use this facet address instead of the deployments-file entry |
| `EXPECTED_DIAMOND_ADDRESS` | `address(0)` | Revert with `DiamondAddressMismatch` unless the deployments file names this diamond |
| `SELECTOR_ARTIFACTS_DIR` | `./out` (`./out/zksync` for the zkSync scripts) | Directory the selector list is read from |
| `CUT_VERIFICATION_MODE` | `false` | Force no-broadcast, require a pinned block, and require the diamond to have code |
| `DIAMOND_STATE_BLOCK` | `0` | The block number the run must observe |

`config/networks.json` holds no diamond address, so the diamond cannot be cross-checked against
config directly. What it does authorise is the chain: every run asserts that `block.chainid`
matches `.<network>.chainId` and reverts with `NetworkChainIdMismatch` otherwise, which is what
catches a recomputation pointed at the wrong RPC. Networks absent from `config/networks.json` skip
that assertion.

## Pinning the diamond state

`buildDiamondCut` reads the live diamond through the loupe to decide Add/Replace/Remove, so a cut
is not a pure function of `main`: a cut that lands between proposing and verifying legitimately
changes the expected calldata. `CUT_VERIFICATION_MODE=true` therefore refuses to guess.

- No `DIAMOND_STATE_BLOCK` → reverts `DiamondStateNotPinned`.
- `DIAMOND_STATE_BLOCK` set but the fork is at a different height → reverts
  `DiamondStateBlockMismatch(expected, actual)`, which is the signal that the caller forgot
  `--fork-block-number` or that the diamond moved on.

A mismatch is a distinct condition from "the calldata differs": it means the comparison could not
be made reproducibly, not that the proposal is wrong.

## Example

```bash
NETWORK=mainnet \
FILE_SUFFIX= \
USE_DEF_DIAMOND=true \
PRIVATE_KEY=$PRIVATE_KEY \
CUT_VERIFICATION_MODE=true \
DIAMOND_STATE_BLOCK=21000000 \
EXPECTED_DIAMOND_ADDRESS=0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE \
FACET_ADDRESS_OVERRIDE=0x... \
SELECTOR_ARTIFACTS_DIR=/path/to/main-build/out \
forge script script/deploy/facets/UpdateAcrossFacetV4.s.sol \
  --fork-url mainnet \
  --fork-block-number 21000000 \
  --json
```

The `cutData` in the script's return value is the calldata to compare against the proposal.

`ScriptBase` still requires `PRIVATE_KEY` to be set, because it derives `deployerAddress` from it in
its constructor. A verification run never broadcasts, so any throwaway key works — do not pass a
production key to a recomputation.
