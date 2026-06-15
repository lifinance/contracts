// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @notice Minimal ERC4626-shaped vault exposing only what the factory probe reads.
contract MockERC4626Underlying {
    address public asset;

    constructor(address _asset) {
        asset = _asset;
    }

    function totalAssets() external pure returns (uint256) {
        return 0;
    }
}
