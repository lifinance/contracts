// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { InvalidAmount, ContractCallNotAllowed, NoSwapDataProvided } from "../Errors/GenericErrors.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Cleanable } from "../Helpers/Cleanable.sol";

/// @title Swapper
/// @author LI.FI (https://li.fi)
/// @notice Abstract contract to provide swap functionality
contract SwapperV2 is ILiFi, Cleanable {
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
        if (nSwaps == 0) revert NoSwapDataProvided();
        address finalTokenId = _swapData[_swapData.length - 1].receivingAssetId;
        uint256 swapBalance = LibAsset.getOwnBalance(finalTokenId);
        _executeSwaps(_lifiData, _swapData, _leftoverReceiver);
        uint256 newBalance = LibAsset.getOwnBalance(finalTokenId);
        swapBalance = newBalance > swapBalance ? newBalance - swapBalance : newBalance;
        if (swapBalance == 0) revert InvalidAmount();
        return swapBalance;
    }

    /// @dev Executes swaps and checks that DEXs used are in the allowList
    /// @param _lifiData LiFi tracking data
    /// @param _swapData Array of data used to execute swaps
    function _executeSwaps(
        LiFiData memory _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address payable _leftoverReceiver
    ) internal noSwapsDust(_swapData, _leftoverReceiver) {
        for (uint256 i = 0; i < _swapData.length; i++) {
            LibSwap.SwapData calldata currentSwapData = _swapData[i];
            if (
                !((LibAsset.isNativeAsset(currentSwapData.sendingAssetId) ||
                    LibAllowList.contractIsAllowed(currentSwapData.approveTo)) &&
                    LibAllowList.contractIsAllowed(currentSwapData.callTo) &&
                    LibAllowList.selectorIsAllowed(bytes4(currentSwapData.callData[:4])))
            ) revert ContractCallNotAllowed();
            LibSwap.swap(_lifiData.transactionId, currentSwapData);
        }
    }
}
