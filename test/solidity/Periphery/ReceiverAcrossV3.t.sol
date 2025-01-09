// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { Test, TestBase, Vm, LiFiDiamond, DSTest, ILiFi, LibSwap, LibAllowList, console, InvalidAmount, ERC20, UniswapV2Router02 } from "../utils/TestBase.sol";
import { OnlyContractOwner, UnAuthorized, ExternalCallFailed } from "src/Errors/GenericErrors.sol";

import { ReceiverAcrossV3 } from "lifi/Periphery/ReceiverAcrossV3.sol";
import { stdJson } from "forge-std/Script.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { MockUniswapDEX, NonETHReceiver } from "../utils/TestHelpers.sol";

address constant SPOKEPOOL_MAINNET = 0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;

contract ReceiverAcrossV3Test is TestBase {
    using stdJson for string;

    ReceiverAcrossV3 internal receiver;
    bytes32 guid = bytes32("12345");
    address receiverAddress = USER_RECEIVER;

    address stargateRouter;
    Executor executor;
    ERC20Proxy erc20Proxy;

    event ExecutorSet(address indexed executor);

    function setUp() public {
        customBlockNumberForForking = 20024274;
        initTestBase();

        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(erc20Proxy));
        receiver = new ReceiverAcrossV3(
            address(this),
            address(executor),
            SPOKEPOOL_MAINNET
        );
        vm.label(address(receiver), "ReceiverAcrossV3");
        vm.label(address(executor), "Executor");
        vm.label(address(erc20Proxy), "ERC20Proxy");
    }

    function test_contractIsSetUpCorrectly() public {
        receiver = new ReceiverAcrossV3(
            address(this),
            address(executor),
            SPOKEPOOL_MAINNET
        );

        assertEq(address(receiver.executor()) == address(executor), true);
        assertEq(receiver.spokepool() == SPOKEPOOL_MAINNET, true);
    }

    function test_OwnerCanPullERC20Token() public {
        // fund receiver with ERC20 tokens
        deal(ADDRESS_DAI, address(receiver), 1000);

        uint256 initialBalance = dai.balanceOf(USER_RECEIVER);

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.pullToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);

        assertEq(dai.balanceOf(USER_RECEIVER), initialBalance + 1000);
    }

    function test_OwnerCanPullNativeToken() public {
        // fund receiver with native tokens
        vm.deal(address(receiver), 1 ether);

        uint256 initialBalance = USER_RECEIVER.balance;

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.pullToken(address(0), payable(USER_RECEIVER), 1 ether);

        assertEq(USER_RECEIVER.balance, initialBalance + 1 ether);
    }

    function test_PullTokenWillRevertIfExternalCallFails() public {
        vm.deal(address(receiver), 1 ether);

        // deploy contract that cannot receive ETH
        NonETHReceiver nonETHReceiver = new NonETHReceiver();

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(ExternalCallFailed.selector);

        receiver.pullToken(
            address(0),
            payable(address(nonETHReceiver)),
            1 ether
        );
    }

    function test_revert_PullTokenNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        receiver.pullToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);
    }

    function test_revert_OnlySpokepoolCanCallHandleV3AcrossMessage() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        // call from deployer of ReceiverAcrossV3
        vm.startPrank(address(this));
        vm.expectRevert(UnAuthorized.selector);

        receiver.handleV3AcrossMessage(
            ADDRESS_USDC,
            defaultUSDCAmount,
            address(0),
            abi.encode("payload")
        );

        // call from owner of user
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);

        receiver.handleV3AcrossMessage(
            ADDRESS_USDC,
            defaultUSDCAmount,
            address(0),
            abi.encode("payload")
        );
    }

    function test_canDecodeAcrossPayloadAndExecuteSwapERC20() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        // encode payload with mock data like Stargate would according to:
        (
            bytes memory payload,
            uint256 amountOutMin
        ) = _getValidAcrossV3Payload(ADDRESS_USDC, ADDRESS_DAI);

        // fake a sendCompose from USDC pool on ETH mainnet
        vm.startPrank(SPOKEPOOL_MAINNET);

        vm.expectEmit();
        emit LiFiTransferCompleted(
            guid,
            ADDRESS_USDC,
            receiverAddress,
            amountOutMin,
            block.timestamp
        );
        receiver.handleV3AcrossMessage(
            ADDRESS_USDC,
            defaultUSDCAmount,
            address(0),
            payload
        );

        assertTrue(dai.balanceOf(receiverAddress) == amountOutMin);
    }

    function test_willReturnFundsToUserIfDstCallFails() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        // encode payload with mock data like Stargate would according to:
        string memory revertReason = "Just because";
        MockUniswapDEX mockDEX = new MockUniswapDEX();

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(mockDEX),
            approveTo: address(mockDEX),
            sendingAssetId: ADDRESS_USDC,
            receivingAssetId: ADDRESS_USDC,
            fromAmount: defaultUSDCAmount,
            callData: abi.encodeWithSelector(
                mockDEX.mockSwapWillRevertWithReason.selector,
                revertReason
            ),
            requiresDeposit: false
        });

        bytes memory payload = abi.encode(guid, swapData, receiverAddress);

        vm.startPrank(SPOKEPOOL_MAINNET);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit LiFiTransferRecovered(
            guid,
            ADDRESS_USDC,
            receiverAddress,
            defaultUSDCAmount,
            block.timestamp
        );
        receiver.handleV3AcrossMessage(
            ADDRESS_USDC,
            defaultUSDCAmount,
            address(0),
            payload
        );

        assertTrue(usdc.balanceOf(receiverAddress) == defaultUSDCAmount);
    }

    // HELPER FUNCTIONS
    function _getValidAcrossV3Payload(
        address _sendingAssetId,
        address _receivingAssetId
    ) public view returns (bytes memory callData, uint256 amountOutMin) {
        // create swapdata
        address[] memory path = new address[](2);
        path[0] = _sendingAssetId;
        path[1] = _receivingAssetId;

        uint256 amountIn = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        amountOutMin = amounts[1];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: _sendingAssetId,
            receivingAssetId: _receivingAssetId,
            fromAmount: amountIn,
            callData: abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOutMin,
                path,
                address(executor),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });

        // this is the "message" that we would receive from the other chain
        callData = abi.encode(guid, swapData, receiverAddress);
    }
}
