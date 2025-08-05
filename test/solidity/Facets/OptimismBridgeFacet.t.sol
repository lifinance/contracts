// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";
import { IL1StandardBridge } from "lifi/Interfaces/IL1StandardBridge.sol";
import { LibAllowList, LibSwap, TestBase, ILiFi } from "../utils/TestBase.sol";
import { InvalidAmount, InvalidReceiver, InformationMismatch, TransferFromFailed } from "lifi/Errors/GenericErrors.sol";

// Stub OptimismBridgeFacet Contract
contract TestOptimismBridgeFacet is OptimismBridgeFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract OptimismBridgeFacetTest is TestBase {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_HOLDER =
        0xaD0135AF20fa82E106607257143d0060A7eB5cBf;
    address internal constant DAI_L1_ADDRESS =
        0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant DAI_L1_HOLDER =
        0x4943b0C9959dcf58871A799dfB71becE0D97c9f4;
    address internal constant DAI_L2_ADDRESS =
        0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address internal constant STANDARD_BRIDGE =
        0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1;
    address internal constant DAI_BRIDGE =
        0x10E6593CDda8c58a1d0f14C5164B376352a55f2F;
    address internal constant UNISWAP_V2_ROUTER =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    uint256 internal constant DSTCHAIN_ID = 10;
    uint32 internal constant L2_GAS = 200000;

    // -----

    TestOptimismBridgeFacet internal optimismBridgeFacet;
    ILiFi.BridgeData internal validBridgeData;
    OptimismBridgeFacet.OptimismData internal validOptimismData;

    function setUp() public {
        customBlockNumberForForking = 15876510;
        initTestBase();

        optimismBridgeFacet = new TestOptimismBridgeFacet();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = optimismBridgeFacet
            .startBridgeTokensViaOptimismBridge
            .selector;
        functionSelectors[1] = optimismBridgeFacet
            .swapAndStartBridgeTokensViaOptimismBridge
            .selector;
        functionSelectors[2] = optimismBridgeFacet.initOptimism.selector;
        functionSelectors[3] = optimismBridgeFacet.addDex.selector;
        functionSelectors[4] = optimismBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(optimismBridgeFacet), functionSelectors);

        OptimismBridgeFacet.Config[]
            memory configs = new OptimismBridgeFacet.Config[](1);
        configs[0] = OptimismBridgeFacet.Config(DAI_L1_ADDRESS, DAI_BRIDGE);

        optimismBridgeFacet = TestOptimismBridgeFacet(address(diamond));
        optimismBridgeFacet.initOptimism(
            configs,
            IL1StandardBridge(STANDARD_BRIDGE)
        );

        optimismBridgeFacet.addDex(address(uniswap));
        optimismBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        optimismBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "optimism",
            integrator: "",
            referrer: address(0),
            sendingAssetId: DAI_L1_ADDRESS,
            receiver: DAI_L1_HOLDER,
            minAmount: 10 * 10 ** dai.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        validOptimismData = OptimismBridgeFacet.OptimismData(
            DAI_L2_ADDRESS,
            L2_GAS,
            false
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(optimismBridgeFacet),
            "OptimismBridgeFacet"
        );
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            bridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            bridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        dai.transfer(USDC_HOLDER, dai.balanceOf(DAI_L1_HOLDER));

        vm.expectRevert(TransferFromFailed.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            validBridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSendingNoEnoughNativeAsset() public {
        vm.startPrank(DAI_L1_HOLDER);

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 3e18;

        vm.expectRevert(InvalidAmount.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge{ value: 2e18 }(
            bridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            bridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(DAI_L1_HOLDER);
        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            validBridgeData,
            validOptimismData
        );
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** usdc.decimals()
        );

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_L1_ADDRESS;

        uint256 amountOut = 1000 * 10 ** dai.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_L1_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(optimismBridgeFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        optimismBridgeFacet.swapAndStartBridgeTokensViaOptimismBridge(
            bridgeData,
            swapData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function test_swapAndStartBridgeTokensViaOptimismBridge_RefundsExcessETH() public {
        vm.startPrank(USER_SENDER);
        
        // Set up bridge data for native ETH with swaps
        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0); // Native ETH
        bridgeData.minAmount = 0.1 ether;

        // Create swap data that swaps ETH to USDC
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0), // from ETH
            USDC_ADDRESS, // to USDC
            0.1 ether,
            abi.encodeWithSelector(
                uniswap.swapExactETHForTokens.selector,
                0,
                validTokenAddresses,
                address(optimismBridgeFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        // Send more ETH than needed - the excess should be refunded
        uint256 sentAmount = 1 ether; // Send 1 ETH when only 0.1 ETH is needed
        uint256 balanceBefore = USER_SENDER.balance;

        // This call should refund the excess ETH due to refundExcessNative modifier
        // If the modifier is removed (as mutant #1128 does), no refund occurs
        optimismBridgeFacet.swapAndStartBridgeTokensViaOptimismBridge{value: sentAmount}(
            bridgeData,
            swapData,
            validOptimismData
        );

        uint256 balanceAfter = USER_SENDER.balance;
        uint256 totalSpent = balanceBefore - balanceAfter;
        
        // With refundExcessNative: user should only lose ~0.1 ETH + gas
        // Without refundExcessNative: user loses full 1 ETH + gas
        // This test specifically targets mutant #1128 where refundExcessNative is deleted
        assertLt(totalSpent, 0.5 ether, "Should not lose more than 0.5 ETH (excess should be refunded)");
        
        // More precise check: should lose approximately 0.1 ETH plus reasonable gas costs
        assertGt(totalSpent, 0.05 ether, "Should spend at least 0.05 ETH for swap and gas");
        assertLt(totalSpent, 0.2 ether, "Should not spend more than 0.2 ETH (0.1 + gas)");

        vm.stopPrank();
    }
}
