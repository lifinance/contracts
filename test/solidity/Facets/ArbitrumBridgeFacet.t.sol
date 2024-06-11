// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { ArbitrumBridgeFacet } from "lifi/Facets/ArbitrumBridgeFacet.sol";
import { IGatewayRouter } from "lifi/Interfaces/IGatewayRouter.sol";

// Stub ArbitrumBridgeFacet Contract
contract TestArbitrumBridgeFacet is ArbitrumBridgeFacet {
    constructor(
        IGatewayRouter _gatewayRouter,
        IGatewayRouter _inbox
    ) ArbitrumBridgeFacet(_gatewayRouter, _inbox) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract ArbitrumBridgeFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant GATEWAY_ROUTER =
        0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef;
    address internal constant INBOX =
        0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f;
    uint256 internal constant MAX_SUBMISSION_COST = 1e16;
    uint256 internal constant MAX_GAS = 100000;
    uint256 internal constant MAX_GAS_PRICE = 1e9;
    // -----

    TestArbitrumBridgeFacet internal arbitrumBridgeFacet;
    ArbitrumBridgeFacet.ArbitrumData internal arbitrumData;
    uint256 internal cost;

    function setUp() public {
        initTestBase();

        arbitrumBridgeFacet = new TestArbitrumBridgeFacet(
            IGatewayRouter(GATEWAY_ROUTER),
            IGatewayRouter(INBOX)
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = arbitrumBridgeFacet
            .startBridgeTokensViaArbitrumBridge
            .selector;
        functionSelectors[1] = arbitrumBridgeFacet
            .swapAndStartBridgeTokensViaArbitrumBridge
            .selector;
        functionSelectors[2] = arbitrumBridgeFacet.addDex.selector;
        functionSelectors[3] = arbitrumBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(arbitrumBridgeFacet), functionSelectors);

        arbitrumBridgeFacet = TestArbitrumBridgeFacet(address(diamond));

        arbitrumBridgeFacet.addDex(address(uniswap));
        arbitrumBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        arbitrumBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        arbitrumBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(arbitrumBridgeFacet),
            "ArbitrumFacet"
        );

        bridgeData.bridge = "arbitrum";
        bridgeData.destinationChainId = 42161;

        arbitrumData = ArbitrumBridgeFacet.ArbitrumData({
            maxSubmissionCost: MAX_SUBMISSION_COST,
            maxGas: MAX_GAS,
            maxGasPrice: MAX_GAS_PRICE
        });

        cost = addToMessageValue =
            MAX_SUBMISSION_COST +
            MAX_GAS_PRICE *
            MAX_GAS;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            arbitrumBridgeFacet.startBridgeTokensViaArbitrumBridge{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, arbitrumData);
        } else {
            arbitrumBridgeFacet.startBridgeTokensViaArbitrumBridge{
                value: addToMessageValue
            }(bridgeData, arbitrumData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            arbitrumBridgeFacet.swapAndStartBridgeTokensViaArbitrumBridge{
                value: swapData[0].fromAmount + addToMessageValue
            }(bridgeData, swapData, arbitrumData);
        } else {
            arbitrumBridgeFacet.swapAndStartBridgeTokensViaArbitrumBridge{
                value: addToMessageValue
            }(bridgeData, swapData, arbitrumData);
        }
    }
}
