// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { InvalidReceiver, ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed } from "../Errors/GenericErrors.sol";
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

    error InsufficientSwapOutput();

    event AssetSwapped(
        bytes32 transactionId,
        address dex,
        address fromAssetId,
        address toAssetId,
        uint256 fromAmount,
        uint256 toAmount,
        uint256 timestamp
    );

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
    ) external payable nonReentrant {
        _depositAndSwapERC20(_swapData);

        // get contract's balance (which will be sent in full to user)
        uint256 amountReceived = ERC20(_swapData.receivingAssetId).balanceOf(
            address(this)
        );

        // ensure that minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        ERC20(_swapData.receivingAssetId).safeTransfer(
            _receiver,
            amountReceived
        );

        // emit events (both required for tracking)
        emit LibSwap.AssetSwapped(
            _transactionId,
            _swapData.callTo,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
            amountReceived,
            block.timestamp
        );

        emit LiFiGenericSwapCompleted(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
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
        emit LibSwap.AssetSwapped(
            _transactionId,
            _swapData.callTo,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
            amountReceived,
            block.timestamp
        );

        emit LiFiGenericSwapCompleted(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
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
        // ensure that contract (callTo) and function selector are whitelisted
        if (
            !(LibAllowList.contractIsAllowed(_swapData.callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(_swapData.callData[:4])))
        ) revert ContractCallNotAllowed();

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call{
            value: msg.value
        }(_swapData.callData);
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        // get contract's balance (which will be sent in full to user)
        uint256 amountReceived = ERC20(_swapData.receivingAssetId).balanceOf(
            address(this)
        );

        // ensure that minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        ERC20(_swapData.receivingAssetId).safeTransfer(
            _receiver,
            amountReceived
        );

        // emit events (both required for tracking)
        emit LibSwap.AssetSwapped(
            _transactionId,
            _swapData.callTo,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
            amountReceived,
            block.timestamp
        );

        emit LiFiGenericSwapCompleted(
            _transactionId,
            _integrator,
            _referrer,
            _receiver,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
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
        // deposit funds
        ERC20(_swapData.sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            _swapData.fromAmount
        );

        // ensure that contract (callTo) and function selector are whitelisted
        if (
            !(LibAllowList.contractIsAllowed(_swapData.callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(_swapData.callData[:4])))
        ) revert ContractCallNotAllowed();

        // check if the current allowance is sufficient
        uint256 currentAllowance = ERC20(_swapData.sendingAssetId).allowance(
            address(this),
            _swapData.approveTo
        );

        if (currentAllowance == 0) {
            // just set allowance
            ERC20(_swapData.sendingAssetId).safeApprove(
                _swapData.approveTo,
                type(uint256).max
            );
        } else if (currentAllowance < _swapData.fromAmount) {
            // allowance exists but is insufficient
            // reset to 0 first
            ERC20(_swapData.sendingAssetId).safeApprove(
                _swapData.approveTo,
                0
            );
            // then set allowance
            ERC20(_swapData.sendingAssetId).safeApprove(
                _swapData.approveTo,
                type(uint256).max
            );
        }

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call(
            _swapData.callData
        );
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }
    }
}
