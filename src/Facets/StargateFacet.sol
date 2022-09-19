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
        for (uint8 i = 0; i < _swapData.length; i++) {
            if (LibAsset.isNativeAsset(_swapData[i].sendingAssetId)) {
                nativeFee -= _swapData[i].fromAmount;
            }
        }

        _startBridge(_lifiData, _stargateData, nativeFee, true);
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
        if (msg.sender != address(router)) {
            revert InvalidStargateRouter();
        }

        (LiFiData memory lifiData, LibSwap.SwapData[] memory swapData, address assetId, address receiver) = abi.decode(
            _payload,
            (LiFiData, LibSwap.SwapData[], address, address)
        );

        if (swapData.length == 0) {
            this.completeBridgeTokensViaStargate(lifiData, assetId, receiver, _amountLD);
        } else {
            this.swapAndCompleteBridgeTokensViaStargate(lifiData, swapData, assetId, receiver);
        }
    }

    /// @notice Completes a cross-chain transaction on the receiving chain using the Stargate Bridge.
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _assetId token received on the receiving chain
    /// @param _receiver address that will receive the tokens
    /// @param _amount number of tokens received
    function completeBridgeTokensViaStargate(
        LiFiData calldata _lifiData,
        address _assetId,
        address _receiver,
        uint256 _amount
    ) external {
        if (msg.sender != address(this)) {
            revert InvalidCaller();
        }

        LibAsset.transferAsset(_assetId, payable(_receiver), _amount);
        emit LiFiTransferCompleted(_lifiData.transactionId, _assetId, _receiver, _amount, block.timestamp);
    }

    /// @notice Performs a swap before completing a cross-chain transaction
    ///         on the receiving chain using the Stargate Bridge.
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData array of data needed for swaps
    /// @param _finalAssetId token received on the receiving chain
    /// @param _receiver address that will receive the tokens
    function swapAndCompleteBridgeTokensViaStargate(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address _finalAssetId,
        address _receiver
    ) external {
        if (msg.sender != address(this)) {
            revert InvalidCaller();
        }

        uint256 swapBalance = _executeAndCheckSwaps(_lifiData, _swapData, payable(_receiver));
        LibAsset.transferAsset(_finalAssetId, payable(_receiver), swapBalance);
        emit LiFiTransferCompleted(_lifiData.transactionId, _finalAssetId, _receiver, swapBalance, block.timestamp);
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
