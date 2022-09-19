// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHyphenRouter } from "../Interfaces/IHyphenRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { InvalidReceiver, InvalidAmount } from "../Errors/GenericErrors.sol";

/// @title Hyphen Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hyphen
contract HyphenFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Storage ///

    /// @notice The contract address of the router on the source chain.
    IHyphenRouter private immutable router;

    /// Types ///

    /// @param assetId The contract address of the token being bridged.
    /// @param amount The amount of tokens to bridge.
    /// @param receiver The address of the token receiver after bridging.
    /// @param toChainId The chainId of the chain to bridge to.
    struct HyphenData {
        address assetId;
        uint256 amount;
        address receiver;
        uint256 toChainId;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _router The contract address of the router on the source chain.
    constructor(IHyphenRouter _router) {
        router = _router;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Hyphen
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _hyphenData data specific to Hyphen
    function startBridgeTokensViaHyphen(LiFiData calldata _lifiData, HyphenData calldata _hyphenData)
        external
        payable
        nonReentrant
    {
        if (LibUtil.isZeroAddress(_hyphenData.receiver)) {
            revert InvalidReceiver();
        }
        if (_hyphenData.amount == 0) {
            revert InvalidAmount();
        }

        LibAsset.depositAsset(_hyphenData.assetId, _hyphenData.amount);
        _startBridge(_lifiData, _hyphenData, false);
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
        if (LibUtil.isZeroAddress(_hyphenData.receiver)) {
            revert InvalidReceiver();
        }

        _hyphenData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _hyphenData, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Hyphen
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _hyphenData data specific to Hyphen
    /// @param _hasSourceSwaps whether or not the bridge has source swaps
    function _startBridge(
        LiFiData calldata _lifiData,
        HyphenData memory _hyphenData,
        bool _hasSourceSwaps
    ) private {
        if (!LibAsset.isNativeAsset(_hyphenData.assetId)) {
            // Give the Hyphen router approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(_hyphenData.assetId), address(router), _hyphenData.amount);

            router.depositErc20(
                _hyphenData.toChainId,
                _hyphenData.assetId,
                _hyphenData.receiver,
                _hyphenData.amount,
                "LIFI"
            );
        } else {
            router.depositNative{ value: _hyphenData.amount }(_hyphenData.receiver, _hyphenData.toChainId, "LIFI");
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "hyphen",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _hyphenData.assetId,
            _lifiData.receivingAssetId,
            _hyphenData.receiver,
            _hyphenData.amount,
            _hyphenData.toChainId,
            _hasSourceSwaps,
            false
        );
    }
}
