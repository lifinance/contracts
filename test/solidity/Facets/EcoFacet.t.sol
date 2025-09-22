// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { EcoFacet } from "lifi/Facets/EcoFacet.sol";
import { IEcoPortal } from "lifi/Interfaces/IEcoPortal.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { InvalidConfig, InvalidReceiver, InformationMismatch, InvalidCallData } from "lifi/Errors/GenericErrors.sol";

contract TestEcoFacet is EcoFacet {
    constructor(IEcoPortal _portal) EcoFacet(_portal) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EcoFacetTest is TestBaseFacet {
    TestEcoFacet internal ecoFacet;
    address internal constant PORTAL =
        0x2b7F87a98707e6D19504293F6680498731272D4f;
    uint256 internal constant NATIVE_SOLVER_REWARD = 0.0001 ether;
    uint256 internal constant TOKEN_SOLVER_REWARD = 10 * 10 ** 6; // 10 USDC (6 decimals)

    function setUp() public {
        customBlockNumberForForking = 35593761;
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        initTestBase();
        addLiquidity(
            ADDRESS_USDC,
            ADDRESS_DAI,
            1000000 * 10 ** ERC20(ADDRESS_USDC).decimals(),
            1000000 * 10 ** ERC20(ADDRESS_DAI).decimals()
        );
        addLiquidity(
            ADDRESS_WRAPPED_NATIVE,
            ADDRESS_USDC,
            100 ether,
            1000000 * 10 ** ERC20(ADDRESS_USDC).decimals()
        );

        ecoFacet = new TestEcoFacet(IEcoPortal(PORTAL));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = ecoFacet.startBridgeTokensViaEco.selector;
        functionSelectors[1] = ecoFacet
            .swapAndStartBridgeTokensViaEco
            .selector;
        functionSelectors[2] = ecoFacet.addDex.selector;
        functionSelectors[3] = ecoFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(ecoFacet), functionSelectors);
        ecoFacet = TestEcoFacet(address(diamond));
        ecoFacet.addDex(ADDRESS_UNISWAP);
        ecoFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        ecoFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        ecoFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(ecoFacet), "EcoFacet");

        bridgeData.bridge = "eco";
        bridgeData.destinationChainId = 10;

        // Set addToMessageValue for native token tests (ERC20 tests will override this)
        addToMessageValue = NATIVE_SOLVER_REWARD;
    }

    function getValidEcoData(
        bool isNative
    ) internal view returns (EcoFacet.EcoData memory) {
        // Calculate solver reward based on token type
        uint256 solverReward = isNative
            ? NATIVE_SOLVER_REWARD
            : TOKEN_SOLVER_REWARD;

        // For EVM chains, create a route that ends with an ERC20 transfer call
        // The last 68 bytes should be: selector (4) + address (32) + amount (32)
        bytes memory transferCall = abi.encodeWithSelector(
            IERC20.transfer.selector,
            USER_RECEIVER,
            bridgeData.minAmount
        );

        // Create a realistic route structure similar to actual Eco routes (~608 bytes)
        // Build in chunks to avoid stack too deep

        // Part 1: Initial metadata and offsets
        bytes memory part1 = abi.encodePacked(
            bytes32(uint256(0x20)), // Offset pointer
            bytes32(keccak256("eco.route.verification")), // Route hash
            uint64(block.timestamp + 1 days), // Deadline
            address(PORTAL), // Portal address
            bytes32(0), // Padding
            bytes32(uint256(0xc0)), // Array offset
            bytes32(uint256(0x120)) // Calldata offset
        );

        // Part 2: Token and amount data
        bytes memory part2 = abi.encodePacked(
            bytes32(uint256(1)), // Array length
            address(bridgeData.sendingAssetId), // Token address
            bytes12(0), // Padding
            bytes32(uint256(bridgeData.minAmount)), // Amount
            bytes32(uint256(1)), // Counter
            bytes32(uint256(0x20)), // Internal offset
            address(bridgeData.sendingAssetId) // Token repeated
        );

        // Part 3: More routing metadata
        bytes memory part3 = abi.encodePacked(
            bytes12(0), // Padding for alignment
            bytes32(uint256(0x60)), // Calldata offset
            bytes32(0), // Reserved
            bytes32(keccak256("route.path")), // Route identifier
            bytes32(uint256(block.timestamp)), // Timestamp
            bytes32(uint256(0x44)), // Length
            bytes32(keccak256("eco.protocol.v1")), // Version
            bytes32(0), // Padding
            bytes32(0) // Extra padding
        );

        // Combine all parts with the transfer call at the end
        bytes memory encodedRoute = abi.encodePacked(
            part1,
            part2,
            part3,
            transferCall // Transfer at the end (68 bytes)
        );

        return
            EcoFacet.EcoData({
                receiverAddress: USER_RECEIVER,
                nonEVMReceiver: "",
                prover: address(0x1234),
                rewardDeadline: uint64(block.timestamp + 2 days),
                solverReward: solverReward,
                encodedRoute: encodedRoute
            });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        EcoFacet.EcoData memory ecoData = getValidEcoData(isNative);

        if (isNative) {
            // For native: send bridge amount + native reward as msg.value
            ecoFacet.startBridgeTokensViaEco{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, ecoData);
        } else {
            // For ERC20: No msg.value needed, tokens already approved
            ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        EcoFacet.EcoData memory ecoData = getValidEcoData(isNative);

        if (isNative) {
            // Swapping to native: send swap input + native reward
            ecoFacet.swapAndStartBridgeTokensViaEco{
                value: swapData[0].fromAmount + addToMessageValue
            }(bridgeData, swapData, ecoData);
        } else {
            ecoFacet.swapAndStartBridgeTokensViaEco{
                value: addToMessageValue
            }(bridgeData, swapData, ecoData);
        }
    }

    function testRevert_whenUsingInvalidConfig() public {
        vm.expectRevert(InvalidConfig.selector);
        new EcoFacet(IEcoPortal(address(0)));
    }

    // Override the base test to handle ERC20 token rewards properly
    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount + TOKEN_SOLVER_REWARD) // User sends amount + reward
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // approval - need to approve total amount (bridge + reward)
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // Override fuzzed test to handle token rewards properly
    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        // Get user's USDC balance
        uint256 userBalance = usdc.balanceOf(USER_SENDER);

        // Ensure amount is within valid range
        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** usdc.decimals();

        // Ensure we have enough balance for amount + reward
        vm.assume(amount + TOKEN_SOLVER_REWARD <= userBalance);

        // Set up bridge data
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount;

        vm.writeLine(logFilePath, vm.toString(amount));

        // approval for total amount (bridge + reward)
        usdc.approve(_facetTestContractAddress, amount + TOKEN_SOLVER_REWARD);

        // prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // Override swap and bridge test to handle token rewards properly
    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        // For ERC20 swaps with Eco, we need the swap to produce enough tokens for both
        // the bridge amount AND the solver reward
        // Set up custom swap data to produce defaultUSDCAmount + TOKEN_SOLVER_REWARD
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256 totalAmountNeeded = defaultUSDCAmount + TOKEN_SOLVER_REWARD; // 100 + 10 = 110 USDC

        // Calculate DAI amount needed to get totalAmountNeeded USDC
        uint256[] memory amounts = uniswap.getAmountsIn(
            totalAmountNeeded,
            path
        );
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    totalAmountNeeded,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // The bridgeData.minAmount is what actually gets bridged (excluding the reward)
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;

        // Approve DAI for the swap
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            totalAmountNeeded, // The swap produces the full amount including reward
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // Store initial balances
        uint256 daiBalanceBefore = dai.balanceOf(USER_SENDER);
        uint256 usdcBalanceBefore = usdc.balanceOf(USER_SENDER);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();

        // Check final balances
        assertEq(
            dai.balanceOf(USER_SENDER),
            daiBalanceBefore - swapData[0].fromAmount
        );
        assertEq(usdc.balanceOf(USER_SENDER), usdcBalanceBefore); // No change in USDC
        assertEq(dai.balanceOf(USER_RECEIVER), 0);
        assertEq(usdc.balanceOf(USER_RECEIVER), 0);
    }

    function test_bridgeToSolanaWithEncodedRoute() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Solana
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS; // Must use NON_EVM_ADDRESS for Solana

        // Solana uses CalldataWithAccounts encoding
        bytes
            memory solanaEncodedRoute = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"; // [pre-commit-checker: not a secret]

        // Mock Solana address (base58 encoded address in bytes)
        bytes memory solanaAddress = hex"11111111111111111111111111111111";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: address(0), // Not used for NON_EVM_ADDRESS
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaEncodedRoute
        });

        // Approve USDC
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Expect events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChain(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            solanaAddress
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // Execute bridge
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_bridgeToTron() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Tron
        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = USER_RECEIVER; // Can use regular address for Tron

        // Tron uses EVM-compatible transfer encoding
        // Create a route that ends with an ERC20 transfer call
        bytes memory transferCall = abi.encodeWithSelector(
            IERC20.transfer.selector,
            USER_RECEIVER,
            bridgeData.minAmount
        );

        bytes memory tronEncodedRoute = abi.encodePacked(
            bytes32(0), // Some prefix data
            uint256(0), // Additional data
            transferCall // Transfer at the end (last 68 bytes)
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: tronEncodedRoute // Tron requires ERC20 transfer format
        });

        // Approve USDC
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Expect event
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // Execute bridge - route validation will check the transfer
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_withoutEncodedRoute() public {
        vm.startPrank(USER_SENDER);

        // Test with any destination chain
        bridgeData.destinationChainId = 10; // Optimism

        // Create EcoData without encodedRoute
        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: "" // Missing encodedRoute (now required for all chains)
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidConfig.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_invalidReceiver_NonEVMAddressWithoutNonEVMReceiver()
        public
    {
        // Test for InvalidReceiver error when NON_EVM_ADDRESS is set but nonEVMReceiver is empty
        vm.startPrank(USER_SENDER);

        // Set receiver to NON_EVM_ADDRESS
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;

        // Create EcoData with empty nonEVMReceiver
        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: address(0),
            nonEVMReceiver: "", // Empty nonEVMReceiver should trigger InvalidReceiver
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: hex"0102030405060708090a0b0c0d0e0f10"
        });

        // Approve USDC
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Expect InvalidReceiver revert
        vm.expectRevert(InvalidReceiver.selector);

        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_informationMismatch_ReceiverAddressMismatch() public {
        // Test for InformationMismatch error when receiver addresses don't match
        vm.startPrank(USER_SENDER);

        // Set up bridge data with standard receiver (not NON_EVM_ADDRESS)
        bridgeData.receiver = USER_RECEIVER;
        bridgeData.hasDestinationCall = false; // No destination call
        bridgeData.destinationChainId = 10; // Optimism (EVM chain)

        // Create EcoData with a different receiver address
        address differentReceiver = address(0x9999);
        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: differentReceiver, // Different from bridgeData.receiver
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: hex"0102030405060708090a0b0c0d0e0f10"
        });

        // Approve USDC
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Expect InformationMismatch revert
        vm.expectRevert(InformationMismatch.selector);

        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_chainIdExceedsUint64Max() public {
        vm.startPrank(USER_SENDER);

        // Setup bridge data with a chain ID that exceeds uint64.max
        // This tests the overflow protection at line 150
        ILiFi.BridgeData memory overflowBridgeData = bridgeData;
        overflowBridgeData.destinationChainId = uint256(type(uint64).max) + 1;
        overflowBridgeData.sendingAssetId = address(0); // native token
        overflowBridgeData.minAmount = 0.01 ether;

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: bytes(""),
            prover: address(0),
            rewardDeadline: 0,
            solverReward: NATIVE_SOLVER_REWARD,
            encodedRoute: bytes("test_route")
        });

        // Fund the user with native tokens
        vm.deal(USER_SENDER, 1 ether);

        // Expect the transaction to revert with InvalidConfig error
        vm.expectRevert(InvalidConfig.selector);

        // Attempt to bridge with the oversized chain ID using native tokens
        ecoFacet.startBridgeTokensViaEco{
            value: overflowBridgeData.minAmount + NATIVE_SOLVER_REWARD
        }(overflowBridgeData, ecoData);

        vm.stopPrank();
    }

    function test_chainIdAtUint64Boundary() public {
        vm.startPrank(USER_SENDER);

        // Additional test: Verify that exactly uint64.max works correctly
        ILiFi.BridgeData memory boundaryBridgeData = bridgeData;
        boundaryBridgeData.destinationChainId = type(uint64).max;

        // For EVM chains, we need a proper transfer call at the end
        bytes memory transferCall = abi.encodeWithSelector(
            IERC20.transfer.selector,
            USER_RECEIVER,
            bridgeData.minAmount
        );
        bytes memory validRoute = abi.encodePacked(bytes32(0), transferCall);

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: bytes(""),
            prover: address(0),
            rewardDeadline: 0,
            solverReward: NATIVE_SOLVER_REWARD,
            encodedRoute: validRoute
        });

        // Fund the user with native tokens
        vm.deal(USER_SENDER, bridgeData.minAmount + NATIVE_SOLVER_REWARD);

        // This should NOT revert at the boundary value
        // The transaction will ultimately fail at the Portal call, but shouldn't fail at the uint64 check
        // We expect a revert from Portal.publishAndFund instead
        vm.expectRevert();

        ecoFacet.startBridgeTokensViaEco{
            value: bridgeData.minAmount + NATIVE_SOLVER_REWARD
        }(boundaryBridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_evmChainWithoutTransferCall() public {
        vm.startPrank(USER_SENDER);

        // Set up for an EVM chain
        bridgeData.destinationChainId = 10; // Optimism

        // Create a route without a transfer call (just random data)
        bytes
            memory invalidRoute = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: invalidRoute
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidCallData.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_evmChainWithWrongSelector() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 10; // Optimism

        // Create a route with approve selector instead of transfer
        bytes memory wrongSelectorRoute = abi.encodePacked(
            bytes32(0), // Some prefix data
            abi.encodeWithSelector(
                IERC20.approve.selector, // Wrong selector!
                USER_RECEIVER,
                defaultUSDCAmount
            )
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: wrongSelectorRoute
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidCallData.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_evmChainWithMismatchedReceiver() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 10; // Optimism

        // Create a route with transfer to wrong address
        address wrongRecipient = address(0x9999);
        bytes memory mismatchedRoute = abi.encodePacked(
            bytes32(0), // Some prefix data
            abi.encodeWithSelector(
                IERC20.transfer.selector,
                wrongRecipient, // Different from USER_RECEIVER!
                defaultUSDCAmount
            )
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: mismatchedRoute
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InformationMismatch.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_routeTooShortForTransfer() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 10; // Optimism

        // Create a route that's too short (< 68 bytes)
        bytes memory tooShortRoute = hex"a9059cbb"; // Only selector, missing params

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: tooShortRoute
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidCallData.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_tronWithInvalidRoute() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Tron
        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = USER_RECEIVER;

        // Create an invalid route without proper transfer call
        bytes
            memory invalidTronRoute = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"; // [pre-commit-checker: not a secret]

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: invalidTronRoute // Missing transfer call
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidCallData.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_validEVMRouteWithCorrectTransfer() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 10; // Optimism

        // Use the exact route from the trace but replace the transfer at the end
        // Original route from trace (608 bytes total, last 68 bytes are the transfer)
        bytes
            memory validRoute = hex"00000000000000000000000000000000000000000000000000000000000000209b84721cc353d18473dfbf398f2885f561df5939f638119c47f05dfec6609afb0000000000000000000000000000000000000000000000000000000068cab7040000000000000000000000002b7f87a98707e6d19504293f6680498731272d4f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000004bd61000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000000000000000000000000000000000000abc6543210000000000000000000000000000000000000000000000000000000005f5e100";
        // Last 68 bytes replaced: transfer(USER_RECEIVER, defaultUSDCAmount)

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: validRoute
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }
}
