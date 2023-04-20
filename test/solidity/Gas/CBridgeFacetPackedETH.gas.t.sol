pragma solidity 0.8.17;

import "ds-test/test.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { Test } from "forge-std/Test.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { console } from "../utils/Console.sol";

contract CBridgeGasTest is Test, DiamondTest {
    address internal constant CBRIDGE_ROUTER =
        0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant USDC_ADDRESS =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WHALE =
        0x72A53cDBBcc1b9efa39c834A540550e23463AAcB; // USDC + ETH
    address internal constant RECEIVER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    ICBridge internal cbridge;
    ERC20 internal usdc;
    LiFiDiamond internal diamond;
    CBridgeFacetPacked internal cBridgeFacetPacked;
    CBridgeFacetPacked internal standAlone;
    CBridgeFacet internal cBridgeFacet;

    bytes32 transactionId;
    string integrator;
    uint256 destinationChainId;
    uint64 nonce;
    uint32 maxSlippage;

    uint256 amountNative;
    bytes packedNative;

    uint256 amountUSDC;
    bytes packedUSDC;

    ILiFi.BridgeData bridgeDataNative;
    CBridgeFacet.CBridgeData cbridgeDataNative;

    ILiFi.BridgeData bridgeDataUSDC;
    CBridgeFacet.CBridgeData cbridgeDataUSDC;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15588208;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        usdc = ERC20(USDC_ADDRESS);
        diamond = createDiamond();
        cbridge = ICBridge(CBRIDGE_ROUTER);

        /// Perpare CBridgeFacetPacked
        cBridgeFacetPacked = new CBridgeFacetPacked(cbridge, address(this));
        standAlone = new CBridgeFacetPacked(cbridge, address(this));

        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeNativePacked
            .selector;
        functionSelectors[1] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeNativeMin
            .selector;
        functionSelectors[2] = cBridgeFacetPacked
            .encoder_startBridgeTokensViaCBridgeNativePacked
            .selector;
        functionSelectors[3] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeERC20Packed
            .selector;
        functionSelectors[4] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeERC20Min
            .selector;
        functionSelectors[5] = cBridgeFacetPacked
            .encoder_startBridgeTokensViaCBridgeERC20Packed
            .selector;

        addFacet(diamond, address(cBridgeFacetPacked), functionSelectors);
        cBridgeFacetPacked = CBridgeFacetPacked(address(diamond));

        /// Perpare CBridgeFacet
        cBridgeFacet = new CBridgeFacet(cbridge);

        bytes4[] memory functionSelectors2 = new bytes4[](1);
        functionSelectors2[0] = cBridgeFacet
            .startBridgeTokensViaCBridge
            .selector;

        addFacet(diamond, address(cBridgeFacet), functionSelectors2);
        cBridgeFacet = CBridgeFacet(address(diamond));

        /// Perpare Approval
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
            abi.encodeWithSignature(
                "startBridgeTokensViaCBridgeNativePacked()"
            ),
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
            abi.encodeWithSignature(
                "startBridgeTokensViaCBridgeERC20Packed()"
            ),
            packedUSDCParams
        );

        // same data for HopFacetOptimized
        bridgeDataNative = ILiFi.BridgeData(
            transactionId,
            "cbridge",
            integrator,
            address(0),
            address(0),
            RECEIVER,
            amountNative,
            destinationChainId,
            false,
            false
        );

        cbridgeDataNative = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 123
        });

        bridgeDataUSDC = ILiFi.BridgeData(
            transactionId,
            "cbridge",
            integrator,
            address(0),
            USDC_ADDRESS,
            RECEIVER,
            amountUSDC,
            destinationChainId,
            false,
            false
        );

        cbridgeDataUSDC = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1234
        });

        standAlone.setApprovalForBridge(tokens);
    }

    function testCallData() public view {
        console.logString("startBridgeTokensViaCBridgeNativePacked");
        console.logBytes(packedNative);
        bytes memory encodedNative = cBridgeFacetPacked
            .encoder_startBridgeTokensViaCBridgeNativePacked(
                transactionId,
                integrator,
                RECEIVER,
                uint64(destinationChainId),
                nonce,
                maxSlippage
            );
        console.logString("encodedNative");
        console.logBytes(encodedNative);

        console.logString("startBridgeTokensViaCBridgeERC20Packed");
        console.logBytes(packedUSDC);
        bytes memory encodedUSDC = cBridgeFacetPacked
            .encoder_startBridgeTokensViaCBridgeERC20Packed(
                transactionId,
                integrator,
                RECEIVER,
                uint64(destinationChainId),
                USDC_ADDRESS,
                amountUSDC,
                nonce,
                maxSlippage
            );
        console.logString("encodedUSDC");
        console.logBytes(encodedUSDC);
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

    function testStartBridgeTokensViaCBridgeNative() public {
        vm.startPrank(WHALE);
        cBridgeFacet.startBridgeTokensViaCBridge{ value: amountNative }(
            bridgeDataNative,
            cbridgeDataNative
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        cBridgeFacet.startBridgeTokensViaCBridge(
            bridgeDataUSDC,
            cbridgeDataUSDC
        );
        vm.stopPrank();
    }
}
