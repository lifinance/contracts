// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { MultichainFacet } from "lifi/Facets/MultichainFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub MultichainFacet Contract
contract TestMultichainFacet is MultichainFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract MultichainFacetTest is DSTest, DiamondTest {
    // These values are for Polygon
    address internal constant BIFI_ADDRESS = 0xFbdd194376de19a88118e84E279b977f165d01b8;
    address internal constant BIFI_HOLDER = 0xf71B335A1d9449c381d867f4172Fc1BB3D2bfb7B;
    address internal constant WMATIC_ADDRESS = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    address internal constant WMATIC_HOLDER = 0x01aeFAC4A308FbAeD977648361fBAecFBCd380C7;
    address internal constant UNISWAP_V2_ROUTER = 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff;
    address internal constant BIFI_ROUTER = 0x6fF0609046A38D76Bd40C5863b4D1a2dCe687f73;
    uint256 internal constant DSTCHAIN_ID = 100;
    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestMultichainFacet internal multichainFacet;
    UniswapV2Router02 internal uniswap;
    ERC20 internal wmatic;
    ERC20 internal bifi;
    ILiFi.BridgeData internal validBridgeData;
    MultichainFacet.MultichainData internal validMultichainData;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_POLYGON");
        uint256 blockNumber = 35028600;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        multichainFacet = new TestMultichainFacet();
        wmatic = ERC20(WMATIC_ADDRESS);
        bifi = ERC20(BIFI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = multichainFacet.startBridgeTokensViaMultichain.selector;
        functionSelectors[1] = multichainFacet.swapAndStartBridgeTokensViaMultichain.selector;
        functionSelectors[2] = multichainFacet.initMultichain.selector;
        functionSelectors[3] = multichainFacet.addDex.selector;
        functionSelectors[4] = multichainFacet.setFunctionApprovalBySignature.selector;

        address[] memory routers = new address[](1);
        routers[0] = BIFI_ROUTER;

        addFacet(diamond, address(multichainFacet), functionSelectors);

        multichainFacet = TestMultichainFacet(address(diamond));
        multichainFacet.initMultichain(routers);

        multichainFacet.addDex(address(uniswap));
        multichainFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        multichainFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "multichain",
            integrator: "",
            referrer: address(0),
            sendingAssetId: BIFI_ADDRESS,
            receiver: BIFI_HOLDER,
            minAmount: 10 * 10**bifi.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        validMultichainData = MultichainFacet.MultichainData(BIFI_ROUTER);
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(BIFI_HOLDER);

        bifi.approve(address(multichainFacet), 10_000 * 10**bifi.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        multichainFacet.startBridgeTokensViaMultichain(bridgeData, validMultichainData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(BIFI_HOLDER);

        bifi.approve(address(multichainFacet), 10_000 * 10**bifi.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        multichainFacet.startBridgeTokensViaMultichain(bridgeData, validMultichainData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(BIFI_HOLDER);

        bifi.approve(address(multichainFacet), 10_000 * 10**bifi.decimals());

        bifi.transfer(WMATIC_HOLDER, bifi.balanceOf(BIFI_HOLDER));

        vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, 10 * 10**bifi.decimals(), 0));
        multichainFacet.startBridgeTokensViaMultichain(validBridgeData, validMultichainData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(BIFI_HOLDER);

        bifi.approve(address(multichainFacet), 10_000 * 10**bifi.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        multichainFacet.startBridgeTokensViaMultichain(bridgeData, validMultichainData);

        vm.stopPrank();
    }

    function testCanBridgeTokens() public {
        vm.startPrank(BIFI_HOLDER);
        bifi.approve(address(multichainFacet), 10_000 * 10**bifi.decimals());

        multichainFacet.startBridgeTokensViaMultichain(validBridgeData, validMultichainData);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(WMATIC_HOLDER);

        wmatic.approve(address(multichainFacet), 10_000 * 10**wmatic.decimals());

        // Swap WMATIC to BIFI
        address[] memory path = new address[](2);
        path[0] = WMATIC_ADDRESS;
        path[1] = BIFI_ADDRESS;

        uint256 amountOut = 10**bifi.decimals() / 10;

        // Calculate BIFI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            WMATIC_ADDRESS,
            BIFI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(multichainFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 10**bifi.decimals() / 10;
        bridgeData.hasSourceSwaps = true;

        multichainFacet.swapAndStartBridgeTokensViaMultichain(bridgeData, swapData, validMultichainData);

        vm.stopPrank();
    }
}
