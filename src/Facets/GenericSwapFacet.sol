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
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { console2 } from "forge-std/console2.sol";

/// @title GenericSwapFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for swapping through ANY APPROVED DEX
/// @dev Can only execute calldata for APPROVED function selectors
/// @custom:version 2.0.0
contract GenericSwapFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    using SafeERC20 for IERC20;

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
    ) external payable nonReentrant returns (uint256 amountOut) {
        // deposit funds
        IERC20(_swapData.sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            _swapData.fromAmount
        );

        // ensure that contract (callTo) and function selector are whitelisted
        if (
            !(LibAllowList.contractIsAllowed(_swapData.callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(_swapData.callData[:4])))
        ) revert ContractCallNotAllowed();

        // get initial token balance
        uint256 initialBalance = IERC20(_swapData.receivingAssetId).balanceOf(
            address(this)
        );

        // check if the current allowance is sufficient
        if (
            IERC20(_swapData.sendingAssetId).allowance(
                address(this),
                _swapData.approveTo
            ) < _swapData.fromAmount
        ) {
            // allowance insufficient - register max approval
            SafeERC20.safeApprove(
                IERC20(_swapData.sendingAssetId),
                _swapData.approveTo,
                0
            );
            SafeERC20.safeApprove(
                IERC20(_swapData.sendingAssetId),
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

        // get final balance
        amountOut =
            IERC20(_swapData.receivingAssetId).balanceOf(address(this)) -
            initialBalance;

        // ensure that minAmountOut was received
        if (amountOut < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountOut);

        // transfer funds to receiver
        IERC20(_swapData.receivingAssetId).safeTransfer(_receiver, amountOut);

        // emit events (both required for tracking)
        emit AssetSwapped(
            _transactionId,
            _swapData.callTo,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
            _minAmountOut,
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
            amountOut
        );
    }

    /// @notice Performs a single swap from an ERC20 token to the network'S native token
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
        // deposit funds
        IERC20(_swapData.sendingAssetId).safeTransferFrom(
            msg.sender,
            address(this),
            _swapData.fromAmount
        );

        // ensure that contract (callTo) and function selector are whitelisted
        if (
            !(LibAllowList.contractIsAllowed(_swapData.callTo) &&
                LibAllowList.selectorIsAllowed(bytes4(_swapData.callData[:4])))
        ) revert ContractCallNotAllowed();

        // get initial token balance
        uint256 initialBalance = address(this).balance;

        // check if the current allowance is sufficient
        if (
            IERC20(_swapData.sendingAssetId).allowance(
                address(this),
                _swapData.approveTo
            ) < _swapData.fromAmount
        ) {
            // allowance insufficient - register max approval
            SafeERC20.safeApprove(
                IERC20(_swapData.sendingAssetId),
                _swapData.approveTo,
                0
            );
            SafeERC20.safeApprove(
                IERC20(_swapData.sendingAssetId),
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

        // get final balance
        uint256 amountReceived = address(this).balance - initialBalance;

        // ensure that minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        // solhint-disable-next-line avoid-low-level-calls
        (success, ) = _receiver.call{ value: amountReceived }("");
        if (!success) revert NativeAssetTransferFailed();

        // emit events (both required for tracking)
        emit AssetSwapped(
            _transactionId,
            _swapData.callTo,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
            _minAmountOut,
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

        // get initial token balance
        uint256 initialBalance = IERC20(_swapData.receivingAssetId).balanceOf(
            address(this)
        );

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call{
            value: msg.value
        }(_swapData.callData);
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        // get final balance
        uint256 amountReceived = IERC20(_swapData.receivingAssetId).balanceOf(
            address(this)
        ) - initialBalance;

        // ensure that minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        IERC20(_swapData.receivingAssetId).safeTransfer(
            _receiver,
            amountReceived
        );

        // emit events (both required for tracking)
        emit AssetSwapped(
            _transactionId,
            _swapData.callTo,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
            _minAmountOut,
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

    //----------------------------------------------------------------------------------------------------------------
    //----------------------------------------------------------------------------------------------------------------
    //----------------------------------------------------------------------------------------------------------------

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
}
