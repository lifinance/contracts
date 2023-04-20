// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";

// Stub CBridgeFacet Contract
contract TestCBridgeFacet is CBridgeFacet {
    constructor(ICBridge _cBridge) CBridgeFacet(_cBridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract CBridgeAndFeeCollectionTest is DSTest, DiamondTest {
    address internal constant CBRIDGE_ROUTER =
        0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant UNISWAP_V2_ROUTER =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant USDC_ADDRESS =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant DAI_ADDRESS =
        0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant WETH_ADDRESS =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant WHALE =
        0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestCBridgeFacet internal cBridge;
    ERC20 internal usdc;
    ERC20 internal dai;
    UniswapV2Router02 internal uniswap;
    FeeCollector internal feeCollector;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 14847528;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        cBridge = new TestCBridgeFacet(ICBridge(CBRIDGE_ROUTER));
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);
        feeCollector = new FeeCollector(address(this));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = cBridge.startBridgeTokensViaCBridge.selector;
        functionSelectors[1] = cBridge
            .swapAndStartBridgeTokensViaCBridge
            .selector;
        functionSelectors[2] = cBridge.addDex.selector;
        functionSelectors[3] = cBridge.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(cBridge), functionSelectors);

        cBridge = TestCBridgeFacet(address(diamond));
        cBridge.addDex(address(uniswap));
        cBridge.addDex(address(feeCollector));
        cBridge.setFunctionApprovalBySignature(
            bytes4(feeCollector.collectTokenFees.selector)
        );
        cBridge.setFunctionApprovalBySignature(
            bytes4(feeCollector.collectNativeFees.selector)
        );
        cBridge.setFunctionApprovalBySignature(
            bytes4(uniswap.swapExactTokensForTokens.selector)
        );
        cBridge.setFunctionApprovalBySignature(
            bytes4(uniswap.swapETHForExactTokens.selector)
        );
    }

    // struct CILiFi.BridgeData {
    //     address cBridge;
    //     uint32 maxSlippage;
    //     uint64 dstChainId;
    //     uint64 nonce;
    //     uint256 amount;
    //     address receiver;
    //     address token;
    // }

    function testCanCollectTokenFeesAndBridgeTokens() public {
        vm.startPrank(WHALE);

        uint256 amount = 1_000 * 10 ** usdc.decimals();
        uint256 fee = 10 * 10 ** usdc.decimals();
        uint256 lifiFee = 5 * 10 ** usdc.decimals();

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            USDC_ADDRESS,
            WHALE,
            amount - fee - lifiFee,
            100,
            true,
            false
        );
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            1
        );

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            USDC_ADDRESS,
            USDC_ADDRESS,
            amount + fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                USDC_ADDRESS,
                fee,
                lifiFee,
                address(0xb33f)
            ),
            true
        );
        // Approve USDC
        usdc.approve(address(cBridge), amount + fee + lifiFee);
        cBridge.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, data);
        vm.stopPrank();

        assertEq(
            feeCollector.getTokenBalance(address(0xb33f), USDC_ADDRESS),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance(USDC_ADDRESS), lifiFee);
        assertEq(usdc.balanceOf(address(cBridge)), 0);
    }

    function testCanCollectNativeFeesAndBridgeTokens() public {
        vm.startPrank(WHALE);

        uint256 amount = 0.1 ether;
        uint256 fee = 0.001 ether;
        uint256 lifiFee = 0.00015 ether;

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            address(0),
            WHALE,
            amount - fee - lifiFee,
            100,
            true,
            false
        );

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            1
        );

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            address(0),
            address(0),
            amount + fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectNativeFees.selector,
                fee,
                lifiFee,
                address(0xb33f)
            ),
            true
        );

        cBridge.swapAndStartBridgeTokensViaCBridge{
            value: amount + fee + lifiFee
        }(bridgeData, swapData, data);
        vm.stopPrank();

        assertEq(
            feeCollector.getTokenBalance(address(0xb33f), address(0)),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance((address(0))), lifiFee);
    }

    function testCanCollectTokenFeesSwapAndBridgeTokens() public {
        vm.startPrank(WHALE);

        uint256 amountToBridge = 1_000 * 10 ** dai.decimals();
        uint256 fee = 10 * 10 ** usdc.decimals();
        uint256 lifiFee = 5 * 10 ** usdc.decimals();

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            DAI_ADDRESS,
            WHALE,
            amountToBridge,
            100,
            true,
            false
        );

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            1
        );

        // Calculate USDC amount
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_ADDRESS;
        uint256[] memory amounts = uniswap.getAmountsIn(amountToBridge, path);
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            USDC_ADDRESS,
            USDC_ADDRESS,
            amountIn + fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                USDC_ADDRESS,
                fee,
                lifiFee,
                address(0xb33f)
            ),
            true
        );

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountToBridge,
                path,
                address(cBridge),
                block.timestamp
            ),
            false
        );
        // Approve USDC
        usdc.approve(address(cBridge), amountIn + fee + lifiFee);
        cBridge.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, data);
        vm.stopPrank();

        assertEq(
            feeCollector.getTokenBalance(address(0xb33f), USDC_ADDRESS),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance(USDC_ADDRESS), lifiFee);
        assertEq(usdc.balanceOf(address(cBridge)), 0);
        assertEq(dai.balanceOf(address(cBridge)), 0);
    }

    function testCanCollectNativeFeesSwapAndBridgeTokens() public {
        vm.startPrank(WHALE);

        uint256 amountToBridge = 1000 * 10 ** usdc.decimals();
        uint256 fee = 0.01 ether;
        uint256 lifiFee = 0.0015 ether;

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            USDC_ADDRESS,
            WHALE,
            amountToBridge,
            100,
            true,
            false
        );

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            1
        );

        // Calculate USDC amount
        address[] memory path = new address[](2);
        path[0] = WETH_ADDRESS;
        path[1] = USDC_ADDRESS;
        uint256[] memory amounts = uniswap.getAmountsIn(amountToBridge, path);
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            address(0),
            address(0),
            fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectNativeFees.selector,
                fee,
                lifiFee,
                address(0xb33f)
            ),
            true
        );

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0),
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapETHForExactTokens.selector,
                amountToBridge,
                path,
                address(cBridge),
                block.timestamp
            ),
            false
        );
        cBridge.swapAndStartBridgeTokensViaCBridge{
            value: amountIn + fee + lifiFee
        }(bridgeData, swapData, data);
        vm.stopPrank();

        assertEq(
            feeCollector.getTokenBalance(address(0xb33f), address(0)),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance(address(0)), lifiFee);
        assertEq(address(cBridge).balance, 0);
        assertEq(usdc.balanceOf(address(cBridge)), 0);
    }

    function testCanSwapCollectTokenFeesAndBridgeTokens() public {
        vm.startPrank(WHALE);

        uint256 amountToBridge = 1_000 * 10 ** dai.decimals();
        uint256 fee = 10 * 10 ** dai.decimals();
        uint256 lifiFee = 5 * 10 ** dai.decimals();

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            DAI_ADDRESS,
            WHALE,
            amountToBridge,
            100,
            true,
            false
        );

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            1
        );

        // Calculate USDC amount
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_ADDRESS;
        uint256[] memory amounts = uniswap.getAmountsIn(
            amountToBridge + fee + lifiFee,
            path
        );
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);

        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountToBridge,
                path,
                address(cBridge),
                block.timestamp
            ),
            true
        );

        swapData[1] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            DAI_ADDRESS,
            DAI_ADDRESS,
            fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                DAI_ADDRESS,
                fee,
                lifiFee,
                address(0xb33f)
            ),
            false
        );
        // Approve USDC
        usdc.approve(address(cBridge), amountIn + fee + lifiFee);
        cBridge.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, data);
        vm.stopPrank();

        assertEq(
            feeCollector.getTokenBalance(address(0xb33f), DAI_ADDRESS),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance(DAI_ADDRESS), lifiFee);
        assertEq(usdc.balanceOf(address(cBridge)), 0);
        assertEq(dai.balanceOf(address(cBridge)), 0);
    }

    function testCanSwapCollectNativeFeesAndBridgeTokens() public {
        vm.startPrank(WHALE);

        uint256 amountToBridge = 1000 * 10 ** usdc.decimals();
        uint256 fee = 10 * 10 ** usdc.decimals();
        uint256 lifiFee = 5 * 10 ** usdc.decimals();

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            USDC_ADDRESS,
            WHALE,
            amountToBridge,
            100,
            true,
            false
        );

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            1
        );

        // Calculate USDC amount
        address[] memory path = new address[](2);
        path[0] = WETH_ADDRESS;
        path[1] = USDC_ADDRESS;
        uint256[] memory amounts = uniswap.getAmountsIn(
            amountToBridge + fee + lifiFee,
            path
        );
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);

        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0),
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapETHForExactTokens.selector,
                amountToBridge + fee + lifiFee,
                path,
                address(cBridge),
                block.timestamp
            ),
            true
        );

        swapData[1] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            USDC_ADDRESS,
            USDC_ADDRESS,
            fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                USDC_ADDRESS,
                fee,
                lifiFee,
                address(0xb33f)
            ),
            false
        );
        cBridge.swapAndStartBridgeTokensViaCBridge{ value: amountIn }(
            bridgeData,
            swapData,
            data
        );
        vm.stopPrank();

        assertEq(
            feeCollector.getTokenBalance(address(0xb33f), USDC_ADDRESS),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance(USDC_ADDRESS), lifiFee);
        assertEq(address(cBridge).balance, 0);
        assertEq(usdc.balanceOf(address(cBridge)), 0);
    }
}
