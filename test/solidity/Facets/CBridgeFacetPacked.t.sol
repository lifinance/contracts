pragma solidity 0.8.17;

import "ds-test/test.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { Test } from "forge-std/Test.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { console } from "../utils/Console.sol";

contract CBridgeFacetPackedTest is Test, DiamondTest {
    address internal constant CBRIDGE_ROUTER =
        0x1619DE6B6B20eD217a58d00f37B9d47C7663feca;
    address internal constant USDC_ADDRESS =
        0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address internal constant WHALE =
        0xF3F094484eC6901FfC9681bCb808B96bAFd0b8a8; // USDC + ETH
    address internal constant RECEIVER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    ICBridge internal cbridge;
    ERC20 internal usdc;
    LiFiDiamond internal diamond;
    CBridgeFacetPacked internal cBridgeFacetPacked;
    CBridgeFacetPacked internal standAlone;

    bytes32 transactionId;
    uint64 destinationChainId;
    uint64 nonce;
    uint32 maxSlippage;

    uint256 amountNative;
    bytes packedNative;

    uint256 amountUSDC;
    bytes packedUSDC;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_ARBITRUM");
        uint256 blockNumber = 58467500;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        /// Perpare CBridgeFacetPacked
        diamond = createDiamond();
        cbridge = ICBridge(CBRIDGE_ROUTER);
        cBridgeFacetPacked = new CBridgeFacetPacked(cbridge, address(this));
        standAlone = new CBridgeFacetPacked(cbridge, address(this));
        usdc = ERC20(USDC_ADDRESS);

        bytes4[] memory functionSelectors = new bytes4[](8);
        functionSelectors[0] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeNativePacked
            .selector;
        functionSelectors[1] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeNativeMin
            .selector;
        functionSelectors[2] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeERC20Packed
            .selector;
        functionSelectors[3] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeERC20Min
            .selector;
        functionSelectors[4] = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeNativePacked
            .selector;
        functionSelectors[5] = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeERC20Packed
            .selector;
        functionSelectors[6] = cBridgeFacetPacked
            .decode_startBridgeTokensViaCBridgeNativePacked
            .selector;
        functionSelectors[7] = cBridgeFacetPacked
            .decode_startBridgeTokensViaCBridgeERC20Packed
            .selector;

        addFacet(diamond, address(cBridgeFacetPacked), functionSelectors);
        cBridgeFacetPacked = CBridgeFacetPacked(address(diamond));

        /// Perpare parameters
        transactionId = "someID";
        destinationChainId = 137;
        maxSlippage = 5000;

        // Native params
        amountNative = 1 ether;
        packedNative = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeNativePacked(
                transactionId,
                RECEIVER,
                destinationChainId,
                nonce,
                maxSlippage
            );

        // USDC params
        amountUSDC = 100 * 10**usdc.decimals();
        packedUSDC = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                USDC_ADDRESS,
                amountUSDC,
                nonce,
                maxSlippage
            );

        // Prepare approvals
        address[] memory tokens = new address[](1);
        tokens[0] = USDC_ADDRESS;
        vm.prank(address(cBridgeFacetPacked));
        usdc.approve(CBRIDGE_ROUTER, type(uint256).max);
        standAlone.setApprovalForBridge(tokens);
    }

    function testStartBridgeTokensViaCBridgeNativePacked() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(diamond).call{ value: amountNative }(
            packedNative
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeNativePacked_StandAlone() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(standAlone).call{ value: amountNative }(
            packedNative
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeNativeMin() public {
        vm.startPrank(WHALE);
        cBridgeFacetPacked.startBridgeTokensViaCBridgeNativeMin{
            value: amountNative
        }(
            transactionId,
            RECEIVER,
            uint64(destinationChainId),
            nonce,
            maxSlippage
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Packed() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        (bool success, ) = address(diamond).call(packedUSDC);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Packed_StandAlone() public {
        vm.startPrank(WHALE);
        usdc.approve(address(standAlone), amountUSDC);
        (bool success, ) = address(standAlone).call(packedUSDC);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Min() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        cBridgeFacetPacked.startBridgeTokensViaCBridgeERC20Min(
            transactionId,
            RECEIVER,
            uint64(destinationChainId),
            USDC_ADDRESS,
            amountUSDC,
            nonce,
            maxSlippage
        );
        vm.stopPrank();
    }

    function testEncodeNativeValidation() public {
        // destinationChainId
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            RECEIVER,
            uint64(type(uint32).max),
            nonce,
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            RECEIVER,
            uint64(type(uint32).max) + 1,
            nonce,
            maxSlippage
        );

        // nonce
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            RECEIVER,
            137,
            uint64(type(uint32).max),
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            RECEIVER,
            137,
            uint64(type(uint32).max) + 1,
            maxSlippage
        );
    }

    function testEncodeERC20Validation() public {
        // destinationChainId
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            uint64(type(uint32).max),
            USDC_ADDRESS,
            amountUSDC,
            nonce,
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            uint64(type(uint32).max) + 1,
            USDC_ADDRESS,
            amountUSDC,
            nonce,
            maxSlippage
        );

        // nonce
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            137,
            USDC_ADDRESS,
            uint256(type(uint128).max),
            nonce,
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            137,
            USDC_ADDRESS,
            uint256(type(uint128).max) + 1,
            nonce,
            maxSlippage
        );

        // nonce
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            137,
            USDC_ADDRESS,
            amountUSDC,
            uint64(type(uint32).max),
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            137,
            USDC_ADDRESS,
            amountUSDC,
            uint64(type(uint32).max) + 1,
            maxSlippage
        );
    }

    function test_CanEncodeAndDecodeCBridgeNativeCall() public {
        bytes memory encoded = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeNativePacked(
                transactionId,
                RECEIVER,
                destinationChainId,
                nonce,
                maxSlippage
            );

        (
            ILiFi.BridgeData memory decodedBridgeData,
            CBridgeFacet.CBridgeData memory decodedCBridgeData
        ) = cBridgeFacetPacked.decode_startBridgeTokensViaCBridgeNativePacked(
                encoded
            );
        assertEq(
            decodedBridgeData.transactionId,
            transactionId,
            "transactionId does not match"
        );
        assertEq(
            decodedBridgeData.receiver,
            RECEIVER,
            "Receiver does not match"
        );
        assertEq(
            decodedBridgeData.destinationChainId,
            destinationChainId,
            "destinationChainId does not match"
        );
        assertEq(
            decodedCBridgeData.maxSlippage,
            maxSlippage,
            "maxSlippage does not match"
        );
        assertEq(decodedCBridgeData.nonce, nonce, "nonce does not match");
    }

    function test_CanEncodeAndDecodeCBridgeERC20Call() public {
        bytes memory encoded = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                USDC_ADDRESS,
                amountUSDC,
                nonce,
                maxSlippage
            );
        (
            ILiFi.BridgeData memory decodedBridgeData,
            CBridgeFacet.CBridgeData memory decodedCBridgeData
        ) = cBridgeFacetPacked.decode_startBridgeTokensViaCBridgeERC20Packed(
                encoded
            );
        assertEq(
            decodedBridgeData.transactionId,
            transactionId,
            "transactionId does not match"
        );
        assertEq(
            decodedBridgeData.receiver,
            RECEIVER,
            "Receiver does not match"
        );
        assertEq(
            decodedBridgeData.destinationChainId,
            destinationChainId,
            "destinationChainId does not match"
        );
        assertEq(
            decodedBridgeData.sendingAssetId,
            USDC_ADDRESS,
            "sendingAssetId does not match"
        );
        assertEq(
            decodedBridgeData.minAmount,
            amountUSDC,
            "minAmount does not match"
        );
        assertEq(
            decodedCBridgeData.maxSlippage,
            maxSlippage,
            "maxSlippage does not match"
        );
        assertEq(decodedCBridgeData.nonce, nonce, "nonce does not match");
    }
}
