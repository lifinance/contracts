// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed, InvalidCallData } from "../Errors/GenericErrors.sol";

//TODO: replace with solady
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";

//TODO: remove
import { console2 } from "forge-std/console2.sol";

/// @title GenericSwapFacetV4
/// @author LI.FI (https://li.fi)
/// @notice Provides gas-optimized functionality for fee collection and for swapping through any APPROVED DEX
/// @dev Can only execute calldata for APPROVED function selectors
/// @custom:version 1.0.0
contract GenericSwapFacetV4 is ILiFi {
    using SafeTransferLib for ERC20;

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
        ERC20 sendingAsset = ERC20(_swapData.sendingAssetId);
        // deposit funds
        sendingAsset.safeTransferFrom(
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

        _returnPositiveSlippageERC20(sendingAsset, _receiver);
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
        ERC20 sendingAsset = ERC20(_swapData.sendingAssetId);

        // deposit funds
        sendingAsset.safeTransferFrom(
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
        // initialize variables before loop to save gas
        uint256 numOfSwaps = _swapData.length;
        LibSwap.SwapData calldata currentSwap;

        // go through all swaps and deposit tokens, where required
        for (uint256 i = 0; i < numOfSwaps; ) {
            currentSwap = _swapData[i];
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

    function _depositAndSwapERC20Single(
        LibSwap.SwapData calldata _swapData,
        address _receiver
    ) private onlyCallsToDexAggregator(_swapData.callTo) {
        ERC20 sendingAsset = ERC20(_swapData.sendingAssetId);
        uint256 fromAmount = _swapData.fromAmount;
        // deposit funds
        sendingAsset.safeTransferFrom(msg.sender, address(this), fromAmount);

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call(
            _swapData.callData
        );
        if (!success) {
            LibUtil.revertWith(res);
        }

        _returnPositiveSlippageERC20(sendingAsset, _receiver);
    }

    // @dev: this function will not work with swapData that has multiple swaps with the same sendingAssetId
    //       as the _returnPositiveSlippage... functionality will refund all remaining tokens after the first swap
    //       We accept this fact since the use case is not common yet. As an alternative you can always use the
    //       "swapTokensGeneric" function of the original GenericSwapFacet
    function _executeSwaps(
        LibSwap.SwapData[] calldata _swapData,
        bytes32 _transactionId,
        address _receiver
    ) private {
        // initialize variables before loop to save gas
        uint256 numOfSwaps = _swapData.length;
        ERC20 sendingAsset;
        address sendingAssetId;
        address receivingAssetId;
        LibSwap.SwapData calldata currentSwap;
        bool success;
        bytes memory returnData;
        uint256 currentAllowance;

        // go through all swaps
        for (uint256 i = 0; i < numOfSwaps; ) {
            currentSwap = _swapData[i];
            sendingAssetId = currentSwap.sendingAssetId;
            sendingAsset = ERC20(currentSwap.sendingAssetId);
            receivingAssetId = currentSwap.receivingAssetId;

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

            if (LibAsset.isNativeAsset(sendingAssetId)) {
                // Native
                // execute the swap
                (success, returnData) = currentSwap.callTo.call{
                    value: currentSwap.fromAmount
                }(currentSwap.callData);
                if (!success) {
                    LibUtil.revertWith(returnData);
                }

                // return any potential leftover sendingAsset tokens
                // but only for swaps, not for fee collections (otherwise the whole amount would be returned before the actual swap)
                if (sendingAssetId != receivingAssetId)
                    _returnPositiveSlippageNative(_receiver);
            } else {
                // ERC20
                // check if the current allowance is sufficient
                currentAllowance = sendingAsset.allowance(
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
                (success, returnData) = currentSwap.callTo.call(
                    currentSwap.callData
                );
                if (!success) {
                    LibUtil.revertWith(returnData);
                }

                // return any potential leftover sendingAsset tokens
                // but only for swaps, not for fee collections (otherwise the whole amount would be returned before the actual swap)
                if (sendingAssetId != receivingAssetId)
                    _returnPositiveSlippageERC20(sendingAsset, _receiver);
            }

            // emit AssetSwapped event
            // @dev: this event might in some cases emit inaccurate information. e.g. if a token is swapped and this contract already held a balance of the receivingAsset
            //       then the event will show swapOutputAmount + existingBalance as toAmount. We accept this potential inaccuracy in return for gas savings and may update this
            //       at a later stage when the described use case becomes more common
            emit LibSwap.AssetSwapped(
                _transactionId,
                currentSwap.callTo,
                sendingAssetId,
                receivingAssetId,
                currentSwap.fromAmount,
                LibAsset.isNativeAsset(receivingAssetId)
                    ? address(this).balance
                    : ERC20(receivingAssetId).balanceOf(address(this)),
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
        if (!success) {
            revert NativeAssetTransferFailed();
        }

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

    // returns any unused 'sendingAsset' tokens (=> positive slippage) to the receiver address
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

    receive() external payable {}
}
