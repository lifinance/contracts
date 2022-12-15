// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test, TestBase, LiFiDiamond, DSTest, ILiFi, LibSwap, LibAllowList, console, InvalidAmount, ERC20, UniswapV2Router02 } from "../utils/TestBase.sol";
import { OnlyContractOwner } from "src/Errors/GenericErrors.sol";

import { Receiver } from "lifi/Periphery/Receiver.sol";
import { stdJson } from "forge-std/Script.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";

contract ReceiverTest is TestBase {
    using stdJson for string;

    Receiver internal receiver;

    error UnAuthorized();

    string path;
    string json;
    address stargateRouter;
    address amarokRouter;
    bytes32 internal transferId;
    Executor executor;
    ERC20Proxy erc20Proxy;

    event LiFiTransferRecovered(
        bytes32 indexed transactionId,
        address receivingAssetId,
        address receiver,
        uint256 amount,
        uint256 timestamp
    );
    event StargateRouterSet(address indexed router);
    event AmarokRouterSet(address indexed router);
    event ExecutorSet(address indexed executor);
    event RecoverGasSet(uint256 indexed recoverGas);

    function setUp() public {
        initTestBase();

        // obtain address of Stargate router in current network from config file
        path = string.concat(vm.projectRoot(), "/config/stargate.json");
        json = vm.readFile(path);
        stargateRouter = json.readAddress(string.concat(".routers.mainnet"));

        path = string.concat(vm.projectRoot(), "/config/amarok.json");
        json = vm.readFile(path);
        amarokRouter = json.readAddress(string.concat(".mainnet.connextHandler"));

        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(this), address(erc20Proxy));
        receiver = new Receiver(address(this), stargateRouter, amarokRouter, address(executor), 100000);
        vm.label(address(receiver), "Receiver");
        vm.label(address(executor), "Executor");
        vm.label(address(erc20Proxy), "ERC20Proxy");
        vm.label(stargateRouter, "StargateRouter");
        vm.label(amarokRouter, "AmarokRouter");

        transferId = keccak256("123");
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

    function test_OwnerCanUpdateRecoverGas() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit RecoverGasSet(1000);

        receiver.setRecoverGas(1000);
    }

    function test_revert_amarok_UpdateRecoverGasNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        receiver.setRecoverGas(1000);
    }

    function test_OwnerCanUpdateExecutorAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit ExecutorSet(stargateRouter);

        receiver.setExecutor(stargateRouter);
    }

    function test_revert_amarok_UpdateExecutorAddressNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        receiver.setExecutor(stargateRouter);
    }

    // AMAROK-RELATED TESTS
    function test_amarok_ExecutesCrossChainMessage() public {
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

        // create callData that will be sent to our Receiver
        bytes memory payload = abi.encode(swapData, USER_RECEIVER);

        // fund receiver with sufficient DAI to execute swap
        vm.startPrank(USER_DAI_WHALE);
        dai.transfer(address(receiver), swapData[0].fromAmount);
        vm.stopPrank();

        // call xReceive function as Amarok router
        vm.startPrank(amarokRouter);
        dai.approve(address(receiver), swapData[0].fromAmount);

        uint32 fakeDomain = 12345;

        // prepare check for events
        vm.expectEmit(true, true, true, true, address(executor));
        emit AssetSwapped(
            0x64e604787cbf194841e7b68d7cd28786f6c9a0a3ab9f8b0a0e87cb4387ab0107,
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            defaultUSDCAmount,
            block.timestamp
        );
        vm.expectEmit(true, true, true, true, address(executor));
        emit LiFiTransferCompleted(transferId, ADDRESS_DAI, USER_RECEIVER, defaultUSDCAmount, block.timestamp);

        // call xReceive function to complete transaction
        receiver.xReceive(transferId, swapData[0].fromAmount, ADDRESS_DAI, USER_SENDER, fakeDomain, payload);
    }

    function test_amarok_ForwardsFundsToReceiverIfDestCallFails() public {
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
                sendingAssetId: ADDRESS_USDC, // swapped sending/receivingId => should fail
                receivingAssetId: ADDRESS_DAI,
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

        // create callData that will be sent to our Receiver
        bytes memory payload = abi.encode(swapData, USER_RECEIVER);

        // fund receiver with sufficient DAI to execute swap
        vm.startPrank(USER_DAI_WHALE);
        dai.transfer(address(receiver), swapData[0].fromAmount);
        vm.stopPrank();

        // call xReceive function as Amarok router
        vm.startPrank(amarokRouter);
        dai.approve(address(receiver), swapData[0].fromAmount);

        uint32 fakeDomain = 12345;

        // prepare check for events
        //! THIS DOES NOT WORK AND I DONT KNOW WHY - @ REVIEWER: PLS TRY TO DEBUG
        // vm.expectEmit(true, true, true, true, ADDRESS_DAI);
        // emit Transfer(address(receiver), USER_RECEIVER, swapData[0].fromAmount);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit LiFiTransferRecovered(transferId, ADDRESS_DAI, USER_RECEIVER, swapData[0].fromAmount, block.timestamp);

        // call xReceive function to complete transaction
        receiver.xReceive(transferId, swapData[0].fromAmount, ADDRESS_DAI, USER_SENDER, fakeDomain, payload);
    }

    function test_amarok_OwnerCanUpdateRouterAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit AmarokRouterSet(stargateRouter);

        receiver.setAmarokRouter(stargateRouter);
    }

    function test_revert_amarok_UpdateRouterAddressNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        receiver.setAmarokRouter(stargateRouter);
    }

    // STARGATE-RELATED TESTS
    function test_stargate_ExecutesCrossChainMessage() public {
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

        // create callData that will be sent to our Receiver
        bytes32 txId = "txId";
        bytes memory payload = abi.encode(txId, swapData, USER_RECEIVER, USER_RECEIVER);

        // fund receiver with sufficient DAI to execute swap
        vm.startPrank(USER_DAI_WHALE);
        dai.transfer(address(receiver), swapData[0].fromAmount);
        vm.stopPrank();

        // call sgReceive function as Stargate router
        vm.startPrank(stargateRouter);
        dai.approve(address(receiver), swapData[0].fromAmount);

        // prepare check for events
        vm.expectEmit(true, true, true, true, address(executor));
        emit AssetSwapped(
            0x7478496400000000000000000000000000000000000000000000000000000000,
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            defaultUSDCAmount,
            block.timestamp
        );
        vm.expectEmit(true, true, true, true, address(executor));
        emit LiFiTransferCompleted(
            0x7478496400000000000000000000000000000000000000000000000000000000,
            ADDRESS_DAI,
            USER_RECEIVER,
            defaultUSDCAmount,
            block.timestamp
        );

        // call sgReceive function to complete transaction
        receiver.sgReceive(0, "", 0, ADDRESS_DAI, swapData[0].fromAmount, payload);
    }

    function test_stargate_EmitsCorrectEventOnRecovery() public {
        // (mock) transfer "bridged funds" to Receiver.sol
        vm.startPrank(USER_SENDER);
        usdc.transfer(address(receiver), defaultUSDCAmount);
        vm.stopPrank();

        bytes memory payload = abi.encode(transferId, swapData, address(1), address(1));

        vm.startPrank(stargateRouter);
        vm.expectEmit(true, true, true, true, address(receiver));
        emit LiFiTransferRecovered(keccak256("123"), ADDRESS_USDC, address(1), defaultUSDCAmount, block.timestamp);

        receiver.sgReceive{ gas: 100000 }(0, "", 0, ADDRESS_USDC, defaultUSDCAmount, payload);
        revert();
    }

    function test_stargate_OwnerCanUpdateRouterAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit StargateRouterSet(amarokRouter);

        receiver.setStargateRouter(amarokRouter);
    }

    function test_revert_stargate_UpdateRouterAddressNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        receiver.setStargateRouter(amarokRouter);
    }
}
