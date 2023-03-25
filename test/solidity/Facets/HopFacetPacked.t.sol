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

contract HopGasTest is Test, DiamondTest {
    address internal constant HOP_USDC_BRIDGE =
        0xe22D2beDb3Eca35E6397e0C6D62857094aA26F52;
    address internal constant HOP_NATIVE_BRIDGE =
        0x33ceb27b39d2Bb7D2e61F7564d3Df29344020417;
    address internal constant USDC_ADDRESS =
        0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address internal constant WHALE =
        0xF3F094484eC6901FfC9681bCb808B96bAFd0b8a8; // USDC + ETH
    address internal constant RECEIVER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    IHopBridge internal hop;
    ERC20 internal usdc;
    LiFiDiamond internal diamond;
    HopFacetPacked internal hopFacetPacked;

    string integrator;
    uint256 amountUSDC;
    uint256 amountBonderFeeUSDC;
    uint256 amountOutMinUSDC;
    bytes packedUSDC;

    uint256 amountNative;
    uint256 amountBonderFeeNative;
    uint256 amountOutMinNative;
    bytes packedNative;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_ARBITRUM");
        uint256 blockNumber = 58467500;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        /// Perpare HopFacetPacked
        diamond = createDiamond();
        hopFacetPacked = new HopFacetPacked();
        usdc = ERC20(USDC_ADDRESS);
        hop = IHopBridge(HOP_USDC_BRIDGE);

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = hopFacetPacked.startBridgeTokensViaHopL2NativePacked.selector;
        functionSelectors[1] = hopFacetPacked.startBridgeTokensViaHopL2NativeMin.selector;
        functionSelectors[2] = hopFacetPacked.startBridgeTokensViaHopL2ERC20Packed.selector;
        functionSelectors[3] = hopFacetPacked.startBridgeTokensViaHopL2ERC20Min.selector;

        addFacet(diamond, address(hopFacetPacked), functionSelectors);
        hopFacetPacked = HopFacetPacked(address(diamond));


        /// Perpare Approval
        HopFacetOptimized hopFacetOptimized = new HopFacetOptimized();
        bytes4[] memory functionSelectorsApproval = new bytes4[](1);
        functionSelectorsApproval[0] = hopFacetOptimized.setApprovalForBridges.selector;

        addFacet(diamond, address(hopFacetOptimized), functionSelectorsApproval);
        hopFacetOptimized = HopFacetOptimized(address(diamond));

        address[] memory bridges = new address[](1);
        bridges[0] = HOP_USDC_BRIDGE;
        address[] memory tokens = new address[](1);
        tokens[0] = USDC_ADDRESS;
        hopFacetOptimized.setApprovalForBridges(bridges, tokens);


        /// Perpare parameters
        integrator = "demo-partner";

        // Native params
        amountNative = 1 * 10**18;
        amountBonderFeeNative = amountNative / 100 * 1;
        amountOutMinNative = amountNative / 100 * 99;

        bytes memory packedNativeParams = bytes.concat(
            bytes8("someID"), // transactionId
            bytes16(bytes(integrator)), // integrator
            bytes20(RECEIVER), // receiver
            bytes16(uint128(amountBonderFeeNative)), // bonderFee
            bytes16(uint128(amountOutMinNative)), // amountOutMin
            bytes2(uint16(137)), // destinationChainId
            bytes16(uint128(amountOutMinNative)), // destinationAmountOutMin
            bytes20(HOP_NATIVE_BRIDGE) // hopBridge
        );
        packedNative = bytes.concat(
            abi.encodeWithSignature("startBridgeTokensViaHopL2NativePacked()"),
            packedNativeParams
        );

        // USDC params
        amountUSDC = 100 * 10**usdc.decimals();
        amountBonderFeeUSDC = amountUSDC / 100 * 1;
        amountOutMinUSDC = amountUSDC / 100 * 99;

        bytes memory packedUSDCParams = bytes.concat(
            bytes8("someID"), // transactionId
            bytes16(bytes(integrator)), // integrator
            bytes20(RECEIVER), // receiver
            bytes16(uint128(amountBonderFeeUSDC)), // bonderFee
            bytes16(uint128(amountOutMinUSDC)), // amountOutMin
            bytes2(uint16(137)), // destinationChainId
            bytes16(uint128(amountOutMinUSDC)), // destinationAmountOutMin
            bytes20(HOP_USDC_BRIDGE), // hopBridge
            bytes20(USDC_ADDRESS), // sendingAssetId
            bytes16(uint128(amountUSDC)) // amount
        );
        packedUSDC = bytes.concat(
            abi.encodeWithSignature("startBridgeTokensViaHopL2ERC20Packed()"),
            packedUSDCParams
        );
    }

    function testStartBridgeTokensViaHopL2NativePacked() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(diamond).call{value: amountNative}(packedNative);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2NativeMin() public {
        vm.startPrank(WHALE);
        hopFacetPacked.startBridgeTokensViaHopL2NativeMin{value: amountNative}(
            "someID",
            integrator,
            RECEIVER,
            amountBonderFeeNative,
            amountOutMinNative,
            137,
            amountOutMinNative,
            HOP_NATIVE_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20Packed() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        (bool success, ) = address(diamond).call(packedUSDC);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20Min() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        hopFacetPacked.startBridgeTokensViaHopL2ERC20Min(
            "someID",
            integrator,
            RECEIVER,
            amountBonderFeeUSDC,
            amountOutMinUSDC,
            137,
            amountOutMinUSDC,
            HOP_USDC_BRIDGE,
            USDC_ADDRESS,
            amountUSDC
        );
        vm.stopPrank();
    }

}
