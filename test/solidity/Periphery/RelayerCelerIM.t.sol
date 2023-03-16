// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibSwap, LibAllowList, TestBase, console } from "../utils/TestBase.sol";
import { InvalidAmount, UnAuthorized, ExternalCallFailed } from "lifi/Errors/GenericErrors.sol";
import { CelerIMFacet, IMessageBus, MsgDataTypes } from "lifi/Facets/CelerIMFacet.sol";
import { IMessageReceiverApp } from "celer-network/contracts/message/interfaces/IMessageReceiverApp.sol";
import { IBridge as ICBridge } from "celer-network/contracts/interfaces/IBridge.sol";
import { RelayerCelerIM } from "lifi/Periphery/RelayerCelerIM.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";

interface Ownable {
    function owner() external returns (address);
}

contract RelayerCelerIMTest is TestBase {
    address internal constant CBRIDGE_ROUTER =
        0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant CBRIDGE_MESSAGEBUS_ETH =
        0x4066D196A423b2b3B8B054f4F40efB47a74E200C;
    CelerIMFacet.CelerIMData internal celerIMData;
    Executor internal executor;
    ERC20Proxy internal erc20Proxy;
    RelayerCelerIM internal relayer;

    function setUp() public {
        initTestBase();
        vm.label(CBRIDGE_ROUTER, "CBRIDGE_ROUTER");
        vm.label(CBRIDGE_MESSAGEBUS_ETH, "CBRIDGE_MESSAGEBUS_ETH");

        // deploy CelerIM Receiver
        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(this), address(erc20Proxy));
        relayer = new RelayerCelerIM(
            address(this),
            CBRIDGE_MESSAGEBUS_ETH,
            address(diamond)
        );

        celerIMData = CelerIMFacet.CelerIMData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.Liquidity
        });

        // add executor address in diamond periphery registry
        PeripheryRegistryFacet(address(diamond)).registerPeripheryContract("Executor", address(executor));
    }

    function test_canExecuteMessageOnDestChain() public {
        uint64 srcChainId = 137;

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

        // create callData that will be sent to our RelayerCelerIM (from CBridge MessageBus)
        bytes32 transactionId = 0x7472616e73616374696f6e496400000000000000000000000000000000000000;
        bytes memory payload = abi.encode(
            transactionId,
            swapData,
            USER_RECEIVER,
            USER_REFUND
        );

        // fund relayer with sufficient DAI to execute swap
        deal(ADDRESS_DAI, address(relayer), swapData[0].fromAmount);

        // call executeMessageWithTransfer function as CBridge MessageBus router
        vm.startPrank(CBRIDGE_MESSAGEBUS_ETH);

        // prepare check for events
        vm.expectEmit(true, true, true, true, address(executor));
        emit AssetSwapped(
            transactionId,
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            defaultUSDCAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, address(executor));
        emit LiFiTransferCompleted(
            transactionId,
            ADDRESS_DAI,
            USER_RECEIVER,
            defaultUSDCAmount,
            block.timestamp
        );

        // call function in RelayerCelerIM to complete transaction
        relayer.executeMessageWithTransfer(
            address(this),
            ADDRESS_DAI,
            swapData[0].fromAmount,
            srcChainId,
            payload,
            address(this)
        );
    }

    function test_Revert_CallExecuteMessageFromAnyAccount() public {
        uint64 srcChainId = 137;
        vm.startPrank(USER_SENDER);

        vm.expectRevert(UnAuthorized.selector);

        // call function in RelayerCelerIM to complete transaction
        relayer.executeMessageWithTransfer(
            address(this),
            ADDRESS_DAI,
            0,
            srcChainId,
            "",
            address(this)
        );
    }

    function test_Revert_CallExecuteMessageRefundFromAnyAccount() public {
        vm.startPrank(USER_SENDER);

        vm.expectRevert(UnAuthorized.selector);

        // call function in RelayerCelerIM to complete transaction
        relayer.executeMessageWithTransferRefund(
            ADDRESS_DAI,
            0,
            "",
            address(this)
        );
    }

    function test_WillRecoverToRefundAddressIfSwapFails() public {
        uint64 srcChainId = 137;

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
                sendingAssetId: ADDRESS_USDC,
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

        // create callData that will be sent to our RelayerCelerIM (from CBridge MessageBus)
        bytes32 transactionId = 0x7472616e73616374696f6e496400000000000000000000000000000000000000;
        bytes memory payload = abi.encode(
            transactionId,
            swapData,
            USER_RECEIVER,
            USER_REFUND
        );

        // fund relayer with sufficient DAI to execute swap
        deal(ADDRESS_DAI, address(relayer), swapData[0].fromAmount);

        // call executeMessageWithTransfer function as CBridge MessageBus router
        vm.startPrank(CBRIDGE_MESSAGEBUS_ETH);

        // prepare check for events
        vm.expectEmit(true, true, true, true, address(relayer));
        emit LiFiTransferRecovered(
            transactionId,
            ADDRESS_DAI,
            USER_REFUND,
            swapData[0].fromAmount,
            block.timestamp
        );

        // call function in RelayerCelerIM to complete transaction
        relayer.executeMessageWithTransfer(
            address(this),
            ADDRESS_DAI,
            swapData[0].fromAmount,
            srcChainId,
            payload,
            address(this)
        );
    }

    function test_WillProcessRefundOnSrcChainIfCalledByMessageBus() public {
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

        // create callData that will be sent to our diamond on srcChain (from CBridge MessageBus)
        bytes32 transactionId = 0x7472616e73616374696f6e496400000000000000000000000000000000000000;
        bytes memory payload = abi.encode(
            transactionId,
            swapData,
            USER_RECEIVER,
            USER_REFUND
        );

        // fund diamond with sufficient DAI to execute swap
        deal(ADDRESS_DAI, address(relayer), swapData[0].fromAmount);

        // call executeMessageWithTransfer function as CBridge MessageBus router
        vm.startPrank(CBRIDGE_MESSAGEBUS_ETH);

        // prepare check for events

        vm.expectEmit(true, true, true, true, address(relayer));
        emit LiFiTransferRecovered(
            transactionId,
            ADDRESS_DAI,
            USER_REFUND,
            swapData[0].fromAmount,
            block.timestamp
        );

        // call function in ReceiverCelerIM to complete transaction
        relayer.executeMessageWithTransferRefund(
            ADDRESS_DAI,
            swapData[0].fromAmount,
            payload,
            address(this)
        );
    }

    function test_CanReceiveNativeAssets() public {
        (bool success, ) = address(relayer).call{ value: 1 }("");
        if (!success) revert ExternalCallFailed();
    }
}
