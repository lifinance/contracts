// SPDX-License-Identifier: MIT
// for testing only not for production
// solhint-disable

pragma solidity ^0.8.3;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract USDT is ERC20 {
    constructor(
        address receiver,
        string memory name,
        string memory symbol
    ) ERC20(name, symbol) {
        // Mint 100 tokens to msg.sender
        // Similar to how
        // 1 dollar = 100 cents
        // 1 token = 1 * (10 ** decimals)
        _mint(receiver, 10000 * 10**uint256(6));
    }
}
