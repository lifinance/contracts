// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibSwap, LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { InsufficientBalance } from "src/Errors/GenericErrors.sol";
import { CircleBridgeFacet } from "lifi/Facets/CircleBridgeFacet.sol";
import { ITokenMessenger } from "lifi/Interfaces/ITokenMessenger.sol";

// import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub CircleBridgeFacet Contract
contract TestCircleBridgeFacet is CircleBridgeFacet {
    constructor(ITokenMessenger _xDaiBridge, address _usdc)
        CircleBridgeFacet(_xDaiBridge, _usdc)
    {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract CircleBridgeFacetTest is TestBaseFacet {
    // These values are for Goerli
    address internal constant TOKEN_MESSENGER =
        0xD0C3da58f55358142b8d3e06C1C30c5C6114EFE8;
    uint32 internal constant DST_DOMAIN = 1;

    TestCircleBridgeFacet internal circleBridgeFacet;
    CircleBridgeFacet.CircleBridgeData internal circleBridgeData;

    function setUp() public {
        // Custom Config
        customRpcUrlForForking = "ETH_NODE_URI_GOERLI";
        customBlockNumberForForking = 8584590;
        ADDRESS_USDC = 0x07865c6E87B9F70255377e024ace6630C1Eaa37F;
        ADDRESS_DAI = 0x65a5ba240CBd7fD75700836b683ba95EBb2F32bd;
        ADDRESS_WETH = 0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6;
        ADDRESS_UNISWAP = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;

        initTestBase();

        defaultDAIAmount = 5 * 10**dai.decimals();
        defaultUSDCAmount = 5 * 10**usdc.decimals();

        circleBridgeFacet = new TestCircleBridgeFacet(
            ITokenMessenger(TOKEN_MESSENGER),
            ADDRESS_USDC
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = circleBridgeFacet
            .startBridgeTokensViaCircleBridge
            .selector;
        functionSelectors[1] = circleBridgeFacet
            .swapAndStartBridgeTokensViaCircleBridge
            .selector;
        functionSelectors[2] = circleBridgeFacet.addDex.selector;
        functionSelectors[3] = circleBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(circleBridgeFacet), functionSelectors);

        circleBridgeFacet = TestCircleBridgeFacet(address(diamond));

        circleBridgeFacet.addDex(address(uniswap));
        circleBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        circleBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        circleBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(circleBridgeFacet),
            "CircleBridgeFacet"
        );

        bridgeData.bridge = "circle";
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.destinationChainId = 43113;

        circleBridgeData = CircleBridgeFacet.CircleBridgeData(DST_DOMAIN);
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            circleBridgeFacet.startBridgeTokensViaCircleBridge{
                value: bridgeData.minAmount
            }(bridgeData, circleBridgeData);
        } else {
            circleBridgeFacet.startBridgeTokensViaCircleBridge(
                bridgeData,
                circleBridgeData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative)
        internal
        override
    {
        if (isNative) {
            circleBridgeFacet.swapAndStartBridgeTokensViaCircleBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, circleBridgeData);
        } else {
            circleBridgeFacet.swapAndStartBridgeTokensViaCircleBridge(
                bridgeData,
                swapData,
                circleBridgeData
            );
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }
}
