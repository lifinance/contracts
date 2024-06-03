// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed } from "../Errors/GenericErrors.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";

/// @title GenericSwapFacetV3
/// @author LI.FI (https://li.fi)
/// @notice Provides gas-optimized functionality for fee collection and for swapping through any APPROVED DEX
/// @dev Can only execute calldata for APPROVED function selectors
/// @custom:version 1.0.0
contract GenericSwapFacetV3 is ILiFi {
    using SafeTransferLib for ERC20;

    /// External Methods ///

    // SINGLE SWAPS

    /// @notice Performs a single swap from an ERC20 token to another ERC20 token
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3ERC20ToERC20(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    ) external {
        _depositAndSwapERC20Single(_swapData, _receiver);

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

        emit ILiFi.LiFiGenericSwapCompleted(
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
    function swapTokensSingleV3ERC20ToNative(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    ) external {
        _depositAndSwapERC20Single(_swapData, _receiver);

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

        emit ILiFi.LiFiGenericSwapCompleted(
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
    function swapTokensSingleV3NativeToERC20(
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
            LibUtil.revertWith(res);
        }

        _returnPositiveSlippageNative(_receiver);

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

        emit ILiFi.LiFiGenericSwapCompleted(
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

    // MULTIPLE SWAPS

    /// @notice Performs multiple swaps in one transaction, starting with ERC20 and ending with native
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensMultipleV3ERC20ToNative(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external {
        _depositMultipleERC20Tokens(_swapData);
        _executeSwaps(_swapData, _transactionId, _receiver);
        _transferNativeTokensAndEmitEvent(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _minAmountOut,
            _swapData
        );
    }

    /// @notice Performs multiple swaps in one transaction, starting with ERC20 and ending with ERC20
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensMultipleV3ERC20ToERC20(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external {
        _depositMultipleERC20Tokens(_swapData);
        _executeSwaps(_swapData, _transactionId, _receiver);
        _transferERC20TokensAndEmitEvent(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _minAmountOut,
            _swapData
        );
    }

    /// @notice Performs multiple swaps in one transaction, starting with native and ending with ERC20
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensMultipleV3NativeToERC20(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external payable {
        _executeSwaps(_swapData, _transactionId, _receiver);
        _transferERC20TokensAndEmitEvent(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _minAmountOut,
            _swapData
        );
    }

    /// Private helper methods ///

    function _depositMultipleERC20Tokens(
        LibSwap.SwapData[] calldata _swapData
    ) private {
        uint256 numOfSwaps = _swapData.length;
        for (uint256 i = 0; i < numOfSwaps; ) {
            LibSwap.SwapData calldata currentSwap = _swapData[i];
            if (currentSwap.requiresDeposit) {
                // we will not check msg.value as tx will fail anyway if not enough value available
                // thus we only deposit ERC20 tokens here
                ERC20(currentSwap.sendingAssetId).safeTransferFrom(
                    msg.sender,
                    address(this),
                    currentSwap.fromAmount
                );
            }
            unchecked {
                ++i;
            }
        }
    }

    function _executeSwaps(
        LibSwap.SwapData[] calldata _swapData,
        bytes32 _transactionId,
        address _receiver
    ) private {
        // go through all swaps
        uint256 numOfSwaps = _swapData.length;
        for (uint256 i = 0; i < numOfSwaps; ) {
            LibSwap.SwapData calldata currentSwap = _swapData[i];
            ERC20 sendingAsset = ERC20(currentSwap.sendingAssetId);

            // check if callTo address is whitelisted
            if (
                !LibAllowList.contractIsAllowed(currentSwap.callTo) ||
                !LibAllowList.selectorIsAllowed(
                    bytes4(currentSwap.callData[:4])
                )
            ) {
                revert ContractCallNotAllowed();
            }

            // if approveTo address is different to callTo, check if it's whitelisted, too
            if (
                currentSwap.approveTo != currentSwap.callTo &&
                !LibAllowList.contractIsAllowed(currentSwap.approveTo)
            ) {
                revert ContractCallNotAllowed();
            }

            if (LibAsset.isNativeAsset(currentSwap.sendingAssetId)) {
                // Native
                // execute the swap
                (bool success, bytes memory returnData) = currentSwap
                    .callTo
                    .call{ value: currentSwap.fromAmount }(
                    currentSwap.callData
                );
                if (!success) {
                    LibUtil.revertWith(returnData);
                }

                // return any potential leftover sendingAsset tokens
                // but only for swaps, not for fee collections (otherwise the whole amount would be returned before the actual swap)
                if (currentSwap.sendingAssetId != currentSwap.receivingAssetId)
                    _returnPositiveSlippageNative(_receiver);
            } else {
                // ERC20
                // check if the current allowance is sufficient
                uint256 currentAllowance = sendingAsset.allowance(
                    address(this),
                    currentSwap.approveTo
                );
                if (currentAllowance < currentSwap.fromAmount) {
                    sendingAsset.safeApprove(currentSwap.approveTo, 0);
                    sendingAsset.safeApprove(
                        currentSwap.approveTo,
                        type(uint256).max
                    );
                }

                // execute the swap
                (bool success, bytes memory returnData) = currentSwap
                    .callTo
                    .call(currentSwap.callData);
                if (!success) {
                    LibUtil.revertWith(returnData);
                }

                // return any potential leftover sendingAsset tokens
                // but only for swaps, not for fee collections (otherwise the whole amount would be returned before the actual swap)
                if (currentSwap.sendingAssetId != currentSwap.receivingAssetId)
                    _returnPositiveSlippageERC20(sendingAsset, _receiver);
            }

            // emit AssetSwapped event
            emit LibSwap.AssetSwapped(
                _transactionId,
                currentSwap.callTo,
                currentSwap.sendingAssetId,
                currentSwap.receivingAssetId,
                currentSwap.fromAmount,
                LibAsset.isNativeAsset(currentSwap.receivingAssetId)
                    ? address(this).balance
                    : ERC20(currentSwap.receivingAssetId).balanceOf(
                        address(this)
                    ),
                block.timestamp
            );

            unchecked {
                ++i;
            }
        }
    }

    function _transferERC20TokensAndEmitEvent(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) private {
        // determine the end result of the swap
        address finalAssetId = _swapData[_swapData.length - 1]
            .receivingAssetId;
        uint256 amountReceived = ERC20(finalAssetId).balanceOf(address(this));

        // make sure minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer to receiver
        ERC20(finalAssetId).safeTransfer(_receiver, amountReceived);

        // emit event
        emit ILiFi.LiFiGenericSwapCompleted(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _swapData[0].sendingAssetId,
            finalAssetId,
            _swapData[0].fromAmount,
            amountReceived
        );
    }

    function _transferNativeTokensAndEmitEvent(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) private {
        uint256 amountReceived = address(this).balance;

        // make sure minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = _receiver.call{ value: amountReceived }("");
        if (!success) revert NativeAssetTransferFailed();

        // emit event
        emit ILiFi.LiFiGenericSwapCompleted(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _swapData[0].sendingAssetId,
            address(0),
            _swapData[0].fromAmount,
            amountReceived
        );
    }

    function _depositAndSwapERC20Single(
        LibSwap.SwapData calldata _swapData,
        address _receiver
    ) private {
        ERC20 sendingAsset = ERC20(_swapData.sendingAssetId);
        uint256 fromAmount = _swapData.fromAmount;
        // deposit funds
        sendingAsset.safeTransferFrom(msg.sender, address(this), fromAmount);

        // ensure that contract (callTo) and function selector are whitelisted
        address callTo = _swapData.callTo;
        address approveTo = _swapData.approveTo;
        bytes calldata callData = _swapData.callData;
        if (
            !(LibAllowList.contractIsAllowed(callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(callData[:4])))
        ) revert ContractCallNotAllowed();

        // ensure that approveTo address is also whitelisted if it differs from callTo
        if (approveTo != callTo && !LibAllowList.contractIsAllowed(approveTo))
            revert ContractCallNotAllowed();

        // check if the current allowance is sufficient
        uint256 currentAllowance = sendingAsset.allowance(
            address(this),
            approveTo
        );

        // check if existing allowance is sufficient
        if (currentAllowance < fromAmount) {
            // check if is non-zero, set to 0 if not
            if (currentAllowance != 0) sendingAsset.safeApprove(approveTo, 0);
            // set allowance to uint max to avoid future approvals
            sendingAsset.safeApprove(approveTo, type(uint256).max);
        }

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = callTo.call(callData);
        if (!success) {
            LibUtil.revertWith(res);
        }

        _returnPositiveSlippageERC20(sendingAsset, _receiver);
    }

    // returns any unused sendingAsset (=> positive slippage) to the receiver address
    function _returnPositiveSlippageERC20(
        ERC20 sendingAsset,
        address receiver
    ) private {
        // if a balance exists in sendingAsset, it must be positive slippage
        if (address(sendingAsset) != address(0)) {
            uint256 sendingAssetBalance = sendingAsset.balanceOf(
                address(this)
            );

            if (sendingAssetBalance > 0) {
                sendingAsset.safeTransfer(receiver, sendingAssetBalance);
            }
        }
    }

    // returns any unused native tokens (=> positive slippage) to the receiver address
    function _returnPositiveSlippageNative(address receiver) private {
        // if a native balance exists in sendingAsset, it must be positive slippage
        uint256 nativeBalance = address(this).balance;

        if (nativeBalance > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = receiver.call{ value: nativeBalance }("");
            if (!success) revert NativeAssetTransferFailed();
        }
    }
}
