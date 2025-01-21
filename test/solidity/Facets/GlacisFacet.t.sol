// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, ERC20 } from "../utils/TestBaseFacet.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { GlacisFacet } from "lifi/Facets/GlacisFacet.sol";
import { IGlacisAirlift, QuoteSendInfo } from "lifi/Interfaces/IGlacisAirlift.sol";
import { InsufficientBalance } from "lifi/Errors/GenericErrors.sol";

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

contract GlacisFacetTest is TestBaseFacet {
    GlacisFacet.GlacisData internal validGlacisData;
    TestGlacisFacet internal glacisFacet;
    ERC20 internal wormhole;
    uint256 internal defaultWORMHOLEAmount;
    uint256 internal tokenFee;

    IGlacisAirlift internal constant airlift =
        IGlacisAirlift(0xE0A049955E18CFfd09C826C2c2e965439B6Ab272);
    address internal ADDRESS_WORMHOLE_TOKEN =
        0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91;

    uint256 internal payableAmount = 1 ether;

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";
        customBlockNumberForForking = 297418708;
        initTestBase();

        wormhole = ERC20(ADDRESS_WORMHOLE_TOKEN);

        defaultWORMHOLEAmount = 1_000 * 10 ** wormhole.decimals();

        deal(
            ADDRESS_WORMHOLE_TOKEN,
            USER_SENDER,
            500_000 * 10 ** wormhole.decimals()
        );

        glacisFacet = new TestGlacisFacet(airlift);
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

        setFacetAddressInTestBase(address(glacisFacet), "GlacisFacet");

        // adjust bridgeData
        bridgeData.bridge = "glacis";
        bridgeData.sendingAssetId = ADDRESS_WORMHOLE_TOKEN;
        bridgeData.minAmount = defaultWORMHOLEAmount;
        bridgeData.destinationChainId = 10;

        QuoteSendInfo memory quoteSendInfo = IGlacisAirlift(address(airlift))
            .quoteSend(
                bridgeData.sendingAssetId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(bridgeData.receiver))),
                bridgeData.destinationChainId,
                REFUND_WALLET,
                payableAmount
            );

        addToMessageValue =
            quoteSendInfo.gmpFee.nativeFee +
            quoteSendInfo.AirliftFeeInfo.airliftFee.nativeFee;

        // produce valid GlacisData
        validGlacisData = GlacisFacet.GlacisData({
            refund: REFUND_WALLET,
            nativeFee: addToMessageValue
        });
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        glacisFacet.startBridgeTokensViaGlacis{ value: addToMessageValue }(
            bridgeData,
            validGlacisData
        );
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        glacisFacet.swapAndStartBridgeTokensViaGlacis{
            value: addToMessageValue
        }(bridgeData, swapData, validGlacisData);
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(
            ADDRESS_WORMHOLE_TOKEN,
            USER_SENDER,
            -int256(defaultWORMHOLEAmount)
        )
        assertBalanceChange(ADDRESS_WORMHOLE_TOKEN, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // approval
        wormhole.approve(address(glacisFacet), bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(glacisFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // TODO
    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // TODO can be related to this issue: https://github.com/glacislabs/airlift-evm/blob/main/test/tokens/MIM.t.sol#L23-L31
        vm.assume(
            amount > 0 * 10 ** wormhole.decimals() &&
                amount < 100_000 * 10 ** wormhole.decimals()
        );
        vm.startPrank(USER_SENDER);
        bridgeData.minAmount = amount;
        // approval
        wormhole.approve(address(glacisFacet), bridgeData.minAmount);
        QuoteSendInfo memory quoteSendInfo = IGlacisAirlift(address(airlift))
            .quoteSend(
                bridgeData.sendingAssetId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(bridgeData.receiver))),
                bridgeData.destinationChainId,
                REFUND_WALLET,
                payableAmount
            );
        addToMessageValue =
            quoteSendInfo.gmpFee.nativeFee +
            quoteSendInfo.AirliftFeeInfo.airliftFee.nativeFee;
        //prepare check for events
        vm.expectEmit(true, true, true, true, address(glacisFacet));
        emit LiFiTransferStarted(bridgeData);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function setDefaultSwapDataSingleDAItoWORMHOLE() internal virtual {
        delete swapData;
        // Swap DAI -> WORMHOLE
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WORMHOLE_TOKEN;

        uint256 amountOut = defaultWORMHOLEAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_WORMHOLE_TOKEN,
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
        override
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_WORMHOLE_TOKEN, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_WORMHOLE_TOKEN, USER_RECEIVER, 0)
    {
        // add liquidity for dex pair
        addLiquidity(
            ADDRESS_DAI,
            ADDRESS_WORMHOLE_TOKEN,
            100_000 * 10 ** ERC20(ADDRESS_DAI).decimals(),
            100_000 * 10 ** wormhole.decimals()
        );

        uint256 initialDAIBalance = dai.balanceOf(USER_SENDER);
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        // reset swap data
        setDefaultSwapDataSingleDAItoWORMHOLE();

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_WORMHOLE_TOKEN,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);
        uint256 initialETHBalance = USER_SENDER.balance;
        initiateSwapAndBridgeTxWithFacet(false);

        // check balances after call
        assertEq(
            dai.balanceOf(USER_SENDER),
            initialDAIBalance - swapData[0].fromAmount
        );
        assertEq(USER_SENDER.balance, initialETHBalance - addToMessageValue);
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        vm.startPrank(USER_SENDER);

        wormhole.approve(
            address(_facetTestContractAddress),
            defaultWORMHOLEAmount
        );

        // send all available W balance to different account to ensure sending wallet has no W funds
        wormhole.transfer(USER_RECEIVER, wormhole.balanceOf(USER_SENDER));

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
