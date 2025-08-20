// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { OutputValidator } from "lifi/Periphery/OutputValidator.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { MockUniswapDEX } from "../utils/MockUniswapDEX.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ETHTransferFailed, TransferFromFailed, InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { stdError } from "forge-std/StdError.sol";

// Stub CBridgeFacet Contract
contract TestCBridgeFacet is CBridgeFacet {
    constructor(ICBridge _cBridge) CBridgeFacet(_cBridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract OutputValidatorTest is TestBase {
    address internal constant CBRIDGE_ROUTER =
        0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820; // mainnet

    OutputValidator private outputValidator;
    address private validationWallet;
    TestCBridgeFacet private cBridge;
    MockUniswapDEX private mockDEX;

    function setUp() public {
        // Initialize TestBase (creates diamond, etc.)
        initTestBase();

        // Deploy OutputValidator
        outputValidator = new OutputValidator(address(this));

        // Setup validation wallet
        validationWallet = address(0x5678);

        // Deploy CBridge facet
        cBridge = new TestCBridgeFacet(ICBridge(CBRIDGE_ROUTER));
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = cBridge.startBridgeTokensViaCBridge.selector;
        functionSelectors[1] = cBridge
            .swapAndStartBridgeTokensViaCBridge
            .selector;
        functionSelectors[2] = cBridge.addDex.selector;
        functionSelectors[3] = cBridge.setFunctionApprovalBySignature.selector;
        functionSelectors[4] = cBridge.triggerRefund.selector;

        addFacet(diamond, address(cBridge), functionSelectors);
        cBridge = TestCBridgeFacet(address(diamond));

        // Deploy and setup MockDEX
        mockDEX = new MockUniswapDEX();

        // Whitelist MockDEX in the diamond using CBridge facet
        cBridge.addDex(address(mockDEX));
        cBridge.setFunctionApprovalBySignature(
            mockDEX.swapExactTokensForTokens.selector
        );
        cBridge.setFunctionApprovalBySignature(
            mockDEX.swapExactTokensForETH.selector
        );
        cBridge.setFunctionApprovalBySignature(
            mockDEX.swapExactETHForTokens.selector
        );

        // Whitelist OutputValidator in the diamond
        cBridge.addDex(address(outputValidator));
        cBridge.setFunctionApprovalBySignature(
            outputValidator.validateOutput.selector
        );

        // Label addresses for better test output
        vm.label(address(outputValidator), "OutputValidator");
        vm.label(validationWallet, "ValidationWallet");
        vm.label(address(cBridge), "CBridgeFacet");
        vm.label(address(mockDEX), "MockDEX");
    }

    function test_validateOutputERC20WithExcess() public {
        // Arrange
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;
        uint256 excessOutput = actualAmount - expectedAmount;

        // Fund this test contract (acting as the diamond) with tokens
        deal(address(dai), address(this), actualAmount);

        // Approve OutputValidator to spend tokens from this contract
        dai.approve(address(outputValidator), actualAmount);

        // Act - call from this contract (simulating diamond calling OutputValidator)
        outputValidator.validateOutput(
            address(dai),
            expectedAmount,
            validationWallet
        );

        // Assert
        assertEq(dai.balanceOf(validationWallet), excessOutput);
        assertEq(dai.balanceOf(address(this)), expectedAmount);
    }

    function test_validateOutputERC20NoExcess() public {
        // Arrange - test case where actual amount equals expected
        uint256 expectedAmount = 1000 ether;
        uint256 actualAmount = 1000 ether;

        // Fund this test contract with tokens
        deal(address(dai), address(this), actualAmount);

        // Approve OutputValidator to spend tokens from this contract
        dai.approve(address(outputValidator), actualAmount);

        // Act - should succeed and transfer 0 excess tokens
        outputValidator.validateOutput(
            address(dai),
            expectedAmount,
            validationWallet
        );

        // Assert - no excess tokens transferred
        assertEq(
            dai.balanceOf(validationWallet),
            0,
            "No excess tokens should be transferred"
        );
        assertEq(
            dai.balanceOf(address(this)),
            expectedAmount,
            "Should keep expected amount"
        );
    }

    function testRevert_validateOutputERC20LessThanExpected() public {
        // Arrange - test case where actual amount is less than expected (should revert)
        uint256 expectedAmount = 1000 ether;
        uint256 actualAmount = 500 ether; // Less than expected

        // Fund this test contract with tokens
        deal(address(dai), address(this), actualAmount);

        // Approve OutputValidator to spend tokens from this contract
        dai.approve(address(outputValidator), actualAmount);

        // Act & Assert - should revert when actualAmount < expectedAmount (underflow)
        vm.expectRevert(stdError.arithmeticError);
        outputValidator.validateOutput(
            address(dai),
            expectedAmount,
            validationWallet
        );
    }

    function test_validateOutputNativeWithExcess() public {
        // Arrange
        uint256 expectedAmount = 7 ether;
        uint256 actualAmount = 10 ether;
        uint256 excessOutput = actualAmount - expectedAmount;

        // Fund this test contract (acting as the diamond) with native tokens
        vm.deal(address(this), actualAmount);

        // Act - call from this contract (simulating diamond calling OutputValidator)
        // Send the actual amount as msg.value for native tokens
        outputValidator.validateOutput{ value: actualAmount }(
            LibAsset.NULL_ADDRESS,
            expectedAmount,
            validationWallet
        );

        // Assert
        assertEq(validationWallet.balance, excessOutput);
        assertEq(address(this).balance, expectedAmount);
    }

    function test_validateOutputNativeNoExcess() public {
        // Arrange - test case where actual amount equals expected (transfers 0 tokens)
        uint256 expectedAmount = 10 ether;
        uint256 actualAmount = 10 ether;

        // Fund this test contract with native tokens
        vm.deal(address(this), actualAmount);

        // Act - should succeed and transfer 0 excess tokens
        outputValidator.validateOutput{ value: actualAmount }(
            LibAsset.NULL_ADDRESS,
            expectedAmount,
            validationWallet
        );

        // Assert - no excess tokens transferred, expectedAmount returned to caller
        assertEq(
            validationWallet.balance,
            0,
            "No excess tokens should be transferred"
        );
        assertEq(
            address(this).balance,
            expectedAmount,
            "Should receive expected amount back"
        );
    }

    function test_validateOutputNativeLessThanExpected() public {
        // Arrange - test case where actual amount is less than expected (should revert)
        uint256 expectedAmount = 10 ether;
        uint256 actualAmount = 5 ether; // Less than expected

        // Fund this test contract with native tokens
        vm.deal(address(this), actualAmount);

        // Act & Assert - should revert when trying to return expectedAmount but insufficient value was sent
        vm.expectRevert(ETHTransferFailed.selector);
        outputValidator.validateOutput{ value: actualAmount }(
            LibAsset.NULL_ADDRESS,
            expectedAmount,
            validationWallet
        );
    }

    function test_validateOutputWithZeroExpectedAmountERC20() public {
        // this is an error case. However, in order to save gas we do not validate the expected amount.
        // This test is to make sure that funds are not lost for ERC20 tokens.

        // Arrange
        uint256 expectedAmount = 0;
        uint256 actualAmount = 1000 * 10 ** dai.decimals();

        // Fund this test contract (acting as the diamond) with tokens
        deal(address(dai), address(this), actualAmount);

        // Approve OutputValidator to spend tokens from this contract
        dai.approve(address(outputValidator), actualAmount);

        // Act - call from this contract (simulating diamond calling OutputValidator)
        outputValidator.validateOutput(
            address(dai),
            expectedAmount,
            validationWallet
        );

        // Assert - should transfer all tokens since expected is 0
        assertEq(dai.balanceOf(validationWallet), actualAmount);
        assertEq(dai.balanceOf(address(this)), expectedAmount);
    }

    function test_validateOutputWithZeroExpectedAmountNative() public {
        // this is an error case. However, in order to save gas we do not validate the expected amount.
        // This test is to make sure that funds are not lost for native tokens.

        // Arrange
        uint256 expectedAmount = 0;
        uint256 actualAmount = 1000 ether;

        // Fund this test contract (acting as the diamond) with native tokens
        vm.deal(address(this), actualAmount);

        // Act - call from this contract (simulating diamond calling OutputValidator)
        // Send the actual amount as msg.value for native tokens
        outputValidator.validateOutput{ value: actualAmount }(
            LibAsset.NULL_ADDRESS,
            expectedAmount,
            validationWallet
        );

        // Assert - should transfer all tokens since expected is 0
        assertEq(validationWallet.balance, actualAmount);
        assertEq(address(this).balance, expectedAmount);
    }

    function test_validateOutputAfterERC20ToERC20SwapWithPositiveSlippage()
        public
    {
        // Arrange - setup DEX and bridge data for a complete transaction flow
        uint256 inputAmount = 1000 * 10 ** usdc.decimals();
        uint256 expectedOutputAmount = 800 * 10 ** dai.decimals();
        uint256 actualOutputAmount = 1200 * 10 ** dai.decimals();
        uint256 excessOutput = actualOutputAmount - expectedOutputAmount;

        // Fund MockDEX with output tokens so it can return them
        deal(address(dai), address(mockDEX), actualOutputAmount);

        // Setup mock DEX to return more output than expected
        mockDEX.setSwapOutput(inputAmount, dai, actualOutputAmount);

        // Create DEX swap data
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);

        // First swap: DEX swap with positive slippage
        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = address(dai);

        swapData[0] = LibSwap.SwapData({
            callTo: address(mockDEX),
            approveTo: address(mockDEX),
            sendingAssetId: address(usdc),
            receivingAssetId: address(dai),
            fromAmount: inputAmount,
            callData: abi.encodeWithSelector(
                mockDEX.swapExactTokensForTokens.selector,
                inputAmount,
                expectedOutputAmount, // minAmountOut
                path,
                address(diamond),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });

        // Second swap: OutputValidator to collect excess
        swapData[1] = LibSwap.SwapData({
            callTo: address(outputValidator),
            approveTo: address(outputValidator),
            sendingAssetId: address(dai),
            receivingAssetId: address(dai),
            fromAmount: actualOutputAmount,
            callData: abi.encodeWithSelector(
                outputValidator.validateOutput.selector,
                address(dai),
                expectedOutputAmount,
                validationWallet
            ),
            requiresDeposit: false
        });

        // Setup bridge data (using CBridge for simplicity)
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("test"),
            bridge: "cbridge",
            integrator: "test-integrator",
            referrer: address(0),
            sendingAssetId: address(dai),
            receiver: address(this),
            minAmount: expectedOutputAmount,
            destinationChainId: 137, // Polygon
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        // CBridge specific data
        CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet
            .CBridgeData({ maxSlippage: 5000, nonce: 1 });

        // Fund the user with input tokens
        deal(address(usdc), USER_SENDER, inputAmount);
        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), inputAmount);

        // Act - execute the complete transaction with DEX swap + output validation + bridge
        cBridge.swapAndStartBridgeTokensViaCBridge(
            bridgeData,
            swapData,
            cBridgeData
        );
        vm.stopPrank();

        // Assert - verify the excess was collected
        assertEq(
            dai.balanceOf(validationWallet),
            excessOutput,
            "Excess should be in validation wallet"
        );

        // Verify user's input tokens were spent
        assertEq(
            usdc.balanceOf(USER_SENDER),
            0,
            "User should have spent all input tokens"
        );
    }

    function test_validateOutputAfterNativeToERC20SwapWithPositiveSlippage()
        public
    {
        // Arrange - setup DEX and bridge data for Native to ERC20 swap flow
        uint256 inputAmount = 10 * 10 ** 18; // 10 ETH (18 decimals)
        uint256 expectedOutputAmount = 800 * 10 ** 6; // 800 USDC (6 decimals)
        uint256 actualOutputAmount = 1200 * 10 ** 6; // 1200 USDC (6 decimals) - Positive slippage from DEX
        uint256 excessOutput = actualOutputAmount - expectedOutputAmount; // 400 USDC excess

        // Fund MockDEX with USDC so it can return them
        deal(address(usdc), address(mockDEX), actualOutputAmount);

        // Setup mock DEX to return more USDC output than expected
        mockDEX.setSwapOutput(inputAmount, usdc, actualOutputAmount);

        // Create DEX swap data for Native to ERC20
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);

        // First swap: DEX swap ETH -> USDC with positive slippage
        address[] memory path = new address[](2);
        path[0] = address(weth); // MockDEX expects WETH but we send native ETH
        path[1] = address(usdc);

        swapData[0] = LibSwap.SwapData({
            callTo: address(mockDEX),
            approveTo: address(mockDEX),
            sendingAssetId: LibAsset.NULL_ADDRESS, // Native ETH
            receivingAssetId: address(usdc),
            fromAmount: inputAmount,
            callData: abi.encodeWithSelector(
                mockDEX.swapExactETHForTokens.selector,
                expectedOutputAmount, // minAmountOut
                path,
                address(diamond),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });

        // Second swap: OutputValidator to collect excess USDC tokens
        swapData[1] = LibSwap.SwapData({
            callTo: address(outputValidator),
            approveTo: address(outputValidator),
            sendingAssetId: address(usdc),
            receivingAssetId: address(usdc),
            fromAmount: actualOutputAmount,
            callData: abi.encodeWithSelector(
                outputValidator.validateOutput.selector,
                address(usdc),
                expectedOutputAmount,
                validationWallet
            ),
            requiresDeposit: false
        });

        // Setup bridge data for USDC tokens
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("test-native-to-erc20"),
            bridge: "cbridge",
            integrator: "test-integrator",
            referrer: address(0),
            sendingAssetId: address(usdc),
            receiver: USER_SENDER,
            minAmount: expectedOutputAmount,
            destinationChainId: 137, // Polygon
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        // CBridge specific data
        CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet
            .CBridgeData({ maxSlippage: 5000, nonce: 4 });

        // Fund the user with input native tokens
        vm.deal(USER_SENDER, inputAmount);
        vm.startPrank(USER_SENDER);

        // Act - execute the complete transaction with DEX swap + output validation + bridge
        cBridge.swapAndStartBridgeTokensViaCBridge{ value: inputAmount }(
            bridgeData,
            swapData,
            cBridgeData
        );
        vm.stopPrank();

        // Assert - verify the excess USDC tokens were collected
        assertEq(
            usdc.balanceOf(validationWallet),
            excessOutput,
            "Excess USDC tokens should be in validation wallet"
        );

        // Verify user's input native tokens were spent
        assertEq(
            USER_SENDER.balance,
            0,
            "User should have spent all input ETH"
        );
    }

    function test_validateOutputAfterERC20ToNativeSwapWithPositiveSlippage()
        public
    {
        // Arrange - setup DEX and bridge data for ERC20 to Native swap flow
        uint256 inputAmount = 1000 * 10 ** usdc.decimals(); // 1000 USDC (6 decimals)
        uint256 expectedOutputAmount = 8 * 10 ** 18; // 8 ETH (18 decimals)
        uint256 actualOutputAmount = 12 * 10 ** 18; // 12 ETH (18 decimals) - Positive slippage from DEX
        uint256 excessOutput = actualOutputAmount - expectedOutputAmount; // 4 ETH excess

        // Fund MockDEX with native tokens so it can return them
        deal(address(mockDEX), actualOutputAmount);

        // Setup mock DEX to return more native output than expected
        mockDEX.setSwapOutput(
            inputAmount,
            ERC20(address(0)),
            actualOutputAmount
        );

        // Create DEX swap data for ERC20 to Native
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);

        // First swap: DEX swap USDC -> ETH with positive slippage
        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = address(weth); // MockDEX expects WETH but will convert to native

        swapData[0] = LibSwap.SwapData({
            callTo: address(mockDEX),
            approveTo: address(mockDEX),
            sendingAssetId: address(usdc),
            receivingAssetId: LibAsset.NULL_ADDRESS, // Native ETH
            fromAmount: inputAmount,
            callData: abi.encodeWithSelector(
                mockDEX.swapExactTokensForETH.selector,
                inputAmount,
                expectedOutputAmount, // minAmountOut
                path,
                address(diamond),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });

        // Second swap: OutputValidator to collect excess native tokens
        swapData[1] = LibSwap.SwapData({
            callTo: address(outputValidator),
            approveTo: address(outputValidator),
            sendingAssetId: LibAsset.NULL_ADDRESS,
            receivingAssetId: LibAsset.NULL_ADDRESS,
            fromAmount: actualOutputAmount, // Send the actual amount as msg.value
            callData: abi.encodeWithSelector(
                outputValidator.validateOutput.selector,
                LibAsset.NULL_ADDRESS,
                expectedOutputAmount,
                validationWallet
            ),
            requiresDeposit: false
        });

        // Setup bridge data for native tokens
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("test-erc20-to-native"),
            bridge: "cbridge",
            integrator: "test-integrator",
            referrer: address(0),
            sendingAssetId: LibAsset.NULL_ADDRESS,
            receiver: USER_SENDER,
            minAmount: expectedOutputAmount,
            destinationChainId: 137, // Polygon
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        // CBridge specific data
        CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet
            .CBridgeData({ maxSlippage: 5000, nonce: 3 });

        // Fund the user with input tokens
        deal(address(usdc), USER_SENDER, inputAmount);
        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), inputAmount);

        // Act - execute the complete transaction with DEX swap + output validation + bridge
        cBridge.swapAndStartBridgeTokensViaCBridge(
            bridgeData,
            swapData,
            cBridgeData
        );
        vm.stopPrank();

        // Assert - verify the excess native tokens were collected
        assertEq(
            validationWallet.balance,
            excessOutput,
            "Excess native tokens should be in validation wallet"
        );

        // Verify user's input tokens were spent
        assertEq(
            usdc.balanceOf(USER_SENDER),
            0,
            "User should have spent all input tokens"
        );
    }

    // Negative test cases
    function testRevert_validateOutputNativeTokensWithoutValue() public {
        // Arrange - try to validate native tokens without sending value
        uint256 expectedAmount = 100 ether;

        // Act & Assert - should revert when no value is sent for native tokens
        vm.expectRevert(ETHTransferFailed.selector);
        outputValidator.validateOutput(
            LibAsset.NULL_ADDRESS,
            expectedAmount,
            validationWallet
        );
    }

    function testRevert_validateOutputERC20InsufficientBalance() public {
        // Arrange - test case where balance is less than expected (should revert)
        uint256 expectedAmount = 1000 ether;
        uint256 actualBalance = 500 ether; // Less than expected

        deal(address(dai), address(this), actualBalance);
        dai.approve(address(outputValidator), actualBalance);

        // Act & Assert - should revert when actualBalance <= expectedAmount
        vm.expectRevert(stdError.arithmeticError);
        outputValidator.validateOutput(
            address(dai),
            expectedAmount,
            validationWallet
        );
    }

    function testRevert_validateOutputERC20InsufficientAllowance() public {
        // Arrange - test contract has balance but insufficient allowance
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;

        deal(address(dai), address(this), actualAmount);
        dai.approve(address(outputValidator), expectedAmount - 1);

        // Act & Assert - should revert when allowance is insufficient for excess transfer
        vm.expectRevert(TransferFromFailed.selector);
        outputValidator.validateOutput(
            address(dai),
            expectedAmount,
            validationWallet
        );
    }

    function testRevert_validateOutputERC20NoAllowance() public {
        // Arrange - test contract has balance but no allowance
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;

        deal(address(dai), address(this), actualAmount);
        // No approve call - allowance is 0

        // Act & Assert - should revert when no allowance is given
        vm.expectRevert(TransferFromFailed.selector);
        outputValidator.validateOutput(
            address(dai),
            expectedAmount,
            validationWallet
        );
    }

    function testRevert_validateOutputNativeTransferToInvalidAddress() public {
        // Arrange - try to send native tokens to an invalid contract that doesn't accept ETH
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;

        InvalidReceiver invalidReceiver = new InvalidReceiver();

        vm.deal(address(this), actualAmount);

        // Act & Assert - should revert when native transfer fails
        vm.expectRevert(ETHTransferFailed.selector);
        outputValidator.validateOutput{ value: actualAmount }(
            LibAsset.NULL_ADDRESS,
            expectedAmount,
            address(invalidReceiver)
        );
    }

    function testRevert_validateOutputWithZeroActualAmountButExpectedAmount()
        public
    {
        // Arrange - send zero value but expect non-zero amount (should fail)
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 0;

        vm.deal(address(this), actualAmount);

        // Act & Assert - should revert when trying to return expectedAmount but no value was received
        vm.expectRevert(ETHTransferFailed.selector);
        outputValidator.validateOutput{ value: actualAmount }(
            LibAsset.NULL_ADDRESS,
            expectedAmount,
            validationWallet
        );
    }

    function test_validateOutputWithZeroBothAmounts() public {
        // Arrange - send zero value and expect zero amount (transfers 0 tokens)
        uint256 expectedAmount = 0;
        uint256 actualAmount = 0;
        uint256 initialBalance = address(this).balance;

        // Act - should succeed and transfer 0 excess tokens
        outputValidator.validateOutput{ value: actualAmount }(
            LibAsset.NULL_ADDRESS,
            expectedAmount,
            validationWallet
        );

        // Assert - no tokens transferred since both amounts are zero
        assertEq(
            validationWallet.balance,
            0,
            "No excess tokens should be transferred"
        );
        assertEq(
            address(this).balance,
            initialBalance,
            "Should receive expected amount (0) back"
        );
    }

    function testRevert_validateOutputERC20WithZeroBalance() public {
        // Arrange - test contract has zero ERC20 balance (should revert)
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 0;

        deal(address(dai), address(this), actualAmount);

        dai.approve(address(outputValidator), actualAmount);

        // Act & Assert - should revert when actualAmount <= expectedAmount
        vm.expectRevert(stdError.arithmeticError);
        outputValidator.validateOutput(
            address(dai),
            expectedAmount,
            validationWallet
        );
    }

    function testRevert_constructorWithNullOwner() public {
        // Act & Assert - should revert when trying to deploy with null owner
        vm.expectRevert(InvalidCallData.selector);
        new OutputValidator(address(0));
    }

    // Needed to receive native tokens in tests
    receive() external payable {}
}

// Contract that rejects ETH transfers to test native transfer failures
contract InvalidReceiver {
    // No receive() or fallback() function - will reject ETH transfers
}
