// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { LibAllowList, TestBaseFacet, console, ERC20, LibSwap, LibAsset } from "../utils/TestBaseFacet.sol";
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
    MayanFacet.MayanData internal validMayanDataNative;
    MayanFacet.MayanData internal invalidMayanDataEVM2Solana;
    TestMayanFacet internal mayanBridgeFacet;
    IMayan internal MAYAN_FORWARDER =
        IMayan(0x0654874eb7F59C6f5b39931FC45dC45337c967c3);
    address internal POLYGON_USDT = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;

    bytes32 ACTUAL_SOL_ADDR =
        hex"4cb7c5f1632114c376c0e7a9a1fd1fbd562699fbd9a0c9f4f26ba8cf6e23df0d";
    bytes32 EXPECTED_SOL_ADDR = bytes32("EXPECTED ADDRESS");

    function setUp() public {
        customBlockNumberForForking = 19968172;
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
            "",
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            // Calldata generated from Mayan SDK 100 USDC on Mainnet -> USDT on Polygon
            hex"afd9b706000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000005f5e10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abc6543210000000000000000000000000000000000000000000000000000000000000005000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f0000000000000000000000000000000000000000000000000000000005aa76a8000000000000000000000000000000000000000000000000000000006655d64300000000000000000000000000000000000000000000000000000000001ff535000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007000000000000000000000000f18f923480dc144326e6c65d4f3d47aa459bb41c000000000000000000000000f18f923480dc144326e6c65d4f3d47aa459bb41c"
        );

        validMayanDataNative = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4, // mayanProtocol address
            // Calldata generated from Mayan SDK 1 ETH -> USDT on Polygon
            hex"1eb1cff00000000000000000000000000000000000000000000000000000000000013e0b0000000000000000000000000000000000000000000000000000000000004df200000000000000000000000000000000000000000000000000000000000a42dfcb617b639c537bd08846f61be4481c34f9391f1b8f53d082de024e232508113e00000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c390000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000006655d880000000000000000000000000000000000000000000000000000000006655d88000000000000000000000000000000000000000000000000000000000e16ffab40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
        );

        invalidMayanDataEVM2Solana = MayanFacet.MayanData(
            EXPECTED_SOL_ADDR,
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4, // mayanProtocol address
            // Send tokens to Solana
            hex"6111ad2500000000000000000000000000000000000000000000000000000000002fa3e500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010883f01f2183c5bf05d6756bf0b0aade846ff42b2bc9afe11e60e677d80270a38b3500000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c394cb7c5f1632114c376c0e7a9a1fd1fbd562699fbd9a0c9f4f26ba8cf6e23df0d0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed7c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000665e43ef00000000000000000000000000000000000000000000000000000000665e43ef00000000000000000000000000000000000000000000000000000000006869570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            mayanBridgeFacet.startBridgeTokensViaMayan{
                value: bridgeData.minAmount
            }(bridgeData, validMayanDataNative);
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
        if (LibAsset.isNativeAsset(bridgeData.sendingAssetId)) {
            validMayanData = validMayanDataNative;
        }

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

    function testBase_CanSwapAndBridgeNativeTokens()
        public
        override
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialUSDCBalance = usdc.balanceOf(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WETH;

        uint256 amountOut = defaultNativeAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        usdc.approve(_facetTestContractAddress, amountIn);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_USDC,
            address(0),
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
        initiateSwapAndBridgeTxWithFacet(false);

        // check balances after call
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialUSDCBalance - swapData[0].fromAmount
        );
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

    function test_RevertsIfNonEVMReceiverIsIncorrect() public {
        bridgeData.receiver = 0x11f111f111f111F111f111f111F111f111f111F1;
        validMayanData = invalidMayanDataEVM2Solana;
        vm.startPrank(USER_SENDER);

        console.log(USER_RECEIVER);
        usdc.approve(_facetTestContractAddress, type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                MayanFacet.InvalidNonEVMReceiver.selector,
                EXPECTED_SOL_ADDR,
                ACTUAL_SOL_ADDR
            )
        );
        mayanBridgeFacet.startBridgeTokensViaMayan(bridgeData, validMayanData);
        vm.stopPrank();
    }
}
