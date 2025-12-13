// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test converter that simulates decimal conversion (like GasUSDT0Converter)
/// @dev Converts 18 decimal native token to 6 decimal wrapped token (1e12 conversion)
contract TestConverterWithDecimals {
    IERC20 public immutable wrappedToken;

    error WithdrawError();
    error InvalidAmount();

    constructor(address _wrappedToken) {
        wrappedToken = IERC20(_wrappedToken);
    }

    function convertToWrapped(uint256 amount) internal pure returns (uint256) {
        return amount / 1e12;
    }

    function convertToNative(uint256 amount) internal pure returns (uint256) {
        return amount * 1e12;
    }

    /// @notice Accepts native token and sends wrapped tokens to caller
    /// @dev Simulates 1e18 -> 1e6 conversion
    function deposit() public payable {
        require(msg.value % 1e12 == 0, "Invalid amount");
        uint256 amountOut = convertToWrapped(msg.value);
        require(
            wrappedToken.transfer(msg.sender, amountOut),
            "Transfer failed"
        );
    }

    /// @notice Pulls wrapped tokens from caller and sends native tokens back
    /// @dev Simulates 1e6 -> 1e18 conversion
    function withdraw(uint256 amount) public {
        // Pull wrapped tokens from caller
        require(
            wrappedToken.transferFrom(msg.sender, address(this), amount),
            "TransferFrom failed"
        );

        // Send native tokens to caller (with decimal conversion)
        uint256 amountOut = convertToNative(amount);
        (bool success, ) = payable(msg.sender).call{ value: amountOut }("");
        if (!success) {
            revert WithdrawError();
        }
    }

    // Needs to receive ETH for testing
    receive() external payable {}
}
