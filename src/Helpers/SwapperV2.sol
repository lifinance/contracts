// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { InvalidAmount, ContractCallNotAllowed, NoSwapDataProvided, CumulativeSlippageTooHigh } from "../Errors/GenericErrors.sol";

/// @title Swapper
/// @author LI.FI (https://li.fi)
/// @notice Abstract contract to provide swap functionality
contract SwapperV2 is ILiFi {
    /// Storage ///

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
            }
        } else _;
    }

    /// Internal Methods ///

    /// @dev Validates input before executing swaps
    /// @param _transactionId the transaction id associated with the operation
    /// @param _minAmount the minimum amount of the final asset to receive
    /// @param _swaps Array of data used to execute swaps
    /// @param _leftoverReceiver The address to send leftover funds to
    function _executeAndCheckSwaps(
        bytes32 _transactionId,
        uint256 _minAmount,
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver
    ) internal returns (uint256) {
        if (_swaps.length == 0) revert NoSwapDataProvided();
        address finalTokenId = _swaps[_swaps.length - 1].receivingAssetId;
        uint256 swapBalance = LibAsset.getOwnBalance(finalTokenId);
        _executeSwaps(_transactionId, _swaps, _leftoverReceiver);
        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId);
        swapBalance = newBalance > swapBalance ? newBalance - swapBalance : 0;
        if (swapBalance < _minAmount) revert CumulativeSlippageTooHigh();
        return swapBalance;
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
