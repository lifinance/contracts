// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { GlacisFacet } from "lifi/Facets/GlacisFacet.sol";
import { IGlacisAirlift, QuoteSendInfo } from "lifi/Interfaces/IGlacisAirlift.sol";

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
    uint256 internal defaultWORMHOLEAmount;
    uint256 internal tokenFee;

    IGlacisAirlift internal constant airlift =
        IGlacisAirlift(0xE0A049955E18CFfd09C826C2c2e965439B6Ab272);
    address internal ADDRESS_WORMHOLE_TOKEN =
        0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91;
    uint256 internal payableAmount = 1 ether;

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";
        customBlockNumberForForking = 295706031;
        initTestBase();

        defaultWORMHOLEAmount =
            1_000 *
            10 ** ERC20(ADDRESS_WORMHOLE_TOKEN).decimals();

        deal(
            ADDRESS_WORMHOLE_TOKEN,
            USER_SENDER,
            100_000 * 10 ** ERC20(ADDRESS_WORMHOLE_TOKEN).decimals()
        );
        deal(
            ADDRESS_WORMHOLE_TOKEN,
            address(airlift),
            100_000 * 10 ** ERC20(ADDRESS_WORMHOLE_TOKEN).decimals()
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
        glacisFacet.addDex(ADDRESS_UNISWAP_ARB);
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

        // produce valid GlacisData
        validGlacisData = GlacisFacet.GlacisData({ refund: REFUND_WALLET });

        console.log(
            "============================ here0.1 ========================"
        );
        // (bool ok, bytes memory result) = address(airlift).staticcall(
        //     abi.encodeWithSignature(
        //         "quoteSend(address,uint256,bytes32,uint256,address,uint256)",
        //         bridgeData.sendingAssetId,
        //         bridgeData.minAmount,
        //         bytes32(uint256(uint160(bridgeData.receiver))),
        //         bridgeData.destinationChainId,
        //         REFUND_WALLET,
        //         payableAmount // TODO
        //     )
        // );
        // require(ok);
        QuoteSendInfo memory quoteSendInfo = IGlacisAirlift(address(airlift))
            .quoteSend(
                bridgeData.sendingAssetId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(bridgeData.receiver))),
                bridgeData.destinationChainId,
                REFUND_WALLET,
                payableAmount
            );

        // tokenFee =
        //     quoteSendInfo.gmpFee.tokenFee +
        //     quoteSendInfo.AirliftFeeInfo.airliftFee.tokenFee; // TODO Can we ignore tokenFee from smart contracts side? As far as I understand smart contract doesnt need to do any calculation with token fees. It will be only shown on the frontend side?

        addToMessageValue =
            quoteSendInfo.gmpFee.nativeFee +
            quoteSendInfo.AirliftFeeInfo.airliftFee.nativeFee;
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        // bridgeData.minAmount -= tokenFee;
        glacisFacet.startBridgeTokensViaGlacis{ value: addToMessageValue }(
            bridgeData,
            validGlacisData
        );
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
        ERC20(ADDRESS_WORMHOLE_TOKEN).approve(
            address(glacisFacet),
            bridgeData.minAmount
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(glacisFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // TODO
    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        //     // TODO can be related to this issue: https://github.com/glacislabs/airlift-evm/blob/main/test/tokens/MIM.t.sol#L23-L31
        //     vm.assume(amount > 1_000 * 10 ** ERC20(ADDRESS_WORMHOLE_TOKEN).decimals() && amount < 100_000 * 10 ** ERC20(ADDRESS_WORMHOLE_TOKEN).decimals());
        //     vm.startPrank(USER_SENDER);
        //     bridgeData.minAmount = amount;
        //     // approval
        //     ERC20(ADDRESS_WORMHOLE_TOKEN).approve(address(glacisFacet), bridgeData.minAmount);
        //     QuoteSendInfo memory quoteSendInfo = IGlacisAirlift(address(airlift)).quoteSend(
        //         bridgeData.sendingAssetId,
        //         bridgeData.minAmount,
        //         bytes32(uint256(uint160(bridgeData.receiver))),
        //         bridgeData.destinationChainId,
        //         REFUND_WALLET,
        //         payableAmount
        //     );
        //     addToMessageValue =
        //         quoteSendInfo.gmpFee.nativeFee +
        //         quoteSendInfo.AirliftFeeInfo.airliftFee.nativeFee;
        //     //prepare check for events
        //     vm.expectEmit(true, true, true, true, address(glacisFacet));
        //     emit LiFiTransferStarted(bridgeData);
        //     initiateBridgeTxWithFacet(false);
        //     vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function setDefaultSwapDataSingleDAItoWORMHOLE() internal virtual {
        delete swapData;
        // Swap DAI -> USDC
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WORMHOLE_TOKEN;

        uint256 amountOut = defaultUSDCAmount;

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
        virtual
        override
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_WORMHOLE_TOKEN, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_WORMHOLE_TOKEN, USER_RECEIVER, 0)
    {
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
            ADDRESS_UNISWAP_ARB,
            ADDRESS_DAI,
            ADDRESS_WORMHOLE_TOKEN,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        // TODO because there isnt any WORMHOLE pair on sushiswap
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        glacisFacet.swapAndStartBridgeTokensViaGlacis{
            value: addToMessageValue
        }(bridgeData, swapData, validGlacisData);
    }

    function test_CanBridgeAndPayFeeWithBridgedToken() public {}

    function test_CanSwapAndBridgeAndPayFeeWithBridgedToken() public {}

    // All facet test files inherit from `utils/TestBaseFacet.sol` and require the following method overrides:
    // - function initiateBridgeTxWithFacet(bool isNative)
    // - function initiateSwapAndBridgeTxWithFacet(bool isNative)
    //
    // These methods are used to run the following tests which must pass:
    // - testBase_CanBridgeNativeTokens()
    // - testBase_CanBridgeTokens()
    // - testBase_CanBridgeTokens_fuzzed(uint256)
    // - testBase_CanSwapAndBridgeNativeTokens()
    // - testBase_CanSwapAndBridgeTokens()
    // - testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress()
    // - testBase_Revert_BridgeToSameChainId()
    // - testBase_Revert_BridgeWithInvalidAmount()
    // - testBase_Revert_BridgeWithInvalidDestinationCallFlag()
    // - testBase_Revert_BridgeWithInvalidReceiverAddress()
    // - testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag()
    // - testBase_Revert_CallerHasInsufficientFunds()
    // - testBase_Revert_SwapAndBridgeToSameChainId()
    // - testBase_Revert_SwapAndBridgeWithInvalidAmount()
    // - testBase_Revert_SwapAndBridgeWithInvalidSwapData()
    //
    // In some cases it doesn't make sense to have all tests. For example the bridge may not support native tokens.
    // In that case you can override the test method and leave it empty. For example:
    //
    // function testBase_CanBridgeNativeTokens() public override {
    //     // facet does not support bridging of native assets
    // }
    //
    // function testBase_CanSwapAndBridgeNativeTokens() public override {
    //     // facet does not support bridging of native assets
    // }
}
