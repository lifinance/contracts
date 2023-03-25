// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IHopBridge } from "../Interfaces/IHopBridge.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Hop Facet (Optimized for Rollups)
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hop
contract HopFacetPacked is ILiFi {

    /// External Methods ///

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaHopL2NativePacked(
    ) external payable {
        checkCalldataLength(118);
        _startBridgeTokensViaHopL2Native(
            // first 4 bytes are function signature
            bytes32(getCalldataValue(4, 8)), // bytes8 > bytes32: transactionId
            string(abi.encodePacked(getCalldataValue(12, 16))), // bytes16 > string: integrator
            address(uint160(getCalldataValue(28, 20))), // bytes20 > address: receiver
            getCalldataValue(48, 16), // uint128 > uint256: bonderFee
            getCalldataValue(64, 16), // uint128 > uint256: amountOutMin
            getCalldataValue(80, 2), // uint8 > uint256: destinationChainId
            getCalldataValue(82, 16), // uint128 > uint256: destinationAmountOutMin
            address(uint160(getCalldataValue(98, 20))) // bytes20 > address: hopBridge
            // => total calldata length required: 118
        );
    }

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationChainId Receiving chain
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function startBridgeTokensViaHopL2NativeMin(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationChainId,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external payable {
        _startBridgeTokensViaHopL2Native(
            transactionId,
            integrator,
            receiver,
            bonderFee,
            amountOutMin,
            destinationChainId,
            destinationAmountOutMin,
            hopBridge
        );
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaHopL2ERC20Packed(
    ) external {
        checkCalldataLength(154);
        _startBridgeTokensViaHopL2ERC20(
            // first 4 bytes are function signature
            bytes32(getCalldataValue(4, 8)), // bytes8 > bytes32: transactionId
            string(abi.encodePacked(getCalldataValue(12, 16))), // bytes16 > string: integrator
            address(uint160(getCalldataValue(28, 20))), // bytes20 > address: receiver
            getCalldataValue(48, 16), // uint128 > uint256: bonderFee
            getCalldataValue(64, 16), // uint128 > uint256: amountOutMin
            getCalldataValue(80, 2), // uint8 > uint256: destinationChainId
            getCalldataValue(82, 16), // uint128 > uint256: destinationAmountOutMin
            address(uint160(getCalldataValue(98, 20))), // bytes20 > address: hopBridge
            address(uint160(getCalldataValue(118, 20))), // bytes20 > address: sendingAssetId
            getCalldataValue(138, 16) // uint128 > uint256: amount
            // => total calldata length required: 154
        );
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationChainId Receiving chain
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param amount Amount of the source asset to bridge
    function startBridgeTokensViaHopL2ERC20Min(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationChainId,
        uint256 destinationAmountOutMin,
        address hopBridge,
        address sendingAssetId,
        uint256 amount
    ) external {
        _startBridgeTokensViaHopL2ERC20(
            transactionId,
            integrator,
            receiver,
            bonderFee,
            amountOutMin,
            destinationChainId,
            destinationAmountOutMin,
            hopBridge,
            sendingAssetId,
            amount
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
    /// @param length Length of callData ro read
    function getCalldataValue(uint startByte, uint length)
        private pure returns (uint) {
        uint _retVal;

        assembly {
            _retVal := calldataload(startByte)
        }

        return _retVal >> (256-length*8);
    }

    function _startBridgeTokensViaHopL2Native(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationChainId,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) private {
        // Bridge assets
        uint256 deadline = block.timestamp + 60 * 20;
        IHopBridge(hopBridge).swapAndSend{ value: msg.value }(
            destinationChainId,
            receiver,
            msg.value,
            bonderFee,
            amountOutMin,
            deadline,
            destinationAmountOutMin,
            deadline
        );

        emit LiFiTransferStarted(BridgeData(
            transactionId,
            "hop",
            integrator,
            address(0),
            address(0),
            receiver,
            msg.value,
            destinationChainId,
            false,
            false
        ));
    }

    function _startBridgeTokensViaHopL2ERC20(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationChainId,
        uint256 destinationAmountOutMin,
        address hopBridge,
        address sendingAssetId,
        uint256 amount
    ) private {
        // Deposit assets
        SafeERC20.safeTransferFrom(IERC20(sendingAssetId), msg.sender, address(this), amount);

        // Bridge assets
        uint256 deadline = block.timestamp + 60 * 20;
        IHopBridge(hopBridge).swapAndSend(
            destinationChainId,
            receiver,
            amount,
            bonderFee,
            amountOutMin,
            deadline,
            destinationAmountOutMin,
            deadline
        );

        emit LiFiTransferStarted(BridgeData(
            transactionId,
            "hop",
            integrator,
            address(0),
            sendingAssetId,
            receiver,
            amount,
            destinationChainId,
            false,
            false
        ));
    }
}
