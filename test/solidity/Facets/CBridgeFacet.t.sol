// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { CBridgeFacet, IMessageBus } from "lifi/Facets/CBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { Executor, IERC20Proxy } from "lifi/Periphery/Executor.sol";
import { ReceiverCelerIM } from "lifi/Periphery/ReceiverCelerIM.sol";
import { IMessageReceiverApp } from "celer-network/contracts/message/interfaces/IMessageReceiverApp.sol";
import { MsgDataTypes } from "celer-network/contracts/message/libraries/MessageSenderLib.sol";
import { DSTest } from "ds-test/test.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";

// Stub CBridgeFacet Contract
contract TestCBridgeFacet is CBridgeFacet {
    constructor(ICBridge _cBridge, IMessageBus _messageBus) CBridgeFacet(_cBridge, _messageBus) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract Setter {
    string public message;

    function setMessage(string calldata _message) external {
        message = _message;
    }
}

contract CBridgeFacetTest is DSTest, DiamondTest {
    event LiFiTransferCompleted(
        bytes32 indexed transactionId,
        address receivingAssetId,
        address receiver,
        uint256 amount,
        uint256 timestamp
    );
    event CBridgeMessageBusAddressSet(address indexed messageBusAddress);
    event CelerIMMessageExecuted(address indexed callTo, bytes4 selector);
    event CelerIMMessageWithTransferExecuted(bytes32 indexed transactionId, address indexed receiver);
    event CelerIMMessageWithTransferFailed(
        bytes32 indexed transactionId,
        address indexed receiver,
        address indexed refundAddress
    );
    event CelerIMMessageWithTransferRefunded(bytes32 indexed transactionId, address indexed refundAddress);

    address internal constant CBRIDGE_ROUTER = 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant WHALE = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;

    address internal constant DAI_WHALE = 0x5D38B4e4783E34e2301A2a36c39a03c45798C4dD;
    address internal constant CBRIDGE_MESSAGE_BUS_ETH = 0x4066D196A423b2b3B8B054f4F40efB47a74E200C;
    address internal constant CBRIDGE_MESSAGE_BUS_POLY = 0xaFDb9C40C7144022811F034EE07Ce2E110093fe6;
    address internal constant EXECUTOR = 0x4F6a9cACA8cd1e6025972Bcaf6BFD8504de69B52;

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestCBridgeFacet internal cBridge;
    ERC20 internal usdc;
    ERC20 internal dai;
    UniswapV2Router02 internal uniswap;
    Setter internal setter;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = vm.envUint("FORK_NUMBER");
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        cBridge = new TestCBridgeFacet(ICBridge(CBRIDGE_ROUTER), IMessageBus(CBRIDGE_MESSAGE_BUS_ETH));
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = cBridge.startBridgeTokensViaCBridge.selector;
        functionSelectors[1] = cBridge.swapAndStartBridgeTokensViaCBridge.selector;
        functionSelectors[2] = cBridge.addDex.selector;
        functionSelectors[3] = cBridge.setFunctionApprovalBySignature.selector;
        functionSelectors[4] = cBridge.executeMessageWithTransferRefund.selector;

        addFacet(diamond, address(cBridge), functionSelectors);

        cBridge = TestCBridgeFacet(address(diamond));
        cBridge.addDex(address(uniswap));
        cBridge.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
    }

    function testCanBridgeTokens() public {
        vm.startPrank(WHALE);
        usdc.approve(address(cBridge), 10_000 * 10**usdc.decimals());
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            USDC_ADDRESS,
            WHALE,
            10_000 * 10**usdc.decimals(),
            100,
            false,
            false
        );
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.Liquidity
        });

        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(DAI_WHALE);

        // Swap DAI -> USDC
        address[] memory path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = USDC_ADDRESS;

        uint256 amountOut = 1_000 * 10**usdc.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            USDC_ADDRESS,
            DAI_WHALE,
            amountOut,
            100,
            true,
            false
        );

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            1,
            abi.encode(address(0)),
            "",
            0,
            MsgDataTypes.BridgeSendType.Liquidity
        );

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(cBridge),
                block.timestamp + 20 minutes
            ),
            true
        );
        // Approve DAI
        dai.approve(address(cBridge), amountIn);
        cBridge.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, data);
        vm.stopPrank();
    }

    // CelerIM-related Tests
    function testCanExecuteMessageWithTransfer() public {
        address finalReceiver = address(0x12345678);

        uint256 amountOut = 100 * 10**usdc.decimals();

        // prepare dest swap data
        address executorAddress = address(new Executor(address(WHALE), address(0)));
        ReceiverCelerIM receiver = new ReceiverCelerIM(address(WHALE), CBRIDGE_MESSAGE_BUS_POLY, executorAddress);

        address[] memory path = new address[](2);
        path[0] = address(dai);
        path[1] = address(usdc);

        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapDataDest = new LibSwap.SwapData[](1);
        swapDataDest[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: address(dai),
            receivingAssetId: address(usdc),
            fromAmount: amountOut,
            callData: abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                executorAddress, // has same address across networks
                block.timestamp + 20 minutes
            ),
            requiresDeposit: false
        });

        bytes32 txId = "txId";
        bytes memory destCallData = abi.encode(
            txId, // transactionId
            swapDataDest, // swapData
            finalReceiver, // receiver
            finalReceiver // refundAddress
        );

        // prepare check for events
        vm.expectEmit(true, true, true, true, executorAddress);
        emit LiFiTransferCompleted(
            txId,
            address(dai), //! is this correct to be DAI here (bridge DAI, swap to USDC)
            finalReceiver,
            amountOut,
            block.timestamp
        );
        vm.expectEmit(true, true, true, true, address(receiver));
        emit CelerIMMessageWithTransferExecuted(txId, finalReceiver);

        // trigger dest side swap and bridging
        // (mock) send "bridged" tokens to Receiver
        vm.startPrank(DAI_WHALE);
        dai.transfer(address(receiver), amountIn);

        if (
            receiver.executeMessageWithTransfer(
                address(cBridge),
                address(dai),
                amountIn,
                1, //srcChainId
                destCallData,
                address(this)
            ) != IMessageReceiverApp.ExecutionStatus.Success
        ) revert("DB: Wrong return value");

        // check finalReceiver balance
        assertEq(usdc.balanceOf(finalReceiver), amountOut);
        vm.stopPrank();
    }

    function testCanExecuteMessageWithTransferFallBack() public {
        address finalReceiver = address(0x12345678);
        address refundAddress = address(0x65745345);

        uint256 amountOut = 100 * 10**usdc.decimals();

        // prepare dest swap data
        address executorAddress = address(new Executor(address(WHALE), address(0)));
        ReceiverCelerIM receiver = new ReceiverCelerIM(address(WHALE), CBRIDGE_MESSAGE_BUS_POLY, executorAddress);

        address[] memory path = new address[](2);
        path[0] = address(dai);
        path[1] = address(usdc);

        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bytes32 txId = "txId";
        bytes memory destCallData = abi.encode(
            txId, // transactionId
            "", // swapData
            finalReceiver, // receiver
            refundAddress // refundAddress
        );

        //? prepare check for events

        // trigger dest side swap and bridging
        // (mock) send "bridged" tokens to Receiver
        vm.startPrank(DAI_WHALE);
        dai.transfer(address(receiver), amountIn);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit CelerIMMessageWithTransferFailed(txId, finalReceiver, refundAddress);

        if (
            receiver.executeMessageWithTransferFallback(
                address(cBridge),
                address(dai),
                amountIn,
                1, //srcChainId
                destCallData,
                address(this)
            ) != IMessageReceiverApp.ExecutionStatus.Success
        ) revert("DB: Wrong return value returned by executeMessageWithTransferFallback()");

        // check balance
        assertEq(dai.balanceOf(refundAddress), amountIn);
        vm.stopPrank();
    }

    function testCanExecuteMessageWithTransferRefund() public {
        address finalReceiver = address(0x12345678);
        address refundAddress = address(0x65745345);

        uint256 amountOut = 100 * 10**usdc.decimals();

        // prepare dest swap data
        address executorAddress = address(new Executor(address(WHALE), address(0)));
        ReceiverCelerIM receiver = new ReceiverCelerIM(address(WHALE), CBRIDGE_MESSAGE_BUS_POLY, executorAddress);

        address[] memory path = new address[](2);
        path[0] = address(dai);
        path[1] = address(usdc);

        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bytes32 txId = "txId";
        bytes memory destCallData = abi.encode(
            txId, // transactionId
            "", // swapData
            finalReceiver, // receiver
            refundAddress // refundAddress
        );

        vm.expectEmit(true, true, true, true, address(cBridge));
        emit CelerIMMessageWithTransferRefunded(txId, refundAddress);

        // trigger dest side swap and bridging
        // (mock) send "bridged" tokens to Receiver
        vm.startPrank(DAI_WHALE);
        dai.transfer(address(cBridge), amountIn);
        vm.stopPrank();

        // call refund function from CBridge messageBus address
        vm.startPrank(CBRIDGE_MESSAGE_BUS_ETH);

        if (
            cBridge.executeMessageWithTransferRefund(address(dai), amountIn, destCallData, address(this)) !=
            IMessageReceiverApp.ExecutionStatus.Success
        ) revert("DB: Wrong return value");

        // check balance
        assertEq(dai.balanceOf(refundAddress), amountIn);
        vm.stopPrank();
    }

    //TODO remove or fix, depending on discussion with Ed
    function testCanExecuteMessageOnly() internal {
        setter = new Setter();
        address executorAddress = address(new Executor(address(WHALE), address(0)));
        ReceiverCelerIM receiver = new ReceiverCelerIM(address(WHALE), CBRIDGE_MESSAGE_BUS_ETH, executorAddress);

        emit log_named_address("address setter: ", address(setter));

        address sender = address(0x110011);
        uint64 srcChainId = 1;
        bytes memory callData = abi.encodePacked(
            address(setter),
            abi.encodeWithSignature("setMessage(string)", "lifi")
        );

        emit log_named_bytes("message in test", callData);
        receiver.executeMessage(address(this), srcChainId, callData, sender);

        assertEq(setter.message(), "lifi");
    }

    //TODO clarify implementation or remove
    function testCanExecuteArbitraryMessage() internal {
        address finalReceiver = address(0x12345678);
        FeeCollector feeCollector = new FeeCollector(address(this));

        uint256 amountOut = 150 * 10**usdc.decimals();

        // prepare bridge data
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "cbridge",
            integrator: "",
            referrer: address(0),
            sendingAssetId: address(dai),
            receiver: finalReceiver,
            minAmount: amountOut,
            destinationChainId: 137,
            hasSourceSwaps: false,
            hasDestinationCall: true
        });

        // prepare dest swap data
        address executorAddress = address(new Executor(address(WHALE), address(0)));
        ReceiverCelerIM receiver = new ReceiverCelerIM(address(WHALE), CBRIDGE_MESSAGE_BUS_POLY, executorAddress);

        LibSwap.SwapData[] memory swapDataDest = new LibSwap.SwapData[](1);
        swapDataDest[0] = LibSwap.SwapData({
            callTo: USDC_ADDRESS,
            approveTo: USDC_ADDRESS, //! ?
            sendingAssetId: USDC_ADDRESS,
            receivingAssetId: USDC_ADDRESS,
            fromAmount: amountOut,
            callData: abi.encodeWithSelector(usdc.transferFrom.selector, WHALE, finalReceiver, amountOut),
            requiresDeposit: false
        });

        bytes32 txId = "txId";
        bytes memory destCallData = abi.encode(
            txId, // transactionId
            swapDataDest, // swapData
            finalReceiver, // receiver
            finalReceiver // refundAddress
        );

        // prepare check for events
        // vm.expectEmit(true, true, true, true, executorAddress);
        // emit LiFiTransferCompleted(
        //     txId,
        //     address(dai),
        //     finalReceiver,
        //     amountOut,
        //     block.timestamp
        // );

        // trigger dest side swap and bridging
        // (mock) send "bridged" tokens to Receiver
        vm.startPrank(WHALE);
        usdc.approve(address(receiver), amountOut);

        if (
            receiver.executeMessage(
                WHALE,
                1, //srcChainId
                destCallData,
                address(this)
            ) != IMessageReceiverApp.ExecutionStatus.Success
        ) revert("DB: Wrong return value");

        // check finalReceiver balance
        assertEq(usdc.balanceOf(finalReceiver), amountOut);
        vm.stopPrank();
        // revert();
    }
}
