// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { IYieldAdapter } from "lifi/VaultWrapper/interfaces/IYieldAdapter.sol";

/// @notice Adapter that resolves to the zero address without reverting, used to
///         exercise the wrapper's zero-asset guard in initialize (the factory relies
///         on that guard rather than resolving the asset itself). The runtime methods
///         are unused stubs (only resolveAsset is called on the deploy path).
contract MockZeroAdapter is IYieldAdapter {
    function resolveAsset(address) external pure returns (address) {
        return address(0);
    }

    function totalAssets(address, address) external pure returns (uint256) {
        return 0;
    }

    function deposit(
        address,
        address,
        uint256
    ) external pure returns (uint256) {
        return 0;
    }

    function withdraw(
        address,
        address,
        uint256
    ) external pure returns (uint256) {
        return 0;
    }
}
