// IDEA:
// - differentiate DEX/swap functions by:
//   > can they send funds directly to user (saves one transfer)
//   > can they ensure minAmount received (saves us two balance checks and some if-logic)

// Questions:
// -  does every DEX have the option to send swapped funds directly to receiver address?
// -  how do we make sure that minAmount was received? Does every DEX have this option to pass a minAmount?
// -  do we neeed refundExcessNative on ERC20 swaps (e.g. when native is the toToken)?
// -  could we think of cases where we execute one ERC20 swap and the funds do not need to be deposited (maybe gasless deposit)?
// -  how can we deal with the issue that the event needs to toAmount in case where we dont conduct balance checks ourselves?

// // function selectors:
// if(fromToken == ERC20) {
//     if(canSendFundsDirectlyToReceiver) {
//         if(canEnsureMinAmountReceived) {
//             return "swapTokensSingleFromERC20NoMinAmountCheckNoTransfer";
//         }
//         else return "swapTokensSingleFromERC20WithMinAmountCheckNoTransfer";
//     }
//     else {
//         if(canEnsureMinAmountReceived) {
//             return "swapTokensSingleFromERC20NoMinAmountCheckWithTransfer";
//         }
//         else return "swapTokensSingleFromERC20WithMinAmountCheckWithTransfer";
//     }
// }

// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { InvalidReceiver, ContractCallNotAllowed, CumulativeSlippageTooHigh } from "../Errors/GenericErrors.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";

