// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IOFTWrapper, IOFT, IOFTV2, IProxyOFT } from "../Interfaces/IOFTWrapper.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { AlreadyInitialized, NotInitialized } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title OFTWrapper Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through OFTWrapper
/// @custom:version 2.0.0
contract OFTWrapperFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.oftwrapper");

    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    /// @notice The contract address of the OFTWrapper on the source chain.
    IOFTWrapper private immutable oftWrapper;

    /// Types ///

    enum TokenType {
        OFT,
        OFTV2,
        OFTFeeV2,
        ProxyOFT,
        ProxyOFTV2,
        ProxyOFTFeeV2
    }

    struct ChainIdConfig {
        uint256 chainId;
        uint16 layerZeroChainId;
    }

    struct Storage {
        mapping(uint256 => uint16) layerZeroChainId;
        bool initialized;
    }

    struct OFTWrapperData {
        TokenType tokenType;
        address proxyOFT;
        bytes32 receiver;
        uint256 minAmount;
        uint256 lzFee;
        address zroPaymentAddress;
        bytes adapterParams;
        IOFTWrapper.FeeObj feeObj;
    }

    /// Errors ///

    error UnknownLayerZeroChain();
    error InvalidProxyOFTAddress();

    /// Events ///

    event OFTWrapperInitialized(ChainIdConfig[] chainIdConfigs);

    event LayerZeroChainIdSet(
        uint256 indexed chainId,
        uint16 layerZeroChainId
    );

    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint16 indexed layerZeroChainId,
        bytes32 receiver
    );

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _oftWrapper The contract address of the OFTWrapper on the source chain.
    constructor(IOFTWrapper _oftWrapper) {
        oftWrapper = _oftWrapper;
    }

    /// Init ///

    /// @notice Initialize local variables for the OFTWrapper Facet.
    /// @param chainIdConfigs Chain Id configuration data.
    function initOFTWrapper(ChainIdConfig[] calldata chainIdConfigs) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage sm = getStorage();

        if (sm.initialized) {
            revert AlreadyInitialized();
        }

        for (uint256 i = 0; i < chainIdConfigs.length; i++) {
            sm.layerZeroChainId[chainIdConfigs[i].chainId] = chainIdConfigs[i]
                .layerZeroChainId;
        }

        sm.initialized = true;

        emit OFTWrapperInitialized(chainIdConfigs);
    }

    /// External Methods ///

    /// @notice Bridges tokens via OFT Wrapper.
    /// @param _bridgeData The core information needed for bridging.
    /// @param _oftWrapperData Data specific to OFT Wrapper.
    function startBridgeTokensViaOFTWrapper(
        ILiFi.BridgeData calldata _bridgeData,
        OFTWrapperData calldata _oftWrapperData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _oftWrapperData);
    }

    /// @notice Performs a swap before bridging via OFT Wrapper.
    /// @param _bridgeData The core information needed for bridging.
    /// @param _swapData An array of swap related data for performing swaps before bridging.
    /// @param _oftWrapperData Data specific to OFT Wrapper.
    function swapAndStartBridgeTokensViaOFTWrapper(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        OFTWrapperData calldata _oftWrapperData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            _oftWrapperData.lzFee
        );

        _startBridge(_bridgeData, _oftWrapperData);
    }

    /// @notice Get fee estimation.
    /// @param _sendingAssetId The address of briding asset.
    /// @param _destinationChainId The id of destination chain.
    /// @param _amount The amount of sending asset.
    /// @param _receiver Receiver address evm chain.
    /// @param _tokenType Type of OFT token.
    /// @param _useZro Whether fee should be paid in ZRO token or not.
    /// @param _adapterParams Parameters for custom functionality.
    /// @param _callerBps Basis points given to the caller/app.
    function estimateOFTFeesAndAmountOut(
        address _sendingAssetId,
        uint256 _destinationChainId,
        uint256 _amount,
        bytes32 _receiver,
        TokenType _tokenType,
        bool _useZro,
        bytes memory _adapterParams,
        uint256 _callerBps
    )
        external
        view
        returns (
            uint256 nativeFee,
            uint256 zroFee,
            uint256 wrapperFee,
            uint256 callerFee,
            uint256 amountOut
        )
    {
        (amountOut, wrapperFee, callerFee) = oftWrapper.getAmountAndFees(
            _sendingAssetId,
            _amount,
            _callerBps
        );

        uint16 layerZeroChainId = getOFTLayerZeroChainId(_destinationChainId);

        if (_tokenType == TokenType.OFT || _tokenType == TokenType.ProxyOFT) {
            (nativeFee, zroFee) = IOFT(_sendingAssetId).estimateSendFee(
                layerZeroChainId,
                abi.encodePacked(bytes20(_receiver << 96)),
                _amount,
                _useZro,
                _adapterParams
            );
        } else {
            (nativeFee, zroFee) = IOFTV2(_sendingAssetId).estimateSendFee(
                layerZeroChainId,
                _receiver,
                _amount,
                _useZro,
                _adapterParams
            );
        }
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via OFT Wrapper.
    /// @param _bridgeData The core information needed for bridging.
    /// @param _oftWrapperData Data specific to OFT Wrapper.
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        OFTWrapperData calldata _oftWrapperData
    ) internal {
        _checkProxyOFTAddress(
            _bridgeData.sendingAssetId,
            _oftWrapperData.tokenType,
            _oftWrapperData.proxyOFT
        );

        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(oftWrapper),
            _bridgeData.minAmount
        );

        if (_oftWrapperData.tokenType == TokenType.OFT) {
            oftWrapper.sendOFT{ value: _oftWrapperData.lzFee }(
                _bridgeData.sendingAssetId,
                getOFTLayerZeroChainId(_bridgeData.destinationChainId),
                abi.encodePacked(_bridgeData.receiver),
                _bridgeData.minAmount,
                _oftWrapperData.minAmount,
                payable(msg.sender),
                _oftWrapperData.zroPaymentAddress,
                _oftWrapperData.adapterParams,
                _oftWrapperData.feeObj
            );
        } else if (_oftWrapperData.tokenType == TokenType.ProxyOFT) {
            oftWrapper.sendProxyOFT{ value: _oftWrapperData.lzFee }(
                _oftWrapperData.proxyOFT,
                getOFTLayerZeroChainId(_bridgeData.destinationChainId),
                abi.encodePacked(_bridgeData.receiver),
                _bridgeData.minAmount,
                _oftWrapperData.minAmount,
                payable(msg.sender),
                _oftWrapperData.zroPaymentAddress,
                _oftWrapperData.adapterParams,
                _oftWrapperData.feeObj
            );
        } else {
            _sendOFTV2(_bridgeData, _oftWrapperData);
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Contains the logic for the bridge OFT V2 tokens via OFT Wrapper.
    /// @param _bridgeData The core information needed for bridging.
    /// @param _oftWrapperData Data specific to OFT Wrapper.
    function _sendOFTV2(
        ILiFi.BridgeData memory _bridgeData,
        OFTWrapperData calldata _oftWrapperData
    ) internal {
        uint16 layerZeroChainId = getOFTLayerZeroChainId(
            _bridgeData.destinationChainId
        );

        bytes32 receiver;
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            receiver = _oftWrapperData.receiver;
        } else {
            receiver = bytes32(uint256(uint160(_bridgeData.receiver)));
        }

        IOFTWrapper.LzCallParams memory lzCallParams = IOFTWrapper
            .LzCallParams(
                payable(msg.sender),
                address(0),
                _oftWrapperData.adapterParams
            );

        if (_oftWrapperData.tokenType == TokenType.OFTV2) {
            oftWrapper.sendOFTV2{ value: _oftWrapperData.lzFee }(
                _bridgeData.sendingAssetId,
                layerZeroChainId,
                receiver,
                _bridgeData.minAmount,
                _oftWrapperData.minAmount,
                lzCallParams,
                _oftWrapperData.feeObj
            );
        } else if (_oftWrapperData.tokenType == TokenType.OFTFeeV2) {
            oftWrapper.sendOFTFeeV2{ value: _oftWrapperData.lzFee }(
                _bridgeData.sendingAssetId,
                layerZeroChainId,
                receiver,
                _bridgeData.minAmount,
                _oftWrapperData.minAmount,
                lzCallParams,
                _oftWrapperData.feeObj
            );
        } else if (_oftWrapperData.tokenType == TokenType.ProxyOFTV2) {
            oftWrapper.sendProxyOFTV2{ value: _oftWrapperData.lzFee }(
                _oftWrapperData.proxyOFT,
                layerZeroChainId,
                receiver,
                _bridgeData.minAmount,
                _oftWrapperData.minAmount,
                lzCallParams,
                _oftWrapperData.feeObj
            );
        } else if (_oftWrapperData.tokenType == TokenType.ProxyOFTFeeV2) {
            oftWrapper.sendProxyOFTFeeV2{ value: _oftWrapperData.lzFee }(
                _oftWrapperData.proxyOFT,
                layerZeroChainId,
                receiver,
                _bridgeData.minAmount,
                _oftWrapperData.minAmount,
                lzCallParams,
                _oftWrapperData.feeObj
            );
        }

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                layerZeroChainId,
                _oftWrapperData.receiver
            );
        }
    }

    function _checkProxyOFTAddress(
        address sendingAssetId,
        TokenType tokenType,
        address proxyOFT
    ) internal view {
        if (
            tokenType == TokenType.ProxyOFT ||
            tokenType == TokenType.ProxyOFTV2 ||
            tokenType == TokenType.ProxyOFTFeeV2
        ) {
            if (IProxyOFT(proxyOFT).token() != sendingAssetId) {
                revert InvalidProxyOFTAddress();
            }
        }
    }

    /// Mappings management ///

    /// @notice Sets the Layer zero chain Id for a given chain Id.
    /// @param _chainId Chain Id.
    /// @param _layerZeroChainId Layer zero chain Id.
    /// @dev This is used to map a chain Id to its Layer zero chain Id.
    function setOFTLayerZeroChainId(
        uint256 _chainId,
        uint16 _layerZeroChainId
    ) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage sm = getStorage();

        if (!sm.initialized) {
            revert NotInitialized();
        }

        sm.layerZeroChainId[_chainId] = _layerZeroChainId;

        emit LayerZeroChainIdSet(_chainId, _layerZeroChainId);
    }

    /// @notice Gets the Layer zero chain Id for a given chain Id.
    /// @param _chainId Chain Id.
    /// @return layerZeroChainId Layer zero chain Id.
    function getOFTLayerZeroChainId(
        uint256 _chainId
    ) private view returns (uint16 layerZeroChainId) {
        Storage storage sm = getStorage();
        layerZeroChainId = sm.layerZeroChainId[_chainId];

        if (layerZeroChainId == 0) {
            revert UnknownLayerZeroChain();
        }

        return layerZeroChainId;
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
