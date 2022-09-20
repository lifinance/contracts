// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IOmniBridge } from "../Interfaces/IOmniBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title OmniBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through OmniBridge
contract OmniBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Storage ///

    /// @notice The chain id of Gnosis.
    uint64 private constant GNOSIS_CHAIN_ID = 100;

    /// @notice The contract address of the foreign omni bridge on the source chain.
    IOmniBridge private immutable foreignOmniBridge;

    /// @notice The contract address of the weth omni bridge on the source chain.
    IOmniBridge private immutable wethOmniBridge;

    /// Types ///

    /// @param assetId The contract address of the token being bridged.
    /// @param amount The amount of tokens to bridge.
    /// @param receiver The address of the token receiver after bridging.
    struct BridgeData {
        address assetId;
        uint256 amount;
        address receiver;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _foreignOmniBridge The contract address of the foreign omni bridge on the source chain.
    /// @param _wethOmniBridge The contract address of the weth omni bridge on the source chain.
    constructor(IOmniBridge _foreignOmniBridge, IOmniBridge _wethOmniBridge) {
        foreignOmniBridge = _foreignOmniBridge;
        wethOmniBridge = _wethOmniBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via OmniBridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data specific to bridge
    function startBridgeTokensViaOmniBridge(LiFiData calldata _lifiData, BridgeData calldata _bridgeData)
        external
        payable
        nonReentrant
    {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        LibAsset.depositAsset(_bridgeData.assetId, _bridgeData.amount);
        _startBridge(_lifiData, _bridgeData, _bridgeData.amount, false);
    }

    /// @notice Performs a swap before bridging via OmniBridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data specific to bridge
    function swapAndStartBridgeTokensViaOmniBridge(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        BridgeData calldata _bridgeData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        uint256 amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _bridgeData, amount, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via OmniBridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data specific to OmniBridge
    /// @param _amount Amount to bridge
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        LiFiData calldata _lifiData,
        BridgeData calldata _bridgeData,
        uint256 _amount,
        bool _hasSourceSwap
    ) private {
        if (LibAsset.isNativeAsset(_bridgeData.assetId)) {
            wethOmniBridge.wrapAndRelayTokens{ value: _amount }(_bridgeData.receiver);
        } else {
            LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), address(foreignOmniBridge), _amount);

            foreignOmniBridge.relayTokens(_bridgeData.assetId, _bridgeData.receiver, _amount);
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "omni",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _bridgeData.assetId,
            _lifiData.receivingAssetId,
            _bridgeData.receiver,
            _bridgeData.amount,
            GNOSIS_CHAIN_ID,
            _hasSourceSwap,
            false
        );
    }
}
