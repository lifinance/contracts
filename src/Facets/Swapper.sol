// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibStorage } from "../Libraries/LibStorage.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

contract Swapper is ILiFi {
    /// Storage ///

    LibStorage internal ls;

    function _executeAndCheckSwaps(LiFiData calldata _lifiData, LibSwap.SwapData[] calldata _swapData)
        internal
        returns (uint256)
    {
        address finalTokenId = _swapData[_swapData.length - 1].receivingAssetId;
        uint256 swapBalance = LibAsset.getOwnBalance(finalTokenId);
        _executeSwaps(_lifiData, _swapData);
        swapBalance = LibAsset.getOwnBalance(finalTokenId) - swapBalance;
        require(swapBalance != 0, "ERR_INVALID_AMOUNT");
        return swapBalance;
    }

    /// Private Methods ///

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _lifiData LiFi tracking data
    /// @param _swapData Array of data used to execute swaps
    function _executeSwaps(LiFiData memory _lifiData, LibSwap.SwapData[] calldata _swapData) internal {
        uint256 length = _swapData.length;
        uint256[] memory preBalances;

        if (length > 1) preBalances = _fetchBalances(_swapData); // No need for cleanup if just one swap

        // Swap
        for (uint256 i = 0; i < length; i++) {
            require(
                ls.dexAllowlist[_swapData[i].approveTo] && ls.dexAllowlist[_swapData[i].callTo],
                "Contract call not allowed!"
            );

            LibSwap.swap(_lifiData.transactionId, _swapData[i]);
        }

        if (length > 1) _cleanUp(_swapData, preBalances); // No need for cleanup if just one swap
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

    /// @dev Sends any leftover balances back to the user
    /// @param _swapData Array of data used to execute swaps
    function _cleanUp(LibSwap.SwapData[] calldata _swapData, uint256[] memory _preBalances) private {
        uint256 length = _swapData.length - 1; // The last token will be bridged or sent back to the user
        address finalAsset = _swapData[length].receivingAssetId;
        uint256 curBalance = 0;
        for (uint256 i = 0; i < length; i++) {
            address curAsset = _swapData[i].receivingAssetId;
            if (curAsset == finalAsset) continue; // Handle multi-to-one swaps
            curBalance = LibAsset.getOwnBalance(curAsset) - _preBalances[i];
            if (curBalance > 0) {
                LibAsset.transferAsset(curAsset, payable(msg.sender), curBalance);
            }
        }
    }
}
