// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { SquidFacet } from "lifi/Facets/SquidFacet.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";
import { ISquidRouter } from "lifi/Interfaces/ISquidRouter.sol";
import { ISquidMulticall } from "lifi/Interfaces/ISquidMulticall.sol";

// Stub SquidFacet Contract
contract TestSquidFacet is SquidFacet {
    address internal constant ADDRESS_WETH =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    constructor(ISquidRouter _squidRouter) SquidFacet(_squidRouter) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract SquidFacetTest is TestBaseFacet {
    error InformationMismatch();

    // These values are for Ethereum Mainnet
    address internal constant ETH_HOLDER =
        0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511;
    address internal constant WETH_HOLDER =
        0xD022510A3414f255150Aa54b2e42DB6129a20d9E;
    address internal constant SQUID_ROUTER =
        0xce16F69375520ab01377ce7B88f5BA8C48F8D666;
    address internal constant SQUID_MULTICALL =
        0x4fd39C9E151e50580779bd04B1f7eCc310079fd3;
    // -----
    // SquidFacet.SquidData internal baseSquidData;
    ISquidMulticall.Call internal sourceCall;
    TestSquidFacet internal squidFacet;

    function setUp() public {
        customBlockNumberForForking = 18810880;
        initTestBase();

        squidFacet = new TestSquidFacet(ISquidRouter(SQUID_ROUTER));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = squidFacet.startBridgeTokensViaSquid.selector;
        functionSelectors[1] = squidFacet
            .swapAndStartBridgeTokensViaSquid
            .selector;
        functionSelectors[2] = squidFacet.addDex.selector;
        functionSelectors[3] = squidFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(squidFacet), functionSelectors);
        squidFacet = TestSquidFacet(address(diamond));
        squidFacet.addDex(ADDRESS_UNISWAP);
        squidFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        squidFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        squidFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(squidFacet), "SquidFacet");

        // adjust bridgeData
        bridgeData.bridge = "squid router";
        bridgeData.destinationChainId = 43114;
        bridgeData.sendingAssetId = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        bridgeData.minAmount = 10000000;
        bridgeData.hasSourceSwaps = false;

        // addToMessageValue = 1 ether;

        vm.label(SQUID_ROUTER, "SquidRouter");
        vm.label(SQUID_MULTICALL, "SquidMulticall");
        vm.label(0xdAC17F958D2ee523a2206206994597C13D831ec7, "USDT_TOKEN");
        vm.label(0x99a58482BD75cbab83b27EC03CA68fF489b5788f, "Vyper_contract");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        SquidFacet.SquidData
            memory validSquidData = _getSquidDataForCallBridgeCallNative();

        addToMessageValue = validSquidData.fee;

        if (isNative) {
            squidFacet.startBridgeTokensViaSquid{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, validSquidData);
        } else {
            squidFacet.startBridgeTokensViaSquid{ value: addToMessageValue }(
                bridgeData,
                validSquidData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        SquidFacet.SquidData
            memory validSquidData = _getSquidDataForCallBridgeCallNative();

        if (isNative) {
            squidFacet.swapAndStartBridgeTokensViaSquid{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, swapData, validSquidData);
        } else {
            squidFacet.swapAndStartBridgeTokensViaSquid{
                value: addToMessageValue
            }(bridgeData, swapData, validSquidData);
        }
    }

    // function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
    //     vm.assume(amount > 100 && amount < 100_000);
    //     super.testBase_CanBridgeTokens_fuzzed(amount);
    // }

    function testBase_CanBridgeTokens() public override {
        // requires custom implementation
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        // requires custom implementation
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // requires custom implementation
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag()
        public
        override
    {
        // while Squid may internally execute calls/swaps on destination, this is not what we call a destination call
        // we do not send payload and execute it using our executor, Squid does this for us
        // therefore the bridgeData will always have "hasDestinationSwaps = false" unless we send our own payload cross-chain
        // which the implementation currently does not support
    }

    function test_Revert_BridgeCallFailsIfSendingAssetIdAndSymbolsDoNotMatch()
        public
    {
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        SquidFacet.SquidData
            memory squidData = _getSquidDataForCallBridgeCallNative();

        squidData.routeType = SquidFacet.RouteType.BridgeCall;
        delete squidData.sourceCalls;
        squidData.bridgedTokenSymbol = "USDT"; // Does not match (should be USDC)
        squidData.depositAssetId = ADDRESS_USDC;
        squidData.fee = 0;

        vm.expectRevert(InformationMismatch.selector);
        squidFacet.startBridgeTokensViaSquid{
            value: bridgeData.minAmount + squidData.fee
        }(bridgeData, squidData);
    }

    function test_Revert_CallBridgeCallFailsIfSendingAssetIdAndSymbolsDoNotMatch()
        public
    {
        // this test case will use Squid to do a pre-bridge swap from USDC to USDC and then bridge the USDC
        address ADDRESS_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
        bridgeData.minAmount = 100000000;
        bridgeData.sendingAssetId = ADDRESS_USDT;

        vm.startPrank(USER_SENDER);

        // give USDT balance to user
        deal(ADDRESS_USDT, USER_SENDER, 100000000);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        SquidFacet.SquidData
            memory squidData = _getSquidDataForCallBridgeCallERC20();
        squidData.bridgedTokenSymbol = "USDC";

        vm.expectRevert(InformationMismatch.selector);
        squidFacet.startBridgeTokensViaSquid{ value: squidData.fee }(
            bridgeData,
            squidData
        );
    }

    function _getSquidDataForCallBridgeCallNative()
        internal
        pure
        returns (SquidFacet.SquidData memory)
    {
        // https://etherscan.io/tx/0x6207e7342f9a815db973a0e30398875a57ef52ac4088ec3dda62b1554acf2cdc
        ISquidMulticall.Call[] memory calls = new ISquidMulticall.Call[](1);

        // swap ETH to USDC on Uniswap
        calls[0].callType = ISquidMulticall.CallType.FullNativeBalance;
        calls[0].target = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45; // SwapRouter02
        calls[0].value = 0;
        calls[0]
            .callData = hex"04e45aaf000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000ce16f69375520ab01377ce7b88f5ba8c48f8d666000000000000000000000000000000000000000000000000016345785d8a0000000000000000000000000000000000000000000000000000000000000cb586c20000000000000000000000000000000000000000000000000000000000000000";
        calls[0].payload = hex"";

        SquidFacet.SquidData memory squidData = SquidFacet.SquidData({
            routeType: SquidFacet.RouteType.CallBridgeCall,
            destinationChain: "osmosis",
            destinationAddress: LibBytes.toHexString(
                uint160(USER_RECEIVER),
                20
            ),
            bridgedTokenSymbol: "USDC",
            depositAssetId: address(0),
            sourceCalls: calls,
            payload: "0x000000027b22737761705f776974685f616374696f6e223a7b22737761705f6d7367223a7b22746f6b656e5f6f75745f6d696e5f616d6f756e74223a223137313833313233222c2270617468223a5b7b22706f6f6c5f6964223a2231323233222c22746f6b656e5f6f75745f64656e6f6d223a226962632f34393841303735314337393841304439413338394141333639313132334441444135374441413446453136354435433735383934353035423837364241364534227d2c7b22706f6f6c5f6964223a2231323437222c22746f6b656e5f6f75745f64656e6f6d223a226962632f44373945374438334142333939424646463933343333453534464141343830433139313234384643353536393234413241383335314145323633384233383737227d5d7d2c2261667465725f737761705f616374696f6e223a7b226962635f7472616e73666572223a7b227265636569766572223a2263656c6573746961316a39767a7572786d776e646c706a746c30396c353033657679706a617161717474653938746a222c226368616e6e656c223a226368616e6e656c2d36393934227d7d2c226c6f63616c5f66616c6c6261636b5f61646472657373223a226f736d6f316a39767a7572786d776e646c706a746c30396c353033657679706a61716171746a6738383864227d7d",
            // fee: 0,
            // fee: bridgeData.minAmount,
            fee: 168211815457577,
            enableExpress: false
        });

        return squidData;
    }

    function test_CanBridgeTokens_CallBridgeCall_Native() public {
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 100000000000000000;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        SquidFacet.SquidData
            memory squidData = _getSquidDataForCallBridgeCallNative();

        squidFacet.startBridgeTokensViaSquid{
            value: bridgeData.minAmount + squidData.fee
        }(bridgeData, squidData);
    }

    function test_CanBridgeTokens_BridgeCall_ERC20() public {
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        SquidFacet.SquidData
            memory squidData = _getSquidDataForCallBridgeCallNative();

        squidData.routeType = SquidFacet.RouteType.BridgeCall;
        delete squidData.sourceCalls;
        squidData.bridgedTokenSymbol = "USDC";
        squidData.depositAssetId = ADDRESS_USDC;
        squidData.fee = 0;

        squidFacet.startBridgeTokensViaSquid{
            value: bridgeData.minAmount + squidData.fee
        }(bridgeData, squidData);
    }

    // USDC > USDT => BRIDGE
    function _getSquidDataForCallBridgeCallERC20()
        internal
        view
        returns (SquidFacet.SquidData memory)
    {
        address ADDRESS_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

        ISquidMulticall.Call[] memory calls = new ISquidMulticall.Call[](2);

        // create uniswap calldata
        // Swap USDC > USDT
        address[] memory swapPath = new address[](2);
        swapPath[0] = ADDRESS_USDC;
        swapPath[1] = ADDRESS_USDT;

        bytes memory callData = abi.encodeWithSelector(
            uniswap.swapExactTokensForTokens.selector,
            defaultUSDCAmount,
            0,
            swapPath,
            SQUID_ROUTER,
            block.timestamp + 20 minutes
        );

        // create call for approving USDC to Uniswap router
        calls[0].callType = ISquidMulticall.CallType.Default;
        calls[0].target = ADDRESS_USDC; // USDC
        calls[0].value = 0;
        calls[0]
            .callData = hex"095ea7b30000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488d000000000000000000000000000000000000000000000000000000003b9aca00";
        calls[0].payload = "";

        // create call for swapping USDC to USDT using Uniswap
        calls[1].callType = ISquidMulticall.CallType.Default;
        calls[1].target = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D; // Uniswap contract
        calls[1].value = 0;
        calls[1].callData = callData;
        calls[1].payload = "";

        // create SquidData
        SquidFacet.SquidData memory squidData = SquidFacet.SquidData({
            routeType: SquidFacet.RouteType.CallBridgeCall,
            destinationChain: "Avalanche",
            destinationAddress: LibBytes.toHexString(
                uint160(USER_RECEIVER),
                20
            ),
            bridgedTokenSymbol: "USDT",
            depositAssetId: ADDRESS_USDC,
            sourceCalls: calls,
            payload: "",
            fee: 0,
            enableExpress: false
        });

        return squidData;
    }

    function test_CanBridgeTokens_CallBridgeCall_ERC20() public {
        // this test case will use Squid to do a pre-bridge swap from USDC to USDT and then bridge the USDC
        address ADDRESS_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
        bridgeData.minAmount = 100000000;
        bridgeData.sendingAssetId = ADDRESS_USDT;

        vm.startPrank(USER_SENDER);

        // give USDT balance to user
        deal(ADDRESS_USDT, USER_SENDER, 100000000);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        SquidFacet.SquidData
            memory squidData = _getSquidDataForCallBridgeCallERC20();

        squidFacet.startBridgeTokensViaSquid{ value: squidData.fee }(
            bridgeData,
            squidData
        );
    }
}
