// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { ServiceFeeCollector } from "lifi/Periphery/ServiceFeeCollector.sol";
import { LIFuelFacet } from "lifi/Facets/LIFuelFacet.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";

// Stub LIFuelFacet Contract
contract TestLIFuelFacet is LIFuelFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract LIFuelFacetTest is TestBaseFacet {
    TestLIFuelFacet internal lifuelFacet;
    ILiFi.BridgeData internal validBridgeData;

    function setUp() public {
        initTestBase();
        lifuelFacet = new TestLIFuelFacet();

        ServiceFeeCollector feeCollector = new ServiceFeeCollector(
            address(this)
        );
        PeripheryRegistryFacet peripheryRegistry = new PeripheryRegistryFacet();

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = lifuelFacet.startBridgeTokensViaLIFuel.selector;
        functionSelectors[1] = lifuelFacet
            .swapAndStartBridgeTokensViaLIFuel
            .selector;
        functionSelectors[2] = lifuelFacet.addDex.selector;
        functionSelectors[3] = lifuelFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(lifuelFacet), functionSelectors);

        lifuelFacet = TestLIFuelFacet(address(diamond));
        peripheryRegistry = PeripheryRegistryFacet(address(diamond));

        lifuelFacet.addDex(address(uniswap));
        lifuelFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        lifuelFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        peripheryRegistry.registerPeripheryContract(
            "ServiceFeeCollector",
            address(feeCollector)
        );
        setFacetAddressInTestBase(address(lifuelFacet), "LIFuelFacet");

        vm.makePersistent(address(lifuelFacet));
        vm.makePersistent(address(peripheryRegistry));

        // adjust bridgeData
        bridgeData.bridge = "lifuel";
        bridgeData.destinationChainId = 100;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            lifuelFacet.startBridgeTokensViaLIFuel{
                value: bridgeData.minAmount
            }(bridgeData);
        } else {
            lifuelFacet.startBridgeTokensViaLIFuel(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            lifuelFacet.swapAndStartBridgeTokensViaLIFuel{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            lifuelFacet.swapAndStartBridgeTokensViaLIFuel(
                bridgeData,
                swapData
            );
        }
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag()
        public
        view
        override
    {
        console.log("Not applicable for LIFuelFacet");
    }
}
