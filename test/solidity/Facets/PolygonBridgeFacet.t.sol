// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IRootChainManager } from "lifi/Interfaces/IRootChainManager.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub PolygonBridgeFacet Contract
contract TestPolygonBridgeFacet is PolygonBridgeFacet {
    constructor(IRootChainManager _rootChainManager, address _erc20Predicate)
        PolygonBridgeFacet(_rootChainManager, _erc20Predicate)
    {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract PolygonBridgeFacetTest is DSTest, DiamondTest {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_HOLDER = 0xaD0135AF20fa82E106607257143d0060A7eB5cBf;
    address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant DAI_HOLDER = 0x4943b0C9959dcf58871A799dfB71becE0D97c9f4;
    address internal constant ROOT_CHAIN_MANAGER = 0xA0c68C638235ee32657e8f720a23ceC1bFc77C77;
    address internal constant ERC20_PREDICATE = 0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    uint256 internal constant DSTCHAIN_ID = 137;

    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestPolygonBridgeFacet internal polygonBridgeFacet;
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    ILiFi.BridgeData internal validBridgeData;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15876510;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        polygonBridgeFacet = new TestPolygonBridgeFacet(IRootChainManager(ROOT_CHAIN_MANAGER), ERC20_PREDICATE);
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = polygonBridgeFacet.startBridgeTokensViaPolygonBridge.selector;
        functionSelectors[1] = polygonBridgeFacet.swapAndStartBridgeTokensViaPolygonBridge.selector;
        functionSelectors[2] = polygonBridgeFacet.addDex.selector;
        functionSelectors[3] = polygonBridgeFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(polygonBridgeFacet), functionSelectors);

        polygonBridgeFacet = TestPolygonBridgeFacet(address(diamond));

        polygonBridgeFacet.addDex(address(uniswap));
        polygonBridgeFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        polygonBridgeFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "polygon",
            integrator: "",
            referrer: address(0),
            sendingAssetId: DAI_ADDRESS,
            receiver: DAI_HOLDER,
            minAmount: 10 * 10**dai.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(DAI_HOLDER);

        dai.approve(address(polygonBridgeFacet), 10_000 * 10**dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        polygonBridgeFacet.startBridgeTokensViaPolygonBridge(bridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(DAI_HOLDER);

        dai.approve(address(polygonBridgeFacet), 10_000 * 10**dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        polygonBridgeFacet.startBridgeTokensViaPolygonBridge(bridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(DAI_HOLDER);

        dai.approve(address(polygonBridgeFacet), 10_000 * 10**dai.decimals());

        dai.transfer(USDC_HOLDER, dai.balanceOf(DAI_HOLDER));

        vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, 10 * 10**dai.decimals(), 0));
        polygonBridgeFacet.startBridgeTokensViaPolygonBridge(validBridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSendingNoEnoughNativeAsset() public {
        vm.startPrank(DAI_HOLDER);

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 3e18;

        vm.expectRevert(InvalidAmount.selector);
        polygonBridgeFacet.startBridgeTokensViaPolygonBridge{ value: 2e18 }(bridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(DAI_HOLDER);

        dai.approve(address(polygonBridgeFacet), 10_000 * 10**dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        polygonBridgeFacet.startBridgeTokensViaPolygonBridge(bridgeData);

        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(DAI_HOLDER);
        dai.approve(address(polygonBridgeFacet), 10_000 * 10**dai.decimals());

        polygonBridgeFacet.startBridgeTokensViaPolygonBridge(validBridgeData);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(polygonBridgeFacet), 10_000 * 10**usdc.decimals());

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_ADDRESS;

        uint256 amountOut = 1000 * 10**dai.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(polygonBridgeFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        polygonBridgeFacet.swapAndStartBridgeTokensViaPolygonBridge(bridgeData, swapData);

        vm.stopPrank();
    }
}
