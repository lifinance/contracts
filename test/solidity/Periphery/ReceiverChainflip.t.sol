// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { Test, TestBase, Vm, LiFiDiamond, DSTest, ILiFi, LibSwap, LibAllowList, console, InvalidAmount, ERC20, UniswapV2Router02 } from "../utils/TestBase.sol";
import { ExternalCallFailed, UnAuthorized } from "src/Errors/GenericErrors.sol";
import { ReceiverChainflip } from "lifi/Periphery/ReceiverChainflip.sol";
import { stdJson } from "forge-std/Script.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { MockUniswapDEX, NonETHReceiver } from "../utils/TestHelpers.sol";

contract ReceiverChainflipTest is TestBase {
    using stdJson for string;

    ReceiverChainflip internal receiver;
    bytes32 guid = bytes32("12345");
    address receiverAddress = USER_RECEIVER;

    Executor executor;
    ERC20Proxy erc20Proxy;
    address chainflipVault;

    event ExecutorSet(address indexed executor);

    function setUp() public {
        customBlockNumberForForking = 18277082;
        initTestBase();

        // Read chainflip vault address from config
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/chainflip.json"
        );
        string memory json = vm.readFile(path);
        chainflipVault = json.readAddress(".mainnet.chainflipVault");
        vm.label(chainflipVault, "Chainflip Vault");

        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(erc20Proxy), address(this));
        receiver = new ReceiverChainflip(
            address(this),
            address(executor),
            chainflipVault
        );
        vm.label(address(receiver), "ReceiverChainflip");
        vm.label(address(executor), "Executor");
        vm.label(address(erc20Proxy), "ERC20Proxy");
    }

    function test_contractIsSetUpCorrectly() public {
        receiver = new ReceiverChainflip(
            address(this),
            address(executor),
            chainflipVault
        );

        assertEq(address(receiver.executor()) == address(executor), true);
        assertEq(receiver.chainflipVault() == chainflipVault, true);
    }

    function test_OwnerCanPullERC20Token() public {
        // fund receiver with ERC20 tokens
        deal(ADDRESS_DAI, address(receiver), 1000);

        uint256 initialBalance = dai.balanceOf(USER_RECEIVER);

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.withdrawToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);

        assertEq(dai.balanceOf(USER_RECEIVER), initialBalance + 1000);
    }

    function test_OwnerCanPullNativeToken() public {
        // fund receiver with native tokens
        vm.deal(address(receiver), 1 ether);

        uint256 initialBalance = USER_RECEIVER.balance;

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.withdrawToken(address(0), payable(USER_RECEIVER), 1 ether);

        assertEq(USER_RECEIVER.balance, initialBalance + 1 ether);
    }

    function test_WithdrawTokenWillRevertIfExternalCallFails() public {
        vm.deal(address(receiver), 1 ether);

        // deploy contract that cannot receive ETH
        NonETHReceiver nonETHReceiver = new NonETHReceiver();

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(ExternalCallFailed.selector);

        receiver.withdrawToken(
            address(0),
            payable(address(nonETHReceiver)),
            1 ether
        );
    }

    function test_revert_WithdrawTokenNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        receiver.withdrawToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);
    }

    function test_revert_OnlyChainflipVaultCanCallCfReceive() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        // call from deployer of ReceiverChainflip
        vm.startPrank(address(this));
        vm.expectRevert(UnAuthorized.selector);

        receiver.cfReceive(
            1, // srcChain (Ethereum)
            abi.encodePacked(address(0)),
            abi.encode("payload"),
            ADDRESS_USDC,
            defaultUSDCAmount
        );

        // call from random user
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);

        receiver.cfReceive(
            1, // srcChain (Ethereum)
            abi.encodePacked(address(0)),
            abi.encode("payload"),
            ADDRESS_USDC,
            defaultUSDCAmount
        );
    }

    function test_canDecodeChainflipPayloadAndExecuteSwapERC20() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        // encode payload with mock data
        (
            bytes memory payload,
            uint256 amountOutMin
        ) = _getValidChainflipPayload(ADDRESS_USDC, ADDRESS_DAI);

        // fake a call from Chainflip vault
        vm.startPrank(chainflipVault);

        vm.expectEmit();
        emit LiFiTransferCompleted(
            guid,
            ADDRESS_USDC,
            receiverAddress,
            amountOutMin,
            block.timestamp
        );
        receiver.cfReceive(
            1, // srcChain (Ethereum)
            abi.encodePacked(address(0)),
            payload,
            ADDRESS_USDC,
            defaultUSDCAmount
        );

        assertTrue(dai.balanceOf(receiverAddress) == amountOutMin);
    }

    function test_willReturnFundsToUserIfDstCallFails() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        // encode payload with mock data
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

        vm.startPrank(chainflipVault);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit LiFiTransferRecovered(
            guid,
            ADDRESS_USDC,
            receiverAddress,
            defaultUSDCAmount,
            block.timestamp
        );
        receiver.cfReceive(
            1, // srcChain (Ethereum)
            abi.encodePacked(address(0)),
            payload,
            ADDRESS_USDC,
            defaultUSDCAmount
        );

        assertTrue(usdc.balanceOf(receiverAddress) == defaultUSDCAmount);
    }

    // HELPER FUNCTIONS
    function _getValidChainflipPayload(
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
