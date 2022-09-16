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
    modifier noLeftovers(LibSwap.Swap[] calldata _swaps, address payable _leftoverReceiver) {
        uint256 nSwaps = _swaps.length;
        if (nSwaps != 1) {
            uint256[] memory initialBalances = _fetchBalances(_swaps);
            address finalAsset = _swaps[nSwaps - 1].receivingAssetId;
            uint256 curBalance = 0;
            uint256 newBalance = 0;
            _;

            for (uint256 i = 0; i < nSwaps - 1; i++) {
                address curAsset = _swaps[i].receivingAssetId;
                if (curAsset == finalAsset) continue; // Handle multi-to-one swaps
                newBalance = LibAsset.getOwnBalance(curAsset);
                curBalance = newBalance > initialBalances[i] ? newBalance - initialBalances[i] : newBalance;
                if (curBalance > 0) LibAsset.transferAsset(curAsset, _leftoverReceiver, curBalance);
            }
        } else _;
    }

    /// Internal Methods ///

    /// @dev Validates input before executing swaps
    /// @param _lifiData LiFi tracking data
    /// @param _swapData Array of data used to execute swaps
    /// @param _leftoverReceiver The address to send leftover funds to
    function _executeAndCheckSwaps(
        LiFiData memory _lifiData,
        LibSwap.SwapData calldata _swapData,
        address payable _leftoverReceiver
    ) internal returns (uint256) {
        LibSwap.Swap[] calldata swaps = _swapData.swaps;
        uint256 nSwaps = swaps.length;
        if (nSwaps == 0) revert NoSwapDataProvided();
        address finalTokenId = swaps[swaps.length - 1].receivingAssetId;
        uint256 swapBalance = LibAsset.getOwnBalance(finalTokenId);
        _executeSwaps(_lifiData, swaps, _leftoverReceiver);
        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId);
        swapBalance = newBalance > swapBalance ? newBalance - swapBalance : newBalance;
        if (swapBalance < _swapData.minReturnAmount) revert CumulativeSlippageTooHigh();
        return swapBalance;
    }

    /// Private Methods ///

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _lifiData LiFi tracking data
    /// @param _swaps Array of data used to execute swaps
    function _executeSwaps(
        LiFiData memory _lifiData,
        LibSwap.Swap[] calldata _swaps,
        address payable _leftoverReceiver
    ) internal noLeftovers(_swaps, _leftoverReceiver) {
        for (uint256 i = 0; i < _swaps.length; i++) {
            LibSwap.Swap calldata currentSwap = _swaps[i];
            if (
                !((LibAsset.isNativeAsset(currentSwap.sendingAssetId) ||
                    LibAllowList.contractIsAllowed(currentSwap.approveTo)) &&
                    LibAllowList.contractIsAllowed(currentSwap.callTo) &&
                    LibAllowList.selectorIsAllowed(bytes4(currentSwap.callData[:4])))
            ) revert ContractCallNotAllowed();
            LibSwap.swap(_lifiData.transactionId, currentSwap);
        }
    }

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swaps Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(LibSwap.Swap[] calldata _swaps) private view returns (uint256[] memory) {
        uint256 length = _swaps.length;
        uint256[] memory balances = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            balances[i] = LibAsset.getOwnBalance(_swaps[i].receivingAssetId);
        }
        return balances;
    }
}
