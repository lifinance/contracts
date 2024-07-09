// SPDX-License-Identifier: Unlicense
pragma solidity =0.8.17;

import { TestBase, ILiFi, LibAllowList, ERC20, DiamondTest, LiFiDiamond, LibSwap, console, UniswapV2Router02 } from "./TestBase.sol";
import { MockUniswapDEX } from "./MockUniswapDEX.sol";

interface DexManager {
    function addDex(address _dex) external;

    function setFunctionApprovalBySignature(bytes4 _signature) external;
}

//common utilities for forge tests
contract TestHelpers is TestBase {
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
            mockDex.swapExactETHForTokens.selector
        );
        DexManager(diamond).setFunctionApprovalBySignature(
            mockDex.swapExactTokensForETH.selector
        );
        DexManager(diamond).setFunctionApprovalBySignature(
            mockDex.swapTokensForExactETH.selector
        );
        DexManager(diamond).setFunctionApprovalBySignature(
            mockDex.mockSwapWillRevertWithReason.selector
        );
    }

    /// CALLDATA AND SWAPDATA GENERATION

    function _getFeeCollectorSwapData(
        bool fromNative
    ) internal view returns (LibSwap.SwapData memory swapData) {
        address assetId = fromNative ? address(0) : ADDRESS_USDC;
        bytes memory callData = fromNative
            ? abi.encodeWithSelector(
                feeCollector.collectNativeFees.selector,
                defaultNativeFeeCollectionAmount,
                0,
                USER_INTEGRATOR
            )
            : abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_USDC,
                defaultUSDCFeeCollectionAmount,
                0,
                USER_INTEGRATOR
            );
        swapData = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            assetId,
            assetId,
            fromNative ? defaultNativeAmount : defaultUSDCAmount,
            callData,
            fromNative ? false : true
        );
    }

    /// VARIOUS HELPER FUNCTIONS

    function mergeBytes(
        bytes memory a,
        bytes memory b
    ) public pure returns (bytes memory c) {
        // Store the length of the first array
        uint alen = a.length;
        // Store the length of BOTH arrays
        uint totallen = alen + b.length;
        // Count the loops required for array a (sets of 32 bytes)
        uint loopsa = (a.length + 31) / 32;
        // Count the loops required for array b (sets of 32 bytes)
        uint loopsb = (b.length + 31) / 32;
        assembly {
            let m := mload(0x40)
            // Load the length of both arrays to the head of the new bytes array
            mstore(m, totallen)
            // Add the contents of a to the array
            for {
                let i := 0
            } lt(i, loopsa) {
                i := add(1, i)
            } {
                mstore(
                    add(m, mul(32, add(1, i))),
                    mload(add(a, mul(32, add(1, i))))
                )
            }
            // Add the contents of b to the array
            for {
                let i := 0
            } lt(i, loopsb) {
                i := add(1, i)
            } {
                mstore(
                    add(m, add(mul(32, add(1, i)), alen)),
                    mload(add(b, mul(32, add(1, i))))
                )
            }
            mstore(0x40, add(m, add(32, totallen)))
            c := m
        }
    }
}

contract NonETHReceiver {
    // this contract cannot receive any ETH due to missing receive function
}
