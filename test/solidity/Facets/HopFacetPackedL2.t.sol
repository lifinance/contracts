// // SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { IHopBridge, IL2AmmWrapper } from "lifi/Interfaces/IHopBridge.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { TestBase, ILiFi } from "../utils/TestBase.sol";

contract CallForwarder {
    error DiamondCallFailed();

    function callDiamond(
        uint256 nativeAmount,
        address contractAddress,
        bytes calldata callData
    ) external payable {
        (bool success, ) = contractAddress.call{ value: nativeAmount }(
            callData
        );
        if (!success) {
            revert DiamondCallFailed();
        }
    }
}

contract HopFacetPackedL2Test is TestBase {
    using SafeTransferLib for ERC20;

    address internal constant HOP_USDC_BRIDGE =
        0xe22D2beDb3Eca35E6397e0C6D62857094aA26F52;
    address internal constant HOP_USDT_BRIDGE =
        0xCB0a4177E0A60247C0ad18Be87f8eDfF6DD30283;
    address internal constant HOP_NATIVE_BRIDGE =
        0x33ceb27b39d2Bb7D2e61F7564d3Df29344020417;
    address internal constant USDT_ADDRESS =
        0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address internal constant USDC_ADDRESS =
        0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address internal constant WHALE =
        0xF3F094484eC6901FfC9681bCb808B96bAFd0b8a8; // USDC + ETH
    address internal constant RECEIVER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;
    address internal constant NATIVE_AMM_WRAPPER =
        0x33ceb27b39d2Bb7D2e61F7564d3Df29344020417;
    address internal constant USDC_AMM_WRAPPER =
        0xe22D2beDb3Eca35E6397e0C6D62857094aA26F52;
    address internal constant USDT_AMM_WRAPPER =
        0xCB0a4177E0A60247C0ad18Be87f8eDfF6DD30283;

    IHopBridge internal hop;
    HopFacetPacked internal hopFacetPacked;
    HopFacetPacked internal standAlone;
    CallForwarder internal callForwarder;

    struct BridgeParams {
        bytes8 transactionId;
        string integrator;
        uint256 destinationChainId;
        uint256 deadline;
        uint256 amount;
        uint256 bonderFee;
        uint256 amountOutMin;
        bytes packedData;
    }

    BridgeParams internal nativeBridgeParams;
    BridgeParams internal usdcBridgeParams;
    BridgeParams internal usdtBridgeParams;

    function setUp() public {
        customBlockNumberForForking = 58467500;
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";
        initTestBase();

        /// Perpare HopFacetPacked
        hopFacetPacked = new HopFacetPacked(address(this), NATIVE_AMM_WRAPPER);
        standAlone = new HopFacetPacked(address(this), NATIVE_AMM_WRAPPER);
        hop = IHopBridge(HOP_USDC_BRIDGE);
        callForwarder = new CallForwarder();

        deal(USDT_ADDRESS, address(WHALE), 100000 * 10 ** usdt.decimals());

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
        address[] memory bridges = new address[](8);
        bridges[0] = HOP_USDC_BRIDGE;
        bridges[1] = HOP_USDT_BRIDGE;
        bridges[2] = IL2AmmWrapper(USDC_AMM_WRAPPER).exchangeAddress();
        bridges[3] = IL2AmmWrapper(USDC_AMM_WRAPPER).bridge();
        bridges[4] = IL2AmmWrapper(USDT_AMM_WRAPPER).exchangeAddress();
        bridges[5] = IL2AmmWrapper(USDT_AMM_WRAPPER).bridge();
        bridges[6] = IL2AmmWrapper(NATIVE_AMM_WRAPPER).exchangeAddress();
        bridges[7] = IL2AmmWrapper(NATIVE_AMM_WRAPPER).bridge();
        address[] memory tokens = new address[](8);
        tokens[0] = USDC_ADDRESS;
        tokens[1] = USDT_ADDRESS;
        tokens[2] = IL2AmmWrapper(USDC_AMM_WRAPPER).l2CanonicalToken();
        tokens[3] = IL2AmmWrapper(USDC_AMM_WRAPPER).hToken();
        tokens[4] = IL2AmmWrapper(USDT_AMM_WRAPPER).l2CanonicalToken();
        tokens[5] = IL2AmmWrapper(USDT_AMM_WRAPPER).hToken();
        tokens[6] = IL2AmmWrapper(NATIVE_AMM_WRAPPER).l2CanonicalToken();
        tokens[7] = IL2AmmWrapper(NATIVE_AMM_WRAPPER).hToken();

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
        bytes8 transactionId = "someID";
        string memory integrator = "demo-partner";
        uint256 destinationChainId = 137;
        uint256 deadline = block.timestamp + 7 * 24 * 60 * 60;

        bytes memory nativePackedData = hopFacetPacked
            .encode_startBridgeTokensViaHopL2NativePacked(
                transactionId,
                RECEIVER,
                destinationChainId,
                1 ether / 100,
                (1 ether / 100) * 99
            );

        nativeBridgeParams = _createBridgeParams(
            transactionId,
            integrator,
            destinationChainId,
            deadline,
            1 ether,
            nativePackedData
        );

        bytes memory usdcPackedData = hopFacetPacked
            .encode_startBridgeTokensViaHopL2ERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                USDC_ADDRESS,
                100 * 10 ** 6,
                (100 * 10 ** 6) / 100,
                ((100 * 10 ** 6) / 100) * 99,
                ((100 * 10 ** 6) / 100) * 99,
                deadline,
                USDC_AMM_WRAPPER
            );

        usdcBridgeParams = _createBridgeParams(
            transactionId,
            integrator,
            destinationChainId,
            deadline,
            100 * 10 ** 6,
            usdcPackedData
        );

        bytes memory usdtPackedData = hopFacetPacked
            .encode_startBridgeTokensViaHopL2ERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                USDT_ADDRESS,
                100 * 10 ** 6,
                (100 * 10 ** 6) / 100,
                ((100 * 10 ** 6) / 100) * 99,
                ((100 * 10 ** 6) / 100) * 99,
                deadline,
                USDT_AMM_WRAPPER
            );

        usdtBridgeParams = _createBridgeParams(
            transactionId,
            integrator,
            destinationChainId,
            deadline,
            100 * 10 ** 6,
            usdtPackedData
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(address(hopFacetPacked), "HopFacetPackedL2");
    }

    function _createBridgeParams(
        bytes8 transactionId,
        string memory integrator,
        uint256 destinationChainId,
        uint256 deadline,
        uint256 amount,
        bytes memory packedData
    ) internal pure returns (BridgeParams memory) {
        return
            BridgeParams({
                transactionId: transactionId,
                integrator: integrator,
                destinationChainId: destinationChainId,
                deadline: deadline,
                amount: amount,
                bonderFee: amount / 100,
                amountOutMin: (amount / 100) * 99,
                packedData: packedData
            });
    }

    // L2 Native
    function testStartBridgeTokensViaHopL2NativePacked() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(diamond).call{
            value: nativeBridgeParams.amount
        }(nativeBridgeParams.packedData);
        if (!success) {
            revert NativeBridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2NativePackedForwarded() public {
        vm.startPrank(WHALE);
        callForwarder.callDiamond{ value: 2 * nativeBridgeParams.amount }(
            nativeBridgeParams.amount,
            address(diamond),
            nativeBridgeParams.packedData
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2NativePackedStandalone() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(standAlone).call{
            value: nativeBridgeParams.amount
        }(nativeBridgeParams.packedData);
        if (!success) {
            revert NativeBridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2NativePackedDecode() public {
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = standAlone.decode_startBridgeTokensViaHopL2NativePacked(
                nativeBridgeParams.packedData
            );

        assertEq(
            decodedBridgeData.transactionId,
            nativeBridgeParams.transactionId
        );
        assertEq(decodedBridgeData.receiver, RECEIVER);
        assertEq(
            decodedBridgeData.destinationChainId,
            nativeBridgeParams.destinationChainId
        );

        assertEq(decodedHopData.bonderFee, nativeBridgeParams.bonderFee);
        assertEq(decodedHopData.amountOutMin, nativeBridgeParams.amountOutMin);
    }

    function testStartBridgeTokensViaHopL2NativeMin() public {
        vm.startPrank(WHALE);
        hopFacetPacked.startBridgeTokensViaHopL2NativeMin{
            value: nativeBridgeParams.amount
        }(
            nativeBridgeParams.transactionId,
            RECEIVER,
            nativeBridgeParams.destinationChainId,
            nativeBridgeParams.bonderFee,
            nativeBridgeParams.amountOutMin,
            nativeBridgeParams.amountOutMin,
            nativeBridgeParams.deadline,
            HOP_NATIVE_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2NativeMinStandalone() public {
        vm.startPrank(WHALE);
        standAlone.startBridgeTokensViaHopL2NativeMin{
            value: nativeBridgeParams.amount
        }(
            nativeBridgeParams.transactionId,
            RECEIVER,
            nativeBridgeParams.destinationChainId,
            nativeBridgeParams.bonderFee,
            nativeBridgeParams.amountOutMin,
            nativeBridgeParams.amountOutMin,
            nativeBridgeParams.deadline,
            HOP_NATIVE_BRIDGE
        );
        vm.stopPrank();
    }

    // L2 ERC20
    function testStartBridgeTokensViaHopL2ERC20Packed_USDC() public {
        vm.startPrank(WHALE);
        usdc.safeApprove(address(diamond), usdcBridgeParams.amount);
        (bool success, ) = address(diamond).call(usdcBridgeParams.packedData);
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20PackedStandalone_USDC() public {
        vm.startPrank(WHALE);
        usdc.safeApprove(address(standAlone), usdcBridgeParams.amount);
        (bool success, ) = address(standAlone).call(
            usdcBridgeParams.packedData
        );
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20PackedDecode_USDC() public {
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = standAlone.decode_startBridgeTokensViaHopL2ERC20Packed(
                usdcBridgeParams.packedData
            );

        assertEq(
            decodedBridgeData.transactionId,
            usdcBridgeParams.transactionId
        );
        assertEq(
            decodedHopData.destinationAmountOutMin,
            usdcBridgeParams.amountOutMin
        );
    }

    function testStartBridgeTokensViaHopL2ERC20Min_USDC() public {
        vm.startPrank(WHALE);
        usdc.safeApprove(address(diamond), usdcBridgeParams.amount);
        hopFacetPacked.startBridgeTokensViaHopL2ERC20Min(
            usdcBridgeParams.transactionId,
            RECEIVER,
            usdcBridgeParams.destinationChainId,
            USDC_ADDRESS,
            usdcBridgeParams.amount,
            usdcBridgeParams.bonderFee,
            usdcBridgeParams.amountOutMin,
            usdcBridgeParams.amountOutMin,
            usdcBridgeParams.deadline,
            HOP_USDC_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20MinStandalone_USDC() public {
        vm.startPrank(WHALE);
        usdc.safeApprove(address(standAlone), usdcBridgeParams.amount);
        standAlone.startBridgeTokensViaHopL2ERC20Min(
            usdcBridgeParams.transactionId,
            RECEIVER,
            usdcBridgeParams.destinationChainId,
            USDC_ADDRESS,
            usdcBridgeParams.amount,
            usdcBridgeParams.bonderFee,
            usdcBridgeParams.amountOutMin,
            usdcBridgeParams.amountOutMin,
            usdcBridgeParams.deadline,
            HOP_USDC_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20Packed_USDT() public {
        vm.startPrank(WHALE);
        usdt.safeApprove(address(diamond), usdtBridgeParams.amount);
        (bool success, ) = address(diamond).call(usdtBridgeParams.packedData);
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20PackedStandalone_USDT() public {
        vm.startPrank(WHALE);
        usdt.safeApprove(address(standAlone), usdtBridgeParams.amount);
        (bool success, ) = address(standAlone).call(
            usdtBridgeParams.packedData
        );
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20PackedDecode_USDT() public {
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = standAlone.decode_startBridgeTokensViaHopL2ERC20Packed(
                usdtBridgeParams.packedData
            );

        assertEq(
            decodedBridgeData.transactionId,
            usdtBridgeParams.transactionId
        );
        assertEq(
            decodedHopData.destinationAmountOutMin,
            usdtBridgeParams.amountOutMin
        );
    }

    function testStartBridgeTokensViaHopL2ERC20Min_USDT() public {
        vm.startPrank(WHALE);
        usdt.safeApprove(address(diamond), usdtBridgeParams.amount);
        hopFacetPacked.startBridgeTokensViaHopL2ERC20Min(
            usdtBridgeParams.transactionId,
            RECEIVER,
            usdtBridgeParams.destinationChainId,
            USDT_ADDRESS,
            usdtBridgeParams.amount,
            usdtBridgeParams.bonderFee,
            usdtBridgeParams.amountOutMin,
            usdtBridgeParams.amountOutMin,
            usdtBridgeParams.deadline,
            HOP_USDT_BRIDGE
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaHopL2ERC20MinStandalone_USDT() public {
        vm.startPrank(WHALE);
        usdt.safeApprove(address(standAlone), usdtBridgeParams.amount);
        standAlone.startBridgeTokensViaHopL2ERC20Min(
            usdtBridgeParams.transactionId,
            RECEIVER,
            usdtBridgeParams.destinationChainId,
            USDT_ADDRESS,
            usdtBridgeParams.amount,
            usdtBridgeParams.bonderFee,
            usdtBridgeParams.amountOutMin,
            usdtBridgeParams.amountOutMin,
            usdtBridgeParams.deadline,
            HOP_USDT_BRIDGE
        );
        vm.stopPrank();
    }
}
