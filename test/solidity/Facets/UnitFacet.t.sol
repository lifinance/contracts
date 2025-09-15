// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { UnitFacet } from "lifi/Facets/UnitFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

// Stub UnitFacet Contract
contract TestUnitFacet is UnitFacet {
    constructor(
        bytes memory _unitNodePublicKey,
        bytes memory _h1NodePublicKey,
        bytes memory _fieldNodePublicKey
    ) UnitFacet(_unitNodePublicKey, _h1NodePublicKey, _fieldNodePublicKey) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract UnitFacetTest is TestBaseFacet {
    UnitFacet.UnitData internal validUnitData;
    TestUnitFacet internal unitFacet;
    bytes internal unitNodePublicKey = hex"04dc6f89f921dc816aa69b687be1fcc3cc1d48912629abc2c9964e807422e1047e0435cb5ba0fa53cb9a57a9c610b4e872a0a2caedda78c4f85ebafcca93524061";
    bytes internal h1NodePublicKey = hex"048633ea6ab7e40cdacf37d1340057e84bb9810de0687af78d031e9b07b65ad4ab379180ab55075f5c2ebb96dab30d2c2fab49d5635845327b6a3c27d20ba4755b";
    bytes internal fieldNodePublicKey = hex"04ae2ab20787f816ea5d13f36c4c4f7e196e29e867086f3ce818abb73077a237f841b33ada5be71b83f4af29f333dedc5411ca4016bd52ab657db2896ef374ce99";

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        unitFacet = new TestUnitFacet(unitNodePublicKey, h1NodePublicKey, fieldNodePublicKey);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = unitFacet.startBridgeTokensViaUnit.selector;
        functionSelectors[1] = unitFacet
            .swapAndStartBridgeTokensViaUnit
            .selector;
        functionSelectors[2] = unitFacet.addDex.selector;
        functionSelectors[3] = unitFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(unitFacet), functionSelectors);
        unitFacet = TestUnitFacet(address(diamond));
        unitFacet.addDex(ADDRESS_UNISWAP);
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(unitFacet), "UnitFacet");

        // adjust bridgeData
        bridgeData.bridge = "unit";
        bridgeData.destinationChainId = 999;
        bridgeData.sendingAssetId = LibAsset.NULL_ADDRESS;
        bridgeData.minAmount = 0.005 ether; // minimum amount is 0.05 ETH (5e16 wei) mentioned in https://docs.hyperunit.xyz/developers/api/generate-address

        // deposit address generated with GET request to https://api.hyperunit.xyz/gen/ethereum/hyperliquid/eth/0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62
        // produce valid UnitData

        bytes memory mergedSignatures = hex"5c6dd328102e0a33f1d71c97dd8c2cd9629447424e695e624a466555f79c89bad61cff5adc77c05ab887717351407d9b2807d3d1c6f093902996217199a797bd26dd64c005f124ec41d66a1759460121d277adcf7494ce333aea0a8172a950d34cc20a8ce919a8c483abffb43aaa10ccb75f649520423e46226acf0e95e3155a6b559ebd23c0681a7de9acaace2ad2ce823aa0c662225d088988170fa4a3c41ded33c1ca4e604e09698ea3fa668651bb4d07b2344d8e4cd860b85fa389";
        validUnitData = UnitFacet.UnitData({
            depositAddress: address(0xCE50D8e79e047534627B3Bc38DE747426Ec63927),
            signatures: mergedSignatures
        });
    }

    // All facet test files inherit from `utils/TestBaseFacet.sol` and require the following method overrides:
    // - function initiateBridgeTxWithFacet(bool isNative)
    // - function initiateSwapAndBridgeTxWithFacet(bool isNative)
    //
    // These methods are used to run the following tests which must pass:
    // - testBase_CanBridgeNativeTokens()
    // - testBase_CanBridgeTokens()
    // - testBase_CanBridgeTokens_fuzzed(uint256)
    // - testBase_CanSwapAndBridgeNativeTokens()
    // - testBase_CanSwapAndBridgeTokens()
    // - testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress()
    // - testBase_Revert_BridgeToSameChainId()
    // - testBase_Revert_BridgeWithInvalidAmount()
    // - testBase_Revert_BridgeWithInvalidDestinationCallFlag()
    // - testBase_Revert_BridgeWithInvalidReceiverAddress()
    // - testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag()
    // - testBase_Revert_CallerHasInsufficientFunds()
    // - testBase_Revert_SwapAndBridgeToSameChainId()
    // - testBase_Revert_SwapAndBridgeWithInvalidAmount()
    // - testBase_Revert_SwapAndBridgeWithInvalidSwapData()
    // 
    // In some cases it doesn't make sense to have all tests. For example the bridge may not support native tokens.
    // In that case you can override the test method and leave it empty. For example:
    // 
    // function testBase_CanBridgeNativeTokens() public override {
    //     // facet does not support bridging of native assets
    // }
    // 
    // function testBase_CanSwapAndBridgeNativeTokens() public override {
    //     // facet does not support bridging of native assets
    // }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            unitFacet.startBridgeTokensViaUnit{
                value: bridgeData.minAmount
            }(bridgeData, validUnitData);
        } else {
            unitFacet.startBridgeTokensViaUnit(
                bridgeData,
                validUnitData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            unitFacet.swapAndStartBridgeTokensViaUnit{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validUnitData);
        } else {
            unitFacet.swapAndStartBridgeTokensViaUnit(
                bridgeData,
                swapData,
                validUnitData
            );
        }
    }

    function test_CanDepositNativeTokens() public {
        initiateBridgeTxWithFacet(true);
    }
    
}
