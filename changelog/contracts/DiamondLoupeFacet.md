# DiamondLoupeFacet – Changelog

Commits that modified this contract (newest first).

## [98d35bd] - feat: DiamondLoupeFacet _facetCount refactor, OwnershipFacet pendingOwner(); update changelog README; only code changes trigger changelog

**Commit**: [`98d35bd5f82b0c7c41ba4531c35152eefa5b7f58`](https://github.com/lifinance/contracts/commit/98d35bd5f82b0c7c41ba4531c35152eefa5b7f58)  
**Date**: 2026-02-25 18:01:27 +0100  
**Author**: Pablo Urriza

### ✨ Added

- `DiamondLoupeFacet`: Added internal `_facetCount` helper function that accepts DiamondStorage as parameter to centralize facet count logic

### 🔄 Changed

- `DiamondLoupeFacet`: Modified `facetCount` to call new internal `_facetCount` helper instead of directly accessing storage
- `DiamondLoupeFacet`: Modified `hasFacets` to use `_facetCount` helper instead of directly accessing `ds.facetAddresses.length`
- `DiamondLoupeFacet`: Bumped contract version from 1.0.9 to 1.1.0

**Note**: This is a non-breaking refactoring that improves code maintainability by eliminating duplicate storage access patterns. The internal helper function allows for consistent facet counting across multiple functions and makes future modifications easier. No changes to external interfaces or behavior.

---


## [3c590de] - chore: bump DiamondLoupeFacet to 1.0.9

**Commit**: [`3c590de2d41775047d9d9a0cf5475e69606c8750`](https://github.com/lifinance/contracts/commit/3c590de2d41775047d9d9a0cf5475e69606c8750)  
**Date**: 2026-02-25 17:50:30 +0100  
**Author**: Pablo Urriza

### 🔄 Changed

- `DiamondLoupeFacet`: Updated contract version tag from 1.0.8 to 1.0.9 in NatSpec documentation

**Note**: This is a documentation-only change with no functional modifications to the contract code. The version bump likely reflects changes in other parts of the codebase or deployment artifacts.

---