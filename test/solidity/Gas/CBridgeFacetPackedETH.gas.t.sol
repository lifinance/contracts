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

contract CBridgeGasETHTest is Test, DiamondTest {
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
    uint64 destinationChainId;
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

        /// Perpare parameters
        transactionId = "someID";
        destinationChainId = 137;
        maxSlippage = 5000;

        // Native params
        amountNative = 1 * 10**18;
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

        // same data for HopFacetOptimized
        bridgeDataNative = ILiFi.BridgeData(
            transactionId,
            "cbridge",
            "",
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
            "",
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
