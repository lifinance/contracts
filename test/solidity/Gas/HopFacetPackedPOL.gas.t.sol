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
        0x76b22b8C1079A44F1211D867D68b1eda76a635A7;
    address internal constant HOP_NATIVE_BRIDGE =
        0x884d1Aa15F9957E1aEAA86a82a72e49Bc2bfCbe3;
    address internal constant USDC_ADDRESS =
        0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address internal constant WHALE =
        0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245; // USDC + ETH
    address internal constant RECEIVER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    IHopBridge internal hop;
    ERC20 internal usdc;
    LiFiDiamond internal diamond;
    HopFacetPacked internal hopFacetPacked;
    HopFacetOptimized internal hopFacetOptimized;

    bytes32 transactionId;
    string integrator;
    uint16 destinationChainId;

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
        string memory rpcUrl = vm.envString("ETH_NODE_URI_POLYGON");
        uint256 blockNumber = 40000000;
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


        /// Perpare HopFacetOptimized & Approval
        hopFacetOptimized = new HopFacetOptimized();
        bytes4[] memory functionSelectorsApproval = new bytes4[](3);
        functionSelectorsApproval[0] = hopFacetOptimized.setApprovalForBridges.selector;
        functionSelectorsApproval[1] = hopFacetOptimized.startBridgeTokensViaHopL2Native.selector;
        functionSelectorsApproval[2] = hopFacetOptimized.startBridgeTokensViaHopL2ERC20.selector;

        addFacet(diamond, address(hopFacetOptimized), functionSelectorsApproval);
        hopFacetOptimized = HopFacetOptimized(address(diamond));

        address[] memory bridges = new address[](1);
        bridges[0] = HOP_USDC_BRIDGE;
        address[] memory tokens = new address[](1);
        tokens[0] = USDC_ADDRESS;
        hopFacetOptimized.setApprovalForBridges(bridges, tokens);


        /// Perpare parameters
        transactionId = "someID";
        integrator = "demo-partner";
        destinationChainId = 10;

        // Native params
        amountNative = 1 * 10**18;
        amountBonderFeeNative = amountNative / 100 * 1;
        amountOutMinNative = amountNative / 100 * 99;

        bytes memory packedNativeParams = bytes.concat(
            bytes8(transactionId), // transactionId
            bytes16(bytes(integrator)), // integrator
            bytes20(RECEIVER), // receiver
            bytes16(uint128(amountBonderFeeNative)), // bonderFee
            bytes16(uint128(amountOutMinNative)), // amountOutMin
            bytes2(uint16(destinationChainId)), // destinationChainId
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
            bytes8(transactionId), // transactionId
            bytes16(bytes(integrator)), // integrator
            bytes20(RECEIVER), // receiver
            bytes16(uint128(amountBonderFeeUSDC)), // bonderFee
            bytes16(uint128(amountOutMinUSDC)), // amountOutMin
            bytes2(uint16(destinationChainId)), // destinationChainId
            bytes16(uint128(amountOutMinUSDC)), // destinationAmountOutMin
            bytes20(HOP_USDC_BRIDGE), // hopBridge
            bytes20(USDC_ADDRESS), // sendingAssetId
            bytes16(uint128(amountUSDC)) // amount
        );
        packedUSDC = bytes.concat(
            abi.encodeWithSignature("startBridgeTokensViaHopL2ERC20Packed()"),
            packedUSDCParams
        );

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

    function testCallData() public view {
        console.logString("startBridgeTokensViaHopL2NativePacked");
        console.logBytes(packedNative);
        console.logString("startBridgeTokensViaHopL2ERC20Packed");
        console.logBytes(packedUSDC);
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
            destinationChainId,
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
            destinationChainId,
            amountOutMinUSDC,
            HOP_USDC_BRIDGE,
            USDC_ADDRESS,
            amountUSDC
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2Native() public {
        vm.startPrank(WHALE);
        hopFacetOptimized.startBridgeTokensViaHopL2Native{value: amountNative}(
            bridgeDataNative,
            hopDataNative
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        hopFacetOptimized.startBridgeTokensViaHopL2ERC20(
            bridgeDataUSDC,
            hopDataUSDC
        );
        vm.stopPrank();
    }
}
