pragma solidity 0.8.17;

import "ds-test/test.sol";
import { IHopBridge } from "lifi/Interfaces/IHopBridge.sol";
import { Test } from "forge-std/Test.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { HopFacetPacked, L2_AmmWrapper } from "lifi/Facets/HopFacetPacked.sol";
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

contract HopFacetPackedL2Test is Test, DiamondTest {
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
    address internal constant AMM_WRAPPER =
        0x33ceb27b39d2Bb7D2e61F7564d3Df29344020417;

    IHopBridge internal hop;
    ERC20 internal usdc;
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
        hopFacetPacked = new HopFacetPacked(address(this), AMM_WRAPPER);
        standAlone = new HopFacetPacked(address(this), AMM_WRAPPER);
        usdc = ERC20(USDC_ADDRESS);
        hop = IHopBridge(HOP_USDC_BRIDGE);
        callForwarder = new CallForwarder();

        bytes4[] memory functionSelectors = new bytes4[](12);
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
            .encode_startBridgeTokensViaHopL1NativePacked
            .selector;
        functionSelectors[9] = hopFacetPacked
            .startBridgeTokensViaHopL1ERC20Packed
            .selector;
        functionSelectors[10] = hopFacetPacked
            .startBridgeTokensViaHopL1ERC20Min
            .selector;
        functionSelectors[11] = hopFacetPacked
            .encode_startBridgeTokensViaHopL1ERC20Packed
            .selector;

        addFacet(diamond, address(hopFacetPacked), functionSelectors);
        hopFacetPacked = HopFacetPacked(address(diamond));

        /// Approval
        address[] memory bridges = new address[](3);
        bridges[0] = HOP_USDC_BRIDGE;
        bridges[1] = L2_AmmWrapper(AMM_WRAPPER).exchangeAddress();
        bridges[2] = L2_AmmWrapper(AMM_WRAPPER).bridge();
        address[] memory tokens = new address[](3);
        tokens[0] = USDC_ADDRESS;
        tokens[1] = L2_AmmWrapper(AMM_WRAPPER).l2CanonicalToken();
        tokens[2] = L2_AmmWrapper(AMM_WRAPPER).hToken();

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
        amountNative = 1 * 10**18;
        amountBonderFeeNative = (amountNative / 100) * 1;
        amountOutMinNative = (amountNative / 100) * 99;

        packedNative = hopFacetPacked
            .encode_startBridgeTokensViaHopL2NativePacked(
                transactionId,
                RECEIVER,
                destinationChainId,
                amountBonderFeeNative,
                amountOutMinNative,
                amountOutMinNative,
                deadline,
                HOP_NATIVE_BRIDGE
            );

        // USDC params
        amountUSDC = 100 * 10**usdc.decimals();
        amountBonderFeeUSDC = (amountUSDC / 100) * 1;
        amountOutMinUSDC = (amountUSDC / 100) * 99;

        packedUSDC = hopFacetPacked
            .encode_startBridgeTokensViaHopL2ERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                USDC_ADDRESS,
                amountUSDC,
                amountBonderFeeUSDC,
                amountOutMinUSDC,
                amountOutMinUSDC,
                deadline,
                HOP_USDC_BRIDGE
            );
    }

    // L2 Native
    function testStartBridgeTokensViaHopL2NativePacked() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(diamond).call{ value: amountNative }(
            packedNative
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2NativePackedForwarded() public {
        vm.startPrank(WHALE);
        callForwarder.callDiamond{ value: 2 * amountNative }(
            amountNative,
            address(diamond),
            packedNative
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2NativePackedStandalone() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(standAlone).call{ value: amountNative }(
            packedNative
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2NativePackedDecode() public {
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = standAlone.decode_startBridgeTokensViaHopL2NativePacked(
                packedNative
            );

        assertEq(decodedBridgeData.transactionId, transactionId);
        assertEq(decodedHopData.destinationAmountOutMin, amountOutMinNative);
    }

    function testStartBridgeTokensViaHopL2NativeMin() public {
        vm.startPrank(WHALE);
        hopFacetPacked.startBridgeTokensViaHopL2NativeMin{
            value: amountNative
        }(
            transactionId,
            RECEIVER,
            destinationChainId,
            amountBonderFeeNative,
            amountOutMinNative,
            amountOutMinNative,
            deadline,
            HOP_NATIVE_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2NativeMinStandalone() public {
        vm.startPrank(WHALE);
        standAlone.startBridgeTokensViaHopL2NativeMin{ value: amountNative }(
            transactionId,
            RECEIVER,
            destinationChainId,
            amountBonderFeeNative,
            amountOutMinNative,
            amountOutMinNative,
            deadline,
            HOP_NATIVE_BRIDGE
        );
        vm.stopPrank();
    }

    // L2 ERC20
    function testStartBridgeTokensViaHopL2ERC20Packed() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        (bool success, ) = address(diamond).call(packedUSDC);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20PackedStandalone() public {
        vm.startPrank(WHALE);
        usdc.approve(address(standAlone), amountUSDC);
        (bool success, ) = address(standAlone).call(packedUSDC);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20PackedDecode() public {
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = standAlone.decode_startBridgeTokensViaHopL2ERC20Packed(packedUSDC);

        assertEq(decodedBridgeData.transactionId, transactionId);
        assertEq(decodedHopData.destinationAmountOutMin, amountOutMinUSDC);
    }

    function testStartBridgeTokensViaHopL2ERC20Min() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        hopFacetPacked.startBridgeTokensViaHopL2ERC20Min(
            transactionId,
            RECEIVER,
            destinationChainId,
            USDC_ADDRESS,
            amountUSDC,
            amountBonderFeeUSDC,
            amountOutMinUSDC,
            amountOutMinUSDC,
            deadline,
            HOP_USDC_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20MinStandalone() public {
        vm.startPrank(WHALE);
        usdc.approve(address(standAlone), amountUSDC);
        standAlone.startBridgeTokensViaHopL2ERC20Min(
            transactionId,
            RECEIVER,
            destinationChainId,
            USDC_ADDRESS,
            amountUSDC,
            amountBonderFeeUSDC,
            amountOutMinUSDC,
            amountOutMinUSDC,
            deadline,
            HOP_USDC_BRIDGE
        );
        vm.stopPrank();
    }
}
