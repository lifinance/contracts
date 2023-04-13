// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ICBridge } from "../Interfaces/ICBridge.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title CBridge Facet Packed
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
/// @custom:version 1.0.0
contract CBridgeFacetPacked is ILiFi {
    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    ICBridge private immutable cBridge;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _cBridge The contract address of the cbridge on the source chain.
    constructor(ICBridge _cBridge) {
        cBridge = _cBridge;
    }

    /// External Methods ///

    /// @notice Bridges Native tokens via cBridge (packed)
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaCBridgeNativePacked() external payable {
        require(
            msg.data.length >= 60,
            "callData length smaller than required"
        );

        _startBridgeTokensViaCBridgeNative({
            // first 4 bytes are function signature
            transactionId: bytes32(bytes8(msg.data[4:12])),
            integrator: string(msg.data[12:28]), // bytes16 > string
            receiver: address(bytes20(msg.data[28:48])),
            destinationChainId: uint64(uint32(bytes4(msg.data[48:52]))),
            nonce: uint64(uint32(bytes4(msg.data[52:56]))),
            maxSlippage: uint32(bytes4(msg.data[56:60]))
            // => total calldata length required: 60
        });
    }

    /// @notice Bridges native tokens via cBridge
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param nonce A number input to guarantee uniqueness of transferId.
    /// @param maxSlippage Destination swap minimal accepted amount
    function startBridgeTokensViaCBridgeNativeMin(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint64 destinationChainId,
        uint64 nonce,
        uint32 maxSlippage
    ) external payable {
        _startBridgeTokensViaCBridgeNative(
            transactionId,
            integrator,
            receiver,
            destinationChainId,
            nonce,
            maxSlippage
        );
    }

    /// @notice Encode callData to send native tokens packed
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param nonce A number input to guarantee uniqueness of transferId.
    /// @param maxSlippage Destination swap minimal accepted amount
    function encoder_startBridgeTokensViaCBridgeNativePacked(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint64 destinationChainId,
        uint64 nonce,
        uint32 maxSlippage
    ) external pure returns (bytes memory) {
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            nonce <= type(uint32).max,
            "nonce value passed too big to fit in uint32"
        );

        return
            bytes.concat(
                CBridgeFacetPacked
                    .startBridgeTokensViaCBridgeNativePacked
                    .selector,
                bytes8(transactionId),
                bytes16(bytes(integrator)),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes4(uint32(nonce)),
                bytes4(maxSlippage)
            );
    }

    /// @notice Bridges ERC20 tokens via cBridge
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaCBridgeERC20Packed() external {
        require(
            msg.data.length >= 96,
            "callData length smaller than required"
        );

        _startBridgeTokensViaCBridgeERC20({
            // first 4 bytes are function signature
            transactionId: bytes32(bytes8(msg.data[4:12])),
            integrator: string(msg.data[12:28]), // bytes16 > string
            receiver: address(bytes20(msg.data[28:48])),
            destinationChainId: uint64(uint32(bytes4(msg.data[48:52]))),
            sendingAssetId: address(bytes20(msg.data[52:72])),
            amount: uint256(uint128(bytes16(msg.data[72:88]))),
            nonce: uint64(uint32(bytes4(msg.data[88:92]))),
            maxSlippage: uint32(bytes4(msg.data[92:96]))
            // => total calldata length required: 96
        });
    }

    /// @notice Bridges ERC20 tokens via cBridge
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param amount Amount of the source asset to bridge
    /// @param nonce A number input to guarantee uniqueness of transferId
    /// @param maxSlippage Destination swap minimal accepted amount
    function startBridgeTokensViaCBridgeERC20Min(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint64 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint64 nonce,
        uint32 maxSlippage
    ) external {
        _startBridgeTokensViaCBridgeERC20(
            transactionId,
            integrator,
            receiver,
            destinationChainId,
            sendingAssetId,
            amount,
            nonce,
            maxSlippage
        );
    }

    /// @notice Encode callData to send ERC20 tokens packed
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param amount Amount of the source asset to bridge
    /// @param nonce A number input to guarantee uniqueness of transferId
    /// @param maxSlippage Destination swap minimal accepted amount
    function encoder_startBridgeTokensViaCBridgeERC20Packed(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint64 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint64 nonce,
        uint32 maxSlippage
    ) external pure returns (bytes memory) {
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            amount <= type(uint128).max,
            "amount value passed too big to fit in uint128"
        );
        require(
            nonce <= type(uint32).max,
            "nonce value passed too big to fit in uint32"
        );

        return
            bytes.concat(
                CBridgeFacetPacked
                    .startBridgeTokensViaCBridgeERC20Packed
                    .selector,
                bytes8(transactionId),
                bytes16(bytes(integrator)),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes20(sendingAssetId),
                bytes16(uint128(amount)),
                bytes4(uint32(nonce)),
                bytes4(maxSlippage)
            );
    }

    /// Internal Methods ///

    function _startBridgeTokensViaCBridgeNative(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint64 destinationChainId,
        uint64 nonce,
        uint32 maxSlippage
    ) private {
        // Bridge assets
        cBridge.sendNative{ value: msg.value }(
            receiver,
            msg.value,
            destinationChainId,
            nonce,
            maxSlippage
        );

        emit LiFiTransferStarted(
            BridgeData({
                transactionId: transactionId,
                bridge: "cbridge",
                integrator: integrator,
                referrer: address(0),
                sendingAssetId: address(0),
                receiver: receiver,
                minAmount: msg.value,
                destinationChainId: destinationChainId,
                hasSourceSwaps: false,
                hasDestinationCall: false
            })
        );
    }

    function _startBridgeTokensViaCBridgeERC20(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint64 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint64 nonce,
        uint32 maxSlippage
    ) private {
        // Deposit assets
        SafeERC20.safeTransferFrom(
            IERC20(sendingAssetId),
            msg.sender,
            address(this),
            amount
        );

        // Bridge assets
        // solhint-disable-next-line check-send-result
        cBridge.send(
            receiver,
            sendingAssetId,
            amount,
            destinationChainId,
            nonce,
            maxSlippage
        );

        emit LiFiTransferStarted(
            BridgeData({
                transactionId: transactionId,
                bridge: "cbridge",
                integrator: integrator,
                referrer: address(0),
                sendingAssetId: sendingAssetId,
                receiver: receiver,
                minAmount: amount,
                destinationChainId: destinationChainId,
                hasSourceSwaps: false,
                hasDestinationCall: false
            })
        );
    }
}
