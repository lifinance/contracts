# Recomputing diamondCut calldata

`UpdateScriptBase` can rebuild the `diamondCut` calldata for a facet without broadcasting, so a
signer can compare a pending Safe proposal against the calldata this repository's own scripts
produce from the config on `main`. With every variable below unset the cut calldata is exactly
what it was before, with one deliberate exception: every run, recompute or not, now asserts that
`block.chainid` matches `config/networks.json` and reverts `NetworkChainIdMismatch` when it does
not. That can only fire when the script is pointed at the wrong chain.

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
| `FACET_ADDRESS_OVERRIDE` | `address(0)` | Use this facet address instead of the deployments-file entry. Required in verification mode (`FacetAddressOverrideRequired` if unset) |
| `EXPECTED_DIAMOND_ADDRESS` | `address(0)` | Revert with `DiamondAddressMismatch` unless the deployments file names this diamond. Required in verification mode (`ExpectedDiamondAddressRequired` if unset) |
| `SELECTOR_ARTIFACTS_DIR` | `./out` (`./out/zksync` for the zkSync scripts) | Directory the selector list is read from |
| `CUT_VERIFICATION_MODE` | `false` | Force no-broadcast, require a pinned block, require the two address overrides, and require the diamond to have code |
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
- No `FACET_ADDRESS_OVERRIDE` → reverts `FacetAddressOverrideRequired`.
- No `EXPECTED_DIAMOND_ADDRESS` → reverts `ExpectedDiamondAddressRequired`.

A mismatch is a distinct condition from "the calldata differs": it means the comparison could not
be made reproducibly, not that the proposal is wrong.

`SELECTOR_ARTIFACTS_DIR` stays optional. A verifier who built `main` into the default `out/`
(or `out/zksync`) with the network's compiler group is using a trustworthy tree. The directory
still has to come from that group — see below.

Two update scripts resolve facet addresses themselves rather than through `update()`, so the
overrides never reach them: `UpdateCoreFacets.s.sol` and `UpdateDiamondLoupeFacet.s.sol`. Both
revert with `VerificationModeNotSupported` instead of returning a result that only looks verified.

## Building the selector artifacts

Production compiles once per EVM-version group (`script/deploy/resources/deployGroupingHelpers.sh`).
A recompute must use the same group as the network, then point `SELECTOR_ARTIFACTS_DIR` at that
`out/`. Building `main` with the default `foundry.toml` (solc 0.8.29 / cancun) and using that tree
for a london or zkEVM network is not what `main` would have produced for that chain.

| Group | How a network lands in it | Build | `SELECTOR_ARTIFACTS_DIR` |
| --- | --- | --- | --- |
| london | `targetEvmVersion` is `london` | `forge build --use 0.8.17 --evm-version london -o /path/to/main-london/out` | `/path/to/main-london/out` |
| cancun | `targetEvmVersion` is `cancun` | `forge build --use 0.8.29 --evm-version cancun -o /path/to/main-cancun/out` | `/path/to/main-cancun/out` |
| zkevm | `isZkEVM` is `true` (`zksync`, `abstract`, `lens`) | `FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync --skip test` | `./out/zksync` (the zkSync profile default; omit the env var if the build wrote there) |

Use a dedicated `-o` directory for london and cancun so the two solc pins do not overwrite each
other. Do not use `FOUNDRY_PROFILE=solc_floor` to run `forge script`: that profile skips
`script/**`. It is fine for producing london facet artifacts only.

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
SELECTOR_ARTIFACTS_DIR=/path/to/main-cancun/out \
forge script script/deploy/facets/UpdateAcrossFacetV4.s.sol \
  --fork-url mainnet \
  --fork-block-number 21000000 \
  --json
```

zkEVM networks (`zksync`, `abstract`, `lens`) have to use the foundry-zksync binary, the zkSync
script copy, and zkSync artifacts:

```bash
NETWORK=zksync \
FILE_SUFFIX= \
USE_DEF_DIAMOND=true \
PRIVATE_KEY=$PRIVATE_KEY \
CUT_VERIFICATION_MODE=true \
DIAMOND_STATE_BLOCK=21000000 \
EXPECTED_DIAMOND_ADDRESS=0x... \
FACET_ADDRESS_OVERRIDE=0x... \
SELECTOR_ARTIFACTS_DIR=./out/zksync \
FOUNDRY_PROFILE=zksync \
./foundry-zksync/forge script script/deploy/zksync/UpdateAcrossFacetV4.zksync.s.sol \
  --fork-url zksync \
  --fork-block-number 21000000 \
  --zksync \
  --json
```

The `cutData` in the script's return value is the calldata to compare against the proposal.

`ScriptBase` still requires `PRIVATE_KEY` to be set, because it derives `deployerAddress` from it in
its constructor. A verification run never broadcasts, so any throwaway key works — do not pass a
production key to a recomputation.