/// @title GenericSwapFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for swapping through ANY APPROVED DEX
/// @dev Can only execute calldata for APPROVED function selectors
/// @custom:version 2.0.0
contract GenericSwapFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    using SafeERC20 for IERC20;

    error InsufficientSwapOutput();

    /// External Methods ///

    /// @notice Performs a single swap with an ERC20 fromToken that requires no deposit (funds are already in the diamond)
    /// @param transactionId the transaction id associated with the operation
    function swapTokensSingleFromERC20NoDeposit(
        bytes32 transactionId,
        string calldata integrator,
        string calldata referrer,
        address payable receiver,
        uint256 minAmount,
        LibSwap.SwapData calldata swapData // TODO: do we need refundExcessNative here?
    ) external payable {
        // TODO: check if this function has any potential use case (e.g. gasless deposit) or should be removed
        _executeSwapFromERC20AndEmitEventWithMinAmountCheck(
            transactionId,
            integrator,
            referrer,
            receiver,
            minAmount,
            swapData
        );
    }

    /// @notice Performs a single swap with an ERC20 fromToken
    /// @param transactionId the transaction id associated with the operation
    function swapTokensSingleFromERC20WithDeposit(
        bytes32 transactionId,
        string calldata integrator,
        string calldata referrer,
        address payable receiver,
        uint256 minAmount,
        LibSwap.SwapData calldata swapData // TODO: do we need refundExcessNative here?
    ) external payable {
        // deposit funds
        IERC20(swapData.sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        _executeSwapFromERC20AndEmitEventWithMinAmountCheck(
            transactionId,
            integrator,
            referrer,
            receiver,
            minAmount,
            swapData
        );
    }

    /// @notice Performs a single swap with an ERC20 fromToken on a DEX that requires minAmount check but sends funds directly to receiver
    /// @param transactionId the transaction id associated with the operation
    function swapTokensSingleFromERC20WithMinAmountCheckNoTransfer(
        bytes32 transactionId,
        string calldata integrator,
        string calldata referrer,
        address payable receiver,
        uint256 minAmount,
        LibSwap.SwapData calldata swapData
    ) external payable {
        // deposit funds
        IERC20(swapData.sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // ensure that contract (callTo) and function selector are whitelisted
        if (
            !(LibAllowList.contractIsAllowed(swapData.callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(swapData.callData[:4])))
        ) revert ContractCallNotAllowed();

        // get initial token balance of receiver
        // TODO: this should be removed as we only use this to emit the event
        uint256 initialBalance = IERC20(swapData.receivingAssetId).balanceOf(
            receiver
        );

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = swapData.callTo.call(
            swapData.callData
        );
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        // get final balance
        // TODO: this should be removed as we only use this to emit the event
        uint256 amountReceived = IERC20(swapData.receivingAssetId).balanceOf(
            receiver
        ) - initialBalance;

        // emit event
        emit LiFiGenericSwapCompleted(
            transactionId,
            integrator,
            referrer,
            receiver,
            swapData.sendingAssetId,
            swapData.receivingAssetId,
            swapData.fromAmount,
            amountReceived
        );
    }

    /// @notice Performs a single swap with an ERC20 fromToken on a DEX that allows to ensure minAmount was received and funds are directly sent to receiver
    /// @param transactionId the transaction id associated with the operation
    function swapTokensSingleFromERC20NoMinAmountCheckNoTransfer(
        bytes32 transactionId,
        string calldata integrator,
        string calldata referrer,
        address payable receiver,
        uint256 minAmount,
        LibSwap.SwapData calldata swapData
    ) external payable {
        // deposit funds
        IERC20(swapData.sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // ensure that contract (callTo) and function selector are whitelisted
        if (
            !(LibAllowList.contractIsAllowed(swapData.callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(swapData.callData[:4])))
        ) revert ContractCallNotAllowed();

        // get initial token balance of receiver
        // TODO: this should be removed as we only use this to emit the event
        uint256 initialBalance = IERC20(swapData.receivingAssetId).balanceOf(
            receiver
        );

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = swapData.callTo.call(
            swapData.callData
        );
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        // get final balance
        uint256 amountReceived = IERC20(swapData.receivingAssetId).balanceOf(
            receiver
        ) - initialBalance;

        // ensure that minAmount was received
        if (amountReceived < minAmount)
            revert CumulativeSlippageTooHigh(minAmount, amountReceived);

        // emit event
        emit LiFiGenericSwapCompleted(
            transactionId,
            integrator,
            referrer,
            receiver,
            swapData.sendingAssetId,
            swapData.receivingAssetId,
            swapData.fromAmount,
            amountReceived
        );
    }

    // /// @notice Performs a single swap with a native fromToken
    // /// @param transactionId the transaction id associated with the operation
    // function swapTokensSingleNative(
    //     bytes32 transactionId,
    //     string calldata integrator,
    //     string calldata referrer,
    //     address payable receiver,
    //     uint256 minAmount,
    //     LibSwap.SwapData calldata swapData
    // ) external payable refundExcessNative(receiver) {
    //     _executeSwapAndEmitEvent(
    //         transactionId,
    //         integrator,
    //         referrer,
    //         receiver,
    //         minAmount,
    //         swapData,
    //         swapData.fromAmount
    //     );
    // }

    /// @notice Performs a single swap
    /// @param transactionId the transaction id associated with the operation
    function _executeSwapFromERC20AndEmitEventWithMinAmountCheck(
        bytes32 transactionId,
        string calldata integrator,
        string calldata referrer,
        address payable receiver,
        uint256 minAmount,
        LibSwap.SwapData calldata swapData
    ) private nonReentrant {
        // ensure that contract (callTo) and function selector are whitelisted
        if (
            // !((LibAsset.isNativeAsset(swapData.sendingAssetId) || // TODO: confirm that we can safely remove this
            // LibAllowList.contractIsAllowed(swapData.approveTo)) && // TODO: confirm that we can safely remove this
            !(LibAllowList.contractIsAllowed(swapData.callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(swapData.callData[:4])))
        ) revert ContractCallNotAllowed();

        // get initial token balance
        uint256 initialBalance = IERC20(swapData.receivingAssetId).balanceOf(
            address(this)
        );

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = swapData.callTo.call(
            swapData.callData
        );
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        // get final balance
        uint256 amountReceived = IERC20(swapData.receivingAssetId).balanceOf(
            address(this)
        ) - initialBalance;

        // ensure that minAmount was received
        if (amountReceived < minAmount)
            revert CumulativeSlippageTooHigh(minAmount, amountReceived);

        // transfer funds to receiver
        IERC20(swapData.receivingAssetId).safeTransfer(
            receiver,
            amountReceived
        );

        // emit event
        emit LiFiGenericSwapCompleted(
            transactionId,
            integrator,
            referrer,
            receiver,
            swapData.sendingAssetId,
            swapData.receivingAssetId,
            swapData.fromAmount,
            amountReceived
        );
    }

    //----------------------------------------------------------------------------------------------------------------
    //----------------------------------------------------------------------------------------------------------------
    //----------------------------------------------------------------------------------------------------------------

    /// @notice Performs multiple swaps in one transaction
    /// @param _transactionId the transaction id associated with the operation
    function swapTokensMultiple(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmount,
        LibSwap.SwapData[] calldata _swapData
    ) external payable nonReentrant refundExcessNative(_receiver) {
        swapTokensGeneric(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _minAmount,
            _swapData
        );
    }

    /// @notice Performs multiple swaps in one transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmount the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensGeneric(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmount,
        LibSwap.SwapData[] calldata _swapData
    ) public payable nonReentrant refundExcessNative(_receiver) {
        uint256 postSwapBalance = _depositAndSwap(
            _transactionId,
            _minAmount,
            _swapData,
            _receiver
        );
        address receivingAssetId = _swapData[_swapData.length - 1]
            .receivingAssetId;
        LibAsset.transferAsset(receivingAssetId, _receiver, postSwapBalance);

        emit LiFiGenericSwapCompleted(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _swapData[0].sendingAssetId,
            receivingAssetId,
            _swapData[0].fromAmount,
            postSwapBalance
        );
    }
}
