// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { MakerTeleportFacet } from "lifi/Facets/MakerTeleportFacet.sol";
import { IMakerTeleport } from "lifi/Interfaces/IMakerTeleport.sol";

// Stub MakerTeleportFacet Contract
contract TestMakerTeleportFacet is MakerTeleportFacet {
    constructor(
        IMakerTeleport _makerTeleport,
        address _dai,
        uint256 _dstChainId,
        bytes32 _l1Domain
    ) MakerTeleportFacet(_makerTeleport, _dai, _dstChainId, _l1Domain) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract MakerTeleportFacetTest is TestBaseFacet {
    // These values are for Optimism
    address internal constant DAI_ADDRESS = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address internal constant DAI_HOLDER = 0x7B7B957c284C2C227C980d6E2F804311947b84d0;
    address internal constant MAKER_TELEPORT = 0x18d2CF2296c5b29343755E6B7e37679818913f88;
    uint256 internal constant DST_CHAIN_ID = 1;
    bytes32 internal constant L1_DOMAIN = "ETH-MAIN-A";

    // -----
    TestMakerTeleportFacet internal makerTeleportFacet;

    function setUp() public {
        customBlockNumberForForking = 71299000;
        customRpcUrlForForking = "ETH_NODE_URI_OPTIMISM";

        initTestBase();

        makerTeleportFacet = new TestMakerTeleportFacet(
            IMakerTeleport(MAKER_TELEPORT),
            DAI_ADDRESS,
            DST_CHAIN_ID,
            L1_DOMAIN
        );
        dai = ERC20(DAI_ADDRESS);

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = makerTeleportFacet.startBridgeTokensViaMakerTeleport.selector;
        functionSelectors[1] = makerTeleportFacet.swapAndStartBridgeTokensViaMakerTeleport.selector;
        functionSelectors[2] = makerTeleportFacet.addDex.selector;
        functionSelectors[3] = makerTeleportFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(makerTeleportFacet), functionSelectors);
        makerTeleportFacet = TestMakerTeleportFacet(address(diamond));
        makerTeleportFacet.addDex(ADDRESS_UNISWAP);
        makerTeleportFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        makerTeleportFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);
        makerTeleportFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        setFacetAddressInTestBase(address(makerTeleportFacet), "MakerTeleportFacet");

        // adjust bridgeData
        bridgeData.bridge = "maker";
        bridgeData.sendingAssetId = DAI_ADDRESS;
        bridgeData.minAmount = defaultDAIAmount;
        bridgeData.destinationChainId = DST_CHAIN_ID;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            makerTeleportFacet.startBridgeTokensViaMakerTeleport{ value: bridgeData.minAmount }(bridgeData);
        } else {
            makerTeleportFacet.startBridgeTokensViaMakerTeleport(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            makerTeleportFacet.swapAndStartBridgeTokensViaMakerTeleport{ value: swapData[0].fromAmount }(
                bridgeData,
                swapData
            );
        } else {
            makerTeleportFacet.swapAndStartBridgeTokensViaMakerTeleport(bridgeData, swapData);
        }
    }

    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(DAI_ADDRESS, DAI_HOLDER, -int256(defaultDAIAmount))
    {
        vm.startPrank(DAI_HOLDER);

        // approval
        dai.approve(address(makerTeleportFacet), bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(makerTeleportFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }
}
