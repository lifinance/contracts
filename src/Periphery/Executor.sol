// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20 } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IERC20Proxy } from "../Interfaces/IERC20Proxy.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

import { DSTest } from "ds-test/test.sol";      //TODO: remove


/// @title Executor
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing
contract Executor is DSTest, ILiFi, ReentrancyGuard, TransferrableOwnership {
    /// Storage ///

    /// @notice The address of the ERC20Proxy contract
    IERC20Proxy public erc20Proxy;

    /// Errors ///
    error ExecutionFailed();
    error InvalidCaller();

    /// Events ///
    event ERC20ProxySet(address indexed proxy);

    /// Modifiers ///

    /// @dev Sends any leftover balances back to the user
    modifier noLeftovers(LibSwap.SwapData[] calldata _swaps, address payable _leftoverReceiver) {
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
                        LibAsset.transferAsset(curAsset, _leftoverReceiver, curBalance - initialBalances[i]);
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
    /// @param _owner The address of owner
    /// @param _erc20Proxy The address of the ERC20Proxy contract
    constructor(address _owner, address _erc20Proxy) TransferrableOwnership(_owner) {
        owner = _owner;
        erc20Proxy = IERC20Proxy(_erc20Proxy);

        emit ERC20ProxySet(_erc20Proxy);
    }

    /// External Methods ///

    /// @notice set ERC20 Proxy
    /// @param _erc20Proxy The address of the ERC20Proxy contract
    function setERC20Proxy(address _erc20Proxy) external onlyOwner {
        erc20Proxy = IERC20Proxy(_erc20Proxy);
        emit ERC20ProxySet(_erc20Proxy);
    }

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
        _processSwaps(_transactionId, _swapData, _transferredAssetId, _receiver, 0, true);
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
        _processSwaps(_transactionId, _swapData, _transferredAssetId, _receiver, _amount, false);
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
        address finalAssetId = _swapData[_swapData.length - 1].receivingAssetId;

        emit log_string("in _processSwaps");
        emit log_uint(11);
        if (!LibAsset.isNativeAsset(finalAssetId)) {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId);
        } else {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId) - msg.value;
        }

        emit log_uint(12);
        emit log_named_uint("IERC20(_transferredAssetId).allowance(msg.sender, address(this)", IERC20(_transferredAssetId).allowance(msg.sender, address(this)));
        if (!LibAsset.isNativeAsset(_transferredAssetId)) {
            startingBalance = LibAsset.getOwnBalance(_transferredAssetId);
            if (_depositAllowance) {
                uint256 allowance = IERC20(_transferredAssetId).allowance(msg.sender, address(this));
                LibAsset.depositAsset(_transferredAssetId, allowance);
            } else {
                erc20Proxy.transferFrom(_transferredAssetId, msg.sender, address(this), _amount);
            }
        } else {
            startingBalance = LibAsset.getOwnBalance(_transferredAssetId) - msg.value;
        }

        emit log_named_uint("IERC20(_transferredAssetId).allowance(msg.sender, address(this)", IERC20(_transferredAssetId).allowance(msg.sender, address(this)));


        emit log_named_uint("balanceDaiExecutor", IERC20(_transferredAssetId).balanceOf(address(this)));
        emit log_named_uint("balanceUSDCExecutor", IERC20(finalAssetId).balanceOf(address(this)));
        emit log_named_uint("startingBalance", startingBalance);    // should be the same?
        emit log_named_uint("balanceUSDCExecutor33", IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48).balanceOf(address(this)));

        emit log_string("\n\n now executing swaps");
        _executeSwaps(_transactionId, _swapData, _receiver);
        emit log_uint(14);

        emit log_named_uint("balanceUSDCExecutor34", IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48).balanceOf(address(this)));
        emit log_named_uint("balanceDaiExecutor", IERC20(_transferredAssetId).balanceOf(address(this)));
        emit log_named_uint("balanceUSDCExecutor", IERC20(finalAssetId).balanceOf(address(this)));

        

        uint256 postSwapBalance = LibAsset.getOwnBalance(_transferredAssetId);
        if (postSwapBalance > startingBalance) {
            emit log_string("in postSwapBalance");
            LibAsset.transferAsset(_transferredAssetId, _receiver, postSwapBalance - startingBalance);
        }
        emit log_named_uint("balanceUSDCExecutor35", IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48).balanceOf(address(this)));


        emit log_uint(15);
        uint256 finalAssetPostSwapBalance = LibAsset.getOwnBalance(finalAssetId);

        if (finalAssetPostSwapBalance > finalAssetStartingBalance) {
            emit log_string("in finalAssetPostSwapBalance");
            LibAsset.transferAsset(finalAssetId, _receiver, finalAssetPostSwapBalance - finalAssetStartingBalance);
        }
        emit log_named_uint("finalAssetStartingBalance", finalAssetStartingBalance);
        emit log_named_uint("finalAssetPostSwapBalance", finalAssetPostSwapBalance);
        emit log_named_uint("balanceUSDCExecutor36", IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48).balanceOf(address(this)));

        emit log_uint(16);

        emit log_named_uint("balanceUSDCExecutor", IERC20(finalAssetId).balanceOf(address(this)));


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
        emit log_uint(22);
        for (uint256 i = 0; i < numSwaps; ) {
            if (_swapData[i].callTo == address(erc20Proxy)) {
                emit log_uint(2222);
                revert UnAuthorized(); // Prevent calling ERC20 Proxy directly
            }

            emit log_uint(23);
            LibSwap.SwapData calldata currentSwapData = _swapData[i];
            LibSwap.swap(_transactionId, currentSwapData);
            unchecked {
                ++i;
            }
            emit log_uint(i);
        }
    }

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swapData Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(LibSwap.SwapData[] calldata _swapData) private view returns (uint256[] memory) {
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
}
