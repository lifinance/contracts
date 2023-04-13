// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// @title AllBridge Interface
interface IAllBridge {
    /// @dev AllBridge Messenger Protocol Enum
    enum MessengerProtocol {
        None,
        Allbridge,
        Wormhole,
        LayerZero
    }

    function pools(bytes32 addr) external returns (address);

    function swapAndBridge(
        bytes32 token,
        uint256 amount,
        bytes32 recipient,
        uint8 destinationChainId,
        bytes32 receiveToken,
        uint256 nonce,
        MessengerProtocol messenger
    ) external payable;
}
