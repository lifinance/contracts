// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IDlnSource } from "../Interfaces/IDlnSource.sol";
import { NotInitialized } from "../Errors/GenericErrors.sol";

/// @title DeBridgeDLN Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through DeBridge DLN
/// @custom:version 1.0.0
contract DeBridgeDlnFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.debridgedln");
    uint32 internal constant REFERRAL_CODE = 30729;
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;
    IDlnSource public immutable dlnSource;

    /// Types ///

    /// @param receivingAssetId The address of the asset to receive
    /// @param receiver The address of the receiver
    /// @param minAmountOut The minimum amount to receive on the destination chain
    struct DeBridgeDlnData {
        bytes receivingAssetId;
        bytes receiver;
        bytes orderAuthorityDst;
        uint256 minAmountOut;
    }

    struct Storage {
        mapping(uint256 => uint256) deBridgeChainId;
        bool initialized;
    }

    struct ChainIdConfig {
        uint256 chainId;
        uint256 deBridgeChainId;
    }

    /// Errors ///

    error UnknownDeBridgeChain();
    error EmptyNonEVMAddress();
    error InvalidConfig();

    /// Events ///

    event DeBridgeInitialized(ChainIdConfig[] chainIdConfigs);

    event DlnOrderCreated(bytes32 indexed orderId);

    event DeBridgeChainIdSet(uint256 indexed chainId, uint256 deBridgeChainId);

    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint256 indexed destinationChainId,
        bytes receiver
    );

    /// Modifiers ///

    modifier onlyValidReceiverAddress(DeBridgeDlnData calldata _deBridgeData) {
        // Ensure nonEVMAddress is not empty
        if (_deBridgeData.receiver.length == 0) {
            revert EmptyNonEVMAddress();
        }
        _;
    }

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _dlnSource The address of the DLN order creation contract
    constructor(IDlnSource _dlnSource) {
        dlnSource = _dlnSource;
    }

    /// Init ///

    /// @notice Initialize local variables for the DeBridgeDln Facet
    /// @param chainIdConfigs Chain Id configuration data
    function initDeBridgeDln(
        ChainIdConfig[] calldata chainIdConfigs
    ) external {
        if (chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();

        Storage storage sm = getStorage();

        for (uint256 i = 0; i < chainIdConfigs.length; i++) {
            sm.deBridgeChainId[chainIdConfigs[i].chainId] = chainIdConfigs[i]
                .deBridgeChainId;
        }

        sm.initialized = true;
        emit DeBridgeInitialized(chainIdConfigs);
    }

    /// External Methods ///

    /// @notice Bridges tokens via DeBridgeDLN
    /// @param _bridgeData The core information needed for bridging
    /// @param _deBridgeData Data specific to DeBridgeDLN
    function startBridgeTokensViaDeBridgeDln(
        ILiFi.BridgeData memory _bridgeData,
        DeBridgeDlnData calldata _deBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        onlyValidReceiverAddress(_deBridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(
            _bridgeData,
            _deBridgeData,
            dlnSource.globalFixedNativeFee()
        );
    }

    /// @notice Performs a swap before bridging via DeBridgeDLN
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _deBridgeData Data specific to DeBridgeDLN
    function swapAndStartBridgeTokensViaDeBridgeDln(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        DeBridgeDlnData calldata _deBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyValidReceiverAddress(_deBridgeData)
    {
        uint256 fee = dlnSource.globalFixedNativeFee();
        address assetId = _bridgeData.sendingAssetId;
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            LibAsset.isNativeAsset(assetId) ? 0 : fee
        );
        _startBridge(_bridgeData, _deBridgeData, fee);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via DeBridgeDLN
    /// @param _bridgeData The core information needed for bridging
    /// @param _deBridgeData Data specific to DeBridgeDLN
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        DeBridgeDlnData calldata _deBridgeData,
        uint256 _fee
    ) internal {
        IDlnSource.OrderCreation memory orderCreation = IDlnSource
            .OrderCreation({
                giveTokenAddress: _bridgeData.sendingAssetId,
                giveAmount: _bridgeData.minAmount,
                takeTokenAddress: _deBridgeData.receivingAssetId,
                takeAmount: _deBridgeData.minAmountOut,
                takeChainId: getDeBridgeChainId(
                    _bridgeData.destinationChainId
                ),
                receiverDst: _deBridgeData.receiver,
                givePatchAuthoritySrc: msg.sender,
                orderAuthorityAddressDst: _deBridgeData.orderAuthorityDst,
                allowedTakerDst: "",
                externalCall: "",
                allowedCancelBeneficiarySrc: abi.encodePacked(msg.sender)
            });

        bytes32 orderId;
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Give the DLN Source approval to bridge tokens
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(dlnSource),
                _bridgeData.minAmount
            );

            orderId = dlnSource.createOrder{ value: _fee }(
                orderCreation,
                "",
                REFERRAL_CODE,
                ""
            );
        } else {
            orderCreation.giveAmount = orderCreation.giveAmount - _fee;
            orderId = dlnSource.createOrder{ value: _bridgeData.minAmount }(
                orderCreation,
                "",
                REFERRAL_CODE,
                ""
            );
        }

        emit DlnOrderCreated(orderId);

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _deBridgeData.receiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// Mappings management ///

    /// @notice Sets the DeBridge chain ID for a given chain ID
    /// @param _chainId uint256 of the chain ID
    /// @param _deBridgeChainId uint256 of the DeBridge chain ID
    /// @dev This is used to map a chain ID to its DeBridge chain ID
    function setDeBridgeChainId(
        uint256 _chainId,
        uint256 _deBridgeChainId
    ) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage sm = getStorage();

        if (!sm.initialized) {
            revert NotInitialized();
        }

        sm.deBridgeChainId[_chainId] = _deBridgeChainId;
        emit DeBridgeChainIdSet(_chainId, _deBridgeChainId);
    }

    /// @notice Gets the DeBridge chain ID for a given chain ID
    /// @param _chainId uint256 of the chain ID
    /// @return uint256 of the DeBridge chain ID
    function getDeBridgeChainId(
        uint256 _chainId
    ) public view returns (uint256) {
        Storage storage sm = getStorage();
        uint256 chainId = sm.deBridgeChainId[_chainId];
        if (chainId == 0) revert UnknownDeBridgeChain();
        return chainId;
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
