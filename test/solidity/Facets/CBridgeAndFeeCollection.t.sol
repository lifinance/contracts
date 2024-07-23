// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { LibAllowList, TestBase, console, LiFiDiamond } from "../utils/TestBase.sol";

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

contract CBridgeAndFeeCollectionTest is TestBase {
    address internal constant CBRIDGE_ROUTER =
        0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant WHALE =
        0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;

    TestCBridgeFacet internal cBridge;

    function setUp() public {
        customBlockNumberForForking = 14847528;
        initTestBase();

        cBridge = new TestCBridgeFacet(ICBridge(CBRIDGE_ROUTER));

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
            ADDRESS_USDC,
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
            ADDRESS_USDC,
            ADDRESS_USDC,
            amount + fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_USDC,
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
            feeCollector.getTokenBalance(address(0xb33f), ADDRESS_USDC),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance(ADDRESS_USDC), lifiFee);
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
            ADDRESS_DAI,
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
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;
        uint256[] memory amounts = uniswap.getAmountsIn(amountToBridge, path);
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            ADDRESS_USDC,
            ADDRESS_USDC,
            amountIn + fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_USDC,
                fee,
                lifiFee,
                address(0xb33f)
            ),
            true
        );

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC,
            ADDRESS_DAI,
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
            feeCollector.getTokenBalance(address(0xb33f), ADDRESS_USDC),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance(ADDRESS_USDC), lifiFee);
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
            ADDRESS_USDC,
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
        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_USDC;
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
            ADDRESS_USDC,
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
            ADDRESS_DAI,
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
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;
        uint256[] memory amounts = uniswap.getAmountsIn(
            amountToBridge + fee + lifiFee,
            path
        );
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);

        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC,
            ADDRESS_DAI,
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
            ADDRESS_DAI,
            ADDRESS_DAI,
            fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_DAI,
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
            feeCollector.getTokenBalance(address(0xb33f), ADDRESS_DAI),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance(ADDRESS_DAI), lifiFee);
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
            ADDRESS_USDC,
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
        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_USDC;
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
            ADDRESS_USDC,
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
            ADDRESS_USDC,
            ADDRESS_USDC,
            fee + lifiFee,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_USDC,
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
            feeCollector.getTokenBalance(address(0xb33f), ADDRESS_USDC),
            fee
        );
        assertEq(feeCollector.getLifiTokenBalance(ADDRESS_USDC), lifiFee);
        assertEq(address(cBridge).balance, 0);
        assertEq(usdc.balanceOf(address(cBridge)), 0);
    }
}
