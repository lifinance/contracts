// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test converter contract that implements WETH9 interface
/// @dev Simulates a converter that wraps/unwraps native ETH to/from an ERC20 token
contract TestWrappedConverter {
    IERC20 public immutable WRAPPED_TOKEN;

    error WithdrawError();
    error InsufficientBalance(uint256 available, uint256 required);
    error TransferFailed();
    error TransferFromFailed();

    constructor(address _wrappedToken) {
        WRAPPED_TOKEN = IERC20(_wrappedToken);
    }

    /// @notice Accepts ETH and sends wrapped tokens to the caller
    function deposit() public payable {
        // Transfer wrapped tokens to caller equal to msg.value
        if (!WRAPPED_TOKEN.transfer(msg.sender, msg.value))
            revert TransferFailed();
    }

    /// @notice Pulls wrapped tokens from caller and sends ETH back
    function withdraw(uint256 wad) public {
        // Pull wrapped tokens from caller
        if (!WRAPPED_TOKEN.transferFrom(msg.sender, address(this), wad))
            revert TransferFromFailed();

        // Send ETH to caller
        (bool success, ) = payable(msg.sender).call{ value: wad }("");
        if (!success) {
            revert WithdrawError();
        }
    }

    // Needs to receive ETH for testing
    receive() external payable {}
}
