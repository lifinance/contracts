// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { CelerCircleBridgeV2Facet } from "lifi/Facets/CelerCircleBridgeV2Facet.sol";
import { ICircleBridgeProxyV2 } from "lifi/Interfaces/ICircleBridgeProxyV2.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

// Stub CelerCircleBridgeFacet Contract
contract TestCelerCircleBridgeV2Facet is
    CelerCircleBridgeV2Facet,
    TestWhitelistManagerBase
{
    constructor(
        ICircleBridgeProxyV2 _circleBridgeProxyV2,
        address _usdc
    ) CelerCircleBridgeV2Facet(_circleBridgeProxyV2, _usdc) {}
}

contract CelerCircleBridgeV2FacetTest is TestBaseFacet {
    address internal constant TOKEN_MESSENGER =
        0x9B36f165baB9ebe611d491180418d8De4b8f3a1f;

    TestCelerCircleBridgeV2Facet internal celerCircleBridgeV2Facet;
    CelerCircleBridgeV2Facet.CelerCircleBridgeData
        internal celerCircleBridgeData;

    function setUp() public {
        // Custom Config
        customRpcUrlForForking = "ETH_NODE_URI_PLUME";
        customBlockNumberForForking = 23981907; // after proxy+bridge configuration

        initTestBase();

        defaultDAIAmount = 100000;
        defaultUSDCAmount = 100001; // fee + 1

        celerCircleBridgeV2Facet = new TestCelerCircleBridgeV2Facet(
            ICircleBridgeProxyV2(TOKEN_MESSENGER),
            ADDRESS_USDC
        );

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = celerCircleBridgeV2Facet
            .startBridgeTokensViaCelerCircleBridge
            .selector;
        functionSelectors[1] = celerCircleBridgeV2Facet
            .swapAndStartBridgeTokensViaCelerCircleBridge
            .selector;
        functionSelectors[2] = celerCircleBridgeV2Facet
            .addAllowedContractSelector
            .selector;

        addFacet(
            diamond,
            address(celerCircleBridgeV2Facet),
            functionSelectors
        );

        celerCircleBridgeV2Facet = TestCelerCircleBridgeV2Facet(
            address(diamond)
        );

        celerCircleBridgeV2Facet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        celerCircleBridgeV2Facet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForETH.selector
        );
        celerCircleBridgeV2Facet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(celerCircleBridgeV2Facet),
            "CelerCircleBridgeV2Facet"
        );

        bridgeData.bridge = "circle";
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.destinationChainId = 43114;

        // Default CelerCircleBridgeData: maxFee = 0 (no limit), minFinalityThreshold = 2000 (standard path)
        celerCircleBridgeData = CelerCircleBridgeV2Facet
            .CelerCircleBridgeData({ maxFee: 0, minFinalityThreshold: 2000 });
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        celerCircleBridgeV2Facet.startBridgeTokensViaCelerCircleBridge(
            bridgeData,
            celerCircleBridgeData
        );
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            celerCircleBridgeV2Facet
                .swapAndStartBridgeTokensViaCelerCircleBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, celerCircleBridgeData);
        } else {
            celerCircleBridgeV2Facet
                .swapAndStartBridgeTokensViaCelerCircleBridge(
                    bridgeData,
                    swapData,
                    celerCircleBridgeData
                );
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function test_Revert_DestinationChainIdTooLarge() public virtual {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.destinationChainId = uint256(type(uint64).max) + 1;
        vm.expectRevert(InvalidCallData.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }
}
