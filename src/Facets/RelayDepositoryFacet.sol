// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IRelayDepository } from "../Interfaces/IRelayDepository.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";

/// @title RelayDepositoryFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for depositing assets into Relay Protocol V2 Depositories
/// @notice WARNING: We cannot guarantee that our bridgeData corresponds to (off-chain-)
/// @notice          data associated with the provided orderId
/// @custom:version 1.0.0
contract RelayDepositoryFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable
{
    /// Storage ///

    /// @notice The address of the Relay Depository contract
    address public immutable RELAY_DEPOSITORY;

    /// Types ///

    /// @dev Relay Depository specific parameters
    /// @param orderId Unique identifier for this deposit order
    /// @param depositorAddress The address that will be recorded as the depositor in the Relay Depository
    struct RelayDepositoryData {
        bytes32 orderId;
        address depositorAddress;
    }

    /// Constructor ///

    /// @param _relayDepository The address of the Relay Depository contract
    constructor(address _relayDepository) {
        if (_relayDepository == address(0)) {
            revert InvalidCallData();
        }
        RELAY_DEPOSITORY = _relayDepository;
    }

    /// External Methods ///

    /// @notice Deposits native tokens into Relay Depository
    /// @param _bridgeData The core information needed for bridging
    /// @param _relayDepositoryData Data specific to Relay Depository including orderId and depositorAddress
    function startBridgeTokensViaRelayDepository(
        ILiFi.BridgeData calldata _bridgeData,
        RelayDepositoryData calldata _relayDepositoryData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _relayDepositoryData);
    }

    /// @notice Performs a swap before depositing into Relay Depository
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _relayDepositoryData Data specific to Relay Depository
    function swapAndStartBridgeTokensViaRelayDepository(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        RelayDepositoryData calldata _relayDepositoryData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _relayDepositoryData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for depositing into Relay Depository
    /// @param _bridgeData The core information needed for bridging
    /// @param _relayDepositoryData Data specific to Relay Depository
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        RelayDepositoryData calldata _relayDepositoryData
    ) internal {
        // prevent invalid deposits or deposits being accidentally credited to msg.sender (our diamond)
        if (_relayDepositoryData.depositorAddress == address(0)) {
            revert InvalidCallData();
        }

        // WARNING: We cannot validate / guarantee that the off-chain-data associated with the provided
        //          orderId corresponds to the _bridgeData (e.g. receiver, destinationChain)

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Native token deposit
            IRelayDepository(RELAY_DEPOSITORY).depositNative{
                value: _bridgeData.minAmount
            }(
                _relayDepositoryData.depositorAddress,
                _relayDepositoryData.orderId
            );
        } else {
            // ERC20 token deposit
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                RELAY_DEPOSITORY,
                _bridgeData.minAmount
            );

            IRelayDepository(RELAY_DEPOSITORY).depositErc20(
                _relayDepositoryData.depositorAddress,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _relayDepositoryData.orderId
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
