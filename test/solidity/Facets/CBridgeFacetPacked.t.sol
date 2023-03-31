pragma solidity 0.8.17;

import "ds-test/test.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { Test } from "forge-std/Test.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { console } from "../utils/Console.sol";

contract CBridgeGasTest is Test, DiamondTest {
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

    bytes32 transactionId;
    string integrator;
    uint256 destinationChainId;
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
        cBridgeFacetPacked = new CBridgeFacetPacked(cbridge);
        usdc = ERC20(USDC_ADDRESS);


        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = cBridgeFacetPacked.startBridgeTokensViaCBridgeNativePacked.selector;
        functionSelectors[1] = cBridgeFacetPacked.startBridgeTokensViaCBridgeNativeMin.selector;
        functionSelectors[2] = cBridgeFacetPacked.startBridgeTokensViaCBridgeERC20Packed.selector;
        functionSelectors[3] = cBridgeFacetPacked.startBridgeTokensViaCBridgeERC20Min.selector;
        functionSelectors[4] = cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeNativePacked.selector;
        functionSelectors[5] = cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeERC20Packed.selector;

        addFacet(diamond, address(cBridgeFacetPacked), functionSelectors);
        cBridgeFacetPacked = CBridgeFacetPacked(address(diamond));

        /// Perpare Approval
        HopFacetOptimized hopFacetOptimized = new HopFacetOptimized();
        bytes4[] memory functionSelectorsApproval = new bytes4[](1);
        functionSelectorsApproval[0] = hopFacetOptimized.setApprovalForBridges.selector;

        addFacet(diamond, address(hopFacetOptimized), functionSelectorsApproval);
        hopFacetOptimized = HopFacetOptimized(address(diamond));

        address[] memory bridges = new address[](1);
        bridges[0] = CBRIDGE_ROUTER;
        address[] memory tokens = new address[](1);
        tokens[0] = USDC_ADDRESS;
        hopFacetOptimized.setApprovalForBridges(bridges, tokens);


        /// Perpare parameters
        transactionId = "someID";
        integrator = "demo-partner";
        destinationChainId = 137;
        maxSlippage = 5000;

        // Native params
        amountNative = 1 * 10**18;
        bytes memory packedNativeParams = bytes.concat(
            bytes8(transactionId), // transactionId
            bytes16(bytes(integrator)), // integrator
            bytes20(RECEIVER), // receiver
            bytes4(uint32(destinationChainId)), // destinationChainId
            bytes4(uint32(nonce)), // nonce
            bytes4(maxSlippage) // maxSlippage
        );
        packedNative = bytes.concat(
            abi.encodeWithSignature("startBridgeTokensViaCBridgeNativePacked()"),
            packedNativeParams
        );

        // USDC params
        amountUSDC = 100 * 10**usdc.decimals();
        bytes memory packedUSDCParams = bytes.concat(
            bytes8(transactionId), // transactionId
            bytes16(bytes(integrator)), // integrator
            bytes20(RECEIVER), // receiver
            bytes4(uint32(destinationChainId)), // destinationChainId
            bytes20(USDC_ADDRESS), // sendingAssetId
            bytes16(uint128(amountUSDC)), // amount
            bytes4(uint32(nonce)), // nonce
            bytes4(maxSlippage) // maxSlippage
        );
        packedUSDC = bytes.concat(
            abi.encodeWithSignature("startBridgeTokensViaCBridgeERC20Packed()"),
            packedUSDCParams
        );
    }

    function testStartBridgeTokensViaCBridgeNativePacked() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(diamond).call{value: amountNative}(packedNative);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeNativeMin() public {
        vm.startPrank(WHALE);
        cBridgeFacetPacked.startBridgeTokensViaCBridgeNativeMin{value: amountNative}(
            transactionId,
            integrator,
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

    function testStartBridgeTokensViaCBridgeERC20Min() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        cBridgeFacetPacked.startBridgeTokensViaCBridgeERC20Min(
            transactionId,
            integrator,
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
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            integrator,
            RECEIVER,
            uint64(type(uint32).max),
            nonce,
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            integrator,
            RECEIVER,
            uint64(type(uint32).max) + 1,
            nonce,
            maxSlippage
        );

        // nonce
        // > max allowed
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            integrator,
            RECEIVER,
            137,
            uint64(type(uint32).max),
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            integrator,
            RECEIVER,
            137,
            uint64(type(uint32).max) + 1,
            maxSlippage
        );
    }

    function testEncodeERC20Validation() public {
        // destinationChainId
        // > max allowed
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            integrator,
            RECEIVER,
            uint64(type(uint32).max),
            USDC_ADDRESS,
            amountUSDC,
            nonce,
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            integrator,
            RECEIVER,
            uint64(type(uint32).max) + 1,
            USDC_ADDRESS,
            amountUSDC,
            nonce,
            maxSlippage
        );

        // nonce
        // > max allowed
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            integrator,
            RECEIVER,
            137,
            USDC_ADDRESS,
            uint256(type(uint128).max),
            nonce,
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            integrator,
            RECEIVER,
            137,
            USDC_ADDRESS,
            uint256(type(uint128).max) + 1,
            nonce,
            maxSlippage
        );

        // nonce
        // > max allowed
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            integrator,
            RECEIVER,
            137,
            USDC_ADDRESS,
            amountUSDC,
            uint64(type(uint32).max),
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encoder_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            integrator,
            RECEIVER,
            137,
            USDC_ADDRESS,
            amountUSDC,
            uint64(type(uint32).max) + 1,
            maxSlippage
        );
    }
}
