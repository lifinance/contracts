// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestToken as ERC20 } from "./TestToken.sol";
import { ExternalCallFailed } from "lifi/Errors/GenericErrors.sol";

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
            (bool success, ) = payable(address(0xd34d)).call{
                value: msg.value
            }("");
            if (!success) revert ExternalCallFailed();
        }

        _toToken.mint(msg.sender, _amountOut);
    }
}
