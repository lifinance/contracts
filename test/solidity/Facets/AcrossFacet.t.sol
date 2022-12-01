// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBase, console, InvalidAmount, ERC20 } from "../utils/TestBase.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";
import { IAcrossSpokePool } from "lifi/Interfaces/IAcrossSpokePool.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized } from "src/Errors/GenericErrors.sol";

// import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub CBridgeFacet Contract
contract TestAcrossFacet is AcrossFacet {
    address internal constant ADDRESS_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    constructor(IAcrossSpokePool _spokePool) AcrossFacet(_spokePool, ADDRESS_WETH) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract AcrossFacetTest is TestBase {
    // These values are for Optimism_Kovan
    address internal constant ETH_HOLDER = 0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511;
    address internal constant WETH_HOLDER = 0xD022510A3414f255150Aa54b2e42DB6129a20d9E;
    address internal constant SPOKE_POOL = 0x4D9079Bb4165aeb4084c526a32695dCfd2F77381;
    // -----
    AcrossFacet.AcrossData internal validAcrossData;
    TestAcrossFacet internal acrossFacet;

    function setUp() public {
        initTestBase();

        acrossFacet = new TestAcrossFacet(IAcrossSpokePool(SPOKE_POOL));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = acrossFacet.startBridgeTokensViaAcross.selector;
        functionSelectors[1] = acrossFacet.swapAndStartBridgeTokensViaAcross.selector;
        functionSelectors[2] = acrossFacet.addDex.selector;
        functionSelectors[3] = acrossFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(acrossFacet), functionSelectors);
        acrossFacet = TestAcrossFacet(address(diamond));
        acrossFacet.addDex(ADDRESS_UNISWAP);
        acrossFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        acrossFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);
        acrossFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        setFacetAddressInTestBase(address(acrossFacet));

        // adjust bridgeData
        bridgeData.bridge = "across";
        bridgeData.destinationChainId = 137;

        // produce valid AcrossData
        validAcrossData = AcrossFacet.AcrossData({ relayerFeePct: 0, quoteTimestamp: uint32(block.timestamp) });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            acrossFacet.startBridgeTokensViaAcross{ value: bridgeData.minAmount }(bridgeData, validAcrossData);
        } else {
            acrossFacet.startBridgeTokensViaAcross(bridgeData, validAcrossData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            acrossFacet.swapAndStartBridgeTokensViaAcross{ value: swapData[0].fromAmount }(
                bridgeData,
                swapData,
                validAcrossData
            );
        } else {
            acrossFacet.swapAndStartBridgeTokensViaAcross(bridgeData, swapData, validAcrossData);
        }
    }

    function testFailsToBridgeERC20TokensDueToQuoteTimeout() public {
        vm.startPrank(WETH_HOLDER);
        ERC20 weth = ERC20(ADDRESS_WETH);
        weth.approve(address(acrossFacet), 10_000 * 10**weth.decimals());

        AcrossFacet.AcrossData memory data = AcrossFacet.AcrossData(
            0, // Relayer fee
            uint32(block.timestamp + 20 minutes)
        );
        acrossFacet.startBridgeTokensViaAcross(bridgeData, data);
        vm.stopPrank();
    }
}
