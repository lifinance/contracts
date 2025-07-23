pragma solidity ^0.8.17;

import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { TestBase, ILiFi } from "../utils/TestBase.sol";

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

    struct BridgeParams {
        bytes32 transactionId;
        uint64 destinationChainId;
        uint64 nonce;
        uint32 maxSlippage;
        uint256 amountNative;
        uint256 amountUSDC;
    }

    BridgeParams internal bridgeParams;
    bytes internal packedNative;
    bytes internal packedUSDC;

    ILiFi.BridgeData internal bridgeDataNative;
    CBridgeFacet.CBridgeData internal cbridgeDataNative;

    ILiFi.BridgeData internal bridgeDataUSDC;
    CBridgeFacet.CBridgeData internal cbridgeDataUSDC;

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

        addFacet(address(diamond), address(cBridgeFacetPacked), functionSelectors);
        cBridgeFacetPacked = CBridgeFacetPacked(payable(address(diamond)));

        /// Perpare CBridgeFacet
        cBridgeFacet = new CBridgeFacet(cbridge);

        bytes4[] memory functionSelectors2 = new bytes4[](1);
        functionSelectors2[0] = cBridgeFacet
            .startBridgeTokensViaCBridge
            .selector;

        addFacet(address(diamond), address(cBridgeFacet), functionSelectors2);
        cBridgeFacet = CBridgeFacet(address(diamond));

        /// Perpare parameters
        bridgeParams = BridgeParams({
            transactionId: "someID",
            destinationChainId: 137,
            nonce: 123,
            maxSlippage: 5000,
            amountNative: 1 ether,
            amountUSDC: 100 * 10 ** usdc.decimals()
        });

        // Native params
        packedNative = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeNativePacked(
                bridgeParams.transactionId,
                RECEIVER,
                bridgeParams.destinationChainId,
                bridgeParams.nonce,
                bridgeParams.maxSlippage
            );

        // USDC params
        packedUSDC = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeERC20Packed(
                bridgeParams.transactionId,
                RECEIVER,
                bridgeParams.destinationChainId,
                ADDRESS_USDT,
                bridgeParams.amountUSDC,
                bridgeParams.nonce,
                bridgeParams.maxSlippage
            );

        // same data for HopFacetOptimized
        bridgeDataNative = ILiFi.BridgeData(
            bridgeParams.transactionId,
            "cbridge",
            "",
            address(0),
            address(0),
            RECEIVER,
            bridgeParams.amountNative,
            bridgeParams.destinationChainId,
            false,
            false
        );

        cbridgeDataNative = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 123
        });

        bridgeDataUSDC = ILiFi.BridgeData(
            bridgeParams.transactionId,
            "cbridge",
            "",
            address(0),
            ADDRESS_USDT,
            RECEIVER,
            bridgeParams.amountUSDC,
            bridgeParams.destinationChainId,
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
            address(diamond),
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
        (bool success, ) = address(diamond).call{
            value: bridgeParams.amountNative
        }(packedNative);
        if (!success) {
            revert NativeBridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeNativePacked_StandAlone() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(standAlone).call{
            value: bridgeParams.amountNative
        }(packedNative);
        if (!success) {
            revert NativeBridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeNativeMin() public {
        vm.startPrank(WHALE);
        cBridgeFacetPacked.startBridgeTokensViaCBridgeNativeMin{
            value: bridgeParams.amountNative
        }(
            bridgeParams.transactionId,
            RECEIVER,
            uint64(bridgeParams.destinationChainId),
            bridgeParams.nonce,
            bridgeParams.maxSlippage
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Packed() public {
        vm.startPrank(WHALE);
        IERC20(ADDRESS_USDT).safeApprove(
            address(diamond),
            bridgeParams.amountUSDC
        );
        (bool success, ) = address(diamond).call(packedUSDC);
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Packed_StandAlone() public {
        vm.startPrank(WHALE);
        IERC20(ADDRESS_USDT).safeApprove(
            address(standAlone),
            bridgeParams.amountUSDC
        );
        (bool success, ) = address(standAlone).call(packedUSDC);
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Min() public {
        vm.startPrank(WHALE);
        IERC20(ADDRESS_USDT).safeApprove(
            address(cBridgeFacetPacked),
            bridgeParams.amountUSDC
        );
        cBridgeFacetPacked.startBridgeTokensViaCBridgeERC20Min(
            bridgeParams.transactionId,
            RECEIVER,
            uint64(bridgeParams.destinationChainId),
            ADDRESS_USDT,
            bridgeParams.amountUSDC,
            bridgeParams.nonce,
            bridgeParams.maxSlippage
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeNative() public {
        vm.startPrank(WHALE);
        cBridgeFacet.startBridgeTokensViaCBridge{
            value: bridgeParams.amountNative
        }(bridgeDataNative, cbridgeDataNative);
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20() public {
        vm.startPrank(WHALE);
        IERC20(ADDRESS_USDT).safeApprove(
            address(cBridgeFacet),
            bridgeParams.amountUSDC
        );
        cBridgeFacet.startBridgeTokensViaCBridge(
            bridgeDataUSDC,
            cbridgeDataUSDC
        );
        vm.stopPrank();
    }
}
