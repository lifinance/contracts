// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ICBridge } from "../Interfaces/ICBridge.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title CBridge Facet Packed
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
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
    function startBridgeTokensViaCBridgeNativePacked(
    ) external payable {
        checkCalldataLength(60);
        _startBridgeTokensViaCBridgeNative({
            // first 4 bytes are function signature
            transactionId: bytes32(getCalldataValue(4, 8)), // bytes8 > bytes32
            integrator: string(abi.encodePacked(getCalldataValue(12, 16))), // bytes16 > string
            receiver: address(uint160(getCalldataValue(28, 20))), // bytes20 > address
            destinationChainId: uint64(getCalldataValue(48, 4)), // bytes4 > uint256 > uint64
            nonce: uint64(getCalldataValue(52, 4)), // bytes4 > uint256 > uint64
            maxSlippage: uint32(getCalldataValue(56, 4)) // bytes4 > uint256 > uint32
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
        return bytes.concat(
            abi.encodeWithSignature("startBridgeTokensViaCBridgeNativePacked()"),
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
    function startBridgeTokensViaCBridgeERC20Packed(
    ) external {
        checkCalldataLength(96);
        _startBridgeTokensViaCBridgeERC20({
            // first 4 bytes are function signature
            transactionId: bytes32(getCalldataValue(4, 8)), // bytes8 > bytes32
            integrator: string(abi.encodePacked(getCalldataValue(12, 16))), // bytes16 > string
            receiver: address(uint160(getCalldataValue(28, 20))), // bytes20 > address
            destinationChainId: uint64(getCalldataValue(48, 4)), // bytes4 > uint256 > uint64
            sendingAssetId: address(uint160(getCalldataValue(52, 20))), // bytes20 > address
            amount: getCalldataValue(72, 16), // bytes16 > uint256
            nonce: uint64(getCalldataValue(88, 4)), // bytes4 > uint256 > uint64
            maxSlippage: uint32(getCalldataValue(92, 4)) // bytes4 > uint256 > uint32
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
        return bytes.concat(
            abi.encodeWithSignature("startBridgeTokensViaCBridgeERC20Packed()"),
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

    /// @notice Validate raw callData length
    /// @param length Total required callData length
    function checkCalldataLength(uint length) private pure {
            uint _calldatasize;
            assembly {
                _calldatasize := calldatasize()
            }

            require(length <= _calldatasize,
                "calldatasize smaler than required");
    }

    /// @notice Extract information from raw callData
    /// @param startByte Start position to read callData from
    /// @param length Length of callData ro read, should not be longer than 32 bytes
    function getCalldataValue(uint startByte, uint length)
        private pure returns (uint) {
        uint _retVal;

        assembly {
            _retVal := calldataload(startByte)
        }

        return _retVal >> (256-length*8);
    }

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

        emit LiFiTransferStarted(BridgeData({
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
        }));
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
        SafeERC20.safeTransferFrom(IERC20(sendingAssetId), msg.sender, address(this), amount);

        // Bridge assets
        cBridge.send(
            receiver,
            sendingAssetId,
            amount,
            destinationChainId,
            nonce,
            maxSlippage
        );

        emit LiFiTransferStarted(BridgeData({
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
        }));
    }
}
