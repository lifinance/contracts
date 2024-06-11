// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ITokenMessenger } from "../Interfaces/ITokenMessenger.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title CircleBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CircleBridge
/// @custom:version 1.0.0
contract CircleBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The address of the TokenMessenger on the source chain.
    ITokenMessenger private immutable tokenMessenger;

    /// @notice The USDC address on the source chain.
    address private immutable usdc;

    /// @param dstDomain The CircleBridge-specific domainId of the destination chain
    struct CircleBridgeData {
        uint32 dstDomain;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _tokenMessenger The address of the TokenMessenger on the source chain.
    /// @param _usdc The address of USDC on the source chain.
    constructor(ITokenMessenger _tokenMessenger, address _usdc) {
        tokenMessenger = _tokenMessenger;
        usdc = _usdc;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CircleBridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _circleBridgeData Data specific to bridge
    function startBridgeTokensViaCircleBridge(
        BridgeData calldata _bridgeData,
        CircleBridgeData calldata _circleBridgeData
    )
        external
        nonReentrant
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, usdc)
    {
        LibAsset.depositAsset(usdc, _bridgeData.minAmount);
        _startBridge(_bridgeData, _circleBridgeData);
    }

    /// @notice Performs a swap before bridging via CircleBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _circleBridgeData Data specific to CircleBridge
    function swapAndStartBridgeTokensViaCircleBridge(
        BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CircleBridgeData calldata _circleBridgeData
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
        _startBridge(_bridgeData, _circleBridgeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CircleBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _circleBridgeData Data specific to CircleBridge
    function _startBridge(
        BridgeData memory _bridgeData,
        CircleBridgeData calldata _circleBridgeData
    ) private {
        // give max approval for token to CircleBridge bridge, if not already
        LibAsset.maxApproveERC20(
            IERC20(usdc),
            address(tokenMessenger),
            _bridgeData.minAmount
        );

        // initiate bridge transaction
        tokenMessenger.depositForBurn(
            _bridgeData.minAmount,
            _circleBridgeData.dstDomain,
            bytes32(uint256(uint160(_bridgeData.receiver))),
            usdc
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
