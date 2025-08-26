// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { OutputValidator } from "lifi/Periphery/OutputValidator.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { MockUniswapDEX } from "../utils/MockUniswapDEX.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { TransferFromFailed, InvalidCallData } from "lifi/Errors/GenericErrors.sol";
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

    event TokensWithdrawn(
        address assetId,
        address payable receiver,
        uint256 amount
    );

    function setUp() public {
        // Initialize TestBase (creates diamond, etc.)
        initTestBase();

        // Deploy OutputValidator with owner parameter
        outputValidator = new OutputValidator(USER_DIAMOND_OWNER);

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
            outputValidator.validateNativeOutput.selector
        );
        cBridge.setFunctionApprovalBySignature(
            outputValidator.validateERC20Output.selector
        );

        // Label addresses for better test output
        vm.label(address(outputValidator), "OutputValidator");
        vm.label(validationWallet, "ValidationWallet");
        vm.label(address(cBridge), "CBridgeFacet");
        vm.label(address(mockDEX), "MockDEX");
    }

    // ============================ Original OutputValidator Tests ============================

    function test_validateOutputERC20WithExcess() public {
        vm.startPrank(address(diamond));

        // Arrange
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;
        uint256 excessOutput = actualAmount - expectedAmount;

        // Fund diamond with tokens
        deal(address(dai), address(diamond), actualAmount);

        // Approve OutputValidator to spend tokens from diamond
        dai.approve(address(outputValidator), excessOutput);

        // Act - call from diamond
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );

        // Assert
        assertEq(dai.balanceOf(validationWallet), excessOutput);
        assertEq(dai.balanceOf(address(diamond)), expectedAmount);

        vm.stopPrank();
    }

    function test_validateOutputERC20NoExcess() public {
        vm.startPrank(address(diamond));

        // Arrange
        uint256 expectedAmount = 1000 ether;
        uint256 actualAmount = 1000 ether;

        // Fund diamond with tokens
        deal(address(dai), address(diamond), actualAmount);

        // Approve OutputValidator to spend tokens from diamond
        dai.approve(address(outputValidator), actualAmount);

        // Act - call from diamond
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );

        // Assert
        assertEq(
            dai.balanceOf(validationWallet),
            0,
            "No excess tokens should be transferred"
        );
        assertEq(
            dai.balanceOf(address(diamond)),
            expectedAmount,
            "Should keep expected amount"
        );

        vm.stopPrank();
    }

    function testRevert_validateOutputERC20LessThanExpected() public {
        vm.startPrank(address(diamond));

        // Arrange - test case where actual amount is less than expected (should revert)
        uint256 expectedAmount = 1000 ether;
        uint256 actualAmount = 500 ether; // Less than expected

        // Fund diamond with tokens
        deal(address(dai), address(diamond), actualAmount);

        // Approve OutputValidator to spend tokens from diamond
        dai.approve(address(outputValidator), actualAmount);

        // Act - call from diamond
        vm.expectRevert(stdError.arithmeticError);
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );

        vm.stopPrank();
    }

    function test_validateOutputNativeWithExcessGreaterThanMsgValue() public {
        vm.startPrank(address(diamond));

        // Arrange
        uint256 expectedAmount = 5 ether;
        uint256 msgValue = 100 ether;

        // Fund diamond with some native tokens
        vm.deal(address(diamond), 200 ether);

        // Act - call with msg.value
        outputValidator.validateNativeOutput{ value: msgValue }(
            expectedAmount,
            validationWallet
        );

        // Assert - with logic: excessAmount = (0 + 100 + 10) - 5 = 105 ether
        // Since excessAmount (105) >= msg.value (100), we go to if branch:
        // - Send all 100 ether to validation wallet
        assertEq(
            validationWallet.balance,
            100 ether,
            "Validation wallet should receive all msg.value"
        );
        assertEq(
            address(diamond).balance,
            100 ether,
            "Sender should keep remaining balance"
        );
        assertEq(
            address(outputValidator).balance,
            0 ether,
            "OutputValidator should have no remaining balance"
        );

        vm.stopPrank();
    }

    function test_validateOutputNativeWithZeroExpectedAmount() public {
        vm.startPrank(address(diamond));

        // Arrange
        uint256 expectedAmount = 0;
        uint256 msgValue = 5 ether;

        // Fund diamond with some native tokens
        vm.deal(address(diamond), msgValue);

        // Act - call with msg.value
        outputValidator.validateNativeOutput{ value: msgValue }(
            expectedAmount,
            validationWallet
        );

        // Assert - all msg.value should go to validation wallet since expectedAmount is 0
        assertEq(
            validationWallet.balance,
            msgValue,
            "Validation wallet should receive all msg.value"
        );
        assertEq(
            address(diamond).balance,
            0,
            "Sender should keep remaining balance"
        );
        assertEq(
            address(outputValidator).balance,
            0,
            "OutputValidator should have no remaining balance"
        );

        vm.stopPrank();
    }

    function test_validateOutputNativeWithZeroMsgValue() public {
        vm.startPrank(address(diamond));

        // Arrange
        uint256 expectedAmount = 10 ether;
        uint256 msgValue = 0;

        // Fund diamond with some native tokens
        vm.deal(address(diamond), 200 ether);

        // Act - call with zero msg.value
        outputValidator.validateNativeOutput{ value: msgValue }(
            expectedAmount,
            validationWallet
        );

        // Assert - no tokens should be transferred since msg.value is 0
        assertEq(
            validationWallet.balance,
            0 ether,
            "Validation wallet should receive nothing"
        );
        assertEq(
            address(diamond).balance,
            200 ether,
            "Sender should keep all balance"
        );
        assertEq(
            address(outputValidator).balance,
            0 ether,
            "OutputValidator should have no remaining balance"
        );

        vm.stopPrank();
    }

    function testRevert_validateOutputERC20WithZeroWallet() public {
        vm.startPrank(address(diamond));

        // Arrange - test case where validationWalletAddress is address(0)
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;

        // Fund this test contract with tokens
        deal(address(dai), address(diamond), actualAmount);

        // Approve OutputValidator to spend tokens from this contract
        dai.approve(address(outputValidator), actualAmount);

        // Act & Assert - should revert when validationWalletAddress is address(0)
        vm.expectRevert(InvalidCallData.selector);
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            address(0) // This should trigger the revert
        );

        vm.stopPrank();
    }

    function test_validateOutputERC20WithZeroExpectedAmount() public {
        vm.startPrank(address(diamond));

        // Arrange - test case where expected amount is 0
        uint256 expectedAmount = 0;
        uint256 actualAmount = 1000 ether;

        // Fund diamond with tokens
        deal(address(dai), address(diamond), actualAmount);

        // Approve OutputValidator to spend tokens from this contract
        dai.approve(address(outputValidator), actualAmount);

        // Act - should succeed and transfer all tokens to validation wallet
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );

        // Assert - all tokens should be transferred to validation wallet
        assertEq(
            dai.balanceOf(validationWallet),
            actualAmount,
            "All tokens should be transferred to validation wallet"
        );
        assertEq(
            dai.balanceOf(address(diamond)),
            0,
            "Sender should have no tokens left"
        );

        vm.stopPrank();
    }

    function test_validateOutputERC20WithInsufficientAllowance() public {
        vm.startPrank(address(diamond));

        // Arrange
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;
        uint256 insufficientAllowance = 100 ether; // Less than excess amount

        // Fund diamond with tokens
        deal(address(dai), address(diamond), actualAmount);

        // Approve OutputValidator with insufficient allowance
        dai.approve(address(outputValidator), insufficientAllowance);

        // Act - call from diamond
        vm.expectRevert(TransferFromFailed.selector);
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );

        vm.stopPrank();
    }

    function test_validateOutputERC20WithZeroAllowance() public {
        vm.startPrank(address(diamond));

        // Arrange
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;

        // Fund diamond with tokens
        deal(address(dai), address(diamond), actualAmount);

        // Don't approve OutputValidator (zero allowance)

        // Act - call from diamond
        vm.expectRevert(TransferFromFailed.selector);
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );

        vm.stopPrank();
    }

    // ============================ Edge Cases ============================

    function test_validateOutputERC20WithMaxUint256ExpectedAmount() public {
        vm.startPrank(address(diamond));

        // Arrange - test with maximum uint256 value
        uint256 positiveSlippage = 20 * 10 ** dai.decimals();
        uint256 expectedAmount = type(uint256).max - positiveSlippage;
        uint256 actualAmount = type(uint256).max;

        // Fund diamond with tokens
        deal(address(dai), address(diamond), actualAmount);

        // Approve OutputValidator to spend tokens from diamond
        dai.approve(address(outputValidator), actualAmount);

        // Act - should succeed
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );

        // Assert - positive slippage tokens transferred to validation wallet due to underflow
        assertEq(dai.balanceOf(validationWallet), positiveSlippage);
        assertEq(dai.balanceOf(address(diamond)), expectedAmount);
        assertEq(dai.balanceOf(address(outputValidator)), 0);

        vm.stopPrank();
    }

    function test_validateOutputNativeWithMaxUint256ExpectedAmount() public {
        vm.startPrank(address(diamond));

        // Arrange - test with maximum uint256 value
        uint256 positiveSlippage = 20 ether;
        uint256 expectedAmount = type(uint256).max - positiveSlippage;
        uint256 actualAmount = type(uint256).max;

        // Fund diamond with some native tokens
        vm.deal(address(diamond), actualAmount);

        // Act - should succeed
        outputValidator.validateNativeOutput{ value: expectedAmount }(
            expectedAmount,
            validationWallet
        );

        // Assert - all msg.value should go to validation wallet due to underflow
        assertEq(validationWallet.balance, positiveSlippage);
        assertEq(address(diamond).balance, expectedAmount);
        assertEq(address(outputValidator).balance, 0);

        vm.stopPrank();
    }

    // ============================ Complex Integration Tests ============================

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
                outputValidator.validateERC20Output.selector,
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
                outputValidator.validateERC20Output.selector,
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
        // Note: All actual output will go to validation wallet with new logic

        // Fund MockDEX with native tokens so it can return them
        deal(address(mockDEX), actualOutputAmount);

        // Setup mock DEX to return more native output than expected
        mockDEX.setSwapOutput(
            inputAmount,
            ERC20(address(0)), // Native ETH (address(0) represents native token)
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
        // Only send the excess portion to OutputValidator
        uint256 excessPortionToValidator = 4 ether; // The excess portion
        swapData[1] = LibSwap.SwapData({
            callTo: address(outputValidator),
            approveTo: address(outputValidator),
            sendingAssetId: LibAsset.NULL_ADDRESS,
            receivingAssetId: LibAsset.NULL_ADDRESS,
            fromAmount: excessPortionToValidator,
            callData: abi.encodeWithSelector(
                outputValidator.validateNativeOutput.selector,
                0, // OutputValidator should send all received funds to validation wallet
                validationWallet
            ),
            requiresDeposit: false
        });

        // Setup bridge data for native tokens
        // Bridge should receive the expected amount (8 ETH), excess goes to OutputValidator
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("test-erc20-to-native"),
            bridge: "cbridge",
            integrator: "test-integrator",
            referrer: address(0),
            sendingAssetId: LibAsset.NULL_ADDRESS,
            receiver: USER_SENDER,
            minAmount: expectedOutputAmount, // Bridge expects the expected amount
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
        // OutputValidator receives 4 ETH and expectedAmount = 0
        // excessAmount = (0 + 4) - 0 = 4 ETH
        // Since 4 >= 4 (msg.value), all 4 ETH goes to validation wallet
        assertEq(
            validationWallet.balance,
            excessPortionToValidator,
            "Excess ETH should go to validation wallet"
        );

        // Verify user's input tokens were spent
        assertEq(
            usdc.balanceOf(USER_SENDER),
            0,
            "User should have spent all input tokens"
        );
    }

    // Needed to receive native tokens in tests
    receive() external payable {}
}
