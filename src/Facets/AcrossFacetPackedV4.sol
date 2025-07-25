// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IAcrossSpokePoolV4 } from "../Interfaces/IAcrossSpokePoolV4.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { AcrossFacetV4 } from "./AcrossFacetV4.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";

/// @title AcrossFacetPackedV4
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across in a gas-optimized way
/// @custom:version 1.0.0
contract AcrossFacetPackedV4 is ILiFi, TransferrableOwnership {
    using SafeTransferLib for ERC20;

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
        bytes32 depositor;
        uint64 destinationChainId;
        bytes32 receivingAssetId;
        uint256 outputAmount;
        bytes32 exclusiveRelayer;
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
        IAcrossSpokePoolV4 _spokePool,
        bytes32 _wrappedNative,
        address _owner
    ) TransferrableOwnership(_owner) {
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
    function startBridgeTokensViaAcrossV4NativePacked() external payable {
        // call Across spoke pool to bridge assets
        SPOKEPOOL.deposit{ value: msg.value }(
            bytes32(msg.data[32:64]), // depositor
            bytes32(msg.data[12:44]), // recipient
            WRAPPED_NATIVE, // inputToken
            bytes32(msg.data[56:88]), // outputToken
            msg.value, // inputAmount
            uint256(bytes32(msg.data[88:120])), // outputAmount
            uint64(uint32(bytes4(msg.data[44:48]))), // destinationChainId
            bytes32(msg.data[120:152]), // exclusiveRelayer
            uint32(bytes4(msg.data[152:156])), // quoteTimestamp
            uint32(bytes4(msg.data[156:160])), // fillDeadline
            uint32(bytes4(msg.data[160:164])), // exclusivityDeadline
            msg.data[164:msg.data.length]
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges native tokens via Across (minimal implementation)
    /// @param _parameters Contains all parameters required for native bridging with AcrossV4
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
    function startBridgeTokensViaAcrossV4ERC20Packed() external {
        address sendingAssetId = address(bytes20(msg.data[52:72]));
        uint256 inputAmount = uint256(uint128(bytes16(msg.data[72:88])));

        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            inputAmount
        );

        SPOKEPOOL.deposit(
            bytes32(msg.data[32:64]), // depositor
            bytes32(msg.data[12:44]), // recipient
            bytes32(uint256(uint160(sendingAssetId))), // inputToken
            bytes32(msg.data[92:124]), // outputToken
            inputAmount, // inputAmount
            uint256(bytes32(msg.data[124:156])), // outputAmount
            uint64(uint32(bytes4(msg.data[88:92]))), // destinationChainId
            bytes32(msg.data[156:188]), // exclusiveRelayer
            uint32(bytes4(msg.data[188:192])), // quoteTimestamp
            uint32(bytes4(msg.data[192:196])), // fillDeadline
            uint32(bytes4(msg.data[196:200])), // exclusivityDeadline
            msg.data[200:msg.data.length]
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges ERC20 tokens via Across (minimal implementation)
    /// @param _parameters Contains all base parameters required for bridging with AcrossV4
    /// @param sendingAssetId The address of the asset/token to be bridged
    /// @param inputAmount The amount to be bridged (including fees)
    function startBridgeTokensViaAcrossV4ERC20Min(
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
        SPOKEPOOL.deposit(
            _parameters.depositor, // depositor
            _parameters.receiver,
            bytes32(uint256(uint160(sendingAssetId))), // inputToken
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
                bytes4(uint32(_parameters.destinationChainId)),
                _parameters.receivingAssetId,
                bytes32(_parameters.outputAmount),
                _parameters.exclusiveRelayer,
                bytes4(_parameters.quoteTimestamp),
                bytes4(_parameters.fillDeadline),
                bytes4(_parameters.exclusivityDeadline),
                _parameters.message
            );
    }

    /// @notice Encodes calldata that can be used to call the ERC20 'packed' function
    /// @param _parameters Contains all base parameters required for bridging with AcrossV4
    /// @param sendingAssetId The address of the asset/token to be bridged
    /// @param inputAmount The amount to be bridged (including fees)
    function encode_startBridgeTokensViaAcrossV4ERC20Packed(
        PackedParameters calldata _parameters,
        address sendingAssetId,
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
            bytes20(sendingAssetId)
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
            bytes4(_parameters.exclusivityDeadline)
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
            BridgeData memory bridgeData,
            AcrossFacetV4.AcrossV4Data memory acrossData
        )
    {
        if (data.length < 164) {
            revert InvalidCalldataLength();
        }

        // extract bridgeData
        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(uint160(uint256(bytes32(data[12:44]))));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[44:48])));

        // extract acrossData
        acrossData.refundAddress = bytes32(data[32:64]); // depositor
        acrossData.receivingAssetId = bytes32(data[56:88]);
        acrossData.outputAmount = uint256(bytes32(data[88:120]));
        acrossData.exclusiveRelayer = bytes32(data[120:152]);
        acrossData.quoteTimestamp = uint32(bytes4(data[152:156]));
        acrossData.fillDeadline = uint32(bytes4(data[156:160]));
        acrossData.exclusivityDeadline = uint32(bytes4(data[160:164]));
        acrossData.message = data[164:];

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
            BridgeData memory bridgeData,
            AcrossFacetV4.AcrossV4Data memory acrossData
        )
    {
        if (data.length < 200) {
            revert InvalidCalldataLength();
        }

        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(uint160(uint256(bytes32(data[12:44]))));
        acrossData.refundAddress = bytes32(data[32:64]); // depositor
        bridgeData.sendingAssetId = address(bytes20(data[64:84]));
        bridgeData.minAmount = uint256(uint128(bytes16(data[84:100])));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[100:104])));

        acrossData.receivingAssetId = bytes32(data[104:136]);
        acrossData.outputAmount = uint256(bytes32(data[136:168]));
        acrossData.exclusiveRelayer = bytes32(data[168:200]);
        acrossData.quoteTimestamp = uint32(bytes4(data[200:204]));
        acrossData.fillDeadline = uint32(bytes4(data[204:208]));
        acrossData.exclusivityDeadline = uint32(bytes4(data[208:212]));
        acrossData.message = data[212:];

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
