// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IXDaiBridgeL2 } from "../Interfaces/IXDaiBridgeL2.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidSendingToken, NoSwapDataProvided } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Gnosis Bridge Facet on Gnosis Chain
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through XDaiBridge
/// @custom:version 1.0.0
contract GnosisBridgeL2Facet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable
{
    /// Storage ///

    /// @notice The xDAI address on the source chain.
    address private constant XDAI = address(0);

    /// @notice The chain id of Ethereum Mainnet.
    uint64 private constant ETHEREUM_CHAIN_ID = 1;

    /// @notice The contract address of the xdai bridge on the source chain.
    IXDaiBridgeL2 private immutable xDaiBridge;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _xDaiBridge The contract address of the xdai bridge on the source chain.
    constructor(IXDaiBridgeL2 _xDaiBridge) {
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
        onlyAllowDestinationChain(_bridgeData, ETHEREUM_CHAIN_ID)
        onlyAllowSourceToken(_bridgeData, XDAI)
    {
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
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowDestinationChain(_bridgeData, ETHEREUM_CHAIN_ID)
        onlyAllowSourceToken(_bridgeData, XDAI)
    {
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
        xDaiBridge.relayTokens{ value: _bridgeData.minAmount }(
            _bridgeData.receiver
        );
        emit LiFiTransferStarted(_bridgeData);
    }
}
