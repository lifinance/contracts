// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

contract Cleanable {
    modifier noSwapsDust(LibSwap.SwapData[] calldata _swapData, address payable _leftoverReceiver) {
        uint256 nSwaps = _swapData.length;
        if (nSwaps != 1) {
            uint256[] memory initialBalances = _fetchBalances(_swapData);
            address finalAsset = _swapData[nSwaps - 1].receivingAssetId;
            uint256 curBalance = 0;
            uint256 newBalance = 0;
            _;

            for (uint256 i = 0; i < nSwaps - 1; ) {
                address curAsset = _swapData[i].receivingAssetId;
                if (curAsset != finalAsset) {
                    newBalance = LibAsset.getOwnBalance(curAsset);
                    curBalance = newBalance > initialBalances[i] ? newBalance - initialBalances[i] : newBalance;
                    if (curBalance > 0) LibAsset.transferAsset(curAsset, _leftoverReceiver, curBalance);
                }
                unchecked {
                    i++;
                }
            }
        } else _;
    }

    modifier noDepositsDust(LibAsset.Deposit[] calldata _deposits, address payable _leftoverReceiver) {
        uint256 nDeposits = _deposits.length;
        if (nDeposits != 0) {
            uint256[] memory initialBalances = _fetchBalances(_deposits);
            uint256 curBalance = 0;
            uint256 newBalance = 0;
            _;

            for (uint256 i = 0; i < nDeposits; ) {
                address curAsset = _deposits[i].assetId;
                newBalance = LibAsset.getOwnBalance(curAsset);
                curBalance = newBalance > initialBalances[i] ? newBalance - initialBalances[i] : newBalance;
                if (curBalance > 0) LibAsset.transferAsset(curAsset, _leftoverReceiver, curBalance);
                unchecked {
                    i++;
                }
            }
        } else _;
    }

    modifier noNativeDust(address payable _leftoverReceiver) {
        uint256 initialBalance = address(this).balance;
        _;
        uint256 newBalance = address(this).balance;
        uint256 excessBalance = newBalance > initialBalance ? newBalance - initialBalance : newBalance;
        if (excessBalance > 0) _leftoverReceiver.transfer(excessBalance);
    }

    /// Private Methods ///

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swapData Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(LibSwap.SwapData[] calldata _swapData) private view returns (uint256[] memory) {
        uint256 length = _swapData.length;
        uint256[] memory balances = new uint256[](length);
        for (uint256 i = 0; i < length; ) {
            balances[i] = LibAsset.getOwnBalance(_swapData[i].receivingAssetId);
            unchecked {
                i++;
            }
        }
        return balances;
    }

    /// @dev Fetches balances of tokens to be deposited before depositing.
    /// @param _deposits Array of data used to perform deposits
    /// @return uint256[] Array of token balances.
    function _fetchBalances(LibAsset.Deposit[] calldata _deposits) private view returns (uint256[] memory) {
        uint256 length = _deposits.length;
        uint256[] memory balances = new uint256[](length);
        for (uint256 i = 0; i < length; ) {
            balances[i] = LibAsset.getOwnBalance(_deposits[i].assetId);
            unchecked {
                i++;
            }
        }
        return balances;
    }
}
