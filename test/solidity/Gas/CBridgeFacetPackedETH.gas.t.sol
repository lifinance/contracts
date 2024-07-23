pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { LibAllowList, LibSwap, TestBase, console, LiFiDiamond, ILiFi, ERC20 } from "../utils/TestBase.sol";

contract CBridgeGasETHTest is TestBase {
    using SafeERC20 for IERC20;

    address internal constant CBRIDGE_ROUTER =
        0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant WHALE =
        0x72A53cDBBcc1b9efa39c834A540550e23463AAcB; // USDC + ETH
    address internal constant RECEIVER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    ICBridge internal cbridge;
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

    function setUp() public {
        customBlockNumberForForking = 15588208;
        initTestBase();

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
        cBridgeFacetPacked = CBridgeFacetPacked(payable(address(diamond)));

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
        amountNative = 1 * 10 ** 18;
        packedNative = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeNativePacked(
                transactionId,
                RECEIVER,
                destinationChainId,
                nonce,
                maxSlippage
            );

        // USDC params
        amountUSDC = 100 * 10 ** usdc.decimals();
        packedUSDC = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                ADDRESS_USDT,
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
            ADDRESS_USDT,
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
        address[] memory bridges = new address[](1);
        bridges[0] = CBRIDGE_ROUTER;
        address[] memory tokens = new address[](1);
        tokens[0] = ADDRESS_USDT;

        // > The standalone facet exposes an approval function
        standAlone.setApprovalForBridge(tokens);

        // > Approve cBridge router by usinng the HopFacetOptimized function
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
        HopFacetOptimized(address(diamond)).setApprovalForBridges(
            bridges,
            tokens
        );

        // or
        // vm.startPrank(address(diamond));
        // IERC20(ADDRESS_USDT).safeApprove(address(CBRIDGE_ROUTER), type(uint256).max);
        // vm.stopPrank();

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(cBridgeFacetPacked),
            "CBridgeFacetPacked"
        );
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
        IERC20(ADDRESS_USDT).safeApprove(address(diamond), amountUSDC);
        (bool success, ) = address(diamond).call(packedUSDC);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Packed_StandAlone() public {
        vm.startPrank(WHALE);
        IERC20(ADDRESS_USDT).safeApprove(address(standAlone), amountUSDC);
        (bool success, ) = address(standAlone).call(packedUSDC);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Min() public {
        vm.startPrank(WHALE);
        IERC20(ADDRESS_USDT).safeApprove(
            address(cBridgeFacetPacked),
            amountUSDC
        );
        cBridgeFacetPacked.startBridgeTokensViaCBridgeERC20Min(
            transactionId,
            RECEIVER,
            uint64(destinationChainId),
            ADDRESS_USDT,
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
        IERC20(ADDRESS_USDT).safeApprove(address(cBridgeFacet), amountUSDC);
        cBridgeFacet.startBridgeTokensViaCBridge(
            bridgeDataUSDC,
            cbridgeDataUSDC
        );
        vm.stopPrank();
    }
}
