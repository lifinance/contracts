// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, InvalidAmount, ERC20 } from "../utils/TestBaseFacet.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InsufficientBalance, InvalidDestinationChain, NoSwapDataProvided } from "src/Errors/GenericErrors.sol";
import { NXTPFacet } from "lifi/Facets/NXTPFacet.sol";
import { ITransactionManager } from "lifi/Interfaces/ITransactionManager.sol";

// Stub NXTPFacet Contract
contract TestNXTPFacet is NXTPFacet {
    constructor(ITransactionManager txManager) NXTPFacet(txManager) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract NXTPFacetTest is TestBaseFacet {
    // These values are for Polygon
    address internal constant TRANSACTION_MANAGER_ETH = 0x31eFc4AeAA7c39e54A33FDc3C46ee2Bd70ae0A09;
    address internal constant TRANSACTION_MANAGER_POLYGON = 0x6090De2EC76eb1Dc3B5d632734415c93c44Fd113;
    address internal constant NXTP_WALLET = 0x997f29174a766A1DA04cf77d135d59Dd12FB54d1;
    address internal constant ROUTER_ETH = 0x8640A7769BA59e219d85802427a964068d4D99F8;
    // -----

    TestNXTPFacet internal nxtpFacet;
    NXTPFacet.NXTPData internal nxtpData;

    function setUp() public {
        initTestBase();

        diamond = createDiamond();
        nxtpFacet = new TestNXTPFacet(ITransactionManager(TRANSACTION_MANAGER_ETH));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = nxtpFacet.startBridgeTokensViaNXTP.selector;
        functionSelectors[1] = nxtpFacet.swapAndStartBridgeTokensViaNXTP.selector;
        functionSelectors[2] = nxtpFacet.addDex.selector;
        functionSelectors[3] = nxtpFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(nxtpFacet), functionSelectors);

        nxtpFacet = TestNXTPFacet(address(diamond));

        nxtpFacet.addDex(address(uniswap));
        nxtpFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        nxtpFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        nxtpFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);

        setFacetAddressInTestBase(address(nxtpFacet), "NXTPFacet");

        bridgeData.bridge = "connext";

        // prepare valid NXTP data
        ITransactionManager.InvariantTransactionData memory txData = ITransactionManager.InvariantTransactionData({
            receivingChainTxManagerAddress: TRANSACTION_MANAGER_POLYGON,
            user: USER_SENDER,
            router: ROUTER_ETH,
            initiator: address(nxtpFacet),
            sendingAssetId: ADDRESS_USDC,
            receivingAssetId: ADDRESS_USDC,
            sendingChainFallback: USER_REFUND, // funds sent here on cancel
            receivingAddress: USER_RECEIVER,
            callTo: address(0),
            sendingChainId: 1,
            receivingChainId: 137,
            callDataHash: "", // hashed to prevent free option
            transactionId: ""
        });

        nxtpData = NXTPFacet.NXTPData({
            invariantData: txData,
            expiry: block.timestamp + 2 days,
            encryptedCallData: abi.encodePacked(""),
            encodedBid: abi.encodePacked(""),
            bidSignature: abi.encodePacked(""),
            encodedMeta: abi.encodePacked("")
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            nxtpFacet.startBridgeTokensViaNXTP{ value: bridgeData.minAmount }(bridgeData, nxtpData);
        } else {
            nxtpFacet.startBridgeTokensViaNXTP(bridgeData, nxtpData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            nxtpFacet.swapAndStartBridgeTokensViaNXTP{ value: swapData[0].fromAmount }(bridgeData, swapData, nxtpData);
        } else {
            nxtpFacet.swapAndStartBridgeTokensViaNXTP(bridgeData, swapData, nxtpData);
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        nxtpData.invariantData.sendingAssetId = address(0);
        super.testBase_CanBridgeNativeTokens();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        nxtpData.invariantData.sendingAssetId = address(0);
        super.testBase_CanSwapAndBridgeNativeTokens();
    }
}
