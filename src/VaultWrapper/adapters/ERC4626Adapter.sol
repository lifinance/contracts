// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IYieldAdapter } from "../interfaces/IYieldAdapter.sol";
import { LibAsset } from "../../Libraries/LibAsset.sol";

/// @title ERC4626Adapter
/// @author LI.FI (https://li.fi)
/// @notice Yield adapter for standard ERC-4626 vaults. Derives the underlying's
///         ERC20 asset via the vault's `asset()` introspection method.
/// @custom:version 1.0.0
contract ERC4626Adapter is IYieldAdapter {
    /// @inheritdoc IYieldAdapter
    function resolveAsset(
        address _underlying
    ) external view returns (address asset) {
        if (!LibAsset.isContract(_underlying)) revert AssetResolutionFailed();
        asset = IERC4626(_underlying).asset();
        if (asset == address(0)) revert AssetResolutionFailed();
    }
}
