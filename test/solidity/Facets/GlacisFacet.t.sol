// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { GlacisFacet } from "lifi/Facets/GlacisFacet.sol";
import { IGlacisAirlift, QuoteSendInfo } from "lifi/Interfaces/IGlacisAirlift.sol";
import { TransferFromFailed, InvalidReceiver, InvalidAmount, CannotBridgeToSameNetwork, NativeAssetNotSupported, InvalidConfig } from "lifi/Errors/GenericErrors.sol";

// Stub GlacisFacet Contract
contract TestGlacisFacet is GlacisFacet {
    constructor(IGlacisAirlift _airlift) GlacisFacet(_airlift) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

abstract contract GlacisFacetTestBase is TestBaseFacet {
    GlacisFacet.GlacisData internal glacisData;
    IGlacisAirlift internal airliftContract;
    TestGlacisFacet internal glacisFacet;
    ERC20 internal srcToken;
    uint256 internal defaultSrcTokenAmount;
    uint256 internal destinationChainId;
    address internal addressSrcToken;
    uint256 internal fuzzingAmountMinValue;
    uint256 internal fuzzingAmountMaxValue;

    uint256 internal payableAmount = 1 ether;

    function setUp() public virtual {
        initTestBase();

        srcToken = ERC20(addressSrcToken);

        defaultSrcTokenAmount = 1_000 * 10 ** srcToken.decimals();

        deal(
            addressSrcToken,
            USER_SENDER,
            500_000 * 10 ** srcToken.decimals()
        );

        glacisFacet = new TestGlacisFacet(airliftContract);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = glacisFacet.startBridgeTokensViaGlacis.selector;
        functionSelectors[1] = glacisFacet
            .swapAndStartBridgeTokensViaGlacis
            .selector;
        functionSelectors[2] = glacisFacet.addDex.selector;
        functionSelectors[3] = glacisFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(address(diamond), address(glacisFacet), functionSelectors);
        glacisFacet = TestGlacisFacet(address(diamond));
        glacisFacet.addDex(ADDRESS_UNISWAP);
        glacisFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        glacisFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        glacisFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        _facetTestContractAddress = address(glacisFacet);
        vm.label(address(glacisFacet), "GlacisFacet");

        // adjust bridgeData
        bridgeData.bridge = "glacis";
        bridgeData.sendingAssetId = addressSrcToken;
        bridgeData.minAmount = defaultSrcTokenAmount;
        bridgeData.destinationChainId = destinationChainId;

        // add liquidity for dex pair DAI-{SOURCE TOKEN}
        // this is necessary because Glacis does not provide routes for stablecoins
        // like USDT or USDC, forcing us to work with custom tokens that often lack
        // liquidity on V2 dexes
        addLiquidity(
            ADDRESS_DAI,
            addressSrcToken,
            100_000 * 10 ** ERC20(ADDRESS_DAI).decimals(),
            100_000 * 10 ** srcToken.decimals()
        );

        // Call `quoteSend` to estimate the required native fee for the transfer.
        // This is necessary to ensure the transaction has sufficient gas for execution.
        // The `payableAmount` parameter simulates the amount of native tokens required for the estimation.

        // Since `quoteSend` is a view function and therefore not payable,
        // we receive `msg.value` as a parameter. When quoting, you can simulate
        // the impact on your `msg.value` by passing a sample amount (payableAmount), such as 1 ETH,
        // to see how it would be adjusted during an actual send.

        // While we are estimating nativeFee, we initially don't know what
        // `msg.value` is "enough." That's why we need to provide an overestimation,
        // for example, 1 ETH. It goes through the full
        // bridging logic and determines "I only need 0.005ETH from that 1ETH."
        // The nativeFee is then returned in QuoteSendInfo. By using 1 ETH,
        // we’re just on the safe side of overestimation to prevent the function
        // from reverting.
        QuoteSendInfo memory quoteSendInfo = IGlacisAirlift(
            address(airliftContract)
        ).quoteSend(
                bridgeData.sendingAssetId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(bridgeData.receiver))),
                bridgeData.destinationChainId,
                REFUND_WALLET,
                payableAmount
            );

        addToMessageValue =
            quoteSendInfo.gmpFee.nativeFee +
            quoteSendInfo.airliftFeeInfo.airliftFee.nativeFee;

        // produce valid GlacisData
        glacisData = GlacisFacet.GlacisData({
            refundAddress: REFUND_WALLET,
            nativeFee: addToMessageValue
        });
    }

    function test_WillStoreConstructorParametersCorrectly() public {
        glacisFacet = new TestGlacisFacet(airliftContract);

        assertEq(address(glacisFacet.airlift()), address(airliftContract));
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestGlacisFacet(IGlacisAirlift(address(0)));
    }

    function initiateBridgeTxWithFacet(bool) internal virtual override {
        glacisFacet.startBridgeTokensViaGlacis{ value: addToMessageValue }(
            bridgeData,
            glacisData
        );
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal virtual override {
        glacisFacet.swapAndStartBridgeTokensViaGlacis{
            value: addToMessageValue
        }(bridgeData, swapData, glacisData);
    }

    function testBase_CanBridgeNativeTokens() public virtual override {
        // facet does not support bridging of native assets
    }

    function testBase_CanBridgeTokens()
        public
        virtual
        override
        assertBalanceChange(
            addressSrcToken,
            USER_SENDER,
            -int256(defaultSrcTokenAmount)
        )
        assertBalanceChange(addressSrcToken, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // approval
        srcToken.approve(address(glacisFacet), bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(glacisFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(
        uint256 amount
    ) public virtual override {
        vm.assume(
            amount > fuzzingAmountMinValue * 10 ** srcToken.decimals() &&
                amount < fuzzingAmountMaxValue * 10 ** srcToken.decimals()
        );
        bridgeData.minAmount = amount;

        vm.startPrank(USER_SENDER);

        // approval
        srcToken.approve(address(glacisFacet), bridgeData.minAmount);

        QuoteSendInfo memory quoteSendInfo = IGlacisAirlift(
            address(airliftContract)
        ).quoteSend(
                bridgeData.sendingAssetId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(bridgeData.receiver))),
                bridgeData.destinationChainId,
                REFUND_WALLET,
                payableAmount
            );
        addToMessageValue =
            quoteSendInfo.gmpFee.nativeFee +
            quoteSendInfo.airliftFeeInfo.airliftFee.nativeFee;

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(glacisFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public virtual override {
        // facet does not support bridging of native assets
    }

    function setDefaultSwapDataSingleDAItoSourceToken() internal virtual {
        delete swapData;
        // Swap DAI -> {SOURCE TOKEN}
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = addressSrcToken;

        uint256 amountOut = defaultSrcTokenAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: addressSrcToken,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function testBase_CanSwapAndBridgeTokens()
        public
        virtual
        override
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(addressSrcToken, USER_SENDER, 0)
        assertBalanceChange(addressSrcToken, USER_RECEIVER, 0)
    {
        uint256 initialDAIBalance = dai.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoSourceToken();

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        uint256 initialETHBalance = USER_SENDER.balance;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            address(uniswap),
            ADDRESS_DAI,
            addressSrcToken,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateSwapAndBridgeTxWithFacet(false);

        // check balances after call
        assertEq(
            dai.balanceOf(USER_SENDER),
            initialDAIBalance - swapData[0].fromAmount
        );
        assertEq(USER_SENDER.balance, initialETHBalance - addToMessageValue);
    }

    function testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.receiver = address(0);
        bridgeData.hasSourceSwaps = true;

        setDefaultSwapDataSingleDAItoSourceToken();

        vm.expectRevert(InvalidReceiver.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeWithInvalidAmount()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = 0;

        setDefaultSwapDataSingleDAItoSourceToken();

        vm.expectRevert(InvalidAmount.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeToSameChainId()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.destinationChainId = block.chainid;
        bridgeData.hasSourceSwaps = true;

        setDefaultSwapDataSingleDAItoSourceToken();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(CannotBridgeToSameNetwork.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_CallerHasInsufficientFunds()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);

        srcToken.approve(
            address(_facetTestContractAddress),
            defaultSrcTokenAmount
        );

        // send all available source token balance to different account to ensure sending wallet has no source token funds
        srcToken.transfer(USER_RECEIVER, srcToken.balanceOf(USER_SENDER));

        vm.expectRevert(TransferFromFailed.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_InvalidRefundAddress() public virtual {
        vm.startPrank(USER_SENDER);

        glacisData = GlacisFacet.GlacisData({
            refundAddress: address(0),
            nativeFee: addToMessageValue
        });

        srcToken.approve(
            address(_facetTestContractAddress),
            defaultSrcTokenAmount
        );

        vm.expectRevert(
            abi.encodeWithSelector(GlacisFacet.InvalidRefundAddress.selector)
        );

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_WhenTryToBridgeNativeAsset() public virtual {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = address(0); // address zero is considered as native asset

        vm.expectRevert(
            abi.encodeWithSelector(NativeAssetNotSupported.selector)
        );

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_WhenTryToSwapAndBridgeNativeAsset() public virtual {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0); // address zero is considered as native asset

        vm.expectRevert(
            abi.encodeWithSelector(NativeAssetNotSupported.selector)
        );

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();
    }
}

contract GlacisFacetWormholeTest is GlacisFacetTestBase {
    function setUp() public virtual override {
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";
        customBlockNumberForForking = 303669576;

        airliftContract = IGlacisAirlift(
            0xD9E7f6f7Dc7517678127D84dBf0F0b4477De14E0
        );
        addressSrcToken = 0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91; // address of W token on Arbitrum network
        destinationChainId = 10;
        fuzzingAmountMinValue = 1; // Minimum fuzzing amount (actual value includes token decimals)
        fuzzingAmountMaxValue = 100_000; // Maximum fuzzing amount (actual value includes token decimals)
        super.setUp();
    }
}

contract GlacisFacetLINKTest is GlacisFacetTestBase {
    function setUp() public virtual override {
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        customBlockNumberForForking = 26082794;

        airliftContract = IGlacisAirlift(
            0x30095227Eb6d72FA6c09DfdeFFC766c33f7FA2DD
        );
        addressSrcToken = 0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196; // address of LINK token on Base network
        destinationChainId = 34443;
        fuzzingAmountMinValue = 1; // Minimum fuzzing amount (actual value includes token decimals)
        fuzzingAmountMaxValue = 10_000; // Maximum fuzzing amount (actual value includes token decimals)
        super.setUp();
    }
}
