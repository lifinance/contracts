// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

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
            payable(address(0xd34d)).call{ value: msg.value }("");
        }

        _toToken.mint(msg.sender, _amountOut);
    }

    function partialSwap(
        ERC20 _fromToken,
        uint256 _amountIn,
        ERC20 _toToken,
        uint256 _amountOut
    ) public payable {
        // Simulate AMM behavior: take the full amount but return some due to better pricing
        if (address(_fromToken) != address(0)) {
            // Take the full amount from the user
            _fromToken.transferFrom(msg.sender, address(this), _amountIn);
            // Burn only 80% (simulate using 80% for the swap)
            _fromToken.burn(address(this), (_amountIn * 80) / 100);
            // Return 20% back to the caller (simulating better pricing)
            _fromToken.transfer(msg.sender, (_amountIn * 20) / 100);
        } else {
            // For native tokens, we receive the full amount via msg.value
            // Send away 80% and return 20% back to the caller
            // solhint-disable-next-line avoid-low-level-calls
            payable(address(0xd34d)).call{ value: (msg.value * 80) / 100 }("");
            // Return 20% back to the caller (simulating better pricing)
            payable(msg.sender).transfer((msg.value * 20) / 100);
        }

        _toToken.mint(msg.sender, _amountOut);
    }
}
