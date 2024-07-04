// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import { Test, console } from "forge-std/Test.sol";
import { Intent } from "lifi/Helpers/Intent.sol";
import { IIntent } from "lifi/Interfaces/IIntent.sol";
import { IntentFactory } from "lifi/Periphery/IntentFactory.sol";
import { TestToken } from "../utils/TestToken.sol";
import { TestAMM } from "../utils/TestAMM.sol";

contract IntentFactoryTest is Test {
    Intent public implementation;
    IntentFactory public factory;
    TestAMM public amm;
    TestToken public tokenA;
    TestToken public tokenB;
    address public alice;

    function setUp() public {
        (implementation, factory) = deploy();
        amm = new TestAMM();
        tokenA = new TestToken("TokenA", "TKNA", 18);
        tokenB = new TestToken("TokenB", "TKNB", 18);
        alice = makeAddr("alice");
    }

    function deploy() public returns (Intent, IntentFactory) {
        address _implementation = address(new Intent());
        IntentFactory _factory = new IntentFactory(_implementation);
        return (Intent(_implementation), _factory);
    }

    function test_can_deposit_and_execute_swap() public {
        tokenA.mint(alice, 1000);
        bytes32 intentId = keccak256("intentId");

        // Compute the address of the intent
        address intentClone = factory.getIntentAddress(
            IIntent.InitData({
                intentId: intentId,
                receiver: alice,
                tokenOut: address(tokenB),
                amoutOutMin: 100
            })
        );

        // Send tokens to the precomputed address
        vm.prank(alice);
        tokenA.transfer(intentClone, 1000);

        IIntent.Call[] memory calls = new IIntent.Call[](2);

        // get approve calldata
        bytes memory approveCalldata = abi.encodeWithSignature(
            "approve(address,uint256)",
            address(amm),
            1000
        );
        calls[0] = IIntent.Call({
            to: address(tokenA),
            value: 0,
            data: approveCalldata
        });

        // get swap calldata
        bytes memory swapCalldata = abi.encodeWithSignature(
            "swap(address,uint256,address,uint256)",
            address(tokenA),
            1000,
            address(tokenB),
            100
        );
        calls[1] = IIntent.Call({
            to: address(amm),
            value: 0,
            data: swapCalldata
        });

        // execute the intent
        factory.deployAndExecuteIntent(
            IIntent.InitData({
                intentId: intentId,
                receiver: alice,
                tokenOut: address(tokenB),
                amoutOutMin: 100
            }),
            calls
        );

        // assertions
        assertEq(tokenB.balanceOf(alice), 100);
        assertEq(tokenA.balanceOf(alice), 0);
        assertEq(tokenB.balanceOf(intentClone), 0);
        assertEq(tokenA.balanceOf(intentClone), 0);
    }

    function test_can_deposit_and_withdraw_all() public {
        tokenA.mint(alice, 1000);
        bytes32 intentId = keccak256("intentId");
        // Compute the address of the intent
        address intentClone = factory.getIntentAddress(
            IIntent.InitData({
                intentId: intentId,
                receiver: alice,
                tokenOut: address(tokenB),
                amoutOutMin: 100
            })
        );
        // Send tokens to the precomputed address
        vm.prank(alice);
        tokenA.transfer(intentClone, 1000);
        // execute the intent
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA);
        factory.deployAndWithdrawAll(
            IIntent.InitData({
                intentId: intentId,
                receiver: alice,
                tokenOut: address(tokenB),
                amoutOutMin: 100
            }),
            tokens
        );
        // assertions
        assertEq(tokenA.balanceOf(alice), 1000);
        assertEq(tokenA.balanceOf(intentClone), 0);
    }
}
