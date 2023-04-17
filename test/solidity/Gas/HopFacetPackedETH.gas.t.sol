pragma solidity 0.8.17;

import "ds-test/test.sol";
import { IHopBridge } from "lifi/Interfaces/IHopBridge.sol";
import { Test } from "forge-std/Test.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { console } from "../utils/Console.sol";

contract HopGasTestETH is Test, DiamondTest {
    address internal constant HOP_USDC_BRIDGE =
        0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant HOP_NATIVE_BRIDGE =
        0xb8901acB165ed027E32754E0FFe830802919727f;
    address internal constant USDC_ADDRESS =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WHALE =
        0x72A53cDBBcc1b9efa39c834A540550e23463AAcB; // USDC + ETH
    address internal constant RECEIVER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    IHopBridge internal hop;
    ERC20 internal usdc;
    LiFiDiamond internal diamond;
    HopFacetPacked internal hopFacetPacked;
    HopFacetOptimized internal hopFacetOptimized;

    bytes32 transactionId;
    string integrator;
    uint256 destinationChainId;
    uint256 amountUSDC;
    uint256 amountBonderFeeUSDC;
    uint256 amountOutMinUSDC;
    bytes packedUSDC;

    uint256 amountNative;
    uint256 amountBonderFeeNative;
    uint256 amountOutMinNative;
    bytes packedNative;

    ILiFi.BridgeData bridgeDataNative;
    HopFacetOptimized.HopData hopDataNative;

    ILiFi.BridgeData bridgeDataUSDC;
    HopFacetOptimized.HopData hopDataUSDC;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15588208;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        /// Perpare HopFacetPacked
        diamond = createDiamond();
        hopFacetPacked = new HopFacetPacked();
        usdc = ERC20(USDC_ADDRESS);
        hop = IHopBridge(HOP_USDC_BRIDGE);

        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = hopFacetPacked
            .startBridgeTokensViaHopL1NativeMin
            .selector;
        functionSelectors[1] = hopFacetPacked
            .startBridgeTokensViaHopL1ERC20Min
            .selector;

        addFacet(diamond, address(hopFacetPacked), functionSelectors);
        hopFacetPacked = HopFacetPacked(address(diamond));

        /// Perpare HopFacetOptimized & Approval
        hopFacetOptimized = new HopFacetOptimized();
        bytes4[] memory functionSelectorsApproval = new bytes4[](3);
        functionSelectorsApproval[0] = hopFacetOptimized
            .setApprovalForBridges
            .selector;
        functionSelectorsApproval[1] = hopFacetOptimized
            .startBridgeTokensViaHopL1Native
            .selector;
        functionSelectorsApproval[2] = hopFacetOptimized
            .startBridgeTokensViaHopL1ERC20
            .selector;

        addFacet(
            diamond,
            address(hopFacetOptimized),
            functionSelectorsApproval
        );
        hopFacetOptimized = HopFacetOptimized(address(diamond));

        address[] memory bridges = new address[](1);
        bridges[0] = HOP_USDC_BRIDGE;
        address[] memory tokens = new address[](1);
        tokens[0] = USDC_ADDRESS;
        hopFacetOptimized.setApprovalForBridges(bridges, tokens);

        /// Perpare parameters
        transactionId = "someID";
        integrator = "demo-partner";
        destinationChainId = 137;

        // Native params
        amountNative = 1 * 10 ** 18;
        amountBonderFeeNative = (amountNative / 100) * 1;
        amountOutMinNative = (amountNative / 100) * 99;

        // USDC params
        amountUSDC = 100 * 10 ** usdc.decimals();
        amountBonderFeeUSDC = (amountUSDC / 100) * 1;
        amountOutMinUSDC = (amountUSDC / 100) * 99;

        // same data for HopFacetOptimized
        bridgeDataNative = ILiFi.BridgeData(
            transactionId,
            "hop",
            integrator,
            address(0),
            address(0),
            RECEIVER,
            amountNative,
            destinationChainId,
            false,
            false
        );

        hopDataNative = HopFacetOptimized.HopData({
            bonderFee: amountBonderFeeNative,
            amountOutMin: amountOutMinNative,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: amountOutMinNative,
            destinationDeadline: block.timestamp + 60 * 20,
            hopBridge: IHopBridge(HOP_NATIVE_BRIDGE)
        });

        bridgeDataUSDC = ILiFi.BridgeData(
            transactionId,
            "hop",
            integrator,
            address(0),
            USDC_ADDRESS,
            RECEIVER,
            amountUSDC,
            destinationChainId,
            false,
            false
        );

        hopDataUSDC = HopFacetOptimized.HopData({
            bonderFee: amountBonderFeeUSDC,
            amountOutMin: amountOutMinUSDC,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: amountOutMinUSDC,
            destinationDeadline: block.timestamp + 60 * 20,
            hopBridge: IHopBridge(HOP_USDC_BRIDGE)
        });
    }

    function testStartBridgeTokensViaHopL1NativeMin() public {
        vm.startPrank(WHALE);
        hopFacetPacked.startBridgeTokensViaHopL1NativeMin{
            value: amountNative
        }(
            transactionId,
            integrator,
            RECEIVER,
            destinationChainId,
            amountOutMinNative,
            HOP_NATIVE_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1ERC20Min() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        hopFacetPacked.startBridgeTokensViaHopL1ERC20Min(
            transactionId,
            integrator,
            RECEIVER,
            destinationChainId,
            USDC_ADDRESS,
            amountUSDC,
            amountOutMinUSDC,
            HOP_USDC_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1Native() public {
        vm.startPrank(WHALE);
        hopFacetOptimized.startBridgeTokensViaHopL1Native{
            value: amountNative
        }(bridgeDataNative, hopDataNative);
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1ERC20() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        hopFacetOptimized.startBridgeTokensViaHopL1ERC20(
            bridgeDataUSDC,
            hopDataUSDC
        );
        vm.stopPrank();
    }
}
