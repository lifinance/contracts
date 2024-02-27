// // SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IConnextHandler } from "../Interfaces/IConnextHandler.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";
import { console2 } from "forge-std/console2.sol";

/// @title AmarokFacetPacked
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Amarok in a gas-optimized way
/// @custom:version 1.0.0
contract AmarokFacetPacked is ILiFi, TransferrableOwnership {
    using SafeTransferLib for ERC20;

    /// Storage

    /// @notice The contract address of the connext handler on the source chain.
    IConnextHandler private immutable connextHandler;

    /// Events ///

    event LiFiAmarokTransfer(bytes8 _transactionId);

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _connextHandler The contract address of the connext handler on the source chain.
    /// @param _owner The contract owner to approve tokens.
    constructor(
        IConnextHandler _connextHandler,
        address _owner
    ) TransferrableOwnership(_owner) {
        connextHandler = _connextHandler;
    }

    /// External Methods ///

    /// @dev Only meant to be called outside of the context of the diamond
    /// @notice Sets approval for the Amarok bridge to spend the specified token
    /// @param tokensToApprove The tokens to approve to approve to the Amarok bridge
    function setApprovalForBridge(
        address[] calldata tokensToApprove
    ) external onlyOwner {
        uint256 numTokens = tokensToApprove.length;

        for (uint256 i; i < numTokens; i++) {
            // Give Amarok approval to bridge tokens
            LibAsset.maxApproveERC20(
                IERC20(tokensToApprove[i]),
                address(connextHandler),
                type(uint256).max
            );
        }
    }

    /// @notice Bridges ERC20 tokens via Amarok
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset() external {
        // extract parameters that are used multiple times in this function
        address sendingAssetId = address(bytes20(msg.data[32:52]));
        uint256 minAmount = uint256(uint128(bytes16(msg.data[52:68])));
        address receiver = address(bytes20(msg.data[12:32]));
        uint256 relayerFee = uint64(uint32(bytes4(msg.data[76:92])));

        // Deposit assets
        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // call Amarok bridge
        connextHandler.xcall(
            uint32(bytes4(msg.data[68:72])), // _destChainDomainId
            receiver, // _to
            sendingAssetId,
            receiver, // _delegate
            minAmount - relayerFee,
            uint256(uint128(uint64(uint32(bytes4(msg.data[72:76]))))), // slippageTol
            "", // calldata (not required)
            relayerFee
        );

        emit LiFiAmarokTransfer(bytes8(msg.data[4:12]));
    }

    function startBridgeTokensViaAmarokERC20PackedPayFeeWithNative()
        external
        payable
    {
        // extract parameters that are used multiple times in this function
        address sendingAssetId = address(bytes20(msg.data[32:52]));
        uint256 minAmount = uint256(uint128(bytes16(msg.data[52:68])));
        address receiver = address(bytes20(msg.data[12:32]));

        // Deposit assets
        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // call Amarok bridge
        connextHandler.xcall{ value: msg.value }(
            uint32(bytes4(msg.data[68:72])), // destChainDomainId
            receiver, // _to
            sendingAssetId,
            receiver, // _delegate
            minAmount,
            uint256(uint128(uint64(uint32(bytes4(msg.data[72:76]))))), // slippageTol
            "" // calldata (not required)
        );

        emit LiFiAmarokTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges ERC20 tokens via Amarok
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param destChainDomainId The Amarok-specific domainId of the destination chain
    /// @param slippageTol Maximum acceptable slippage in BPS. For example, a value of 30 means 0.3% slippage
    /// @param relayerFee The amount of relayer fee the tx called xcall with
    function startBridgeTokensViaAmarokERC20MinPayFeeWithAsset(
        bytes32 transactionId,
        address receiver,
        address sendingAssetId,
        uint256 minAmount,
        uint32 destChainDomainId,
        uint256 slippageTol,
        uint256 relayerFee
    ) external {
        // Deposit assets
        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // Bridge assets
        connextHandler.xcall(
            destChainDomainId,
            receiver, // _to
            sendingAssetId,
            receiver, // _delegate
            minAmount - relayerFee,
            slippageTol,
            "", // calldata (not required)
            relayerFee
        );

        emit LiFiAmarokTransfer(bytes8(transactionId));
    }

    /// @notice Bridges ERC20 tokens via Amarok
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param destChainDomainId The Amarok-specific domainId of the destination chain
    /// @param slippageTol Maximum acceptable slippage in BPS. For example, a value of 30 means 0.3% slippage
    function startBridgeTokensViaAmarokERC20MinPayFeeWithNative(
        bytes32 transactionId,
        address receiver,
        address sendingAssetId,
        uint256 minAmount,
        uint32 destChainDomainId,
        uint256 slippageTol
    ) external payable {
        // Deposit assets
        ERC20(sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // Bridge assets
        connextHandler.xcall{ value: msg.value }(
            destChainDomainId,
            receiver, // _to
            sendingAssetId,
            receiver, // _delegate
            minAmount,
            slippageTol,
            "" // calldata (not required)
        );

        emit LiFiAmarokTransfer(bytes8(transactionId));
    }

    /// @notice Encode call data to bridge ERC20 tokens via Amarok
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param destChainDomainId The Amarok-specific domainId of the destination chain
    /// @param slippageTol Max bps of original due to slippage (i.e. would be 9995 to tolerate .05% slippage)
    /// @param relayerFee The amount of relayer fee the tx called xcall with
    function encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset(
        bytes32 transactionId,
        address receiver,
        address sendingAssetId,
        uint256 minAmount,
        uint32 destChainDomainId,
        uint256 slippageTol,
        uint256 relayerFee
    ) external pure returns (bytes memory) {
        require(
            minAmount <= type(uint128).max,
            "minAmount value passed too big to fit in uint128"
        );
        require(
            slippageTol <= type(uint32).max,
            "slippageTol value passed too big to fit in uint32"
        );
        require(
            relayerFee <= type(uint128).max,
            "relayerFee value passed too big to fit in uint128"
        );

        return
            bytes.concat(
                AmarokFacetPacked
                    .startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset
                    .selector,
                bytes8(transactionId), // we only use 8 bytes of the 32bytes txId in order to save gas
                bytes20(receiver),
                bytes20(sendingAssetId),
                bytes16(uint128(minAmount)),
                bytes4(destChainDomainId),
                bytes4(uint32(slippageTol)),
                bytes16(uint128(relayerFee))
            );
    }

    /// @notice Encode call data to bridge ERC20 tokens via Amarok
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param destChainDomainId The Amarok-specific domainId of the destination chain
    /// @param slippageTol Max bps of original due to slippage (i.e. would be 9995 to tolerate .05% slippage)
    function encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithNative(
        bytes32 transactionId,
        address receiver,
        address sendingAssetId,
        uint256 minAmount,
        uint32 destChainDomainId,
        uint256 slippageTol
    ) external pure returns (bytes memory) {
        require(
            minAmount <= type(uint128).max,
            "minAmount value passed too big to fit in uint128"
        );
        require(
            slippageTol <= type(uint32).max,
            "slippageTol value passed too big to fit in uint32"
        );

        return
            bytes.concat(
                AmarokFacetPacked
                    .startBridgeTokensViaAmarokERC20PackedPayFeeWithNative
                    .selector,
                bytes8(transactionId), // we only use 8 bytes of the 32bytes txId in order to save gas
                bytes20(receiver),
                bytes20(sendingAssetId),
                bytes16(uint128(minAmount)),
                bytes4(destChainDomainId),
                bytes4(uint32(slippageTol))
            );
    }

    /// @notice Decodes calldata for startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset(
        bytes calldata _data
    )
        external
        pure
        returns (BridgeData memory, AmarokFacet.AmarokData memory)
    {
        require(
            _data.length >= 92,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        AmarokFacet.AmarokData memory amarokData;

        uint32 destChainDomainId = uint32(bytes4(_data[68:72]));

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.receiver = address(bytes20(_data[12:32]));
        bridgeData.destinationChainId = getChainIdForDomain(destChainDomainId);
        bridgeData.sendingAssetId = address(bytes20(_data[32:52]));
        bridgeData.minAmount = uint256(uint128(bytes16(_data[52:68])));

        amarokData.callData = "";
        amarokData.callTo = bridgeData.receiver;
        amarokData.destChainDomainId = destChainDomainId;
        amarokData.slippageTol = uint32(bytes4(_data[72:76]));
        amarokData.relayerFee = uint256(uint128(bytes16(_data[76:92])));
        amarokData.delegate = bridgeData.receiver;
        amarokData.payFeeWithSendingAsset = true;

        return (bridgeData, amarokData);
    }

    /// @notice Decodes calldata for startBridgeTokensViaAmarokERC20PackedPayFeeWithNative
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaAmarokERC20PackedPayFeeWithNative(
        bytes calldata _data
    )
        external
        pure
        returns (BridgeData memory, AmarokFacet.AmarokData memory)
    {
        require(
            _data.length >= 76,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        AmarokFacet.AmarokData memory amarokData;

        uint32 destChainDomainId = uint32(bytes4(_data[68:72]));

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.receiver = address(bytes20(_data[12:32]));
        bridgeData.destinationChainId = getChainIdForDomain(destChainDomainId);
        bridgeData.sendingAssetId = address(bytes20(_data[32:52]));
        bridgeData.minAmount = uint256(uint128(bytes16(_data[52:68])));

        amarokData.callData = "";
        amarokData.callTo = bridgeData.receiver;
        amarokData.destChainDomainId = destChainDomainId;
        amarokData.slippageTol = uint256(
            uint128(uint32(bytes4(_data[72:76])))
        );
        amarokData.delegate = bridgeData.receiver;
        amarokData.payFeeWithSendingAsset = false;

        return (bridgeData, amarokData);
    }

    function getChainIdForDomain(
        uint32 domainId
    ) public pure returns (uint32 chainId) {
        if (domainId == 6648936) return 1;
        // ETH
        else if (domainId == 1886350457) return 137;
        // POL
        else if (domainId == 6450786) return 56;
        // BSC
        else if (domainId == 1869640809) return 10;
        // OPT
        else if (domainId == 6778479) return 100;
        // GNO/DAI
        else if (domainId == 1634886255) return 42161;
        // ARB
        else if (domainId == 1818848877) return 59144; // LIN
    }
}
