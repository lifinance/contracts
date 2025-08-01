// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for AllBridge
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
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
        uint256 destinationChainId,
        bytes32 receiveToken,
        uint256 nonce,
        MessengerProtocol messenger,
        uint256 feeTokenAmount
    ) external payable;

    function getTransactionCost(
        uint256 chainId
    ) external view returns (uint256);

    function getMessageCost(
        uint256 chainId,
        MessengerProtocol protocol
    ) external view returns (uint256);

    function getBridgingCostInTokens(
        uint256 destinationChainId,
        MessengerProtocol messenger,
        address tokenAddress
    ) external view returns (uint256);
}
