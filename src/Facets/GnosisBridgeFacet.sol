// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IXDaiBridge } from "../Interfaces/IXDaiBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount } from "../Errors/GenericErrors.sol";
import { InvalidAmount, InvalidSendingToken, InvalidDestinationChain, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";

/// @title Gnosis Bridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through XDaiBridge
contract GnosisBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Storage ///

    address internal constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    uint64 internal constant GNOSIS_CHAIN_ID = 100;

    /// Types ///

    struct GnosisData {
        address xDaiBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via XDaiBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _gnosisData data specific to bridge
    function startBridgeTokensViaXDaiBridge(ILiFi.BridgeData memory _bridgeData, GnosisData calldata _gnosisData)
        external
        payable
        nonReentrant
    {
        if (_bridgeData.destinationChainId != GNOSIS_CHAIN_ID) {
            revert InvalidDestinationChain();
        }
        if (_bridgeData.sendingAssetId != DAI) {
            revert InvalidSendingToken();
        }
        if (_bridgeData.minAmount == 0) {
            revert InvalidAmount();
        }
        if (LibUtil.isZeroAddress(_bridgeData.receiver)) {
            revert InvalidReceiver();
        }

        LibAsset.depositAsset(DAI, _bridgeData.minAmount);
        _startBridge(_bridgeData, _gnosisData, false);
    }

    /// @notice Performs a swap before bridging via XDaiBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    /// @param _gnosisData data specific to bridge
    function swapAndStartBridgeTokensViaXDaiBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        GnosisData memory _gnosisData
    ) external payable nonReentrant {
        if (_bridgeData.destinationChainId != GNOSIS_CHAIN_ID) {
            revert InvalidDestinationChain();
        }
        if (_bridgeData.sendingAssetId != DAI || _swapData[_swapData.length - 1].receivingAssetId != DAI) {
            revert InvalidSendingToken();
        }
        if (LibUtil.isZeroAddress(_bridgeData.receiver)) {
            revert InvalidReceiver();
        }
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _gnosisData, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via XDaiBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _gnosisData data specific to bridge
    /// @param hasSourceSwaps whether or not the bridge has source swaps
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        GnosisData memory _gnosisData,
        bool hasSourceSwaps
    ) private {
        LibAsset.maxApproveERC20(IERC20(DAI), _gnosisData.xDaiBridge, _bridgeData.minAmount);
        IXDaiBridge(_gnosisData.xDaiBridge).relayTokens(_bridgeData.receiver, _bridgeData.minAmount);
        emit LiFiTransferStarted(_bridgeData);
    }
}
