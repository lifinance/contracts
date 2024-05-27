// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20, LibSwap } from "../utils/TestBaseFacet.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";
import { IMayan } from "lifi/Interfaces/IMayan.sol";

// Stub MayanFacet Contract
contract TestMayanFacet is MayanFacet {
    constructor(IMayan _bridge) MayanFacet(_bridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract MayanFacetTest is TestBaseFacet {
    MayanFacet.MayanData internal validMayanData;
    TestMayanFacet internal mayanBridgeFacet;
    IMayan internal MAYAN_FORWARDER =
        IMayan(0x0654874eb7F59C6f5b39931FC45dC45337c967c3);
    address internal POLYGON_USDT = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;

    function setUp() public {
        customBlockNumberForForking = 19960692;
        initTestBase();

        mayanBridgeFacet = new TestMayanFacet(MAYAN_FORWARDER);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = mayanBridgeFacet
            .startBridgeTokensViaMayan
            .selector;
        functionSelectors[1] = mayanBridgeFacet
            .swapAndStartBridgeTokensViaMayan
            .selector;
        functionSelectors[2] = mayanBridgeFacet.addDex.selector;
        functionSelectors[3] = mayanBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(mayanBridgeFacet), functionSelectors);
        mayanBridgeFacet = TestMayanFacet(address(diamond));
        mayanBridgeFacet.addDex(ADDRESS_UNISWAP);
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(mayanBridgeFacet), "MayanFacet");

        // adjust bridgeData
        bridgeData.bridge = "mayanBridge";
        bridgeData.destinationChainId = 137;

        // produce valid MayanData
        validMayanData = MayanFacet.MayanData(
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            hex"afd9b706000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000000989680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000000000000000000000000000000000000000000000000000000000005000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f00000000000000000000000000000000000000000000000000000000007574470000000000000000000000000000000000000000000000000000000066547cfe00000000000000000000000000000000000000000000000000000000001f8c1e0000000000000000000000000e59bec273184dbaab3123d7ca0df72f24c79f0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007000000000000000000000000f18f923480dc144326e6c65d4f3d47aa459bb41c000000000000000000000000f18f923480dc144326e6c65d4f3d47aa459bb41c",
            ""
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            mayanBridgeFacet.startBridgeTokensViaMayan{
                value: bridgeData.minAmount
            }(bridgeData, validMayanData);
        } else {
            mayanBridgeFacet.startBridgeTokensViaMayan(
                bridgeData,
                validMayanData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            mayanBridgeFacet.swapAndStartBridgeTokensViaMayan{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validMayanData);
        } else {
            mayanBridgeFacet.swapAndStartBridgeTokensViaMayan(
                bridgeData,
                swapData,
                validMayanData
            );
        }
    }

    function test_CanSwapAndBridgeTokensFromNative()
        public
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialETHBalance = USER_SENDER.balance;

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // prepare swap data
        address[] memory path = new address[](2);

        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            address(0),
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        //@dev the bridged amount will be higher than bridgeData.minAmount since the code will
        //     deposit all remaining ETH to the bridge. We cannot access that value (minAmount + remaining gas)
        //     therefore the test is designed to only check if an event was emitted but not match the parameters
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(true);

        // check balances after call
        assertEq(
            USER_SENDER.balance,
            initialETHBalance - swapData[0].fromAmount
        );
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        amount = bound(amount, 150, 100_000);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }
}
