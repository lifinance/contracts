// // SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "ds-test/test.sol";
import { IHopBridge } from "lifi/Interfaces/IHopBridge.sol";
import { Test } from "forge-std/Test.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { console } from "../utils/Console.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";

contract CallForwarder {
    function callDiamond(
        uint256 nativeAmount,
        address contractAddress,
        bytes calldata callData
    ) external payable {
        (bool success, ) = contractAddress.call{ value: nativeAmount }(
            callData
        );
        if (!success) {
            revert();
        }
    }
}

contract HopFacetPackedL1Test is Test, DiamondTest {
    using SafeTransferLib for ERC20;

    address internal constant HOP_USDC_BRIDGE =
        0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant HOP_USDT_BRIDGE =
        0x3E4a3a4796d16c0Cd582C382691998f7c06420B6;
    address internal constant HOP_NATIVE_BRIDGE =
        0xb8901acB165ed027E32754E0FFe830802919727f;
    address internal constant USDT_ADDRESS =
        0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant USDC_ADDRESS =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WHALE =
        0x72A53cDBBcc1b9efa39c834A540550e23463AAcB; // USDC + ETH
    address internal constant RECEIVER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    IHopBridge internal hop;
    ERC20 internal usdc;
    ERC20 internal usdt;
    LiFiDiamond internal diamond;
    HopFacetPacked internal hopFacetPacked;
    HopFacetPacked internal standAlone;
    CallForwarder internal callForwarder;

    bytes8 transactionId;
    string integrator;
    uint256 destinationChainId;
    uint256 deadline;

    uint256 amountUSDC;
    uint256 amountBonderFeeUSDC;
    uint256 amountOutMinUSDC;
    bytes packedUSDC;

    uint256 amountUSDT;
    uint256 amountBonderFeeUSDT;
    uint256 amountOutMinUSDT;
    bytes packedUSDT;

    uint256 amountNative;
    uint256 amountBonderFeeNative;
    uint256 amountOutMinNative;
    bytes packedNative;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15588208;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        /// Perpare HopFacetPacked
        diamond = createDiamond();
        hopFacetPacked = new HopFacetPacked(address(this), address(0));
        standAlone = new HopFacetPacked(address(this), address(0));
        usdc = ERC20(USDC_ADDRESS);
        usdt = ERC20(USDT_ADDRESS);
        hop = IHopBridge(HOP_USDC_BRIDGE);
        callForwarder = new CallForwarder();

        deal(USDT_ADDRESS, address(WHALE), 100000 * 10 ** usdt.decimals());

        bytes4[] memory functionSelectors = new bytes4[](13);
        functionSelectors[0] = hopFacetPacked
            .setApprovalForHopBridges
            .selector;
        functionSelectors[1] = hopFacetPacked
            .startBridgeTokensViaHopL2NativePacked
            .selector;
        functionSelectors[2] = hopFacetPacked
            .startBridgeTokensViaHopL2NativeMin
            .selector;
        functionSelectors[3] = hopFacetPacked
            .encode_startBridgeTokensViaHopL2NativePacked
            .selector;
        functionSelectors[4] = hopFacetPacked
            .startBridgeTokensViaHopL2ERC20Packed
            .selector;
        functionSelectors[5] = hopFacetPacked
            .startBridgeTokensViaHopL2ERC20Min
            .selector;
        functionSelectors[6] = hopFacetPacked
            .encode_startBridgeTokensViaHopL2ERC20Packed
            .selector;
        functionSelectors[7] = hopFacetPacked
            .startBridgeTokensViaHopL1NativePacked
            .selector;
        functionSelectors[8] = hopFacetPacked
            .startBridgeTokensViaHopL1NativeMin
            .selector;
        functionSelectors[9] = hopFacetPacked
            .encode_startBridgeTokensViaHopL1NativePacked
            .selector;
        functionSelectors[10] = hopFacetPacked
            .startBridgeTokensViaHopL1ERC20Packed
            .selector;
        functionSelectors[11] = hopFacetPacked
            .startBridgeTokensViaHopL1ERC20Min
            .selector;
        functionSelectors[12] = hopFacetPacked
            .encode_startBridgeTokensViaHopL1ERC20Packed
            .selector;

        addFacet(diamond, address(hopFacetPacked), functionSelectors);
        hopFacetPacked = HopFacetPacked(address(diamond));

        /// Approval
        address[] memory bridges = new address[](2);
        bridges[0] = HOP_USDC_BRIDGE;
        bridges[1] = HOP_USDT_BRIDGE;
        address[] memory tokens = new address[](2);
        tokens[0] = USDC_ADDRESS;
        tokens[1] = USDT_ADDRESS;

        // > diamond
        HopFacetOptimized hopFacetOptimized = new HopFacetOptimized();
        bytes4[] memory functionSelectorsApproval = new bytes4[](1);
        functionSelectorsApproval[0] = hopFacetOptimized
            .setApprovalForBridges
            .selector;
        addFacet(
            diamond,
            address(hopFacetOptimized),
            functionSelectorsApproval
        );
        hopFacetOptimized = HopFacetOptimized(address(diamond));
        hopFacetOptimized.setApprovalForBridges(bridges, tokens);

        // > standAlone
        standAlone.setApprovalForHopBridges(bridges, tokens);

        /// Perpare parameters
        transactionId = "someID";
        integrator = "demo-partner";
        destinationChainId = 137;
        deadline = block.timestamp + 7 * 24 * 60 * 60;

        // Native params
        amountNative = 1 * 10 ** 18;
        amountBonderFeeNative = (amountNative / 100) * 1;
        amountOutMinNative = (amountNative / 100) * 99;

        packedNative = hopFacetPacked
            .encode_startBridgeTokensViaHopL1NativePacked(
                transactionId,
                RECEIVER,
                destinationChainId,
                amountOutMinNative,
                address(0),
                0,
                HOP_NATIVE_BRIDGE
            );

        // USDC params
        amountUSDC = 100 * 10 ** usdc.decimals();
        amountBonderFeeUSDC = (amountUSDC / 100) * 1;
        amountOutMinUSDC = (amountUSDC / 100) * 99;

        packedUSDC = hopFacetPacked
            .encode_startBridgeTokensViaHopL1ERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                USDC_ADDRESS,
                amountUSDC,
                amountOutMinUSDC,
                address(0),
                0,
                HOP_USDC_BRIDGE
            );

        // USDT params
        amountUSDT = 100 * 10 ** usdt.decimals();
        amountBonderFeeUSDT = (amountUSDT / 100) * 1;
        amountOutMinUSDT = (amountUSDT / 100) * 99;

        packedUSDT = hopFacetPacked
            .encode_startBridgeTokensViaHopL1ERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                USDT_ADDRESS,
                amountUSDT,
                amountOutMinUSDT,
                address(0),
                0,
                HOP_USDT_BRIDGE
            );
    }

    // L1 Native
    function testStartBridgeTokensViaHopL1NativePacked() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(diamond).call{ value: amountNative }(
            packedNative
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1NativePackedForwarded() public {
        vm.startPrank(WHALE);
        callForwarder.callDiamond{ value: 2 * amountNative }(
            amountNative,
            address(diamond),
            packedNative
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1NativePackedStandalone() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(standAlone).call{ value: amountNative }(
            packedNative
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1NativePackedDecode() public {
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = standAlone.decode_startBridgeTokensViaHopL1NativePacked(
                packedNative
            );

        assertEq(decodedBridgeData.transactionId, transactionId);
        assertEq(decodedHopData.destinationAmountOutMin, amountOutMinNative);
    }

    function testStartBridgeTokensViaHopL1NativeMin() public {
        vm.startPrank(WHALE);
        hopFacetPacked.startBridgeTokensViaHopL1NativeMin{
            value: amountNative
        }(
            transactionId,
            RECEIVER,
            destinationChainId,
            amountOutMinNative,
            address(0),
            0,
            HOP_NATIVE_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1NativeMinStandalone() public {
        vm.startPrank(WHALE);
        standAlone.startBridgeTokensViaHopL1NativeMin{ value: amountNative }(
            transactionId,
            RECEIVER,
            destinationChainId,
            amountOutMinNative,
            address(0),
            0,
            HOP_NATIVE_BRIDGE
        );
        vm.stopPrank();
    }

    // L1 ERC20
    function testStartBridgeTokensViaHopL1ERC20Packed_USDC() public {
        vm.startPrank(WHALE);
        usdc.safeApprove(address(diamond), amountUSDC);
        (bool success, ) = address(diamond).call(packedUSDC);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1ERC20PackedStandalone_USDC() public {
        vm.startPrank(WHALE);
        usdc.safeApprove(address(standAlone), amountUSDC);
        (bool success, ) = address(standAlone).call(packedUSDC);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1ERC20PackedDecode_USDC() public {
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = standAlone.decode_startBridgeTokensViaHopL1ERC20Packed(packedUSDC);

        assertEq(decodedBridgeData.transactionId, transactionId);
        assertEq(decodedHopData.destinationAmountOutMin, amountOutMinUSDC);
    }

    function testStartBridgeTokensViaHopL1ERC20Min_USDC() public {
        vm.startPrank(WHALE);
        usdc.safeApprove(address(diamond), amountUSDC);
        hopFacetPacked.startBridgeTokensViaHopL1ERC20Min(
            transactionId,
            RECEIVER,
            destinationChainId,
            USDC_ADDRESS,
            amountUSDC,
            amountOutMinUSDC,
            address(0),
            0,
            HOP_USDC_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1ERC20MinStandalone_USDC() public {
        vm.startPrank(WHALE);
        usdc.safeApprove(address(standAlone), amountUSDC);
        standAlone.startBridgeTokensViaHopL1ERC20Min(
            transactionId,
            RECEIVER,
            destinationChainId,
            USDC_ADDRESS,
            amountUSDC,
            amountOutMinUSDC,
            address(0),
            0,
            HOP_USDC_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1ERC20Packed_USDT() public {
        vm.startPrank(WHALE);
        usdt.safeApprove(address(diamond), amountUSDT);
        (bool success, ) = address(diamond).call(packedUSDT);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1ERC20PackedStandalone_USDT() public {
        vm.startPrank(WHALE);
        usdt.safeApprove(address(standAlone), amountUSDT);
        (bool success, ) = address(standAlone).call(packedUSDT);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1ERC20PackedDecode_USDT() public {
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = standAlone.decode_startBridgeTokensViaHopL1ERC20Packed(packedUSDT);

        assertEq(decodedBridgeData.transactionId, transactionId);
        assertEq(decodedHopData.destinationAmountOutMin, amountOutMinUSDT);
    }

    function testStartBridgeTokensViaHopL1ERC20Min_USDT() public {
        vm.startPrank(WHALE);
        usdt.safeApprove(address(diamond), amountUSDT);
        hopFacetPacked.startBridgeTokensViaHopL1ERC20Min(
            transactionId,
            RECEIVER,
            destinationChainId,
            USDT_ADDRESS,
            amountUSDT,
            amountOutMinUSDT,
            address(0),
            0,
            HOP_USDT_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL1ERC20MinStandalone_USDT() public {
        vm.startPrank(WHALE);
        usdt.safeApprove(address(standAlone), amountUSDT);
        standAlone.startBridgeTokensViaHopL1ERC20Min(
            transactionId,
            RECEIVER,
            destinationChainId,
            USDT_ADDRESS,
            amountUSDT,
            amountOutMinUSDT,
            address(0),
            0,
            HOP_USDT_BRIDGE
        );
        vm.stopPrank();
    }

    // Encode
    // function testEncodeNativeValidation() public {
    //     // destinationChainId
    //     // > max allowed
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1NativePacked(
    //         transactionId,
    //         RECEIVER,
    //         uint256(type(uint32).max),
    //         amountBonderFeeNative,
    //         amountOutMinNative,
    //         amountOutMinNative,
    //         deadline,
    //         HOP_NATIVE_BRIDGE
    //     );
    //     // > too big
    //     vm.expectRevert();
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1NativePacked(
    //         transactionId,
    //         RECEIVER,
    //         uint256(type(uint32).max) + 1,
    //         amountBonderFeeNative,
    //         amountOutMinNative,
    //         amountOutMinNative,
    //         deadline,
    //         HOP_NATIVE_BRIDGE
    //     );

    //     // bonderFee
    //     // > max allowed
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1NativePacked(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         uint256(type(uint128).max),
    //         amountOutMinNative,
    //         amountOutMinNative,
    //         deadline,
    //         HOP_NATIVE_BRIDGE
    //     );
    //     // > too big
    //     vm.expectRevert();
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1NativePacked(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         uint256(type(uint128).max) + 1,
    //         amountOutMinNative,
    //         amountOutMinNative,
    //         deadline,
    //         HOP_NATIVE_BRIDGE
    //     );

    //     // amountOutMin
    //     // > max allowed
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1NativePacked(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         amountBonderFeeNative,
    //         uint256(type(uint128).max),
    //         amountOutMinNative,
    //         deadline,
    //         HOP_NATIVE_BRIDGE
    //     );
    //     // > too big
    //     vm.expectRevert();
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1NativePacked(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         amountBonderFeeNative,
    //         uint256(type(uint128).max) + 1,
    //         amountOutMinNative,
    //         deadline,
    //         HOP_NATIVE_BRIDGE
    //     );

    //     // destinationAmountOutMin
    //     // > max allowed
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1NativePacked(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         amountBonderFeeNative,
    //         amountOutMinNative,
    //         uint256(type(uint128).max),
    //         deadline,
    //         HOP_NATIVE_BRIDGE
    //     );
    //     // > too big
    //     vm.expectRevert();
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1NativePacked(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         amountBonderFeeNative,
    //         amountOutMinNative,
    //         uint256(type(uint128).max) + 1,
    //         deadline,
    //         HOP_NATIVE_BRIDGE
    //     );
    // }

    // function testEncodeERC20Validation() public {
    //     // destinationChainId
    //     // > max allowed
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         uint256(type(uint32).max),
    //         USDC_ADDRESS,
    //         amountUSDC,
    //         amountBonderFeeUSDC,
    //         amountOutMinUSDC,
    //         amountOutMinUSDC,
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );
    //     // > too big
    //     vm.expectRevert();
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         uint256(type(uint32).max) + 1,
    //         USDC_ADDRESS,
    //         amountUSDC,
    //         amountBonderFeeUSDC,
    //         amountOutMinUSDC,
    //         amountOutMinUSDC,
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );

    //     // amount
    //     // > max allowed
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         USDC_ADDRESS,
    //         uint256(type(uint128).max),
    //         amountBonderFeeUSDC,
    //         amountOutMinUSDC,
    //         amountOutMinUSDC,
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );
    //     // > too big
    //     vm.expectRevert();
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         USDC_ADDRESS,
    //         uint256(type(uint128).max) + 1,
    //         amountBonderFeeUSDC,
    //         amountOutMinUSDC,
    //         amountOutMinUSDC,
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );

    //     // bonderFee
    //     // > max allowed
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         USDC_ADDRESS,
    //         amountUSDC,
    //         uint256(type(uint128).max),
    //         amountOutMinUSDC,
    //         amountOutMinUSDC,
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );
    //     // > too big
    //     vm.expectRevert();
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         USDC_ADDRESS,
    //         amountUSDC,
    //         uint256(type(uint128).max) + 1,
    //         amountOutMinUSDC,
    //         amountOutMinUSDC,
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );

    //     // amountOutMin
    //     // > max allowed
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         USDC_ADDRESS,
    //         amountUSDC,
    //         amountBonderFeeUSDC,
    //         uint256(type(uint128).max),
    //         amountOutMinUSDC,
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );
    //     // > too big
    //     vm.expectRevert();
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         USDC_ADDRESS,
    //         amountUSDC,
    //         amountBonderFeeUSDC,
    //         uint256(type(uint128).max) + 1,
    //         amountOutMinUSDC,
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );

    //     // destinationAmountOutMin
    //     // > max allowed
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         USDC_ADDRESS,
    //         amountUSDC,
    //         amountBonderFeeUSDC,
    //         amountOutMinUSDC,
    //         uint256(type(uint128).max),
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );
    //     // > too big
    //     vm.expectRevert();
    //     hopFacetPacked.encode_startBridgeTokensViaHopL1ERC20Packed(
    //         transactionId,
    //         RECEIVER,
    //         137,
    //         USDC_ADDRESS,
    //         amountUSDC,
    //         amountBonderFeeUSDC,
    //         amountOutMinUSDC,
    //         uint256(type(uint128).max) + 1,
    //         deadline,
    //         HOP_USDC_BRIDGE
    //     );
    // }
}
