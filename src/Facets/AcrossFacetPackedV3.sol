// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { IAcrossSpokePool } from "../Interfaces/IAcrossSpokePool.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { AcrossFacetV3 } from "./AcrossFacetV3.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";

/// @title AcrossFacetPackedV3
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across in a gas-optimized way
/// @custom:version 1.0.0
contract AcrossFacetPackedV3 is ILiFi, TransferrableOwnership {
    using SafeTransferLib for ERC20;

    bytes public constant ACROSS_REFERRER_DELIMITER = hex"d00dfeeddeadbeef";
    uint8 private constant ACROSS_REFERRER_ADDRESS_LENGTH = 20;
    uint256 private constant REFERRER_OFFSET = 28;

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
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaAcrossV3NativePacked() external payable {
        // call Across spoke pool to bridge assets
        spokePool.depositV3{ value: msg.value }(
            msg.sender, // depositor
            address(bytes20(msg.data[12:32])), // recipient
            wrappedNative, // inputToken
            address(bytes20(msg.data[36:56])), // outputToken
            msg.value, // inputAmount
            uint256(bytes32(msg.data[56:88])), // outputAmount
            uint64(uint32(bytes4(msg.data[32:36]))), // destinationChainId
            address(0), // exclusiveRelayer (not used by us)
            uint32(bytes4(msg.data[88:92])),
            uint32(bytes4(msg.data[92:96])),
            0, // exclusivityDeadline (not used by us)
            msg.data[96:msg.data.length - REFERRER_OFFSET]
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges native tokens via Across (minimal implementation)
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param receivingAssetId The address of the token to be received at destination chain
    /// @param outputAmount The amount to be received at destination chain (after fees)
    /// @param quoteTimestamp The timestamp of the Across quote that was used for this transaction
    /// @param fillDeadline The destination chain timestamp until which the order can be filled
    /// @param message Arbitrary data that can be used to pass additional information to the recipient along with the tokens
    function startBridgeTokensViaAcrossV3NativeMin(
        bytes32 transactionId,
        address receiver,
        uint256 destinationChainId,
        address receivingAssetId,
        uint256 outputAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        bytes calldata message
    ) external payable {
        // call Across spoke pool to bridge assets
        spokePool.depositV3{ value: msg.value }(
            msg.sender, // depositor
            receiver, // recipient
            wrappedNative, // inputToken
            receivingAssetId, // outputToken
            msg.value, // inputAmount
            outputAmount, // outputAmount
            destinationChainId,
            address(0), // exclusiveRelayer (not used by us)
            quoteTimestamp,
            fillDeadline,
            0, // exclusivityDeadline (not used by us)
            message
        );

        emit LiFiAcrossTransfer(bytes8(transactionId));
    }

    /// @notice Bridges ERC20 tokens via Across (packed implementation)
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaAcrossV3ERC20Packed() external payable {
        address sendingAssetId = address(bytes20(msg.data[32:52]));
        uint256 inputAmount = uint256(uint128(bytes16(msg.data[52:68])));

        // Deposit assets
        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            inputAmount
        );

        // call Across SpokePool
        spokePool.depositV3(
            msg.sender, // depositor
            address(bytes20(msg.data[12:32])), // recipient
            sendingAssetId, // inputToken
            address(bytes20(msg.data[72:92])), // outputToken
            inputAmount, // inputAmount
            uint256(bytes32(msg.data[92:124])), // outputAmount
            uint64(uint32(bytes4(msg.data[68:72]))), // destinationChainId
            address(0), // exclusiveRelayer (not used by us)
            uint32(bytes4(msg.data[124:128])), // uint32 quoteTimestamp
            uint32(bytes4(msg.data[128:132])), // uint32 fillDeadline
            0, // exclusivityDeadline (not used by us)
            msg.data[132:msg.data.length - REFERRER_OFFSET]
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges ERC20 tokens via Across (minimal implementation)
    /// @param transactionId Custom transaction ID for tracking
    /// @param sendingAssetId The address of the asset/token to be bridged
    /// @param inputAmount The amount to be bridged (including fees)
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param receivingAssetId The address of the token to be received at destination chain
    /// @param outputAmount The amount to be received at destination chain (after fees)
    /// @param quoteTimestamp The timestamp of the Across quote that was used for this transaction
    /// @param fillDeadline The destination chain timestamp until which the order can be filled
    /// @param message Arbitrary data that can be used to pass additional information to the recipient along with the tokens
    function startBridgeTokensViaAcrossV3ERC20Min(
        bytes32 transactionId,
        address sendingAssetId,
        uint256 inputAmount,
        address receiver,
        uint64 destinationChainId,
        address receivingAssetId,
        uint256 outputAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        bytes calldata message
    ) external payable {
        // Deposit assets
        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            inputAmount
        );

        // call Across SpokePool
        spokePool.depositV3(
            msg.sender, // depositor
            receiver, // recipient
            sendingAssetId, // inputToken
            receivingAssetId, // outputToken
            inputAmount, // inputAmount
            outputAmount, // outputAmount
            destinationChainId,
            address(0), // exclusiveRelayer (not used by us)
            quoteTimestamp,
            fillDeadline,
            0, // exclusivityDeadline (not used by us)
            message
        );

        emit LiFiAcrossTransfer(bytes8(transactionId));
    }

    /// @notice Encodes calldata that can be used to call the native 'packed' function
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param receivingAssetId The address of the token to be received at destination chain
    /// @param outputAmount The amount to be received at destination chain (after fees)
    /// @param quoteTimestamp The timestamp of the Across quote that was used for this transaction
    /// @param fillDeadline The destination chain timestamp until which the order can be filled
    /// @param message Arbitrary data that can be used to pass additional information to the recipient along with the tokens
    function encode_startBridgeTokensViaAcrossV3NativePacked(
        bytes32 transactionId,
        address receiver,
        uint256 destinationChainId,
        address receivingAssetId,
        uint256 outputAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        bytes calldata message
    ) external pure returns (bytes memory) {
        // there are already existing networks with chainIds outside uint32 range but since we not support either of them yet,
        // we feel comfortable using this approach to save further gas
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );

        return
            bytes.concat(
                AcrossFacetPackedV3
                    .startBridgeTokensViaAcrossV3NativePacked
                    .selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes20(receivingAssetId),
                bytes32(outputAmount),
                bytes4(quoteTimestamp),
                bytes4(fillDeadline),
                message
            );
    }

    /// @notice Encodes calldata that can be used to call the ERC20 'packed' function
    /// @param transactionId Custom transaction ID for tracking
    /// @param sendingAssetId The address of the asset/token to be bridged
    /// @param inputAmount The amount to be bridged (including fees)
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param receivingAssetId The address of the token to be received at destination chain
    /// @param outputAmount The amount to be received at destination chain (after fees)
    /// @param quoteTimestamp The timestamp of the Across quote that was used for this transaction
    /// @param fillDeadline The destination chain timestamp until which the order can be filled
    /// @param message Arbitrary data that can be used to pass additional information to the recipient along with the tokens
    function encode_startBridgeTokensViaAcrossV3ERC20Packed(
        bytes32 transactionId,
        address sendingAssetId,
        uint256 inputAmount,
        address receiver,
        uint64 destinationChainId,
        address receivingAssetId,
        uint256 outputAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        bytes calldata message
    ) external pure returns (bytes memory) {
        // there are already existing networks with chainIds outside uint32 range but since we not support either of them yet,
        // we feel comfortable using this approach to save further gas
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );

        require(
            inputAmount <= type(uint128).max,
            "inputAmount value passed too big to fit in uint128"
        );

        return
            bytes.concat(
                AcrossFacetPackedV3
                    .startBridgeTokensViaAcrossV3ERC20Packed
                    .selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes20(sendingAssetId),
                bytes16(uint128(inputAmount)),
                bytes4(uint32(destinationChainId)),
                bytes20(receivingAssetId),
                bytes32(outputAmount),
                bytes4(quoteTimestamp),
                bytes4(fillDeadline),
                message
            );
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
            data.length >= 96,
            "invalid calldata (must have length >= 96)"
        );

        // calculate end of calldata (and start of delimiter + referrer address)
        uint256 calldataEndsAt = data.length - REFERRER_OFFSET;

        // extract bridgeData
        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(bytes20(data[12:32]));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[32:36])));

        // extract acrossData
        acrossData.receivingAssetId = address(bytes20(data[36:56]));
        acrossData.outputAmount = uint256(bytes32(data[56:88]));
        acrossData.quoteTimestamp = uint32(bytes4(data[88:92]));
        acrossData.fillDeadline = uint32(bytes4(data[92:96]));
        acrossData.message = data[96:calldataEndsAt];

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
            data.length >= 132,
            "invalid calldata (must have length > 132)"
        );

        // calculate end of calldata (and start of delimiter + referrer address)
        uint256 calldataEndsAt = data.length - REFERRER_OFFSET;

        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(bytes20(data[12:32]));
        bridgeData.sendingAssetId = address(bytes20(data[32:52]));
        bridgeData.minAmount = uint256(uint128(bytes16(data[52:68])));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[68:72])));

        // extract acrossData
        acrossData.receivingAssetId = address(bytes20(data[72:92]));
        acrossData.outputAmount = uint256(bytes32(data[92:124]));
        acrossData.quoteTimestamp = uint32(bytes4(data[124:128]));
        acrossData.fillDeadline = uint32(bytes4(data[128:132]));
        acrossData.message = data[132:calldataEndsAt];

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
