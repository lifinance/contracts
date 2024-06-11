// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { LibAllowList, LibSwap, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { MakerTeleportFacet } from "lifi/Facets/MakerTeleportFacet.sol";
import { ITeleportGateway } from "lifi/Interfaces/ITeleportGateway.sol";
import { InsufficientBalance } from "lifi/Errors/GenericErrors.sol";

// Stub MakerTeleportFacet Contract
contract TestMakerTeleportFacet is MakerTeleportFacet {
    constructor(
        ITeleportGateway _teleportGateway,
        address _dai,
        uint256 _dstChainId,
        bytes32 _l1Domain
    ) MakerTeleportFacet(_teleportGateway, _dai, _dstChainId, _l1Domain) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract MockArbSys {
    function sendTxToL1(
        address _destination,
        bytes calldata _callDataForL1
    ) external view returns (uint256) {
        console.log("sendTxToL1 called");
        console.logAddress(_destination);
        console.logBytes(_callDataForL1);
        return 1;
    }
}

contract MakerTeleportFacetTest is TestBaseFacet {
    // These values are for Arbitrum
    address internal constant TELEPORT_GATEWAY =
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
            ITeleportGateway(TELEPORT_GATEWAY),
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

        // deploy mockArbSys
        MockArbSys mockArbSys = new MockArbSys();
        bytes memory code = address(mockArbSys).code;
        vm.etch(0x0000000000000000000000000000000000000064, code);
    }

    function setDefaultSwapData() internal {
        delete swapData;
        // Swap USDC -> DAI
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        uint256 amountOut = defaultDAIAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: ADDRESS_DAI,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    amountOut,
                    path,
                    address(makerTeleportFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        makerTeleportFacet.startBridgeTokensViaMakerTeleport(bridgeData);
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
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
        vm.expectEmit(true, true, true, true, address(makerTeleportFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        usdc.approve(
            address(makerTeleportFacet),
            10_000 * 10 ** usdc.decimals()
        );

        setDefaultSwapData();
        bridgeData.hasSourceSwaps = true;

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** dai.decimals();

        // approval
        dai.approve(address(makerTeleportFacet), amount);

        bridgeData.minAmount = amount;

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

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        vm.startPrank(USER_SENDER);

        dai.approve(address(_facetTestContractAddress), defaultUSDCAmount);

        // send all available DAI balance to different account to ensure sending wallet has no DAI funds
        dai.transfer(USER_RECEIVER, dai.balanceOf(USER_SENDER));

        vm.expectRevert(
            abi.encodeWithSelector(
                InsufficientBalance.selector,
                bridgeData.minAmount,
                0
            )
        );

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }
}
