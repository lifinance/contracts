// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { UnAuthorized } from "lifi/Errors/GenericErrors.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IERC20Proxy } from "../Interfaces/IERC20Proxy.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import { ERC721Holder } from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Executor
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing
/// @custom:version 2.0.0
contract Executor is ILiFi, ReentrancyGuard, ERC1155Holder, ERC721Holder {
    /// Storage ///

    /// @notice The address of the ERC20Proxy contract
    IERC20Proxy public erc20Proxy;

    /// Events ///
    event ERC20ProxySet(address indexed proxy);

    /// Modifiers ///

    /// @dev Sends any leftover balances back to the user
    modifier noLeftovers(
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver
    ) {
        uint256 numSwaps = _swaps.length;
        if (numSwaps != 1) {
            uint256[] memory initialBalances = _fetchBalances(_swaps);
            address finalAsset = _swaps[numSwaps - 1].receivingAssetId;
            uint256 curBalance = 0;

            _;

            for (uint256 i = 0; i < numSwaps - 1; ) {
                address curAsset = _swaps[i].receivingAssetId;
                // Handle multi-to-one swaps
                if (curAsset != finalAsset) {
                    curBalance = LibAsset.getOwnBalance(curAsset);
                    if (curBalance > initialBalances[i]) {
                        LibAsset.transferAsset(
                            curAsset,
                            _leftoverReceiver,
                            curBalance - initialBalances[i]
                        );
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

    /// Constructor
    /// @notice Initialize local variables for the Executor
    /// @param _erc20Proxy The address of the ERC20Proxy contract
    constructor(address _erc20Proxy) {
        erc20Proxy = IERC20Proxy(_erc20Proxy);
        emit ERC20ProxySet(_erc20Proxy);
    }

    /// External Methods ///

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _transactionId the transaction id for the swap
    /// @param _swapData array of data needed for swaps
    /// @param _transferredAssetId token received from the other chain
    /// @param _receiver address that will receive tokens in the end
    function swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] calldata _swapData,
        address _transferredAssetId,
        address payable _receiver
    ) external payable nonReentrant {
        _processSwaps(
            _transactionId,
            _swapData,
            _transferredAssetId,
            _receiver,
            0,
            true
        );
    }

    /// @notice Performs a series of swaps or arbitrary executions
    /// @param _transactionId the transaction id for the swap
    /// @param _swapData array of data needed for swaps
    /// @param _transferredAssetId token received from the other chain
    /// @param _receiver address that will receive tokens in the end
    /// @param _amount amount of token for swaps or arbitrary executions
    function swapAndExecute(
        bytes32 _transactionId,
        LibSwap.SwapData[] calldata _swapData,
        address _transferredAssetId,
        address payable _receiver,
        uint256 _amount
    ) external payable nonReentrant {
        _processSwaps(
            _transactionId,
            _swapData,
            _transferredAssetId,
            _receiver,
            _amount,
            false
        );
    }

    /// Private Methods ///

    /// @notice Performs a series of swaps or arbitrary executions
    /// @param _transactionId the transaction id for the swap
    /// @param _swapData array of data needed for swaps
    /// @param _transferredAssetId token received from the other chain
    /// @param _receiver address that will receive tokens in the end
    /// @param _amount amount of token for swaps or arbitrary executions
    /// @param _depositAllowance If deposit approved amount of token
    function _processSwaps(
        bytes32 _transactionId,
        LibSwap.SwapData[] calldata _swapData,
        address _transferredAssetId,
        address payable _receiver,
        uint256 _amount,
        bool _depositAllowance
    ) private {
        uint256 startingBalance;
        uint256 finalAssetStartingBalance;
        address finalAssetId = _swapData[_swapData.length - 1]
            .receivingAssetId;
        if (!LibAsset.isNativeAsset(finalAssetId)) {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId);
        } else {
            finalAssetStartingBalance =
                LibAsset.getOwnBalance(finalAssetId) -
                msg.value;
        }

        if (!LibAsset.isNativeAsset(_transferredAssetId)) {
            startingBalance = LibAsset.getOwnBalance(_transferredAssetId);
            if (_depositAllowance) {
                uint256 allowance = IERC20(_transferredAssetId).allowance(
                    msg.sender,
                    address(this)
                );
                LibAsset.depositAsset(_transferredAssetId, allowance);
            } else {
                erc20Proxy.transferFrom(
                    _transferredAssetId,
                    msg.sender,
                    address(this),
                    _amount
                );
            }
        } else {
            startingBalance =
                LibAsset.getOwnBalance(_transferredAssetId) -
                msg.value;
        }

        _executeSwaps(_transactionId, _swapData, _receiver);

        uint256 postSwapBalance = LibAsset.getOwnBalance(_transferredAssetId);
        if (postSwapBalance > startingBalance) {
            LibAsset.transferAsset(
                _transferredAssetId,
                _receiver,
                postSwapBalance - startingBalance
            );
        }

        uint256 finalAssetPostSwapBalance = LibAsset.getOwnBalance(
            finalAssetId
        );

        if (finalAssetPostSwapBalance > finalAssetStartingBalance) {
            LibAsset.transferAsset(
                finalAssetId,
                _receiver,
                finalAssetPostSwapBalance - finalAssetStartingBalance
            );
        }

        emit LiFiTransferCompleted(
            _transactionId,
            _transferredAssetId,
            _receiver,
            finalAssetPostSwapBalance,
            block.timestamp
        );
    }

    /// @dev Executes swaps one after the other
    /// @param _transactionId the transaction id for the swap
    /// @param _swapData Array of data used to execute swaps
    /// @param _leftoverReceiver Address to receive lefover tokens
    function _executeSwaps(
        bytes32 _transactionId,
        LibSwap.SwapData[] calldata _swapData,
        address payable _leftoverReceiver
    ) private noLeftovers(_swapData, _leftoverReceiver) {
        uint256 numSwaps = _swapData.length;
        for (uint256 i = 0; i < numSwaps; ) {
            if (_swapData[i].callTo == address(erc20Proxy)) {
                revert UnAuthorized(); // Prevent calling ERC20 Proxy directly
            }

            LibSwap.SwapData calldata currentSwapData = _swapData[i];
            LibSwap.swap(_transactionId, currentSwapData);
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swapData Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(
        LibSwap.SwapData[] calldata _swapData
    ) private view returns (uint256[] memory) {
        uint256 numSwaps = _swapData.length;
        uint256[] memory balances = new uint256[](numSwaps);
        address asset;
        for (uint256 i = 0; i < numSwaps; ) {
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

    /// @dev required for receiving native assets from destination swaps
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
