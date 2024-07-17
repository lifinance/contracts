// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

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
        IntentFactory _factory = new IntentFactory(address(this));
        address payable _implementation = payable(_factory.implementation());
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
                amountOutMin: 100,
                deadline: block.timestamp
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
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            calls
        );

        // assertions
        assertEq(tokenB.balanceOf(alice), 100);
        assertEq(tokenA.balanceOf(alice), 0);
        assertEq(tokenB.balanceOf(intentClone), 0);
        assertEq(tokenA.balanceOf(intentClone), 0);
    }

    function test_can_deposit_native_and_execute_swap() public {
        bytes32 intentId = keccak256("intentId");

        // Compute the address of the intent
        address intentClone = factory.getIntentAddress(
            IIntent.InitData({
                intentId: intentId,
                receiver: alice,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            })
        );

        // Send tokens to the precomputed address
        vm.prank(alice);
        (bool ok, ) = intentClone.call{ value: 0.1 ether }("");
        ok;

        IIntent.Call[] memory calls = new IIntent.Call[](1);

        // get swap calldata
        bytes memory swapCalldata = abi.encodeWithSignature(
            "swap(address,uint256,address,uint256)",
            address(0),
            0.1 ether,
            address(tokenB),
            100
        );
        calls[0] = IIntent.Call({
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
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            calls
        );

        // assertions
        assertEq(tokenB.balanceOf(alice), 100);
        assertEq(tokenB.balanceOf(intentClone), 0);
        assertEq(intentClone.balance, 0);
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
                amountOutMin: 100,
                deadline: block.timestamp
            })
        );
        // Send tokens to the precomputed address
        vm.prank(alice);
        tokenA.transfer(intentClone, 1000);
        (bool ok, ) = intentClone.call{ value: 1 ether }("");
        ok;
        // execute the intent
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(0);
        factory.deployAndWithdrawAll(
            IIntent.InitData({
                intentId: intentId,
                receiver: alice,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            tokens
        );
        // assertions
        assertEq(tokenA.balanceOf(alice), 1000);
        assertEq(tokenA.balanceOf(intentClone), 0);
        assertEq(intentClone.balance, 0);
    }
}
