// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IAcrossSpokePool } from "../Interfaces/IAcrossSpokePool.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { AcrossFacet } from "./AcrossFacet.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { console2 } from "forge-std/console2.sol";

/// @title AcrossFacetPacked
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across in a gas-optimized way
/// @custom:version 1.0.0
contract AcrossFacetPacked is ILiFi, TransferrableOwnership {
    using SafeTransferLib for ERC20;

    bytes public constant ACROSS_REFERRER_DELIMITER = hex"d00dfeeddeadbeef";
    uint8 private constant ACROSS_REFERRER_ADDRESS_LENGTH = 20;
    uint256 private constant REFERRER_OFFSET = 28;

    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    IAcrossSpokePool private immutable spokePool;

    /// @notice The WETH address on the current chain.
    address private immutable wrappedNative;

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
    function startBridgeTokensViaAcrossNativePacked() external payable {
        // calculate end of calldata (and start of delimiter + referrer address)
        uint256 calldataEndsAt = msg.data.length - REFERRER_OFFSET;

        // call Across spoke pool to bridge assets
        spokePool.deposit{ value: msg.value }(
            address(bytes20(msg.data[12:32])), // receiver
            wrappedNative, // wrappedNative address
            msg.value, // minAmount
            uint64(uint32(bytes4(msg.data[32:36]))), // destinationChainId
            int64(uint64(bytes8(msg.data[36:44]))), // int64 relayerFeePct
            uint32(bytes4(msg.data[44:48])), // uint32 quoteTimestamp
            msg.data[80:calldataEndsAt], // bytes message (due to variable length positioned at the end of the calldata)
            uint256(bytes32(msg.data[48:80])) // uint256 maxCount
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges native tokens via Across (minimal implementation)
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param relayerFeePct The relayer fee in token percentage with 18 decimals
    /// @param quoteTimestamp The timestamp associated with the suggested fee
    /// @param message Arbitrary data that can be used to pass additional information to the recipient along with the tokens
    /// @param maxCount Used to protect the depositor from frontrunning to guarantee their quote remains valid
    function startBridgeTokensViaAcrossNativeMin(
        bytes32 transactionId,
        address receiver,
        uint256 destinationChainId,
        int64 relayerFeePct,
        uint32 quoteTimestamp,
        bytes calldata message,
        uint256 maxCount
    ) external payable {
        // call Across spoke pool to bridge assets
        spokePool.deposit{ value: msg.value }(
            receiver,
            wrappedNative,
            msg.value,
            destinationChainId,
            relayerFeePct,
            quoteTimestamp,
            message,
            maxCount
        );

        emit LiFiAcrossTransfer(bytes8(transactionId));
    }

    /// @notice Bridges ERC20 tokens via Across (packed implementation)
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaAcrossERC20Packed() external payable {
        address sendingAssetId = address(bytes20(msg.data[32:52]));
        uint256 minAmount = uint256(uint128(bytes16(msg.data[52:68])));

        // Deposit assets
        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // calculate end of calldata (and start of delimiter + referrer address)
        uint256 calldataEndsAt = msg.data.length - REFERRER_OFFSET;

        // call Across spoke pool to bridge assets
        spokePool.deposit(
            address(bytes20(msg.data[12:32])), // receiver
            address(bytes20(msg.data[32:52])), // sendingAssetID
            minAmount,
            uint64(uint32(bytes4(msg.data[68:72]))), // destinationChainId
            int64(uint64(bytes8(msg.data[72:80]))), // int64 relayerFeePct
            uint32(bytes4(msg.data[80:84])), // uint32 quoteTimestamp
            msg.data[116:calldataEndsAt], // bytes message (due to variable length positioned at the end of the calldata)
            uint256(bytes32(msg.data[84:116])) // uint256 maxCount
        );

        emit LiFiAcrossTransfer(bytes8(msg.data[4:12]));
    }

    function startBridgeTokensViaAcrossERC20Min(
        bytes32 transactionId,
        address sendingAssetId,
        uint256 minAmount,
        address receiver,
        uint64 destinationChainId,
        int64 relayerFeePct,
        uint32 quoteTimestamp,
        bytes calldata message,
        uint256 maxCount
    ) external payable {
        // Deposit assets
        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // call Across spoke pool to bridge assets
        spokePool.deposit(
            receiver,
            sendingAssetId,
            minAmount,
            destinationChainId,
            relayerFeePct,
            quoteTimestamp,
            message,
            maxCount
        );

        emit LiFiAcrossTransfer(bytes8(transactionId));
    }

    function encode_startBridgeTokensViaAcrossNativePacked(
        bytes32 transactionId,
        address receiver,
        uint64 destinationChainId,
        int64 relayerFeePct,
        uint32 quoteTimestamp,
        uint256 maxCount,
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
                AcrossFacetPacked
                    .startBridgeTokensViaAcrossNativePacked
                    .selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes8(uint64(relayerFeePct)),
                bytes4(quoteTimestamp),
                bytes32(maxCount),
                message
            );
    }

    function encode_startBridgeTokensViaAcrossERC20Packed(
        bytes32 transactionId,
        address receiver,
        address sendingAssetId,
        uint256 minAmount,
        uint256 destinationChainId,
        int64 relayerFeePct,
        uint32 quoteTimestamp,
        bytes calldata message,
        uint256 maxCount
    ) external pure returns (bytes memory) {
        // there are already existing networks with chainIds outside uint32 range but since we not support either of them yet,
        // we feel comfortable using this approach to save further gas
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );

        require(
            minAmount <= type(uint128).max,
            "minAmount value passed too big to fit in uint128"
        );

        return
            bytes.concat(
                AcrossFacetPacked
                    .startBridgeTokensViaAcrossERC20Packed
                    .selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes20(sendingAssetId),
                bytes16(uint128(minAmount)),
                bytes4(uint32(destinationChainId)),
                bytes8(uint64(relayerFeePct)),
                bytes4(uint32(quoteTimestamp)),
                bytes32(maxCount),
                message
            );
    }

    function decode_startBridgeTokensViaAcrossNativePacked(
        bytes calldata data
    )
        external
        pure
        returns (
            BridgeData memory bridgeData,
            AcrossFacet.AcrossData memory acrossData
        )
    {
        require(
            data.length >= 108,
            "invalid calldata (must have length > 108)"
        );

        // calculate end of calldata (and start of delimiter + referrer address)
        uint256 calldataEndsAt = data.length - REFERRER_OFFSET;

        // extract bridgeData
        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(bytes20(data[12:32]));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[32:36])));

        // extract acrossData
        acrossData.relayerFeePct = int64(uint64(bytes8(data[36:44])));
        acrossData.quoteTimestamp = uint32(bytes4(data[44:48]));
        acrossData.maxCount = uint256(bytes32(data[48:80]));
        acrossData.message = data[80:calldataEndsAt];

        return (bridgeData, acrossData);
    }

    function decode_startBridgeTokensViaAcrossERC20Packed(
        bytes calldata data
    )
        external
        pure
        returns (
            BridgeData memory bridgeData,
            AcrossFacet.AcrossData memory acrossData
        )
    {
        require(
            data.length >= 144,
            "invalid calldata (must have length > 144)"
        );

        // calculate end of calldata (and start of delimiter + referrer address)
        uint256 calldataEndsAt = data.length - REFERRER_OFFSET;

        bridgeData.transactionId = bytes32(bytes8(data[4:12]));
        bridgeData.receiver = address(bytes20(data[12:32]));
        bridgeData.sendingAssetId = address(bytes20(data[32:52]));
        bridgeData.minAmount = uint256(uint128(bytes16(data[52:68])));
        bridgeData.destinationChainId = uint64(uint32(bytes4(data[68:72])));

        // extract acrossData
        acrossData.relayerFeePct = int64(uint64(bytes8(data[72:80])));
        acrossData.quoteTimestamp = uint32(bytes4(data[80:84]));
        acrossData.maxCount = uint256(bytes32(data[84:116]));
        acrossData.message = data[116:calldataEndsAt];

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
