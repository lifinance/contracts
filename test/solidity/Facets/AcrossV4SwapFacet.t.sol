// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { ISpokePoolPeriphery } from "lifi/Interfaces/ISpokePoolPeriphery.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";

// Stub AcrossV4SwapFacet Contract
contract TestAcrossV4SwapFacet is AcrossV4SwapFacet, TestWhitelistManagerBase {
    constructor(
        ISpokePoolPeriphery _spokePoolPeriphery,
        address _spokePool
    ) AcrossV4SwapFacet(_spokePoolPeriphery, _spokePool) {}
}

contract AcrossV4SwapFacetTest is TestBaseFacet {
    // Mainnet addresses
    address internal constant SPOKE_POOL_PERIPHERY =
        0x649C790f02B7e04a5A2e60b6EE6e7d5B2E6B29A5;
    address internal constant SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;

    AcrossV4SwapFacet.AcrossV4SwapData internal validAcrossV4SwapData;
    TestAcrossV4SwapFacet internal acrossV4SwapFacet;

    function setUp() public {
        customBlockNumberForForking = 22989702;
        initTestBase();

        acrossV4SwapFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            SPOKE_POOL
        );

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = acrossV4SwapFacet
            .startBridgeTokensViaAcrossV4Swap
            .selector;
        functionSelectors[1] = acrossV4SwapFacet
            .swapAndStartBridgeTokensViaAcrossV4Swap
            .selector;
        functionSelectors[2] = acrossV4SwapFacet
            .addAllowedContractSelector
            .selector;

        addFacet(diamond, address(acrossV4SwapFacet), functionSelectors);
        acrossV4SwapFacet = TestAcrossV4SwapFacet(address(diamond));
        acrossV4SwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        acrossV4SwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        acrossV4SwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(acrossV4SwapFacet),
            "AcrossV4SwapFacet"
        );

        // Adjust bridgeData
        bridgeData.bridge = "acrossV4Swap";
        bridgeData.destinationChainId = 137;

        // Build valid AcrossV4SwapData
        uint32 quoteTimestamp = uint32(block.timestamp);
        validAcrossV4SwapData = AcrossV4SwapFacet.AcrossV4SwapData({
            depositData: ISpokePoolPeriphery.BaseDepositData({
                inputToken: ADDRESS_USDC,
                outputToken: _convertAddressToBytes32(ADDRESS_USDC_POL),
                outputAmount: (defaultUSDCAmount * 9) / 10,
                depositor: USER_SENDER,
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                destinationChainId: 137,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: quoteTimestamp,
                fillDeadline: uint32(quoteTimestamp + 1000),
                exclusivityParameter: 0,
                message: ""
            }),
            swapToken: ADDRESS_USDC,
            exchange: ADDRESS_UNISWAP,
            transferType: ISpokePoolPeriphery.TransferType.Approval,
            routerCalldata: "", // Would be populated with actual DEX calldata
            minExpectedInputTokenAmount: (defaultUSDCAmount * 9) / 10,
            enableProportionalAdjustment: false
        });

        vm.label(SPOKE_POOL_PERIPHERY, "SpokePoolPeriphery");
        vm.label(SPOKE_POOL, "SpokePool");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap{
                value: bridgeData.minAmount
            }(bridgeData, validAcrossV4SwapData);
        } else {
            acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
                bridgeData,
                validAcrossV4SwapData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            acrossV4SwapFacet.swapAndStartBridgeTokensViaAcrossV4Swap{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validAcrossV4SwapData);
        } else {
            acrossV4SwapFacet.swapAndStartBridgeTokensViaAcrossV4Swap(
                bridgeData,
                swapData,
                validAcrossV4SwapData
            );
        }
    }

    // Facet does not support native bridging directly (needs WETH)
    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function test_contractIsSetUpCorrectly() public {
        acrossV4SwapFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            SPOKE_POOL
        );

        assertEq(
            address(acrossV4SwapFacet.SPOKE_POOL_PERIPHERY()) ==
                SPOKE_POOL_PERIPHERY,
            true
        );
        assertEq(acrossV4SwapFacet.SPOKE_POOL() == SPOKE_POOL, true);
    }

    function testRevert_WhenConstructedWithZeroPeripheryAddress() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestAcrossV4SwapFacet(ISpokePoolPeriphery(address(0)), SPOKE_POOL);
    }

    function testRevert_WhenConstructedWithZeroSpokePoolAddress() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            address(0)
        );
    }

    /// @notice Converts an address to bytes32
    function _convertAddressToBytes32(
        address _address
    ) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_address)));
    }
}
