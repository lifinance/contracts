// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LiFiIntentEscrowFacetV2 } from "lifi/Facets/LiFiIntentEscrowFacetV2.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { InvalidReceiver, NativeAssetNotSupported, InvalidAmount, InformationMismatch } from "lifi/Errors/GenericErrors.sol";
import { ReceiverOIF } from "lifi/Periphery/ReceiverOIF.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { TokenWrapper } from "lifi/Periphery/TokenWrapper.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LiFiData } from "lifi/Helpers/LiFiData.sol";

import { MandateOutput, StandardOrder } from "lifi/Interfaces/IOpenIntentFramework.sol";

import { OUTPUT_SETTLER_COIN, OutputSettler } from "../Periphery/ReceiverOIF.t.sol";
import { DeployPeripheryHelpers } from "../utils/DeployPeripheryHelpers.sol";

contract AlwaysYesOracle {
    function isProven(
        uint256,
        /* remoteChainId */
        bytes32,
        /* outputOracle */
        bytes32,
        /* application */
        bytes32 /* dataHash */
    ) external pure returns (bool) {
        return true;
    }

    function efficientRequireProven(
        bytes calldata /* proofSeries */
    ) external pure {}
}

struct SolveParams {
    uint32 timestamp;
    bytes32 solver;
}

interface ILiFiIntentEscrowSettler {
    event Open(bytes32 indexed orderId, StandardOrder order);

    function orderStatus(bytes32 orderid) external returns (uint8);

    function finalise(
        StandardOrder calldata order,
        SolveParams[] calldata solveParams,
        bytes32 destination,
        bytes calldata call
    ) external;

    function orderIdentifier(
        StandardOrder calldata order
    ) external view returns (bytes32);
}

// Stub LiFiIntentEscrowFacetV2 Contract
contract TestLiFiIntentEscrowFacetV2 is
    LiFiIntentEscrowFacetV2,
    TestWhitelistManagerBase
{
    constructor(
        address escrowSettler
    ) LiFiIntentEscrowFacetV2(escrowSettler) {}
}

