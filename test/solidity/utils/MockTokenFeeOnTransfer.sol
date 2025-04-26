// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// A mock fee-on-transfer token contract that implements ERC20
contract MockFeeOnTransferToken is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    uint256 public fee; // Fee percentage (e.g., 500 = 5%)

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        uint256 _fee
    ) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        fee = _fee; // Fee in basis points (1/100 of a percent)
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 feeAmount = (amount * fee) / 10000;
        uint256 transferAmount = amount - feeAmount;

        balanceOf[msg.sender] -= amount;
        balanceOf[to] += transferAmount;
        // Fee is burned

        emit Transfer(msg.sender, to, transferAmount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }

        uint256 feeAmount = (amount * fee) / 10000;
        uint256 transferAmount = amount - feeAmount;

        balanceOf[from] -= amount;
        balanceOf[to] += transferAmount;
        // Fee is burned

        emit Transfer(from, to, transferAmount);
        return true;
    }

    // ERC4626-like function to make the token detectable as fee-on-transfer
    function convertToAssets(uint256 shares) external pure returns (uint256) {
        return shares;
    }
}
