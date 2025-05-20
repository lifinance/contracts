// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { DeBridgeFacet } from "lifi/Facets/DeBridgeFacet.sol";
import { IDeBridgeGate } from "lifi/Interfaces/IDeBridgeGate.sol";

// Stub DeBridgeFacet Contract
contract TestDeBridgeFacet is DeBridgeFacet {
    constructor(IDeBridgeGate _deBridgeGate) DeBridgeFacet(_deBridgeGate) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract DeBridgeFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant DEBRIDGE_GATE =
        0x43dE2d77BF8027e25dBD179B491e8d64f38398aA;
    uint256 internal constant DST_CHAIN_ID = 56;
    uint256 public constant REVERT_IF_EXTERNAL_FAIL = 1;

    TestDeBridgeFacet internal deBridgeFacet;
    DeBridgeFacet.DeBridgeData internal deBridgeData;

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            deBridgeFacet.startBridgeTokensViaDeBridge{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, deBridgeData);
        } else {
            deBridgeFacet.startBridgeTokensViaDeBridge{
                value: addToMessageValue
            }(bridgeData, deBridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            deBridgeFacet.swapAndStartBridgeTokensViaDeBridge{
                value: swapData[0].fromAmount + addToMessageValue
            }(bridgeData, swapData, deBridgeData);
        } else {
            deBridgeFacet.swapAndStartBridgeTokensViaDeBridge{
                value: addToMessageValue
            }(bridgeData, swapData, deBridgeData);
        }
    }

    function setUp() public {
        initTestBase();

        deBridgeFacet = new TestDeBridgeFacet(IDeBridgeGate(DEBRIDGE_GATE));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = deBridgeFacet
            .startBridgeTokensViaDeBridge
            .selector;
        functionSelectors[1] = deBridgeFacet
            .swapAndStartBridgeTokensViaDeBridge
            .selector;
        functionSelectors[2] = deBridgeFacet.addDex.selector;
        functionSelectors[3] = deBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(deBridgeFacet), functionSelectors);

        deBridgeFacet = TestDeBridgeFacet(address(diamond));

        deBridgeFacet.addDex(address(uniswap));
        deBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        deBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        deBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        deBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        setFacetAddressInTestBase(address(deBridgeFacet), "DeBridgeFacet");

        bridgeData.bridge = "debridge";
        bridgeData.minAmount = defaultUSDCAmount;

        IDeBridgeGate.ChainSupportInfo memory chainConfig = IDeBridgeGate(
            DEBRIDGE_GATE
        ).getChainToConfig(DST_CHAIN_ID);
        uint256 nativeFee = addToMessageValue = chainConfig.fixedNativeFee == 0
            ? IDeBridgeGate(DEBRIDGE_GATE).globalFixedNativeFee()
            : chainConfig.fixedNativeFee;
        uint256 executionFee = 1 * 10 ** usdc.decimals();

        deBridgeData = DeBridgeFacet.DeBridgeData(
            nativeFee,
            false,
            0,
            DeBridgeFacet.SubmissionAutoParamsTo(
                executionFee,
                REVERT_IF_EXTERNAL_FAIL,
                abi.encodePacked(USER_RECEIVER),
                ""
            )
        );
    }

    function test_Revert_BridgeWithInvalidAmount() public {
        vm.startPrank(USER_SENDER);

        deBridgeData.nativeFee--;

        vm.expectRevert();

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // amount should be greater than execution fee
        vm.assume(amount > 1);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }
}
