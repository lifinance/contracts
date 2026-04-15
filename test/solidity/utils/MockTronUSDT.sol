// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title MockTronUSDT
/// @notice Test double for Tron mainnet USDT (TRC20): legacy `transfer` is
///         declared `returns (bool)` but on-chain bytecode can fall through
///         without `return true;`, so callers still see a successful state
///         change yet decode 32 zero bytes (`false`). This contract models that
///         by returning `false` after a successful debit/credit (same outcome
///         for libraries that require an empty return or ABI-true). `transferFrom`
///         and `approve` return `true` and match normal ERC20 expectations.
contract MockTronUSDT {
    error InsufficientBalance();
    error InsufficientAllowance();

    string public name = "Tether USD";
    string public symbol = "USDT";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    /// @notice Successful balance update, then returns `false` (see contract @notice).
    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        // Same observable as missing `return true;` on Tron USDT: strict `safeTransfer` fails.
        return false;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        if (allowance[from][msg.sender] < amount)
            revert InsufficientAllowance();
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}
