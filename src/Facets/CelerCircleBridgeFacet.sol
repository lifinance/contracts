// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICircleBridgeProxy } from "../Interfaces/ICircleBridgeProxy.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";

/// @title CelerCircleBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CelerCircleBridge
/// @custom:version 1.0.2
contract CelerCircleBridgeFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable
{
    /// Storage ///

    /// @notice The address of the CircleBridgeProxy on the current chain.
    ICircleBridgeProxy private immutable CIRCLE_BRIDGE_PROXY;

    /// @notice The USDC address on the current chain.
    address private immutable USDC;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _circleBridgeProxy The address of the CircleBridgeProxy on the current chain.
    /// @param _usdc The address of USDC on the current chain.
    constructor(ICircleBridgeProxy _circleBridgeProxy, address _usdc) {
        CIRCLE_BRIDGE_PROXY = _circleBridgeProxy;
        USDC = _usdc;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CelerCircleBridge
    /// @param _bridgeData Data containing core information for bridging
    function startBridgeTokensViaCelerCircleBridge(
        BridgeData calldata _bridgeData
    )
        external
        nonReentrant
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, USDC)
    {
        LibAsset.depositAsset(USDC, _bridgeData.minAmount);
        _startBridge(_bridgeData);
    }

    /// @notice Performs a swap before bridging via CelerCircleBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    function swapAndStartBridgeTokensViaCelerCircleBridge(
        BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, USDC)
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

    /// @dev Contains the business logic for the bridge via CelerCircleBridge
    /// @param _bridgeData The core information needed for bridging
    function _startBridge(BridgeData memory _bridgeData) private {
        if (_bridgeData.destinationChainId > type(uint64).max)
            revert InvalidCallData();

        // give max approval for token to CelerCircleBridge bridge, if not already
        LibAsset.maxApproveERC20(
            IERC20(USDC),
            address(CIRCLE_BRIDGE_PROXY),
            _bridgeData.minAmount
        );

        // initiate bridge transaction
        CIRCLE_BRIDGE_PROXY.depositForBurn(
            _bridgeData.minAmount,
            uint64(_bridgeData.destinationChainId),
            LibUtil.convertAddressToBytes32(_bridgeData.receiver),
            USDC
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
