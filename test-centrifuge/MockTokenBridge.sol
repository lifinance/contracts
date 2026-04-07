// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "lifi/Libraries/LibAsset.sol";

/// @title  MockTokenBridge
/// @notice Mimics the Centrifuge TokenBridge.send() signature exactly.
///         Does NOT do cross-chain — just pulls tokens and emits an event
///         so we can verify the full approve → send callpath on mainnet.
contract MockTokenBridge {
    event BridgeSent(
        address indexed token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress
    );

    function send(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress
    ) external payable returns (bytes memory) {
        IERC20(token).transferFrom(msg.sender, address(this), amount);

        emit BridgeSent(token, amount, receiver, destinationChainId, refundAddress);

        return bytes("");
    }
}
