// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

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

contract HopFacetOptimizedL2Test is TestBaseFacet {
    // These values are for Mainnet
    address internal constant USDC_BRIDGE =
        0x76b22b8C1079A44F1211D867D68b1eda76a635A7;
    address internal constant DAI_BRIDGE =
        0x28529fec439cfF6d7D1D5917e956dEE62Cd3BE5c;
    address internal constant NATIVE_BRIDGE =
        0x884d1Aa15F9957E1aEAA86a82a72e49Bc2bfCbe3;
    uint256 internal constant DSTCHAIN_ID = 1;
    // -----

    TestHopFacet internal hopFacet;
    ILiFi.BridgeData internal validBridgeData;
    HopFacetOptimized.HopData internal validHopData;

    function setUp() public {
        // Custom Config
        customRpcUrlForForking = vm.envString("ETH_NODE_URI_POLYGON");
        customBlockNumberForForking = 38461246;
        ADDRESS_USDC = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
        ADDRESS_DAI = 0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063;
        ADDRESS_WETH = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
        ADDRESS_UNISWAP = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;

        initTestBase();
        hopFacet = new TestHopFacet();
        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = hopFacet
            .startBridgeTokensViaHopL2ERC20
            .selector;
        functionSelectors[1] = hopFacet
            .startBridgeTokensViaHopL2Native
            .selector;
        functionSelectors[2] = hopFacet
            .swapAndStartBridgeTokensViaHopL2ERC20
            .selector;
        functionSelectors[3] = hopFacet
            .swapAndStartBridgeTokensViaHopL2Native
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
        bridgeData.destinationChainId = 1;

        // produce valid HopData
        validHopData = HopFacetOptimized.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20,
            hopBridge: IHopBridge(NATIVE_BRIDGE)
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        validHopData.bonderFee = (bridgeData.minAmount * 1) / 100;
        if (isNative) {
            hopFacet.startBridgeTokensViaHopL2Native{
                value: bridgeData.minAmount
            }(bridgeData, validHopData);
        } else {
            validHopData.hopBridge = IHopBridge(USDC_BRIDGE);
            hopFacet.startBridgeTokensViaHopL2ERC20(bridgeData, validHopData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative)
        internal
        override
    {
        validHopData.bonderFee = (bridgeData.minAmount * 1) / 100;
        if (isNative || bridgeData.sendingAssetId == address(0)) {
            validHopData.hopBridge = IHopBridge(NATIVE_BRIDGE);
            hopFacet.swapAndStartBridgeTokensViaHopL2Native{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validHopData);
        } else {
            validHopData.hopBridge = IHopBridge(USDC_BRIDGE);
            hopFacet.swapAndStartBridgeTokensViaHopL2ERC20(
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
        validHopData.bonderFee = (bridgeData.minAmount * 1) / 100;
        validHopData.amountOutMin = 999999;
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
        hopFacet.swapAndStartBridgeTokensViaHopL2ERC20{
            value: swapData[0].fromAmount
        }(bridgeData, swapData, validHopData);
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag()
        public
        override
    {
        console.log("Not applicable for HopFacetOptimized");
    }

    function testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag()
        public
        override
    {
        console.log("Not applicable for HopFacetOptimized");
    }
}
