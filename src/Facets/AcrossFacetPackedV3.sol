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
/// @custom:version 1.0.0
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
            address(bytes20(msg.data[88:108])), // exclusiveRelayer
            uint32(bytes4(msg.data[108:112])), // quoteTimestamp
            uint32(bytes4(msg.data[112:116])), // fillDeadline
            uint32(bytes4(msg.data[116:120])), // exclusivityDeadline
            msg.data[120:msg.data.length]
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
            msg.sender, // depositor
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
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaAcrossV3ERC20Packed() external {
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
            address(bytes20(msg.data[124:144])), // exclusiveRelayer
            uint32(bytes4(msg.data[144:148])), // quoteTimestamp
            uint32(bytes4(msg.data[148:152])), // fillDeadline
            uint32(bytes4(msg.data[152:156])), // exclusivityDeadline
            msg.data[156:msg.data.length]
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
            msg.sender, // depositor
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

        return
            bytes.concat(
                AcrossFacetPackedV3
                    .startBridgeTokensViaAcrossV3ERC20Packed
                    .selector,
                bytes8(_parameters.transactionId),
                bytes20(_parameters.receiver),
                bytes20(sendingAssetId),
                bytes16(uint128(inputAmount)),
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
            data.length >= 120,
            "invalid calldata (must have length >= 120)"
        );

        // extract bridgeData
        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(bytes20(data[12:32]));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[32:36])));

        // extract acrossData
        acrossData.receivingAssetId = address(bytes20(data[36:56]));
        acrossData.outputAmount = uint256(bytes32(data[56:88]));
        acrossData.exclusiveRelayer = address(bytes20(data[88:108]));
        acrossData.quoteTimestamp = uint32(bytes4(data[108:112]));
        acrossData.fillDeadline = uint32(bytes4(data[112:116]));
        acrossData.exclusivityDeadline = uint32(bytes4(data[116:120]));
        acrossData.message = data[120:];

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
            data.length >= 156,
            "invalid calldata (must have length > 156)"
        );

        // extract bridgeData
        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(bytes20(data[12:32]));
        bridgeData.sendingAssetId = address(bytes20(data[32:52]));
        bridgeData.minAmount = uint256(uint128(bytes16(data[52:68])));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[68:72])));

        // extract acrossData
        acrossData.receivingAssetId = address(bytes20(data[72:92]));
        acrossData.outputAmount = uint256(bytes32(data[92:124]));
        acrossData.exclusiveRelayer = address(bytes20(data[124:144]));
        acrossData.quoteTimestamp = uint32(bytes4(data[144:148]));
        acrossData.fillDeadline = uint32(bytes4(data[148:152]));
        acrossData.exclusivityDeadline = uint32(bytes4(data[152:156]));
        acrossData.message = data[156:];

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
