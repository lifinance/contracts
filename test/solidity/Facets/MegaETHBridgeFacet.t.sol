// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { MegaETHBridgeFacet } from "lifi/Facets/MegaETHBridgeFacet.sol";
import { IL1StandardBridge } from "lifi/Interfaces/IL1StandardBridge.sol";
import { LibAllowList, LibSwap, TestBase, ILiFi } from "../utils/TestBase.sol";
import { InvalidAmount, InvalidReceiver, InformationMismatch, TransferFromFailed } from "lifi/Errors/GenericErrors.sol";

// Stub MegaETHBridgeFacet Contract
contract TestMegaETHBridgeFacet is MegaETHBridgeFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract MegaETHBridgeFacetTest is TestBase {
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

    TestMegaETHBridgeFacet internal megaETHBridgeFacet;
    ILiFi.BridgeData internal validBridgeData;
    MegaETHBridgeFacet.MegaETHData internal validMegaETHData;

    function setUp() public {
        customBlockNumberForForking = 15876510;
        initTestBase();

        megaETHBridgeFacet = new TestMegaETHBridgeFacet();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = megaETHBridgeFacet
            .startBridgeTokensViaMegaETHBridge
            .selector;
        functionSelectors[1] = megaETHBridgeFacet
            .swapAndStartBridgeTokensViaMegaETHBridge
            .selector;
        functionSelectors[2] = megaETHBridgeFacet.initMegaETH.selector;
        functionSelectors[3] = megaETHBridgeFacet.addDex.selector;
        functionSelectors[4] = megaETHBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(megaETHBridgeFacet), functionSelectors);

        MegaETHBridgeFacet.Config[]
            memory configs = new MegaETHBridgeFacet.Config[](1);
        configs[0] = MegaETHBridgeFacet.Config(DAI_L1_ADDRESS, DAI_BRIDGE);

        megaETHBridgeFacet = TestMegaETHBridgeFacet(address(diamond));
        megaETHBridgeFacet.initMegaETH(
            configs,
            IL1StandardBridge(STANDARD_BRIDGE)
        );

        megaETHBridgeFacet.addDex(address(uniswap));
        megaETHBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        megaETHBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "megaeth",
            integrator: "",
            referrer: address(0),
            sendingAssetId: DAI_L1_ADDRESS,
            receiver: DAI_L1_HOLDER,
            minAmount: 10 * 10 ** dai.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        validMegaETHData = MegaETHBridgeFacet.MegaETHData(
            DAI_L2_ADDRESS,
            L2_GAS,
            false
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(megaETHBridgeFacet),
            "MegaETHBridgeFacet"
        );
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(megaETHBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        megaETHBridgeFacet.startBridgeTokensViaMegaETHBridge(
            bridgeData,
            validMegaETHData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(megaETHBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        megaETHBridgeFacet.startBridgeTokensViaMegaETHBridge(
            bridgeData,
            validMegaETHData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(megaETHBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        dai.transfer(USDC_HOLDER, dai.balanceOf(DAI_L1_HOLDER));

        vm.expectRevert(TransferFromFailed.selector);
        megaETHBridgeFacet.startBridgeTokensViaMegaETHBridge(
            validBridgeData,
            validMegaETHData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSendingNoEnoughNativeAsset() public {
        vm.startPrank(DAI_L1_HOLDER);

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 3e18;

        vm.expectRevert(InvalidAmount.selector);
        megaETHBridgeFacet.startBridgeTokensViaMegaETHBridge{ value: 2e18 }(
            bridgeData,
            validMegaETHData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(megaETHBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        megaETHBridgeFacet.startBridgeTokensViaMegaETHBridge(
            bridgeData,
            validMegaETHData
        );

        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(DAI_L1_HOLDER);
        dai.approve(
            address(megaETHBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        megaETHBridgeFacet.startBridgeTokensViaMegaETHBridge(
            validBridgeData,
            validMegaETHData
        );
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(
            address(megaETHBridgeFacet),
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
                address(megaETHBridgeFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        megaETHBridgeFacet.swapAndStartBridgeTokensViaMegaETHBridge(
            bridgeData,
            swapData,
            validMegaETHData
        );

        vm.stopPrank();
    }
}
