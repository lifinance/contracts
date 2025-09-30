// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { ERC20 } from "lib/solmate/src/tokens/ERC20.sol";
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { LibAllowList } from "../../../src/Libraries/LibAllowList.sol";
import { LibSwap } from "../../../src/Libraries/LibSwap.sol";
import { EcoFacet } from "../../../src/Facets/EcoFacet.sol";
import { IEcoPortal } from "../../../src/Interfaces/IEcoPortal.sol";
import { ILiFi } from "../../../src/Interfaces/ILiFi.sol";
import { InvalidConfig, InvalidReceiver, InformationMismatch } from "../../../src/Errors/GenericErrors.sol";

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
        0xB5e58A8206473Df3Ab9b8DDd3B0F84c0ba68F8b5;
    uint256 internal constant NATIVE_SOLVER_REWARD = 0.0001 ether;
    uint256 internal constant TOKEN_SOLVER_REWARD = 10 * 10 ** 6; // 10 USDC (6 decimals)

    function setUp() public {
        customBlockNumberForForking = 35717845;
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

    // Helper function to create a properly encoded Route struct
    // The route will always have exactly one call - an ERC20 transfer to the receiver
    function initiateBridgeTxWithFacet(bool isNative) internal override {
        EcoFacet.EcoData memory ecoData = _getValidEcoData(isNative);

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
        EcoFacet.EcoData memory ecoData = _getValidEcoData(isNative);

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

    function testRevert_WhenUsingInvalidConfig() public {
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

    function test_BridgeToSolanaWithEncodedRoute() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Solana
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS; // Must use NON_EVM_ADDRESS for Solana

        // Solana uses CalldataWithAccounts encoding
        bytes
            memory solanaEncodedRoute = hex"52a01d29f1d91ab0b57761768e39b85275adf37a9da16dd3640f0f461d2b34e18b15d4680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7000000000000000001000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6164454c00000000000100000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a99b0000000a0000000c64454c0000000000060404000000dadaffa20d79347c07967829bb1a2fb4527985bb805d6e4e1bdaa132452b31630001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6100008f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2000148c1d430876bafc918c7395041939a101ea72fead56b9ec8c4b8e5c7f76d363b0000"; // [pre-commit-checker: not a secret]

        // Dev Solana address (base58 encoded address in bytes)
        bytes
            memory solanaAddress = hex"32576271585272443245527261533541747453486e5345646d7242657532546e39344471554872436d576b7a";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: address(0), // Not used for NON_EVM_ADDRESS
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaEncodedRoute,
            solanaATA: 0x8f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2 // Extracted from encodedRoute ATA for USDC on Solana
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

    function test_BridgeToTron() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Tron
        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = USER_RECEIVER; // Can use regular address for Tron

        // Tron is EVM-compatible, so use the same Route struct encoding
        bytes memory tronEncodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: tronEncodedRoute, // Properly encoded Route struct
            solanaATA: bytes32(0)
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

    function testRevert_WithoutEncodedRoute() public {
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
            encodedRoute: "", // Missing encodedRoute (now required for all chains)
            solanaATA: bytes32(0)
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidConfig.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_InvalidReceiver_NonEVMAddressWithoutNonEVMReceiver()
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
            encodedRoute: hex"0102030405060708090a0b0c0d0e0f10",
            solanaATA: bytes32(0)
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

    function testRevert_InvalidReceiver_RouteReceiverMismatch() public {
        // Test for InvalidReceiver error when the receiver in the route doesn't match bridgeData.receiver
        // This triggers line 291 in EcoFacet.sol
        vm.startPrank(USER_SENDER);

        // Set up bridge data for an EVM chain
        bridgeData.destinationChainId = 10; // Optimism
        bridgeData.receiver = USER_RECEIVER; // Set to USER_RECEIVER

        // Create a route with a DIFFERENT receiver address to trigger the mismatch
        address wrongReceiver = address(0x9999);
        bytes memory routeWithWrongReceiver = _createEncodedRoute(
            wrongReceiver, // Different receiver than bridgeData.receiver
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER, // Matches bridgeData.receiver
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: routeWithWrongReceiver, // Route has different receiver
            solanaATA: bytes32(0)
        });

        // Approve USDC
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Expect InvalidReceiver revert from line 291
        vm.expectRevert(InvalidReceiver.selector);

        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_InformationMismatch_ReceiverAddressMismatch() public {
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
            encodedRoute: hex"0102030405060708090a0b0c0d0e0f10",
            solanaATA: bytes32(0)
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

        ILiFi.BridgeData memory overflowBridgeData = bridgeData;
        overflowBridgeData.destinationChainId = uint256(type(uint64).max) + 1;
        overflowBridgeData.sendingAssetId = address(0);
        overflowBridgeData.minAmount = 0.01 ether;

        // Use the helper to create a properly encoded route
        // Note: We're using ADDRESS_USDC here because the Route expects a token address for the transfer
        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC, // Use a valid token address even though we're sending native
            overflowBridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: bytes(""),
            prover: address(0),
            rewardDeadline: 0,
            solverReward: NATIVE_SOLVER_REWARD,
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
        });

        vm.deal(USER_SENDER, 1 ether);

        vm.expectRevert(InvalidConfig.selector);
        ecoFacet.startBridgeTokensViaEco{
            value: overflowBridgeData.minAmount + NATIVE_SOLVER_REWARD
        }(overflowBridgeData, ecoData);

        vm.stopPrank();
    }

    function test_ChainIdAtUint64Boundary() public {
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
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
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

    function testRevert_InvalidABIEncodedRoute() public {
        vm.startPrank(USER_SENDER);

        // Set up for an EVM chain
        bridgeData.destinationChainId = 10; // Optimism

        // Create data that cannot be ABI decoded as a Route struct
        bytes
            memory invalidRoute = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: invalidRoute,
            solanaATA: bytes32(0)
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Will revert during ABI decode attempt
        vm.expectRevert();
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_RouteTooShortForABIDecode() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 10; // Optimism

        // Create data that's too short to be a valid ABI-encoded Route
        bytes memory tooShortRoute = hex"a9059cbb"; // Only 4 bytes

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: tooShortRoute,
            solanaATA: bytes32(0)
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Will revert during ABI decode attempt
        vm.expectRevert();
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronWithInvalidRoute() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Tron (which is an EVM-compatible chain in this context)
        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = USER_RECEIVER;

        // Create data that cannot be ABI decoded as a Route struct
        bytes
            memory invalidTronRoute = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"; // [pre-commit-checker: not a secret]

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: invalidTronRoute,
            solanaATA: bytes32(0)
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Will revert during ABI decode attempt
        vm.expectRevert();
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_ValidEVMRouteWithCorrectTransfer() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 10; // Optimism

        // Use the helper to create a properly encoded Route
        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
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

    function test_IsEVMChainCalledWithSolanaChainId() public {
        vm.startPrank(USER_SENDER);

        // Set destination to Solana but use EVM receiver (invalid config, but covers the branch)
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = USER_RECEIVER; // EVM address, not NON_EVM_ADDRESS

        // Create a valid Route struct encoding
        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidReceiver.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SolanaRouteValidation_EmptyNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS;

        bytes
            memory solanaRoute = hex"9e6c10e6d964ed8b7015b410e7049dc1450b4bdcda6976d16b98dab756c33c2fa54fc9680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7"; // [pre-commit-checker: not a secret]

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: address(0),
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaRoute,
            solanaATA: bytes32(uint256(1))
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidReceiver.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SolanaRouteValidation_TooLongNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS;

        bytes
            memory solanaRoute = hex"fefd31b99638603f4dbb9bc6d42d223ec4b4d4ab5509910efa68063ba9f4fac57e0ed4680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7000000000000000001000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6164454c00000000000100000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a99b0000000a0000000c64454c0000000000060404000000dadaffa20d79347c07967829bb1a2fb4527985bb805d6e4e1bdaa132452b31630001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6100008f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2000148c1d430876bafc918c7395041939a101ea72fead56b9ec8c4b8e5c7f76d363b0000"; // [pre-commit-checker: not a secret]

        bytes memory tooLongAddress = new bytes(45);
        for (uint256 i = 0; i < 45; i++) {
            tooLongAddress[i] = bytes1(uint8(65 + (i % 26)));
        }

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: address(0),
            nonEVMReceiver: tooLongAddress,
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaRoute,
            solanaATA: bytes32(uint256(1))
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidReceiver.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SolanaRouteValidation_RouteTooShort() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS;

        bytes memory tooShortRoute = hex"9e6c10e6d964ed8b7015b410e7049dc1"; // [pre-commit-checker: not a secret]

        bytes
            memory solanaAddress = hex"32576271585272443245527261533541747453486e5345646d7242657532546e39344471554872436d576b7a"; // [pre-commit-checker: not a secret]

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: address(0),
            nonEVMReceiver: solanaAddress,
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: tooShortRoute,
            solanaATA: bytes32(uint256(1))
        });

        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        vm.expectRevert(InvalidReceiver.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_BridgeToSolanaWithSolanaATAZero() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Solana
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS; // Must use NON_EVM_ADDRESS for Solana

        // Solana uses CalldataWithAccounts encoding
        bytes
            memory solanaEncodedRoute = hex"52a01d29f1d91ab0b57761768e39b85275adf37a9da16dd3640f0f461d2b34e18b15d4680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7000000000000000001000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6164454c00000000000100000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a99b0000000a0000000c64454c0000000000060404000000dadaffa20d79347c07967829bb1a2fb4527985bb805d6e4e1bdaa132452b31630001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6100008f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2000148c1d430876bafc918c7395041939a101ea72fead56b9ec8c4b8e5c7f76d363b0000"; // [pre-commit-checker: not a secret]

        // Dev Solana address (base58 encoded address in bytes)
        bytes
            memory solanaAddress = hex"32576271585272443245527261533541747453486e5345646d7242657532546e39344471554872436d576b7a";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: address(0), // Not used for NON_EVM_ADDRESS
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaEncodedRoute,
            solanaATA: bytes32(0) // Set to zero - should revert
        });

        // Approve USDC
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Expect InvalidConfig revert due to solanaATA being zero
        vm.expectRevert(InvalidConfig.selector);

        // Execute bridge
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SolanaATADoesNotMatch() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Solana
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS; // Must use NON_EVM_ADDRESS for Solana

        // Solana uses CalldataWithAccounts encoding
        bytes
            memory solanaEncodedRoute = hex"52a01d29f1d91ab0b57761768e39b85275adf37a9da16dd3640f0f461d2b34e18b15d4680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7000000000000000001000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6164454c00000000000100000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a99b0000000a0000000c64454c0000000000060404000000dadaffa20d79347c07967829bb1a2fb4527985bb805d6e4e1bdaa132452b31630001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6100008f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2000148c1d430876bafc918c7395041939a101ea72fead56b9ec8c4b8e5c7f76d363b0000"; // [pre-commit-checker: not a secret]

        // Dev Solana address (base58 encoded address in bytes)
        bytes
            memory solanaAddress = hex"32576271585272443245527261533541747453486e5345646d7242657532546e39344471554872436d576b7a";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: address(0), // Not used for NON_EVM_ADDRESS
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaEncodedRoute,
            solanaATA: bytes32(uint256(0x123456789abcdef)) // Different ATA that doesn't match the route
        });

        // Approve USDC
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Expect revert due to ATA mismatch
        vm.expectRevert(InvalidReceiver.selector);

        // Execute bridge
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function _createEncodedRoute(
        address receiver,
        address token,
        uint256 amount
    ) internal view returns (bytes memory) {
        // Create token array for the route
        IEcoPortal.TokenAmount[] memory tokens = new IEcoPortal.TokenAmount[](
            1
        );
        tokens[0] = IEcoPortal.TokenAmount({ token: token, amount: amount });

        // Create calls array with exactly one call - the ERC20 transfer to receiver
        EcoFacet.Call[] memory calls = new EcoFacet.Call[](1);
        calls[0] = EcoFacet.Call({
            target: token,
            callData: abi.encodeWithSelector(
                IERC20.transfer.selector,
                receiver,
                amount
            )
        });

        // Create the Route struct
        EcoFacet.Route memory route = EcoFacet.Route({
            salt: keccak256("eco.route.test"),
            deadline: uint64(block.timestamp + 1 days),
            portal: PORTAL, // Portal is the contract that receives and executes the route
            nativeAmount: 0,
            tokens: tokens,
            calls: calls
        });

        // ABI encode the route
        return abi.encode(route);
    }

    function _getValidEcoData(
        bool isNative
    ) internal view returns (EcoFacet.EcoData memory) {
        // Calculate solver reward based on token type
        uint256 solverReward = isNative
            ? NATIVE_SOLVER_REWARD
            : TOKEN_SOLVER_REWARD;

        // Create a properly encoded route using the Route struct
        bytes memory encodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        return
            EcoFacet.EcoData({
                receiverAddress: USER_RECEIVER,
                nonEVMReceiver: "",
                prover: address(0x1234),
                rewardDeadline: uint64(block.timestamp + 2 days),
                solverReward: solverReward,
                encodedRoute: encodedRoute,
                solanaATA: bytes32(0)
            });
    }
}
