// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IOFTWrapper, IOFT, IOFTV2, IOFTV2WithFee, IProxyOFT } from "../Interfaces/IOFTWrapper.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibAccess } from "lifi/Libraries/LibAccess.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { AlreadyInitialized, NotInitialized, ExternalCallFailed, InvalidCallData, ContractCallNotAllowed } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title OFTWrapper Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging various types of Omnichain Fungible Tokens (OFTs)
/// @custom:version 1.1.0
contract OFTWrapperFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.oftwrapper");

    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    bytes4 public constant INTERFACE_ID_IOFTV2 = 0x1f7ecdf7;
    bytes4 public constant INTERFACE_ID_IOFTCore = 0x14e4ceea; // => OFTV1
    bytes4 public constant INTERFACE_ID_IOFTWithFee = 0x6984a9e8;

    /// Types ///

    struct ChainIdConfig {
        uint256 chainId;
        uint16 layerZeroChainId;
    }

    struct WhitelistConfig {
        address contractAddress;
        bool whitelisted;
    }

    struct OftFeeEstimate {
        uint256 nativeFee;
        uint256 zroFee;
    }

    struct Storage {
        mapping(uint256 => uint16) layerZeroChainId;
        mapping(address => bool) whitelistedOFTs;
    }

    struct OFTWrapperData {
        address proxyOftAddress; // contains address of proxy OFT contract or address(0), if token does not have proxy
        bytes32 receiver; // exclusively used for non-EVM receiver addresses (usually we use _bridgeData.receiver)
        uint256 minAmount; // minAmount to be received on dst chain
        uint256 lzFee; // amount of native fee to be sent to Layer Zero endpoint for relaying message
        address zroPaymentAddress; // should be set to address(0) if not paying with ZRO token
        bytes adapterParams; // parameters for the adapter service, e.g. send some dust native token to dstChain
        IOFTWrapper.FeeObj feeObj; // contains information about optional callerFee (= fee taken by dApp)
        bytes customCode_sendTokensCallData; // contains function identifier and parameters for sending tokens
        address customCode_approveTo; // in case approval to a custom contract is required
    }

    /// Errors ///

    error UnknownLayerZeroChain();
    error InvalidProxyOFTAddress();
    error ContractWithNonStandardFeeEstimateFunction(string originalError);

    /// Events ///

    event OFTWrapperInitialized(ChainIdConfig[] chainIdConfigs);
    event WhitelistUpdated(WhitelistConfig[] whitelistConfigs);

    event LayerZeroChainIdSet(
        uint256 indexed chainId,
        uint16 layerZeroChainId
    );

    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint16 indexed layerZeroChainId,
        bytes32 receiver
    );

    /// Init ///

    /// @notice Initialize local variables for the OFTWrapper Facet.
    /// @param chainIdConfigs Chain Id configuration data.
    /// @param whitelistConfigs contracts to be whitelisted
    function initOFTWrapper(
        ChainIdConfig[] calldata chainIdConfigs,
        WhitelistConfig[] calldata whitelistConfigs
    ) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage sm = getStorage();

        // add layerZero custom chainIds
        for (uint256 i = 0; i < chainIdConfigs.length; i++) {
            sm.layerZeroChainId[chainIdConfigs[i].chainId] = chainIdConfigs[i]
                .layerZeroChainId;
        }

        // whitelist contracts
        batchWhitelist(whitelistConfigs);

        emit OFTWrapperInitialized(chainIdConfigs);
    }

    /// OFT V1 ---------------------------------------------------------------------------------------------------------

    /// @notice Bridges OFT V1 tokens via OFT Wrapper
    /// @param _bridgeData The core information needed for bridging
    /// @param _oftWrapperData Specific information required for bridging OFTs
    function startBridgeTokensViaOFTWrapperV1(
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

        _startBridgeOFTV1(_bridgeData, _oftWrapperData);
    }

    /// @notice Executes one or several swaps at src chain and bridges the resulting OFT V1 tokens via OFT Wrapper
    /// @param _bridgeData The core information needed for bridging
    /// @param _oftWrapperData Specific information required for bridging OFTs
    function swapAndStartBridgeTokensViaOFTWrapperV1(
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

        _startBridgeOFTV1(_bridgeData, _oftWrapperData);
    }

    /// @dev Contains the business logic for the bridge via OFT Wrapper.
    /// @param _bridgeData The core information needed for bridging.
    /// @param _oftWrapperData Specific information required for bridging OFTs.
    function _startBridgeOFTV1(
        ILiFi.BridgeData memory _bridgeData,
        OFTWrapperData calldata _oftWrapperData
    ) internal {
        address oftContract = _bridgeData.sendingAssetId;
        // check if OFT requires proxy contract for bridging
        if (_oftWrapperData.proxyOftAddress != address(0)) {
            // check proxy address
            _checkProxyOFTAddress(
                _bridgeData.sendingAssetId,
                _oftWrapperData.proxyOftAddress
            );

            // use proxy address for bridging
            oftContract = _oftWrapperData.proxyOftAddress;
        }

        // set approval for oft contract
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            oftContract,
            _bridgeData.minAmount
        );
        // TODO: should we set allowance back to 0 after this?

        // make sure oft contract is whitelisted
        if (!_isWhitelisted(oftContract)) revert ContractCallNotAllowed();

        // start bridging
        IOFT(oftContract).sendFrom{ value: _oftWrapperData.lzFee }(
            address(this),
            getOFTLayerZeroChainId(_bridgeData.destinationChainId),
            abi.encodePacked(_bridgeData.receiver),
            _bridgeData.minAmount,
            payable(msg.sender),
            _oftWrapperData.zroPaymentAddress,
            _oftWrapperData.adapterParams
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// OFT V2 ---------------------------------------------------------------------------------------------------------

    /// @notice Bridges OFT V2 tokens via OFT Wrapper
    /// @param _bridgeData The core information needed for bridging
    /// @param _oftWrapperData Specific information required for bridging OFTs
    function startBridgeTokensViaOFTWrapperV2(
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

        _startBridgeOFTV2(_bridgeData, _oftWrapperData);
    }

    /// @notice Executes one or several swaps at src chain and bridges the resulting OFT V2 tokens via OFT Wrapper
    /// @param _bridgeData The core information needed for bridging
    /// @param _oftWrapperData Specific information required for bridging OFTs
    function swapAndStartBridgeTokensViaOFTWrapperV2(
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

        _startBridgeOFTV2(_bridgeData, _oftWrapperData);
    }

    /// @dev Contains the business logic for the bridge via OFT Wrapper.
    /// @param _bridgeData The core information needed for bridging.
    /// @param _oftWrapperData Specific information required for bridging OFTs.
    function _startBridgeOFTV2(
        ILiFi.BridgeData memory _bridgeData,
        OFTWrapperData calldata _oftWrapperData
    ) internal {
        // prepare required information for bridging OFT V2
        (
            uint16 layerZeroChainId,
            bytes32 receiver,
            IOFTV2.LzCallParams memory lzCallParams
        ) = _prepareV2(_bridgeData, _oftWrapperData);

        // check if OFT requires proxy contract for bridging
        address oftContract = _bridgeData.sendingAssetId;
        if (_oftWrapperData.proxyOftAddress != address(0)) {
            // check proxy address
            _checkProxyOFTAddress(
                _bridgeData.sendingAssetId,
                _oftWrapperData.proxyOftAddress
            );

            // use proxy address for bridging
            oftContract = _oftWrapperData.proxyOftAddress;
        }

        // set approval for oft contract
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            oftContract,
            _bridgeData.minAmount
        );
        // TODO: should we set allowance back to 0 after this?

        // make sure oft contract is whitelisted
        if (!_isWhitelisted(oftContract)) revert ContractCallNotAllowed();

        // start bridging
        IOFTV2(oftContract).sendFrom{ value: _oftWrapperData.lzFee }(
            address(this),
            layerZeroChainId,
            receiver,
            _bridgeData.minAmount,
            lzCallParams
        );

        // emits LifiTransferStarted event and BridgeToNonEVMChain event, if applicable
        _emitEvents(_bridgeData, layerZeroChainId, _oftWrapperData.receiver);
    }

    /// OFT V2 With Fee-------------------------------------------------------------------------------------------------

    /// @notice Bridges OFT V2WithFee tokens via OFT Wrapper
    /// @param _bridgeData The core information needed for bridging
    /// @param _oftWrapperData Specific information required for bridging OFTs
    function startBridgeTokensViaOFTWrapperV2WithFee(
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

        _startBridgeOFTV2WithFee(_bridgeData, _oftWrapperData);
    }

    /// @notice Executes one or several swaps at src chain and bridges the resulting OFTV2WithFee tokens via OFT Wrapper
    /// @param _bridgeData The core information needed for bridging
    /// @param _oftWrapperData Specific information required for bridging OFTs
    function swapAndStartBridgeTokensViaOFTWrapperV2WithFee(
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

        _startBridgeOFTV2WithFee(_bridgeData, _oftWrapperData);
    }

    /// @dev Contains the business logic for the bridge via OFT Wrapper.
    /// @param _bridgeData The core information needed for bridging.
    /// @param _oftWrapperData Specific information required for bridging OFTs.
    function _startBridgeOFTV2WithFee(
        ILiFi.BridgeData memory _bridgeData,
        OFTWrapperData calldata _oftWrapperData
    ) internal {
        // prepare required information for bridging OFT V2
        (
            uint16 layerZeroChainId,
            bytes32 receiver,
            IOFTV2.LzCallParams memory lzCallParams
        ) = _prepareV2(_bridgeData, _oftWrapperData);

        // check if OFT requires proxy contract for bridging
        address oftContract = _bridgeData.sendingAssetId;
        if (_oftWrapperData.proxyOftAddress != address(0)) {
            // check proxy address
            _checkProxyOFTAddress(
                _bridgeData.sendingAssetId,
                _oftWrapperData.proxyOftAddress
            );

            // use proxy address for bridging
            oftContract = _oftWrapperData.proxyOftAddress;
        }

        // set approval for oft contract
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            oftContract,
            _bridgeData.minAmount
        );
        // TODO: should we set allowance back to 0 after this?

        // make sure oft contract is whitelisted
        if (!_isWhitelisted(oftContract)) revert ContractCallNotAllowed();

        // start bridging
        IOFTV2WithFee(oftContract).sendFrom{ value: _oftWrapperData.lzFee }(
            address(this),
            layerZeroChainId,
            receiver,
            _bridgeData.minAmount,
            _oftWrapperData.minAmount,
            lzCallParams
        );

        // emits LifiTransferStarted event and BridgeToNonEVMChain event, if applicable
        _emitEvents(_bridgeData, layerZeroChainId, _oftWrapperData.receiver);
    }

    /// Custom Code OFT-------------------------------------------------------------------------------------------------

    /// @notice Bridges custom code OFTs via their own contract
    /// @param _bridgeData The core information needed for bridging
    /// @param _oftWrapperData Specific information required for bridging OFTs
    function startBridgeTokensViaCustomCodeOFT(
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

        _startBridgeCustomCodeOFT(_bridgeData, _oftWrapperData);
    }

    /// @notice Executes one or several swaps at src chain and bridges the resulting custom code OFT tokens
    /// @param _bridgeData The core information needed for bridging
    /// @param _oftWrapperData Specific information required for bridging OFTs
    function swapAndStartBridgeTokensViaCustomCodeOFT(
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

        _startBridgeCustomCodeOFT(_bridgeData, _oftWrapperData);
    }

    /// @dev Contains the business logic for bridging via custom code OFTs
    /// @param _bridgeData The core information needed for bridging.
    /// @param _oftWrapperData Specific information required for bridging OFTs.
    function _startBridgeCustomCodeOFT(
        ILiFi.BridgeData memory _bridgeData,
        OFTWrapperData calldata _oftWrapperData
    ) internal {
        // set approval for custom OFT bridge contract
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            _oftWrapperData.customCode_approveTo,
            _bridgeData.minAmount
        );

        // this OFT type does not use the OFTWrapper contract, instead we call the token contract/or its
        // proxy directly. Since the send function/signature in these contracts differ, we prepare the calldata
        // in the backend and execute the calldata here via a low-level call. The (token/proxy) contract to be called
        // must be whitelisted prior to executing this function for security for security reasons

        // make sure calldata isnt empty
        if (_oftWrapperData.customCode_sendTokensCallData.length == 0)
            revert InvalidCallData();

        // check if proxy contract is whitelisted
        if (!_isWhitelisted(_oftWrapperData.proxyOftAddress))
            revert ContractCallNotAllowed();

        // call proxy token contract with prepared calldata
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = _oftWrapperData.proxyOftAddress.call{
            value: _oftWrapperData.lzFee
        }(_oftWrapperData.customCode_sendTokensCallData);
        if (!success) {
            revert ExternalCallFailed();
        }

        // emits LifiTransferStarted event and BridgeToNonEVMChain event, if applicable
        uint16 layerZeroChainId = getOFTLayerZeroChainId(
            _bridgeData.destinationChainId
        );
        _emitEvents(_bridgeData, layerZeroChainId, _oftWrapperData.receiver);
    }

    /// HELPER FUNCTIONS------------------------------------------------------------------------------------------------

    /// @notice Returns the function selector that should be used for bridging the given OFT if it can be determined
    /// @param _sendingAssetId The address of briding asset.
    /// @param _withSrcSwap set to true if you want to swapAndBridge, otherwise set to false
    function determineOFTBridgeSendFunction(
        address _sendingAssetId,
        bool _withSrcSwap
    ) public view returns (bytes4 bridgeFunctionSelector) {
        if (isOftV1(_sendingAssetId)) {
            if (_withSrcSwap)
                return
                    OFTWrapperFacet
                        .swapAndStartBridgeTokensViaOFTWrapperV1
                        .selector;
            else
                return
                    OFTWrapperFacet.startBridgeTokensViaOFTWrapperV1.selector;
        }
        if (isOftV2(_sendingAssetId)) {
            if (_withSrcSwap)
                return
                    OFTWrapperFacet
                        .swapAndStartBridgeTokensViaOFTWrapperV2
                        .selector;
            else
                return
                    OFTWrapperFacet.startBridgeTokensViaOFTWrapperV2.selector;
        }
        if (isOftV2WithFee(_sendingAssetId)) {
            if (_withSrcSwap)
                return
                    OFTWrapperFacet
                        .swapAndStartBridgeTokensViaOFTWrapperV2WithFee
                        .selector;
            else
                return
                    OFTWrapperFacet
                        .startBridgeTokensViaOFTWrapperV2WithFee
                        .selector;
        }

        // if non of the above checks was successful, we will return the function selector for customCodeOFTs
        // however, this does not mean that the token is bridgeable via this facet as there are too many different
        // implementations out there to cover for all possibilities
        if (_withSrcSwap)
            return
                OFTWrapperFacet
                    .swapAndStartBridgeTokensViaCustomCodeOFT
                    .selector;
        else return OFTWrapperFacet.startBridgeTokensViaCustomCodeOFT.selector;
    }

    function isOftV1(address _sendingAssetId) public view returns (bool) {
        try
            IERC165(_sendingAssetId).supportsInterface(INTERFACE_ID_IOFTCore)
        returns (bool result) {
            return result;
        } catch {
            return false;
        }
    }

    function isOftV2(address _sendingAssetId) public view returns (bool) {
        try
            IERC165(_sendingAssetId).supportsInterface(INTERFACE_ID_IOFTV2)
        returns (bool result) {
            return result;
        } catch {
            return false;
        }
    }

    function isOftV2WithFee(
        address _sendingAssetId
    ) public view returns (bool) {
        try
            IERC165(_sendingAssetId).supportsInterface(
                INTERFACE_ID_IOFTWithFee
            )
        returns (bool result) {
            return result;
        } catch {
            return false;
        }
    }

    /// @notice Get fee estimation.
    /// @param _sendingAssetId The address of the asset to be sent
    /// @param _destinationChainId The id of destination chain.
    /// @param _amount The amount of sending asset.
    /// @param _receiver Receiver address evm chain.
    /// @param _useZro Whether fee should be paid in ZRO token or not.
    /// @param _adapterParams Parameters for custom functionality.
    /// @param _customCodeCallData The calldata to obtain a fee estimate for a customCodeOFT, otherwise empty
    function estimateOFTFees(
        address _sendingAssetId,
        uint256 _destinationChainId,
        uint256 _amount,
        bytes32 _receiver,
        bool _useZro,
        bytes calldata _adapterParams,
        bytes calldata _customCodeCallData
    ) external view returns (OftFeeEstimate memory feeEstimate) {
        // check if called for customCodeOFT
        if (
            determineOFTBridgeSendFunction(_sendingAssetId, false) !=
            OFTWrapperFacet.startBridgeTokensViaCustomCodeOFT.selector
        ) {
            uint16 layerZeroChainId = getOFTLayerZeroChainId(
                _destinationChainId
            );

            // Obtain estimates for native/zroFee via token contract
            try
                // Try IOFTV2 function
                IOFTV2(_sendingAssetId).estimateSendFee(
                    layerZeroChainId,
                    _receiver,
                    _amount,
                    _useZro,
                    _adapterParams
                )
            returns (uint256 _nativeFee, uint256 _zroFee) {
                feeEstimate.nativeFee = _nativeFee;
                feeEstimate.zroFee = _zroFee;
            } catch {
                try
                    // Try OFTV1 function
                    IOFT(_sendingAssetId).estimateSendFee(
                        layerZeroChainId,
                        abi.encodePacked(bytes20(_receiver << 96)),
                        _amount,
                        _useZro,
                        _adapterParams
                    )
                returns (uint256 _nativeFee, uint256 _zroFee) {
                    feeEstimate.nativeFee = _nativeFee;
                    feeEstimate.zroFee = _zroFee;
                } catch Error(string memory reason) {
                    revert ContractWithNonStandardFeeEstimateFunction(reason);
                } catch (bytes memory) {
                    revert ContractWithNonStandardFeeEstimateFunction(
                        "failed without error message"
                    );
                }
            }
        } else {
            // make sure customCodeCallData is available
            if (_customCodeCallData.length == 0) revert InvalidCallData();

            // obtain fee estimate directly from customCodeOFT contract
            // using assembly here since low-level calls in view functions are not permitted
            (bool success, bytes memory result) = _sendingAssetId.staticcall(
                _customCodeCallData
            );

            // check result of call and, if call successful, make sure result has data
            if (!success || result.length == 0) {
                revert ExternalCallFailed();
            } else {
                // decode result data
                (feeEstimate.nativeFee, feeEstimate.zroFee) = abi.decode(
                    result,
                    (uint256, uint256)
                );
            }
        }
    }

    /// Internal Helper Functions ///

    function _isWhitelisted(
        address contractAddress
    ) internal view returns (bool) {
        // get storage object
        Storage storage sm = getStorage();

        // check if contract address is whitelisted
        if (sm.whitelistedOFTs[contractAddress]) return true;

        return false;
    }

    function _emitEvents(
        ILiFi.BridgeData memory _bridgeData,
        uint16 layerZeroChainId,
        bytes32 nonEvmReceiver
    ) internal {
        if (_bridgeData.receiver == NON_EVM_ADDRESS)
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                layerZeroChainId,
                nonEvmReceiver
            );

        emit LiFiTransferStarted(_bridgeData);
    }

    function _prepareV2(
        ILiFi.BridgeData memory _bridgeData,
        OFTWrapperData calldata _oftWrapperData
    )
        internal
        view
        returns (
            uint16 layerZeroChainId,
            bytes32 receiver,
            IOFTV2.LzCallParams memory LzCallParams
        )
    {
        layerZeroChainId = getOFTLayerZeroChainId(
            _bridgeData.destinationChainId
        );

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            receiver = _oftWrapperData.receiver;
        } else {
            receiver = bytes32(uint256(uint160(_bridgeData.receiver)));
        }

        LzCallParams = IOFTV2.LzCallParams(
            payable(msg.sender),
            address(0),
            _oftWrapperData.adapterParams
        );
    }

    function _checkProxyOFTAddress(
        address sendingAssetId,
        address proxyOFT
    ) internal view {
        if (IProxyOFT(proxyOFT).token() != sendingAssetId) {
            revert InvalidProxyOFTAddress();
        }
    }

    /// Mappings and Whitelist Management ///

    /// @notice Register the address of a DEX contract to be approved for swapping.
    /// @param configs configuration data about contracts to be whitelisted (or removed from whitelist)
    function batchWhitelist(WhitelistConfig[] calldata configs) public {
        // ensure that this function can only be executed by authorized addresses
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        // get storage object
        Storage storage sm = getStorage();

        // go through arrays and update whitelist
        for (uint i; i < configs.length; ) {
            sm.whitelistedOFTs[configs[i].contractAddress] = configs[i]
                .whitelisted;
            unchecked {
                ++i;
            }
        }

        // emit event with parameters
        emit WhitelistUpdated(configs);
    }

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

        sm.layerZeroChainId[_chainId] = _layerZeroChainId;

        emit LayerZeroChainIdSet(_chainId, _layerZeroChainId);
    }

    /// @notice Gets the Layer zero chain Id for a given chain Id.
    /// @param _chainId Chain Id.
    /// @return layerZeroChainId Layer zero chain Id.
    function getOFTLayerZeroChainId(
        uint256 _chainId
    ) public view returns (uint16 layerZeroChainId) {
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
