// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBase, console, ERC20, UniswapV2Router02 } from "../utils/TestBase.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { HopFacetStandalone } from "lifi/Facets/HopFacetStandalone.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub HopFacet Contract
contract TestHopFacet is HopFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract TestHopFacetOptimized is HopFacetOptimized {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HopFacetTestCompare is TestBase {
    // EVENTS
    event HopBridgeRegistered(address indexed assetId, address bridge);
    event HopInitialized(HopFacet.Config[] configs);

    // These values are for Mainnet
    address internal constant USDC_BRIDGE = 0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant DAI_BRIDGE = 0x3d4Cc8A61c7528Fd86C55cfe061a78dCBA48EDd1;
    address internal constant NATIVE_BRIDGE = 0xb8901acB165ed027E32754E0FFe830802919727f;
    address internal constant CONNEXT_HANDLER = 0xB4C1340434920d70aD774309C75f9a4B679d801e;
    uint256 internal constant DSTCHAIN_ID = 137;
    // -----

    TestHopFacet internal hopFacet;
    TestHopFacetOptimized internal hopFacetOptimized;
    HopFacetStandalone internal hopFacetStandalone;
    ILiFi.BridgeData internal validBridgeData;
    HopFacet.HopData internal validHopData;
    HopFacetOptimized.HopData internal validHopDataOptimized;
    HopFacetStandalone.HopData internal validHopDataStandalone;

    function setUp() public {
        //! 1) set up original facet with diamond
        initTestBase();
        hopFacet = new TestHopFacet();
        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = hopFacet.startBridgeTokensViaHop.selector;
        functionSelectors[1] = hopFacet.swapAndStartBridgeTokensViaHop.selector;
        functionSelectors[2] = hopFacet.initHop.selector;
        functionSelectors[3] = hopFacet.registerBridge.selector;
        functionSelectors[4] = hopFacet.addDex.selector;
        functionSelectors[5] = hopFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(hopFacet), functionSelectors);

        HopFacet.Config[] memory configs = new HopFacet.Config[](3);
        configs[0] = HopFacet.Config(ADDRESS_USDC, USDC_BRIDGE);
        configs[1] = HopFacet.Config(ADDRESS_DAI, DAI_BRIDGE);
        configs[2] = HopFacet.Config(address(0), NATIVE_BRIDGE);

        hopFacet = TestHopFacet(address(diamond));
        hopFacet.initHop(configs);

        hopFacet.addDex(address(uniswap));
        hopFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        hopFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);
        hopFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        setFacetAddressInTestBase(address(hopFacet), "HopFacet");

        // adjust bridgeData
        bridgeData.bridge = "hop";
        bridgeData.destinationChainId = 137;

        // produce valid HopData
        validHopData = HopFacet.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20
        });

        //! 2) set up optimized facet with diamond
        diamond = createDiamond();

        hopFacetOptimized = new TestHopFacetOptimized();
        bytes4[] memory functionSelectors2 = new bytes4[](6);
        functionSelectors2[0] = hopFacetOptimized.startBridgeTokensViaHop.selector;
        functionSelectors2[1] = hopFacetOptimized.swapAndStartBridgeTokensViaHop.selector;
        functionSelectors2[2] = hopFacetOptimized.initHop.selector;
        functionSelectors2[3] = hopFacetOptimized.registerBridge.selector;
        functionSelectors2[4] = hopFacetOptimized.addDex.selector;
        functionSelectors2[5] = hopFacetOptimized.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(hopFacetOptimized), functionSelectors);

        HopFacetOptimized.Config[] memory configs2 = new HopFacetOptimized.Config[](3);
        configs2[0] = HopFacetOptimized.Config(ADDRESS_USDC, USDC_BRIDGE);
        configs2[1] = HopFacetOptimized.Config(ADDRESS_DAI, DAI_BRIDGE);
        configs2[2] = HopFacetOptimized.Config(address(0), NATIVE_BRIDGE);

        hopFacetOptimized = TestHopFacetOptimized(address(diamond));
        hopFacetOptimized.initHop(configs2);

        hopFacetOptimized.addDex(address(uniswap));
        hopFacetOptimized.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        hopFacetOptimized.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);
        hopFacetOptimized.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        setFacetAddressInTestBase(address(hopFacetOptimized), "HopFacet");

        // produce valid HopData
        validHopDataOptimized = HopFacetOptimized.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20
        });

        //! 3) deploy gas-optimized standalone hop facet
        hopFacetStandalone = new HopFacetStandalone();
        HopFacetStandalone.Config[] memory configs3 = new HopFacetStandalone.Config[](3);
        configs3[0] = HopFacetStandalone.Config(ADDRESS_USDC, USDC_BRIDGE);
        configs3[1] = HopFacetStandalone.Config(ADDRESS_DAI, DAI_BRIDGE);
        configs3[2] = HopFacetStandalone.Config(address(0), NATIVE_BRIDGE);
        hopFacetStandalone.initHop(configs3);
        // produce valid HopData
        validHopDataStandalone = HopFacetStandalone.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20
        });
    }

    function test_bridgeTokens_1_STANDARD() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(hopFacet), bridgeData.minAmount);

        uint256 startGas = gasleft();
        hopFacet.startBridgeTokensViaHop(bridgeData, validHopData);
        vm.writeLine(logFilePath, string.concat("Gas used STANDARD:   ", vm.toString(startGas - gasleft())));

        vm.stopPrank();
    }

    function test_bridgeTokens_2_OPTIMIZED() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(hopFacetOptimized), bridgeData.minAmount);
        uint256 startGas = gasleft();
        hopFacetOptimized.startBridgeTokensViaHop(bridgeData, validHopDataOptimized);
        vm.writeLine(logFilePath, string.concat("Gas used OPTIMIZED:  ", vm.toString(startGas - gasleft())));
        vm.stopPrank();
    }

    function test_bridgeTokens_3_STANDALONE() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(hopFacetStandalone), bridgeData.minAmount);
        uint256 startGas = gasleft();
        hopFacetStandalone.startBridgeTokensViaHop(bridgeData, validHopDataStandalone);
        vm.writeLine(logFilePath, string.concat("Gas used STANDALONE: ", vm.toString(startGas - gasleft())));
        vm.stopPrank();
    }
}
