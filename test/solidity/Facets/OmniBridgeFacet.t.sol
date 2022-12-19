// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { OmniBridgeFacet } from "lifi/Facets/OmniBridgeFacet.sol";
import { IOmniBridge } from "lifi/Interfaces/IOmniBridge.sol";

// Stub OmniBridgeFacet Contract
contract TestOmniBridgeFacet is OmniBridgeFacet {
    constructor(IOmniBridge _foreignOmniBridge, IOmniBridge _wethOmniBridge)
        OmniBridgeFacet(_foreignOmniBridge, _wethOmniBridge)
    {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract OmniBridgeFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant FOREIGN_BRIDGE = 0x88ad09518695c6c3712AC10a214bE5109a655671;
    address internal constant WETH_BRIDGE = 0xa6439Ca0FCbA1d0F80df0bE6A17220feD9c9038a;

    // -----

    TestOmniBridgeFacet internal omniBridgeFacet;

    function setUp() public {
        initTestBase();

        omniBridgeFacet = new TestOmniBridgeFacet(IOmniBridge(FOREIGN_BRIDGE), IOmniBridge(WETH_BRIDGE));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = omniBridgeFacet.startBridgeTokensViaOmniBridge.selector;
        functionSelectors[1] = omniBridgeFacet.swapAndStartBridgeTokensViaOmniBridge.selector;
        functionSelectors[2] = omniBridgeFacet.addDex.selector;
        functionSelectors[3] = omniBridgeFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(omniBridgeFacet), functionSelectors);

        omniBridgeFacet = TestOmniBridgeFacet(address(diamond));

        omniBridgeFacet.addDex(address(uniswap));
        omniBridgeFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        omniBridgeFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        omniBridgeFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);

        setFacetAddressInTestBase(address(omniBridgeFacet), "OmniBridgeFacet");

        bridgeData.bridge = "omni";
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            omniBridgeFacet.startBridgeTokensViaOmniBridge{ value: bridgeData.minAmount }(bridgeData);
        } else {
            omniBridgeFacet.startBridgeTokensViaOmniBridge(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            omniBridgeFacet.swapAndStartBridgeTokensViaOmniBridge{ value: swapData[0].fromAmount }(
                bridgeData,
                swapData
            );
        } else {
            omniBridgeFacet.swapAndStartBridgeTokensViaOmniBridge(bridgeData, swapData);
        }
    }
}
