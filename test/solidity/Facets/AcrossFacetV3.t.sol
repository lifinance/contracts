// WORKING depositV3 (not mine):
// https://etherscan.io/tx/0xa9f617b3f59fe37259eb2e4e2eb1a19469f097f9d498477c0dc0d06655ae31d7

// Parameters
//   "0xdBC0Ac7F3eD888001C035Ad4033833974FDaBEF7",
//   "0xdBC0Ac7F3eD888001C035Ad4033833974FDaBEF7",
//   "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
//   "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
//   "100000000000",
//   "99988986958",
//   "42161",
//   "0x0000000000000000000000000000000000000000",
//   "1717991015",
//   "1718012856",
//   "0",
//   "0x"

// waiting for response here
// https://github.com/foundry-rs/foundry/issues/4988

// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { AcrossFacetV3 } from "lifi/Facets/AcrossFacetV3.sol";
import { IAcrossSpokePool } from "lifi/Interfaces/IAcrossSpokePool.sol";
import { LibUtil } from "lifi/libraries/LibUtil.sol";

// Stub AcrossFacetV3 Contract
contract TestAcrossFacetV3 is AcrossFacetV3 {
    address internal constant ADDRESS_WETH =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    constructor(
        IAcrossSpokePool _spokePool
    ) AcrossFacetV3(_spokePool, ADDRESS_WETH) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract AcrossFacetV3Test is TestBaseFacet {
    address internal constant ETH_HOLDER =
        0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511;
    address internal constant WETH_HOLDER =
        0xD022510A3414f255150Aa54b2e42DB6129a20d9E;
    address internal constant SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    address internal constant ADDRESS_USDC_POL =
        0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    // -----
    AcrossFacetV3.AcrossData internal validAcrossData;
    TestAcrossFacetV3 internal acrossFacetV3;

    function setUp() public {
        customBlockNumberForForking = 19960294;
        initTestBase();

        acrossFacetV3 = new TestAcrossFacetV3(IAcrossSpokePool(SPOKE_POOL));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = acrossFacetV3
            .startBridgeTokensViaAcross
            .selector;
        functionSelectors[1] = acrossFacetV3
            .swapAndStartBridgeTokensViaAcross
            .selector;
        functionSelectors[2] = acrossFacetV3.addDex.selector;
        functionSelectors[3] = acrossFacetV3
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(acrossFacetV3), functionSelectors);
        acrossFacetV3 = TestAcrossFacetV3(address(diamond));
        acrossFacetV3.addDex(ADDRESS_UNISWAP);
        acrossFacetV3.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        acrossFacetV3.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        acrossFacetV3.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(acrossFacetV3), "AcrossFacetV3");

        // adjust bridgeData
        bridgeData.bridge = "across";
        // bridgeData.destinationChainId = 137;
        bridgeData.destinationChainId = 42161;

        // produce valid AcrossData
        uint32 quoteTimestamp = 1716791411;
        validAcrossData = AcrossFacetV3.AcrossData({
            // receivingAssetId: ADDRESS_USDC_POL,
            receivingAssetId: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831, //USDC @ ARB
            outputAmount: 0.9 ether,
            quoteTimestamp: quoteTimestamp,
            fillDeadline: quoteTimestamp + 1000,
            message: ""
        });

        vm.label(SPOKE_POOL, "SpokePool_Proxy");
        vm.label(0x08C21b200eD06D2e32cEC91a770C3FcA8aD5F877, "SpokePool_Impl");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            acrossFacetV3.startBridgeTokensViaAcross{
                value: bridgeData.minAmount
            }(bridgeData, validAcrossData);
        } else {
            acrossFacetV3.startBridgeTokensViaAcross(
                bridgeData,
                validAcrossData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            acrossFacetV3.swapAndStartBridgeTokensViaAcross{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validAcrossData);
        } else {
            acrossFacetV3.swapAndStartBridgeTokensViaAcross(
                bridgeData,
                swapData,
                validAcrossData
            );
        }
    }

    function testFailsToBridgeERC20TokensDueToQuoteTimeout() public {
        console.logBytes4(IAcrossSpokePool.deposit.selector);
        vm.startPrank(WETH_HOLDER);
        ERC20 weth = ERC20(ADDRESS_WETH);
        weth.approve(address(acrossFacetV3), 10_000 * 10 ** weth.decimals());

        validAcrossData.quoteTimestamp = uint32(block.timestamp + 20 minutes);

        acrossFacetV3.startBridgeTokensViaAcross(bridgeData, validAcrossData);
        vm.stopPrank();
    }

    function testCanBridgeTokens() public {
        vm.startPrank(USER_SENDER);

        // set approval
        usdc.approve(address(acrossFacetV3), defaultUSDCAmount);

        // set up expected event emission
        vm.expectEmit(true, true, true, true, address(acrossFacetV3));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens()
        public
        override
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256((defaultNativeAmount + addToMessageValue))
        )
    // assertBalanceChange(address(0), USER_RECEIVER, 0)
    // assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
    // assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        vm.startPrank(0x75e89d5979E4f6Fba9F97c104c2F0AFB3F1dcB88);
        console.log("balance sender: ", USER_SENDER.balance);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        validAcrossData
            .receivingAssetId = 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619; // WMATIC on POL

        //prepare check for events
        // vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        // emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        // (bool success, bytes memory result) = SPOKE_POOL.call{
        //     value: 1 ether
        // }(
        //     hex"7b93923200000000000000000000000075e89d5979e4f6fba9f97c104c2f0afb3f1dcb880000000000000000000000000000000000000000000000000000000abc654321000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000000000000000000000007ceb23fd6bc0add59e62ac25578270cff1b9f6190000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000c7d713b49da00000000000000000000000000000000000000000000000000000000000000000089000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000665428730000000000000000000000000000000000000000000000000000000066542c5b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000003626c610000000000000000000000000000000000000000000000000000000000"
        // );

        // if (!success) LibUtil.revertWith(result);
        vm.stopPrank();
    }
}
