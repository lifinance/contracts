// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { Test, console } from "forge-std/Test.sol";
import { SwapIntentHandler } from "lifi/Helpers/SwapIntentHandler.sol";
import { IIntent } from "lifi/Interfaces/IIntent.sol";
import { IntentFactory } from "lifi/Periphery/IntentFactory.sol";
import { TestToken } from "../utils/TestToken.sol";
import { TestAMM } from "../utils/TestAMM.sol";

contract IntentFactoryTest is Test {
    SwapIntentHandler public implementation;
    IntentFactory public factory;
    TestAMM public amm;
    TestToken public tokenA;
    TestToken public tokenB;
    address public alice;
    address public receiver;

    event IntentExecuted(
        bytes32 indexed intentId,
        address receiver,
        address tokenOut,
        uint256 amountOut
    );

    function setUp() public {
        (implementation, factory) = deploy();
        amm = new TestAMM();
        tokenA = new TestToken("TokenA", "TKNA", 18);
        tokenB = new TestToken("TokenB", "TKNB", 18);
        alice = makeAddr("alice");
        receiver = makeAddr("receiver");
    }

    function deploy() public returns (SwapIntentHandler, IntentFactory) {
        IntentFactory _factory = new IntentFactory(address(this));
        address payable _implementation = payable(_factory.implementation());
        return (SwapIntentHandler(_implementation), _factory);
    }

    function test_can_deposit_and_execute_swap() public {
        tokenA.mint(alice, 1000);
        bytes32 intentId = keccak256("intentId");

        // Compute the address of the intent
        address intentClone = factory.getIntentAddress(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
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

        vm.expectEmit();
        emit IntentExecuted(intentId, receiver, address(tokenB), 100);

        // execute the intent
        factory.deployAndExecuteIntent(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            calls
        );

        // assertions
        assertEq(tokenB.balanceOf(receiver), 100);
        assertEq(tokenA.balanceOf(alice), 0);
        assertEq(tokenB.balanceOf(intentClone), 0);
        assertEq(tokenA.balanceOf(intentClone), 0);
    }

    function test_fails_to_execute_after_executed() public {
        tokenA.mint(alice, 2000);
        bytes32 intentId = keccak256("intentId");

        // Compute the address of the intent
        address intentClone = factory.getIntentAddress(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
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

        vm.expectEmit();
        emit IntentExecuted(intentId, receiver, address(tokenB), 100);

        // execute the intent
        factory.deployAndExecuteIntent(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            calls
        );

        vm.prank(alice);
        tokenA.transfer(intentClone, 1000);

        vm.expectRevert();

        // execute the intent
        factory.deployAndExecuteIntent(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            calls
        );
    }

    function test_fail_when_min_amount_not_received() public {
        tokenA.mint(alice, 1000);
        bytes32 intentId = keccak256("intentId");

        // Compute the address of the intent
        address intentClone = factory.getIntentAddress(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
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
            1
        );
        calls[1] = IIntent.Call({
            to: address(amm),
            value: 0,
            data: swapCalldata
        });

        vm.expectRevert();
        // execute the intent
        factory.deployAndExecuteIntent(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            calls
        );
    }

    function test_can_deposit_native_and_execute_swap() public {
        bytes32 intentId = keccak256("intentId");

        // Compute the address of the intent
        address intentClone = factory.getIntentAddress(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
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

        vm.expectEmit();
        emit IntentExecuted(intentId, receiver, address(tokenB), 100);

        // execute the intent
        factory.deployAndExecuteIntent(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            calls
        );

        // assertions
        assertEq(tokenB.balanceOf(receiver), 100);
        assertEq(tokenB.balanceOf(intentClone), 0);
        assertEq(intentClone.balance, 0);
    }

    function test_can_deposit_and_withdraw_all() public {
        tokenA.mint(alice, 2000);
        bytes32 intentId = keccak256("intentId");
        // Compute the address of the intent
        address intentClone = factory.getIntentAddress(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            })
        );
        // Send tokens to the precomputed address
        vm.startPrank(alice);
        tokenA.transfer(intentClone, 1000);
        (bool ok, ) = intentClone.call{ value: 1 ether }("");
        ok;
        // Deploy and withdraw all tokens
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(0);
        factory.deployAndWithdrawAll(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            tokens,
            payable(alice)
        );

        // Send more tokens
        tokenA.transfer(intentClone, 1000);

        // Withdraw again
        SwapIntentHandler(payable(intentClone)).withdrawAll(
            tokens,
            payable(alice)
        );
        vm.stopPrank();

        // assertions
        assertEq(tokenA.balanceOf(alice), 2000);
        assertEq(tokenA.balanceOf(intentClone), 0);
        assertEq(intentClone.balance, 0);
    }

    function test_can_withdraw_after_intent_is_executed() public {
        tokenA.mint(alice, 2000);
        bytes32 intentId = keccak256("intentId");

        // Compute the address of the intent
        address intentClone = factory.getIntentAddress(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
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

        vm.expectEmit();
        emit IntentExecuted(intentId, receiver, address(tokenB), 100);

        // execute the intent
        factory.deployAndExecuteIntent(
            IIntent.InitData({
                intentId: intentId,
                owner: alice,
                receiver: receiver,
                tokenOut: address(tokenB),
                amountOutMin: 100,
                deadline: block.timestamp
            }),
            calls
        );

        vm.startPrank(alice);
        tokenA.transfer(intentClone, 1000);
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA);

        SwapIntentHandler(payable(intentClone)).withdrawAll(
            tokens,
            payable(alice)
        );
        vm.stopPrank();
    }
}
