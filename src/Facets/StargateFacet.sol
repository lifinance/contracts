// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IStargateRouter, IFactory, IPool } from "../Interfaces/IStargateRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidConfig, InvalidCaller, TokenAddressIsZero } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Stargate Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Stargate
contract StargateFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.stargate");
    struct Storage {
        address stargateRouter;
    }

    /// Types ///

    struct StargateData {
        address router;
        uint16 dstChainId;
        uint256 srcPoolId;
        uint256 dstPoolId;
        uint256 amountLD;
        uint256 minAmountLD;
        uint256 dstGasForCall;
        bytes callTo;
        bytes callData;
    }

    /// Errors ///

    error InvalidStargateRouter();

    /// Events ///

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
        nonReentrant
    {
        address token = getTokenFromPoolId(_stargateData.router, _stargateData.srcPoolId);

        if (token == address(0)) {
            revert TokenAddressIsZero();
        }

        LibAsset.depositAsset(token, _stargateData.amountLD);

        _startBridge(_bridgeData, _stargateData, msg.value, false);
    }

    /// @notice Performs a swap before bridging via Stargate Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _stargateData Data specific to Stargate Bridge
    function swapAndStartBridgeTokensViaStargate(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        StargateData memory _stargateData
    ) external payable nonReentrant {
        LibAsset.depositAssets(_swapData);
        _stargateData.amountLD = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        LibSwap.SwapData[] memory swaps = _swapData;
        uint256 nativeFee = msg.value;
        for (uint8 i = 0; i < swaps.length; ) {
            if (LibAsset.isNativeAsset(swaps[i].sendingAssetId)) {
                nativeFee -= swaps[i].fromAmount;
            }
            unchecked {
                ++i;
            }
        }

        _startBridge(_bridgeData, _stargateData, nativeFee, true);
    }

    /// @notice Completes a cross-chain transaction on the receiving chain.
    /// @dev This function is called from Stargate Router.
    /// @param * (unused) The remote chainId sending the tokens
    /// @param * (unused) The remote Bridge address
    /// @param * (unused) Nonce
    /// @param * (unused) The token contract on the local chain
    /// @param _amountLD The amount of local _token contract tokens
    /// @param _payload The data to execute
    function sgReceive(
        uint16, // _srcChainId unused
        bytes memory, // _srcAddress unused
        uint256, // _nonce unused
        address, // _token unused
        uint256 _amountLD,
        bytes memory _payload
    ) external nonReentrant {
        Storage storage s = getStorage();
        if (msg.sender != s.stargateRouter) {
            revert InvalidStargateRouter();
        }

        (
            ILiFi.BridgeData memory bridgeData,
            LibSwap.SwapData[] memory swapData,
            address assetId,
            address receiver
        ) = abi.decode(_payload, (ILiFi.BridgeData, LibSwap.SwapData[], address, address));

        if (swapData.length == 0) {
            this.completeBridgeTokensViaStargate(bridgeData, assetId, receiver, _amountLD);
        } else {
            this.swapAndCompleteBridgeTokensViaStargate(bridgeData, swapData, assetId, receiver);
        }
    }

    /// @notice Completes a cross-chain transaction on the receiving chain using the Stargate Bridge.
    /// @param _bridgeData data used purely for tracking and analytics
    /// @param _assetId token received on the receiving chain
    /// @param _receiver address that will receive the tokens
    /// @param _amount number of tokens received
    function completeBridgeTokensViaStargate(
        ILiFi.BridgeData memory _bridgeData,
        address _assetId,
        address _receiver,
        uint256 _amount
    ) external {
        if (msg.sender != address(this)) {
            revert InvalidCaller();
        }

        LibAsset.transferAsset(_assetId, payable(_receiver), _amount);
        emit LiFiTransferCompleted(_bridgeData.transactionId, _assetId, _receiver, _amount, block.timestamp);
    }

    /// @notice Performs a swap before completing a cross-chain transaction
    ///         on the receiving chain using the Stargate Bridge.
    /// @param _bridgeData data used purely for tracking and analytics
    /// @param _swapData array of data needed for swaps
    /// @param _finalAssetId token received on the receiving chain
    /// @param _receiver address that will receive the tokens
    function swapAndCompleteBridgeTokensViaStargate(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        address _finalAssetId,
        address _receiver
    ) external {
        if (msg.sender != address(this)) {
            revert InvalidCaller();
        }

        uint256 swapBalance = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(_receiver)
        );
        LibAsset.transferAsset(_finalAssetId, payable(_receiver), swapBalance);
        emit LiFiTransferCompleted(_bridgeData.transactionId, _finalAssetId, _receiver, swapBalance, block.timestamp);
    }

    function quoteLayerZeroFee(StargateData calldata _stargateData) external view returns (uint256, uint256) {
        return
            IStargateRouter(_stargateData.router).quoteLayerZeroFee(
                _stargateData.dstChainId,
                1, // TYPE_SWAP_REMOTE on Bridge
                _stargateData.callTo,
                _stargateData.callData,
                IStargateRouter.lzTxObj(_stargateData.dstGasForCall, 0, "0x")
            );
    }

    /// Private Methods ///

    /// @notice Returns token address from poolId
    /// @dev Get token address which registered on router's factory
    /// @param _router Stargate Bridge router address
    /// @param _poolId PoolId of token
    function getTokenFromPoolId(address _router, uint256 _poolId) private view returns (address) {
        address factory = IStargateRouter(_router).factory();
        address pool = IFactory(factory).getPool(_poolId);
        return IPool(pool).token();
    }

    /// @dev Contains the business logic for the bridge via Stargate Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _stargateData Data specific to Stargate Bridge
    /// @param _nativeFee Native gas fee for the cross chain message
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        StargateData memory _stargateData,
        uint256 _nativeFee,
        bool _hasSourceSwap
    ) private {
        address token = getTokenFromPoolId(_stargateData.router, _stargateData.srcPoolId);

        if (token == address(0)) {
            revert TokenAddressIsZero();
        }

        LibAsset.maxApproveERC20(IERC20(token), _stargateData.router, _stargateData.amountLD);

        IStargateRouter(_stargateData.router).swap{ value: _nativeFee }(
            _stargateData.dstChainId,
            _stargateData.srcPoolId,
            _stargateData.dstPoolId,
            payable(msg.sender),
            _stargateData.amountLD,
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
}
