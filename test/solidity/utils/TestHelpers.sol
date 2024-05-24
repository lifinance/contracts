// SPDX-License-Identifier: Unlicense
pragma solidity =0.8.17;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { MockUniswapDEX } from "./MockUniswapDEX.sol";

interface DexManager {
    function addDex(address _dex) external;

    function setFunctionApprovalBySignature(bytes4 _signature) external;
}

//common utilities for forge tests
contract TestHelpers is Test {
    /// @notice will deploy and fund a mock DEX that can simulate the following behaviour for both ERC20/Native:
    ///         positive slippage#1: uses less input tokens as expected
    ///         positive slippage#2: returns more output tokens as expected
    ///         negative slippage (too high): returns less output tokens as expected
    /// @param outputToken the address of the token that the swap shall return (address(0) for native)
    /// @param outputAmount the amount of outputToken the swap shall return (address(0) for native)
    /// @param amountInActual the amount of inputToken the DEX should pull from msg.sender (if set to 0 then the amountInMax value of the swap function will be used)
    function deployAndFundMockDEX(
        address outputToken,
        uint256 outputAmount,
        uint256 amountInActual
    ) internal returns (MockUniswapDEX mockDex) {
        // deploy
        mockDex = new MockUniswapDEX();

        // fund DEX with native or ERC20
        if (outputToken == address(0)) deal(address(mockDex), outputAmount);
        else deal(outputToken, address(mockDex), outputAmount);

        // set swap outcome
        mockDex.setSwapOutput(
            amountInActual,
            ERC20(outputToken),
            outputAmount
        );
    }

    function deployFundAndWhitelistMockDEX(
        address diamond,
        address outputToken,
        uint256 outputAmount,
        uint256 amountInActual
    ) internal returns (MockUniswapDEX mockDex) {
        // deploy and fund
        mockDex = deployAndFundMockDEX(
            outputToken,
            outputAmount,
            amountInActual
        );

        // whitelist DEX & function selector
        DexManager(diamond).addDex(address(mockDex));
        DexManager(diamond).setFunctionApprovalBySignature(
            mockDex.swapTokensForExactTokens.selector
        );
        DexManager(diamond).setFunctionApprovalBySignature(
            mockDex.swapExactTokensForTokens.selector
        );
        DexManager(diamond).setFunctionApprovalBySignature(
            mockDex.swapETHForExactTokens.selector
        );
        DexManager(diamond).setFunctionApprovalBySignature(
            mockDex.mockSwapWillRevertWithReason.selector
        );
    }
}

contract NonETHReceiver {
    // this contract cannot receive any ETH due to missing receive function
}
