// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title A test ERC20 token.
 */
contract TestERC20 is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1e28;

    /**
     * @dev Constructor that gives msg.sender all of the existing tokens.
     */
    constructor() ERC20("TestERC20", "TERC20") {
        _mint(msg.sender, INITIAL_SUPPLY);
    }
}
