# OwnershipFacet – Changelog

Commits that modified this contract (newest first).

## [98d35bd] - feat: DiamondLoupeFacet _facetCount refactor, OwnershipFacet pendingOwner(); update changelog README; only code changes trigger changelog

**Commit**: [`98d35bd5f82b0c7c41ba4531c35152eefa5b7f58`](https://github.com/lifinance/contracts/commit/98d35bd5f82b0c7c41ba4531c35152eefa5b7f58)  
**Date**: 2026-02-25 18:01:27 +0100  
**Author**: Pablo Urriza

### ✨ Added

- `OwnershipFacet`: Added `pendingOwner()` external view function that returns the address of the pending new owner during a two-step ownership transfer, or address(0) if no transfer is in progress

### 🔄 Changed

- `OwnershipFacet`: Bumped contract version from 1.0.0 to 1.0.1 in custom:version tag

**Note**: This addition improves transparency for two-step ownership transfers by allowing external parties to query if an ownership transfer is pending and who the pending owner is. No storage layout changes or breaking modifications. Safe to upgrade in diamond proxy pattern.

---