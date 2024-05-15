// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20, LibSwap } from "../utils/TestBaseFacet.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";
import { IMayan } from "lifi/Interfaces/IMayan.sol";

// Stub MayanFacet Contract
contract TestMayanFacet is MayanFacet {
    constructor(IMayan _bridge) MayanFacet(_bridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract MayanFacetTest is TestBaseFacet {
    MayanFacet.MayanData internal validMayanData;
    TestMayanFacet internal mayanBridgeFacet;
    IMayan internal MAYAN_BRIDGE =
        IMayan(0xF3f04555f8FdA510bfC77820FD6eB8446f59E72d);
    address internal POLYGON_USDT = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    uint256 internal totalFees;

    function setUp() public {
        customBlockNumberForForking = 19367700;
        initTestBase();

        address[] memory EXAMPLE_ALLOWED_TOKENS = new address[](2);
        EXAMPLE_ALLOWED_TOKENS[0] = address(1);
        EXAMPLE_ALLOWED_TOKENS[1] = address(2);

        mayanBridgeFacet = new TestMayanFacet(MAYAN_BRIDGE);
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = mayanBridgeFacet
            .startBridgeTokensViaMayan
            .selector;
        functionSelectors[1] = mayanBridgeFacet
            .swapAndStartBridgeTokensViaMayan
            .selector;
        functionSelectors[2] = mayanBridgeFacet.addDex.selector;
        functionSelectors[3] = mayanBridgeFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[4] = mayanBridgeFacet
            .setMayanChainIdMapping
            .selector;

        addFacet(diamond, address(mayanBridgeFacet), functionSelectors);
        mayanBridgeFacet = TestMayanFacet(address(diamond));
        mayanBridgeFacet.addDex(ADDRESS_UNISWAP);
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        mayanBridgeFacet.setMayanChainIdMapping(137, 5);

        setFacetAddressInTestBase(address(mayanBridgeFacet), "MayanFacet");

        // adjust bridgeData
        bridgeData.bridge = "mayanBridge";
        bridgeData.destinationChainId = 137;

        // produce valid MayanData
        validMayanData = MayanFacet.MayanData({
            mayanAddr: 0x32f0af4069bde51a996d1250ef3f7c2431245b98e027b34aa5ca5ae435c435c9,
            referrer: bytes32(0),
            tokenOutAddr: bytes32(uint256(uint160(POLYGON_USDT))),
            receiver: bytes32(uint256(uint160(USER_SENDER))),
            swapFee: 100000,
            redeemFee: 1000000,
            refundFee: 1000000,
            transferDeadline: block.timestamp + 1000,
            swapDeadline: uint64(block.timestamp + 1000),
            amountOutMin: uint64((bridgeData.minAmount * 99) / 100),
            unwrap: false,
            gasDrop: 0
        });

        totalFees =
            validMayanData.redeemFee +
            validMayanData.refundFee +
            validMayanData.swapFee;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            mayanBridgeFacet.startBridgeTokensViaMayan{
                value: bridgeData.minAmount + totalFees
            }(bridgeData, validMayanData);
        } else {
            mayanBridgeFacet.startBridgeTokensViaMayan(
                bridgeData,
                validMayanData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            mayanBridgeFacet.swapAndStartBridgeTokensViaMayan{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validMayanData);
        } else {
            mayanBridgeFacet.swapAndStartBridgeTokensViaMayan(
                bridgeData,
                swapData,
                validMayanData
            );
        }
    }

    function test_CanSwapAndBridgeTokensFromNative()
        public
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialETHBalance = USER_SENDER.balance;

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // prepare swap data
        address[] memory path = new address[](2);

        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

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

        //@dev the bridged amount will be higher than bridgeData.minAmount since the code will
        //     deposit all remaining ETH to the bridge. We cannot access that value (minAmount + remaining gas)
        //     therefore the test is designed to only check if an event was emitted but not match the parameters
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(true);

        // check balances after call
        assertEq(
            USER_SENDER.balance,
            initialETHBalance - swapData[0].fromAmount
        );
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        amount = bound(amount, 150, 100_000);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }
}
