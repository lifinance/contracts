pragma solidity 0.8.17;

import { IHopBridge } from "lifi/Interfaces/IHopBridge.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";
import { LibAllowList, LibSwap, TestBase, console, LiFiDiamond, ILiFi, ERC20 } from "../utils/TestBase.sol";

contract HopGasTest is TestBase {
    address internal constant HOP_USDC_BRIDGE =
        0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant WHALE =
        0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;

    IHopBridge internal hop;
    HopFacet internal hopFacet;

    function setUp() public {
        // set custom block number for forking
        customBlockNumberForForking = 14847528;
        initTestBase();

        hopFacet = new HopFacet();
        hop = IHopBridge(HOP_USDC_BRIDGE);

        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = hopFacet.initHop.selector;
        functionSelectors[1] = hopFacet.startBridgeTokensViaHop.selector;

        addFacet(diamond, address(hopFacet), functionSelectors);
        hopFacet = HopFacet(address(diamond));

        HopFacet.Config[] memory config = new HopFacet.Config[](1);
        config[0] = HopFacet.Config(ADDRESS_USDC, HOP_USDC_BRIDGE);
        hopFacet.initHop(config);

        string[] memory tokens = new string[](1);
        tokens[0] = "USDC";

        // set facet address in TestBase
        setFacetAddressInTestBase(address(hopFacet), "HopFacet");
    }

    function testDirectBridge() public {
        uint256 amount = 100 * 10 ** usdc.decimals();
        uint256 amountOutMin = 99 * 10 ** usdc.decimals();
        uint256 deadline = block.timestamp + 20 minutes;

        vm.startPrank(WHALE);
        usdc.approve(HOP_USDC_BRIDGE, amount);
        hop.sendToL2(
            137,
            WHALE,
            amount,
            amountOutMin,
            deadline,
            address(0),
            0
        );
        vm.stopPrank();
    }

    function testLifiBridge() public {
        uint256 amount = 100 * 10 ** usdc.decimals();
        uint256 amountOutMin = 99 * 10 ** usdc.decimals();
        uint256 deadline = block.timestamp + 20 minutes;

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "hop",
            "",
            address(0),
            ADDRESS_USDC,
            WHALE,
            amount,
            137,
            false,
            false
        );

        HopFacet.HopData memory hopData = HopFacet.HopData(
            0, // not needed
            0, // not needed
            0, // not needed
            amountOutMin,
            deadline,
            address(0),
            0,
            0
        );

        vm.startPrank(WHALE);
        vm.chainId(1); // Only needed because of bug in forge forking...
        usdc.approve(address(hopFacet), amount);
        hopFacet.startBridgeTokensViaHop(bridgeData, hopData);
        vm.stopPrank();
    }
}
