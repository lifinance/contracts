// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHyphenRouter } from "../Interfaces/IHyphenRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Hyphen Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hyphen
contract HyphenFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Types ///

    /// @param token The contract address of the token being bridged.
    /// @param amount The amount of tokens to bridge.
    /// @param recipient The address of the token recipient after bridging.
    /// @param toChainId The chainId of the chain to bridge to.
    struct HyphenData {
        address token;
        uint256 amount;
        address recipient;
        uint256 toChainId;
        address router;
    }

    /// @notice Bridges tokens via Hyphen
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _hyphenData data specific to Hyphen
    function startBridgeTokensViaHyphen(LiFiData calldata _lifiData, HyphenData calldata _hyphenData)
        external
        payable
        nonReentrant
    {
        LibAsset.depositAsset(_hyphenData.token, _hyphenData.amount);
        _startBridge(_hyphenData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "hyphen",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _hyphenData.token,
            _lifiData.receivingAssetId,
            _hyphenData.recipient,
            _hyphenData.amount,
            _hyphenData.toChainId,
            false,
            false
        );
    }

    /// @notice Performs a swap before bridging via Hyphen
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hyphenData data specific to Hyphen
    function swapAndStartBridgeTokensViaHyphen(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        HyphenData memory _hyphenData
    ) external payable nonReentrant {
        _hyphenData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_hyphenData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "hyphen",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            _lifiData.receivingAssetId,
            _hyphenData.recipient,
            _swapData[0].fromAmount,
            _hyphenData.toChainId,
            true,
            false
        );
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Hyphen
    /// @param _hyphenData data specific to Hyphen
    function _startBridge(HyphenData memory _hyphenData) private {
        if (!LibAsset.isNativeAsset(_hyphenData.token)) {
            // Give the Hyphen router approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(_hyphenData.token), _hyphenData.router, _hyphenData.amount);

            IHyphenRouter(_hyphenData.router).depositErc20(
                _hyphenData.toChainId,
                _hyphenData.token,
                _hyphenData.recipient,
                _hyphenData.amount,
                "LIFI"
            );
        } else {
            IHyphenRouter(_hyphenData.router).depositNative{ value: _hyphenData.amount }(
                _hyphenData.recipient,
                _hyphenData.toChainId,
                "LIFI"
            );
        }
    }
}
