// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { HyphenFacet } from "lifi/Facets/HyphenFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IHyphenRouter } from "lifi/Interfaces/IHyphenRouter.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub HyphenFacet Contract
contract TestHyphenFacet is HyphenFacet {
    constructor(IHyphenRouter _router) HyphenFacet(_router) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HyphenFacetTesBackup is DSTest, DiamondTest {
    // These values are for Polygon
    address internal constant USDC_ADDRESS = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address internal constant USDC_HOLDER = 0xD6216fC19DB775Df9774a6E33526131dA7D19a2c;
    address internal constant WMATIC_ADDRESS = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    address internal constant WMATIC_HOLDER = 0x01aeFAC4A308FbAeD977648361fBAecFBCd380C7;
    address internal constant HYPHEN_ROUTER = 0x2A5c2568b10A0E826BfA892Cf21BA7218310180b;
    address internal constant UNISWAP_V2_ROUTER = 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff;
    uint256 internal constant DSTCHAIN_ID = 43114;
    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestHyphenFacet internal hyphenFacet;
    UniswapV2Router02 internal uniswap;
    ERC20 internal wmatic;
    ERC20 internal usdc;
    ILiFi.BridgeData internal validBridgeData;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_POLYGON");
        uint256 blockNumber = 35028600;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        hyphenFacet = new TestHyphenFacet(IHyphenRouter(HYPHEN_ROUTER));
        wmatic = ERC20(WMATIC_ADDRESS);
        usdc = ERC20(USDC_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = hyphenFacet.startBridgeTokensViaHyphen.selector;
        functionSelectors[1] = hyphenFacet.swapAndStartBridgeTokensViaHyphen.selector;
        functionSelectors[2] = hyphenFacet.addDex.selector;
        functionSelectors[3] = hyphenFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(hyphenFacet), functionSelectors);

        hyphenFacet = TestHyphenFacet(address(diamond));

        hyphenFacet.addDex(address(uniswap));
        hyphenFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        hyphenFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "hyphen",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_ADDRESS,
            receiver: USDC_HOLDER,
            minAmount: 10 * 10**usdc.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(hyphenFacet), 10_000 * 10**usdc.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        hyphenFacet.startBridgeTokensViaHyphen(bridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(hyphenFacet), 10_000 * 10**usdc.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        hyphenFacet.startBridgeTokensViaHyphen(bridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(hyphenFacet), 10_000 * 10**usdc.decimals());

        usdc.transfer(WMATIC_HOLDER, usdc.balanceOf(USDC_HOLDER));

        vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, 10 * 10**usdc.decimals(), 0));
        hyphenFacet.startBridgeTokensViaHyphen(validBridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(hyphenFacet), 10_000 * 10**usdc.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        hyphenFacet.startBridgeTokensViaHyphen(bridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSendingTokenIsNotSupported() public {
        vm.startPrank(WMATIC_HOLDER);

        wmatic.approve(address(hyphenFacet), 10_000 * 10**wmatic.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = WMATIC_ADDRESS;

        vm.expectRevert(abi.encodePacked("Token not supported"));
        hyphenFacet.startBridgeTokensViaHyphen(bridgeData);

        vm.stopPrank();
    }

    function testCanBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(address(hyphenFacet), 10_000 * 10**usdc.decimals());

        hyphenFacet.startBridgeTokensViaHyphen(validBridgeData);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(WMATIC_HOLDER);

        wmatic.approve(address(hyphenFacet), 10_000 * 10**wmatic.decimals());

        // Swap WMATIC to USDC
        address[] memory path = new address[](2);
        path[0] = WMATIC_ADDRESS;
        path[1] = USDC_ADDRESS;

        uint256 amountOut = 10 * 10**usdc.decimals();

        // Calculate USDC amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            WMATIC_ADDRESS,
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(hyphenFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        hyphenFacet.swapAndStartBridgeTokensViaHyphen(bridgeData, swapData);

        vm.stopPrank();
    }
}
