// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibStorage } from "../Libraries/LibStorage.sol";
import { InvalidAmount, ContractCallNotAllowed, NoSwapDataProvided } from "../Errors/GenericErrors.sol";

/// @title Swapper
/// @author LI.FI (https://li.fi)
/// @notice Abstract contract to provide swap functionality
contract SwapperV2 is ILiFi {
    /// Storage ///

    LibStorage internal appStorage;

    /// Modifiers ///

    /// @dev Sends any leftover balances back to the user
    modifier noLeftovers(LibSwap.SwapData[] calldata _swapData, address payable _receiver) {
        uint256 nSwaps = _swapData.length;
        if (nSwaps != 1) {
            uint256[] memory initialBalances = _fetchBalances(_swapData);
            address finalAsset = _swapData[nSwaps - 1].receivingAssetId;
            uint256 curBalance = 0;
            uint256 newBalance = 0;
            _;

            for (uint256 i = 0; i < nSwaps - 1; i++) {
                address curAsset = _swapData[i].receivingAssetId;
                if (curAsset == finalAsset) continue; // Handle multi-to-one swaps
                newBalance = LibAsset.getOwnBalance(curAsset);
                curBalance = newBalance > initialBalances[i] ? newBalance - initialBalances[i] : newBalance;
                if (curBalance > 0) LibAsset.transferAsset(curAsset, _receiver, curBalance);
            }
        } else _;
    }

    /// Internal Methods ///

    /// @dev Validates input before executing swaps
    /// @param _lifiData LiFi tracking data
    /// @param _swapData Array of data used to execute swaps
    /// @param _receiver The address to send leftover funds to
    function _executeAndCheckSwaps(
        LiFiData memory _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address payable _receiver
    ) internal returns (uint256) {
        uint256 nSwaps = _swapData.length;
        if (nSwaps == 0) revert NoSwapDataProvided();
        address finalTokenId = _swapData[_swapData.length - 1].receivingAssetId;
        uint256 swapBalance = LibAsset.getOwnBalance(finalTokenId);
        _executeSwaps(_lifiData, _swapData, _receiver);
        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId);
        swapBalance = newBalance > swapBalance ? newBalance - swapBalance : newBalance;
        if (swapBalance == 0) revert InvalidAmount();
        return swapBalance;
    }

    /// Private Methods ///

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _lifiData LiFi tracking data
    /// @param _swapData Array of data used to execute swaps
    function _executeSwaps(
        LiFiData memory _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address payable _receiver
    ) internal noLeftovers(_swapData, _receiver) {
        for (uint256 i = 0; i < _swapData.length; i++) {
            LibSwap.SwapData calldata currentSwapData = _swapData[i];
            if (
                !(appStorage.dexAllowlist[currentSwapData.approveTo] &&
                    appStorage.dexAllowlist[currentSwapData.callTo] &&
                    appStorage.dexFuncSignatureAllowList[bytes4(currentSwapData.callData[:4])])
            ) revert ContractCallNotAllowed();
            LibSwap.swap(_lifiData.transactionId, currentSwapData);
        }
    }

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swapData Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(LibSwap.SwapData[] calldata _swapData) private view returns (uint256[] memory) {
        uint256 length = _swapData.length;
        uint256[] memory balances = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            balances[i] = LibAsset.getOwnBalance(_swapData[i].receivingAssetId);
        }
        return balances;
    }
}
