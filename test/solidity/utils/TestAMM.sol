// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.7;

import { TestToken as ERC20 } from "./TestToken.sol";

contract TestAMM {
    function swap(
        ERC20 _fromToken,
        uint256 _amountIn,
        ERC20 _toToken,
        uint256 _amountOut
    ) public {
        _fromToken.transferFrom(msg.sender, address(this), _amountIn);
        _fromToken.burn(address(this), _amountIn);
        _toToken.mint(msg.sender, _amountOut);
    }
}
