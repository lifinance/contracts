// // SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IConnextHandler } from "../Interfaces/IConnextHandler.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";

/// @title Amarok Facet (Optimized for Rollups)
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Amarok
/// @custom:version 0.0.1
contract AmarokFacetPacked is ILiFi, TransferrableOwnership {
    using SafeTransferLib for ERC20;

    /// Storage

    /// @notice The contract address of the connext handler on the source chain.
    IConnextHandler private immutable connextHandler;

    /// Errors ///

    error Invalid();

    /// Events ///

    event LiFiAmarokTransfer(bytes8 _transactionId);

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _owner The contract owner to approve tokens.
    /// @param _connextHandler The contract address of the connext handler on the source chain.
    constructor(
        address _owner,
        IConnextHandler _connextHandler
    ) TransferrableOwnership(_owner) {
        if (address(_connextHandler) == address(0)) {
            revert Invalid();
        }
        connextHandler = _connextHandler;
    }

    /// External Methods ///

    /// @dev Only meant to be called outside of the context of the diamond
    /// @notice Sets approval for the Amarok bridge to spend the specified token
    /// @param tokensToApprove The tokens to approve to approve to the Amarok bridge
    function setApprovalForAmarokBridges(
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
    function startBridgeTokensViaAmarokERC20Packed() external {
        address receiver = address(bytes20(msg.data[12:32]));
        address token = address(bytes20(msg.data[32:52]));
        uint256 amount = uint256(uint128(bytes16(msg.data[52:68])));
        uint256 relayerFee = uint64(uint32(bytes4(msg.data[88:104])));

        // Deposit assets
        ERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        connextHandler.xcall(
            uint32(bytes4(msg.data[68:72])),
            receiver,
            token,
            receiver,
            amount - relayerFee,
            uint256(uint128(bytes16(msg.data[72:88]))),
            "0x",
            relayerFee
        );

        emit LiFiAmarokTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges ERC20 tokens via Amarok
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param destChainDomainId The Amarok-specific domainId of the destination chain
    /// @param slippageTol Max bps of original due to slippage (i.e. would be 9995 to tolerate .05% slippage)
    /// @param relayerFee The amount of relayer fee the tx called xcall with
    function startBridgeTokensViaAmarokERC20Min(
        bytes8 transactionId,
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
            receiver,
            sendingAssetId,
            receiver,
            minAmount - relayerFee,
            slippageTol,
            "0x",
            relayerFee
        );

        emit LiFiAmarokTransfer(transactionId);
    }

    /// @notice Encode call data to bridge ERC20 tokens via Amarok
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param destChainDomainId The Amarok-specific domainId of the destination chain
    /// @param slippageTol Max bps of original due to slippage (i.e. would be 9995 to tolerate .05% slippage)
    /// @param relayerFee The amount of relayer fee the tx called xcall with
    function encode_startBridgeTokensViaAmarokERC20Packed(
        bytes32 transactionId, // FIXME: bytes8 or 32?
        address receiver,
        address sendingAssetId,
        uint256 minAmount,
        uint32 destChainDomainId,
        uint256 slippageTol,
        uint256 relayerFee
    ) external pure returns (bytes memory) {
        require(
            minAmount <= type(uint128).max,
            "amount value passed too big to fit in uint128"
        );
        require(
            slippageTol <= type(uint128).max,
            "slippageTol value passed too big to fit in uint128"
        );
        require(
            relayerFee <= type(uint128).max,
            "relayerFee value passed too big to fit in uint128"
        );

        return
            bytes.concat(
                AmarokFacetPacked
                    .startBridgeTokensViaAmarokERC20Packed
                    .selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes20(sendingAssetId),
                bytes16(uint128(minAmount)),
                bytes4(destChainDomainId),
                bytes16(uint128(slippageTol)),
                bytes16(uint128(relayerFee))
            );
    }

    /// @notice Decodes calldata for startBridgeTokensViaAmarokERC20Packed
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaAmarokERC20Packed(
        bytes calldata _data
    )
        external
        pure
        returns (BridgeData memory, AmarokFacet.AmarokData memory)
    {
        require(
            _data.length >= 104,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        AmarokFacet.AmarokData memory amarokData;

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.receiver = address(bytes20(_data[12:32]));
        // bridgeData.destinationChainId; // has to be mapped from destChainDomainId
        bridgeData.sendingAssetId = address(bytes20(_data[32:52]));
        bridgeData.minAmount = uint256(uint128(bytes16(_data[52:68])));

        amarokData.callData = "0x";
        amarokData.callTo = bridgeData.receiver;
        amarokData.relayerFee = uint256(uint128(bytes16(_data[88:104])));
        amarokData.slippageTol = uint256(uint128(bytes16(_data[72:88])));
        amarokData.delegate = bridgeData.receiver;
        amarokData.destChainDomainId = uint32(bytes4(_data[68:72]));
        amarokData.payFeeWithSendingAsset = true;

        return (bridgeData, amarokData);
    }
}
