// SPDX-License-Identifier: MIT
/// @custom:version 1.0.1
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { ContractCallNotAllowed, NoSwapDataProvided, CumulativeSlippageTooHigh } from "../Errors/GenericErrors.sol";

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
    /// @notice Sends any leftover balances to the user
    /// @param _swaps Swap data array
    /// @param _leftoverReceiver Address to send leftover tokens to
    /// @param _initialBalances Array of initial token balances
    modifier noLeftovers(
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256[] memory _initialBalances
    ) {
        uint256 numSwaps = _swaps.length;

        _;

        if (numSwaps != 1) {
            address finalAsset = _swaps[numSwaps - 1].receivingAssetId;
            uint256 curBalance;

            for (uint256 i = 0; i < numSwaps - 1; ) {
                address curAsset = _swaps[i].receivingAssetId;
                // Handle multi-to-one swaps
                if (curAsset != finalAsset) {
                    curBalance =
                        LibAsset.getOwnBalance(curAsset) -
                        _initialBalances[i];
                    if (curBalance > 0) {
                        LibAsset.transferAsset(
                            curAsset,
                            _leftoverReceiver,
                            curBalance
                        );
                    }
                }
                unchecked {
                    ++i;
                }
            }
        }

        // Handle leftover input tokens
        for (uint256 i = 0; i < numSwaps; ) {
            address inputAsset = _swaps[i].sendingAssetId;
            uint256 currentInputBalance = LibAsset.getOwnBalance(inputAsset);

            // Only transfer leftovers if there's actually a balance remaining
            if (currentInputBalance > 0) {
                LibAsset.transferAsset(
                    inputAsset,
                    _leftoverReceiver,
                    currentInputBalance
                );
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Sends any leftover balances back to the user reserving native tokens
    /// @notice Sends any leftover balances to the user
    /// @param _swaps Swap data array
    /// @param _leftoverReceiver Address to send leftover tokens to
    /// @param _initialBalances Array of initial token balances
    modifier noLeftoversReserve(
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256[] memory _initialBalances,
        uint256 _nativeReserve
    ) {
        uint256 numSwaps = _swaps.length;

        _;

        if (numSwaps != 1) {
            address finalAsset = _swaps[numSwaps - 1].receivingAssetId;
            uint256 curBalance;

            for (uint256 i = 0; i < numSwaps - 1; ) {
                address curAsset = _swaps[i].receivingAssetId;
                // Handle multi-to-one swaps
                if (curAsset != finalAsset) {
                    curBalance =
                        LibAsset.getOwnBalance(curAsset) -
                        _initialBalances[i];
                    uint256 reserve = LibAsset.isNativeAsset(curAsset)
                        ? _nativeReserve
                        : 0;
                    if (curBalance > reserve) {
                        LibAsset.transferAsset(
                            curAsset,
                            _leftoverReceiver,
                            curBalance - reserve
                        );
                    }
                }
                unchecked {
                    ++i;
                }
            }
        }

        // Handle leftover input tokens (minus reserve)
        for (uint256 i = 0; i < numSwaps; ) {
            address inputAsset = _swaps[i].sendingAssetId;
            uint256 currentInputBalance = LibAsset.getOwnBalance(inputAsset);
            uint256 reserve = LibAsset.isNativeAsset(inputAsset)
                ? _nativeReserve
                : 0;

            // Only transfer leftovers if there's actually a balance remaining after reserve
            if (currentInputBalance > reserve) {
                LibAsset.transferAsset(
                    inputAsset,
                    _leftoverReceiver,
                    currentInputBalance - reserve
                );
            }
            unchecked {
                ++i;
            }
        }
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
                LibAsset.NATIVE_ASSETID,
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

        // Execute swaps without the noLeftovers modifier
        _executeSwapsOnly(_transactionId, _swaps);

        // Calculate balance before leftover handling
        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId) -
            initialBalance;

        if (newBalance < _minAmount) {
            revert CumulativeSlippageTooHigh(_minAmount, newBalance);
        }

        // Handle leftovers after balance check
        _handleLeftovers(_swaps, _leftoverReceiver, initialBalances);

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

        // Execute swaps without the noLeftoversReserve modifier
        _executeSwapsOnly(_transactionId, _swaps);

        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId) -
            initialBalance;

        if (LibAsset.isNativeAsset(finalTokenId)) {
            newBalance -= _nativeReserve;
        }

        if (newBalance < _minAmount) {
            revert CumulativeSlippageTooHigh(_minAmount, newBalance);
        }

        // Handle leftovers with reserve after balance check
        _handleLeftoversReserve(
            _swaps,
            _leftoverReceiver,
            initialBalances,
            _nativeReserve
        );

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
        for (uint256 i = 0; i < numSwaps; ) {
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

            unchecked {
                ++i;
            }
        }
    }

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _reserveData Data passed used to reserve native tokens
    /// @param _swaps Array of data used to execute swaps
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
        for (uint256 i = 0; i < numSwaps; ) {
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

            unchecked {
                ++i;
            }
        }
    }

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swaps Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(
        LibSwap.SwapData[] calldata _swaps
    ) private view returns (uint256[] memory) {
        uint256 numSwaps = _swaps.length;
        uint256[] memory balances = new uint256[](numSwaps);
        address asset;
        for (uint256 i = 0; i < numSwaps; ) {
            asset = _swaps[i].receivingAssetId;
            balances[i] = LibAsset.getOwnBalance(asset);

            if (LibAsset.isNativeAsset(asset)) {
                balances[i] -= msg.value;
            }

            unchecked {
                ++i;
            }
        }

        return balances;
    }

    /// @dev Executes swaps only without leftover handling
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swaps Array of data used to execute swaps
    function _executeSwapsOnly(
        bytes32 _transactionId,
        LibSwap.SwapData[] calldata _swaps
    ) private {
        uint256 numSwaps = _swaps.length;
        for (uint256 i = 0; i < numSwaps; ) {
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

            unchecked {
                ++i;
            }
        }
    }

    /// @dev Handles leftover tokens after swaps complete
    /// @param _swaps Swap data array
    /// @param _leftoverReceiver Address to send leftover tokens to
    /// @param _initialBalances Array of initial token balances
    function _handleLeftovers(
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256[] memory _initialBalances
    ) private {
        uint256 numSwaps = _swaps.length;
        address finalAsset = _swaps[numSwaps - 1].receivingAssetId;

        if (numSwaps != 1) {
            uint256 curBalance;

            for (uint256 i = 0; i < numSwaps - 1; ) {
                address curAsset = _swaps[i].receivingAssetId;
                // Handle multi-to-one swaps
                if (curAsset != finalAsset) {
                    curBalance =
                        LibAsset.getOwnBalance(curAsset) -
                        _initialBalances[i];
                    if (curBalance > 0) {
                        LibAsset.transferAsset(
                            curAsset,
                            _leftoverReceiver,
                            curBalance
                        );
                    }
                }
                unchecked {
                    ++i;
                }
            }
        }

        // Handle leftover input tokens (but not the final receiving token)
        for (uint256 i = 0; i < numSwaps; ) {
            address inputAsset = _swaps[i].sendingAssetId;
            uint256 currentInputBalance = LibAsset.getOwnBalance(inputAsset);

            // Only transfer leftovers if there's actually a balance remaining
            // and if it's not the final receiving asset (which should be kept for bridging)
            if (currentInputBalance > 0 && inputAsset != finalAsset) {
                LibAsset.transferAsset(
                    inputAsset,
                    _leftoverReceiver,
                    currentInputBalance
                );
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Handles leftover tokens after swaps complete with native reserve
    /// @param _swaps Swap data array
    /// @param _leftoverReceiver Address to send leftover tokens to
    /// @param _initialBalances Array of initial token balances
    /// @param _nativeReserve Amount of native token to prevent from being swept
    function _handleLeftoversReserve(
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver,
        uint256[] memory _initialBalances,
        uint256 _nativeReserve
    ) private {
        uint256 numSwaps = _swaps.length;
        address finalAsset = _swaps[numSwaps - 1].receivingAssetId;

        if (numSwaps != 1) {
            uint256 curBalance;

            for (uint256 i = 0; i < numSwaps - 1; ) {
                address curAsset = _swaps[i].receivingAssetId;
                // Handle multi-to-one swaps
                if (curAsset != finalAsset) {
                    curBalance =
                        LibAsset.getOwnBalance(curAsset) -
                        _initialBalances[i];
                    uint256 reserve = LibAsset.isNativeAsset(curAsset)
                        ? _nativeReserve
                        : 0;
                    if (curBalance > reserve) {
                        LibAsset.transferAsset(
                            curAsset,
                            _leftoverReceiver,
                            curBalance - reserve
                        );
                    }
                }
                unchecked {
                    ++i;
                }
            }
        }

        // Handle leftover input tokens (minus reserve, but not the final receiving token)
        for (uint256 i = 0; i < numSwaps; ) {
            address inputAsset = _swaps[i].sendingAssetId;
            uint256 currentInputBalance = LibAsset.getOwnBalance(inputAsset);
            uint256 reserve = LibAsset.isNativeAsset(inputAsset)
                ? _nativeReserve
                : 0;

            // Only transfer leftovers if there's actually a balance remaining after reserve
            // and if it's not the final receiving asset (which should be kept for bridging)
            if (currentInputBalance > reserve && inputAsset != finalAsset) {
                LibAsset.transferAsset(
                    inputAsset,
                    _leftoverReceiver,
                    currentInputBalance - reserve
                );
            }
            unchecked {
                ++i;
            }
        }
    }
}
