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

//TODO: remove
import { console2 } from "forge-std/console2.sol";

/// @title GenericSwapFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for swapping through any APPROVED DEX
/// @dev Can only execute calldata for APPROVED function selectors
/// @custom:version 3.0.0
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
        _depositAndSwapERC20Single(_swapData);

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
        _depositAndSwapERC20Single(_swapData);

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

    //------------------------------------------------------------------------
    //------------------------------------------------------------------------
    function swapTokensGenericV2FromERC20(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external payable {
        _depositERC20Tokens(_swapData);
        _executeSwaps(_swapData, _transactionId);
        _transferTokensAndEmitEvent(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _minAmountOut,
            _swapData
        );
    }

    function swapTokensGenericV2FromNative(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external payable {
        _executeSwaps(_swapData, _transactionId);
        _transferTokensAndEmitEvent(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _minAmountOut,
            _swapData
        );
    }

    function _depositERC20Tokens(
        LibSwap.SwapData[] calldata _swapData
    ) internal {
        console2.log("in _depositERC20Tokens");
        // TODO: consider/test adding a dedicated parameter (array with deposit tokens/amounts) so that we dont have to go through all swapData items
        LibSwap.SwapData[] calldata swapData = _swapData; // TODO: does this actually save gas?
        uint256 numOfSwaps = swapData.length;
        for (uint256 i = 0; i < numOfSwaps; ) {
            // CHECKED: saves gas (REMOVE COMMENT WHEN DONE)
            LibSwap.SwapData calldata currentSwap = swapData[i];
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
        bytes32 _transactionId
    ) private {
        console2.log("in _executeSwaps");
        // go through all swaps
        uint256 numOfSwaps = _swapData.length;
        for (uint256 i = 0; i < numOfSwaps; ) {
            LibSwap.SwapData calldata currentSwap = _swapData[i];

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

            // FOR ERC20 only: check if the current allowance is sufficient
            bool isNative = LibAsset.isNativeAsset(currentSwap.sendingAssetId);
            if (!isNative) {
                ERC20 sendingAsset = ERC20(currentSwap.sendingAssetId);
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
            }

            // execute the swap
            (bool success, bytes memory returnData) = currentSwap.callTo.call{
                value: isNative ? currentSwap.fromAmount : 0
            }(currentSwap.callData);
            if (!success) {
                revert(LibUtil.getRevertMsg(returnData));
            }

            // emit AssetSwapped event
            emit LibSwap.AssetSwapped(
                _transactionId,
                currentSwap.callTo,
                currentSwap.sendingAssetId,
                currentSwap.receivingAssetId,
                currentSwap.fromAmount,
                isNative
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

    function _transferTokensAndEmitEvent(
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
        emit LiFiGenericSwapCompleted(
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

    function _depositAndSwapERC20Single(
        LibSwap.SwapData calldata _swapData
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
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }
    }
}
