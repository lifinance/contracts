// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { ContractCallNotAllowed, NoSwapDataProvided, CumulativeSlippageTooHigh } from "../Errors/GenericErrors.sol";

/// @title SwapperV2
/// @author LI.FI (https://li.fi)
/// @notice Abstract contract to provide swap functionality with leftover token handling
/// @custom:version 1.1.0
contract SwapperV2 is ILiFi {
    /// Types ///

    /// @dev only used to get around "Stack Too Deep" errors
    struct ReserveData {
        bytes32 transactionId;
        address payable leftoverReceiver;
        uint256 nativeReserve;
    }

    /// Modifiers ///

    /// @dev Sends any leftover balances back to the user
    /// @notice Sends any leftover balances to the user
    /// @param _swaps Swap data array
    /// @param _leftoverReceiver Address to send leftover tokens to
    /// @param _initialBalances Array of initial token balances
    modifier noLeftovers(
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256[] memory _initialBalances
    ) {
        _;
        _refundLeftovers(_swaps, _leftoverReceiver, _initialBalances, 0);
    }

    /// @dev Sends any leftover balances back to the user reserving native tokens
    /// @notice Sends any leftover balances to the user
    /// @param _swaps Swap data array
    /// @param _leftoverReceiver Address to send leftover tokens to
    /// @param _initialBalances Array of initial token balances
    /// @param _nativeReserve Amount of native token to prevent from being swept
    modifier noLeftoversReserve(
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256[] memory _initialBalances,
        uint256 _nativeReserve
    ) {
        _;
        _refundLeftovers(
            _swaps,
            _leftoverReceiver,
            _initialBalances,
            _nativeReserve
        );
    }

    /// @dev Refunds any excess native asset sent to the contract after the main function
    /// @notice Refunds any excess native asset sent to the contract after the main function
    /// @param _refundReceiver Address to send refunds to
    modifier refundExcessNative(address payable _refundReceiver) {
        uint256 initialBalance = address(this).balance - msg.value;
        _;
        uint256 finalBalance = address(this).balance;

        if (finalBalance > initialBalance) {
            LibAsset.transferAsset(
                LibAsset.NULL_ADDRESS,
                _refundReceiver,
                finalBalance - initialBalance
            );
        }
    }

    /// Internal Methods ///

    /// @dev Deposits value, executes swaps, and performs minimum amount check
    /// @param _transactionId the transaction id associated with the operation
    /// @param _minAmount the minimum amount of the final asset to receive
    /// @param _swaps Array of data used to execute swaps
    /// @param _leftoverReceiver The address to send leftover funds to
    /// @return uint256 result of the swap
    function _depositAndSwap(
        bytes32 _transactionId,
        uint256 _minAmount,
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver
    ) internal returns (uint256) {
        uint256 numSwaps = _swaps.length;

        if (numSwaps == 0) {
            revert NoSwapDataProvided();
        }

        address finalTokenId = _swaps[numSwaps - 1].receivingAssetId;
        uint256 initialBalance = LibAsset.getOwnBalance(finalTokenId);

        if (LibAsset.isNativeAsset(finalTokenId)) {
            initialBalance -= msg.value;
        }

        uint256[] memory initialBalances = _fetchBalances(_swaps);

        LibAsset.depositAssets(_swaps);

        _executeSwaps(
            _transactionId,
            _swaps,
            _leftoverReceiver,
            initialBalances
        );

        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId) -
            initialBalance;

        if (newBalance < _minAmount) {
            revert CumulativeSlippageTooHigh(_minAmount, newBalance);
        }

        return newBalance;
    }

    /// @dev Deposits value, executes swaps, and performs minimum amount check and reserves native token for fees
    /// @param _transactionId the transaction id associated with the operation
    /// @param _minAmount the minimum amount of the final asset to receive
    /// @param _swaps Array of data used to execute swaps
    /// @param _leftoverReceiver The address to send leftover funds to
    /// @param _nativeReserve Amount of native token to prevent from being swept back to the caller
    function _depositAndSwap(
        bytes32 _transactionId,
        uint256 _minAmount,
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256 _nativeReserve
    ) internal returns (uint256) {
        uint256 numSwaps = _swaps.length;

        if (numSwaps == 0) {
            revert NoSwapDataProvided();
        }

        address finalTokenId = _swaps[numSwaps - 1].receivingAssetId;
        uint256 initialBalance = LibAsset.getOwnBalance(finalTokenId);

        if (LibAsset.isNativeAsset(finalTokenId)) {
            initialBalance -= msg.value;
        }

        uint256[] memory initialBalances = _fetchBalances(_swaps);

        LibAsset.depositAssets(_swaps);

        ReserveData memory reserveData = ReserveData({
            transactionId: _transactionId,
            leftoverReceiver: _leftoverReceiver,
            nativeReserve: _nativeReserve
        });

        _executeSwaps(reserveData, _swaps, initialBalances);

        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId) -
            initialBalance;

        if (LibAsset.isNativeAsset(finalTokenId)) {
            newBalance -= _nativeReserve;
        }

        if (newBalance < _minAmount) {
            revert CumulativeSlippageTooHigh(_minAmount, newBalance);
        }

        return newBalance;
    }

    /// Private Methods ///

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swaps Array of data used to execute swaps
    /// @param _leftoverReceiver Address to send leftover tokens to
    /// @param _initialBalances Array of initial balances
    function _executeSwaps(
        bytes32 _transactionId,
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256[] memory _initialBalances
    ) internal noLeftovers(_swaps, _leftoverReceiver, _initialBalances) {
        uint256 numSwaps = _swaps.length;
        for (uint256 i; i < numSwaps; ++i) {
            LibSwap.SwapData calldata currentSwap = _swaps[i];

            if (
                !((LibAsset.isNativeAsset(currentSwap.sendingAssetId) ||
                    LibAllowList.contractIsAllowed(currentSwap.approveTo)) &&
                    LibAllowList.contractIsAllowed(currentSwap.callTo) &&
                    LibAllowList.selectorIsAllowed(
                        bytes4(currentSwap.callData[:4])
                    ))
            ) revert ContractCallNotAllowed();

            LibSwap.swap(_transactionId, currentSwap);
        }
    }

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _reserveData Data passed used to reserve native tokens
    /// @param _swaps Array of data used to execute swaps
    /// @param _initialBalances Array of initial balances
    function _executeSwaps(
        ReserveData memory _reserveData,
        LibSwap.SwapData[] calldata _swaps,
        uint256[] memory _initialBalances
    )
        internal
        noLeftoversReserve(
            _swaps,
            _reserveData.leftoverReceiver,
            _initialBalances,
            _reserveData.nativeReserve
        )
    {
        uint256 numSwaps = _swaps.length;
        for (uint256 i; i < numSwaps; ++i) {
            LibSwap.SwapData calldata currentSwap = _swaps[i];

            if (
                !((LibAsset.isNativeAsset(currentSwap.sendingAssetId) ||
                    LibAllowList.contractIsAllowed(currentSwap.approveTo)) &&
                    LibAllowList.contractIsAllowed(currentSwap.callTo) &&
                    LibAllowList.selectorIsAllowed(
                        bytes4(currentSwap.callData[:4])
                    ))
            ) revert ContractCallNotAllowed();

            LibSwap.swap(_reserveData.transactionId, currentSwap);
        }
    }

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swaps Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(
        LibSwap.SwapData[] calldata _swaps
    ) internal view returns (uint256[] memory) {
        uint256 numSwaps = _swaps.length;
        uint256[] memory balances = new uint256[](numSwaps);
        address asset;
        for (uint256 i; i < numSwaps; ++i) {
            asset = _swaps[i].receivingAssetId;
            balances[i] = LibAsset.getOwnBalance(asset);

            if (LibAsset.isNativeAsset(asset)) {
                balances[i] -= msg.value;
            }
        }

        return balances;
    }

    /// @dev Refunds leftover tokens to a specified receiver after swaps complete
    /// @param _swaps Swap data array
    /// @param _leftoverReceiver Address to send leftover tokens to
    /// @param _initialBalances Array of initial token balances
    /// @param _nativeReserve Amount of native token to prevent from being swept (0 for no reserve)
    function _refundLeftovers(
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256[] memory _initialBalances,
        uint256 _nativeReserve
    ) private {
        uint256 numSwaps = _swaps.length;
        address finalAsset = _swaps[numSwaps - 1].receivingAssetId;

        // Handle both intermediate receiving assets and leftover input tokens in a single loop
        uint256 leftoverAmount;
        address curAsset;
        address inputAsset;
        uint256 curAssetReserve;
        uint256 currentInputBalance;
        uint256 inputAssetReserve;

        for (uint256 i; i < numSwaps; ++i) {
            // Handle intermediate receiving assets (only for non-final swaps when numSwaps > 1)
            if (i < numSwaps - 1 && numSwaps != 1) {
                curAsset = _swaps[i].receivingAssetId;
                // Handle multiple swap steps
                if (curAsset != finalAsset) {
                    leftoverAmount =
                        LibAsset.getOwnBalance(curAsset) -
                        _initialBalances[i];
                    curAssetReserve = LibAsset.isNativeAsset(curAsset)
                        ? _nativeReserve
                        : 0;
                    if (leftoverAmount > curAssetReserve) {
                        LibAsset.transferAsset(
                            curAsset,
                            _leftoverReceiver,
                            leftoverAmount - curAssetReserve
                        );
                    }
                }
            }

            // Handle leftover input tokens (but never sweep the final receiving asset)
            inputAsset = _swaps[i].sendingAssetId;
            currentInputBalance = LibAsset.getOwnBalance(inputAsset);
            inputAssetReserve = LibAsset.isNativeAsset(inputAsset)
                ? _nativeReserve
                : 0;

            // Only transfer leftovers if there's actually a balance remaining after reserve
            // and if it's not the final receiving asset (which should be kept for bridging)
            if (
                currentInputBalance > inputAssetReserve &&
                inputAsset != finalAsset
            ) {
                LibAsset.transferAsset(
                    inputAsset,
                    _leftoverReceiver,
                    currentInputBalance - inputAssetReserve
                );
            }
        }
    }
}
