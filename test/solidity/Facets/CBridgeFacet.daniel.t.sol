// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { CBridgeFacet, IMessageBus, MsgDataTypes, MessageSenderLib } from "lifi/Facets/CBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { Executor, IERC20Proxy } from "lifi/Periphery/Executor.sol";
import { Receiver } from "lifi/Periphery/Receiver.sol";
import { ReceiverCelerIM } from "lifi/Periphery/ReceiverCelerIM.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";

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

contract CBridgeFacetTestDaniel is DSTest, DiamondTest {
    event LiFiTransferStarted(ILiFi.BridgeData bridgeData);
    event MessageWithTransfer(
        address indexed sender,
        address receiver,
        uint256 dstChainId,
        address bridge,
        bytes32 srcTransferId,
        bytes message,
        uint256 fee
    );

    event LiFiTransferCompleted(
        bytes32 indexed transactionId,
        address receivingAssetId,
        address receiver,
        uint256 amount,
        uint256 timestamp
    );

        address internal constant CBRIDGE_ROUTER = 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
        address internal constant UNISWAP_V2_ROUTER_ETH = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
        address internal constant UNISWAP_V2_ROUTER_POLY = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
        address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
        address internal constant USDC_WHALE = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;
        address internal constant DAI_WHALE = 0x5D38B4e4783E34e2301A2a36c39a03c45798C4dD;
        address internal constant CBRIDGE_MESSAGE_BUS_ETH = 0x4066D196A423b2b3B8B054f4F40efB47a74E200C;
        address internal constant CBRIDGE_MESSAGE_BUS_POLY = 0xaFDb9C40C7144022811F034EE07Ce2E110093fe6;

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestCBridgeFacet internal cBridge;
    ERC20 internal usdc;
    ERC20 internal dai;
    UniswapV2Router02 internal uniswap;
    UniswapV2Router02 internal uniswap_poly;


    // tokenAddress > user > balance 
    mapping(address => mapping(AddressTypes => uint256)) public initialBalances;

    enum AddressTypes {
        // contracts
        DEX,
        DAI_TOKEN,
        USDC_TOKEN,
        EXECUTOR,
        RECEIVER,
        // wallets
        DEPLOYER,
        DAI_WHALE,
        USDC_WHALE,
        USER_1,
        USER_2
    }

    struct CurrentAccounts {
        address daiWhale; 
        address usdcWhale;
        UniswapV2Router02 dex;
        ERC20 daiToken;     //TODO change to address
        ERC20 usdcToken; 
        address deployer;
        address user1;
        address user2;
        address receiver;
        address executor;
    }
    
    // chainId => forkId
    mapping(uint256 => uint256) public forkIds;

    // chainId => type
    mapping(uint256 => mapping(AddressTypes => address)) public addressesPerChain;

    mapping(uint256 => string) public chainNames;

    // accounts per Chain
    mapping(uint256 => CurrentAccounts) _accounts2;     //! not used yet

    CurrentAccounts public _accounts;
    uint256 activeChainId;


    // functionality ideas
    // - deploy to various chains
    // - deployer account
    // - accounts mapping with addresses for each fork
    // - constants for all relevant addresses (tokens, whales, dexs, diamond, periphery) TODO: add LI.FI, CBridge, etc.
    // - produce standard swap data
    // - set up users with initial balance
    // -  modifier that re-activates current fork after function execution



    function setUp() public {

        initTestHelper();
        selectForkWithAccounts(1);

        diamond = createDiamond();
        cBridge = new TestCBridgeFacet(ICBridge(CBRIDGE_ROUTER), IMessageBus(CBRIDGE_MESSAGE_BUS_ETH));

        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER_ETH);
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = cBridge.startBridgeTokensViaCBridge.selector;
        functionSelectors[1] = cBridge.swapAndStartBridgeTokensViaCBridge.selector;
        functionSelectors[2] = cBridge.addDex.selector;
        functionSelectors[3] = cBridge.setFunctionApprovalBySignature.selector;
        functionSelectors[4] = cBridge.cBridgeMessageBus.selector;  //TODO remove

        addFacet(diamond, address(cBridge), functionSelectors);
        cBridge = TestCBridgeFacet(address(diamond));

        cBridge.addDex(address(uniswap));
        cBridge.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
    }

    //#region functions testFramework contract


    function initTestHelper() internal {
        // create forks
        forkIds[1] = vm.createFork(vm.envString("ETH_NODE_URI_MAINNET"), vm.envUint("FORK_NUMBER"));
        forkIds[56] = vm.createFork(vm.envString("ETH_NODE_URI_BSC"), vm.envUint("BSC_FORK_NUMBER"));
        forkIds[137] = vm.createFork(vm.envString("ETH_NODE_URI_POLYGON"), vm.envUint("POLYGON_FORK_NUMBER"));
        chainNames[forkIds[1]] = "MAINNET";
        chainNames[forkIds[56]] = "BSC";
        chainNames[forkIds[137]] = "POLYGON";

        // store addresses in mapping
        // mainnet
        addressesPerChain[1][AddressTypes.DAI_WHALE] = 0x5D38B4e4783E34e2301A2a36c39a03c45798C4dD;
        addressesPerChain[1][AddressTypes.USDC_WHALE] = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;
        addressesPerChain[1][AddressTypes.DEX] = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
        addressesPerChain[1][AddressTypes.USDC_TOKEN] = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        addressesPerChain[1][AddressTypes.DAI_TOKEN] = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
        addressesPerChain[1][AddressTypes.EXECUTOR] = 0x4F6a9cACA8cd1e6025972Bcaf6BFD8504de69B52;
        addressesPerChain[1][AddressTypes.RECEIVER] = 0x1b107DfdD93B8A8D305F043543766Eaa160E0A0B;
        addressesPerChain[1][AddressTypes.USER_1] = 0x288e1bB700d73e5FeA070a4C90Fec6CD5ef42D29;
        addressesPerChain[1][AddressTypes.USER_2] = 0x75cfB84cf6A92Cc41007A94028D0B2D8beb7ccEf;

        // todo bsc 
        // addressesPerChain[56][AddressTypes.DAI_WHALE] = ;
        // addressesPerChain[56][AddressTypes.USDC_WHALE] = ;
        // addressesPerChain[56][AddressTypes.DEX] = ;
        // addressesPerChain[56][AddressTypes.USDC_TOKEN] = ;
        // addressesPerChain[56][AddressTypes.DAI_TOKEN] = ;
        // addressesPerChain[56][AddressTypes.EXECUTOR] = 0x4F6a9cACA8cd1e6025972Bcaf6BFD8504de69B52;
        // addressesPerChain[56][AddressTypes.RECEIVER] = 0x1b107DfdD93B8A8D305F043543766Eaa160E0A0B;


        // polygon
        addressesPerChain[137][AddressTypes.DAI_WHALE] = 0xd7052EC0Fe1fe25b20B7D65F6f3d490fCE58804f;
        addressesPerChain[137][AddressTypes.USDC_WHALE] = 0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245;
        addressesPerChain[137][AddressTypes.DEX] = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
        addressesPerChain[137][AddressTypes.USDC_TOKEN] = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
        addressesPerChain[137][AddressTypes.DAI_TOKEN] = 0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063;
        addressesPerChain[137][AddressTypes.EXECUTOR] = 0x4F6a9cACA8cd1e6025972Bcaf6BFD8504de69B52;
        addressesPerChain[137][AddressTypes.RECEIVER] = 0x1b107DfdD93B8A8D305F043543766Eaa160E0A0B;
        addressesPerChain[137][AddressTypes.USER_1] = 0x288e1bB700d73e5FeA070a4C90Fec6CD5ef42D29;
        addressesPerChain[137][AddressTypes.USER_2] = 0x75cfB84cf6A92Cc41007A94028D0B2D8beb7ccEf;

    }

    function _selectForkWithChainId(uint256 chainId) private {
        // chainId 1 will be the first fork and has forkId 0
        if(chainId != 1 && forkIds[chainId] == 0) revert("DB: fork does not exist");
        vm.selectFork(forkIds[chainId]);
        activeChainId = chainId;
        console.log("");
        console.log("-------------------------");
        console.log("%s fork (chainId: %s) with forkID %s selected", chainNames[forkIds[chainId]], chainId, forkIds[chainId]);
    }

    // activates fork with given ID and updates all accounts with chainId-specific addresses
    function selectForkWithAccounts(uint256 chainId) internal {
        _selectForkWithChainId(chainId);
        _accounts.daiWhale = addressesPerChain[chainId][AddressTypes.DAI_WHALE];
        _accounts.usdcWhale = addressesPerChain[chainId][AddressTypes.USDC_WHALE];
        _accounts.dex = UniswapV2Router02(addressesPerChain[chainId][AddressTypes.DEX]);
        _accounts.daiToken = ERC20(addressesPerChain[chainId][AddressTypes.DAI_TOKEN]);
        _accounts.usdcToken = ERC20(addressesPerChain[chainId][AddressTypes.USDC_TOKEN]);
        _accounts.user1 = addressesPerChain[chainId][AddressTypes.USER_1];
        _accounts.user2 = addressesPerChain[chainId][AddressTypes.USER_2];
        _accounts.executor = addressesPerChain[chainId][AddressTypes.EXECUTOR];
        _accounts.receiver = addressesPerChain[chainId][AddressTypes.RECEIVER];
    }

    function printAllAccounts() internal  {
        console.log("-------------------------");
        console.log("Current addresses for %s fork with id %s", chainNames[vm.activeFork()], vm.activeFork());
        console.log("DAI Whale      :", addressesPerChain[activeChainId][AddressTypes.DAI_WHALE]);
        console.log("USDC Whale     :", addressesPerChain[activeChainId][AddressTypes.USDC_WHALE]);
        console.log("DEX            :", addressesPerChain[activeChainId][AddressTypes.DEX]);
        console.log("USDC Token     :", addressesPerChain[activeChainId][AddressTypes.USDC_TOKEN]);
        console.log("DAI Token      :", addressesPerChain[activeChainId][AddressTypes.DAI_TOKEN]);
        console.log("User 1         :", addressesPerChain[activeChainId][AddressTypes.USER_1]);
        console.log("User 2         :", addressesPerChain[activeChainId][AddressTypes.USER_2]);
        console.log("Executor       :", addressesPerChain[activeChainId][AddressTypes.EXECUTOR]);
        console.log("Receiver       :", addressesPerChain[activeChainId][AddressTypes.RECEIVER]);
        console.log("-------------------------");
    }

    function setInitialBalances() internal {
        //TODO use for loop
        initialBalances[address(address(_accounts.usdcToken))][AddressTypes.DAI_WHALE] = getBalanceUSDC(_accounts.daiWhale);
        initialBalances[address(_accounts.daiToken)][AddressTypes.DAI_WHALE] = getBalanceDAI(_accounts.daiWhale);
        initialBalances[address(_accounts.usdcToken)][AddressTypes.USDC_WHALE] = getBalanceUSDC(_accounts.usdcWhale);
        initialBalances[address(_accounts.daiToken)][AddressTypes.USDC_WHALE] = getBalanceDAI(_accounts.usdcWhale);
        initialBalances[address(_accounts.usdcToken)][AddressTypes.EXECUTOR] = getBalanceUSDC(_accounts.executor);
        initialBalances[address(_accounts.daiToken)][AddressTypes.EXECUTOR] = getBalanceDAI(_accounts.executor);
        initialBalances[address(_accounts.usdcToken)][AddressTypes.RECEIVER] = getBalanceUSDC(_accounts.receiver);
        initialBalances[address(_accounts.daiToken)][AddressTypes.RECEIVER] = getBalanceDAI(_accounts.receiver);
        initialBalances[address(_accounts.usdcToken)][AddressTypes.USER_1] = getBalanceUSDC(_accounts.user1);
        initialBalances[address(_accounts.daiToken)][AddressTypes.USER_1] = getBalanceDAI(_accounts.user1);
        initialBalances[address(_accounts.usdcToken)][AddressTypes.USER_2] = getBalanceUSDC(_accounts.user2);
        initialBalances[address(_accounts.daiToken)][AddressTypes.USER_2] = getBalanceDAI(_accounts.user2);
    }

    function printBalances() internal view {
        console.log("-----------printBalances--------------");
        console.log("Balance_USDC_DAI_WHALE:  %s", _accounts.usdcToken.balanceOf(_accounts.daiWhale));
        console.log("Balance_DAI__DAI_WHALE:  %s", _accounts.daiToken.balanceOf(_accounts.daiWhale));
        console.log("Balance_USDC_USDC_WHALE: %s", _accounts.usdcToken.balanceOf(_accounts.usdcWhale));
        console.log("Balance_DAI__USDC_WHALE: %s", _accounts.daiToken.balanceOf(_accounts.usdcWhale));
    }

    function getBalanceUSDC(address user) internal view returns (uint256) {
        return _accounts.usdcToken.balanceOf(user);
    }

    function getBalanceDAI(address user) internal view returns (uint256) {
        return _accounts.daiToken.balanceOf(user);
    }

    function deployReceiverAndExecutor() internal {
        _accounts.executor = address(new Executor(address(_accounts.usdcWhale), address(0)));
        // _accounts.receiver = address(new Receiver(address(_accounts.usdcWhale), address(0), address(_accounts.executor)));
        _accounts.receiver = address(new ReceiverCelerIM(address(_accounts.usdcWhale), CBRIDGE_MESSAGE_BUS_POLY, address(_accounts.executor)));
    }

    function assertNoBalanceChangeInDAI(AddressTypes user) internal returns (bool) {
        // TODO
        // return initialBalances[address(_accounts.daiToken)][user] == _accounts.daiToken.balanceOf(user);
    }

    //#endregion

    //#region Working Tests

    // function testCanBridgeTokens(uint32 amount) public {
    //     vm.startPrank(DAI_WHALE);
    //     vm.assume(amount < 10000 && amount > 50);
    //     usdc.approve(address(cBridge), 10_000 * 10**usdc.decimals());
    //     uint256 initialBalance = usdc.balanceOf(DAI_WHALE);

    //     uint256 amountOut = 50 * 10**usdc.decimals();   
    //     // uint256 amountOut = amount * 10**usdc.decimals(); //TODO why tests run so long?

    //     // prepare bridge data
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
    //         transactionId:          "",
    //         bridge:                 "cbridge",
    //         integrator:             "",
    //         referrer:               address(0),
    //         sendingAssetId:         USDC_ADDRESS,
    //         receiver:               DAI_WHALE,
    //         minAmount:              amountOut,
    //         destinationChainId:     100,
    //         hasSourceSwaps:         false,
    //         hasDestinationCall:     false
    //     });

    //     // calculate nonce as recommended by CBridge
    //     //TODO check with docs
    //     uint64 nonce = uint64(uint(keccak256(abi.encodePacked(
    //             block.timestamp,
    //             msg.sender,
    //             block.number
    //     ))));


    //     // prepare cBridgeData
    //     CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData({
    //         maxSlippage:    5000,
    //         nonce:          nonce,
    //         callTo:         abi.encodePacked(address(0)),
    //         callData:       "",
    //         messageBusFee:  0,
    //         bridgeType:     MsgDataTypes.BridgeSendType.Liquidity
    //     });   


    //     // check if LiFiTransferStarted event will be emitted by our contract with correct data
    //     vm.expectEmit(true, true, true, true, address(cBridge));
    //     emit LiFiTransferStarted(bridgeData);
    //     cBridge.startBridgeTokensViaCBridge(bridgeData, cBridgeData);

    //     // check balances
    //     assertEq(initialBalance - amountOut, usdc.balanceOf(DAI_WHALE));
    //     vm.stopPrank();
    // }

    // function testCanBridgeNativeTokens(uint32 amount) public {
    //     vm.startPrank(DAI_WHALE);
    //     vm.assume(amount < 10000 && amount > 50);

    //     uint256 amountOut = 50 * 10**18;   
    //     // uint256 amountOut = amount * 10**18; //TODO why tests run so long?

    //     vm.deal(DAI_WHALE, amountOut);
    //     uint256 initialBalance = address(this).balance;

    //     // prepare bridge data
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
    //         transactionId:          "",
    //         bridge:                 "cbridge",
    //         integrator:             "",
    //         referrer:               address(0),
    //         sendingAssetId:         address(0),    // address(0) == native asset ID
    //         receiver:               DAI_WHALE,
    //         minAmount:              amountOut,
    //         destinationChainId:     100,
    //         hasSourceSwaps:         false,
    //         hasDestinationCall:     false
    //     });

    //     // calculate nonce as recommended by CBridge
    //     //TODO check with docs
    //     uint64 nonce = uint64(uint(keccak256(abi.encodePacked(
    //             block.timestamp,
    //             msg.sender,
    //             block.number
    //     ))));


    //     // prepare cBridgeData
    //     CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData({
    //         maxSlippage:    5000,
    //         nonce:          nonce,
    //         callTo:         abi.encodePacked(address(0)),
    //         callData:       "",
    //         messageBusFee:  0,
    //         bridgeType:     MsgDataTypes.BridgeSendType.Liquidity
    //     });   


    //     // check if LiFiTransferStarted event will be emitted by our contract with correct data
    //     vm.expectEmit(true, true, true, true, address(cBridge));
    //     emit LiFiTransferStarted(bridgeData);
    //     cBridge.startBridgeTokensViaCBridge{value: amountOut}(bridgeData, cBridgeData);

    //     // check balances (vague assertion due to gas costs for call)
    //     assertLe(initialBalance - amountOut, address(this).balance);
    //     vm.stopPrank();
    // }

    // function testCanBridgeTokensAndSendMessage(uint32 amount) public {
    //     vm.startPrank(DAI_WHALE);
    //     vm.assume(amount < 10000 && amount > 50);


    //     uint256 amountOut = 50 * 10**18;   
    //     // uint256 amountOut = amount * 10**18; //TODO why tests run so long?

    //     dai.approve(address(cBridge), 10_000 * 10**dai.decimals());
    //     uint256 initialBalance = dai.balanceOf(DAI_WHALE);

    //     // prepare bridge data
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
    //         transactionId:          "",
    //         bridge:                 "cbridge",
    //         integrator:             "",
    //         referrer:               address(0),
    //         sendingAssetId:         DAI_ADDRESS,    // address(0) == native asset ID
    //         receiver:               DAI_WHALE,
    //         minAmount:              amountOut,
    //         destinationChainId:     100,
    //         hasSourceSwaps:         false,
    //         hasDestinationCall:     true
    //     });

    //     // calculate nonce as recommended by CBridge
    //     //TODO check with docs
    //     uint64 nonce = uint64(uint(keccak256(abi.encodePacked(
    //             block.timestamp,
    //             msg.sender,
    //             block.number
    //     ))));

    //     // prepare callData for dest call
    //     // Swap USDC > DAI at dest 
    //     //! (should use dest chain addresses here)
    //     address[] memory pathDest = new address[](2);
    //     pathDest[0] = USDC_ADDRESS;
    //     pathDest[1] = DAI_ADDRESS;
    //     bytes memory destCallData = abi.encodeWithSelector(
    //         uniswap.swapExactTokensForTokens.selector,
    //         1000,
    //         0,
    //         pathDest,
    //         address(cBridge),
    //         block.timestamp + 20 minutes
    //     );

    //     // Calculate messageBusFee based on message length
    //     uint256 messageBusFee = IMessageBus(CBRIDGE_MESSAGE_BUS_ETH).calcFee(destCallData);

    //     // prepare cBridgeData
    //     CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData({
    //         maxSlippage:    5000,
    //         nonce:          nonce,
    //         // callTo:         abi.encodePacked(address(UNISWAP_V2_ROUTER_ETH)),
    //         callTo:         abi.encodePacked(address(UNISWAP_V2_ROUTER_POLY)),  //TODO receiver?
    //         callData:       destCallData,
    //         messageBusFee:  messageBusFee,
    //         bridgeType:     MsgDataTypes.BridgeSendType.Liquidity
    //     });   

    //     // check if function call emits events
    //         // calculate transferId as it will be produced during bridging
    //     bytes32 transferId = keccak256(
    //             abi.encodePacked(
    //                 address(cBridge),
    //                 bridgeData.receiver,
    //                 bridgeData.sendingAssetId,
    //                 bridgeData.minAmount,
    //                 uint64(bridgeData.destinationChainId),
    //                 cBridgeData.nonce, 
    //                 uint64(block.chainid)
    //             )
    //     );

    //         // check if MessageWithTransfer event will be emitted by MessageBus with correct data
    //     vm.expectEmit(true, false, false, true, CBRIDGE_MESSAGE_BUS_ETH);
    //     emit MessageWithTransfer(
    //         address(cBridge),
    //         bridgeData.receiver,
    //         bridgeData.destinationChainId,
    //         CBRIDGE_ROUTER,
    //         transferId,
    //         destCallData,
    //         messageBusFee
    //     );  

    //     // check if LiFiTransferStarted event will be emitted by our contract with correct data
    //     vm.expectEmit(true, true, true, true, address(cBridge));
    //     emit LiFiTransferStarted(bridgeData);
    //     cBridge.startBridgeTokensViaCBridge{value: messageBusFee}(bridgeData, cBridgeData);

    //     // check balances (vague assertion due to gas costs for call)
    //     assertLe(initialBalance - amountOut - messageBusFee, address(this).balance);
    //     vm.stopPrank();
    // }

    // function testCanBridgeNativeTokensAndSendMessage(uint32 amount) public {
    //     vm.startPrank(DAI_WHALE);
    //     vm.assume(amount < 10000 && amount > 50);

    //     uint256 amountOut = 50 * 10**18;   
    //     // uint256 amountOut = amount * 10**18; //TODO why tests run so long?

    //     vm.deal(DAI_WHALE, 1000000 ether);
    //     uint256 initialBalance = address(this).balance;

    //     // prepare bridge data
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
    //         transactionId:          "",
    //         bridge:                 "cbridge",
    //         integrator:             "",
    //         referrer:               address(0),
    //         sendingAssetId:         address(0),    // address(0) == native asset ID
    //         receiver:               DAI_WHALE,
    //         minAmount:              amountOut,
    //         destinationChainId:     100,
    //         hasSourceSwaps:         false,
    //         hasDestinationCall:     true
    //     });

    //     // calculate nonce as recommended by CBridge
    //     //TODO check with docs
    //     uint64 nonce = uint64(uint(keccak256(abi.encodePacked(
    //             block.timestamp,
    //             msg.sender,
    //             block.number
    //     ))));

    //     // prepare callData for dest call
    //     // Swap USDC > DAI at dest 
    //     //! (should use dest chain addresses here)
    //     address[] memory pathDest = new address[](2);
    //     pathDest[0] = USDC_ADDRESS;
    //     pathDest[1] = DAI_ADDRESS;
    //     bytes memory destCallData = abi.encodeWithSelector(
    //         uniswap.swapExactTokensForTokens.selector,
    //         1000,
    //         0,
    //         pathDest,
    //         address(cBridge),
    //         block.timestamp + 20 minutes
    //     );

    //     // Calculate messageBusFee based on message length
    //     uint256 messageBusFee = IMessageBus(CBRIDGE_MESSAGE_BUS_ETH).calcFee(destCallData);

    //     // prepare cBridgeData
    //     CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData({
    //         maxSlippage:    5000,
    //         nonce:          nonce,
    //         callTo:         abi.encodePacked(address(UNISWAP_V2_ROUTER_ETH)),   //TODO change to receiver
    //         callData:       destCallData,
    //         messageBusFee:  messageBusFee,
    //         bridgeType:     MsgDataTypes.BridgeSendType.Liquidity
    //     });   

    //     // check if function call emits events
    //         // calculate transferId as it will be produced during bridging
    //     bytes32 transferId = keccak256(
    //             abi.encodePacked(
    //                 address(cBridge),
    //                 bridgeData.receiver,
    //                 bridgeData.sendingAssetId,
    //                 bridgeData.minAmount,
    //                 uint64(bridgeData.destinationChainId),
    //                 cBridgeData.nonce, 
    //                 uint64(block.chainid)
    //             )
    //     );

    //         // check if MessageWithTransfer event will be emitted by MessageBus with correct data
    //     vm.expectEmit(true, false, false, true, CBRIDGE_MESSAGE_BUS_ETH);
    //     emit MessageWithTransfer(
    //         address(cBridge),
    //         bridgeData.receiver,
    //         bridgeData.destinationChainId,
    //         CBRIDGE_ROUTER,
    //         transferId,
    //         destCallData,
    //         messageBusFee
    //     );  

    //     // check if LiFiTransferStarted event will be emitted by our contract with correct data
    //     vm.expectEmit(true, true, true, true, address(cBridge));
    //     emit LiFiTransferStarted(bridgeData);
    //     cBridge.startBridgeTokensViaCBridge{value: amountOut + messageBusFee}(bridgeData, cBridgeData);

    //     // check balances (vague assertion due to gas costs for call)
    //     assertLe(initialBalance - amountOut - messageBusFee, address(this).balance);
    //     vm.stopPrank();
    // }

    // function testCanSwapAndBridgeTokens(uint32 amount) public {
    //     vm.startPrank(DAI_WHALE);
    //     vm.assume(amount < 10000 && amount > 50);
    //     usdc.approve(address(cBridge), 10_000 * 10**usdc.decimals());
    //     dai.approve(address(cBridge), 10_000 * 10**dai.decimals());
    //     uint256 initialBalance = dai.balanceOf(DAI_WHALE);

    //     // Swap DAI -> USDC
    //     address[] memory pathSrc = new address[](2);
    //     pathSrc[0] = DAI_ADDRESS;
    //     pathSrc[1] = USDC_ADDRESS;

    //     uint256 amountOut = 50 * 10**usdc.decimals();   
    //     // uint256 amountOut = amount * 10**usdc.decimals(); //TODO why tests run so long?

    //     // Calculate DAI amount
    //     uint256[] memory amounts = uniswap.getAmountsIn(amountOut, pathSrc);
    //     uint256 amountIn = amounts[0];
    //     dai.approve(address(cBridge), amountIn);

    //     // prepare swap data for swap at src chain  (DAI > USDC)
    //     LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
    //     swapData[0] = LibSwap.SwapData({
    //         callTo:             address(uniswap),
    //         approveTo:          address(uniswap),
    //         sendingAssetId:     DAI_ADDRESS,
    //         receivingAssetId:   USDC_ADDRESS,
    //         fromAmount:         amountIn,
    //         callData:           abi.encodeWithSelector(
    //                                 uniswap.swapExactTokensForTokens.selector,
    //                                 amountIn,
    //                                 amountOut,
    //                                 pathSrc,
    //                                 address(cBridge),
    //                                 block.timestamp + 20 minutes
    //                             ),
    //         requiresDeposit:    true
    //     });

    //     // prepare bridge data
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
    //         transactionId:          "",
    //         bridge:                 "cbridge",
    //         integrator:             "",
    //         referrer:               address(0),
    //         sendingAssetId:         USDC_ADDRESS,
    //         receiver:               DAI_WHALE,
    //         minAmount:              amountOut,
    //         destinationChainId:     100,
    //         hasSourceSwaps:         true,
    //         hasDestinationCall:     false
    //     });

    //     // calculate nonce as recommended by CBridge
    //     uint64 nonce = uint64(uint(keccak256(abi.encodePacked(
    //             block.timestamp,
    //             msg.sender,
    //             block.number
    //     ))));

    //     // prepare cBridgeData
    //     CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData({
    //         maxSlippage:    5000,
    //         nonce:          nonce,
    //         callTo:         abi.encodePacked(address(0)),
    //         callData:       "",
    //         messageBusFee:  0,
    //         bridgeType:     MsgDataTypes.BridgeSendType.Liquidity
    //     });   

    //     // check if LiFiTransferStarted event will be emitted by our contract with correct data
    //     vm.expectEmit(true, true, true, true, address(cBridge));
    //     emit LiFiTransferStarted(bridgeData);
    //     cBridge.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, cBridgeData);

    //     // check balances
    //     assertEq(initialBalance - amountIn, dai.balanceOf(DAI_WHALE));
    //     vm.stopPrank();
    // }

    // function testCanSwapAndBridgeTokensAndSendMessage(uint32 amount) public {
    //     vm.startPrank(DAI_WHALE);
    //     vm.assume(amount < 10000 && amount > 50);
    //     dai.approve(address(cBridge), 10_000 * 10**dai.decimals());
    //     uint256 initialBalance = dai.balanceOf(DAI_WHALE);

    //     // Swap DAI -> USDC
    //     address[] memory pathSrc = new address[](2);
    //     pathSrc[0] = DAI_ADDRESS;
    //     pathSrc[1] = USDC_ADDRESS;

    //     uint256 amountOut = 50 * 10**usdc.decimals();   
    //     // uint256 amountOut = amount * 10**usdc.decimals(); //TODO why tests run so long?

    //     // Calculate DAI amount
    //     uint256[] memory amounts = uniswap.getAmountsIn(amountOut, pathSrc);
    //     uint256 amountIn = amounts[0];
    //     dai.approve(address(cBridge), amountIn);

    //     // prepare swap data for swap at src chain  (DAI > USDC)
    //     LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
    //     swapData[0] = LibSwap.SwapData({
    //         callTo:             address(uniswap),
    //         approveTo:          address(uniswap),
    //         sendingAssetId:     DAI_ADDRESS,
    //         receivingAssetId:   USDC_ADDRESS,
    //         fromAmount:         amountIn,
    //         callData:           abi.encodeWithSelector(
    //                                 uniswap.swapExactTokensForTokens.selector,
    //                                 amountIn,
    //                                 amountOut,
    //                                 pathSrc,
    //                                 address(cBridge),
    //                                 block.timestamp + 20 minutes
    //                             ),
    //         requiresDeposit:    true
    //     });

    //     // prepare bridge data
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
    //         transactionId:          "",
    //         bridge:                 "cbridge",
    //         integrator:             "",
    //         referrer:               address(0),
    //         sendingAssetId:         USDC_ADDRESS,
    //         receiver:               DAI_WHALE,
    //         minAmount:              amountOut,
    //         destinationChainId:     100,
    //         hasSourceSwaps:         true,
    //         hasDestinationCall:     true
    //     });

    //     // prepare callData for dest call
    //     // Swap USDC > DAI at dest 
    //     //! (should use dest chain addresses here)
    //     address[] memory pathDest = new address[](2);
    //     pathDest[0] = USDC_ADDRESS;
    //     pathDest[1] = DAI_ADDRESS;
    //     bytes memory destCallData = abi.encodeWithSelector(
    //         uniswap.swapExactTokensForTokens.selector,
    //         amountIn,
    //         amountOut,
    //         pathDest,
    //         address(cBridge),
    //         block.timestamp + 20 minutes
    //     );

    //     // Calculate messageBusFee based on message length
    //     uint256 messageBusFee = IMessageBus(CBRIDGE_MESSAGE_BUS_ETH).calcFee(destCallData);
        
    //     // calculate nonce as recommended by CBridge
    //     uint64 nonce = uint64(uint(keccak256(abi.encodePacked(
    //             block.timestamp,
    //             msg.sender,
    //             block.number
    //     ))));

    //     // prepare cBridgeData
    //     CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData({
    //         maxSlippage:    5000,
    //         nonce:          nonce,

    //         callTo:         abi.encodePacked(address(UNISWAP_V2_ROUTER_ETH)), //TODO change to receiver?
    //         callData:       destCallData,
    //         messageBusFee:  messageBusFee,
    //         bridgeType:     MsgDataTypes.BridgeSendType.Liquidity
    //     });   

    //     // check if function call emits events
    //         // calculate transferId as it will be produced during bridging
    //     bytes32 transferId = keccak256(
    //             abi.encodePacked(
    //                 address(cBridge),
    //                 bridgeData.receiver,
    //                 bridgeData.sendingAssetId,
    //                 bridgeData.minAmount,
    //                 uint64(bridgeData.destinationChainId),
    //                 cBridgeData.nonce, 
    //                 uint64(block.chainid)
    //             )
    //     );

    //         // check if MessageWithTransfer event will be emitted by MessageBus with correct data
    //     vm.expectEmit(true, false, false, true, CBRIDGE_MESSAGE_BUS_ETH);
    //     emit MessageWithTransfer(
    //         address(cBridge),
    //         bridgeData.receiver,
    //         bridgeData.destinationChainId,
    //         CBRIDGE_ROUTER,
    //         transferId,
    //         destCallData,
    //         messageBusFee
    //     );
    //         // check if LiFiTransferStarted event will be emitted by our contract with correct data
    //     vm.expectEmit(true, true, true, true, address(cBridge));
    //     emit LiFiTransferStarted(bridgeData);
    //     cBridge.swapAndStartBridgeTokensViaCBridge{value:messageBusFee}(bridgeData, swapData, cBridgeData);

    //     // check balances
    //     assertEq(initialBalance - amountIn, dai.balanceOf(DAI_WHALE));
    //     vm.stopPrank();
    // }

    //#endregion

    //#region cross-chain tests 
        // describe and prepare scenario
        // SOURCE (chainId 1 - Ethereum mainnet):
        //  1) swap USDC to 100 DAI
        //  2) bridge DAI 
        // DEST (chainId 137 - POLYGON):
        //  3) receive DAI from bridging
        //  4) swap DAI to USDC

    // function testCrossChainTestCaseSrc(uint32 amount) public {
    //     console.log("in testCrossChainTestCase");
    //     vm.startPrank(_accounts.usdcWhale);

    //     // prepare source swap data
    //     address[] memory pathSrc = new address[](2);
    //     pathSrc[0] = address(_accounts.usdcToken);
    //     pathSrc[1] = address(_accounts.daiToken);

    //     uint256 amountOut = 100 * 10**dai.decimals();   

    //     // Calculate USDC amount
    //     uint256[] memory amounts = _accounts.dex.getAmountsIn(amountOut, pathSrc);
    //     uint256 amountIn = amounts[0];

    //     _accounts.usdcToken.approve(address(cBridge), amountIn);

    //     LibSwap.SwapData[] memory swapDataSrc = new LibSwap.SwapData[](1);
    //     swapDataSrc[0] = LibSwap.SwapData({
    //         callTo:             address(uniswap),
    //         approveTo:          address(uniswap),
    //         sendingAssetId:     address(_accounts.usdcToken),
    //         receivingAssetId:   address(_accounts.daiToken),
    //         fromAmount:         amountIn,
    //         callData:           abi.encodeWithSelector(
    //                                 uniswap.swapExactTokensForTokens.selector,
    //                                 amountIn,
    //                                 amountOut,
    //                                 pathSrc,
    //                                 address(cBridge),
    //                                 block.timestamp + 20 minutes
    //                             ),
    //         requiresDeposit:    true
    //     });

    //     // prepare bridge data
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
    //         transactionId:          "",
    //         bridge:                 "cbridge",
    //         integrator:             "",
    //         referrer:               address(0),
    //         sendingAssetId:         address(_accounts.daiToken),
    //         receiver:               address(_accounts.usdcWhale),
    //         minAmount:              amountOut,
    //         destinationChainId:     137,
    //         hasSourceSwaps:         true,
    //         hasDestinationCall:     true
    //     });

    //     // prepare dest swap data
    //     selectForkWithAccounts(137);
    //     deployReceiverAndExecutor();
    //     uint256 amountInDest = amountOut;
    //     address[] memory pathDest = new address[](2);
    //     pathDest[0] = address(_accounts.daiToken);
    //     pathDest[1] = address(_accounts.usdcToken);
    //     uint256[] memory amountsDest = _accounts.dex.getAmountsOut(amountInDest, pathDest);
    //     uint256 amountOutDest = amountsDest[0];
    //     console.log("_accounts.receiver: %s", _accounts.receiver);
    //     console.log("_accounts.usdcToken: %s",address(_accounts.usdcToken));
    //     _accounts.usdcToken.approve(_accounts.receiver, amountInDest);
    //     console.log("5");

    //     //! this needs to be updated to match the actual 

    //     // prepare swap data for swap at dest chain  (DAI -> USDC)
    //     LibSwap.SwapData[] memory swapDataDest = new LibSwap.SwapData[](1);
    //     swapDataDest[0] = LibSwap.SwapData({
    //         callTo:             address(_accounts.dex),
    //         approveTo:          address(_accounts.dex),
    //         receivingAssetId:   address(_accounts.daiToken),
    //         sendingAssetId:     address(_accounts.usdcToken),
    //         fromAmount:         amountInDest,
    //         callData:           abi.encodeWithSelector(
    //                                 uniswap.swapExactTokensForTokens.selector,
    //                                 amountInDest,
    //                                 amountOutDest,
    //                                 pathDest,
    //                                 _accounts.executor,     // has same address across networks
    //                                 block.timestamp + 20 minutes
    //                             ),
    //         requiresDeposit:    false
    //     });

    //     bytes memory destCallData = abi.encode(
    //         "",                     // transactionId
    //         swapDataDest,           // swapData
    //         _accounts.usdcWhale,    // receiver
    //         _accounts.user1         // refundAddress
    //     );

    //     // //! ---------- switch back to src side -------------
    //     selectForkWithAccounts(1);

    //     // Calculate messageBusFee based on message length
    //     uint256 messageBusFee = IMessageBus(CBRIDGE_MESSAGE_BUS_ETH).calcFee(destCallData);
        
    //     // calculate nonce as recommended by CBridge
    //     uint64 nonce = uint64(uint(keccak256(abi.encodePacked(
    //             block.timestamp,
    //             msg.sender,
    //             block.number
    //     ))));

    //     // prepare cBridgeData
    //     CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData({
    //         maxSlippage:    5000,
    //         nonce:          nonce,
    //         callTo:         abi.encodePacked(address(_accounts.receiver)),
    //         callData:       destCallData,
    //         messageBusFee:  messageBusFee,
    //         bridgeType:     MsgDataTypes.BridgeSendType.Liquidity
    //     });   

    //     // prepare check for events
    //         // calculate transferId as it will be produced during bridging
    //     bytes32 transferId = keccak256(
    //             abi.encodePacked(
    //                 address(cBridge),
    //                 address(_accounts.receiver),
    //                 bridgeData.sendingAssetId,
    //                 bridgeData.minAmount,
    //                 uint64(bridgeData.destinationChainId),
    //                 cBridgeData.nonce,
    //                 uint64(block.chainid)
    //             )
    //     );
 
    //     // event MessageWithTransfer:
    //     //     address indexed sender,
    //     //     address receiver,
    //     //     uint256 dstChainId,
    //     //     address bridge,
    //     //     bytes32 srcTransferId,
    //     //     bytes message,
    //     //     uint256 fee
    //     // );

    //     console.log("");
    //     console.log("");
    //     console.log("*****************2********************");

    //     console.log("sender: %s", address(cBridge));
    //     console.log("receiver: %s", address(_accounts.usdcWhale));
    //     console.log("dstChainId: %s", bridgeData.destinationChainId);
    //     console.log("bridge: %s", CBRIDGE_ROUTER);
    //     console.log("fee: %s", messageBusFee);

    //     console.log("srcTransferId:");
    //     emit log_bytes32(transferId);
    //     console.log("message:");
    //     emit log_bytes(destCallData);
    //     console.log("*************************************");





    //     // check if MessageWithTransfer event will be emitted by MessageBus with correct data
    //     //! TODO TransferId does not match
    //     //! will be difficult to set up with varying bridges used (transferId computation differs)
    //     // vm.expectEmit(true, false, false, true, CBRIDGE_MESSAGE_BUS_ETH);
    //     // emit MessageWithTransfer(
    //     //     address(cBridge),
    //     //     address(_accounts.usdcWhale),
    //     //     bridgeData.destinationChainId,
    //     //     CBRIDGE_ROUTER,
    //     //     transferId,
    //     //     destCallData,
    //     //     messageBusFee
    //     // );
    //     // check if LiFiTransferStarted event will be emitted by our contract with correct data
    //     vm.expectEmit(true, true, true, true, address(cBridge));
    //     emit LiFiTransferStarted(bridgeData);


    //     // initiate transaction on src side
    //     //TODO FA
    //     cBridge.swapAndStartBridgeTokensViaCBridge{value:messageBusFee}(bridgeData, swapDataSrc, cBridgeData);

    //     // check  balances and make assertions
    //     // TODO


    //     //! src side done (src swap & events checked)

    //     //! ###########################################
    //     //! ############ [DONE: 50%] ##################
    //     console.log("############ [DONE: 50%] ##################");
    //     //! ###########################################
    //     //! ---- now check release on dest side -------


    //     vm.stopPrank();
    //     selectForkWithAccounts(137);     
    //     vm.startPrank(_accounts.daiWhale);
        

    //     // prepare check for events
    //     // TODO

    //     // trigger dest side swap and bridging
    //     // send bridged tokens to Receiver
    //     _accounts.daiToken.transfer(_accounts.receiver, 100 * 10**_accounts.daiToken.decimals());
    //     setInitialBalances();

    //     assertEq(_accounts.daiToken.balanceOf(_accounts.receiver), 100 * 10**_accounts.daiToken.decimals());



    //     // call testReceive function in Receiver
    //     ReceiverCelerIM cReceiver = ReceiverCelerIM(_accounts.receiver);
    //     // console.log("hier1");
    //     emit log_string("hier1");
    //     // emit log_address(_accounts.daiToken.balanceOf(_accounts.receiver));

    //     console.log("USDC_WHALE: %s", USDC_WHALE);
    //     console.log("bridgeData.sendingAssetId: %s", bridgeData.sendingAssetId);
    //     console.log("bridgeData.minAmount: %s", bridgeData.minAmount);

    //     emit log_bytes(cBridgeData.callData);
        
    //     cReceiver.executeMessageWithTransfer(
    //         USDC_WHALE,
    //         bridgeData.sendingAssetId,
    //         bridgeData.minAmount,
    //         1,
    //         cBridgeData.callData,
    //         address(this)
    //     );

                

    //     console.log("hier2");








    //     vm.stopPrank();
    // }

    // function testExecuteMessageWithTransferFallBack(uint32 amount) public {
    //     // Szenario
    //     // try to bridge 100 DAI and send message
    //     // bridging fails
    //     //
    //     console.log("in testExecuteMessageWithTransferFallBack");
    //     // switch to src to get correct token address for bridgeData
    //     selectForkWithAccounts(1);

    //     uint256 amountOut = 100 * 10 ** _accounts.daiToken.decimals();

    //     // prepare bridge data
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
    //         transactionId:          "",
    //         bridge:                 "cbridge",
    //         integrator:             "",
    //         referrer:               address(0),
    //         sendingAssetId:         address(_accounts.daiToken),
    //         receiver:               address(_accounts.usdcWhale),
    //         minAmount:              amountOut,
    //         destinationChainId:     137,
    //         hasSourceSwaps:         true,
    //         hasDestinationCall:     true
    //     });

    //     selectForkWithAccounts(137);

    //     // console.log("balance receiver DAI:    %s", _accounts.daiToken.balanceOf(_accounts.receiver));
    //     // console.log("balance receiver USDC:   %s", _accounts.usdcToken.balanceOf(_accounts.receiver));
        
    //     // console.log("balance USDC_WHALE DAI:  %s", _accounts.daiToken.balanceOf(_accounts.usdcWhale));
    //     // console.log("balance USDC_WHALE USDC: %s", _accounts.usdcToken.balanceOf(_accounts.usdcWhale));
        
    //     // console.log("balance executor DAI:    %s", _accounts.daiToken.balanceOf(_accounts.executor));
    //     // console.log("balance executor USDC:   %s", _accounts.usdcToken.balanceOf(_accounts.executor));


    //     // prepare dest swap data
    //     deployReceiverAndExecutor();

    //     uint256 amountInDest = amountOut;
    //     address[] memory pathDest = new address[](2);
    //     pathDest[0] = address(_accounts.daiToken);
    //     pathDest[1] = address(_accounts.usdcToken);
    //     uint256[] memory amountsDest = _accounts.dex.getAmountsOut(amountInDest, pathDest);
    //     uint256 amountOutDest = amountsDest[0];
    //     // console.log("amountInDest:  %s", amountInDest);
    //     // console.log("amountOutDest: %s", amountOutDest);

    //     // prepare swap data for swap at dest chain  (DAI -> USDC)
    //     LibSwap.SwapData[] memory swapDataDest = new LibSwap.SwapData[](1);
    //     swapDataDest[0] = LibSwap.SwapData({
    //         callTo:             address(_accounts.dex),
    //         approveTo:          address(_accounts.dex),
    //         sendingAssetId:     address(_accounts.daiToken),
    //         receivingAssetId:   address(_accounts.usdcToken),
    //         fromAmount:         amountInDest,
    //         callData:           abi.encodeWithSelector(
    //                                 uniswap.swapExactTokensForTokens.selector,
    //                                 amountInDest,
    //                                 0,
    //                                 pathDest,
    //                                 _accounts.executor,     // has same address across networks
    //                                 block.timestamp + 20 minutes
    //                             ),
    //         requiresDeposit:    false
    //     });

    //     bytes32 txId = "txId";
    //     bytes memory destCallData = abi.encode(
    //         txId,                   // transactionId
    //         swapDataDest,           // swapData
    //         _accounts.usdcWhale,    // receiver
    //         _accounts.user1         // refundAddress
    //     );

    //     // prepare check for events
    //     vm.expectEmit(true,true,true,true, _accounts.receiver);
    //     emit LiFiTransferCompleted(
    //         txId,
    //         address(_accounts.daiToken),
    //         _accounts.usdcWhale,
    //         amountOut,
    //         block.timestamp
    //     );

    //     // set initial balances for balance checks at the end
    //     setInitialBalances();

    //     // trigger dest side swap and bridging
    //     // (mock) send "bridged" tokens to Receiver 
    //     vm.startPrank(_accounts.daiWhale);
    //     _accounts.daiToken.transfer(_accounts.receiver, amountOut);

    //     // call testReceive function in Receiver
    //     ReceiverCelerIM cReceiver = ReceiverCelerIM(_accounts.receiver);
    //     cReceiver.executeMessageWithTransfer(
    //         address(cBridge),
    //         address(_accounts.daiToken),
    //         bridgeData.minAmount,
    //         1,
    //         destCallData,
    //         address(this)
    //     );
        
    //     // console.log("balance receiver DAI:    %s", _accounts.daiToken.balanceOf(address(cReceiver)));
    //     // console.log("balance receiver USDC:   %s", _accounts.usdcToken.balanceOf(address(cReceiver)));
        
    //     // console.log("balance USDC_WHALE DAI:  %s", _accounts.daiToken.balanceOf(_accounts.usdcWhale));
    //     // console.log("balance USDC_WHALE USDC: %s", _accounts.usdcToken.balanceOf(_accounts.usdcWhale));
        
    //     // console.log("balance executor DAI:    %s", _accounts.daiToken.balanceOf(_accounts.executor));
    //     // console.log("balance executor USDC:   %s", _accounts.usdcToken.balanceOf(_accounts.executor));
        
    //     //TODO check balances with assertions
    //     // assertEq(initialBalances[_accounts.daiToken][AddressTypes.DAI_WHALE], getBalanceDAI());

    //     vm.stopPrank();
    // }


    // //! works but needs to be finalized (assertions) 
    // function testExecuteMessageWithTransfer(uint32 amount) public {
    //     console.log("in testExecutesMessageWithTransferOnDest");
    //     // switch to src to get correct token address for bridgeData
    //     selectForkWithAccounts(1);

    //     uint256 amountOut = 100 * 10 ** _accounts.daiToken.decimals();

    //     // prepare bridge data
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
    //         transactionId:          "",
    //         bridge:                 "cbridge",
    //         integrator:             "",
    //         referrer:               address(0),
    //         sendingAssetId:         address(_accounts.daiToken),
    //         receiver:               address(_accounts.usdcWhale),
    //         minAmount:              amountOut,
    //         destinationChainId:     137,
    //         hasSourceSwaps:         true,
    //         hasDestinationCall:     true
    //     });

    //     selectForkWithAccounts(137);

    //     // console.log("balance receiver DAI:    %s", _accounts.daiToken.balanceOf(_accounts.receiver));
    //     // console.log("balance receiver USDC:   %s", _accounts.usdcToken.balanceOf(_accounts.receiver));
        
    //     // console.log("balance USDC_WHALE DAI:  %s", _accounts.daiToken.balanceOf(_accounts.usdcWhale));
    //     // console.log("balance USDC_WHALE USDC: %s", _accounts.usdcToken.balanceOf(_accounts.usdcWhale));
        
    //     // console.log("balance executor DAI:    %s", _accounts.daiToken.balanceOf(_accounts.executor));
    //     // console.log("balance executor USDC:   %s", _accounts.usdcToken.balanceOf(_accounts.executor));


    //     // prepare dest swap data
    //     deployReceiverAndExecutor();

    //     uint256 amountInDest = amountOut;
    //     address[] memory pathDest = new address[](2);
    //     pathDest[0] = address(_accounts.daiToken);
    //     pathDest[1] = address(_accounts.usdcToken);
    //     uint256[] memory amountsDest = _accounts.dex.getAmountsOut(amountInDest, pathDest);
    //     uint256 amountOutDest = amountsDest[0];
    //     // console.log("amountInDest:  %s", amountInDest);
    //     // console.log("amountOutDest: %s", amountOutDest);

    //     // prepare swap data for swap at dest chain  (DAI -> USDC)
    //     LibSwap.SwapData[] memory swapDataDest = new LibSwap.SwapData[](1);
    //     swapDataDest[0] = LibSwap.SwapData({
    //         callTo:             address(_accounts.dex),
    //         approveTo:          address(_accounts.dex),
    //         sendingAssetId:     address(_accounts.daiToken),
    //         receivingAssetId:   address(_accounts.usdcToken),
    //         fromAmount:         amountInDest,
    //         callData:           abi.encodeWithSelector(
    //                                 uniswap.swapExactTokensForTokens.selector,
    //                                 amountInDest,
    //                                 0,
    //                                 pathDest,
    //                                 _accounts.executor,     // has same address across networks
    //                                 block.timestamp + 20 minutes
    //                             ),
    //         requiresDeposit:    false
    //     });

    //     bytes32 txId = "txId";
    //     bytes memory destCallData = abi.encode(
    //         txId,                   // transactionId
    //         swapDataDest,           // swapData
    //         _accounts.usdcWhale,    // receiver
    //         _accounts.user1         // refundAddress
    //     );

    //     // prepare check for events
    //     vm.expectEmit(true,true,true,true, _accounts.receiver);
    //     emit LiFiTransferCompleted(
    //         txId,
    //         address(_accounts.daiToken),
    //         _accounts.usdcWhale,
    //         amountOut,
    //         block.timestamp
    //     );

    //     // set initial balances for balance checks at the end
    //     setInitialBalances();

    //     // trigger dest side swap and bridging
    //     // (mock) send "bridged" tokens to Receiver 
    //     vm.startPrank(_accounts.daiWhale);
    //     _accounts.daiToken.transfer(_accounts.receiver, amountOut);

    //     // call testReceive function in Receiver
    //     ReceiverCelerIM cReceiver = ReceiverCelerIM(_accounts.receiver);
    //     cReceiver.executeMessageWithTransfer(
    //         address(cBridge),
    //         address(_accounts.daiToken),
    //         bridgeData.minAmount,
    //         1,
    //         destCallData,
    //         address(this)
    //     );
        
    //     // console.log("balance receiver DAI:    %s", _accounts.daiToken.balanceOf(address(cReceiver)));
    //     // console.log("balance receiver USDC:   %s", _accounts.usdcToken.balanceOf(address(cReceiver)));
        
    //     // console.log("balance USDC_WHALE DAI:  %s", _accounts.daiToken.balanceOf(_accounts.usdcWhale));
    //     // console.log("balance USDC_WHALE USDC: %s", _accounts.usdcToken.balanceOf(_accounts.usdcWhale));
        
    //     // console.log("balance executor DAI:    %s", _accounts.daiToken.balanceOf(_accounts.executor));
    //     // console.log("balance executor USDC:   %s", _accounts.usdcToken.balanceOf(_accounts.executor));
        
    //     //TODO check balances with assertions
    //     // assertEq(initialBalances[_accounts.daiToken][AddressTypes.DAI_WHALE], getBalanceDAI());

    //     vm.stopPrank();
    // }

    //#endregion
}
