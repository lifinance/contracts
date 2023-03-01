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

contract mockTxToL1 {
    function sendTxToL1(address _destination, bytes calldata _callDataForL1)
        external
        returns (uint256)
    {
        console.log("sendTxToL1 called");
        return 1;
    }
}

contract MakerTeleportFacetTest is TestBaseFacet {
    // These values are for Arbitrum
    address internal constant MAKER_TELEPORT =
        0x5dBaf6F2bEDebd414F8d78d13499222347e59D5E;
    uint256 internal constant DST_CHAIN_ID = 1;
    bytes32 internal constant L1_DOMAIN = "ETH-MAIN-A";

    // -----
    TestMakerTeleportFacet internal makerTeleportFacet;

    function setUp() public {
        customBlockNumberForForking = 58467500;
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";

        ADDRESS_UNISWAP = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
        ADDRESS_USDC = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
        ADDRESS_DAI = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
        ADDRESS_WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

        initTestBase();

        makerTeleportFacet = new TestMakerTeleportFacet(
            IMakerTeleport(MAKER_TELEPORT),
            ADDRESS_DAI,
            DST_CHAIN_ID,
            L1_DOMAIN
        );
        dai = ERC20(ADDRESS_DAI);

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = makerTeleportFacet
            .startBridgeTokensViaMakerTeleport
            .selector;
        functionSelectors[1] = makerTeleportFacet
            .swapAndStartBridgeTokensViaMakerTeleport
            .selector;
        functionSelectors[2] = makerTeleportFacet.addDex.selector;
        functionSelectors[3] = makerTeleportFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(makerTeleportFacet), functionSelectors);
        makerTeleportFacet = TestMakerTeleportFacet(address(diamond));
        makerTeleportFacet.addDex(ADDRESS_UNISWAP);
        makerTeleportFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        makerTeleportFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        makerTeleportFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(makerTeleportFacet),
            "MakerTeleportFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "maker";
        bridgeData.sendingAssetId = ADDRESS_DAI;
        bridgeData.minAmount = defaultDAIAmount;
        bridgeData.destinationChainId = DST_CHAIN_ID;

        // deploy mockTxToL1
        mockTxToL1 mockTxToL1Contract = new mockTxToL1();
        bytes memory code = address(mockTxToL1Contract).code;
        vm.etch(0x0000000000000000000000000000000000000064, code);
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            makerTeleportFacet.startBridgeTokensViaMakerTeleport{
                value: bridgeData.minAmount
            }(bridgeData);
        } else {
            makerTeleportFacet.startBridgeTokensViaMakerTeleport(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative)
        internal
        override
    {
        if (isNative) {
            makerTeleportFacet.swapAndStartBridgeTokensViaMakerTeleport{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            makerTeleportFacet.swapAndStartBridgeTokensViaMakerTeleport(
                bridgeData,
                swapData
            );
        }
    }

    // ToDo Fix issue
    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(defaultDAIAmount)
        )
    {
        vm.startPrank(USER_SENDER);

        // approval
        dai.approve(address(makerTeleportFacet), bridgeData.minAmount);

        //prepare check for events
        // vm.expectEmit(true, true, true, true, address(makerTeleportFacet));
        // emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // ToDo Fix issue
    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {}

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }
}
