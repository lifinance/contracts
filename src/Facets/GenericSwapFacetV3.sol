// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed } from "../Errors/GenericErrors.sol";

/// @title GenericSwapFacetV3
/// @author LI.FI (https://li.fi)
/// @notice Provides gas-optimized functionality for fee collection and for swapping through any whitelisted DEX
/// @dev Can only execute calldata for whitelisted function selectors
/// @custom:version 2.0.0
contract GenericSwapFacetV3 is ILiFi {
    /// Storage
    address public immutable NATIVE_ADDRESS;

    /// @dev Sentinel selector used to whitelist contracts that are approveTo-only targets
    ///      (i.e. not callable directly, but need allowance set against them).
    ///      See LibAllowList "Special ApproveTo-Only Selector" documentation.
    bytes4 private constant APPROVE_TO_ONLY_SELECTOR = 0xffffffff;

    /// Constructor
    /// @param _nativeAddress the address of the native token for this network
    constructor(address _nativeAddress) {
        NATIVE_ADDRESS = _nativeAddress;
    }

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
        uint256 amountReceived = IERC20(receivingAssetId).balanceOf(
            address(this)
        );

        // ensure that minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        LibAsset.transferERC20(receivingAssetId, _receiver, amountReceived);

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
        address sendingAssetId = _swapData.sendingAssetId;
        uint256 fromAmount = _swapData.fromAmount;
        emit LibSwap.AssetSwapped(
            _transactionId,
            _swapData.callTo,
            sendingAssetId,
            NATIVE_ADDRESS,
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
            NATIVE_ADDRESS,
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
        // ensure that contract (callTo) and function selector are whitelisted as a pair
        if (
            !LibAllowList.contractSelectorIsAllowed(
                callTo,
                bytes4(_swapData.callData[:4])
            )
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
        uint256 amountReceived = IERC20(receivingAssetId).balanceOf(
            address(this)
        );

        // ensure that minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer funds to receiver
        LibAsset.transferERC20(receivingAssetId, _receiver, amountReceived);

        // emit events (both required for tracking)
        uint256 fromAmount = _swapData.fromAmount;
        emit LibSwap.AssetSwapped(
            _transactionId,
            callTo,
            NATIVE_ADDRESS,
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
            NATIVE_ADDRESS,
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
        // initialize variables before loop to save gas
        uint256 numOfSwaps = _swapData.length;
        LibSwap.SwapData calldata currentSwap;

        // go through all swaps and deposit tokens, where required
        for (uint256 i = 0; i < numOfSwaps; ) {
            currentSwap = _swapData[i];
            if (currentSwap.requiresDeposit) {
                // we will not check msg.value as tx will fail anyway if not enough value available
                // thus we only deposit ERC20 tokens here
                LibAsset.transferFromERC20(
                    currentSwap.sendingAssetId,
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
    ) private {
        address sendingAssetId = _swapData.sendingAssetId;
        uint256 fromAmount = _swapData.fromAmount;
        // deposit funds
        LibAsset.transferFromERC20(
            sendingAssetId,
            msg.sender,
            address(this),
            fromAmount
        );

        // ensure that contract (callTo) and function selector are whitelisted as a pair
        address callTo = _swapData.callTo;
        address approveTo = _swapData.approveTo;
        bytes calldata callData = _swapData.callData;
        if (
            !LibAllowList.contractSelectorIsAllowed(
                callTo,
                bytes4(callData[:4])
            )
        ) revert ContractCallNotAllowed();

        // ensure that approveTo is whitelisted as an approveTo-only target if it differs from callTo
        if (
            approveTo != callTo &&
            !LibAllowList.contractSelectorIsAllowed(
                approveTo,
                APPROVE_TO_ONLY_SELECTOR
            )
        ) revert ContractCallNotAllowed();

        // set max approval if current allowance is insufficient
        // uses solady's safeApproveWithRetry under the hood which first
        // attempts a direct approve(spender, max) and only resets to zero
        // before retrying if the first call fails (handles USDT-style tokens
        // that require allowance to be zero before changing)
        LibAsset.maxApproveERC20(
            IERC20(sendingAssetId),
            approveTo,
            fromAmount
        );

        // execute swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = callTo.call(callData);
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
        bytes32 _transactionId,
        address _receiver
    ) private {
        // initialize variables before loop to save gas
        uint256 numOfSwaps = _swapData.length;
        address sendingAssetId;
        address receivingAssetId;
        LibSwap.SwapData calldata currentSwap;
        bool success;
        bytes memory returnData;

        // go through all swaps
        for (uint256 i = 0; i < numOfSwaps; ) {
            currentSwap = _swapData[i];
            sendingAssetId = currentSwap.sendingAssetId;
            receivingAssetId = currentSwap.receivingAssetId;

            // check if callTo and selector are whitelisted as a pair
            if (
                !LibAllowList.contractSelectorIsAllowed(
                    currentSwap.callTo,
                    bytes4(currentSwap.callData[:4])
                )
            ) {
                revert ContractCallNotAllowed();
            }

            // if approveTo differs from callTo, it must be whitelisted as an approveTo-only target
            if (
                currentSwap.approveTo != currentSwap.callTo &&
                !LibAllowList.contractSelectorIsAllowed(
                    currentSwap.approveTo,
                    APPROVE_TO_ONLY_SELECTOR
                )
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
                // but only for swaps, not for fee collections
                // (otherwise the whole amount would be returned before the actual swap)
                if (sendingAssetId != receivingAssetId)
                    _returnPositiveSlippageNative(_receiver);
            } else {
                // ERC20
                // set max approval if current allowance is insufficient
                // uses solady's safeApproveWithRetry under the hood which first
                // attempts a direct approve(spender, max) and only resets to zero
                // before retrying if the first call fails (handles USDT-style tokens
                // that require allowance to be zero before changing)
                LibAsset.maxApproveERC20(
                    IERC20(sendingAssetId),
                    currentSwap.approveTo,
                    currentSwap.fromAmount
                );

                // execute the swap
                (success, returnData) = currentSwap.callTo.call(
                    currentSwap.callData
                );
                if (!success) {
                    LibUtil.revertWith(returnData);
                }

                // return any potential leftover sendingAsset tokens
                // but only for swaps, not for fee collections
                // (otherwise the whole amount would be returned before the actual swap)
                if (sendingAssetId != receivingAssetId)
                    _returnPositiveSlippageERC20(sendingAssetId, _receiver);
            }

            // emit AssetSwapped event
            // @dev: this event might in some cases emit inaccurate information. e.g. if a token is
            //       swapped and this contract already held a balance of the receivingAsset then the
            //       event will show swapOutputAmount + existingBalance as toAmount. We accept this
            //       potential inaccuracy in return for gas savings and may update this at a later
            //       stage when the described use case becomes more common
            emit LibSwap.AssetSwapped(
                _transactionId,
                currentSwap.callTo,
                sendingAssetId,
                receivingAssetId,
                currentSwap.fromAmount,
                LibAsset.isNativeAsset(receivingAssetId)
                    ? address(this).balance
                    : IERC20(receivingAssetId).balanceOf(address(this)),
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
        uint256 amountReceived = IERC20(finalAssetId).balanceOf(address(this));

        // make sure minAmountOut was received
        if (amountReceived < _minAmountOut)
            revert CumulativeSlippageTooHigh(_minAmountOut, amountReceived);

        // transfer to receiver
        LibAsset.transferERC20(finalAssetId, _receiver, amountReceived);

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
            NATIVE_ADDRESS,
            _swapData[0].fromAmount,
            amountReceived
        );
    }

    // returns any unused 'sendingAsset' tokens (=> positive slippage) to the receiver address
    function _returnPositiveSlippageERC20(
        address sendingAssetId,
        address receiver
    ) private {
        // if a balance exists in sendingAsset, it must be positive slippage
        if (sendingAssetId != NATIVE_ADDRESS) {
            uint256 sendingAssetBalance = IERC20(sendingAssetId).balanceOf(
                address(this)
            );

            // we decided to change this value from 0 to 1 to have more flexibility with rebasing tokens that
            // sometimes produce rounding errors. In those cases there might be 1 wei leftover at the end of a swap
            // but this 1 wei is not transferable, so the tx reverts. We accept that 1 wei dust gets stuck in the contract
            // with every tx as this does not represent a significant USD value in any relevant token.
            if (sendingAssetBalance > 1) {
                LibAsset.transferERC20(
                    sendingAssetId,
                    receiver,
                    sendingAssetBalance
                );
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
