// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed } from "../Errors/GenericErrors.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";

/// @title GenericSwapFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for swapping through ANY APPROVED DEX
/// @dev Can only execute calldata for APPROVED function selectors
/// @custom:version 2.0.0
contract GenericSwapFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    // using SafeERC20 for ERC20;
    using SafeTransferLib for ERC20;

    /// External Methods ///

    /// @notice Performs a single swap from an ERC20 token to another ERC20 token
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleERC20ToERC20(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    ) external payable {
        _depositAndSwapERC20(_swapData);

        address receivingAssetId = _swapData.receivingAssetId;
        address sendingAssetId = _swapData.sendingAssetId;

        // get contract's balance (which will be sent in full to user)
        uint256 amountReceived = ERC20(receivingAssetId).balanceOf(
            address(this)
        );

        // ensure that minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        ERC20(receivingAssetId).safeTransfer(_receiver, amountReceived);

        // emit events (both required for tracking)
        uint256 fromAmount = _swapData.fromAmount;
        emit LibSwap.AssetSwapped(
            _transactionId,
            _swapData.callTo,
            sendingAssetId,
            receivingAssetId,
            fromAmount,
            amountReceived,
            block.timestamp
        );

        emit LiFiGenericSwapCompleted(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            sendingAssetId,
            receivingAssetId,
            fromAmount,
            amountReceived
        );
    }

    /// @notice Performs a single swap from an ERC20 token to the network's native token
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleERC20ToNative(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    ) external payable {
        _depositAndSwapERC20(_swapData);

        // get contract's balance (which will be sent in full to user)
        uint256 amountReceived = address(this).balance;

        // ensure that minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = _receiver.call{ value: amountReceived }("");
        if (!success) revert NativeAssetTransferFailed();

        // emit events (both required for tracking)
        address receivingAssetId = _swapData.receivingAssetId;
        address sendingAssetId = _swapData.sendingAssetId;
        uint256 fromAmount = _swapData.fromAmount;
        emit LibSwap.AssetSwapped(
            _transactionId,
            _swapData.callTo,
            sendingAssetId,
            receivingAssetId,
            fromAmount,
            amountReceived,
            block.timestamp
        );

        emit LiFiGenericSwapCompleted(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            sendingAssetId,
            receivingAssetId,
            fromAmount,
            amountReceived
        );
    }

    /// @notice Performs a single swap from the network's native token to ERC20 token
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleNativeToERC20(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    ) external payable {
        address callTo = _swapData.callTo;
        // ensure that contract (callTo) and function selector are whitelisted
        if (
            !(LibAllowList.contractIsAllowed(callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(_swapData.callData[:4])))
        ) revert ContractCallNotAllowed();

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = callTo.call{ value: msg.value }(
            _swapData.callData
        );
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        // get contract's balance (which will be sent in full to user)
        address receivingAssetId = _swapData.receivingAssetId;
        uint256 amountReceived = ERC20(receivingAssetId).balanceOf(
            address(this)
        );

        // ensure that minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        ERC20(receivingAssetId).safeTransfer(_receiver, amountReceived);

        // emit events (both required for tracking)
        address sendingAssetId = _swapData.sendingAssetId;
        uint256 fromAmount = _swapData.fromAmount;
        emit LibSwap.AssetSwapped(
            _transactionId,
            callTo,
            sendingAssetId,
            receivingAssetId,
            fromAmount,
            amountReceived,
            block.timestamp
        );

        emit LiFiGenericSwapCompleted(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            sendingAssetId,
            receivingAssetId,
            fromAmount,
            amountReceived
        );
    }

    /// @notice Performs multiple swaps (of any kind) in one transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensGeneric(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external payable nonReentrant refundExcessNative(_receiver) {
        uint256 postSwapBalance = _depositAndSwap(
            _transactionId,
            _minAmountOut,
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

    /// Internal helper methods ///

    function _depositAndSwapERC20(
        LibSwap.SwapData calldata _swapData
    ) private {
        ERC20 sendingAsset = ERC20(_swapData.sendingAssetId);
        uint256 fromAmount = _swapData.fromAmount;
        // deposit funds
        sendingAsset.safeTransferFrom(msg.sender, address(this), fromAmount);

        // ensure that contract (callTo) and function selector are whitelisted
        address callTo = _swapData.callTo;
        address approveTo = _swapData.approveTo;
        if (
            !(LibAllowList.contractIsAllowed(callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(_swapData.callData[:4])))
        ) revert ContractCallNotAllowed();

        // ensure that approveTo address is also whitelisted if it differs from callTo
        if (approveTo != callTo && !LibAllowList.contractIsAllowed(approveTo))
            revert ContractCallNotAllowed();

        // check if the current allowance is sufficient
        uint256 currentAllowance = sendingAsset.allowance(
            address(this),
            approveTo
        );

        if (currentAllowance == 0) {
            // just set allowance
            sendingAsset.safeApprove(approveTo, type(uint256).max);
        } else if (currentAllowance < fromAmount) {
            // allowance exists but is insufficient
            // reset to 0 first
            sendingAsset.safeApprove(approveTo, 0);
            // then set allowance
            sendingAsset.safeApprove(approveTo, type(uint256).max);
        }

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = callTo.call(_swapData.callData);
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }
    }
}
