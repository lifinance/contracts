// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGasZip } from "../Interfaces/IGasZip.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { InvalidCallData, CannotBridgeToSameNetwork, InvalidAmount, InvalidConfig } from "lifi/Errors/GenericErrors.sol";

/// @title GasZipFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality to swap ERC20 tokens to native and deposit them to the gas.zip protocol (https://www.gas.zip/)
/// @custom:version 2.0.3
contract GasZipFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    using SafeTransferLib for address;

    error OnlyNativeAllowed();
    error TooManyChainIds();

    /// State ///
    address public constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;
    IGasZip public immutable GAS_ZIP_ROUTER;
    uint256 internal constant MAX_CHAINID_LENGTH_ALLOWED = 32;

    /// Constructor ///
    constructor(address _gasZipRouter) {
        if (address(_gasZipRouter) == address(0)) {
            revert InvalidConfig();
        }
        GAS_ZIP_ROUTER = IGasZip(_gasZipRouter);
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
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        // this function / path shall only be used for native assets
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId))
            revert OnlyNativeAllowed();

        // make sure that msg.value matches the to-be-deposited amount
        if (msg.value != _bridgeData.minAmount) revert InvalidAmount();

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
    {
        // make sure that the output of the last swap step is native
        if (
            !LibAsset.isNativeAsset(
                _swapData[_swapData.length - 1].receivingAssetId
            )
        ) revert InvalidCallData();

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
        // make sure receiver address has a value to prevent potential loss of funds
        if (_gasZipData.receiverAddress == bytes32(0))
            revert InvalidCallData();

        // validate that receiverAddress matches with bridgeData in case of EVM target chain
        if (
            _bridgeData.receiver != NON_EVM_ADDRESS &&
            _gasZipData.receiverAddress !=
            bytes32(bytes20(uint160(_bridgeData.receiver)))
        ) revert InvalidCallData();

        // validate bridgeData
        // make sure destinationChainId is of a different network
        if (_bridgeData.destinationChainId == block.chainid)
            revert CannotBridgeToSameNetwork();

        // We are depositing to a new contract that supports deposits for EVM chains + Solana (therefore 'receiver' address is bytes32)
        GAS_ZIP_ROUTER.deposit{ value: _bridgeData.minAmount }(
            _gasZipData.destinationChains,
            _gasZipData.receiverAddress
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Returns a value that signals to Gas.zip to which chains gas should be sent in equal parts
    /// @param _chainIds a list of Gas.zip-specific chainIds (not the original chainIds), see https://dev.gas.zip/gas/chain-support/outbound
    function getDestinationChainsValue(
        uint8[] calldata _chainIds
    ) external pure returns (uint256 destinationChains) {
        uint256 length = _chainIds.length;

        if (length > MAX_CHAINID_LENGTH_ALLOWED) revert TooManyChainIds();

        for (uint256 i; i < length; ++i) {
            // Shift destinationChains left by 8 bits and add the next chainID
            destinationChains =
                (destinationChains << 8) |
                uint256(_chainIds[i]);
        }
    }
}
