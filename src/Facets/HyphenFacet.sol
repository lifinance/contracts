// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHyphenRouter } from "../Interfaces/IHyphenRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { InvalidReceiver, InvalidAmount, CannotBridgeToSameNetwork } from "../Errors/GenericErrors.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Hyphen Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hyphen
contract HyphenFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Types ///

    /// @param token The contract address of the token being bridged.
    /// @param amount The amount of tokens to bridge.
    /// @param recipient The address of the token recipient after bridging.
    /// @param toChainId The chainId of the chain to bridge to.
    struct HyphenData {
        address router;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Hyphen
    /// @param _bridgeData the core information needed for bridging
    /// @param _hyphenData data specific to Hyphen
    function startBridgeTokensViaHyphen(ILiFi.BridgeData memory _bridgeData, HyphenData calldata _hyphenData)
        external
        payable
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _hyphenData);
    }

    /// @notice Performs a swap before bridging via Hyphen
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hyphenData data specific to Hyphen
    function swapAndStartBridgeTokensViaHyphen(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        HyphenData memory _hyphenData
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _hyphenData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Hyphen
    /// @param _bridgeData the core information needed for bridging
    /// @param _hyphenData data specific to Hyphen
    function _startBridge(ILiFi.BridgeData memory _bridgeData, HyphenData memory _hyphenData) private {
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Give the Hyphen router approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), _hyphenData.router, _bridgeData.minAmount);

            IHyphenRouter(_hyphenData.router).depositErc20(
                _bridgeData.destinationChainId,
                _bridgeData.sendingAssetId,
                _bridgeData.receiver,
                _bridgeData.minAmount,
                "LIFI"
            );
        } else {
            IHyphenRouter(_hyphenData.router).depositNative{ value: _bridgeData.minAmount }(
                _bridgeData.receiver,
                _bridgeData.destinationChainId,
                "LIFI"
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
