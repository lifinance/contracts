// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, ERC20 } from "../utils/TestBaseFacet.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { GlacisFacet } from "lifi/Facets/GlacisFacet.sol";
import { IGlacisAirlift, QuoteSendInfo } from "lifi/Interfaces/IGlacisAirlift.sol";
import { InsufficientBalance, InvalidReceiver, InvalidAmount, CannotBridgeToSameNetwork } from "lifi/Errors/GenericErrors.sol";

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
    GlacisFacet.GlacisData internal validGlacisData;
    IGlacisAirlift internal airliftContract;
    TestGlacisFacet internal glacisFacet;
    ERC20 internal srcToken;
    uint256 internal defaultSrcTokenAmount;
    uint256 internal destinationChainId;
    address internal ADDRESS_SRC_TOKEN;

    uint256 internal payableAmount = 1 ether;

    function setUp() public virtual {
        initTestBase();

        srcToken = ERC20(ADDRESS_SRC_TOKEN);

        defaultSrcTokenAmount = 1_000 * 10 ** srcToken.decimals();

        deal(
            ADDRESS_SRC_TOKEN,
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

        addFacet(diamond, address(glacisFacet), functionSelectors);
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
        bridgeData.sendingAssetId = ADDRESS_SRC_TOKEN;
        bridgeData.minAmount = defaultSrcTokenAmount;
        bridgeData.destinationChainId = destinationChainId;

        // add liquidity for dex pair DAI-{SOURCE TOKEN}
        // this is necessary because Glacis does not provide routes for stablecoins
        // like USDT or USDC, forcing us to work with custom tokens that often lack
        // liquidity on V2 dexes
        addLiquidity(
            ADDRESS_DAI,
            ADDRESS_SRC_TOKEN,
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
        validGlacisData = GlacisFacet.GlacisData({
            refundAddress: REFUND_WALLET,
            nativeFee: addToMessageValue
        });
    }

    function initiateBridgeTxWithFacet(bool) internal virtual override {
        glacisFacet.startBridgeTokensViaGlacis{ value: addToMessageValue }(
            bridgeData,
            validGlacisData
        );
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal virtual override {
        glacisFacet.swapAndStartBridgeTokensViaGlacis{
            value: addToMessageValue
        }(bridgeData, swapData, validGlacisData);
    }

    function testBase_CanBridgeNativeTokens() public virtual override {
        // facet does not support bridging of native assets
    }

    function testBase_CanBridgeTokens()
        public
        virtual
        override
        assertBalanceChange(
            ADDRESS_SRC_TOKEN,
            USER_SENDER,
            -int256(defaultSrcTokenAmount)
        )
        assertBalanceChange(ADDRESS_SRC_TOKEN, USER_RECEIVER, 0)
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
            amount > 1 * 10 ** srcToken.decimals() &&
                amount < 100_000 * 10 ** srcToken.decimals()
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
        path[1] = ADDRESS_SRC_TOKEN;

        uint256 amountOut = defaultSrcTokenAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_SRC_TOKEN,
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
        assertBalanceChange(ADDRESS_SRC_TOKEN, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_SRC_TOKEN, USER_RECEIVER, 0)
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
            ADDRESS_SRC_TOKEN,
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

        vm.expectRevert(
            abi.encodeWithSelector(
                InsufficientBalance.selector,
                bridgeData.minAmount,
                0
            )
        );

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }
}

contract GlacisFacetWormholeTest is GlacisFacetTestBase {
    function setUp() public virtual override {
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";
        customBlockNumberForForking = 298468086;

        airliftContract = IGlacisAirlift(
            0xE0A049955E18CFfd09C826C2c2e965439B6Ab272
        );
        ADDRESS_SRC_TOKEN = 0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91; // address of W token on Arbitrum network
        destinationChainId = 10;
        super.setUp();
    }
}

contract GlacisFacetLINKTest is GlacisFacetTestBase {
    function setUp() public virtual override {
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        customBlockNumberForForking = 25427676;

        airliftContract = IGlacisAirlift(
            0x56E20A6260644CC9F0B7d79a8C8E1e3Fabc15CEA
        );
        ADDRESS_SRC_TOKEN = 0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196; // address of LINK token on Base network
        destinationChainId = 34443;
        super.setUp();
    }
}