contract LiFiIntentEscrowFacetV2Test is TestBaseFacet {
    // The base for the swap-path output multiplier (1e18 = 100%).
    uint256 internal constant MULTIPLIER_BASE = 1e18;

    error FailedInputSettlerDeployment();

    event Open(bytes32 indexed orderId, StandardOrder order);

    TestLiFiIntentEscrowFacetV2 internal lifiIntentEscrowFacet;
    TestLiFiIntentEscrowFacetV2 internal baseLiFiIntentEscrowFacet;

    address internal lifiIntentEscrowSettler;

    address internal alwaysYesOracle;

    address internal dstCallReceiver;

    address payable internal tokenWrapper;

    function _validLIFIIntentData()
        internal
        view
        returns (LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2 memory)
    {
        return
            LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2({
                recipient: bytes32(uint256(uint160(bridgeData.receiver))),
                dstCallReceiver: bytes32(uint256(uint160(dstCallReceiver))),
                depositAndRefundAddress: address(uint160(123123321321)),
                nonce: uint256(100),
                expires: type(uint32).max,
                fillDeadline: type(uint32).max,
                inputOracle: alwaysYesOracle, // Not used
                outputOracle: bytes32(0), // not used
                outputSettler: bytes32(uint256(uint160(OUTPUT_SETTLER_COIN))),
                outputToken: bytes32(uint256(888999888)),
                outputAmountMultiplier: uint128(MULTIPLIER_BASE),
                dstCallSwapData: new LibSwap.SwapData[](0),
                outputContext: hex""
            });
    }

    function setUp() public {
        // Block after deployment.
        customBlockNumberForForking = 23695990;
        initTestBase();

        // Instead of accessing the mainnet deployment, deploy here.
        // This saves a lot of RPC calls and significantly speeds up testing suite.
        (, Executor executor) = DeployPeripheryHelpers
            .deployERC20ProxyAndExecutor(address(this), address(this));
        dstCallReceiver = address(
            new ReceiverOIF(
                address(this),
                address(executor),
                OUTPUT_SETTLER_COIN
            )
        );
        tokenWrapper = payable(
            address(new TokenWrapper(address(weth), address(0), address(this)))
        );

        // deploy oracle & allocator
        alwaysYesOracle = address(new AlwaysYesOracle());

        lifiIntentEscrowSettler = 0x000025c3226C00B2Cdc200005a1600509f4e00C0;

        baseLiFiIntentEscrowFacet = new TestLiFiIntentEscrowFacetV2(
            lifiIntentEscrowSettler
        );

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = baseLiFiIntentEscrowFacet
            .startBridgeTokensViaLiFiIntentEscrowV2
            .selector;
        functionSelectors[1] = baseLiFiIntentEscrowFacet
            .swapAndStartBridgeTokensViaLiFiIntentEscrowV2
            .selector;
        functionSelectors[2] = baseLiFiIntentEscrowFacet
            .addAllowedContractSelector
            .selector;

        addFacet(
            diamond,
            address(baseLiFiIntentEscrowFacet),
            functionSelectors
        );
        lifiIntentEscrowFacet = TestLiFiIntentEscrowFacetV2(address(diamond));
        lifiIntentEscrowFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        lifiIntentEscrowFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        lifiIntentEscrowFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );
        lifiIntentEscrowFacet.addAllowedContractSelector(
            tokenWrapper,
            TokenWrapper.deposit.selector
        );
        lifiIntentEscrowFacet.addAllowedContractSelector(
            tokenWrapper,
            TokenWrapper.withdraw.selector
        );

        setFacetAddressInTestBase(
            address(lifiIntentEscrowFacet),
            "LiFiIntentEscrowFacetV2"
        );

        // adjust bridgeData
        bridgeData.bridge = "LIFIIntent";
        bridgeData.destinationChainId = 137;
    }

    function testRevert_deployWith0Address() external {
        vm.expectRevert(abi.encodeWithSignature("InvalidConfig()"));
        new TestLiFiIntentEscrowFacetV2(address(0));
    }

    event Finalised(
        bytes32 indexed orderId,
        bytes32 solver,
        bytes32 destination
    );

    event IntentRegistered(bytes32 indexed orderId, StandardOrder order);

    function test_LIFIIntentDepositStatus() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Check that the execution happens as we would expect it to.

        uint256 expectedOutputAmount = (bridgeData.minAmount *
            uint256(validLIFIIntentData.outputAmountMultiplier)) /
            MULTIPLIER_BASE;

        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: validLIFIIntentData.outputOracle,
            settler: validLIFIIntentData.outputSettler,
            chainId: bridgeData.destinationChainId,
            token: validLIFIIntentData.outputToken,
            amount: expectedOutputAmount,
            recipient: validLIFIIntentData.recipient,
            callbackData: hex"",
            context: validLIFIIntentData.outputContext
        });
        uint256[2][] memory idsAndAmounts = new uint256[2][](1);
        idsAndAmounts[0] = [
            uint256(uint160(bridgeData.sendingAssetId)),
            bridgeData.minAmount
        ];

        StandardOrder memory order = StandardOrder({
            user: validLIFIIntentData.depositAndRefundAddress,
            nonce: validLIFIIntentData.nonce,
            originChainId: block.chainid,
            expires: validLIFIIntentData.expires,
            fillDeadline: validLIFIIntentData.fillDeadline,
            inputOracle: validLIFIIntentData.inputOracle,
            inputs: idsAndAmounts,
            outputs: outputs
        });

        bytes32 orderId = ILiFiIntentEscrowSettler(lifiIntentEscrowSettler)
            .orderIdentifier(order);

        vm.expectEmit(true, true, true, true, lifiIntentEscrowSettler);
        emit Open(orderId, order);

        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();

        // Check that we can redeem the intent (i.e. that we registered the intent we expected.)

        address solver = address(7788778877);
        vm.startPrank(solver);

        uint8 orderStatus = ILiFiIntentEscrowSettler(lifiIntentEscrowSettler)
            .orderStatus(orderId);
        assertEq(orderStatus, 1); // Check orderStatus is deposited.

        bytes32 solverIdentifier = bytes32(uint256(uint160(solver)));
        SolveParams[] memory solveParams = new SolveParams[](1);
        solveParams[0] = SolveParams({
            timestamp: type(uint32).max,
            solver: solverIdentifier
        });

        vm.expectEmit(true, true, true, true, lifiIntentEscrowSettler);
        emit Finalised(orderId, solverIdentifier, solverIdentifier);

        ILiFiIntentEscrowSettler(lifiIntentEscrowSettler).finalise(
            order,
            solveParams,
            bytes32(uint256(uint160(solver))),
            hex""
        );

        assertEq(usdc.balanceOf(solver), bridgeData.minAmount);
    }

    function test_LIFIIntentNonEvm() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Incorrectly modify the recipient
        validLIFIIntentData.recipient = keccak256("");
        bridgeData.receiver = LiFiData.NON_EVM_ADDRESS;

        // This call should not revert as the address comparision is skipped.
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function testRevert_LIFIIntentNonEvmIsZeroAddress() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Incorrectly modify the recipient
        validLIFIIntentData.recipient = bytes32(0);
        bridgeData.receiver = LiFiData.NON_EVM_ADDRESS;

        // This call should revert because recipient == bytes32(0) is always invalid.
        vm.expectRevert(InvalidReceiver.selector);
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function testRevert_NonEvmWithDestinationCall() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Non-EVM destination combined with a destination call.
        bridgeData.receiver = LiFiData.NON_EVM_ADDRESS;
        bridgeData.hasDestinationCall = true;
        validLIFIIntentData.recipient = keccak256("");
        validLIFIIntentData.dstCallSwapData = new LibSwap.SwapData[](1);

        vm.expectRevert(InformationMismatch.selector);
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function testRevert_LIFIIntentWrongReceiver() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Incorrectly modify the recipient
        validLIFIIntentData.recipient = bytes32(
            uint256(uint160(bridgeData.receiver)) + 1
        );

        vm.expectRevert(InvalidReceiver.selector);
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function testRevert_LIFIIntentNativeNotSupported() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        bridgeData.sendingAssetId = address(0);

        vm.expectRevert(NativeAssetNotSupported.selector);
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
    }

    function testRevert_LIFIIntentZeroDepositAndRefundAddress() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Set depositAndRefundAddress to address(0)
        validLIFIIntentData.depositAndRefundAddress = address(0);

        vm.expectRevert(
            LiFiIntentEscrowFacetV2.InvalidDepositAndRefundAddress.selector
        );
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function testRevert_LIFIIntentZeroDepositAndRefundAddressSwapAnd()
        external
    {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);
        bridgeData.hasSourceSwaps = true;

        // Set depositAndRefundAddress to address(0)
        validLIFIIntentData.depositAndRefundAddress = address(0);

        LibSwap.SwapData[] memory _swapData = new LibSwap.SwapData[](1);

        vm.expectRevert(
            LiFiIntentEscrowFacetV2.InvalidDepositAndRefundAddress.selector
        );
        lifiIntentEscrowFacet.swapAndStartBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            _swapData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function testRevert_LIFIIntentZeroMultiplierNonSwap() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        validLIFIIntentData.outputAmountMultiplier = 0;

        vm.expectRevert(InvalidAmount.selector);
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function test_NonSwapPathScalesWithMultiplier() external {
        // The non-swap path must also derive committed output via the multiplier.
        // Use a 2x multiplier: committed == minAmount * 2.
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        validLIFIIntentData.outputAmountMultiplier = uint128(
            2 * MULTIPLIER_BASE
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);
        bridgeData.sendingAssetId = address(usdc);

        uint256 expectedOutputAmount = bridgeData.minAmount * 2;

        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: validLIFIIntentData.outputOracle,
            settler: validLIFIIntentData.outputSettler,
            chainId: bridgeData.destinationChainId,
            token: validLIFIIntentData.outputToken,
            amount: expectedOutputAmount,
            recipient: validLIFIIntentData.recipient,
            callbackData: hex"",
            context: validLIFIIntentData.outputContext
        });
        uint256[2][] memory idsAndAmounts = new uint256[2][](1);
        idsAndAmounts[0] = [
            uint256(uint160(bridgeData.sendingAssetId)),
            bridgeData.minAmount
        ];

        StandardOrder memory order = StandardOrder({
            user: validLIFIIntentData.depositAndRefundAddress,
            nonce: validLIFIIntentData.nonce,
            originChainId: block.chainid,
            expires: validLIFIIntentData.expires,
            fillDeadline: validLIFIIntentData.fillDeadline,
            inputOracle: validLIFIIntentData.inputOracle,
            inputs: idsAndAmounts,
            outputs: outputs
        });

        bytes32 orderId = ILiFiIntentEscrowSettler(lifiIntentEscrowSettler)
            .orderIdentifier(order);

        vm.expectEmit(true, true, true, true, lifiIntentEscrowSettler);
        emit Open(orderId, order);

        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function test_NonSwapPathCrossDecimalMultiplier() external {
        // Non-swap with a cross-decimal multiplier (6→18 dec, 1:1 price).
        // multiplier = 1e18 * 10^(18-6) = 1e30
        // committed = minAmount * 1e30 / 1e18 = minAmount * 1e12
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        validLIFIIntentData.outputAmountMultiplier = uint128(1e30);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);
        bridgeData.sendingAssetId = address(usdc);

        uint256 expectedOutputAmount = bridgeData.minAmount * 10 ** 12;

        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: validLIFIIntentData.outputOracle,
            settler: validLIFIIntentData.outputSettler,
            chainId: bridgeData.destinationChainId,
            token: validLIFIIntentData.outputToken,
            amount: expectedOutputAmount,
            recipient: validLIFIIntentData.recipient,
            callbackData: hex"",
            context: validLIFIIntentData.outputContext
        });
        uint256[2][] memory idsAndAmounts = new uint256[2][](1);
        idsAndAmounts[0] = [
            uint256(uint160(bridgeData.sendingAssetId)),
            bridgeData.minAmount
        ];

        StandardOrder memory order = StandardOrder({
            user: validLIFIIntentData.depositAndRefundAddress,
            nonce: validLIFIIntentData.nonce,
            originChainId: block.chainid,
            expires: validLIFIIntentData.expires,
            fillDeadline: validLIFIIntentData.fillDeadline,
            inputOracle: validLIFIIntentData.inputOracle,
            inputs: idsAndAmounts,
            outputs: outputs
        });

        bytes32 orderId = ILiFiIntentEscrowSettler(lifiIntentEscrowSettler)
            .orderIdentifier(order);

        vm.expectEmit(true, true, true, true, lifiIntentEscrowSettler);
        emit Open(orderId, order);

        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function testRevert_NonSwapDownscaleFloorsToZero() external {
        // A tiny minAmount with a downscale multiplier floors to zero and reverts.
        // minAmount = 999, multiplier = 1e6 (18→6 dec) → 999 * 1e6 / 1e18 = 0
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        validLIFIIntentData.outputAmountMultiplier = uint128(1e6);

        bridgeData.minAmount = 999;
        bridgeData.sendingAssetId = address(usdc);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);
        deal(address(usdc), USER_SENDER, bridgeData.minAmount);

        vm.expectRevert(InvalidAmount.selector);
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function test_NonSwapWithDestinationCallAndMultiplier() external {
        // Non-swap + destination call + non-unit multiplier (2x).
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        validLIFIIntentData.outputAmountMultiplier = uint128(
            2 * MULTIPLIER_BASE
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);
        bridgeData.sendingAssetId = address(usdc);
        bridgeData.hasDestinationCall = true;
        validLIFIIntentData.dstCallSwapData = new LibSwap.SwapData[](1);

        uint256 expectedOutputAmount = bridgeData.minAmount * 2;

        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: validLIFIIntentData.outputOracle,
            settler: validLIFIIntentData.outputSettler,
            chainId: bridgeData.destinationChainId,
            token: validLIFIIntentData.outputToken,
            amount: expectedOutputAmount,
            recipient: validLIFIIntentData.dstCallReceiver,
            callbackData: abi.encode(
                bridgeData.transactionId,
                validLIFIIntentData.dstCallSwapData,
                validLIFIIntentData.recipient
            ),
            context: validLIFIIntentData.outputContext
        });
        uint256[2][] memory idsAndAmounts = new uint256[2][](1);
        idsAndAmounts[0] = [
            uint256(uint160(bridgeData.sendingAssetId)),
            bridgeData.minAmount
        ];

        StandardOrder memory order = StandardOrder({
            user: validLIFIIntentData.depositAndRefundAddress,
            nonce: validLIFIIntentData.nonce,
            originChainId: block.chainid,
            expires: validLIFIIntentData.expires,
            fillDeadline: validLIFIIntentData.fillDeadline,
            inputOracle: validLIFIIntentData.inputOracle,
            inputs: idsAndAmounts,
            outputs: outputs
        });

        bytes32 orderId = ILiFiIntentEscrowSettler(lifiIntentEscrowSettler)
            .orderIdentifier(order);

        vm.expectEmit(true, true, true, true, lifiIntentEscrowSettler);
        emit Open(orderId, order);

        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {} else {
            LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
                memory validLIFIIntentData = _validLIFIIntentData();
            lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
                bridgeData,
                validLIFIIntentData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {} else {
            LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
                memory validLIFIIntentData = _validLIFIIntentData();
            lifiIntentEscrowFacet
                .swapAndStartBridgeTokensViaLiFiIntentEscrowV2(
                    bridgeData,
                    swapData,
                    validLIFIIntentData
                );
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_Revert_BridgeToSameChainId() public override {
        // not applicable, this facet intentionally allows same-chain actions/intents
    }

    function testBase_Revert_SwapAndBridgeToSameChainId() public override {
        // not applicable, this facet intentionally allows same-chain actions/intents
    }

    function testRevert_MismatchedDestinationCallFlag() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Set hasDestinationCall to true but leave dstCallSwapData empty
        bridgeData.hasDestinationCall = true;

        vm.expectRevert(InformationMismatch.selector);
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function testRevert_MismatchedDestinationCallFlagReverse() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Set hasDestinationCall to false but provide dstCallSwapData data
        bridgeData.hasDestinationCall = false;
        validLIFIIntentData.dstCallSwapData = new LibSwap.SwapData[](1);

        vm.expectRevert(InformationMismatch.selector);
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function testRevert_MismatchedDestinationCallNoReceiver() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Set hasDestinationCall to false but provide dstCallSwapData data
        bridgeData.hasDestinationCall = true;
        validLIFIIntentData.dstCallSwapData = new LibSwap.SwapData[](1);
        validLIFIIntentData.dstCallReceiver = bytes32(0);

        vm.expectRevert(InvalidReceiver.selector);
        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function test_WithDestinationCallCheckOrderId() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        vm.startPrank(USER_SENDER);
        usdc.approve(address(lifiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = address(usdc);

        // Correctly set hasDestinationCall to true with outputCall data
        bridgeData.hasDestinationCall = true;
        validLIFIIntentData.dstCallSwapData = new LibSwap.SwapData[](1);

        uint256 expectedOutputAmount = (bridgeData.minAmount *
            uint256(validLIFIIntentData.outputAmountMultiplier)) /
            MULTIPLIER_BASE;

        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: validLIFIIntentData.outputOracle,
            settler: validLIFIIntentData.outputSettler,
            chainId: bridgeData.destinationChainId,
            token: validLIFIIntentData.outputToken,
            amount: expectedOutputAmount,
            recipient: validLIFIIntentData.dstCallReceiver,
            callbackData: abi.encode(
                bridgeData.transactionId,
                validLIFIIntentData.dstCallSwapData,
                validLIFIIntentData.recipient
            ),
            context: validLIFIIntentData.outputContext
        });
        uint256[2][] memory idsAndAmounts = new uint256[2][](1);
        idsAndAmounts[0] = [
            uint256(uint160(bridgeData.sendingAssetId)),
            bridgeData.minAmount
        ];

        StandardOrder memory order = StandardOrder({
            user: validLIFIIntentData.depositAndRefundAddress,
            nonce: validLIFIIntentData.nonce,
            originChainId: block.chainid,
            expires: validLIFIIntentData.expires,
            fillDeadline: validLIFIIntentData.fillDeadline,
            inputOracle: validLIFIIntentData.inputOracle,
            inputs: idsAndAmounts,
            outputs: outputs
        });

        bytes32 orderId = ILiFiIntentEscrowSettler(lifiIntentEscrowSettler)
            .orderIdentifier(order);

        vm.expectEmit(true, true, true, true, lifiIntentEscrowSettler);
        emit Open(orderId, order);

        lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            validLIFIIntentData
        );
        vm.stopPrank();
    }

    function _setupDaiToUsdcSwap(
        uint256 _amountIn,
        uint256 _quotedSwapOut
    ) internal {
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: ADDRESS_UNISWAP,
                approveTo: ADDRESS_UNISWAP,
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: _amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    _amountIn,
                    _quotedSwapOut,
                    path,
                    address(lifiIntentEscrowFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        deal(ADDRESS_DAI, USER_SENDER, _amountIn);
        dai.approve(address(lifiIntentEscrowFacet), _amountIn);
    }

    // Helper function that setups a expectEmit with appropriate information.
    function _expectOpenWithScaledOutput(
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2 memory _intentData,
        uint256 _intentInput,
        uint256 _expectedOutputAmount
    ) internal {
        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: _intentData.outputOracle,
            settler: _intentData.outputSettler,
            chainId: bridgeData.destinationChainId,
            token: _intentData.outputToken,
            amount: _expectedOutputAmount,
            recipient: _intentData.recipient,
            callbackData: hex"",
            context: _intentData.outputContext
        });
        uint256[2][] memory idsAndAmounts = new uint256[2][](1);
        idsAndAmounts[0] = [
            uint256(uint160(bridgeData.sendingAssetId)),
            _intentInput
        ];
        StandardOrder memory order = StandardOrder({
            user: _intentData.depositAndRefundAddress,
            nonce: _intentData.nonce,
            originChainId: block.chainid,
            expires: _intentData.expires,
            fillDeadline: _intentData.fillDeadline,
            inputOracle: _intentData.inputOracle,
            inputs: idsAndAmounts,
            outputs: outputs
        });

        bytes32 orderId = ILiFiIntentEscrowSettler(lifiIntentEscrowSettler)
            .orderIdentifier(order);

        vm.expectEmit(true, true, true, true, lifiIntentEscrowSettler);
        emit Open(orderId, order);
    }

    function test_OutputAmountScalesWithMultiplier() external {
        // The committed destination output is realizedSwapOutput * multiplier /
        // MULTIPLIER_BASE. Positive slippage funds the intent (no refund).
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        address refundAddress = makeAddr("refundAddress");
        validLIFIIntentData.depositAndRefundAddress = refundAddress;
        validLIFIIntentData.outputAmountMultiplier = uint128(2 * 1e18); // 2x

        vm.startPrank(USER_SENDER);

        uint256 amountIn = 100 * 10 ** 18; // 100 DAI
        uint256 expectedUSDCOut;
        uint256 quotedSwapOut;
        {
            address[] memory path = new address[](2);
            path[0] = ADDRESS_DAI;
            path[1] = ADDRESS_USDC;
            expectedUSDCOut = uniswap.getAmountsOut(amountIn, path)[1];
            quotedSwapOut = expectedUSDCOut - 1; // worst-case floor below realized
        }

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = quotedSwapOut;
        bridgeData.hasSourceSwaps = true;

        _setupDaiToUsdcSwap(amountIn, quotedSwapOut);

        uint256 refundBalanceBefore = usdc.balanceOf(refundAddress);

        // Independently derived: 2x the realized output (no /1e18 in the test).
        _expectOpenWithScaledOutput(
            validLIFIIntentData,
            expectedUSDCOut,
            expectedUSDCOut * 2
        );

        lifiIntentEscrowFacet.swapAndStartBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            swapData,
            validLIFIIntentData
        );

        // Full swap output funds the intent, not the user.
        assertEq(
            usdc.balanceOf(refundAddress),
            refundBalanceBefore,
            "No positive-slippage refund should be issued"
        );

        vm.stopPrank();
    }

    function test_OutputAmountMultiplierUnitFactor() external {
        // A unit multiplier (1e18) with matching decimals commits exactly the
        // realized swap output; the struct's outputAmount is not preserved.
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        address refundAddress = makeAddr("refundAddress");
        validLIFIIntentData.depositAndRefundAddress = refundAddress;
        validLIFIIntentData.outputAmountMultiplier = uint128(MULTIPLIER_BASE);

        vm.startPrank(USER_SENDER);

        uint256 amountIn = 100 * 10 ** 18;
        uint256 expectedUSDCOut;
        {
            address[] memory path = new address[](2);
            path[0] = ADDRESS_DAI;
            path[1] = ADDRESS_USDC;
            expectedUSDCOut = uniswap.getAmountsOut(amountIn, path)[1];
        }

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = expectedUSDCOut;
        bridgeData.hasSourceSwaps = true;

        _setupDaiToUsdcSwap(amountIn, expectedUSDCOut);

        uint256 refundBalanceBefore = usdc.balanceOf(refundAddress);

        _expectOpenWithScaledOutput(
            validLIFIIntentData,
            expectedUSDCOut,
            expectedUSDCOut
        );

        lifiIntentEscrowFacet.swapAndStartBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            swapData,
            validLIFIIntentData
        );

        assertEq(
            usdc.balanceOf(refundAddress),
            refundBalanceBefore,
            "No refund should be issued on unit-factor swap"
        );

        vm.stopPrank();
    }

    function test_OutputAmountMultiplierAdjustsForDecimals() external {
        // Realized output is 6-decimal USDC; output token is 18-decimal at a 1:1
        // price. The multiplier folds the decimal delta:
        // 1e18 * 10^(18 - 6) == 1e30, so committed == realized * 1e12.
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        address refundAddress = makeAddr("refundAddress");
        validLIFIIntentData.depositAndRefundAddress = refundAddress;
        validLIFIIntentData.outputAmountMultiplier = uint128(1e30);

        vm.startPrank(USER_SENDER);

        uint256 amountIn = 100 * 10 ** 18;
        uint256 expectedUSDCOut;
        {
            address[] memory path = new address[](2);
            path[0] = ADDRESS_DAI;
            path[1] = ADDRESS_USDC;
            expectedUSDCOut = uniswap.getAmountsOut(amountIn, path)[1];
        }

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = expectedUSDCOut;
        bridgeData.hasSourceSwaps = true;

        _setupDaiToUsdcSwap(amountIn, expectedUSDCOut);

        // Independently derived: realized (6-dec) scaled to 18 decimals.
        _expectOpenWithScaledOutput(
            validLIFIIntentData,
            expectedUSDCOut,
            expectedUSDCOut * 10 ** 12
        );

        lifiIntentEscrowFacet.swapAndStartBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            swapData,
            validLIFIIntentData
        );

        vm.stopPrank();
    }

    function test_OutputAmountMultiplierRoundsDown() external {
        // A multiplier just above MULTIPLIER_BASE: for a realized output below
        // MULTIPLIER_BASE (USDC is ~1e8) the sub-ULP contribution floors away, so
        // the committed amount stays at the realized output. A round-up
        // implementation would instead over-commit by 1.
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        address refundAddress = makeAddr("refundAddress");
        validLIFIIntentData.depositAndRefundAddress = refundAddress;
        uint128 multiplier = uint128(MULTIPLIER_BASE + 1);
        validLIFIIntentData.outputAmountMultiplier = multiplier;

        vm.startPrank(USER_SENDER);

        uint256 amountIn = 100 * 10 ** 18;
        uint256 expectedUSDCOut;
        {
            address[] memory path = new address[](2);
            path[0] = ADDRESS_DAI;
            path[1] = ADDRESS_USDC;
            expectedUSDCOut = uniswap.getAmountsOut(amountIn, path)[1];
        }

        uint256 numerator = expectedUSDCOut * multiplier;
        assertGt(
            numerator % MULTIPLIER_BASE,
            0,
            "test must exercise flooring (no exact division)"
        );
        uint256 expectedFloored = numerator / MULTIPLIER_BASE;

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = expectedUSDCOut;
        bridgeData.hasSourceSwaps = true;

        _setupDaiToUsdcSwap(amountIn, expectedUSDCOut);

        _expectOpenWithScaledOutput(
            validLIFIIntentData,
            expectedUSDCOut,
            expectedFloored
        );

        lifiIntentEscrowFacet.swapAndStartBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            swapData,
            validLIFIIntentData
        );

        vm.stopPrank();
    }

    function testRevert_ScaledOutputAmountZero() external {
        // A zero multiplier makes the scaled effectiveOutputAmount == 0 on the
        // swap path; InvalidAmount must still trip.
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();
        validLIFIIntentData.outputAmountMultiplier = 0;

        vm.startPrank(USER_SENDER);

        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256 amountIn = 100 * 10 ** 18;
        uint256[] memory expectedAmounts = uniswap.getAmountsOut(
            amountIn,
            path
        );
        uint256 expectedUSDCOut = expectedAmounts[1];

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = expectedUSDCOut;
        bridgeData.hasSourceSwaps = true;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: ADDRESS_UNISWAP,
                approveTo: ADDRESS_UNISWAP,
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    expectedUSDCOut,
                    path,
                    address(lifiIntentEscrowFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        deal(ADDRESS_DAI, USER_SENDER, amountIn);
        dai.approve(address(lifiIntentEscrowFacet), amountIn);

        vm.expectRevert(InvalidAmount.selector);

        lifiIntentEscrowFacet.swapAndStartBridgeTokensViaLiFiIntentEscrowV2(
            bridgeData,
            swapData,
            validLIFIIntentData
        );

        vm.stopPrank();
    }

    function test_SwapNativeToNativeWithSwaps() external {
        LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2
            memory validLIFIIntentData = _validLIFIIntentData();

        uint256 amount = defaultNativeAmount;

        delete swapData;
        // Set calldata for converting user native into wrapped.
        swapData.push(
            LibSwap.SwapData({
                callTo: tokenWrapper,
                approveTo: address(0),
                sendingAssetId: address(0),
                receivingAssetId: address(weth),
                fromAmount: amount,
                callData: abi.encodeCall(TokenWrapper.deposit, ()),
                requiresDeposit: false
            })
        );

        // Make destination calldata for converting WETH into ETH. This is a common usecase for when solvers only provide WETH to WETH intents.
        LibSwap.SwapData[] memory destinationSwapData = new LibSwap.SwapData[](
            1
        );
        destinationSwapData[0] = LibSwap.SwapData({
            callTo: tokenWrapper,
            approveTo: tokenWrapper,
            sendingAssetId: address(weth),
            receivingAssetId: address(0),
            fromAmount: amount,
            callData: abi.encodeCall(TokenWrapper.withdraw, ()),
            requiresDeposit: false
        });

        validLIFIIntentData.outputToken = bytes32(
            uint256(uint160(address(weth)))
        );
        validLIFIIntentData.dstCallSwapData = destinationSwapData;
        validLIFIIntentData.outputAmountMultiplier = uint128(MULTIPLIER_BASE);

        // Set the bridge data for an input swap.
        bridgeData.sendingAssetId = address(weth);
        bridgeData.minAmount = amount;
        bridgeData.hasSourceSwaps = true;
        bridgeData.hasDestinationCall = true;

        // Initiate the intent
        lifiIntentEscrowFacet.swapAndStartBridgeTokensViaLiFiIntentEscrowV2{
            value: amount
        }(bridgeData, swapData, validLIFIIntentData);

        // Construct the output that matches this intent.
        // Committed output = realizedSwapOutput * multiplier / MULTIPLIER_BASE.
        // The wrap is 1:1 and multiplier is 1e18, so committed == amount.
        uint256 committedOutput = (amount *
            uint256(validLIFIIntentData.outputAmountMultiplier)) /
            MULTIPLIER_BASE;
        MandateOutput memory output = MandateOutput({
            oracle: validLIFIIntentData.outputOracle,
            settler: validLIFIIntentData.outputSettler,
            chainId: block.chainid,
            token: validLIFIIntentData.outputToken,
            amount: committedOutput,
            recipient: validLIFIIntentData.dstCallReceiver,
            callbackData: abi.encode(
                bridgeData.transactionId,
                validLIFIIntentData.dstCallSwapData,
                validLIFIIntentData.recipient
            ),
            context: validLIFIIntentData.outputContext
        });

        uint256 beforeExecutionBalance = bridgeData.receiver.balance;

        // Get us the fill tokens.
        TokenWrapper(tokenWrapper).deposit{ value: amount }();
        weth.approve(OUTPUT_SETTLER_COIN, type(uint256).max);

        // Fill the output. We don't really care about whether the intent is filled properly, just that it is filled and trigger the execution.
        OutputSettler(OUTPUT_SETTLER_COIN).fill(
            bytes32(0),
            output,
            type(uint48).max,
            abi.encode(address(this))
        );

        uint256 afterExecutionBalance = bridgeData.receiver.balance;

        assertEq(afterExecutionBalance - beforeExecutionBalance, amount);
    }
}
