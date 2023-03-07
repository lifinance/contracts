// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISquidRouter } from "../Interfaces/ISquidRouter.sol";
import { ISquidMulticall } from "../Interfaces/ISquidMulticall.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";

/// @title Squid Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Squid Router
contract SquidFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    using LibBytes for bytes;

    // @param callData the data to be passed to Squid Router
    struct SquidData {
        bytes callData;
    }

    /// State ///
    ISquidRouter public immutable squidRouter;

    /// Constructor ///
    constructor(ISquidRouter _squidRouter) {
        squidRouter = _squidRouter;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Squid Router
    /// @param _bridgeData the core information needed for bridging
    /// @param _squidData data specific to Squid Router
    function startBridgeTokensViaSquid(
        ILiFi.BridgeData memory _bridgeData,
        SquidData memory _squidData
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

        _startBridge(_bridgeData, _squidData);
    }

    /// @notice Swaps and bridges tokens via Squid Router
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _squidData data specific to Squid Router
    function swapAndStartBridgeTokensViaSquid(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        SquidData memory _squidData
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
        _startBridge(_bridgeData, _squidData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Squid Router
    /// @param _bridgeData the core information needed for bridging
    /// @param _squidData data specific to Squid Router
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        SquidData memory _squidData
    ) internal {
        IERC20 sendingAssetId = IERC20(_bridgeData.sendingAssetId);
        uint256 msgValue = LibAsset.isNativeAsset(address(sendingAssetId))
            ? _bridgeData.minAmount
            : 0;

        if (msgValue == 0) {
            LibAsset.maxApproveERC20(
                sendingAssetId,
                address(squidRouter),
                _bridgeData.minAmount
            );
        }

        (bool success, bytes memory res) = address(squidRouter).call{
            value: msgValue
        }(_squidData.callData);

        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
