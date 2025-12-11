// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICircleBridgeProxyV2 } from "../Interfaces/ICircleBridgeProxyV2.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";

/// @title CelerCircleBridgeV2Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CelerCircleBridge
/// @custom:version 1.0.0
contract CelerCircleBridgeV2Facet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable
{
    /// Storage ///

    /// @notice The address of the CircleBridgeProxy on the current chain.
    ICircleBridgeProxyV2 public immutable CIRCLE_BRIDGE_PROXY_V2;
    /// @notice The USDC address on the current chain.
    address public immutable USDC;

    /// Types ///

    /// @param maxFee Maximum fee to pay on the destination domain, specified in units of burnToken. 0 means no fee limit.
    /// @param minFinalityThreshold The minimum finality at which a burn message will be attested to. 1000 = fast path, 2000 = standard path.
    struct CelerCircleBridgeData {
        uint256 maxFee;
        uint32 minFinalityThreshold;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _circleBridgeProxyV2 The address of the CircleBridgeProxy on the current chain.
    /// @param _usdc The address of USDC on the current chain.
    constructor(ICircleBridgeProxyV2 _circleBridgeProxyV2, address _usdc) {
        CIRCLE_BRIDGE_PROXY_V2 = _circleBridgeProxyV2;
        USDC = _usdc;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CelerCircleBridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _celerCircleBridgeData Data specific to CelerCircleBridge
    function startBridgeTokensViaCelerCircleBridgeV2(
        BridgeData calldata _bridgeData,
        CelerCircleBridgeData calldata _celerCircleBridgeData
    )
        external
        nonReentrant
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, USDC)
    {
        LibAsset.depositAsset(USDC, _bridgeData.minAmount);
        _startBridge(_bridgeData, _celerCircleBridgeData);
    }

    /// @notice Performs a swap before bridging via CelerCircleBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _celerCircleBridgeData Data specific to CelerCircleBridge
    function swapAndStartBridgeTokensViaCelerCircleBridgeV2(
        BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CelerCircleBridgeData calldata _celerCircleBridgeData
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
        _startBridge(_bridgeData, _celerCircleBridgeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CelerCircleBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _celerCircleBridgeData Data specific to CelerCircleBridge
    function _startBridge(
        BridgeData memory _bridgeData,
        CelerCircleBridgeData calldata _celerCircleBridgeData
    ) private {
        if (_bridgeData.destinationChainId > type(uint64).max) {
            revert InvalidCallData();
        }

        // give max approval for token to CelerCircleBridge bridge, if not already
        LibAsset.maxApproveERC20(
            IERC20(USDC),
            address(CIRCLE_BRIDGE_PROXY_V2),
            _bridgeData.minAmount
        );

        // initiate bridge transaction
        CIRCLE_BRIDGE_PROXY_V2.depositForBurn(
            _bridgeData.minAmount,
            uint64(_bridgeData.destinationChainId),
            bytes32(uint256(uint160(_bridgeData.receiver))),
            USDC,
            _celerCircleBridgeData.maxFee,
            _celerCircleBridgeData.minFinalityThreshold
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
