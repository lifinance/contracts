// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { LibSwap, LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { InsufficientBalance } from "src/Errors/GenericErrors.sol";
import { CircleBridgeFacet } from "lifi/Facets/CircleBridgeFacet.sol";
import { ITokenMessenger } from "lifi/Interfaces/ITokenMessenger.sol";

// import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub CircleBridgeFacet Contract
contract TestCircleBridgeFacet is CircleBridgeFacet {
    constructor(
        ITokenMessenger _xDaiBridge,
        address _usdc
    ) CircleBridgeFacet(_xDaiBridge, _usdc) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract CircleBridgeFacetTest is TestBaseFacet {
    address internal constant TOKEN_MESSENGER =
        0xBd3fa81B58Ba92a82136038B25aDec7066af3155;
    uint32 internal constant DST_DOMAIN = 3; //ARB

    TestCircleBridgeFacet internal circleBridgeFacet;
    CircleBridgeFacet.CircleBridgeData internal circleBridgeData;

    function setUp() public {
        // Custom Config
        customBlockNumberForForking = 17484106;

        initTestBase();

        circleBridgeFacet = new TestCircleBridgeFacet(
            ITokenMessenger(TOKEN_MESSENGER),
            ADDRESS_USDC
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = circleBridgeFacet
            .startBridgeTokensViaCircleBridge
            .selector;
        functionSelectors[1] = circleBridgeFacet
            .swapAndStartBridgeTokensViaCircleBridge
            .selector;
        functionSelectors[2] = circleBridgeFacet.addDex.selector;
        functionSelectors[3] = circleBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(circleBridgeFacet), functionSelectors);

        circleBridgeFacet = TestCircleBridgeFacet(address(diamond));

        circleBridgeFacet.addDex(address(uniswap));
        circleBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        circleBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        circleBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(circleBridgeFacet),
            "CircleBridgeFacet"
        );

        bridgeData.bridge = "circle";
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.destinationChainId = 43113;

        circleBridgeData = CircleBridgeFacet.CircleBridgeData(DST_DOMAIN);

        vm.label(TOKEN_MESSENGER, "TokenMessenger");
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        circleBridgeFacet.startBridgeTokensViaCircleBridge(
            bridgeData,
            circleBridgeData
        );
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            circleBridgeFacet.swapAndStartBridgeTokensViaCircleBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, circleBridgeData);
        } else {
            circleBridgeFacet.swapAndStartBridgeTokensViaCircleBridge(
                bridgeData,
                swapData,
                circleBridgeData
            );
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }
}
