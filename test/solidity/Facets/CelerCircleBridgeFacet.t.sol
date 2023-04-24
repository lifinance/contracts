// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibSwap, LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { InsufficientBalance } from "src/Errors/GenericErrors.sol";
import { CelerCircleBridgeFacet } from "lifi/Facets/CelerCircleBridgeFacet.sol";
import { ICircleBridgeProxy } from "lifi/Interfaces/ICircleBridgeProxy.sol";

// import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub CelerCircleBridgeFacet Contract
contract TestCelerCircleBridgeFacet is CelerCircleBridgeFacet {
    constructor(
        ICircleBridgeProxy _circleBridgeProxy,
        address _usdc
    ) CelerCircleBridgeFacet(_circleBridgeProxy, _usdc) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract CelerCircleBridgeFacetTest is TestBaseFacet {
    // These values are for Goerli
    address internal constant TOKEN_MESSENGER =
        0x6065A982F04F759b7d2D042D2864e569fad84214;

    TestCelerCircleBridgeFacet internal celerCircleBridgeFacet;

    function setUp() public {
        // Custom Config
        customBlockNumberForForking = 17118891; // after proxy+bridge configuration

        initTestBase();

        defaultDAIAmount = 100000;
        defaultUSDCAmount = 100001; // fee + 1

        celerCircleBridgeFacet = new TestCelerCircleBridgeFacet(
            ICircleBridgeProxy(TOKEN_MESSENGER),
            ADDRESS_USDC
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = celerCircleBridgeFacet
            .startBridgeTokensViaCelerCircleBridge
            .selector;
        functionSelectors[1] = celerCircleBridgeFacet
            .swapAndStartBridgeTokensViaCelerCircleBridge
            .selector;
        functionSelectors[2] = celerCircleBridgeFacet.addDex.selector;
        functionSelectors[3] = celerCircleBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(celerCircleBridgeFacet), functionSelectors);

        celerCircleBridgeFacet = TestCelerCircleBridgeFacet(address(diamond));

        celerCircleBridgeFacet.addDex(address(uniswap));
        celerCircleBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        celerCircleBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        celerCircleBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(celerCircleBridgeFacet),
            "CelerCircleBridgeFacet"
        );

        bridgeData.bridge = "celerCircle";
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.destinationChainId = 43114;
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        celerCircleBridgeFacet.startBridgeTokensViaCelerCircleBridge(
            bridgeData
        );
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            celerCircleBridgeFacet
                .swapAndStartBridgeTokensViaCelerCircleBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            celerCircleBridgeFacet
                .swapAndStartBridgeTokensViaCelerCircleBridge(
                    bridgeData,
                    swapData
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
