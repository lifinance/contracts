// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { IAcrossSpokePool } from "../Interfaces/IAcrossSpokePool.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { AcrossFacetV3 } from "./AcrossFacetV3.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";

/// @title AcrossFacetPackedV3
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across in a gas-optimized way
/// @custom:version 1.2.0
contract AcrossFacetPackedV3 is ILiFi, TransferrableOwnership {
    using SafeTransferLib for ERC20;

    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    IAcrossSpokePool public immutable spokePool;

    /// @notice The WETH address on the current chain.
    address public immutable wrappedNative;

    /// Events ///

    event LiFiAcrossTransfer(bytes8 _transactionId);
    event CallExecutedAndFundsWithdrawn();

    /// Errors ///

    error WithdrawFailed();

    // using this struct to bundle parameters is required since otherwise we run into stack-too-deep errors
    // (Solidity can only handle a limited amount of parameters at any given time)
    struct PackedParameters {
        bytes32 transactionId;
        address receiver;
        address depositor;
        uint64 destinationChainId;
        address receivingAssetId;
        uint256 outputAmount;
        address exclusiveRelayer;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityDeadline;
        bytes message;
    }

    /// Constructor ///

    /// @notice Initialize the contract
    /// @param _spokePool The contract address of the spoke pool on the source chain
    /// @param _wrappedNative The address of the wrapped native token on the source chain
    /// @param _owner The address of the contract owner
    constructor(
        IAcrossSpokePool _spokePool,
        address _wrappedNative,
        address _owner
    ) TransferrableOwnership(_owner) {
        spokePool = _spokePool;
        wrappedNative = _wrappedNative;
    }

    /// External Methods ///

    /// @dev Only meant to be called outside of the context of the diamond
    /// @notice Sets approval for the Across spoke pool Router to spend the specified token
    /// @param tokensToApprove The tokens to approve to the Across spoke pool
    function setApprovalForBridge(
        address[] calldata tokensToApprove
    ) external onlyOwner {
        for (uint256 i; i < tokensToApprove.length; i++) {
            // Give Across spoke pool approval to pull tokens from this facet
            LibAsset.maxApproveERC20(
                IERC20(tokensToApprove[i]),
                address(spokePool),
                type(uint256).max
            );
        }
    }

    /// @notice Bridges native tokens via Across (packed implementation)
    /// @dev Calldata mapping:
    /// [0:4] - function selector
    /// [4:12] - transactionId
    /// [12:32] - receiver
    /// [32:52] - depositor
    /// [52:56] - destinationChainId
    /// [56:76] - receivingAssetId
    /// [76:108] - outputAmount
    /// [108:128] - exclusiveRelayer
    /// [128:132] - quoteTimestamp
    /// [132:136] - fillDeadline
    /// [136:140] - exclusivityDeadline
    /// [140:] - message
    function startBridgeTokensViaAcrossV3NativePacked() external payable {
        // call Across spoke pool to bridge assets
        spokePool.depositV3{ value: msg.value }(
            address(bytes20(msg.data[32:52])), // depositor
            address(bytes20(msg.data[12:32])), // recipient
            wrappedNative, // inputToken
            address(bytes20(msg.data[56:76])), // outputToken
            msg.value, // inputAmount
            uint256(bytes32(msg.data[76:108])), // outputAmount
            uint64(uint32(bytes4(msg.data[52:56]))), // destinationChainId
            address(bytes20(msg.data[108:128])), // exclusiveRelayer
            uint32(bytes4(msg.data[128:132])), // quoteTimestamp
            uint32(bytes4(msg.data[132:136])), // fillDeadline
            uint32(bytes4(msg.data[136:140])), // exclusivityDeadline
            msg.data[140:msg.data.length]
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges native tokens via Across (minimal implementation)
    /// @param _parameters Contains all parameters required for native bridging with AcrossV3
    function startBridgeTokensViaAcrossV3NativeMin(
        PackedParameters calldata _parameters
    ) external payable {
        // call Across spoke pool to bridge assets
        spokePool.depositV3{ value: msg.value }(
            _parameters.depositor, // depositor
            _parameters.receiver,
            wrappedNative, // inputToken
            _parameters.receivingAssetId, // outputToken
            msg.value, // inputAmount
            _parameters.outputAmount,
            _parameters.destinationChainId,
            _parameters.exclusiveRelayer,
            _parameters.quoteTimestamp,
            _parameters.fillDeadline,
            _parameters.exclusivityDeadline,
            _parameters.message
        );

        emit LiFiAcrossTransfer(bytes8(_parameters.transactionId));
    }

    /// @notice Bridges ERC20 tokens via Across (packed implementation)
    /// @dev Calldata mapping:
    /// [0:4] - function selector
    /// [4:12] - transactionId
    /// [12:32] - receiver
    /// [32:52] - depositor
    /// [52:72] - sendingAssetId
    /// [72:88] - inputAmount
    /// [88:92] - destinationChainId
    /// [92:112] - receivingAssetId
    /// [112:144] - outputAmount
    /// [144:164] - exclusiveRelayer
    /// [164:168] - quoteTimestamp
    /// [168:172] - fillDeadline
    /// [172:176] - exclusivityDeadline
    /// [176:] - message
    function startBridgeTokensViaAcrossV3ERC20Packed() external {
        address sendingAssetId = address(bytes20(msg.data[52:72]));
        uint256 inputAmount = uint256(uint128(bytes16(msg.data[72:88])));

        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            inputAmount
        );

        spokePool.depositV3(
            address(bytes20(msg.data[32:52])), // depositor
            address(bytes20(msg.data[12:32])), // recipient
            sendingAssetId, // inputToken
            address(bytes20(msg.data[92:112])), // outputToken
            inputAmount, // inputAmount
            uint256(bytes32(msg.data[112:144])), // outputAmount
            uint64(uint32(bytes4(msg.data[88:92]))), // destinationChainId
            address(bytes20(msg.data[144:164])), // exclusiveRelayer
            uint32(bytes4(msg.data[164:168])), // quoteTimestamp
            uint32(bytes4(msg.data[168:172])), // fillDeadline
            uint32(bytes4(msg.data[172:176])), // exclusivityDeadline
            msg.data[176:msg.data.length]
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges ERC20 tokens via Across (minimal implementation)
    /// @param _parameters Contains all base parameters required for bridging with AcrossV3
    /// @param sendingAssetId The address of the asset/token to be bridged
    /// @param inputAmount The amount to be bridged (including fees)
    function startBridgeTokensViaAcrossV3ERC20Min(
        PackedParameters calldata _parameters,
        address sendingAssetId,
        uint256 inputAmount
    ) external {
        // Deposit assets
        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            inputAmount
        );

        // call Across SpokePool
        spokePool.depositV3(
            _parameters.depositor, // depositor
            _parameters.receiver,
            sendingAssetId, // inputToken
            _parameters.receivingAssetId, // outputToken
            inputAmount,
            _parameters.outputAmount,
            _parameters.destinationChainId,
            _parameters.exclusiveRelayer,
            _parameters.quoteTimestamp,
            _parameters.fillDeadline,
            _parameters.exclusivityDeadline,
            _parameters.message
        );

        emit LiFiAcrossTransfer(bytes8(_parameters.transactionId));
    }

    /// @notice Encodes calldata that can be used to call the native 'packed' function
    /// @param _parameters Contains all parameters required for native bridging with AcrossV3
    function encode_startBridgeTokensViaAcrossV3NativePacked(
        PackedParameters calldata _parameters
    ) external pure returns (bytes memory) {
        // there are already existing networks with chainIds outside uint32 range but since we not support either of them yet,
        // we feel comfortable using this approach to save further gas
        require(
            _parameters.destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );

        return
            bytes.concat(
                AcrossFacetPackedV3
                    .startBridgeTokensViaAcrossV3NativePacked
                    .selector,
                bytes8(_parameters.transactionId),
                bytes20(_parameters.receiver),
                bytes20(_parameters.depositor),
                bytes4(uint32(_parameters.destinationChainId)),
                bytes20(_parameters.receivingAssetId),
                bytes32(_parameters.outputAmount),
                bytes20(_parameters.exclusiveRelayer),
                bytes4(_parameters.quoteTimestamp),
                bytes4(_parameters.fillDeadline),
                bytes4(_parameters.exclusivityDeadline),
                _parameters.message
            );
    }

    /// @notice Encodes calldata that can be used to call the ERC20 'packed' function
    /// @param _parameters Contains all base parameters required for bridging with AcrossV3
    /// @param sendingAssetId The address of the asset/token to be bridged
    /// @param inputAmount The amount to be bridged (including fees)
    function encode_startBridgeTokensViaAcrossV3ERC20Packed(
        PackedParameters calldata _parameters,
        address sendingAssetId,
        uint256 inputAmount
    ) external pure returns (bytes memory) {
        // there are already existing networks with chainIds outside uint32 range but since we not support either of them yet,
        // we feel comfortable using this approach to save further gas
        require(
            _parameters.destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );

        require(
            inputAmount <= type(uint128).max,
            "inputAmount value passed too big to fit in uint128"
        );

        // Split the concatenation into parts to avoid "stack too deep" errors
        bytes memory part1 = bytes.concat(
            AcrossFacetPackedV3
                .startBridgeTokensViaAcrossV3ERC20Packed
                .selector,
            bytes8(_parameters.transactionId),
            bytes20(_parameters.receiver),
            bytes20(_parameters.depositor),
            bytes20(sendingAssetId)
        );

        bytes memory part2 = bytes.concat(
            bytes16(uint128(inputAmount)),
            bytes4(uint32(_parameters.destinationChainId)),
            bytes20(_parameters.receivingAssetId),
            bytes32(_parameters.outputAmount)
        );

        bytes memory part3 = bytes.concat(
            bytes20(_parameters.exclusiveRelayer),
            bytes4(_parameters.quoteTimestamp),
            bytes4(_parameters.fillDeadline),
            bytes4(_parameters.exclusivityDeadline)
        );

        // Combine all parts with the message
        return bytes.concat(part1, part2, part3, _parameters.message);
    }

    /// @notice Decodes calldata that is meant to be used for calling the native 'packed' function
    /// @param data the calldata to be decoded
    function decode_startBridgeTokensViaAcrossV3NativePacked(
        bytes calldata data
    )
        external
        pure
        returns (
            BridgeData memory bridgeData,
            AcrossFacetV3.AcrossV3Data memory acrossData
        )
    {
        require(
            data.length >= 140,
            "invalid calldata (must have length >= 140)"
        );

        // extract bridgeData
        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(bytes20(data[12:32]));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[52:56])));

        // extract acrossData
        acrossData.refundAddress = address(bytes20(data[32:52])); // depositor
        acrossData.receivingAssetId = address(bytes20(data[56:76]));
        acrossData.outputAmount = uint256(bytes32(data[76:108]));
        acrossData.exclusiveRelayer = address(bytes20(data[108:128]));
        acrossData.quoteTimestamp = uint32(bytes4(data[128:132]));
        acrossData.fillDeadline = uint32(bytes4(data[132:136]));
        acrossData.exclusivityDeadline = uint32(bytes4(data[136:140]));
        acrossData.message = data[140:];

        return (bridgeData, acrossData);
    }

    /// @notice Decodes calldata that is meant to be used for calling the ERC20 'packed' function
    /// @param data the calldata to be decoded
    function decode_startBridgeTokensViaAcrossV3ERC20Packed(
        bytes calldata data
    )
        external
        pure
        returns (
            BridgeData memory bridgeData,
            AcrossFacetV3.AcrossV3Data memory acrossData
        )
    {
        require(
            data.length >= 176,
            "invalid calldata (must have length >= 176)"
        );

        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(bytes20(data[12:32]));
        acrossData.refundAddress = address(bytes20(data[32:52])); // depositor
        bridgeData.sendingAssetId = address(bytes20(data[52:72]));
        bridgeData.minAmount = uint256(uint128(bytes16(data[72:88])));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[88:92])));

        acrossData.receivingAssetId = address(bytes20(data[92:112]));
        acrossData.outputAmount = uint256(bytes32(data[112:144]));
        acrossData.exclusiveRelayer = address(bytes20(data[144:164]));
        acrossData.quoteTimestamp = uint32(bytes4(data[164:168]));
        acrossData.fillDeadline = uint32(bytes4(data[168:172]));
        acrossData.exclusivityDeadline = uint32(bytes4(data[172:176]));
        acrossData.message = data[176:];

        return (bridgeData, acrossData);
    }

    /// @notice Execute calldata and withdraw asset
    /// @param _callTo The address to execute the calldata on
    /// @param _callData The data to execute
    /// @param _assetAddress Asset to be withdrawn
    /// @param _to address to withdraw to
    /// @param _amount amount of asset to withdraw
    function executeCallAndWithdraw(
        address _callTo,
        bytes calldata _callData,
        address _assetAddress,
        address _to,
        uint256 _amount
    ) external onlyOwner {
        // execute calldata
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = _callTo.call(_callData);

        // check success of call
        if (success) {
            // call successful - withdraw the asset
            LibAsset.transferAsset(_assetAddress, payable(_to), _amount);
            emit CallExecutedAndFundsWithdrawn();
        } else {
            // call unsuccessful - revert
            revert WithdrawFailed();
        }
    }
}
