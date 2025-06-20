// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { PioneerFacet } from "lifi/Facets/PioneerFacet.sol";

// Stub PioneerFacet Contract
contract TestPioneerFacet is PioneerFacet {
    constructor(address payable destination) PioneerFacet(destination) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract PioneerFacetTest is TestBaseFacet {
    TestPioneerFacet internal basePioneerFacet;
    TestPioneerFacet internal pioneerFacet;

    address payable internal destination;

    PioneerFacet.PioneerData internal pioneerData;

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        destination = payable(address(uint160(uint256(keccak256("Pioneer")))));

        basePioneerFacet = new TestPioneerFacet(destination);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = basePioneerFacet
            .startBridgeTokensViaPioneer
            .selector;
        functionSelectors[1] = basePioneerFacet
            .swapAndStartBridgeTokensViaPioneer
            .selector;
        functionSelectors[2] = basePioneerFacet.addDex.selector;
        functionSelectors[3] = basePioneerFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(basePioneerFacet), functionSelectors);
        pioneerFacet = TestPioneerFacet(address(diamond));
        pioneerFacet.addDex(ADDRESS_UNISWAP);
        pioneerFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        pioneerFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        pioneerFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(pioneerFacet), "PioneerFacet");

        // adjust bridgeData
        bridgeData.bridge = "pioneer";
        bridgeData.destinationChainId = 137;

        // Set a refund address.
        pioneerData.refundAddress = payable(address(0xdeaddeadff77));
    }

    function test_transfer_to_pioneer() external {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(basePioneerFacet), bridgeData.minAmount);

        basePioneerFacet.startBridgeTokensViaPioneer(bridgeData, pioneerData);

        assertEq(
            IERC20(bridgeData.sendingAssetId).balanceOf(destination),
            bridgeData.minAmount
        );
    }

    function test_native_transfer_to_pioneer() external {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = address(0);

        basePioneerFacet.startBridgeTokensViaPioneer{
            value: bridgeData.minAmount
        }(bridgeData, pioneerData);

        assertEq(destination.balance, bridgeData.minAmount);
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            pioneerFacet.startBridgeTokensViaPioneer{
                value: bridgeData.minAmount
            }(bridgeData, pioneerData);
        } else {
            pioneerFacet.startBridgeTokensViaPioneer(bridgeData, pioneerData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            pioneerFacet.swapAndStartBridgeTokensViaPioneer{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, pioneerData);
        } else {
            pioneerFacet.swapAndStartBridgeTokensViaPioneer(
                bridgeData,
                swapData,
                pioneerData
            );
        }
    }
}
