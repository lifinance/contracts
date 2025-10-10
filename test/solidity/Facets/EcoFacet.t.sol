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
import { InvalidConfig, InvalidReceiver, NativeAssetNotSupported } from "../../../src/Errors/GenericErrors.sol";

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

        addToMessageValue = 0;
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        EcoFacet.EcoData memory ecoData = _getValidEcoData();
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        EcoFacet.EcoData memory ecoData = _getValidEcoData();
        ecoFacet.swapAndStartBridgeTokensViaEco(bridgeData, swapData, ecoData);
    }

    function testRevert_WhenUsingInvalidConfig() public {
        vm.expectRevert(InvalidConfig.selector);
        new EcoFacet(IEcoPortal(address(0)));
    }

    function testRevert_NativeTokenNotSupported() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data with native token
        bridgeData.sendingAssetId = address(0); // Native token
        bridgeData.minAmount = 0.1 ether;

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC, // Route can use any token
            100 * 10 ** 6
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: 0.0001 ether,
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
        });

        // Should revert when trying to bridge native tokens
        vm.expectRevert(NativeAssetNotSupported.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_NativeTokenNotSupportedInSwap() public {
        vm.startPrank(USER_SENDER);

        // Set up swap to native token
        bridgeData.sendingAssetId = address(0); // Native token
        bridgeData.minAmount = 0.1 ether;
        bridgeData.hasSourceSwaps = true;

        // Swap DAI to native
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0), // Swapping to native
                fromAmount: 1000 * 10 ** 18,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    bridgeData.minAmount,
                    1000 * 10 ** 18,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            100 * 10 ** 6
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: 0.0001 ether,
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
        });

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // Should revert when trying to swap and bridge native tokens
        vm.expectRevert(NativeAssetNotSupported.selector);
        ecoFacet.swapAndStartBridgeTokensViaEco{ value: 0.0001 ether }(
            bridgeData,
            swapData,
            ecoData
        );

        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens() public override {}

    function testBase_CanSwapAndBridgeNativeTokens() public override {}

    // Override the base test to handle ERC20 token rewards properly
    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount + TOKEN_SOLVER_REWARD)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        bridgeData.minAmount = defaultUSDCAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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

        // Ensure we have enough balance for total amount
        vm.assume(amount + TOKEN_SOLVER_REWARD <= userBalance);

        // Set up bridge data - minAmount is now the total (fee-inclusive)
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount + TOKEN_SOLVER_REWARD;

        vm.writeLine(logFilePath, vm.toString(amount));

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // Override swap and bridge test to handle token rewards properly
    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256 totalAmountNeeded = defaultUSDCAmount + TOKEN_SOLVER_REWARD;

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

        bridgeData.minAmount = totalAmountNeeded;
        bridgeData.hasSourceSwaps = true;

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            totalAmountNeeded,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        uint256 daiBalanceBefore = dai.balanceOf(USER_SENDER);
        uint256 usdcBalanceBefore = usdc.balanceOf(USER_SENDER);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(
            dai.balanceOf(USER_SENDER),
            daiBalanceBefore - swapData[0].fromAmount
        );
        assertEq(usdc.balanceOf(USER_SENDER), usdcBalanceBefore);
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
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaEncodedRoute,
            solanaATA: 0x8f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2 // Extracted from encodedRoute ATA for USDC on Solana
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: tronEncodedRoute, // Properly encoded Route struct
            solanaATA: bytes32(0)
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: "", // Missing encodedRoute (now required for all chains)
            solanaATA: bytes32(0)
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: "", // Empty nonEVMReceiver should trigger InvalidReceiver
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: hex"0102030405060708090a0b0c0d0e0f10",
            solanaATA: bytes32(0)
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: routeWithWrongReceiver, // Route has different receiver
            solanaATA: bytes32(0)
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Expect InvalidReceiver revert from line 291
        vm.expectRevert(InvalidReceiver.selector);

        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_chainIdExceedsUint64Max() public {
        vm.startPrank(USER_SENDER);

        ILiFi.BridgeData memory overflowBridgeData = bridgeData;
        overflowBridgeData.destinationChainId = uint256(type(uint64).max) + 1;

        // Use the helper to create a properly encoded route
        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            overflowBridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: bytes(""),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
        });

        overflowBridgeData.minAmount =
            overflowBridgeData.minAmount +
            TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, overflowBridgeData.minAmount);

        vm.expectRevert(InvalidConfig.selector);
        ecoFacet.startBridgeTokensViaEco(overflowBridgeData, ecoData);

        vm.stopPrank();
    }

    function test_ChainIdAtUint64Boundary() public {
        vm.startPrank(USER_SENDER);

        ILiFi.BridgeData memory boundaryBridgeData = bridgeData;
        boundaryBridgeData.destinationChainId = type(uint64).max;
        boundaryBridgeData.sendingAssetId = ADDRESS_USDC;
        boundaryBridgeData.minAmount = 100 * 10 ** 6;

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            boundaryBridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: bytes(""),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
        });

        boundaryBridgeData.minAmount =
            boundaryBridgeData.minAmount +
            TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, boundaryBridgeData.minAmount);

        ecoFacet.startBridgeTokensViaEco(boundaryBridgeData, ecoData);

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
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: invalidRoute,
            solanaATA: bytes32(0)
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: tooShortRoute,
            solanaATA: bytes32(0)
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: invalidTronRoute,
            solanaATA: bytes32(0)
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: validRoute,
            solanaATA: bytes32(0)
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaRoute,
            solanaATA: bytes32(uint256(1))
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: tooLongAddress,
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaRoute,
            solanaATA: bytes32(uint256(1))
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: solanaAddress,
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: tooShortRoute,
            solanaATA: bytes32(uint256(1))
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaEncodedRoute,
            solanaATA: bytes32(0) // Set to zero - should revert
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: solanaEncodedRoute,
            solanaATA: bytes32(uint256(0x123456789abcdef)) // Different ATA that doesn't match the route
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

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

    function _getValidEcoData()
        internal
        view
        returns (EcoFacet.EcoData memory)
    {
        bytes memory encodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        return
            EcoFacet.EcoData({
                nonEVMReceiver: "",
                prover: address(0x1234),
                rewardDeadline: uint64(block.timestamp + 2 days),
                solverReward: TOKEN_SOLVER_REWARD,
                encodedRoute: encodedRoute,
                solanaATA: bytes32(0)
            });
    }
}
