// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "lifi/Libraries/LibAsset.sol";

/// @title MockPullERC20Facet
/// @author LI.FI (https://li.fi)
/// @notice Mock facet that pulls ERC20 tokens from msg.sender
/// @custom:version 1.0.0
contract MockPullERC20Facet {
    // Pulls `amountIn` from msg.sender if `from == msg.sender`
    function pull(
        bytes memory /*payload*/,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        if (from == msg.sender) {
            LibAsset.transferFromERC20(
                tokenIn,
                msg.sender,
                address(this),
                amountIn
            );
        }
        return amountIn;
    }
}
