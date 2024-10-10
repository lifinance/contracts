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

/// @title GasZipFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality to swap ERC20 tokens to native and deposit them to the gas.zip protocol (https://www.gas.zip/)
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
    /// @param _gasZipData contains information which chains and address gas should be sent to
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

    /// @notice Performs one or multiple actions (e.g. fee collection, swapping) that must end with the native token before depositing to the gas.zip protocol
    /// @param _bridgeData The core information needed for depositing
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _gasZipData contains information which chains and address gas should be sent to
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
        // deposit and swap ERC20 tokens to native
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
    /// @param _gasZipData contains information which chains and address gas should be sent to
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        IGasZip.GasZipData calldata _gasZipData
    ) internal {
        // We are depositing to a new contract that supports deposits for EVM chains + Solana (therefore 'receiver' address is bytes32)
        gasZipRouter.deposit{ value: _bridgeData.minAmount }(
            _gasZipData.destinationChains,
            _gasZipData.receiver
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Returns a value that signals to Gas.zip to which chains gas should be sent in equal parts
    /// @param _chainIds a list of Gas.zip-specific chainIds (not the original chainIds), see https://dev.gas.zip/gas/chain-support/outbound
    function getDestinationChainsValue(
        uint8[] calldata _chainIds
    ) external pure returns (uint256 destinationChains) {
        uint256 length = _chainIds.length;
        require(length <= 32, "Too many chain IDs");

        for (uint256 i; i < length; ++i) {
            // Shift destinationChains left by 8 bits and add the next chainID
            destinationChains =
                (destinationChains << 8) |
                uint256(_chainIds[i]);
        }
    }
}
