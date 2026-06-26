# Libraries — past findings

## LF-053 · MEDIUM · LibAsset · acknowledged

**Recognition signal:** Batch handler iterating per-item native-asset deposits that validates msg.value per-item instead of validating the cumulative native amount against a single msg.value.

**Root cause:** depositAssets() iterates LibSwap.SwapData entries and calls depositAsset() per swap; for native assets it only checks msg.value >= amount on each iteration individually. Because msg.value is fixed for the transaction, the same ETH balance is treated as sufficient for every native swap, so the function accepts a batch whose total native requirement exceeds the actual ETH sent.

**Fix:** Not fixed. Acknowledged with a note that inheriting contracts should not call depositAssets in a loop with multiple native-asset swaps.

**Source:** `2025.05.06_LibAsset(v2.0.0).pdf` p.4-4 · `audit20250506::6.1.1`

---

## LF-054 · MEDIUM · LibAsset · fixed

**Recognition signal:** Internal ERC20 transfer helper that does not reject the native-asset sentinel before issuing a low-level call, so transfers to address(0) succeed silently due to empty returndata.

**Root cause:** transferFromERC20 does not guard against assetId == address(0); the call falls through to a transferFrom on address(0), which has no code, so the low-level call returns success with empty returndata. The function therefore returns silently instead of reverting on an obviously invalid ERC20 address.

**Fix:** Fixed in b1d0a6e248 by reverting with NullAddrIsNotAnERC20Token when assetId is the native asset placeholder.

**Source:** `2025.05.06_LibAsset(v2.0.0).pdf` p.5-5 · `audit20250506::6.1.2`

---

## LF-055 · LOW · LibAsset · fixed

**Recognition signal:** Library helper whose semantics around the native-asset sentinel changed between versions (revert vs. return), creating an implicit breaking change for inheriting facets.

**Root cause:** The v2.0.0 approveERC20 reverts when called with the native-asset placeholder, while v1.0.2 maxApproveERC20 returned early. Callers that relied on the old behavior of safe no-op for native assets now revert unexpectedly.

**Fix:** Fixed in 84a413732 by restoring the early-return-on-native-asset behavior.

**Source:** `2025.05.06_LibAsset(v2.0.0).pdf` p.6-6 · `audit20250506::6.2.1`

---

## LF-056 · LOW · LibAsset · fixed

**Recognition signal:** isContract helper that treats the EIP-7702 0xef0100 prefix as conclusive evidence of contract status without dereferencing and code-size-checking the delegated implementation.

**Root cause:** isContract returns true as soon as the first three bytes of extcodecopy match the EIP-7702 delegation prefix 0xef0100, without checking that the delegated target has non-zero code. An EOA that delegates to address(0) therefore appears as a contract while behaving like an EOA, breaking any access-control or routing logic that relies on the contract-vs-EOA distinction.

**Fix:** Fixed in dcb3125546 and 5927e648 by validating that the delegated implementation has non-zero code size.

**Source:** `2025.05.06_LibAsset(v2.0.0).pdf` p.6-7 · `audit20250506::6.2.2`

---

## LF-114 · LOW · LibAllowList, WhitelistManagerFacet · mitigated

**Recognition signal:** Allow-list / access-control gate that checks two related dimensions (target + function-selector, or sender + role + scope) via independent mappings instead of a composite key, enabling cross-combinations the author never intended to authorize.

**Root cause:** AllowListStorage keeps contractAllowList and selectorAllowList as two independent mappings, and external-call gates check each membership separately. As a result, every whitelisted address is implicitly callable with every whitelisted selector, so an unintended selector that happens to be whitelisted on a different protocol (e.g. transferFrom on a token contract) becomes a valid call target on every whitelisted contract.

**Fix:** Acknowledged for already-deployed contracts; a new granular pair-based whitelist (isContractSelectorWhitelisted) was introduced for new contracts. Migration safety fix in PR#1441 commit e87f69019e59b8060f9c53e00acd4ed07ac4084a; verified.

**Source:** `2025.11.04_WhitelistManagerFacet(v1.0.0).pdf` p.4-6 · `audit20251104::L-1`

---

## LF-057 · INFO · LibAsset · fixed

**Recognition signal:** Codehash equality check against only one of {bytes32(0), keccak256("")} when deciding whether an address has code.

**Root cause:** extcodehash returns bytes32(0) for addresses that have never received a transaction and keccak256("") for addresses that have received ETH but have no code. Comparing only against keccak256("") therefore lets virgin EOAs satisfy the codehash != emptyHash condition and be misclassified as contracts.

**Fix:** Addressed in dcb3125546 by removing the codehash-based check entirely.

**Source:** `2025.05.06_LibAsset(v2.0.0).pdf` p.8-9 · `audit20250506::6.4.2`

---

## LF-070 · INFO · LibAsset · acknowledged

**Recognition signal:** Using extcodesize > N as a contract/EOA discriminator where N is chosen for EIP-7702 compatibility, without considering hand-rolled bytecode of smaller size.

**Root cause:** isContract() returns size > 23 to remain compatible with EIP-7702 delegated accounts (size 23). Hand-crafted minimal bytecode contracts deployed outside the Solidity compiler can have code size < 23 and are mis-classified as EOAs.

**Fix:** Acknowledged: residual risk noted, no security impact at this time and no fix applied.

**Source:** `2025.06.20_LibAsset(v2.1.0).pdf` p.4-5 · `audit20250620::6.1.1`

---

## LF-116 · INFO · LibAllowList, WhitelistManagerFacet · acknowledged

**Recognition signal:** Storage helper exposing full-array view functions over an admin-grown unbounded list, with no pagination or cursor pattern.

**Root cause:** LibAllowList's contracts, selectors, and whitelistedSelectorsByContract arrays grow without bound. The view helpers (getAllowedContracts, getAllowedSelectors, getWhitelistedSelectorsForContract) iterate the full array; at large sizes the call exhausts block gas, making whitelist enumeration unusable by integrators.

**Fix:** Acknowledged; LI.FI did not add pagination but documents the warning.

**Source:** `2025.11.04_WhitelistManagerFacet(v1.0.0)_1.pdf` p.4-4 · `audit20251104_1::6.2.1`
