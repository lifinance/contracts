// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICircleBridgeProxy } from "../Interfaces/ICircleBridgeProxy.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title CelerCircleBridgeFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CelerCircleBridge
/// @custom:version 2.0.0
contract CelerCircleBridgeFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable
{
    /// Storage ///

    /// @notice The address of the CircleBridgeProxy on the current chain.
    ICircleBridgeProxy public immutable CIRCLE_BRIDGE_PROXY;
    /// @notice The USDC address on the current chain.
    address public immutable USDC;

    /// Types ///

    /// @param maxFee Maximum fee to pay on the destination domain, specified in units of burnToken. 0 means no fee limit.
    /// @param minFinalityThreshold The minimum finality at which a burn message will be attested to. 1000 = fast path, 2000 = standard path.
    struct CelerCircleData {
        uint256 maxFee;
        uint32 minFinalityThreshold;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _circleBridgeProxy The address of the CircleBridgeProxy on the current chain.
    /// @param _usdc The address of USDC on the current chain.
    constructor(ICircleBridgeProxy _circleBridgeProxy, address _usdc) {
        if (address(_circleBridgeProxy) == address(0) || _usdc == address(0)) {
            revert InvalidConfig();
        }
        CIRCLE_BRIDGE_PROXY = _circleBridgeProxy;
        USDC = _usdc;
    }

    /// @notice Sets a max approval from lifiDiamond to CircleBridgeProxy
    /// It is safe to set a max approval since the diamond is designed to not hold any funds (that could otherwise be stolen if CircleBridgeProxy turns malicious)
    /// We also don't need to store the initialization status of this facet since it will not break from being initialized multiple times (plus it's an admin-only function)
    function initCelerCircleBridge() external {
        LibDiamond.enforceIsContractOwner();

        // approve max allowance to CircleBridgeProxy
        // since this facet only supports one token: USDC which follows the IERC20 standard, we can safely use approve instead of safeApprove.
        IERC20(USDC).approve(address(CIRCLE_BRIDGE_PROXY), type(uint256).max);
    }

    /// External Methods ///

    /// @notice Bridges tokens via CelerCircleBridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _celerCircleData Data specific to CelerCircleBridge
    function startBridgeTokensViaCelerCircleBridge(
        BridgeData calldata _bridgeData,
        CelerCircleData calldata _celerCircleData
    )
        external
        nonReentrant
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, USDC)
    {
        LibAsset.depositAsset(USDC, _bridgeData.minAmount);
        _startBridge(_bridgeData, _celerCircleData);
    }

    /// @notice Performs a swap before bridging via CelerCircleBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _celerCircleData Data specific to CelerCircleBridge
    function swapAndStartBridgeTokensViaCelerCircleBridge(
        BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CelerCircleData calldata _celerCircleData
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
        _startBridge(_bridgeData, _celerCircleData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CelerCircleBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _celerCircleData Data specific to CelerCircleBridge
    function _startBridge(
        BridgeData memory _bridgeData,
        CelerCircleData calldata _celerCircleData
    ) private {
        if (_bridgeData.destinationChainId > type(uint64).max) {
            revert InvalidCallData();
        }

        // initiate bridge transaction
        CIRCLE_BRIDGE_PROXY.depositForBurn(
            _bridgeData.minAmount,
            uint64(_bridgeData.destinationChainId),
            bytes32(uint256(uint160(_bridgeData.receiver))),
            USDC,
            _celerCircleData.maxFee,
            _celerCircleData.minFinalityThreshold
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
