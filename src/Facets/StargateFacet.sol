// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IStargateRouter, IFactory, IPool } from "../Interfaces/IStargateRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InformationMismatch, InvalidConfig, InvalidCaller, TokenAddressIsZero } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibMappings } from "../Libraries/LibMappings.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Stargate Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Stargate
contract StargateFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.stargate");
    struct Storage {
        address stargateRouter;
    }

    /// Types ///

    struct StargateData {
        address router;
        uint256 dstPoolId;
        uint256 minAmountLD;
        uint256 dstGasForCall;
        bytes callTo;
        bytes callData;
    }

    /// Errors ///
    error UnknownStargatePool();
    error UnknownLayerZeroChain();
    error InvalidStargateRouter();

    /// Events ///

    event StargatePoolIdSet(address indexed token, uint256 poolId);
    event LayerZeroChainIdSet(uint256 indexed chainId, uint16 layerZeroChainId);
    event StargateInitialized(address stargateRouter);

    /// Init ///

    /// @notice Initializes local variables for the Stargate facet
    /// @param _stargateRouter address of the canonical Stargate router contract
    function initStargate(address _stargateRouter) external {
        LibDiamond.enforceIsContractOwner();
        if (_stargateRouter == address(0)) {
            revert InvalidConfig();
        }
        Storage storage s = getStorage();
        s.stargateRouter = _stargateRouter;
        emit StargateInitialized(_stargateRouter);
    }

    /// External Methods ///

    /// @notice Bridges tokens via Stargate Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _stargateData Data specific to Stargate Bridge
    function startBridgeTokensViaStargate(ILiFi.BridgeData memory _bridgeData, StargateData calldata _stargateData)
        external
        payable
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _stargateData, msg.value);
    }

    /// @notice Performs a swap before bridging via Stargate Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _stargateData Data specific to Stargate Bridge
    function swapAndStartBridgeTokensViaStargate(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        StargateData calldata _stargateData
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        uint256 nativeFee = msg.value;
        for (uint8 i = 0; i < _swapData.length; ) {
            if (LibAsset.isNativeAsset(_swapData[i].sendingAssetId)) {
                nativeFee -= _swapData[i].fromAmount;
            }
            unchecked {
                ++i;
            }
        }

        _startBridge(_bridgeData, _stargateData, nativeFee);
    }

    function quoteLayerZeroFee(uint256 _destinationChainId, StargateData calldata _stargateData)
        external
        view
        returns (uint256, uint256)
    {
        return
            IStargateRouter(_stargateData.router).quoteLayerZeroFee(
                getLayerZeroChainId(_destinationChainId),
                1, // TYPE_SWAP_REMOTE on Bridge
                _stargateData.callTo,
                _stargateData.callData,
                IStargateRouter.lzTxObj(_stargateData.dstGasForCall, 0, "")
            );
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Stargate Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _stargateData Data specific to Stargate Bridge
    /// @param _nativeFee Native gas fee for the cross chain message
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        StargateData calldata _stargateData,
        uint256 _nativeFee
    ) private noNativeAsset(_bridgeData) {
        (, LibSwap.SwapData[] memory destinationSwaps, , ) = abi.decode(
            _stargateData.callData,
            (ILiFi.BridgeData, LibSwap.SwapData[], address, address)
        );
        if ((destinationSwaps.length > 0) != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
        }

        LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), _stargateData.router, _bridgeData.minAmount);

        IStargateRouter(_stargateData.router).swap{ value: _nativeFee }(
            getLayerZeroChainId(_bridgeData.destinationChainId),
            getStargatePoolId(_bridgeData.sendingAssetId),
            _stargateData.dstPoolId,
            payable(msg.sender),
            _bridgeData.minAmount,
            _stargateData.minAmountLD,
            IStargateRouter.lzTxObj(_stargateData.dstGasForCall, 0, "0x"),
            _stargateData.callTo,
            _stargateData.callData
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }

    /// Mappings management ///

    /// @notice Sets the Stargate pool ID for a given token
    /// @param _token address of the token
    /// @param _poolId uint16 of the Stargate pool ID
    function setStargatePoolId(address _token, uint16 _poolId) external {
        LibDiamond.enforceIsContractOwner();
        LibMappings.StargateMappings storage sm = LibMappings.getStargateMappings();
        sm.stargatePoolId[_token] = _poolId;
        emit StargatePoolIdSet(_token, _poolId);
    }

    /// @notice Sets the Layer 0 chain ID for a given chain ID
    /// @param _chainId uint16 of the chain ID
    /// @param _layerZeroChainId uint16 of the Layer 0 chain ID
    /// @dev This is used to map a chain ID to its Layer 0 chain ID
    function setLayerZeroChainId(uint256 _chainId, uint16 _layerZeroChainId) external {
        LibDiamond.enforceIsContractOwner();
        LibMappings.StargateMappings storage sm = LibMappings.getStargateMappings();
        sm.layerZeroChainId[_chainId] = _layerZeroChainId;
        emit LayerZeroChainIdSet(_chainId, _layerZeroChainId);
    }

    /// @notice Gets the Stargate pool ID for a given token
    /// @param _token address of the token
    /// @return uint256 of the Stargate pool ID
    function getStargatePoolId(address _token) private view returns (uint16) {
        LibMappings.StargateMappings storage sm = LibMappings.getStargateMappings();
        uint16 poolId = sm.stargatePoolId[_token];
        if (poolId == 0) revert UnknownStargatePool();
        return poolId;
    }

    /// @notice Gets the Layer 0 chain ID for a given chain ID
    /// @param _chainId uint256 of the chain ID
    /// @return uint16 of the Layer 0 chain ID
    function getLayerZeroChainId(uint256 _chainId) private view returns (uint16) {
        LibMappings.StargateMappings storage sm = LibMappings.getStargateMappings();
        uint16 chainId = sm.layerZeroChainId[_chainId];
        if (chainId == 0) revert UnknownLayerZeroChain();
        return chainId;
    }
}
