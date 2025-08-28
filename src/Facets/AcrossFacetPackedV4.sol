// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IAcrossSpokePoolV4 } from "../Interfaces/IAcrossSpokePoolV4.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { AcrossFacetV4 } from "./AcrossFacetV4.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title AcrossFacetPackedV4
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across in a gas-optimized way
/// @dev This packed implementation prioritizes gas optimization over runtime validation.
///      Critical parameters like refund addresses are not validated to minimize gas costs.
///      Callers must ensure valid parameters to avoid potential loss of funds.
///      For more validation and safety, use the non-packed AcrossFacetV4 via LiFiDiamond.
/// @custom:version 1.0.0
contract AcrossFacetPackedV4 is ILiFi, TransferrableOwnership {
    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    IAcrossSpokePoolV4 public immutable SPOKEPOOL;

    /// @notice The WETH address on the current chain.
    bytes32 public immutable WRAPPED_NATIVE;

    /// Events ///

    event LiFiAcrossTransfer(bytes8 _transactionId);
    event CallExecutedAndFundsWithdrawn();

    /// Errors ///

    error WithdrawFailed();
    error InvalidDestinationChainId();
    error InvalidInputAmount();
    error InvalidCalldataLength();

    // using this struct to bundle parameters is required since otherwise we run into stack-too-deep errors
    // (Solidity can only handle a limited amount of parameters at any given time)
    struct PackedParameters {
        bytes32 transactionId;
        bytes32 receiver;
        bytes32 depositor; // also acts as refund address in case release tx cannot be executed
        bytes32 sendingAssetId;
        uint64 destinationChainId;
        bytes32 receivingAssetId;
        uint256 outputAmount;
        bytes32 exclusiveRelayer;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityParameter;
        bytes message;
    }

    /// Constructor ///

    /// @notice Initialize the contract
    /// @param _spokePool The contract address of the spoke pool on the source chain
    /// @param _wrappedNative The address of the wrapped native token on the source chain
    /// @param _owner The address of the contract owner
    constructor(
        IAcrossSpokePoolV4 _spokePool,
        bytes32 _wrappedNative,
        address _owner
    ) TransferrableOwnership(_owner) {
        if (
            address(_spokePool) == address(0) ||
            _wrappedNative == bytes32(0) ||
            _owner == address(0)
        ) {
            revert InvalidConfig();
        }

        SPOKEPOOL = _spokePool;
        WRAPPED_NATIVE = _wrappedNative;
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
                address(SPOKEPOOL),
                type(uint256).max
            );
        }
    }

    /// @notice Bridges native tokens via Across (packed implementation)
    /// @dev Calldata mapping:
    /// [0:4] - function selector
    /// [4:12] - transactionId
    /// [12:44] - receiver
    /// [44:76] - depositor (also acts as refund address in case release tx cannot be executed)
    /// [76:108] - sendingAssetId (bytes32)
    /// [108:140] - outputAmount
    /// [140:172] - destinationChainId
    /// [172:204] - exclusiveRelayer
    /// [204:208] - quoteTimestamp
    /// [208:212] - fillDeadline
    /// [212:216] - exclusivityParameter
    /// [216:] - message
    /// @dev NOTE: This packed implementation prioritizes gas optimization over runtime validation.
    ///      The depositor parameter (refund address) is not validated to be non-zero.
    ///      Callers must ensure valid parameters to avoid potential loss of funds.
    ///      For full validation, use the non-packed AcrossFacetV4 implementation.
    function startBridgeTokensViaAcrossV4NativePacked() external payable {
        // call Across spoke pool to bridge assets
        SPOKEPOOL.deposit{ value: msg.value }(
            bytes32(msg.data[44:76]), // depositor
            bytes32(msg.data[12:44]), // recipient
            WRAPPED_NATIVE, // inputToken (native is always wrapped)
            bytes32(msg.data[108:140]), // outputToken (receivingAssetId)
            msg.value, // inputAmount
            uint256(bytes32(msg.data[140:172])), // outputAmount
            uint64(uint32(bytes4(msg.data[172:176]))), // destinationChainId
            bytes32(msg.data[176:208]), // exclusiveRelayer
            uint32(bytes4(msg.data[208:212])), // quoteTimestamp
            uint32(bytes4(msg.data[212:216])), // fillDeadline
            uint32(bytes4(msg.data[216:220])), // exclusivityParameter
            msg.data[220:msg.data.length]
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges native tokens via Across (minimal implementation)
    /// @param _parameters Contains all parameters required for native bridging with AcrossV4
    /// @dev NOTE: This minimal implementation prioritizes gas optimization over runtime validation.
    ///      The depositor parameter (refund address) is not validated to be non-zero.
    ///      Callers must ensure valid parameters to avoid potential loss of funds.
    ///      For full validation, use the non-packed AcrossFacetV4 implementation.
    function startBridgeTokensViaAcrossV4NativeMin(
        PackedParameters calldata _parameters
    ) external payable {
        // call Across spoke pool to bridge assets
        SPOKEPOOL.deposit{ value: msg.value }(
            _parameters.depositor, // depositor
            _parameters.receiver,
            WRAPPED_NATIVE, // inputToken
            _parameters.receivingAssetId, // outputToken
            msg.value, // inputAmount
            _parameters.outputAmount,
            _parameters.destinationChainId,
            _parameters.exclusiveRelayer,
            _parameters.quoteTimestamp,
            _parameters.fillDeadline,
            _parameters.exclusivityParameter,
            _parameters.message
        );

        emit LiFiAcrossTransfer(bytes8(_parameters.transactionId));
    }

    /// @notice Bridges ERC20 tokens via Across (packed implementation)
    /// @dev Calldata mapping:
    /// [0:4] - function selector
    /// [4:12] - transactionId
    /// [12:44] - receiver
    /// [44:76] - depositor (also acts as refund address in case release tx cannot be executed)
    /// [76:108] - sendingAssetId (bytes32)
    /// [108:124] - inputAmount
    /// [124:128] - destinationChainId
    /// [128:160] - receivingAssetId
    /// [160:192] - outputAmount
    /// [192:224] - exclusiveRelayer
    /// [224:228] - quoteTimestamp
    /// [228:232] - fillDeadline
    /// [232:236] - exclusivityParameter
    /// [236:] - message
    /// @dev NOTE: This packed implementation prioritizes gas optimization over runtime validation.
    ///      The depositor parameter (refund address) is not validated to be non-zero.
    ///      Callers must ensure valid parameters to avoid potential loss of funds.
    ///      For full validation, use the non-packed AcrossFacetV4 implementation.
    function startBridgeTokensViaAcrossV4ERC20Packed() external {
        bytes32 sendingAssetId = bytes32(msg.data[76:108]);
        uint256 inputAmount = uint256(uint128(bytes16(msg.data[108:124])));

        LibAsset.transferFromERC20(
            address(uint160(uint256(sendingAssetId))),
            msg.sender,
            address(this),
            inputAmount
        );

        SPOKEPOOL.deposit(
            bytes32(msg.data[44:76]), // depositor
            bytes32(msg.data[12:44]), // recipient
            sendingAssetId, // inputToken
            bytes32(msg.data[128:160]), // outputToken (receivingAssetId)
            inputAmount, // inputAmount
            uint256(bytes32(msg.data[160:192])), // outputAmount
            uint64(uint32(bytes4(msg.data[124:128]))), // destinationChainId
            bytes32(msg.data[192:224]), // exclusiveRelayer
            uint32(bytes4(msg.data[224:228])), // quoteTimestamp
            uint32(bytes4(msg.data[228:232])), // fillDeadline
            uint32(bytes4(msg.data[232:236])), // exclusivityParameter
            msg.data[236:msg.data.length]
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges ERC20 tokens via Across (minimal implementation)
    /// @param _parameters Contains all base parameters required for bridging with AcrossV4
    /// @param inputAmount The amount to be bridged (including fees)
    /// @dev NOTE: This minimal implementation prioritizes gas optimization over runtime validation.
    ///      The depositor parameter (refund address) is not validated to be non-zero.
    ///      Callers must ensure valid parameters to avoid potential loss of funds.
    ///      For full validation, use the non-packed AcrossFacetV4 implementation.
    function startBridgeTokensViaAcrossV4ERC20Min(
        PackedParameters calldata _parameters,
        uint256 inputAmount
    ) external {
        // Convert bytes32 sendingAssetId back to address for ERC20 operations
        address sendingAssetId = address(
            uint160(uint256(_parameters.sendingAssetId))
        );

        // Deposit assets
        LibAsset.transferFromERC20(
            sendingAssetId,
            msg.sender,
            address(this),
            inputAmount
        );

        // call Across SpokePool
        SPOKEPOOL.deposit(
            _parameters.depositor, // depositor
            _parameters.receiver,
            _parameters.sendingAssetId, // inputToken (now from parameters)
            _parameters.receivingAssetId, // outputToken
            inputAmount,
            _parameters.outputAmount,
            _parameters.destinationChainId,
            _parameters.exclusiveRelayer,
            _parameters.quoteTimestamp,
            _parameters.fillDeadline,
            _parameters.exclusivityParameter,
            _parameters.message
        );

        emit LiFiAcrossTransfer(bytes8(_parameters.transactionId));
    }

    /// @notice Encodes calldata that can be used to call the native 'packed' function
    /// @param _parameters Contains all parameters required for native bridging with AcrossV4
    function encode_startBridgeTokensViaAcrossV4NativePacked(
        PackedParameters calldata _parameters
    ) external pure returns (bytes memory) {
        // there are already existing networks with chainIds outside uint32 range but since we not
        // support either of them yet, we feel comfortable using this approach to save further gas
        if (_parameters.destinationChainId > type(uint32).max) {
            revert InvalidDestinationChainId();
        }

        return
            bytes.concat(
                AcrossFacetPackedV4
                    .startBridgeTokensViaAcrossV4NativePacked
                    .selector,
                bytes8(_parameters.transactionId),
                _parameters.receiver,
                _parameters.depositor,
                _parameters.sendingAssetId,
                _parameters.receivingAssetId,
                bytes32(_parameters.outputAmount),
                bytes4(uint32(_parameters.destinationChainId)),
                _parameters.exclusiveRelayer,
                bytes4(_parameters.quoteTimestamp),
                bytes4(_parameters.fillDeadline),
                bytes4(_parameters.exclusivityParameter),
                _parameters.message
            );
    }

    /// @notice Encodes calldata that can be used to call the ERC20 'packed' function
    /// @param _parameters Contains all base parameters required for bridging with AcrossV4
    /// @param inputAmount The amount to be bridged (including fees)
    function encode_startBridgeTokensViaAcrossV4ERC20Packed(
        PackedParameters calldata _parameters,
        uint256 inputAmount
    ) external pure returns (bytes memory) {
        // there are already existing networks with chainIds outside uint32 range but since we not
        // support either of them yet, we feel comfortable using this approach to save further gas
        if (_parameters.destinationChainId > type(uint32).max) {
            revert InvalidDestinationChainId();
        }

        if (inputAmount > type(uint128).max) {
            revert InvalidInputAmount();
        }

        // Split the concatenation into parts to avoid "stack too deep" errors
        bytes memory part1 = bytes.concat(
            AcrossFacetPackedV4
                .startBridgeTokensViaAcrossV4ERC20Packed
                .selector,
            bytes8(_parameters.transactionId),
            _parameters.receiver,
            _parameters.depositor,
            _parameters.sendingAssetId
        );

        bytes memory part2 = bytes.concat(
            bytes16(uint128(inputAmount)),
            bytes4(uint32(_parameters.destinationChainId)),
            _parameters.receivingAssetId,
            bytes32(_parameters.outputAmount)
        );

        bytes memory part3 = bytes.concat(
            _parameters.exclusiveRelayer,
            bytes4(_parameters.quoteTimestamp),
            bytes4(_parameters.fillDeadline),
            bytes4(_parameters.exclusivityParameter)
        );

        // Combine all parts with the message
        return bytes.concat(part1, part2, part3, _parameters.message);
    }

    /// @notice Decodes calldata that is meant to be used for calling the native 'packed' function
    /// @param data the calldata to be decoded
    function decode_startBridgeTokensViaAcrossV4NativePacked(
        bytes calldata data
    )
        external
        pure
        returns (
            ILiFi.BridgeData memory bridgeData,
            AcrossFacetV4.AcrossV4Data memory acrossData
        )
    {
        if (data.length < 220) {
            revert InvalidCalldataLength();
        }

        // extract bridgeData
        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(uint160(uint256(bytes32(data[12:44]))));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[172:176])));

        // extract acrossData
        acrossData.refundAddress = bytes32(data[44:76]); // depositor
        acrossData.sendingAssetId = bytes32(data[76:108]); // sendingAssetId
        acrossData.receivingAssetId = bytes32(data[108:140]);
        acrossData.outputAmount = uint256(bytes32(data[140:172]));
        acrossData.exclusiveRelayer = bytes32(data[176:208]);
        acrossData.quoteTimestamp = uint32(bytes4(data[208:212]));
        acrossData.fillDeadline = uint32(bytes4(data[212:216]));
        acrossData.exclusivityParameter = uint32(bytes4(data[216:220]));
        acrossData.message = data[220:];

        return (bridgeData, acrossData);
    }

    /// @notice Decodes calldata that is meant to be used for calling the ERC20 'packed' function
    /// @param data the calldata to be decoded
    function decode_startBridgeTokensViaAcrossV4ERC20Packed(
        bytes calldata data
    )
        external
        pure
        returns (
            ILiFi.BridgeData memory bridgeData,
            AcrossFacetV4.AcrossV4Data memory acrossData
        )
    {
        if (data.length < 236) {
            revert InvalidCalldataLength();
        }

        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(uint160(uint256(bytes32(data[12:44]))));
        acrossData.refundAddress = bytes32(data[44:76]); // depositor
        acrossData.sendingAssetId = bytes32(data[76:108]); // sendingAssetId
        bridgeData.sendingAssetId = address(
            uint160(uint256(bytes32(data[76:108])))
        );
        bridgeData.minAmount = uint256(uint128(bytes16(data[108:124])));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[124:128])));

        acrossData.receivingAssetId = bytes32(data[128:160]);
        acrossData.outputAmount = uint256(bytes32(data[160:192]));
        acrossData.exclusiveRelayer = bytes32(data[192:224]);
        acrossData.quoteTimestamp = uint32(bytes4(data[224:228]));
        acrossData.fillDeadline = uint32(bytes4(data[228:232]));
        acrossData.exclusivityParameter = uint32(bytes4(data[232:236]));
        acrossData.message = data[236:];

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
