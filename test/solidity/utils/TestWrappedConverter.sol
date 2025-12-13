// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test converter contract that implements WETH9 interface
/// @dev Simulates a converter that wraps/unwraps native ETH to/from an ERC20 token
contract TestWrappedConverter {
    IERC20 public immutable wrappedToken;

    error WithdrawError();
    error InsufficientBalance(uint256 available, uint256 required);

    constructor(address _wrappedToken) {
        wrappedToken = IERC20(_wrappedToken);
    }

    /// @notice Accepts ETH and sends wrapped tokens to the caller
    function deposit() public payable {
        // Transfer wrapped tokens to caller equal to msg.value
        require(
            wrappedToken.transfer(msg.sender, msg.value),
            "Transfer failed"
        );
    }

    /// @notice Pulls wrapped tokens from caller and sends ETH back
    function withdraw(uint256 wad) public {
        // Pull wrapped tokens from caller
        require(
            wrappedToken.transferFrom(msg.sender, address(this), wad),
            "TransferFrom failed"
        );

        // Send ETH to caller
        (bool success, ) = payable(msg.sender).call{ value: wad }("");
        if (!success) {
            revert WithdrawError();
        }
    }

    // Needs to receive ETH for testing
    receive() external payable {}
}
