// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../../../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { AcrossFacetV4 } from "lifi/Facets/AcrossFacetV4.sol";
import { IAcrossSpokePoolV4 } from "lifi/Interfaces/IAcrossSpokePoolV4.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { InvalidConfig, InvalidReceiver, InvalidNonEVMReceiver, InvalidCallData } from "lifi/Errors/GenericErrors.sol";

// Stub AcrossFacetV4 Contract
contract TestAcrossFacetV4 is AcrossFacetV4 {
    address internal constant ADDRESS_WETH =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    constructor(
        IAcrossSpokePoolV4 _spokePool
    ) AcrossFacetV4(_spokePool, _convertAddressToBytes32(ADDRESS_WETH)) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract AcrossFacetV4Test is TestBaseFacet {
    address internal constant SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    bytes32 internal constant USDC_ADDRESS_SOLANA =
        0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61;
    bytes32 internal constant USER_RECEIVER_SOLANA =
        0x98e43fd4b1f88564e7ecfa1dd5059e0ab4a8126fcdd31927f1db9eb51dd74b12;

    // -----
    AcrossFacetV4.AcrossV4Data internal validAcrossData;
    TestAcrossFacetV4 internal acrossFacetV4;

    error InvalidQuoteTimestamp();

    function setUp() public {
        customBlockNumberForForking = 22989702;
        initTestBase();

        acrossFacetV4 = new TestAcrossFacetV4(IAcrossSpokePoolV4(SPOKE_POOL));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = acrossFacetV4
            .startBridgeTokensViaAcrossV4
            .selector;
        functionSelectors[1] = acrossFacetV4
            .swapAndStartBridgeTokensViaAcrossV4
            .selector;
        functionSelectors[2] = acrossFacetV4.addDex.selector;
        functionSelectors[3] = acrossFacetV4
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(acrossFacetV4), functionSelectors);
        acrossFacetV4 = TestAcrossFacetV4(address(diamond));
        acrossFacetV4.addDex(ADDRESS_UNISWAP);
        acrossFacetV4.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        acrossFacetV4.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        acrossFacetV4.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(acrossFacetV4), "AcrossFacetV4");

        // adjust bridgeData
        bridgeData.bridge = "across";
        // bridgeData.destinationChainId = 137;
        bridgeData.destinationChainId = 1151111081099710;

        // produce valid AcrossData
        uint32 quoteTimestamp = uint32(block.timestamp);
        validAcrossData = AcrossFacetV4.AcrossV4Data({
            receiverAddress: _convertAddressToBytes32(USER_RECEIVER),
            refundAddress: _convertAddressToBytes32(USER_REFUND),
            sendingAssetId: _convertAddressToBytes32(ADDRESS_USDC),
            receivingAssetId: _convertAddressToBytes32(ADDRESS_USDC_POL),
            outputAmount: (defaultUSDCAmount * 9) / 10,
            outputAmountMultiplier: 1000000000000000000, // 100.00% (1e18)
            exclusiveRelayer: _convertAddressToBytes32(address(0)),
            quoteTimestamp: quoteTimestamp,
            fillDeadline: uint32(quoteTimestamp + 1000),
            exclusivityDeadline: 0,
            message: ""
        });

        vm.label(SPOKE_POOL, "SpokePool_Proxy");
        vm.label(0x08C21b200eD06D2e32cEC91a770C3FcA8aD5F877, "SpokePool_Impl");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            acrossFacetV4.startBridgeTokensViaAcrossV4{
                value: bridgeData.minAmount
            }(bridgeData, validAcrossData);
        } else {
            acrossFacetV4.startBridgeTokensViaAcrossV4(
                bridgeData,
                validAcrossData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            acrossFacetV4.swapAndStartBridgeTokensViaAcrossV4{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validAcrossData);
        } else {
            acrossFacetV4.swapAndStartBridgeTokensViaAcrossV4(
                bridgeData,
                swapData,
                validAcrossData
            );
        }
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** usdc.decimals();

        logFilePath = "./test/logs/"; // works but is not really a proper file
        // logFilePath = "./test/logs/fuzz_test.txt"; // throws error "failed to write to
        // "....../test/logs/fuzz_test.txt": No such file or directory"

        vm.writeLine(logFilePath, vm.toString(amount));
        // approval
        usdc.approve(_facetTestContractAddress, amount);

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // Set the bridge data sendingAssetId to match the Across data
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokensToSolana() public {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Set parameters
        bridgeData.receiver = NON_EVM_ADDRESS;
        validAcrossData.receiverAddress = _convertAddressToBytes32(
            NON_EVM_ADDRESS
        );
        validAcrossData.receivingAssetId = USDC_ADDRESS_SOLANA;
        bridgeData.minAmount = 1 * 10 ** usdc.decimals();
        validAcrossData.outputAmount = (bridgeData.minAmount * 99) / 100;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeTokens()
        public
        override
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC; // USDC is the asset that will be bridged

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
        vm.stopPrank();
    }

    function test_canSwapAndBridgeTokensWithOutputAmountMultiplier()
        public
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // Set output amount multiplier to 85%
        validAcrossData.outputAmountMultiplier = uint128(850000000000000000); // 85.00%
        validAcrossData.outputAmount = 10000; // This will be ignored

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
        vm.stopPrank();
    }

    function test_canSwapAndBridgeNativeTokensWithOutputAmountPercent()
        public
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialUSDCBalance = usdc.balanceOf(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        uint256 amountOut = defaultNativeAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // Set output amount multiplier to 93.75%
        validAcrossData.outputAmountMultiplier = uint128(937500000000000000); // 93.75%
        validAcrossData.outputAmount = 10000; // This will be ignored

        // approval
        usdc.approve(_facetTestContractAddress, amountIn);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_USDC,
            address(0),
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
        initiateSwapAndBridgeTxWithFacet(false);

        // check balances after call
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialUSDCBalance - swapData[0].fromAmount
        );
        vm.stopPrank();
    }

    function testRevert_FailsIfCalledWithOutdatedQuote() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        validAcrossData.quoteTimestamp = uint32(block.timestamp - 100 days);

        vm.expectRevert(InvalidQuoteTimestamp.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function test_contractIsSetUpCorrectly() public {
        acrossFacetV4 = new TestAcrossFacetV4(IAcrossSpokePoolV4(SPOKE_POOL));

        assertEq(address(acrossFacetV4.SPOKEPOOL()) == SPOKE_POOL, true);
        assertEq(
            acrossFacetV4.WRAPPED_NATIVE() ==
                _convertAddressToBytes32(ADDRESS_WRAPPED_NATIVE),
            true
        );
    }

    function testRevert_WillFailIfBridgeDataReceiverDoesNotMatchWithAcrossData()
        public
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        // Keep quote fresh so we specifically test receiver mismatch.
        validAcrossData.quoteTimestamp = uint32(block.timestamp);

        bridgeData.receiver = address(0x123); // does not match with USER_RECEIVER

        vm.expectRevert(InvalidReceiver.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function testRevert_WillFailIfAcrossDataReceiverDoesNotMatchWithBridgeData()
        public
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        // Set AcrossData receiver to a different address than bridgeData.receiver
        validAcrossData.receiverAddress = _convertAddressToBytes32(
            address(0x456)
        );

        vm.expectRevert(InvalidReceiver.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function testRevert_WillFailIfBothReceiverAddressesAreDifferent() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        // Set both to different addresses
        bridgeData.receiver = address(0x123);
        validAcrossData.receiverAddress = _convertAddressToBytes32(
            address(0x456)
        );

        vm.expectRevert(InvalidReceiver.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function testRevert_WillFailIfAcrossDataReceiverIsZeroAddress() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        // Set AcrossData receiver to zero address
        validAcrossData.receiverAddress = _convertAddressToBytes32(address(0));

        vm.expectRevert(InvalidReceiver.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function testRevert_WillFailIfBridgeDataReceiverIsZeroAddress() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        // Set bridgeData receiver to zero address
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function test_SuccessfulValidationWhenReceiverAddressesMatch()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // Ensure both receiver addresses match
        bridgeData.receiver = USER_RECEIVER;
        validAcrossData.receiverAddress = _convertAddressToBytes32(
            USER_RECEIVER
        );

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // This should succeed without reverting
        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function testRevert_WillFailIfEVMReceiverAddressIsZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        // Set up for EVM chain (not non-EVM)
        bridgeData.receiver = USER_RECEIVER; // EVM address
        validAcrossData.receivingAssetId = _convertAddressToBytes32(
            ADDRESS_USDC_POL
        );

        // Set receiver address to zero (which should cause InvalidReceiver for EVM)
        validAcrossData.receiverAddress = bytes32(0);

        vm.expectRevert(InvalidReceiver.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function testRevert_WillFailIfEVMReceiverAddressIsZeroWithDestinationCall()
        public
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        // Set up for EVM chain with destination call
        bridgeData.receiver = USER_RECEIVER;
        bridgeData.hasDestinationCall = true; // This bypasses the address matching check
        validAcrossData.receivingAssetId = _convertAddressToBytes32(
            ADDRESS_USDC_POL
        );
        validAcrossData.message = "some message"; // Set message to match hasDestinationCall

        // Set receiver address to zero (which should cause InvalidReceiver for EVM)
        validAcrossData.receiverAddress = bytes32(0);

        vm.expectRevert(InvalidReceiver.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function testRevert_WillFailIfNonEVMReceiverAddressIsZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        // Set up for non-EVM chain (Solana)
        bridgeData.receiver = NON_EVM_ADDRESS;
        validAcrossData.receivingAssetId = USDC_ADDRESS_SOLANA;

        // Set receiver address to zero (which should cause InvalidNonEVMReceiver)
        validAcrossData.receiverAddress = bytes32(0);

        vm.expectRevert(InvalidNonEVMReceiver.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function testRevert_WillFailIfRefundAddressIsZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossFacetV4), bridgeData.minAmount);

        // Set refund address to zero (which should cause InvalidCallData)
        validAcrossData.refundAddress = bytes32(0);

        vm.expectRevert(InvalidCallData.selector);

        acrossFacetV4.startBridgeTokensViaAcrossV4(
            bridgeData,
            validAcrossData
        );
        vm.stopPrank();
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestAcrossFacetV4(IAcrossSpokePoolV4(address(0)));
    }

    function testRevert_WhenConstructedWithZeroWrappedNative() public {
        vm.expectRevert(InvalidConfig.selector);

        new AcrossFacetV4(IAcrossSpokePoolV4(SPOKE_POOL), bytes32(0));
    }

    /// @notice Converts an address to a bytes32
    /// @param _address The address to convert
    function _convertAddressToBytes32(
        address _address
    ) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_address)));
    }
}
