// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test, TestBase, LiFiDiamond, DSTest, ILiFi, LibSwap, LibAllowList, console, InvalidAmount, ERC20, UniswapV2Router02 } from "../utils/TestBase.sol";
import { OnlyContractOwner } from "src/Errors/GenericErrors.sol";
import { CCIPMsgReceiver } from "lifi/Periphery/CCIPMsgReceiver.sol";
import { stdJson } from "forge-std/Script.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { Client } from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";

contract CCIPMsgReceiverTest is TestBase {
    using stdJson for string;

    CCIPMsgReceiver internal receiver;

    error UnAuthorized();

    string path;
    string json;
    address ccipRouter;
    Executor executor;
    ERC20Proxy erc20Proxy;

    event CCIPRouterSet(address indexed router);
    event ExecutorSet(address indexed executor);
    event RecoverGasSet(uint256 indexed recoverGas);

    function setUp() public {
        initTestBase();

        // obtain address of Stargate router in current network from config file
        path = string.concat(vm.projectRoot(), "/config/ccip.json");
        json = vm.readFile(path);
        ccipRouter = json.readAddress(
            string.concat(".routers.mainnet.router")
        );

        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(erc20Proxy));
        receiver = new CCIPMsgReceiver(
            address(this),
            ccipRouter,
            address(executor),
            100000
        );
        vm.label(address(receiver), "Receiver");
        vm.label(address(executor), "Executor");
        vm.label(address(erc20Proxy), "ERC20Proxy");
        vm.label(ccipRouter, "CCIPRouter");
    }

    function test_revert_OwnerCanPullToken() public {
        // send token to receiver
        vm.startPrank(USER_SENDER);
        dai.transfer(address(receiver), 1000);
        vm.stopPrank();

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.pullToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);

        assertEq(1000, dai.balanceOf(USER_RECEIVER));
    }

    function test_revert_PullTokenNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        receiver.pullToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);
    }

    function test_CCIP_ExecutesCrossChainMessage() public {
        // create swap data
        delete swapData;
        // Swap DAI -> USDC
        address[] memory swapPath = new address[](2);
        swapPath[0] = ADDRESS_DAI;
        swapPath[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, swapPath);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    amountOut,
                    swapPath,
                    address(executor),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // create callData that will be sent to our CCIPMsgReceiver
        bytes32 txId = keccak256("txId");
        bytes memory payload = abi.encode(txId, swapData, USER_RECEIVER);

        // fund receiver with sufficient DAI to execute swap
        vm.startPrank(USER_DAI_WHALE);
        dai.transfer(address(receiver), swapData[0].fromAmount);
        vm.stopPrank();

        // call sgReceive function as Stargate router
        vm.startPrank(ccipRouter);
        dai.approve(address(receiver), swapData[0].fromAmount);

        // prepare check for events
        vm.expectEmit(true, true, true, true, address(executor));
        emit AssetSwapped(
            txId,
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            defaultUSDCAmount,
            block.timestamp
        );
        vm.expectEmit(true, true, true, true, address(executor));
        emit LiFiTransferCompleted(
            txId,
            ADDRESS_DAI,
            USER_RECEIVER,
            defaultUSDCAmount,
            block.timestamp
        );

        Client.EVMTokenAmount[]
            memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({
            token: ADDRESS_DAI,
            amount: swapData[0].fromAmount
        });

        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: txId,
            sourceChainSelector: 3734403246176062136, // Optimism chain selector,
            sender: abi.encode(address(receiver)),
            data: payload,
            destTokenAmounts: tokenAmounts
        });

        // call ccipReceive function to complete transaction
        receiver.ccipReceive(message);
    }

    function test_CCIP_EmitsCorrectEventOnRecovery() public {
        // (mock) transfer "bridged funds" to CCIPMsgReceiver.sol
        bytes32 txId = keccak256("txId");
        vm.startPrank(USER_SENDER);
        usdc.transfer(address(receiver), defaultUSDCAmount);
        vm.stopPrank();

        bytes memory payload = abi.encode(txId, swapData, address(1));

        vm.startPrank(ccipRouter);
        vm.expectEmit(true, true, true, true, address(receiver));
        emit LiFiTransferRecovered(
            txId,
            ADDRESS_USDC,
            address(1),
            defaultUSDCAmount,
            block.timestamp
        );

        Client.EVMTokenAmount[]
            memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({
            token: ADDRESS_USDC,
            amount: defaultUSDCAmount
        });

        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: txId,
            sourceChainSelector: 3734403246176062136, // Optimism chain selector,
            sender: abi.encode(address(receiver)),
            data: payload,
            destTokenAmounts: tokenAmounts
        });

        // call ccipReceive function to complete transaction
        receiver.ccipReceive(message);
    }
}
