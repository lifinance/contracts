// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IThorSwap } from "../Interfaces/IThorSwap.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";

/// @title Allbridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through ThorSwap
contract ThorSwapFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// @notice The contract address of the ThorSwap router on the source chain.
    IThorSwap[] public allowedTSRouters;
    address public tsTokenProxy;

    /// Types ///
    enum RouterType {
        Uniswap,
        Generic,
        Thorchain
    }

    /// @notice The struct for the ThorSwap data.
    struct ThorSwapData {
        RouterType routerType;
        address tsRouter;
        address tcRouter;
        address tcVault;
        string tcMemo;
        address token;
        uint256 amount;
        uint256 amountOutMin;
        address router;
        bytes data;
        uint256 deadline;
    }

    /// @notice Initializes the ThorSwap contract
    constructor(IThorSwap[] memory _allowedTSRouters, address _tsTokenProxy) {
        allowedTSRouters = _allowedTSRouters;
        tsTokenProxy = _tsTokenProxy;
    }

    /// @notice Bridge tokens to another chain via ThorSwap
    /// @param _bridgeData The bridge data struct
    function startBridgeTokensViaThorSwap(
        ILiFi.BridgeData memory _bridgeData,
        ThorSwapData calldata _thorSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _thorSwapData);
    }

    /// @notice Bridge tokens to another chain via ThorSwap
    /// @param _bridgeData The bridge data struct
    /// @param _swapData The swap data struct
    /// @param _thorSwapData The ThorSwap data struct
    function swapAndStartBridgeTokensViaThorSwap(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        ThorSwapData calldata _thorSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _thorSwapData);
    }

    /// @notice Bridge tokens to another chain via ThorSwap
    /// @param _bridgeData The bridge data struct
    /// @param _thorSwapData The thorSwap data struct for ThorSwap specicific data
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        ThorSwapData calldata _thorSwapData
    ) internal {
        IERC20 sendingAssetId = IERC20(_bridgeData.sendingAssetId);

        // Send straight to ThorChain
        if (_thorSwapData.routerType == RouterType.Thorchain) {
            IThorSwap(_thorSwapData.tsRouter).depositWithExpiry{
                value: msg.value
            }(
                _thorSwapData.tcVault,
                _thorSwapData.token,
                _thorSwapData.amount,
                _thorSwapData.tcMemo,
                _thorSwapData.deadline
            );
        }

        // Uniswap Style Aggregator
        if (_thorSwapData.routerType == RouterType.Uniswap) {
            LibAsset.maxApproveERC20(
                sendingAssetId,
                tsTokenProxy,
                _bridgeData.minAmount
            );

            IThorSwap(_thorSwapData.tsRouter).swapIn(
                _thorSwapData.tcRouter,
                _thorSwapData.tcVault,
                _thorSwapData.tcMemo,
                _thorSwapData.token,
                _thorSwapData.amount,
                _thorSwapData.amountOutMin,
                _thorSwapData.deadline
            );
        }

        // Generic Aggregator
        if (_thorSwapData.routerType == RouterType.Generic) {
            LibAsset.maxApproveERC20(
                sendingAssetId,
                tsTokenProxy,
                _bridgeData.minAmount
            );

            IThorSwap(_thorSwapData.tsRouter).swapIn(
                _thorSwapData.tcRouter,
                _thorSwapData.tcVault,
                _thorSwapData.tcMemo,
                _thorSwapData.token,
                _thorSwapData.amount,
                _thorSwapData.router,
                _thorSwapData.data,
                _thorSwapData.deadline
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
