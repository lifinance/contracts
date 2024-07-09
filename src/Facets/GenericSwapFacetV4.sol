// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed, InvalidCallData } from "../Errors/GenericErrors.sol";

//TODO: replace with solady
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

//TODO: remove
import { console2 } from "forge-std/console2.sol";

/// @title GenericSwapFacetV4
/// @author LI.FI (https://li.fi)
/// @notice Provides gas-optimized functionality for fee collection and for swapping through any APPROVED DEX
/// @dev Can only execute calldata for APPROVED function selectors
/// @custom:version 1.0.0
contract GenericSwapFacetV4 is ILiFi {
    using SafeTransferLib for address;

    /// Storage ///

    address public immutable dexAggregatorAddress;

    /// Constructor

    /// @notice Initialize the contract
    /// @param _dexAggregatorAddress The address of the DEX aggregator
    constructor(address _dexAggregatorAddress) {
        dexAggregatorAddress = _dexAggregatorAddress;
    }

    /// Modifier
    modifier onlyCallsToDexAggregator(address callTo) {
        if (callTo != dexAggregatorAddress) revert InvalidCallData();
        _;
    }

    /// External Methods ///

    // SINGLE SWAPS

    /// @notice Performs a single swap from an ERC20 token to another ERC20 token
    /// @param (unused)_transactionId the transaction id associated with the operation
    /// @param (unused) _integrator the name of the integrator
    /// @param (unused) _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3ERC20ToERC20(
        bytes32,
        string calldata,
        string calldata,
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
    /// @param (unused)_transactionId the transaction id associated with the operation
    /// @param (unused) _integrator the name of the integrator
    /// @param (unused) _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3ERC20ToNative(
        bytes32,
        string calldata,
        string calldata,
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
    /// @param (unused)_transactionId the transaction id associated with the operation
    /// @param (unused) _integrator the name of the integrator
    /// @param (unused) _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3NativeToERC20(
        bytes32,
        string calldata,
        string calldata,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    ) external payable onlyCallsToDexAggregator(_swapData.callTo) {
        address callTo = _swapData.callTo;

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = callTo.call{ value: msg.value }(
            _swapData.callData
        );
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
    /// @param (*) _transactionId the transaction id associated with the operation
    /// @param (*) _integrator the name of the integrator
    /// @param (*) _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensMultipleV3ERC20ToERC20(
        bytes32,
        string calldata,
        string calldata,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external {
        //TODO: merge two functions ..MultipleV3ERCTo...
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
        bytes32,
        string calldata,
        string calldata,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external {
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
    /// @param (*) _transactionId the transaction id associated with the operation
    /// @param (*) _integrator the name of the integrator
    /// @param (*) _referrer the address of the referrer
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensMultipleV3NativeToERC20(
        bytes32,
        string calldata,
        string calldata,
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    ) external payable {
        uint256 finalAmountOut = _executeSwaps(_swapData, _receiver);

        // make sure that minAmount was received
        if (finalAmountOut < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, finalAmountOut);
    }

    /// Private helper methods ///
    function _depositMultipleERC20Tokens(
        LibSwap.SwapData[] calldata _swapData
    ) private {}

    function _depositAndSwapERC20Single(
        LibSwap.SwapData calldata _swapData,
        address _receiver
    ) private onlyCallsToDexAggregator(_swapData.callTo) {
        address sendingAssetId = _swapData.sendingAssetId;
        uint256 fromAmount = _swapData.fromAmount;
        // deposit funds
        sendingAssetId.safeTransferFrom(msg.sender, address(this), fromAmount);

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call(
            _swapData.callData
        );
        if (!success) {
            LibUtil.revertWith(res);
        }

        _returnPositiveSlippageERC20(sendingAssetId, _receiver);
    }

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
