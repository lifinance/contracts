// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ICBridge } from "../Interfaces/ICBridge.sol";
import { CBridgeFacet } from "./CBridgeFacet.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ERC20 } from "solmate/utils/SafeTransferLib.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ContractCallNotAllowed, ExternalCallFailed } from "../Errors/GenericErrors.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

/// @title CBridge Facet Packed
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
/// @custom:version 1.0.0
contract CBridgeFacetPacked is ILiFi, TransferrableOwnership {
    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    ICBridge private immutable cBridge;

    /// Events ///

    event LiFiCBridgeTransfer(bytes8 _transactionId);

    event CBridgeRefund(
        address indexed _assetAddress,
        address indexed _to,
        uint256 amount
    );

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _cBridge The contract address of the cbridge on the source chain.
    constructor(ICBridge _cBridge, address _owner)
        TransferrableOwnership(_owner)
    {
        cBridge = _cBridge;
    }

    /// External Methods ///

    /// @dev Only meant to be called outside of the context of the diamond
    /// @notice Sets approval for the CBridge Router to spend the specified token
    /// @param tokensToApprove The tokens to approve to the CBridge Router
    function setApprovalForBridge(address[] calldata tokensToApprove)
        external
        onlyOwner
    {
        for (uint256 i; i < tokensToApprove.length; i++) {
            // Give CBridge approval to bridge tokens
            LibAsset.maxApproveERC20(
                IERC20(tokensToApprove[i]),
                address(cBridge),
                type(uint256).max
            );
        }
    }

    /// @notice Triggers a cBridge refund with calldata produced by cBridge API
    /// @param _callTo The address to execute the calldata on
    /// @param _callData The data to execute
    /// @param _assetAddress Asset to be withdrawn
    /// @param _to Address to withdraw to
    /// @param _amount Amount of asset to withdraw
    function triggerRefund(
        address payable _callTo,
        bytes calldata _callData,
        address _assetAddress,
        address _to,
        uint256 _amount
    ) external onlyOwner {
        // make sure that callTo address is either of the cBridge addresses
        if (address(cBridge) != _callTo) {
            revert ContractCallNotAllowed();
        }

        // call contract
        bool success;
        (success, ) = _callTo.call(_callData);
        if (!success) {
            revert ExternalCallFailed();
        }

        // forward funds to _to address and emit event
        address sendTo = (LibUtil.isZeroAddress(_to)) ? msg.sender : _to;
        LibAsset.transferAsset(_assetAddress, payable(sendTo), _amount);
        emit CBridgeRefund(_assetAddress, sendTo, _amount);
    }

    /// @notice Bridges Native tokens via cBridge (packed)
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaCBridgeNativePacked() external payable {
        cBridge.sendNative{ value: msg.value }(
            address(bytes20(msg.data[12:32])), // receiver
            msg.value, // amount
            uint64(uint32(bytes4(msg.data[32:36]))), // destinationChainId
            uint64(uint32(bytes4(msg.data[36:40]))), // nonce
            uint32(bytes4(msg.data[40:44])) // maxSlippage
        );

        emit LiFiCBridgeTransfer(bytes8(msg.data[4:12])); // transactionId
    }

    /// @notice Bridges native tokens via cBridge
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param nonce A number input to guarantee uniqueness of transferId.
    /// @param maxSlippage Destination swap minimal accepted amount
    function startBridgeTokensViaCBridgeNativeMin(
        bytes32 transactionId,
        address receiver,
        uint64 destinationChainId,
        uint64 nonce,
        uint32 maxSlippage
    ) external payable {
        cBridge.sendNative{ value: msg.value }(
            receiver,
            msg.value,
            destinationChainId,
            nonce,
            maxSlippage
        );

        emit LiFiCBridgeTransfer(bytes8(transactionId));
    }

    /// @notice Bridges ERC20 tokens via cBridge
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaCBridgeERC20Packed() external {
        address sendingAssetId = address(bytes20(msg.data[36:56]));
        uint256 amount = uint256(uint128(bytes16(msg.data[56:72])));

        // Deposit assets
        ERC20(sendingAssetId).transferFrom(msg.sender, address(this), amount);

        // Bridge assets
        // solhint-disable-next-line check-send-result
        cBridge.send(
            address(bytes20(msg.data[12:32])), // receiver
            sendingAssetId, // sendingAssetId
            amount, // amount
            uint64(uint32(bytes4(msg.data[32:36]))), // destinationChainId
            uint64(uint32(bytes4(msg.data[72:76]))), // nonce
            uint32(bytes4(msg.data[76:80])) // maxSlippage
        );

        emit LiFiCBridgeTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges ERC20 tokens via cBridge
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param amount Amount of the source asset to bridge
    /// @param nonce A number input to guarantee uniqueness of transferId
    /// @param maxSlippage Destination swap minimal accepted amount
    function startBridgeTokensViaCBridgeERC20Min(
        bytes32 transactionId,
        address receiver,
        uint64 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint64 nonce,
        uint32 maxSlippage
    ) external {
        // Deposit assets
        ERC20(sendingAssetId).transferFrom(msg.sender, address(this), amount);

        // Bridge assets
        // solhint-disable-next-line check-send-result
        cBridge.send(
            receiver,
            sendingAssetId,
            amount,
            destinationChainId,
            nonce,
            maxSlippage
        );

        emit LiFiCBridgeTransfer(bytes8(transactionId));
    }

    /// Encoder/Decoders ///

    /// @notice Encodes calldata for startBridgeTokensViaCBridgeNativePacked
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param nonce A number input to guarantee uniqueness of transferId.
    /// @param maxSlippage Destination swap minimal accepted amount
    function encode_startBridgeTokensViaCBridgeNativePacked(
        bytes32 transactionId,
        address receiver,
        uint64 destinationChainId,
        uint64 nonce,
        uint32 maxSlippage
    ) external pure returns (bytes memory) {
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            nonce <= type(uint32).max,
            "nonce value passed too big to fit in uint32"
        );

        return
            bytes.concat(
                CBridgeFacetPacked
                    .startBridgeTokensViaCBridgeNativePacked
                    .selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes4(uint32(nonce)),
                bytes4(maxSlippage)
            );
    }

    /// @notice Decodes calldata for startBridgeTokensViaCBridgeNativePacked
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaCBridgeNativePacked(
        bytes calldata _data
    )
        external
        pure
        returns (BridgeData memory, CBridgeFacet.CBridgeData memory)
    {
        require(
            _data.length >= 40,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        CBridgeFacet.CBridgeData memory cBridgeData;

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.receiver = address(bytes20(_data[28:48]));
        bridgeData.destinationChainId = uint64(uint32(bytes4(_data[48:52])));
        cBridgeData.nonce = uint64(uint32(bytes4(_data[52:56])));
        cBridgeData.maxSlippage = uint32(bytes4(_data[56:60]));

        return (bridgeData, cBridgeData);
    }

    /// @notice Encodes calldata for startBridgeTokensViaCBridgeERC20Packed
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param nonce A number input to guarantee uniqueness of transferId
    /// @param maxSlippage Destination swap minimal accepted amount
    function encode_startBridgeTokensViaCBridgeERC20Packed(
        bytes32 transactionId,
        address receiver,
        uint64 destinationChainId,
        address sendingAssetId,
        uint256 minAmount,
        uint64 nonce,
        uint32 maxSlippage
    ) external pure returns (bytes memory) {
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            minAmount <= type(uint128).max,
            "amount value passed too big to fit in uint128"
        );
        require(
            nonce <= type(uint32).max,
            "nonce value passed too big to fit in uint32"
        );

        return
            bytes.concat(
                CBridgeFacetPacked
                    .startBridgeTokensViaCBridgeERC20Packed
                    .selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes20(sendingAssetId),
                bytes16(uint128(minAmount)),
                bytes4(uint32(nonce)),
                bytes4(maxSlippage)
            );
    }

    function decode_startBridgeTokensViaCBridgeERC20Packed(
        bytes calldata _data
    )
        external
        pure
        returns (BridgeData memory, CBridgeFacet.CBridgeData memory)
    {
        require(_data.length >= 76, "data passed is not the correct length");

        BridgeData memory bridgeData;
        CBridgeFacet.CBridgeData memory cBridgeData;

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.receiver = address(bytes20(_data[12:22]));
        bridgeData.destinationChainId = uint64(uint32(bytes4(_data[22:26])));
        bridgeData.sendingAssetId = address(bytes20(_data[26:46]));
        bridgeData.minAmount = uint256(uint128(bytes16(_data[46:62])));
        cBridgeData.nonce = uint64(uint32(bytes4(_data[62:66])));
        cBridgeData.maxSlippage = uint32(bytes4(_data[66:70]));

        return (bridgeData, cBridgeData);
    }
}
