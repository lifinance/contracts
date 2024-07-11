// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LibSwap, IERC20 } from "../Libraries/LibSwap.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed, InvalidCallData, UnAuthorized } from "../Errors/GenericErrors.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

/// @title GenericSwapper
/// @author LI.FI (https://li.fi)
/// @notice Provides gas-optimized functionality for fee collection and for swapping through any APPROVED DEX
/// @dev Can only execute calldata for APPROVED function selectors
/// @custom:version 1.0.0
contract GenericSwapperB is ILiFi {
    using SafeTransferLib for address;

    struct TokenApproval {
        address tokenAddress;
        bool maxApprovalToFeeCollector; // if true then a max approval will be set between this contract and LI.FI FeeCollector
        bool maxApprovalToDexAggregator; // if true then a max approval will be set between this contract and the LI.FI DEX Aggregator
    }

    /// Modifier ///
    modifier onlyAdmin() {
        if (msg.sender != adminAddress) revert UnAuthorized();
        _;
    }

    /// Storage ///

    address public immutable dexAggregatorAddress;
    address public immutable feeCollectorAddress;
    address public immutable adminAddress;

    /// Constructor

    /// @notice Initialize the contract
    /// @param _dexAggregatorAddress The address of the LI.FI DEX aggregator
    /// @param _feeCollectorAddress The address of the LI.FI FeeCollector
    /// @param _adminAddress The address of admin wallet (that can set token approvals)
    constructor(
        address _dexAggregatorAddress,
        address _feeCollectorAddress,
        address _adminAddress
    ) {
        dexAggregatorAddress = _dexAggregatorAddress;
        feeCollectorAddress = _feeCollectorAddress;
        adminAddress = _adminAddress;
    }

    /// Modifier
    modifier onlyCallsToDexAggregator(address callTo) {
        if (callTo != dexAggregatorAddress) revert InvalidCallData();
        _;
    }

    modifier onlyCallsToLiFiContracts(LibSwap.SwapData[] memory swapData) {
        for (uint256 i; i < swapData.length; ) {
            if (
                swapData[i].callTo != dexAggregatorAddress &&
                swapData[i].callTo != feeCollectorAddress
            ) revert InvalidCallData();

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }

        _;
    }

    /// External Methods ///

    // SINGLE SWAPS

    /// @notice Performs a single swap from an ERC20 token to another ERC20 token
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3ERC20ToERC20(
        address _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    ) external onlyCallsToDexAggregator(_swapData.callTo) {
        address sendingAssetId = _swapData.sendingAssetId;
        // deposit funds
        sendingAssetId.safeTransferFrom(
            msg.sender,
            address(this),
            _swapData.fromAmount
        );

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call(
            _swapData.callData
        );
        if (!success) {
            LibUtil.revertWith(res);
        }

        // make sure that minAmount was received
        uint256 amountReceived = abi.decode(res, (uint256));
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        _returnPositiveSlippageERC20(sendingAssetId, _receiver);
    }

    /// @notice Performs a single swap from an ERC20 token to the network's native token
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3ERC20ToNative(
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    ) external onlyCallsToDexAggregator(_swapData.callTo) {
        address sendingAssetId = _swapData.sendingAssetId;

        // deposit funds
        sendingAssetId.safeTransferFrom(
            msg.sender,
            address(this),
            _swapData.fromAmount
        );

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call(
            _swapData.callData
        );
        if (!success) {
            LibUtil.revertWith(res);
        }

        // make sure that minAmount was received
        uint256 amountReceived = abi.decode(res, (uint256));
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        _returnPositiveSlippageNative(_receiver);
    }

    /// @notice Performs a single swap from the network's native token to ERC20 token
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3NativeToERC20(
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    ) external payable onlyCallsToDexAggregator(_swapData.callTo) {
        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call{
            value: msg.value
        }(_swapData.callData);
        if (!success) {
            LibUtil.revertWith(res);
        }

        // make sure that minAmount was received
        uint256 amountReceived = abi.decode(res, (uint256));
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // return any positive slippage (i.e. unused sendingAsset tokens)
        _returnPositiveSlippageNative(_receiver);
    }

    // MULTIPLE SWAPS

    /// @notice Performs multiple swaps in one transaction, starting with ERC20 and ending with native
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensMultipleV3ERC20ToAny(
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external onlyCallsToLiFiContracts(_swapData) {
        // deposit token of first swap
        LibSwap.SwapData calldata currentSwap = _swapData[0];

        // check if a deposit is required
        if (currentSwap.requiresDeposit) {
            // we will not check msg.value as tx will fail anyway if not enough value available
            // thus we only deposit ERC20 tokens here
            currentSwap.sendingAssetId.safeTransferFrom(
                msg.sender,
                address(this),
                currentSwap.fromAmount
            );
        }

        uint256 finalAmountOut = _executeSwaps(_swapData, _receiver);

        // make sure that minAmount was received
        if (finalAmountOut < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, finalAmountOut);
    }

    function swapTokensMultipleV3ERC20ToNative(
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external onlyCallsToLiFiContracts(_swapData) {
        // deposit token of first swap
        LibSwap.SwapData calldata currentSwap = _swapData[0];

        // check if a deposit is required
        if (currentSwap.requiresDeposit) {
            // we will not check msg.value as tx will fail anyway if not enough value available
            // thus we only deposit ERC20 tokens here
            currentSwap.sendingAssetId.safeTransferFrom(
                msg.sender,
                address(this),
                currentSwap.fromAmount
            );
        }

        uint256 finalAmountOut = _executeSwaps(_swapData, _receiver);

        // make sure that minAmount was received
        if (finalAmountOut < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, finalAmountOut);
    }

    /// @notice Performs multiple swaps in one transaction, starting with native and ending with ERC20
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensMultipleV3NativeToERC20(
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external payable onlyCallsToLiFiContracts(_swapData) {
        uint256 finalAmountOut = _executeSwaps(_swapData, _receiver);

        // make sure that minAmount was received
        if (finalAmountOut < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, finalAmountOut);
    }

    /// @notice (Re-)Sets max approvals from this contract to DEX Aggregator and FeeCollector
    /// @param _approvals The information which approvals to set for which token
    function setApprovalForTokens(
        TokenApproval[] calldata _approvals
    ) external onlyAdmin {
        address tokenAddress;
        uint256 currentAllowance;
        for (uint256 i; i < _approvals.length; ) {
            tokenAddress = _approvals[i].tokenAddress;

            // if maxApprovalToDexAggregator==true, set max approval, otherwise set approval to 0
            // same for 'maxApprovalToFeeCollector' flag

            // update approval for DEX aggregator
            if (_approvals[i].maxApprovalToDexAggregator) {
                // if an allowance exists, set it to 0 first
                currentAllowance = IERC20(tokenAddress).allowance(
                    address(this),
                    dexAggregatorAddress
                );
                if (
                    currentAllowance != 0 &&
                    currentAllowance != type(uint256).max
                ) tokenAddress.safeApprove(dexAggregatorAddress, 0);

                // set max approval
                tokenAddress.safeApprove(
                    dexAggregatorAddress,
                    type(uint256).max
                );
            } else tokenAddress.safeApprove(dexAggregatorAddress, 0);

            // update approval for FeeCollector
            if (_approvals[i].maxApprovalToFeeCollector) {
                // if an allowance exists, set it to 0 first
                currentAllowance = IERC20(tokenAddress).allowance(
                    address(this),
                    feeCollectorAddress
                );
                if (
                    currentAllowance != 0 &&
                    currentAllowance != type(uint256).max
                ) tokenAddress.safeApprove(feeCollectorAddress, 0);

                // set max approval
                tokenAddress.safeApprove(
                    feeCollectorAddress,
                    type(uint256).max
                );
            } else tokenAddress.safeApprove(feeCollectorAddress, 0);

            // gas-efficient way to increase counter
            unchecked {
                ++i;
            }
        }
    }

    /// Private helper methods ///

    // @dev: this function will not work with swapData that has multiple swaps with the same sendingAssetId
    //       as the _returnPositiveSlippage... functionality will refund all remaining tokens after the first swap
    //       We accept this fact since the use case is not common yet. As an alternative you can always use the
    //       "swapTokensGeneric" function of the original GenericSwapFacet
    function _executeSwaps(
        LibSwap.SwapData[] calldata _swapData,
        address _receiver
    ) private returns (uint256 finalAmountOut) {
        // initialize variables before loop to save gas
        address sendingAssetId;
        address receivingAssetId;
        LibSwap.SwapData calldata currentSwap;
        bool success;
        bytes memory returnData;

        // go through all swaps
        for (uint256 i = 0; i < _swapData.length; ) {
            currentSwap = _swapData[i];
            sendingAssetId = currentSwap.sendingAssetId;
            receivingAssetId = currentSwap.receivingAssetId;

            // execute the swap
            (success, returnData) = currentSwap.callTo.call{
                value: LibAsset.isNativeAsset(sendingAssetId)
                    ? currentSwap.fromAmount
                    : 0
            }(currentSwap.callData);
            if (!success) {
                LibUtil.revertWith(returnData);
            }

            // check if this is the final swap
            if (i == _swapData.length - 1) {
                finalAmountOut = abi.decode(returnData, (uint256));
            }

            // return any potential leftover sendingAsset tokens
            // but only for swaps, not for fee collections (otherwise the whole amount would be returned before the actual swap)
            if (sendingAssetId != receivingAssetId)
                if (LibAsset.isNativeAsset(sendingAssetId)) {
                    // Native
                    _returnPositiveSlippageNative(_receiver);
                } else {
                    // ERC20
                    _returnPositiveSlippageERC20(sendingAssetId, _receiver);
                }

            unchecked {
                ++i;
            }
        }
    }

    // returns any unused 'sendingAsset' tokens (=> positive slippage) to the receiver address
    function _returnPositiveSlippageERC20(
        address sendingAsset,
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

    receive() external payable {}
}
