// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { IHopBridge } from "lifi/Interfaces/IHopBridge.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub HopFacet Contract
contract TestHopFacet is HopFacetOptimized {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HopFacetOptimizedL1Test is TestBaseFacet {
    // These values are for Mainnet
    address internal constant USDC_BRIDGE = 0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant DAI_BRIDGE = 0x3d4Cc8A61c7528Fd86C55cfe061a78dCBA48EDd1;
    address internal constant NATIVE_BRIDGE = 0xb8901acB165ed027E32754E0FFe830802919727f;
    address internal constant CONNEXT_HANDLER = 0xB4C1340434920d70aD774309C75f9a4B679d801e;
    uint256 internal constant DSTCHAIN_ID = 137;
    // -----

    TestHopFacet internal hopFacet;
    ILiFi.BridgeData internal validBridgeData;
    HopFacetOptimized.HopData internal validHopData;

    function setUp() public {
        initTestBase();
        hopFacet = new TestHopFacet();
        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = hopFacet.startBridgeTokensViaHopL1ERC20.selector;
        functionSelectors[1] = hopFacet.startBridgeTokensViaHopL1Native.selector;
        functionSelectors[2] = hopFacet.swapAndStartBridgeTokensViaHopL1ERC20.selector;
        functionSelectors[3] = hopFacet.swapAndStartBridgeTokensViaHopL1Native.selector;
        functionSelectors[4] = hopFacet.setApprovalForBridges.selector;
        functionSelectors[5] = hopFacet.addDex.selector;
        functionSelectors[6] = hopFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(hopFacet), functionSelectors);

        hopFacet = TestHopFacet(address(diamond));

        hopFacet.addDex(address(uniswap));
        hopFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        hopFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);
        hopFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        setFacetAddressInTestBase(address(hopFacet), "HopFacet");

        // Set approval for all bridges
        address[] memory bridges = new address[](2);
        bridges[0] = USDC_BRIDGE;
        bridges[1] = DAI_BRIDGE;
        address[] memory tokens = new address[](2);
        tokens[0] = ADDRESS_USDC;
        tokens[1] = ADDRESS_DAI;
        hopFacet.setApprovalForBridges(bridges, tokens);

        vm.makePersistent(address(hopFacet));

        // adjust bridgeData
        bridgeData.bridge = "hop";
        bridgeData.destinationChainId = 137;

        // produce valid HopData
        validHopData = HopFacetOptimized.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20,
            hopBridge: IHopBridge(NATIVE_BRIDGE)
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            hopFacet.startBridgeTokensViaHopL1Native{ value: bridgeData.minAmount }(bridgeData, validHopData);
        } else {
            validHopData.hopBridge = IHopBridge(USDC_BRIDGE);
            hopFacet.startBridgeTokensViaHopL1ERC20(bridgeData, validHopData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative || bridgeData.sendingAssetId == address(0)) {
            validHopData.hopBridge = IHopBridge(NATIVE_BRIDGE);
            hopFacet.swapAndStartBridgeTokensViaHopL1Native{ value: swapData[0].fromAmount }(
                bridgeData,
                swapData,
                validHopData
            );
        } else {
            validHopData.hopBridge = IHopBridge(USDC_BRIDGE);
            hopFacet.swapAndStartBridgeTokensViaHopL1ERC20(bridgeData, swapData, validHopData);
        }
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag() public override {
        console.log("Not applicable for HopFacetOptimized");
    }

    function testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag() public override {
        console.log("Not applicable for HopFacetOptimized");
    }
}
