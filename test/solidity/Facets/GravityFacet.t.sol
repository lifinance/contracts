// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, InvalidAmount, ERC20 } from "../utils/TestBaseFacet.sol";
import { NativeAssetNotSupported } from "src/Errors/GenericErrors.sol";
import { GravityFacet } from "lifi/Facets/GravityFacet.sol";
import { IGravityRouter } from "lifi/Interfaces/IGravityRouter.sol";

// Stub GravityFacet Contract
contract TestGravityFacet is GravityFacet {
    constructor(IGravityRouter _router) GravityFacet(_router) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GravityFacetTest is TestBaseFacet {
    // These values are for mainnet
    address internal constant GRAVITY_ROUTER = 0xa4108aA1Ec4967F8b52220a4f7e94A8201F2D906;
    // -----

    TestGravityFacet internal gravityFacet;
    GravityFacet.GravityData internal gravityData;

    function setUp() public {
        initTestBase();

        diamond = createDiamond();
        gravityFacet = new TestGravityFacet(IGravityRouter(GRAVITY_ROUTER));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = gravityFacet.startBridgeTokensViaGravity.selector;
        functionSelectors[1] = gravityFacet.swapAndStartBridgeTokensViaGravity.selector;
        functionSelectors[2] = gravityFacet.addDex.selector;
        functionSelectors[3] = gravityFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(gravityFacet), functionSelectors);

        gravityFacet = TestGravityFacet(address(diamond));

        gravityFacet.addDex(address(uniswap));
        gravityFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        gravityFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);

        setFacetAddressInTestBase(address(gravityFacet), "GravityFacet");

        bridgeData.bridge = "gravity";

        gravityData = GravityFacet.GravityData({ destinationAddress: "canto1f0cukfd8xj368prlpj6x69nyer3fcnus8wy8uf" });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            revert NativeAssetNotSupported();
        } else {
            gravityFacet.startBridgeTokensViaGravity(bridgeData, gravityData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            revert NativeAssetNotSupported();
        } else {
            gravityFacet.swapAndStartBridgeTokensViaGravity(bridgeData, swapData, gravityData);
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function test_revert_BridgeNativeAsset() public {
        bridgeData.sendingAssetId = address(0);
        vm.expectRevert(NativeAssetNotSupported.selector);
        gravityFacet.startBridgeTokensViaGravity(bridgeData, gravityData);
    }
}
