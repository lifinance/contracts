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
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Gnosis Bridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through XDaiBridge
contract GnosisBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
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
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowDestinationChain(_bridgeData, GNOSIS_CHAIN_ID)
        onlyAllowSourceToken(_bridgeData, DAI)
        nonReentrant
    {
        LibAsset.depositAsset(DAI, _bridgeData.minAmount);
        _startBridge(_bridgeData, _gnosisData);
    }

    /// @notice Performs a swap before bridging via XDaiBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    /// @param _gnosisData data specific to bridge
    function swapAndStartBridgeTokensViaXDaiBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        GnosisData memory _gnosisData
    )
        external
        payable
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowDestinationChain(_bridgeData, GNOSIS_CHAIN_ID)
        onlyAllowSourceToken(_bridgeData, DAI)
        nonReentrant
    {
        if (_swapData[_swapData.length - 1].receivingAssetId != DAI) {
            revert InvalidSendingToken();
        }
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _gnosisData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via XDaiBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _gnosisData data specific to bridge
    function _startBridge(ILiFi.BridgeData memory _bridgeData, GnosisData memory _gnosisData) private {
        LibAsset.maxApproveERC20(IERC20(DAI), _gnosisData.xDaiBridge, _bridgeData.minAmount);
        IXDaiBridge(_gnosisData.xDaiBridge).relayTokens(_bridgeData.receiver, _bridgeData.minAmount);
        emit LiFiTransferStarted(_bridgeData);
    }
}
