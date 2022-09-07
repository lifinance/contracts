pragma solidity 0.8.13;

import "ds-test/test.sol";
import { IHopBridge } from "lifi/Interfaces/IHopBridge.sol";
import { Vm } from "forge-std/Vm.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { console } from "../utils/Console.sol";

contract HopGasTest is DSTest, DiamondTest {
    address internal constant HOP_USDC_BRIDGE = 0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WHALE = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;

    ILiFi.LiFiData internal lifiData = ILiFi.LiFiData("", "", address(0), address(0), address(0), address(0), 0, 0);

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    IHopBridge internal hop;
    ERC20 internal immutable usdc = ERC20(USDC_ADDRESS);
    LiFiDiamond internal diamond;
    HopFacet internal hopFacet;

    function setUp() public {
        diamond = createDiamond();
        hopFacet = new HopFacet();
        hop = IHopBridge(HOP_USDC_BRIDGE);

        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = hopFacet.startBridgeTokensViaHop.selector;

        addFacet(diamond, address(hopFacet), functionSelectors);
        hopFacet = HopFacet(address(diamond));

        IHopBridge.BridgeConfig[] memory config = new IHopBridge.BridgeConfig[](1);
        config[0] = IHopBridge.BridgeConfig(USDC_ADDRESS, HOP_USDC_BRIDGE, address(0));
        string[] memory tokens = new string[](1);
        tokens[0] = "USDC";
    }

    function testDirectBridge() public {
        uint256 amount = 100 * 10**usdc.decimals();
        uint256 amountOutMin = 99 * 10**usdc.decimals();
        uint256 deadline = block.timestamp + 20 minutes;

        vm.startPrank(WHALE);
        usdc.approve(HOP_USDC_BRIDGE, amount);
        hop.sendToL2(137, WHALE, amount, amountOutMin, deadline, address(0), 0);
        vm.stopPrank();
    }

    function testLifiBridge() public {
        uint256 amount = 100 * 10**usdc.decimals();
        uint256 amountOutMin = 99 * 10**usdc.decimals();
        uint256 deadline = block.timestamp + 20 minutes;

        HopFacet.HopData memory hopData = HopFacet.HopData(
            "USDC",
            USDC_ADDRESS,
            HOP_USDC_BRIDGE,
            WHALE,
            1,
            137,
            amount,
            0, // not needed
            0, // not needed
            0, // not needed
            amountOutMin,
            deadline
        );

        vm.startPrank(WHALE);
        usdc.approve(address(hopFacet), amount);
        hopFacet.startBridgeTokensViaHop(lifiData, hopData);
        vm.stopPrank();
    }
}
