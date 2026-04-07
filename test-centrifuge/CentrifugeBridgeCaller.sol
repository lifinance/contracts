// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "lifi/Libraries/LibAsset.sol";

interface ITokenBridge {
    function send(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress
    ) external payable returns (bytes memory);
}

/// @title  CentrifugeBridgeCaller
/// @notice Minimal standalone contract that does what CentrifugeFacet._startBridge does,
///         without Diamond/facet overhead. Deploy → call bridge() → verify tokens moved.
contract CentrifugeBridgeCaller {
    ITokenBridge public immutable tokenBridge;

    event BridgeInitiated(
        address indexed token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId
    );

    constructor(address _tokenBridge) {
        tokenBridge = ITokenBridge(_tokenBridge);
    }

    /// @notice Pull tokens from caller, approve bridge, call send()
    /// @param token     ERC20 token to bridge
    /// @param amount    Amount to bridge
    /// @param receiver  Destination receiver (bytes32 for non-EVM support)
    /// @param destChainId  Destination EVM chain ID
    function bridge(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destChainId
    ) external payable {
        // 1. Pull tokens from caller into this contract
        IERC20(token).transferFrom(msg.sender, address(this), amount);

        // 2. Approve bridge to pull from us
        IERC20(token).approve(address(tokenBridge), amount);

        // 3. Call bridge — forwards msg.value for cross-chain gas
        tokenBridge.send{ value: msg.value }(
            token,
            amount,
            receiver,
            destChainId,
            msg.sender
        );

        emit BridgeInitiated(token, amount, receiver, destChainId);
    }
}
