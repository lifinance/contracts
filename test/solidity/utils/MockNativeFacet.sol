// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "lifi/Libraries/LibAsset.sol";

/// @title MockNativeFacet
/// @author LI.FI (https://li.fi)
/// @notice Mock facet that handles native token transfers
/// @custom:version 1.0.0
contract MockNativeFacet {
    function handleNative(
        bytes memory payload,
        address /*from*/,
        address /*tokenIn*/,
        uint256 amountIn
    ) external payable returns (uint256) {
        address recipient = abi.decode(payload, (address));
        LibAsset.transferAsset(address(0), payable(recipient), amountIn);
        return amountIn;
    }
}
