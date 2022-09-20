// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.16;

import { TestToken as ERC20 } from "./TestToken.sol";

contract TestAMM {
    function swap(
        ERC20 _fromToken,
        uint256 _amountIn,
        ERC20 _toToken,
        uint256 _amountOut
    ) public payable {
        if (address(_fromToken) != address(0)) {
            _fromToken.transferFrom(msg.sender, address(this), _amountIn);
            _fromToken.burn(address(this), _amountIn);
        } else {
            payable(address(0xd34d)).transfer(msg.value);
        }

        _toToken.mint(msg.sender, _amountOut);
    }
}
