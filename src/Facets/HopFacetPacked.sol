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
        checkCalldataLength(120);
        _startBridgeTokensViaHopL2Native({
            // first 4 bytes are function signature
            transactionId: bytes32(getCalldataValue(4, 8)), // bytes8 > bytes32
            integrator: string(abi.encodePacked(getCalldataValue(12, 16))), // bytes16 > string
            receiver: address(uint160(getCalldataValue(28, 20))), // bytes20 > address
            destinationChainId: getCalldataValue(48, 4), // bytes4(uint32) > uint256
            bonderFee: getCalldataValue(52, 16), // bytes16(uint128) > uint256
            amountOutMin: getCalldataValue(68, 16), // bytes16(uint128) > uint256
            destinationAmountOutMin: getCalldataValue(84, 16), // bytes16(uint128) > uint256
            hopBridge: address(uint160(getCalldataValue(100, 20))) // bytes20 > address
            // => total calldata length required: 120
        });
    }

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function startBridgeTokensViaHopL2NativeMin(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 destinationChainId,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external payable {
        _startBridgeTokensViaHopL2Native(
            transactionId,
            integrator,
            receiver,
            destinationChainId,
            bonderFee,
            amountOutMin,
            destinationAmountOutMin,
            hopBridge
        );
    }

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function encodeBridgeTokensViaHopL2NativePacked(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 destinationChainId,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external pure returns (bytes memory) {
        return bytes.concat(
            abi.encodeWithSignature("startBridgeTokensViaHopL2NativePacked()"),
            bytes8(transactionId),
            bytes16(bytes(integrator)),
            bytes20(receiver),
            bytes4(uint32(destinationChainId)),
            bytes16(uint128(bonderFee)),
            bytes16(uint128(amountOutMin)),
            bytes16(uint128(destinationAmountOutMin)),
            bytes20(hopBridge)
        );
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaHopL2ERC20Packed(
    ) external {
        checkCalldataLength(156);
        _startBridgeTokensViaHopL2ERC20({
            // first 4 bytes are function signature
            transactionId: bytes32(getCalldataValue(4, 8)), // bytes8 > bytes32
            integrator: string(abi.encodePacked(getCalldataValue(12, 16))), // bytes16 > string
            receiver: address(uint160(getCalldataValue(28, 20))), // bytes20 > address
            destinationChainId: getCalldataValue(48, 4), // bytes4(uint32) > uint256
            sendingAssetId: address(uint160(getCalldataValue(52, 20))), // bytes20 > address
            amount: getCalldataValue(72, 16), // bytes16(uint128) > uint256
            bonderFee: getCalldataValue(88, 16), // bytes16(uint128) > uint256
            amountOutMin: getCalldataValue(104, 16), // bytes16(uint128) > uint256
            destinationAmountOutMin: getCalldataValue(120, 16), // bytes16(uint128) > uint256
            hopBridge: address(uint160(getCalldataValue(136, 20))) // bytes20 > address
            // => total calldata length required: 156
        });
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param amount Amount of the source asset to bridge
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function startBridgeTokensViaHopL2ERC20Min(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external {
        _startBridgeTokensViaHopL2ERC20(
            transactionId,
            integrator,
            receiver,
            destinationChainId,
            sendingAssetId,
            amount,
            bonderFee,
            amountOutMin,
            destinationAmountOutMin,
            hopBridge
        );
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param amount Amount of the source asset to bridge
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function encodeBridgeTokensViaHopL2ERC20Packed(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external pure returns (bytes memory) {
        bytes memory packedUSDCParams = bytes.concat(
            bytes8(transactionId),
            bytes16(bytes(integrator)),
            bytes20(receiver),
            bytes4(uint32(destinationChainId)),
            bytes20(sendingAssetId),
            bytes16(uint128(amount)),
            bytes16(uint128(bonderFee)),
            bytes16(uint128(amountOutMin)),
            bytes16(uint128(destinationAmountOutMin)),
            bytes20(hopBridge)
        );

        // split into two concat steps to avoid "Stack too deep" compiler errors

        return bytes.concat(
            abi.encodeWithSignature("startBridgeTokensViaHopL2ERC20Packed()"),
            packedUSDCParams
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

    function _startBridgeTokensViaHopL2Native(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint256 destinationChainId,
        uint256 bonderFee,
        uint256 amountOutMin,
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

        emit LiFiTransferStarted(BridgeData({
            transactionId: transactionId,
            bridge: "hop",
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

    function _startBridgeTokensViaHopL2ERC20(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
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

        emit LiFiTransferStarted(BridgeData({
            transactionId: transactionId,
            bridge: "hop",
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
