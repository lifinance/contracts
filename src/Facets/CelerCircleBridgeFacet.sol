// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICircleBridgeProxy } from "../Interfaces/ICircleBridgeProxy.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title CelerCircleBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CelerCircleBridge
/// @custom:version 1.0.0
contract CelerCircleBridgeFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable
{
    /// Storage ///

    /// @notice The address of the TokenMessenger on the current chain.
    ICircleBridgeProxy private immutable circleBridgeProxy;

    /// @notice The USDC address on the current chain.
    address private immutable usdc;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _circleBridgeProxy The address of the CircleBridgeProxy on the current chain.
    /// @param _usdc The address of USDC on the current chain.
    constructor(ICircleBridgeProxy _circleBridgeProxy, address _usdc) {
        circleBridgeProxy = _circleBridgeProxy;
        usdc = _usdc;
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
        onlyAllowSourceToken(_bridgeData, usdc)
    {
        LibAsset.depositAsset(usdc, _bridgeData.minAmount);
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
        onlyAllowSourceToken(_bridgeData, usdc)
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
        require(
            _bridgeData.destinationChainId <= type(uint64).max,
            "DestinationChainId passed is too big to fit in uint64"
        );

        // give max approval for token to CelerCircleBridge bridge, if not already
        LibAsset.maxApproveERC20(
            IERC20(usdc),
            address(circleBridgeProxy),
            _bridgeData.minAmount
        );

        // initiate bridge transaction
        circleBridgeProxy.depositForBurn(
            _bridgeData.minAmount,
            uint64(_bridgeData.destinationChainId),
            bytes32(uint256(uint160(_bridgeData.receiver))),
            usdc
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
