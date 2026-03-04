# WithdrawFacet – Changelog

Changes grouped by contract version (`@custom:version`).

## v1.0.2

**Commits**: [`c41df2c`](https://github.com/lifinance/contracts/commit/c41df2cdcfc01f25dcf6e19cbecb22e9ba0e79c6)  
**Date**: 2026-02-26 14:11:45 +0100

### ✨ Added

- `WithdrawFacet`: Added `getWithdrawFacetName()` function returning 'WithdrawFacet' for facet identification and debugging purposes
- `WithdrawFacet`: Implemented `batchWithdraw()` function body with array length validation and iterative withdrawal logic for multiple assets

### 🔄 Changed

- `WithdrawFacet`: Updated facet version from previous to '1.0.2' to reflect implementation changes
- **Note**: The batchWithdraw function now includes input validation (array length matching) and delegates to internal _withdrawAsset for each asset. Access control enforcement remains unchanged (owner bypass or access control check). No storage layout changes, safe for upgradeable deployments.

### 🗑️ Removed

- `WithdrawFacet`: Removed `BatchWithdrawCompleted` event that was declared but never emitted in the implementation

---


## v1.0.2

**Commits**: [`c98a883`](https://github.com/lifinance/contracts/commit/c98a883fac0fd202bfa02cf75c833b6d9eebcbe5)  
**Date**: 2026-02-26 13:24:36 +0100

### 🔄 Changed

- `WithdrawFacet`: Updated contract version from 1.0.1 to 1.0.2 in both @custom:version tag and getWithdrawFacetVersion() return value
- **Note**: This is a version-only update with no code logic changes. The version bump likely indicates deployment or documentation synchronization. No redeployment required unless coordinating with other facet updates in the diamond pattern.

---