// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IYieldAdapter } from "../interfaces/IYieldAdapter.sol";

/// @title ERC4626Adapter
/// @author LI.FI (https://li.fi)
/// @notice Yield adapter for standard ERC-4626 vaults. Derives the underlying's
///         ERC20 asset via the vault's `asset()` introspection method.
/// @custom:version 1.0.0
contract ERC4626Adapter is IYieldAdapter {
    error AssetResolutionFailed();

    /// @inheritdoc IYieldAdapter
    function resolveAsset(
        address _underlying
    ) external view returns (address asset) {
        if (_underlying.code.length == 0) revert AssetResolutionFailed();
        try IERC4626(_underlying).asset() returns (address a) {
            if (a == address(0)) revert AssetResolutionFailed();
            asset = a;
        } catch {
            revert AssetResolutionFailed();
        }
    }
}
