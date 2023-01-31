// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IMakerTeleport } from "../Interfaces/IMakerTeleport.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidSendingToken, NoSwapDataProvided } from "../Errors/GenericErrors.sol";

/// @title MakerTeleport Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Maker Teleport
contract MakerTeleportFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The address of Maker Teleport.
    IMakerTeleport private immutable makerTeleport;

    /// @notice The address of DAI on the source chain.
    address private immutable dai;

    /// @notice The chain id of destination chain.
    uint256 private immutable dstChainId;

    /// @notice The domain of l1 network.
    bytes32 private immutable l1Domain;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _makerTeleport The address of Maker Teleport.
    /// @param _dai The address of DAI on the source chain.
    /// @param _dstChainId The chain id of destination chain.
    /// @param _l1Domain The domain of l1 network.
    constructor(
        IMakerTeleport _makerTeleport,
        address _dai,
        uint256 _dstChainId,
        bytes32 _l1Domain
    ) {
        dstChainId = _dstChainId;
        makerTeleport = _makerTeleport;
        dai = _dai;
        l1Domain = _l1Domain;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Maker Teleport
    /// @param _bridgeData The core information needed for bridging
    function startBridgeTokensViaMakerTeleport(ILiFi.BridgeData memory _bridgeData)
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        onlyAllowDestinationChain(_bridgeData, dstChainId)
        onlyAllowSourceToken(_bridgeData, dai)
    {
        LibAsset.depositAsset(dai, _bridgeData.minAmount);
        _startBridge(_bridgeData);
    }

    /// @notice Performs a swap before bridging via Maker Teleport
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    function swapAndStartBridgeTokensViaMakerTeleport(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        onlyAllowDestinationChain(_bridgeData, dstChainId)
        onlyAllowSourceToken(_bridgeData, dai)
    {
        if (_swapData.length == 0) {
            revert NoSwapDataProvided();
        }
        if (_swapData[_swapData.length - 1].receivingAssetId != dai) {
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

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Maker Teleport
    /// @param _bridgeData The core information needed for bridging
    function _startBridge(ILiFi.BridgeData memory _bridgeData) internal {
        LibAsset.maxApproveERC20(IERC20(dai), address(makerTeleport), _bridgeData.minAmount);

        makerTeleport.initiateTeleport(l1Domain, _bridgeData.receiver, uint128(_bridgeData.minAmount));

        emit LiFiTransferStarted(_bridgeData);
    }
}
