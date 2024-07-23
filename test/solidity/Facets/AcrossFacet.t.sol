// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";
import { IAcrossSpokePool } from "lifi/Interfaces/IAcrossSpokePool.sol";

// Stub AcrossFacet Contract
contract TestAcrossFacet is AcrossFacet {
    address internal constant ADDRESS_WRAPPED_NATIVE =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    constructor(
        IAcrossSpokePool _spokePool
    ) AcrossFacet(_spokePool, ADDRESS_WRAPPED_NATIVE) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract AcrossFacetTest is TestBaseFacet {
    address internal constant ETH_HOLDER =
        0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511;
    address internal constant WETH_HOLDER =
        0xD022510A3414f255150Aa54b2e42DB6129a20d9E;
    address internal constant SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    // -----
    AcrossFacet.AcrossData internal validAcrossData;
    TestAcrossFacet internal acrossFacet;

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        acrossFacet = new TestAcrossFacet(IAcrossSpokePool(SPOKE_POOL));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = acrossFacet.startBridgeTokensViaAcross.selector;
        functionSelectors[1] = acrossFacet
            .swapAndStartBridgeTokensViaAcross
            .selector;
        functionSelectors[2] = acrossFacet.addDex.selector;
        functionSelectors[3] = acrossFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(acrossFacet), functionSelectors);
        acrossFacet = TestAcrossFacet(address(diamond));
        acrossFacet.addDex(ADDRESS_UNISWAP);
        acrossFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        acrossFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        acrossFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(acrossFacet), "AcrossFacet");

        // adjust bridgeData
        bridgeData.bridge = "across";
        bridgeData.destinationChainId = 137;

        // produce valid AcrossData
        validAcrossData = AcrossFacet.AcrossData({
            relayerFeePct: 0,
            quoteTimestamp: uint32(block.timestamp),
            message: "",
            maxCount: type(uint256).max
        });

        vm.label(SPOKE_POOL, "SpokePool");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            acrossFacet.startBridgeTokensViaAcross{
                value: bridgeData.minAmount
            }(bridgeData, validAcrossData);
        } else {
            acrossFacet.startBridgeTokensViaAcross(
                bridgeData,
                validAcrossData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            acrossFacet.swapAndStartBridgeTokensViaAcross{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validAcrossData);
        } else {
            acrossFacet.swapAndStartBridgeTokensViaAcross(
                bridgeData,
                swapData,
                validAcrossData
            );
        }
    }

    function testFailsToBridgeERC20TokensDueToQuoteTimeout() public {
        console.logBytes4(IAcrossSpokePool.deposit.selector);
        vm.startPrank(WETH_HOLDER);
        ERC20 weth = ERC20(ADDRESS_WRAPPED_NATIVE);
        weth.approve(address(acrossFacet), 10_000 * 10 ** weth.decimals());

        AcrossFacet.AcrossData memory data = AcrossFacet.AcrossData(
            0, // Relayer fee
            uint32(block.timestamp + 20 minutes),
            "",
            type(uint256).max
        );
        acrossFacet.startBridgeTokensViaAcross(bridgeData, data);
        vm.stopPrank();
    }
}
