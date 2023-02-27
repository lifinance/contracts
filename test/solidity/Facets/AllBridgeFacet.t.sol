// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { AllBridgeFacet, IAllBridge, MessengerProtocol } from "lifi/Facets/AllBridgeFacet.sol";
import { TestBase } from "../utils/TestBase.sol";

// Stub AllBridgeFacet Contract
contract TestAllBridgeFacet is AllBridgeFacet {
    constructor(IAllBridge _allBridge) AllBridgeFacet(_allBridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract AllBridgeFacetTest is TestBaseFacet {
    address internal constant BRIDGE_ADDRESS =
        0xA314330482f325D38A83B492EF6B006224a3bea9;
    address internal constant ALLBRIDGE_POOL =
        0x1D3df13aDAe6cA91Fb90b977c21d6e90ad8d403C;
    // -----
    AllBridgeFacet.AllBridgeData internal validAllBridgeData;
    TestAllBridgeFacet internal allBridgeFacet;

    function setUp() public {
        customBlockNumberForForking = 16661275;
        initTestBase();

        allBridgeFacet = new TestAllBridgeFacet(IAllBridge(BRIDGE_ADDRESS));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = allBridgeFacet
            .startBridgeTokensViaAllBridge
            .selector;
        functionSelectors[1] = allBridgeFacet
            .swapAndStartBridgeTokensViaAllBridge
            .selector;
        functionSelectors[2] = allBridgeFacet.addDex.selector;
        functionSelectors[3] = allBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(allBridgeFacet), functionSelectors);
        allBridgeFacet = TestAllBridgeFacet(address(diamond));
        allBridgeFacet.addDex(ADDRESS_UNISWAP);
        allBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        allBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        allBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(allBridgeFacet), "AllBridgeFacet");

        // adjust bridgeData
        bridgeData.bridge = "allbridge";
        bridgeData.destinationChainId = 137;

        uint256 testPolygonMessengerFees = 69857330070000;
        uint256 testPolygonBridgeFees = 28764782970000;
        uint256 fees = testPolygonBridgeFees + testPolygonMessengerFees;
        // produce valid AllBridgeData
        validAllBridgeData = AllBridgeFacet.AllBridgeData({
            fees: fees,
            recipient: 0x00000000000000000000000012561cc3ea2a60aa158b0421010859a983bf3c96,
            destinationChainId: 5,
            receiveToken: 0x0000000000000000000000002791Bca1f2de4661ED88A30C99A7a9449Aa84174,
            nonce: 40953790744158426077674476975877556494233328003707004662889959804198145032447,
            messenger: MessengerProtocol.Allbridge
        });
        addToMessageValue = validAllBridgeData.fees;
        ERC20(ADDRESS_USDC).approve(ALLBRIDGE_POOL, type(uint256).max);
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            allBridgeFacet.startBridgeTokensViaAllBridge{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, validAllBridgeData);
        } else {
            allBridgeFacet.startBridgeTokensViaAllBridge{
                value: addToMessageValue
            }(bridgeData, validAllBridgeData);
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            allBridgeFacet.swapAndStartBridgeTokensViaAllBridge{
                value: swapData[0].fromAmount + addToMessageValue
            }(bridgeData, swapData, validAllBridgeData);
        } else {
            allBridgeFacet.swapAndStartBridgeTokensViaAllBridge{
                value: addToMessageValue
            }(bridgeData, swapData, validAllBridgeData);
        }
    }
}
