// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { InvalidAmount, ContractCallNotAllowed, NoSwapDataProvided, CumulativeSlippageTooHigh } from "../Errors/GenericErrors.sol";

/// @title Swapper
/// @author LI.FI (https://li.fi)
/// @notice Abstract contract to provide swap functionality
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
    modifier noLeftovers(LibSwap.SwapData[] calldata _swaps, address payable _leftoverReceiver) {
        uint256 nSwaps = _swaps.length;
        if (nSwaps != 1) {
            uint256[] memory initialBalances = _fetchBalances(_swaps);
            address finalAsset = _swaps[nSwaps - 1].receivingAssetId;
            uint256 curBalance = 0;
            uint256 newBalance = 0;
            _;

            for (uint256 i = 0; i < nSwaps - 1; ) {
                address curAsset = _swaps[i].receivingAssetId;
                // Handle multi-to-one swaps
                if (curAsset != finalAsset) {
                    newBalance = LibAsset.getOwnBalance(curAsset);
                    curBalance = newBalance > initialBalances[i] ? newBalance - initialBalances[i] : newBalance;
                    if (curBalance > 0) LibAsset.transferAsset(curAsset, _leftoverReceiver, curBalance);
                }
                unchecked {
                    ++i;
                }
            }
        } else _;
    }

    /// @dev Sends any leftover balances back to the user
    modifier noLeftoversReserve(
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256 _nativeReserve
    ) {
        uint256 nSwaps = _swaps.length;
        if (nSwaps != 1) {
            uint256[] memory initialBalances = _fetchBalances(_swaps);
            address finalAsset = _swaps[nSwaps - 1].receivingAssetId;
            uint256 curBalance = 0;
            uint256 newBalance = 0;
            _;

            for (uint256 i = 0; i < nSwaps - 1; ) {
                address curAsset = _swaps[i].receivingAssetId;
                // Handle multi-to-one swaps
                if (curAsset != finalAsset) {
                    uint256 reserve = LibAsset.isNativeAsset(curAsset) ? _nativeReserve : 0;
                    newBalance = LibAsset.getOwnBalance(curAsset);
                    curBalance = newBalance > initialBalances[i] ? newBalance - initialBalances[i] : newBalance;
                    if (curBalance > 0) LibAsset.transferAsset(curAsset, _leftoverReceiver, curBalance - reserve);
                }
                unchecked {
                    ++i;
                }
            }
        } else _;
    }

    /// @dev Refunds any excess native asset sent to the contract after the main function
    modifier refundExcessNative(address payable _refundReceiver) {
        uint256 initialBalance = address(this).balance - msg.value;
        _;
        uint256 finalBalance = address(this).balance;
        uint256 excess = finalBalance > initialBalance ? finalBalance - initialBalance : 0;
        if (excess > 0) {
            LibAsset.transferAsset(LibAsset.NATIVE_ASSETID, _refundReceiver, excess);
        }
    }

    /// Internal Methods ///

    /// @dev Deposits value, executes swaps, and performs minimum amount check
    /// @param _transactionId the transaction id associated with the operation
    /// @param _minAmount the minimum amount of the final asset to receive
    /// @param _swaps Array of data used to execute swaps
    /// @param _leftoverReceiver The address to send leftover funds to
    function _depositAndSwap(
        bytes32 _transactionId,
        uint256 _minAmount,
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver
    ) internal returns (uint256) {
        if (_swaps.length == 0) revert NoSwapDataProvided();
        address finalTokenId = _swaps[_swaps.length - 1].receivingAssetId;
        uint256 sentNative = LibAsset.isNativeAsset(finalTokenId) ? msg.value : 0;
        uint256 initialBalance = LibAsset.getOwnBalance(finalTokenId) - sentNative;

        LibAsset.depositAssets(_swaps);
        _executeSwaps(_transactionId, _swaps, _leftoverReceiver);

        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId) - initialBalance;
        if (newBalance < _minAmount) revert CumulativeSlippageTooHigh(_minAmount, newBalance);
        return newBalance;
    }

    /// @dev Deposits value, executes swaps, and performs minimum amount check
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
        if (_swaps.length == 0) revert NoSwapDataProvided();
        address finalTokenId = _swaps[_swaps.length - 1].receivingAssetId;
        uint256 sentNative = LibAsset.isNativeAsset(finalTokenId) ? msg.value : 0;
        uint256 initialBalance = LibAsset.getOwnBalance(finalTokenId) - sentNative;

        LibAsset.depositAssets(_swaps);
        ReserveData memory rd = ReserveData(_transactionId, _leftoverReceiver, _nativeReserve);
        _executeSwaps(rd, _swaps);

        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId) - initialBalance;
        if (newBalance < _minAmount) revert CumulativeSlippageTooHigh(_minAmount, newBalance);
        return newBalance;
    }

    /// Private Methods ///

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swaps Array of data used to execute swaps
    /// @param _leftoverReceiver The address to send leftover funds to
    function _executeSwaps(
        bytes32 _transactionId,
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver
    ) internal noLeftovers(_swaps, _leftoverReceiver) {
        for (uint256 i = 0; i < _swaps.length; ) {
            LibSwap.SwapData calldata currentSwap = _swaps[i];
            if (
                !((LibAsset.isNativeAsset(currentSwap.sendingAssetId) ||
                    LibAllowList.contractIsAllowed(currentSwap.approveTo)) &&
                    LibAllowList.contractIsAllowed(currentSwap.callTo) &&
                    LibAllowList.selectorIsAllowed(bytes4(currentSwap.callData[:4])))
            ) revert ContractCallNotAllowed();
            LibSwap.swap(_transactionId, currentSwap);
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _reserveData Data passed used to reserve native tokens
    /// @param _swaps Array of data used to execute swaps
    function _executeSwaps(ReserveData memory _reserveData, LibSwap.SwapData[] calldata _swaps)
        internal
        noLeftoversReserve(_swaps, _reserveData.leftoverReceiver, _reserveData.nativeReserve)
    {
        for (uint256 i = 0; i < _swaps.length; ) {
            LibSwap.SwapData calldata currentSwap = _swaps[i];
            if (
                !((LibAsset.isNativeAsset(currentSwap.sendingAssetId) ||
                    LibAllowList.contractIsAllowed(currentSwap.approveTo)) &&
                    LibAllowList.contractIsAllowed(currentSwap.callTo) &&
                    LibAllowList.selectorIsAllowed(bytes4(currentSwap.callData[:4])))
            ) revert ContractCallNotAllowed();
            LibSwap.swap(_reserveData.transactionId, currentSwap);
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swaps Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(LibSwap.SwapData[] calldata _swaps) private view returns (uint256[] memory) {
        uint256 length = _swaps.length;
        uint256[] memory balances = new uint256[](length);
        for (uint256 i = 0; i < length; ) {
            balances[i] = LibAsset.getOwnBalance(_swaps[i].receivingAssetId);
            unchecked {
                ++i;
            }
        }
        return balances;
    }
}
