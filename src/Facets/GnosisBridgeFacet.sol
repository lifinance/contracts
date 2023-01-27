// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IXDaiBridge } from "../Interfaces/IXDaiBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidSendingToken, NoSwapDataProvided } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Gnosis Bridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through XDaiBridge
contract GnosisBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The DAI address on the source chain.
    address private constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;

    /// @notice The chain id of Gnosis.
    uint64 private constant GNOSIS_CHAIN_ID = 100;

    /// @notice The contract address of the xdai bridge on the source chain.
    IXDaiBridge private immutable xDaiBridge;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _xDaiBridge The contract address of the xdai bridge on the source chain.
    constructor(IXDaiBridge _xDaiBridge) {
        xDaiBridge = _xDaiBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via XDaiBridge
    /// @param _bridgeData the core information needed for bridging
    function startBridgeTokensViaXDaiBridge(
        ILiFi.BridgeData memory _bridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowDestinationChain(_bridgeData, GNOSIS_CHAIN_ID)
        onlyAllowSourceToken(_bridgeData, DAI)
    {
        LibAsset.depositAsset(DAI, _bridgeData.minAmount);
        _startBridge(_bridgeData);
    }

    /// @notice Performs a swap before bridging via XDaiBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapAndStartBridgeTokensViaXDaiBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData
    )
        external
        payable
        nonReentrant
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowDestinationChain(_bridgeData, GNOSIS_CHAIN_ID)
        onlyAllowSourceToken(_bridgeData, DAI)
    {
        if (_swapData.length == 0) revert NoSwapDataProvided();
        if (_swapData[_swapData.length - 1].receivingAssetId != DAI) {
            revert InvalidSendingToken();
        }
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via XDaiBridge
    /// @param _bridgeData the core information needed for bridging
    function _startBridge(ILiFi.BridgeData memory _bridgeData) private {
        LibAsset.maxApproveERC20(
            IERC20(DAI),
            address(xDaiBridge),
            _bridgeData.minAmount
        );
        xDaiBridge.relayTokens(_bridgeData.receiver, _bridgeData.minAmount);
        emit LiFiTransferStarted(_bridgeData);
    }
}
