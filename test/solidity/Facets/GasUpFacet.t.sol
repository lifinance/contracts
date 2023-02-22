// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { ServiceFeeCollector } from "lifi/Periphery/ServiceFeeCollector.sol";
import { GasUpFacet } from "lifi/Facets/GasUpFacet.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";

// Stub HopFacet Contract
contract TestGasUpFacet is GasUpFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GasUpFacetTest is TestBaseFacet {

    TestGasUpFacet internal gasUpFacet;
    ILiFi.BridgeData internal validBridgeData;

    function setUp() public {
        initTestBase();
        gasUpFacet = new TestGasUpFacet();

        ServiceFeeCollector feeCollector = new ServiceFeeCollector(address(this));
        PeripheryRegistryFacet peripheryRegistry = new PeripheryRegistryFacet();

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = gasUpFacet
            .startBridgeTokensViaGasUp
            .selector;
        functionSelectors[1] = gasUpFacet
            .swapAndStartBridgeTokensViaGasUp
            .selector;
        functionSelectors[2] = gasUpFacet.addDex.selector;
        functionSelectors[3] = gasUpFacet
            .setFunctionApprovalBySignature
            .selector;

        bytes4[] memory peripheryRegistryFunctionSelectors = new bytes4[](1);
        peripheryRegistryFunctionSelectors[0] = peripheryRegistry
            .registerPeripheryContract
            .selector;

        addFacet(diamond, address(gasUpFacet), functionSelectors);
        addFacet(diamond, address(peripheryRegistry), peripheryRegistryFunctionSelectors);
        
        gasUpFacet = TestGasUpFacet(address(diamond));
        peripheryRegistry = PeripheryRegistryFacet(address(diamond));

        gasUpFacet.addDex(address(uniswap));
        gasUpFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        gasUpFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        peripheryRegistry.registerPeripheryContract("SERVICE_FEE_COLLECTOR", address(feeCollector));
        setFacetAddressInTestBase(address(gasUpFacet), "GasUpFacet");

        vm.makePersistent(address(gasUpFacet));

        // adjust bridgeData
        bridgeData.bridge = "gasUp";
        bridgeData.destinationChainId = 100;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            gasUpFacet.startBridgeTokensViaGasUp{
                value: bridgeData.minAmount
            }(bridgeData);
        } else {
            gasUpFacet.startBridgeTokensViaGasUp(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative)
        internal
        override
    {
        if (isNative) {
            gasUpFacet.swapAndStartBridgeTokensViaGasUp{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            gasUpFacet.swapAndStartBridgeTokensViaGasUp(
                bridgeData,
                swapData
            );
        }
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag()
    public
    override
    {
        console.log("Not applicable for GasUpFacet");
    }

}
