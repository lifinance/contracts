// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { ServiceFeeCollector } from "lifi/Periphery/ServiceFeeCollector.sol";
import { GetGasFacet } from "lifi/Facets/GetGasFacet.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";

// Stub GetGasFacet Contract
contract TestGetGasFacet is GetGasFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GetGasFacetTest is TestBaseFacet {

    TestGetGasFacet internal getGasFacet;
    ILiFi.BridgeData internal validBridgeData;

    function setUp() public {
        initTestBase();
        getGasFacet = new TestGetGasFacet();

        ServiceFeeCollector feeCollector = new ServiceFeeCollector(address(this));
        PeripheryRegistryFacet peripheryRegistry = new PeripheryRegistryFacet();

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = getGasFacet
            .startBridgeTokensViaGetGas
            .selector;
        functionSelectors[1] = getGasFacet
            .swapAndStartBridgeTokensViaGetGas
            .selector;
        functionSelectors[2] = getGasFacet.addDex.selector;
        functionSelectors[3] = getGasFacet
            .setFunctionApprovalBySignature
            .selector;

        bytes4[] memory peripheryRegistryFunctionSelectors = new bytes4[](1);
        peripheryRegistryFunctionSelectors[0] = peripheryRegistry
            .registerPeripheryContract
            .selector;

        addFacet(diamond, address(getGasFacet), functionSelectors);
        addFacet(diamond, address(peripheryRegistry), peripheryRegistryFunctionSelectors);
        
        getGasFacet = TestGetGasFacet(address(diamond));
        peripheryRegistry = PeripheryRegistryFacet(address(diamond));

        getGasFacet.addDex(address(uniswap));
        getGasFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        getGasFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );


        peripheryRegistry.registerPeripheryContract("ServiceFeeCollector", address(feeCollector));
        setFacetAddressInTestBase(address(getGasFacet), "GetGasFacet");

        vm.makePersistent(address(getGasFacet));
        vm.makePersistent(address(peripheryRegistry));

        // adjust bridgeData
        bridgeData.bridge = "getGas";
        bridgeData.destinationChainId = 100;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            getGasFacet.startBridgeTokensViaGetGas{
                value: bridgeData.minAmount
            }(bridgeData);
        } else {
            getGasFacet.startBridgeTokensViaGetGas(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative)
        internal
        override
    {
        if (isNative) {
            getGasFacet.swapAndStartBridgeTokensViaGetGas{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            getGasFacet.swapAndStartBridgeTokensViaGetGas(
                bridgeData,
                swapData
            );
        }
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag()
    public
    override
    {
        console.log("Not applicable for GetGasFacet");
    }

}
