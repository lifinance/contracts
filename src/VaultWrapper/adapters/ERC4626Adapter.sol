// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { IYieldAdapter } from "../interfaces/IYieldAdapter.sol";
import { LibAsset } from "../../Libraries/LibAsset.sol";

/// @title ERC4626Adapter
/// @author LI.FI (https://li.fi)
/// @notice Yield adapter for standard ERC-4626 vaults: resolves the underlying's ERC20
///         asset and routes a vault wrapper's deposits, withdrawals, and valuation
///         through the ERC-4626 interface.
/// @dev Stateless: holds no storage, so the `deposit`/`withdraw` methods are safe to
///      `delegatecall` from a wrapper (they run in the wrapper's context and act only on
///      their arguments). `resolveAsset`/`totalAssets` are ordinary view calls.
///      This contract is not intended to custody funds; under `delegatecall` the assets
///      and yield-source shares belong to the calling wrapper, and a direct call holds
///      nothing.
/// @custom:version 1.1.0
contract ERC4626Adapter is IYieldAdapter {
    /// @inheritdoc IYieldAdapter
    function resolveAsset(
        address _underlying
    ) external view returns (address asset) {
        if (!LibAsset.isContract(_underlying)) revert AssetResolutionFailed();
        asset = IERC4626(_underlying).asset();
        if (asset == address(0)) revert AssetResolutionFailed();
    }

    /// @inheritdoc IYieldAdapter
    function totalAssets(
        address _underlying,
        address _holder
    ) external view returns (uint256 assets) {
        assets = IERC4626(_underlying).convertToAssets(
            IERC4626(_underlying).balanceOf(_holder)
        );
    }

    /// @inheritdoc IYieldAdapter
    function deposit(
        address _asset,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 deposited) {
        SafeTransferLib.safeApproveWithRetry(_asset, _underlying, _assets);
        IERC4626(_underlying).deposit(_assets, address(this));
        deposited = _assets;
    }

    /// @inheritdoc IYieldAdapter
    function withdraw(
        address,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 withdrawn) {
        IERC4626(_underlying).withdraw(_assets, address(this), address(this));
        withdrawn = _assets;
    }
}
