// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { InvalidAmount, ContractCallNotAllowed, NoSwapDataProvided } from "../Errors/GenericErrors.sol";

/// @title Swapper
/// @author LI.FI (https://li.fi)
/// @notice Abstract contract to provide swap functionality
contract SwapperV2 is ILiFi {
    /// Storage ///

    /// Modifiers ///

    /// @dev Sends any leftover balances back to the user
    modifier noLeftovers(LibSwap.SwapData[] calldata _swapData, address payable _leftoverReceiver) {
        uint256 nSwaps = _swapData.length;
        if (nSwaps != 1) {
            uint256[] memory initialBalances = _fetchBalances(_swapData);
            address finalAsset = _swapData[nSwaps - 1].receivingAssetId;
            uint256 curBalance = 0;
            _;

            for (uint256 i = 0; i < nSwaps - 1; ) {
                address curAsset = _swapData[i].receivingAssetId;
                // Handle multi-to-one swaps
                if (curAsset != finalAsset) {
                    curBalance = LibAsset.getOwnBalance(curAsset) - initialBalances[i];
                    if (curBalance > 0) {
                        LibAsset.transferAsset(curAsset, _leftoverReceiver, curBalance);
                    }
                }
                unchecked {
                    ++i;
                }
            }
        } else {
            _;
        }
    }

    /// Internal Methods ///

    /// @dev Validates input before executing swaps
    /// @param _lifiData LiFi tracking data
    /// @param _swapData Array of data used to execute swaps
    /// @param _leftoverReceiver The address to send leftover funds to
    function _executeAndCheckSwaps(
        LiFiData memory _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address payable _leftoverReceiver
    ) internal returns (uint256) {
        uint256 nSwaps = _swapData.length;

        if (nSwaps == 0) {
            revert NoSwapDataProvided();
        }

        address finalTokenId = _swapData[nSwaps - 1].receivingAssetId;
        uint256 swapBalance = LibAsset.getOwnBalance(finalTokenId);

        if (LibAsset.isNativeAsset(finalTokenId)) {
            swapBalance -= msg.value;
        }

        _executeSwaps(_lifiData, _swapData, _leftoverReceiver);

        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId);
        swapBalance = newBalance > swapBalance ? newBalance - swapBalance : 0;

        if (swapBalance == 0) {
            revert InvalidAmount();
        }

        return swapBalance;
    }

    /// Private Methods ///

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _lifiData LiFi tracking data
    /// @param _swapData Array of data used to execute swaps
    function _executeSwaps(
        LiFiData memory _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address payable _leftoverReceiver
    ) internal noLeftovers(_swapData, _leftoverReceiver) {
        uint256 nSwaps = _swapData.length;
        LibSwap.SwapData calldata currentSwapData;
        for (uint256 i = 0; i < nSwaps; ) {
            currentSwapData = _swapData[i];

            if (
                !((LibAsset.isNativeAsset(currentSwapData.sendingAssetId) ||
                    LibAllowList.contractIsAllowed(currentSwapData.approveTo)) &&
                    LibAllowList.contractIsAllowed(currentSwapData.callTo) &&
                    LibAllowList.selectorIsAllowed(bytes4(currentSwapData.callData[:4])))
            ) {
                revert ContractCallNotAllowed();
            }

            LibSwap.swap(_lifiData.transactionId, currentSwapData);

            unchecked {
                ++i;
            }
        }
    }

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swapData Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(LibSwap.SwapData[] calldata _swapData) private view returns (uint256[] memory) {
        uint256 nSwaps = _swapData.length;
        uint256[] memory balances = new uint256[](nSwaps);
        address asset;
        for (uint256 i = 0; i < nSwaps; ) {
            asset = _swapData[i].receivingAssetId;
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
}
