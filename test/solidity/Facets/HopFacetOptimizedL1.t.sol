// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { IHopBridge } from "lifi/Interfaces/IHopBridge.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub HopFacet Contract
contract TestHopFacet is HopFacetOptimized {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HopFacetOptimizedL1Test is TestBaseFacet {
    // These values are for Mainnet
    address internal constant USDC_BRIDGE =
        0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant DAI_BRIDGE =
        0x3d4Cc8A61c7528Fd86C55cfe061a78dCBA48EDd1;
    address internal constant NATIVE_BRIDGE =
        0xb8901acB165ed027E32754E0FFe830802919727f;
    uint256 internal constant DSTCHAIN_ID = 137;
    // -----

    TestHopFacet internal hopFacet;
    ILiFi.BridgeData internal validBridgeData;
    HopFacetOptimized.HopData internal validHopData;

    function setUp() public {
        initTestBase();
        hopFacet = new TestHopFacet();
        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = hopFacet
            .startBridgeTokensViaHopL1ERC20
            .selector;
        functionSelectors[1] = hopFacet
            .startBridgeTokensViaHopL1Native
            .selector;
        functionSelectors[2] = hopFacet
            .swapAndStartBridgeTokensViaHopL1ERC20
            .selector;
        functionSelectors[3] = hopFacet
            .swapAndStartBridgeTokensViaHopL1Native
            .selector;
        functionSelectors[4] = hopFacet.setApprovalForBridges.selector;
        functionSelectors[5] = hopFacet.addDex.selector;
        functionSelectors[6] = hopFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(hopFacet), functionSelectors);

        hopFacet = TestHopFacet(address(diamond));

        hopFacet.addDex(address(uniswap));
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapExactETHForTokens.selector
        );
        setFacetAddressInTestBase(address(hopFacet), "HopFacet");

        // Set approval for all bridges
        address[] memory bridges = new address[](2);
        bridges[0] = USDC_BRIDGE;
        bridges[1] = DAI_BRIDGE;
        address[] memory tokens = new address[](2);
        tokens[0] = ADDRESS_USDC;
        tokens[1] = ADDRESS_DAI;
        hopFacet.setApprovalForBridges(bridges, tokens);

        vm.makePersistent(address(hopFacet));

        // adjust bridgeData
        bridgeData.bridge = "hop";
        bridgeData.destinationChainId = 137;

        // produce valid HopData
        validHopData = HopFacetOptimized.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20,
            hopBridge: IHopBridge(NATIVE_BRIDGE),
            relayer: address(0),
            relayerFee: 0,
            nativeFee: 0
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            hopFacet.startBridgeTokensViaHopL1Native{
                value: bridgeData.minAmount
            }(bridgeData, validHopData);
        } else {
            validHopData.hopBridge = IHopBridge(USDC_BRIDGE);
            hopFacet.startBridgeTokensViaHopL1ERC20(bridgeData, validHopData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative || bridgeData.sendingAssetId == address(0)) {
            validHopData.hopBridge = IHopBridge(NATIVE_BRIDGE);
            hopFacet.swapAndStartBridgeTokensViaHopL1Native{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validHopData);
        } else {
            validHopData.hopBridge = IHopBridge(USDC_BRIDGE);
            hopFacet.swapAndStartBridgeTokensViaHopL1ERC20(
                bridgeData,
                swapData,
                validHopData
            );
        }
    }

    function testCanSwapNativeAndBridgeTokens() public {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleETHtoUSDC();

        // update HopData
        validHopData.amountOutMin = defaultUSDCAmount;
        validHopData.hopBridge = IHopBridge(USDC_BRIDGE);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            address(0),
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        hopFacet.swapAndStartBridgeTokensViaHopL1ERC20{
            value: swapData[0].fromAmount
        }(bridgeData, swapData, validHopData);
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag()
        public
        view
        override
    {
        console.log("Not applicable for HopFacetOptimized");
    }

    function testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag()
        public
        view
        override
    {
        console.log("Not applicable for HopFacetOptimized");
    }

    function testBase_Revert_BridgeWithInvalidAmount()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.minAmount = 0;

        // OptimizedFacet does have less checks, therefore tx fails at different point in code
        vm.expectRevert("L1_BRG: Must transfer a non-zero amount");

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeWithInvalidAmount()
        public
        virtual
        override
    {
        // OptimizedFacet does have less checks, therefore it is possible to send a tx with minAmount == 0
    }

    function testBase_Revert_BridgeToSameChainId() public virtual override {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.destinationChainId = block.chainid;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // OptimizedFacet does have less checks, therefore tx fails at different point in code
        vm.expectRevert("L1_BRG: chainId not supported");

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeToSameChainId()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.destinationChainId = block.chainid;
        bridgeData.hasSourceSwaps = true;

        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // OptimizedFacet does have less checks, therefore tx fails at different point in code
        vm.expectRevert("L1_BRG: chainId not supported");

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress()
        public
        virtual
        override
    {
        // OptimizedFacet does have less checks, therefore it is possible to send a tx with invalid receiver address
    }

    function testBase_Revert_BridgeWithInvalidReceiverAddress()
        public
        virtual
        override
    {
        // OptimizedFacet does have less checks, therefore it is possible to send a tx with invalid receiver address
    }

    function testBase_Revert_CallerHasInsufficientFunds()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(_facetTestContractAddress), defaultUSDCAmount);

        // send all available USDC balance to different account to ensure sending wallet has no USDC funds
        usdc.transfer(USER_RECEIVER, usdc.balanceOf(USER_SENDER));

        // OptimizedFacet does have less checks, therefore tx fails at different point in code
        vm.expectRevert("ERC20: transfer amount exceeds balance");

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }
}
