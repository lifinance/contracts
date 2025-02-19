// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBase, ILiFi, LibSwap, console, ERC20, UniswapV2Router02 } from "../utils/TestBase.sol";
import { ExternalCallFailed, UnAuthorized } from "src/Errors/GenericErrors.sol";
import { ReceiverChainflip } from "lifi/Periphery/ReceiverChainflip.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { stdJson } from "forge-std/Script.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { MockUniswapDEX, NonETHReceiver } from "../utils/TestHelpers.sol";

contract ReceiverChainflipTest is TestBase {
    using stdJson for string;

    error ETHTransferFailed();

    ReceiverChainflip internal receiver;
    bytes32 guid = bytes32("12345");
    address receiverAddress = USER_RECEIVER;
    address constant CHAINFLIP_NATIVE_ADDRESS =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    Executor executor;
    ERC20Proxy erc20Proxy;
    address chainflipVault;

    event ExecutorSet(address indexed executor);

    function setUp() public {
        customBlockNumberForForking = 18277082;
        initTestBase();

        chainflipVault = getConfigAddressFromPath(
            "chainflip.json",
            ".chainflipVault.mainnet"
        );
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

    function test_ContractIsSetUpCorrectly() public {
        receiver = new ReceiverChainflip(
            address(this),
            address(executor),
            chainflipVault
        );

        assertEq(address(receiver.executor()) == address(executor), true);
        assertEq(receiver.chainflipVault() == chainflipVault, true);
    }

    function testRevert_OnlyChainflipVaultCanCallCfReceive() public {
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
        vm.stopPrank();

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
        vm.stopPrank();
    }

    function test_CanDecodeChainflipPayloadAndExecuteSwapERC20() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        // Store initial balance
        uint256 initialReceiverDAI = dai.balanceOf(receiverAddress);

        // encode payload with mock data
        (
            bytes memory payload,
            uint256 amountOutMin
        ) = _getValidChainflipPayload(ADDRESS_USDC, ADDRESS_DAI);

        // fake a call from Chainflip vault
        vm.startPrank(chainflipVault);

        vm.expectEmit(true, true, true, true, address(executor));
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

        vm.stopPrank();

        // Verify balances changed correctly
        assertEq(
            usdc.balanceOf(address(receiver)),
            0,
            "Receiver should have 0 USDC after swap"
        );
        assertEq(
            dai.balanceOf(receiverAddress),
            initialReceiverDAI + amountOutMin,
            "Receiver should have received DAI"
        );
    }

    function test_WillReturnFundsToUserIfDstCallFails() public {
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
            4, // srcChain (Arbitrum)
            abi.encodePacked(address(0)),
            payload,
            ADDRESS_USDC,
            defaultUSDCAmount
        );

        assertTrue(usdc.balanceOf(receiverAddress) == defaultUSDCAmount);
    }

    function test_WillReturnNativeTokensToUserIfDstCallFails() public {
        // Fund chainflipVault with native token as well
        vm.deal(chainflipVault, 1 ether);

        // Create mock DEX that will revert
        string memory revertReason = "Just because";
        MockUniswapDEX mockDEX = new MockUniswapDEX();

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(mockDEX),
            approveTo: address(mockDEX),
            sendingAssetId: LibAsset.NATIVE_ASSETID,
            receivingAssetId: ADDRESS_DAI,
            fromAmount: 1 ether,
            callData: abi.encodeWithSelector(
                mockDEX.mockSwapWillRevertWithReason.selector,
                revertReason
            ),
            requiresDeposit: false
        });

        bytes memory payload = abi.encode(guid, swapData, receiverAddress);

        uint256 initialBalance = receiverAddress.balance;

        vm.startPrank(chainflipVault);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit LiFiTransferRecovered(
            guid,
            LibAsset.NATIVE_ASSETID,
            receiverAddress,
            1 ether,
            block.timestamp
        );

        receiver.cfReceive{ value: 1 ether }(
            4, // srcChain (Arbitrum)
            abi.encodePacked(address(0)),
            payload,
            CHAINFLIP_NATIVE_ADDRESS,
            1 ether
        );

        assertEq(receiverAddress.balance, initialBalance + 1 ether);
        vm.stopPrank();
    }

    function testRevert_IfNativeRecoveryTransferFailsToSendETHToUser() public {
        // Fund receiver with native token
        vm.deal(address(receiver), 1 ether);
        // Fund chainflipVault with native token
        vm.deal(chainflipVault, 1 ether);

        // Create a contract that can't receive ETH
        NonETHReceiver nonEthReceiver = new NonETHReceiver();

        // Create mock DEX that will revert
        MockUniswapDEX mockDEX = new MockUniswapDEX();

        // Create swap data that will fail when trying to send ETH
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(mockDEX),
            approveTo: address(mockDEX),
            sendingAssetId: LibAsset.NATIVE_ASSETID,
            receivingAssetId: LibAsset.NATIVE_ASSETID, // Try to get ETH back
            fromAmount: 1 ether,
            callData: abi.encodeWithSelector(
                mockDEX.mockSwapWillRevertWithReason.selector,
                "Mock swap failed"
            ),
            requiresDeposit: false
        });

        bytes memory payload = abi.encode(
            guid,
            swapData,
            address(nonEthReceiver)
        );

        vm.startPrank(chainflipVault);

        vm.expectRevert(ETHTransferFailed.selector);
        receiver.cfReceive{ value: 1 ether }(
            4, // srcChain (Arbitrum)
            abi.encodePacked(address(0)),
            payload,
            CHAINFLIP_NATIVE_ADDRESS,
            1 ether
        );

        vm.stopPrank();
    }

    function test_CanDecodeChainflipPayloadAndExecuteSwapNative() public {
        // fund chainflipVault with native token
        vm.deal(chainflipVault, 0.01 ether);

        // Store initial balance
        uint256 initialReceiverDAI = dai.balanceOf(receiverAddress);

        // encode payload with mock data
        (
            bytes memory payload,
            uint256 amountOutMin
        ) = _getValidChainflipPayloadNative(0.01 ether);

        // fake a call from Chainflip vault
        vm.startPrank(chainflipVault);

        vm.expectEmit();
        emit LiFiTransferCompleted(
            guid,
            LibAsset.NATIVE_ASSETID,
            receiverAddress,
            amountOutMin,
            block.timestamp
        );

        receiver.cfReceive{ value: 0.01 ether }(
            4, // srcChain (Arbitrum)
            abi.encodePacked(address(0)),
            payload,
            CHAINFLIP_NATIVE_ADDRESS,
            0.01 ether
        );
        vm.stopPrank();

        // Verify balances changed correctly
        assertEq(
            address(receiver).balance,
            0,
            "Receiver should have 0 ETH after swap"
        );
        assertEq(
            dai.balanceOf(receiverAddress),
            initialReceiverDAI + amountOutMin,
            "Receiver should have received DAI"
        );
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
        amountOutMin = defaultUSDCAmount; // Use same amount for exact output

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: _sendingAssetId,
            receivingAssetId: _receivingAssetId,
            fromAmount: amountIn,
            callData: abi.encodeWithSelector(
                uniswap.swapTokensForExactTokens.selector,
                amountOutMin,
                amountIn, // Max input amount
                path,
                address(executor),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });

        // this is the "message" that we would receive from the other chain
        callData = abi.encode(guid, swapData, receiverAddress);
    }

    // Add helper function for native token swap data
    function _getValidChainflipPayloadNative(
        uint256 amountIn
    ) public view returns (bytes memory callData, uint256 amountOutMin) {
        // create swapdata for ETH -> DAI
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_DAI;

        // Calculate ETH input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        amountOutMin = amounts[1];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: LibAsset.NATIVE_ASSETID,
            receivingAssetId: ADDRESS_DAI,
            fromAmount: amountIn,
            callData: abi.encodeWithSelector(
                uniswap.swapExactETHForTokens.selector,
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
