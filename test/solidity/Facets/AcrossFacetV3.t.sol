// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { AcrossFacetV3 } from "lifi/Facets/AcrossFacetV3.sol";
import { IAcrossSpokePool } from "lifi/Interfaces/IAcrossSpokePool.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { InformationMismatch } from "lifi/Errors/GenericErrors.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Stub AcrossFacetV3 Contract
contract TestAcrossFacetV3 is AcrossFacetV3, TestWhitelistManagerBase {
    address internal constant ADDRESS_WETH =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    constructor(
        IAcrossSpokePool _spokePool
    ) AcrossFacetV3(_spokePool, ADDRESS_WETH) {}
}

contract AcrossFacetV3Test is TestBaseFacet {
    address internal constant ETH_HOLDER =
        0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511;
    address internal constant WETH_HOLDER =
        0xD022510A3414f255150Aa54b2e42DB6129a20d9E;
    address internal constant SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    // -----
    AcrossFacetV3.AcrossV3Data internal validAcrossData;
    TestAcrossFacetV3 internal acrossFacetV3;

    error InvalidQuoteTimestamp();

    function setUp() public {
        customBlockNumberForForking = 19960294;
        initTestBase();

        acrossFacetV3 = new TestAcrossFacetV3(IAcrossSpokePool(SPOKE_POOL));
        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = acrossFacetV3
            .startBridgeTokensViaAcrossV3
            .selector;
        functionSelectors[1] = acrossFacetV3
            .swapAndStartBridgeTokensViaAcrossV3
            .selector;
        functionSelectors[2] = acrossFacetV3.addAllowedContractSelector.selector;

        addFacet(diamond, address(acrossFacetV3), functionSelectors);
        acrossFacetV3 = TestAcrossFacetV3(address(diamond));
        acrossFacetV3.addAllowedContractSelector(ADDRESS_UNISWAP, uniswap.swapExactTokensForTokens.selector);
        acrossFacetV3.addAllowedContractSelector(ADDRESS_UNISWAP, uniswap.swapTokensForExactETH.selector);
        acrossFacetV3.addAllowedContractSelector(ADDRESS_UNISWAP, uniswap.swapETHForExactTokens.selector);

        setFacetAddressInTestBase(address(acrossFacetV3), "AcrossFacetV3");

        // adjust bridgeData
        bridgeData.bridge = "across";
        // bridgeData.destinationChainId = 137;
        bridgeData.destinationChainId = 42161;

        // produce valid AcrossData
        uint32 quoteTimestamp = uint32(block.timestamp);
        validAcrossData = AcrossFacetV3.AcrossV3Data({
            receiverAddress: USER_RECEIVER,
            refundAddress: USER_REFUND,
            receivingAssetId: ADDRESS_USDC_POL,
            outputAmount: (defaultUSDCAmount * 9) / 10,
            outputAmountPercent: 1000000000000000000, // 100.00% (1e18)
            exclusiveRelayer: address(0),
            quoteTimestamp: quoteTimestamp,
            fillDeadline: uint32(quoteTimestamp + 1000),
            exclusivityDeadline: 0,
            message: ""
        });

        vm.label(SPOKE_POOL, "SpokePool_Proxy");
        vm.label(0x08C21b200eD06D2e32cEC91a770C3FcA8aD5F877, "SpokePool_Impl");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            acrossFacetV3.startBridgeTokensViaAcrossV3{
                value: bridgeData.minAmount
            }(bridgeData, validAcrossData);
        } else {
            acrossFacetV3.startBridgeTokensViaAcrossV3(
                bridgeData,
                validAcrossData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            acrossFacetV3.swapAndStartBridgeTokensViaAcrossV3{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validAcrossData);
        } else {
            acrossFacetV3.swapAndStartBridgeTokensViaAcrossV3(
                bridgeData,
                swapData,
                validAcrossData
            );
        }
    }

    function test_canSwapAndBridgeTokensWithOutputAmountPercent()
        public
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // Set output amount percent to 85%
        validAcrossData.outputAmountPercent = uint64(850000000000000000); // 85.00%
        validAcrossData.outputAmount = 10000; // This will be ignored

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_canSwapAndBridgeNativeTokensWithOutputAmountPercent()
        public
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
        path[1] = ADDRESS_WRAPPED_NATIVE;

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

        // Set output amount percent to 93.75%
        validAcrossData.outputAmountPercent = uint64(937500000000000000); // 93.75%
        validAcrossData.outputAmount = 10000; // This will be ignored

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
        vm.stopPrank();
    }

    function testRevert_FailsIfCalledWithOutdatedQuote() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV3), bridgeData.minAmount);

        validAcrossData.quoteTimestamp = uint32(block.timestamp - 100 days);

        vm.expectRevert(InvalidQuoteTimestamp.selector);

        acrossFacetV3.startBridgeTokensViaAcrossV3(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function test_contractIsSetUpCorrectly() public {
        acrossFacetV3 = new TestAcrossFacetV3(IAcrossSpokePool(SPOKE_POOL));

        assertEq(address(acrossFacetV3.spokePool()) == SPOKE_POOL, true);
        assertEq(
            acrossFacetV3.wrappedNative() == ADDRESS_WRAPPED_NATIVE,
            true
        );
    }

    function testRevert_WillFailIfBridgeDataReceiverDoesNotMatchWithAcrossData()
        public
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV3), bridgeData.minAmount);

        validAcrossData.quoteTimestamp = uint32(block.timestamp - 100 days);

        bridgeData.receiver = address(0x123); // does not match with USER_RECEIVER

        vm.expectRevert(InformationMismatch.selector);

        acrossFacetV3.startBridgeTokensViaAcrossV3(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }
}
