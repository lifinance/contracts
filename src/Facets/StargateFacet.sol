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

    /// @notice The contract address of the stargate router on the source chain.
    IStargateRouter private immutable router;

    /// Types ///

    /// @param dstChainId Destination chainId.
    /// @param srcPoolId Source pool id.
    /// @param dstPoolId Dest pool id.
    /// @param amountLD Quantity to swap.
    /// @param minAmountLD The min qty you would accept on the destination.
    /// @param dstGasForCall Additional gas fee for extral call on the destination.
    /// @param callTo The address to send the tokens to on the destination.
    /// @param callData Additional payload.
    struct StargateData {
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

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _router The contract address of the stargate router on the source chain.
    constructor(IStargateRouter _router) {
        router = _router;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Stargate Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _stargateData Data specific to Stargate Bridge
    function startBridgeTokensViaStargate(LiFiData calldata _lifiData, StargateData calldata _stargateData)
        external
        payable
        nonReentrant
    {
        address token = getTokenFromPoolId(_stargateData.srcPoolId);

        if (token == address(0)) {
            revert TokenAddressIsZero();
        }

        LibAsset.depositAssetWithFee(token, _stargateData.amountLD, msg.value);

        _startBridge(_lifiData, _stargateData, msg.value, false);
    }

    /// @notice Performs a swap before bridging via Stargate Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _stargateData Data specific to Stargate Bridge
    function swapAndStartBridgeTokensViaStargate(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        StargateData memory _stargateData
    ) external payable nonReentrant {
        _stargateData.amountLD = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));

        uint256 nativeFee = msg.value;
        for (uint8 i = 0; i < _swapData.length; ) {
            if (LibAsset.isNativeAsset(_swapData[i].sendingAssetId)) {
                nativeFee -= _swapData[i].fromAmount;
            }
            unchecked {
                ++i;
            }
        }

        _startBridge(_lifiData, _stargateData, nativeFee, true);
    }

    function quoteLayerZeroFee(StargateData calldata _stargateData) external view returns (uint256, uint256) {
        return
            router.quoteLayerZeroFee(
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
    /// @param _poolId PoolId of token
    function getTokenFromPoolId(uint256 _poolId) private view returns (address) {
        address factory = router.factory();
        address pool = IFactory(factory).getPool(_poolId);
        return IPool(pool).token();
    }

    /// @dev Contains the business logic for the bridge via Stargate Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _stargateData Data specific to Stargate Bridge
    /// @param _nativeFee Native gas fee for the cross chain message
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        LiFiData memory _lifiData,
        StargateData memory _stargateData,
        uint256 _nativeFee,
        bool _hasSourceSwap
    ) private {
        address token = getTokenFromPoolId(_stargateData.srcPoolId);

        if (token == address(0)) {
            revert TokenAddressIsZero();
        }

        LibAsset.maxApproveERC20(IERC20(token), address(router), _stargateData.amountLD);

        router.swap{ value: _nativeFee }(
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

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "stargate",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _lifiData.sendingAssetId,
            _lifiData.receivingAssetId,
            _lifiData.receiver,
            _stargateData.amountLD,
            _lifiData.destinationChainId,
            _hasSourceSwap,
            _stargateData.callData.length > 0
        );
    }
}
