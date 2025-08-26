// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { OutputValidator } from "lifi/Periphery/OutputValidator.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { MockUniswapDEX } from "../utils/MockUniswapDEX.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
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
        // Arrange
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;
        uint256 excessOutput = actualAmount - expectedAmount;

        // Fund this test contract (acting as the diamond) with tokens
        deal(address(dai), address(this), actualAmount);

        // Approve OutputValidator to spend tokens from this contract
        dai.approve(address(outputValidator), actualAmount);

        // Act - call from this contract (simulating diamond calling OutputValidator)
        outputValidator.validateERC20Output(
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
        outputValidator.validateERC20Output(
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
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );
    }

    function test_validateOutputNativeWithExcessGreaterThanMsgValue() public {
        // Arrange
        uint256 expectedAmount = 5 ether;
        uint256 msgValue = 10 ether;

        // Fund this test contract with some native tokens
        vm.deal(address(this), 20 ether);

        // Act - call with msg.value
        outputValidator.validateNativeOutput{ value: msgValue }(
            expectedAmount,
            validationWallet
        );

        // Assert - with logic: excessAmount = (0 + 10 + 10) - 5 = 15 ether
        // Since excessAmount (15) >= msg.value (10), we go to if branch:
        // - Send all 10 ether to validation wallet
        assertEq(
            validationWallet.balance,
            10 ether,
            "Validation wallet should receive all msg.value"
        );
        assertEq(
            address(this).balance,
            10 ether,
            "Sender should keep remaining balance"
        );
        assertEq(
            address(outputValidator).balance,
            0 ether,
            "OutputValidator should have no remaining balance"
        );
    }

    function test_validateOutputNativeWithZeroExpectedAmount() public {
        // Arrange
        uint256 expectedAmount = 0;
        uint256 msgValue = 5 ether;

        // Fund this test contract with some native tokens
        vm.deal(address(this), 20 ether);

        // Act - call with msg.value
        outputValidator.validateNativeOutput{ value: msgValue }(
            expectedAmount,
            validationWallet
        );

        // Assert - all msg.value should go to validation wallet since expectedAmount is 0
        assertEq(
            validationWallet.balance,
            5 ether,
            "Validation wallet should receive all msg.value"
        );
        assertEq(
            address(this).balance,
            15 ether,
            "Sender should keep remaining balance"
        );
        assertEq(
            address(outputValidator).balance,
            0 ether,
            "OutputValidator should have no remaining balance"
        );
    }

    function test_validateOutputNativeWithZeroMsgValue() public {
        // Arrange
        uint256 expectedAmount = 10 ether;
        uint256 msgValue = 0;

        // Fund this test contract with some native tokens
        vm.deal(address(this), 20 ether);

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
            address(this).balance,
            20 ether,
            "Sender should keep all balance"
        );
        assertEq(
            address(outputValidator).balance,
            0 ether,
            "OutputValidator should have no remaining balance"
        );
    }

    function testRevert_validateOutputERC20WithZeroWallet() public {
        // Arrange - test case where validationWalletAddress is address(0)
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;

        // Fund this test contract with tokens
        deal(address(dai), address(this), actualAmount);

        // Approve OutputValidator to spend tokens from this contract
        dai.approve(address(outputValidator), actualAmount);

        // Act & Assert - should revert when validationWalletAddress is address(0)
        vm.expectRevert(InvalidCallData.selector);
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            address(0) // This should trigger the revert
        );
    }

    function test_validateOutputERC20WithZeroExpectedAmount() public {
        // Arrange - test case where expected amount is 0
        uint256 expectedAmount = 0;
        uint256 actualAmount = 1000 ether;

        // Fund this test contract with tokens
        deal(address(dai), address(this), actualAmount);

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
            dai.balanceOf(address(this)),
            0,
            "Sender should have no tokens left"
        );
    }

    function test_validateOutputERC20WithInsufficientAllowance() public {
        // Arrange
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;
        uint256 insufficientAllowance = 100 ether; // Less than excess amount

        // Fund this test contract with tokens
        deal(address(dai), address(this), actualAmount);

        // Approve OutputValidator with insufficient allowance
        dai.approve(address(outputValidator), insufficientAllowance);

        // Act & Assert - should revert due to insufficient allowance
        vm.expectRevert(TransferFromFailed.selector);
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );
    }

    function test_validateOutputERC20WithZeroAllowance() public {
        // Arrange
        uint256 expectedAmount = 100 ether;
        uint256 actualAmount = 800 ether;

        // Fund this test contract with tokens
        deal(address(dai), address(this), actualAmount);

        // Don't approve OutputValidator (zero allowance)

        // Act & Assert - should revert due to zero allowance
        vm.expectRevert(TransferFromFailed.selector);
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );
    }

    // ============================ Integration Tests ============================

    function test_CompleteSwapAndValidationFlowERC20ToERC20() public {
        vm.startPrank(address(diamond));

        // Arrange - simulate a complete swap flow
        uint256 expectedOutput = 800 ether;
        uint256 actualOutput = 950 ether; // Positive slippage

        // Simulate swap execution (MockDEX would normally do this)
        deal(address(usdc), address(diamond), actualOutput);

        // Approve OutputValidator to spend excess tokens
        usdc.approve(address(outputValidator), actualOutput);

        // Act - validate the output
        outputValidator.validateERC20Output(
            address(usdc),
            expectedOutput,
            validationWallet
        );

        // Assert
        uint256 excessAmount = actualOutput - expectedOutput;
        assertEq(usdc.balanceOf(validationWallet), excessAmount);
        assertEq(usdc.balanceOf(address(diamond)), expectedOutput);

        vm.stopPrank();
    }

    function test_CompleteSwapAndValidationFlowERC20ToNative() public {
        vm.startPrank(address(diamond));

        // Arrange - simulate ERC20 to native swap
        uint256 expectedOutput = 0.5 ether;
        uint256 actualOutput = 0.6 ether; // Positive slippage

        // Simulate swap execution
        vm.deal(address(diamond), actualOutput);

        // Act - validate the output
        outputValidator.validateNativeOutput{ value: expectedOutput }(
            expectedOutput,
            validationWallet
        );

        // Assert
        uint256 excessAmount = actualOutput - expectedOutput;
        assertEq(validationWallet.balance, excessAmount);
        assertEq(address(diamond).balance, expectedOutput);

        vm.stopPrank();
    }

    function test_CompleteSwapAndValidationFlowNativeToERC20() public {
        vm.startPrank(address(diamond));

        // Arrange - simulate native to ERC20 swap
        uint256 swapAmount = 1 ether;
        uint256 expectedOutput = 1800 ether;
        uint256 actualOutput = 2000 ether; // Positive slippage

        // Fund the diamond with input tokens
        vm.deal(address(diamond), swapAmount);

        // Simulate swap execution
        deal(address(dai), address(diamond), actualOutput);

        // Approve OutputValidator to spend excess tokens
        dai.approve(address(outputValidator), actualOutput);

        // Act - validate the output
        outputValidator.validateERC20Output(
            address(dai),
            expectedOutput,
            validationWallet
        );

        // Assert
        uint256 excessAmount = actualOutput - expectedOutput;
        assertEq(dai.balanceOf(validationWallet), excessAmount);
        assertEq(dai.balanceOf(address(diamond)), expectedOutput);

        vm.stopPrank();
    }

    // ============================ Edge Cases ============================

    function test_validateOutputERC20WithMaxUint256ExpectedAmount() public {
        // Arrange - test with maximum uint256 value
        uint256 expectedAmount = type(uint256).max;
        uint256 actualAmount = type(uint256).max;

        // Fund this test contract with tokens
        deal(address(dai), address(this), actualAmount);

        // Approve OutputValidator to spend tokens from this contract
        dai.approve(address(outputValidator), actualAmount);

        // Act - should succeed with no excess
        outputValidator.validateERC20Output(
            address(dai),
            expectedAmount,
            validationWallet
        );

        // Assert - no excess tokens transferred
        assertEq(dai.balanceOf(validationWallet), 0);
        assertEq(dai.balanceOf(address(this)), expectedAmount);
    }

    function test_validateOutputNativeWithMaxUint256ExpectedAmount() public {
        vm.startPrank(address(diamond));

        // Arrange - test with maximum uint256 value
        uint256 positiveSlippage = 20 ether;
        uint256 expectedAmount = type(uint256).max - positiveSlippage;
        uint256 actualAmount = type(uint256).max;

        // Fund this test contract with some native tokens
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

    // Needed to receive native tokens in tests
    receive() external payable {}
}
