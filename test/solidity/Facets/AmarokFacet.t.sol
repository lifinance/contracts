// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";
import { IConnextHandler } from "lifi/Interfaces/IConnextHandler.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount, InformationMismatch } from "src/Errors/GenericErrors.sol";

// Stub AmarokFacet Contract
contract TestAmarokFacet is AmarokFacet {
    constructor(
        IConnextHandler _connextHandler
    ) AmarokFacet(_connextHandler) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract AmarokFacetTest is TestBaseFacet {
    address internal constant CONNEXT_HANDLER =
        0x8898B472C54c31894e3B9bb83cEA802a5d0e63C6;
    uint32 internal constant DSTCHAIN_DOMAIN_GOERLI = 1735356532;
    uint32 internal constant DSTCHAIN_DOMAIN_POLYGON = 1886350457;
    // -----

    TestAmarokFacet internal amarokFacet;
    AmarokFacet.AmarokData internal amarokData;

    function setUp() public {
        // set custom block no for mainnet forking
        customBlockNumberForForking = 17484106;

        initTestBase();

        amarokFacet = new TestAmarokFacet(IConnextHandler(CONNEXT_HANDLER));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = amarokFacet.startBridgeTokensViaAmarok.selector;
        functionSelectors[1] = amarokFacet
            .swapAndStartBridgeTokensViaAmarok
            .selector;
        functionSelectors[2] = amarokFacet.addDex.selector;
        functionSelectors[3] = amarokFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(amarokFacet), functionSelectors);
        amarokFacet = TestAmarokFacet(address(diamond));
        amarokFacet.addDex(address(uniswap));
        amarokFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        amarokFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(amarokFacet), "AmarokFacet");

        // label addresses for better call traces
        vm.label(CONNEXT_HANDLER, "CONNEXT_HANDLER");

        // adjust bridgeData
        bridgeData.bridge = "amarok";
        bridgeData.destinationChainId = 137;

        // produce valid AmarokData
        address delegate = address(0x0BAEE5700179d87FabAd13022447Bd4E160374DD);
        amarokData = AmarokFacet.AmarokData({
            callTo: USER_RECEIVER,
            callData: "",
            relayerFee: 0,
            slippageTol: 955,
            delegate: delegate,
            destChainDomainId: DSTCHAIN_DOMAIN_POLYGON,
            payFeeWithSendingAsset: false
        });

        // make sure relayerFee is sent with every transaction
        addToMessageValue = 1 * 10 ** 15;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            amarokFacet.startBridgeTokensViaAmarok{
                value: bridgeData.minAmount
            }(bridgeData, amarokData);
        } else {
            amarokFacet.startBridgeTokensViaAmarok(bridgeData, amarokData);
        }
    }

    function test_CanBridgeAndPayFeeWithBridgedToken() public {
        amarokData.relayerFee = 1 * 10 ** usdc.decimals();
        amarokData.payFeeWithSendingAsset = true;
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);

        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_revert_ReceiverAddressesDontMatchWhenNoDestCall() public {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //
        bridgeData.hasDestinationCall = false;
        bridgeData.receiver = USER_REFUND;

        vm.expectRevert(InformationMismatch.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            amarokFacet.swapAndStartBridgeTokensViaAmarok{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, amarokData);
        } else {
            amarokFacet.swapAndStartBridgeTokensViaAmarok(
                bridgeData,
                swapData,
                amarokData
            );
        }
    }

    function test_CanSwapAndBridgeAndPayFeeWithBridgedToken() public {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        amarokData.relayerFee = 1 * 10 ** usdc.decimals();
        amarokData.payFeeWithSendingAsset = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }
}
