// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGasZip } from "../Interfaces/IGasZip.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { ERC20 } from "solady/tokens/ERC20.sol";

/// @title GasZipFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality to swap ERC20 tokens to native and deposit them to the  gas.zip protocol (https://www.gas.zip/)
/// @custom:version 2.0.0
contract GasZipFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    using SafeTransferLib for address;

    error OnlySwapsFromERC20ToNativeAllowed();
    error OnlyNativeAllowed();

    /// State ///
    IGasZip public immutable gasZipRouter;

    /// Constructor ///
    constructor(address _gasZipRouter) {
        gasZipRouter = IGasZip(_gasZipRouter);
    }

    /// @notice Bridges tokens using the gas.zip protocol
    /// @dev this function only supports native flow. For ERC20 flows this facet should be used as a protocol step instead
    /// @param _bridgeData The core information needed for bridging
    /// @param _gasZipData GasZip-specific bridge data
    function startBridgeTokensViaGasZip(
        ILiFi.BridgeData memory _bridgeData,
        IGasZip.GasZipData calldata _gasZipData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        // this function / path shall only be used for native assets
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId))
            revert OnlyNativeAllowed();

        // deposit native to Gas.zip
        _startBridge(_bridgeData, _gasZipData);
    }

    /// @notice Performs a swap from ERC20 to native before depositing to the gas.zip protocol
    /// @param _bridgeData The core information needed for depositing
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _gasZipData GasZip-specific bridge data
    function swapAndStartBridgeTokensViaGasZip(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        IGasZip.GasZipData calldata _gasZipData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        // this function / path shall only be used for ERC20 assets
        if (
            !LibAsset.isNativeAsset(
                _swapData[_swapData.length - 1].receivingAssetId
            )
        ) revert OnlySwapsFromERC20ToNativeAllowed();

        // deposit and swap ERC20 tokens to n ative
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        // deposit native to Gas.zip
        _startBridge(_bridgeData, _gasZipData);
    }

    /// @dev Contains the business logic for depositing to GasZip protocol
    /// @param _bridgeData The core information needed for bridging
    /// @param _gasZipData Data specific to Gas.zip protocol
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        IGasZip.GasZipData calldata _gasZipData
    ) internal {
        // should we conduct any calldata checks here?
        // e.g. verify the receiver address (add parameter in _gasZipData and cross-check with bytes calldata)

        // deposit native to Gas.zip (v1) https://dev.gas.zip/gas/code-examples/contractDeposit
        gasZipRouter.deposit{ value: _bridgeData.minAmount }(
            _gasZipData.destinationChains,
            _gasZipData.receiver
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Returns a value that signals to Gas.zip to which chains gas should be sent in equal parts
    /// @param _chainIds a list of Gas.zip-specific chainIds (not the original chainIds), see https://dev.gas.zip/gas/chain-support/outbound
    function getDestinationChainsValue(
        uint8[] memory _chainIds
    ) public pure returns (uint256 destinationChains) {
        for (uint256 i = 0; i < _chainIds.length; i++) {
            // Shift destinationChains left by 8 bits and add the next chainID
            destinationChains =
                (destinationChains << 8) |
                uint256(_chainIds[i]);
        }
    }
}
