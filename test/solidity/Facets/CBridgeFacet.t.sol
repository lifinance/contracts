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
    event Deposited(
        bytes32 depositId,
        address depositor,
        address token,
        uint256 amount,
        uint64 mintChainId,
        address mintAccount
    );
    event Deposited(
        bytes32 depositId,
        address depositor,
        address token,
        uint256 amount,
        uint64 mintChainId,
        address mintAccount,
        uint64 nonce
    );
    event Burn(bytes32 burnId, address token, address account, uint256 amount, address withdrawAccount);
    event Burn(
        bytes32 burnId,
        address token,
        address account,
        uint256 amount,
        uint64 toChainId,
        address toAccount,
        uint64 nonce
    );
    address internal constant CBRIDGE_ROUTER = 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant USDC_WHALE = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;
    address internal constant DAI_WHALE = 0x5D38B4e4783E34e2301A2a36c39a03c45798C4dD;
    address internal constant CBRIDGE_MESSAGE_BUS_ETH = 0x4066D196A423b2b3B8B054f4F40efB47a74E200C;
    address internal constant CBRIDGE_MESSAGE_BUS_POLY = 0xaFDb9C40C7144022811F034EE07Ce2E110093fe6;
    address internal constant CBRIDGE_1_LIQUIDITY = 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant CBRIDGE_2_PEG_DEPOSIT = 0xB37D31b2A74029B5951a2778F959282E2D518595;
    address internal constant CBRIDGE_3_PEG_BURN = 0x16365b45EB269B5B5dACB34B4a15399Ec79b95eB;
    address internal constant CBRIDGE_4_PEG_V2_DEPOSIT = 0x7510792A3B1969F9307F3845CE88e39578f2bAE1;
    address internal constant CBRIDGE_5_PEG_V2_BURN = 0x52E4f244f380f8fA51816c8a10A63105dd4De084;
    address internal constant CBRIDGE_6_PEG_V2_BURNFROM = 0x52E4f244f380f8fA51816c8a10A63105dd4De084;
    address internal constant EXECUTOR = 0x4F6a9cACA8cd1e6025972Bcaf6BFD8504de69B52;

    enum BridgeSendType {
        Null,
        Liquidity,
        PegDeposit,
        PegBurn,
        PegV2Deposit,
        PegV2Burn,
        PegV2BurnFrom
    }
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestCBridgeFacet internal cBridge;
    ERC20 internal usdc;
    ERC20 internal dai;
    UniswapV2Router02 internal uniswap;

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

    // Test xLiquidity bridge
    function testCanBridgeTokens_Liquidity() public {
        vm.startPrank(USDC_WHALE);
        usdc.approve(address(cBridge), 10_000 * 10**usdc.decimals());
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            USDC_ADDRESS,
            USDC_WHALE,
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

    // Tests xAsset bridge
    function testCanBridgeTokens_PegDeposit() public {
        // related transaction: https://etherscan.io/tx/0x7897dc67293dace5b00f90a1f1e7f1c6a43c5d9ed00c4ce77f7984e40634492e
        uint64 targetChainId = 416;
        uint256 amountToBeBridged = 100 * 10**usdc.decimals();

        vm.startPrank(USDC_WHALE);
        usdc.approve(address(cBridge), amountToBeBridged);
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            USDC_ADDRESS,
            USDC_WHALE,
            amountToBeBridged,
            targetChainId,
            false,
            false
        );
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.PegDeposit
        });

        // calculate depId to check event
        bytes32 depId = keccak256(
            abi.encodePacked(
                address(cBridge),
                USDC_ADDRESS,
                amountToBeBridged,
                targetChainId,
                USDC_WHALE,
                data.nonce,
                uint64(block.chainid)
            )
        );

        vm.expectEmit(true, true, true, true, CBRIDGE_2_PEG_DEPOSIT);
        emit Deposited(depId, address(cBridge), USDC_ADDRESS, amountToBeBridged, targetChainId, USDC_WHALE);

        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        vm.stopPrank();
    }

    function testCanBridgeTokens_PegBurn() public {
        // related transaction: https://etherscan.io/tx/0xfd8b4324487625996fcd60c14b573dbc2c9cd4ccfa957eff0a046dada14654c1
        ERC20 testToken = ERC20(0x3f95E5099CF3A125145212Afd53039B8d8C5656e); //
        address withdrawAccount = address(0x1234);
        uint256 amountToBeBridged = 100 * 10**testToken.decimals();
        uint64 targetChainId = 0; //! ??

        address testTokenWhale = 0xB493e877fDd0CE531F2A129A08831efcEfA44fda;
        vm.startPrank(testTokenWhale);

        testToken.approve(address(cBridge), amountToBeBridged);
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            address(testToken),
            withdrawAccount,
            amountToBeBridged,
            targetChainId, //! ??
            false,
            false
        );
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.PegBurn
        });

        // calculate depId to check event
        bytes32 burnId = keccak256(
            abi.encodePacked(
                address(cBridge),
                address(testToken),
                amountToBeBridged,
                withdrawAccount,
                data.nonce,
                uint64(block.chainid)
            )
        );

        vm.expectEmit(true, true, true, true, CBRIDGE_3_PEG_BURN);
        emit Burn(burnId, address(testToken), address(cBridge), amountToBeBridged, withdrawAccount);

        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        vm.stopPrank();
    }

    function testCanBridgeTokens_PegV2Deposit() public {
        // related transaction: https://etherscan.io/tx/0xec4376009be12e4ae12a9f841bcc6b1a27d32a9073937eaa50f8367824e8ce4e
        ERC20 testToken = ERC20(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2); // WETH
        address receiver = address(0x1234);
        uint256 amountToBeBridged = 100 * 10**testToken.decimals();
        uint64 targetChainId = 592;

        address testTokenWhale = 0x2F0b23f53734252Bda2277357e97e1517d6B042A;
        vm.startPrank(testTokenWhale);

        testToken.approve(address(cBridge), amountToBeBridged);
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            address(testToken),
            receiver,
            amountToBeBridged,
            targetChainId, //! ??
            false,
            false
        );
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.PegV2Deposit
        });

        // calculate depId to check event
        bytes32 depId = keccak256(
            abi.encodePacked(
                address(cBridge),
                address(testToken),
                amountToBeBridged,
                targetChainId,
                bridgeData.receiver,
                data.nonce,
                uint64(block.chainid),
                CBRIDGE_4_PEG_V2_DEPOSIT
            )
        );

        vm.expectEmit(true, true, true, true, CBRIDGE_4_PEG_V2_DEPOSIT);
        emit Deposited(
            depId,
            address(cBridge),
            address(testToken),
            amountToBeBridged,
            targetChainId,
            receiver,
            data.nonce
        );

        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        vm.stopPrank();
    }

    //TODO needs fixing
    function testCanBridgeTokens_PegV2BurnUSDC() internal {
        // 0x52E4f244f380f8fA51816c8a10A63105dd4De084 >> CBRIDGE_5_PEG_V2_BURN
        // 0x317F8d18FB16E49a958Becd0EA72f8E153d25654 >> TestToken (cfUSDC)
        // 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 >> USDC (TokenProxy)
        // 0xa2327a938Febf5FEC13baCFb16Ae10EcBc4cbDCF >> Implementation for USDC TokenProxy
        // canonical == usdc

        // related transaction:https://etherscan.io/tx/0x6af78a9bc2b8c8bdb99fa2d141264832c4496a69e64dc6294213eaae66daa57a
        ERC20 testToken = ERC20(0x317F8d18FB16E49a958Becd0EA72f8E153d25654); // cfUSDC
        address receiver = address(0x1234);
        uint256 amountToBeBridged = 100 * 10**testToken.decimals();
        uint64 targetChainId = 12340001;
        address testTokenWhale = 0x317F8d18FB16E49a958Becd0EA72f8E153d25654; // only holder of cfUSDC

        // make sure user has USDC
        vm.startPrank(USDC_WHALE);
        usdc.transfer(receiver, amountToBeBridged);
        vm.stopPrank();

        // approve cfUSDC contract to pull USDC token from bridge
        //! how do we know in which cases we have such a weird setup where approval for another token is required in order to "burn" this one
        vm.startPrank(address(cBridge));
        usdc.approve(0x317F8d18FB16E49a958Becd0EA72f8E153d25654, amountToBeBridged); //! this must be done in our facet somehow
        vm.stopPrank();

        vm.startPrank(receiver);
        usdc.approve(address(cBridge), amountToBeBridged);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            address(usdc),
            receiver,
            amountToBeBridged,
            targetChainId,
            false,
            false
        );
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.PegV2Burn
        });

        // calculate depId to check event
        bytes32 burnId = keccak256(
            abi.encodePacked(
                address(cBridge),
                address(testToken),
                amountToBeBridged,
                targetChainId,
                bridgeData.receiver,
                data.nonce,
                uint64(block.chainid),
                CBRIDGE_5_PEG_V2_BURN
            )
        );

        vm.expectEmit(true, true, true, true, CBRIDGE_5_PEG_V2_BURN);
        emit Burn(
            burnId,
            address(testToken),
            address(cBridge),
            amountToBeBridged,
            targetChainId,
            bridgeData.receiver,
            data.nonce
        );

        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        vm.stopPrank();
    }

    //TODO needs fixing
    function testCanBridgeTokens_PegV2BurnSEAN() public {
        // 0x52E4f244f380f8fA51816c8a10A63105dd4De084 >> CBRIDGE_5_PEG_V2_BURN
        // 0xA719CB79Af39A9C10eDA2755E0938bCE35e9DE24 >> TestToken (SEAN)
        // related transaction: https://etherscan.io/tx/0x04e1406e3d39cf8a9a0bbef322c27eaac1dadb9aa054ff3e73b7d4973b29dfc1
        ERC20 testToken = ERC20(0xA719CB79Af39A9C10eDA2755E0938bCE35e9DE24); // SEAN
        address receiver = address(0x1234);
        console.log("here");
        console.log(testToken.symbol());

        uint256 amountToBeBridged = 100 * 10**testToken.decimals();
        console.log(amountToBeBridged);
        uint64 targetChainId = 12340001;
        address testTokenWhale = 0xD004AdB98DdcdD65c7B7d7cBA9579E2e1eD3129F;

        // make sure user has test token
        vm.startPrank(testTokenWhale);
        testToken.transfer(receiver, amountToBeBridged);
        vm.stopPrank();

        // approve bridge to spend testToken and initiate tx
        vm.startPrank(receiver);
        testToken.approve(address(cBridge), amountToBeBridged);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            address(testToken),
            receiver,
            amountToBeBridged,
            targetChainId,
            false,
            false
        );
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.PegV2Burn
        });

        // calculate burnId to check event
        bytes32 burnId = keccak256(
            abi.encodePacked(
                address(cBridge),
                address(testToken),
                amountToBeBridged,
                targetChainId,
                bridgeData.receiver,
                data.nonce,
                uint64(block.chainid),
                CBRIDGE_5_PEG_V2_BURN
            )
        );

        vm.expectEmit(true, true, true, true, CBRIDGE_5_PEG_V2_BURN);
        emit Burn(
            burnId,
            address(testToken),
            address(cBridge),
            amountToBeBridged,
            targetChainId,
            bridgeData.receiver,
            data.nonce
        );

        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        vm.stopPrank();
    }

    //TODO needs fixing - missing approval
    function testCanBridgeTokens_PegV2Burn_BEFOREFIX() internal {
        // 0x52E4f244f380f8fA51816c8a10A63105dd4De084 >> CBRIDGE_5_PEG_V2_BURN
        // 0x317F8d18FB16E49a958Becd0EA72f8E153d25654 >> TestToken (cfUSDC)
        // 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 >> USDC (TokenProxy)
        // 0xa2327a938Febf5FEC13baCFb16Ae10EcBc4cbDCF >> Implementation for USDC TokenProxy
        // canonical == usdc

        // related transaction:https://etherscan.io/tx/0x6af78a9bc2b8c8bdb99fa2d141264832c4496a69e64dc6294213eaae66daa57a
        ERC20 testToken = ERC20(0x317F8d18FB16E49a958Becd0EA72f8E153d25654); // cfUSDC
        address receiver = address(0x1234);
        uint256 amountToBeBridged = 100 * 10**testToken.decimals();
        uint64 targetChainId = 12340001;
        address testTokenWhale = 0x317F8d18FB16E49a958Becd0EA72f8E153d25654; // only holder of cfUSDC

        vm.startPrank(testTokenWhale);
        testToken.transfer(receiver, amountToBeBridged);
        vm.stopPrank();
        vm.startPrank(USDC_WHALE);
        usdc.transfer(receiver, amountToBeBridged);
        usdc.transfer(address(cBridge), amountToBeBridged);
        vm.stopPrank();
        vm.startPrank(address(cBridge));
        usdc.approve(0x317F8d18FB16E49a958Becd0EA72f8E153d25654, amountToBeBridged);
        vm.stopPrank();
        vm.startPrank(receiver);
        // testToken.approve(address(cBridge), amountToBeBridged);
        usdc.approve(address(cBridge), amountToBeBridged); // this one is not right
        usdc.approve(0x317F8d18FB16E49a958Becd0EA72f8E153d25654, amountToBeBridged); // this one is not right
        usdc.approve(0x52E4f244f380f8fA51816c8a10A63105dd4De084, amountToBeBridged); // this one is not right

        //TODO we are missing some approval here but which one?
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            address(usdc),
            receiver,
            amountToBeBridged,
            targetChainId, //! ??
            false,
            false
        );
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.PegV2Burn
        });

        // calculate depId to check event
        bytes32 burnId = keccak256(
            abi.encodePacked(
                address(cBridge),
                address(testToken),
                amountToBeBridged,
                targetChainId,
                bridgeData.receiver,
                data.nonce,
                uint64(block.chainid),
                CBRIDGE_5_PEG_V2_BURN
            )
        );

        vm.expectEmit(true, true, true, true, CBRIDGE_5_PEG_V2_BURN);
        emit Burn(
            burnId,
            address(testToken),
            address(cBridge),
            amountToBeBridged,
            targetChainId,
            bridgeData.receiver,
            data.nonce
        );

        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        vm.stopPrank();
    }

    //TODO needs fixing - missing approval
    function testCanBridgeTokens_PegV2BurnFrom() internal {
        // related transaction:https://etherscan.io/tx/0x6af78a9bc2b8c8bdb99fa2d141264832c4496a69e64dc6294213eaae66daa57a
        ERC20 testToken = ERC20(0x317F8d18FB16E49a958Becd0EA72f8E153d25654); // cfUSDC
        address receiver = address(0x1234);
        uint256 amountToBeBridged = 100 * 10**testToken.decimals();
        uint64 targetChainId = 12340001;
        address testTokenWhale = 0x317F8d18FB16E49a958Becd0EA72f8E153d25654; // only holder of cfUSDC

        vm.startPrank(testTokenWhale);
        testToken.transfer(receiver, amountToBeBridged);
        vm.stopPrank();
        vm.startPrank(receiver);

        testToken.approve(address(cBridge), amountToBeBridged);
        //TODO we are missing some approval here but which one?

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            address(testToken),
            receiver,
            amountToBeBridged,
            targetChainId, //! ??
            false,
            false
        );
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.PegV2BurnFrom
        });

        // calculate depId to check event
        bytes32 burnId = keccak256(
            abi.encodePacked(
                address(cBridge),
                address(testToken),
                amountToBeBridged,
                targetChainId,
                bridgeData.receiver,
                data.nonce,
                uint64(block.chainid),
                CBRIDGE_6_PEG_V2_BURNFROM
            )
        );

        vm.expectEmit(true, true, true, true, CBRIDGE_6_PEG_V2_BURNFROM);
        emit Burn(
            burnId,
            address(testToken),
            address(cBridge),
            amountToBeBridged,
            targetChainId,
            bridgeData.receiver,
            data.nonce
        );

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
    function testCanExecuteMessageWithTransferRefund() public {
        address finalReceiver = address(0x12345678);
        address refundAddress = address(0x65745345);

        uint256 amountOut = 100 * 10**usdc.decimals();

        // prepare dest swap data
        address executorAddress = address(new Executor(address(USDC_WHALE), address(0)));
        ReceiverCelerIM receiver = new ReceiverCelerIM(address(USDC_WHALE), CBRIDGE_MESSAGE_BUS_POLY, executorAddress);

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
}
