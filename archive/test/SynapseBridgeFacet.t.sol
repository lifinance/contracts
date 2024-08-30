// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { SynapseBridgeFacet } from "lifi/Facets/SynapseBridgeFacet.sol";
import { ISynapseRouter } from "lifi/Interfaces/ISynapseRouter.sol";

// Stub SynapseBridgeFacet Contract
contract TestSynapseBridgeFacet is SynapseBridgeFacet {
    constructor(
        ISynapseRouter _synapseRouter
    ) SynapseBridgeFacet(_synapseRouter) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract SynapseBridgeFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant SYNAPSE_ROUTER =
        0x7E7A0e201FD38d3ADAA9523Da6C109a07118C96a;
    address internal constant NETH_ADDRESS =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    uint256 internal constant DST_CHAIN_ID = 56;

    TestSynapseBridgeFacet internal synapseBridgeFacet;
    SynapseBridgeFacet.SynapseData internal synapseData;

    function setUp() public {
        customBlockNumberForForking = 16815700;

        initTestBase();

        synapseBridgeFacet = new TestSynapseBridgeFacet(
            ISynapseRouter(SYNAPSE_ROUTER)
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = synapseBridgeFacet
            .startBridgeTokensViaSynapseBridge
            .selector;
        functionSelectors[1] = synapseBridgeFacet
            .swapAndStartBridgeTokensViaSynapseBridge
            .selector;
        functionSelectors[2] = synapseBridgeFacet.addDex.selector;
        functionSelectors[3] = synapseBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(synapseBridgeFacet), functionSelectors);

        synapseBridgeFacet = TestSynapseBridgeFacet(address(diamond));

        synapseBridgeFacet.addDex(address(uniswap));
        synapseBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        synapseBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        synapseBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        synapseBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        setFacetAddressInTestBase(
            address(synapseBridgeFacet),
            "SynapseBridgeFacet"
        );

        bridgeData.bridge = "synapse";
        bridgeData.minAmount = defaultUSDCAmount;

        synapseData = SynapseBridgeFacet.SynapseData(
            ISynapseRouter.SwapQuery(address(0), address(0), 0, 0, ""),
            ISynapseRouter.SwapQuery(address(0), address(0), 0, 0, "")
        );

        setOriginQuery(
            bridgeData.sendingAssetId,
            "USDC",
            bridgeData.minAmount
        );
    }

    function setOriginQuery(
        address tokenIn,
        string memory symbol,
        uint256 amountOut
    ) internal {
        string[] memory tokenSymbols = new string[](1);
        tokenSymbols[0] = symbol;
        ISynapseRouter.SwapQuery[] memory swapQuery = ISynapseRouter(
            SYNAPSE_ROUTER
        ).getOriginAmountOut(tokenIn, tokenSymbols, amountOut);

        synapseData.originQuery = swapQuery[0];
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            synapseBridgeFacet.startBridgeTokensViaSynapseBridge{
                value: bridgeData.minAmount
            }(bridgeData, synapseData);
        } else {
            synapseBridgeFacet.startBridgeTokensViaSynapseBridge(
                bridgeData,
                synapseData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            synapseBridgeFacet.swapAndStartBridgeTokensViaSynapseBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, synapseData);
        } else {
            synapseBridgeFacet.swapAndStartBridgeTokensViaSynapseBridge(
                bridgeData,
                swapData,
                synapseData
            );
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        setOriginQuery(NETH_ADDRESS, "nETH", bridgeData.minAmount);

        super.testBase_CanBridgeNativeTokens();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        setOriginQuery(NETH_ADDRESS, "nETH", bridgeData.minAmount);

        super.testBase_CanSwapAndBridgeNativeTokens();
    }
}
