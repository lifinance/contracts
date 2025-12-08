// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { UnAuthorized, InvalidConfig } from "../Errors/GenericErrors.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

/// @title ReceiverAcrossV4
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing via AcrossV4
/// @custom:version 1.0.0
contract ReceiverAcrossV4 is ILiFi, WithdrawablePeriphery {
    using SafeTransferLib for address;

    /// Storage ///
    IExecutor public immutable EXECUTOR;
    address public immutable SPOKEPOOL;

    /// Modifiers ///
    modifier onlySpokepool() {
        if (msg.sender != SPOKEPOOL) {
            revert UnAuthorized();
        }
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _executor,
        address _spokepool
    ) WithdrawablePeriphery(_owner) {
        if (
            _executor == address(0) ||
            _spokepool == address(0) ||
            _owner == address(0)
        ) revert InvalidConfig();

        EXECUTOR = IExecutor(_executor);
        SPOKEPOOL = _spokepool;
    }

    /// External Methods ///

    /// @notice Completes an AcrossV4 cross-chain transaction on the receiving chain
    /// @dev Token transfer and message execution will happen in one atomic transaction
    /// @dev This function can only be called the Across SpokePool on this network
    /// @dev Across did not rename this function to V4 but it can be used for V4 as well
    /// @param tokenSent The address of the token that was received
    /// @param amount The amount of tokens received
    /// @param * - unused(relayer) The address of the relayer who is executing this message
    /// @param message The composed message payload in bytes
    function handleV3AcrossMessage(
        address tokenSent,
        uint256 amount,
        address,
        bytes memory message
    ) external onlySpokepool {
        // decode payload
        (
            bytes32 transactionId,
            LibSwap.SwapData[] memory swapData,
            address receiver
        ) = abi.decode(message, (bytes32, LibSwap.SwapData[], address));

        // execute swap(s)
        _swapAndCompleteBridgeTokens(
            transactionId,
            swapData,
            tokenSent,
            payable(receiver),
            amount
        );
    }

    /// Private Methods ///

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @notice Since Across will always send wrappedNative to contract, we do not need a native handling here
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swapData array of data needed for swaps
    /// @param assetId address of the token received from the source chain
    ///                (not to be confused with StargateV2's assetIds which are uint16 values)
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function _swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver,
        uint256 amount
    ) private {
        assetId.safeApproveWithRetry(address(EXECUTOR), amount);
        try
            EXECUTOR.swapAndCompleteBridgeTokens(
                _transactionId,
                _swapData,
                assetId,
                receiver
            )
        {
            // do nothing
        } catch {
            // send the bridged (and unswapped) funds to receiver address
            LibAsset.transferERC20(assetId, receiver, amount);

            emit LiFiTransferRecovered(
                _transactionId,
                assetId,
                receiver,
                amount,
                block.timestamp
            );
        }

        // reset approval to 0
        assetId.safeApprove(address(EXECUTOR), 0);
    }

    /// @notice Receive native asset directly.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
