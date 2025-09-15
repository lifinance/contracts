// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { EcoFacet } from "lifi/Facets/EcoFacet.sol";
import { IEcoPortal } from "lifi/Interfaces/IEcoPortal.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";

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
    address internal constant PORTAL = 0x2b7F87a98707e6D19504293F6680498731272D4f;
    uint256 internal constant NATIVE_SOLVER_REWARD = 0.0001 ether;
    uint256 internal constant TOKEN_SOLVER_REWARD = 10 * 10 ** 6; // 10 USDC (6 decimals)

    // Chain IDs for testing
    uint256 internal constant LIFI_CHAIN_ID_SOLANA = 1151111081099710;
    uint256 internal constant LIFI_CHAIN_ID_TRON = 1885080386571452;
    address internal constant NON_EVM_ADDRESS = 0x11f111f111f111F111f111f111F111f111f111F1;

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

        // Create mock encoded route data for all chains
        bytes memory mockEncodedRoute = hex"0102030405060708090a0b0c0d0e0f10";

        return
            EcoFacet.EcoData({
                receiverAddress: USER_RECEIVER,
                nonEVMReceiver: "",
                prover: address(0x1234),
                rewardDeadline: uint64(block.timestamp + 2 days),
                solverReward: solverReward,
                encodedRoute: mockEncodedRoute // Required for all chains now
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
            uint256 msgValue = swapData.length > 0
                ? swapData[0].fromAmount + addToMessageValue
                : addToMessageValue;
            ecoFacet.swapAndStartBridgeTokensViaEco{ value: msgValue }(
                bridgeData,
                swapData,
                ecoData
            );
        } else {
            // Swapping from native to ERC20: No additional msg.value needed
            uint256 msgValue = swapData.length > 0
                ? swapData[0].fromAmount
                : 0;
            ecoFacet.swapAndStartBridgeTokensViaEco{ value: msgValue }(
                bridgeData,
                swapData,
                ecoData
            );
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

    // Test Solana bridging
    function testBridge_ToSolanaWithEncodedRoute() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Solana
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS; // Must use NON_EVM_ADDRESS for Solana

        // Create Borsh-encoded route (mock data for testing)
        bytes memory borshEncodedRoute = hex"0102030405060708090a0b0c0d0e0f10";

        // Mock Solana address (base58 encoded address in bytes)
        bytes memory solanaAddress = hex"11111111111111111111111111111111";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: address(0), // Not used for NON_EVM_ADDRESS
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD, // Use TOKEN_SOLVER_REWARD for consistency
            encodedRoute: borshEncodedRoute
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

    function testBridge_ToTron() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Tron
        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = USER_RECEIVER; // Can use regular address for Tron

        // Create mock encoded route data
        bytes memory mockEncodedRoute = hex"0102030405060708090a0b0c0d0e0f10";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            receiverAddress: USER_RECEIVER,
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            solverReward: TOKEN_SOLVER_REWARD,
            encodedRoute: mockEncodedRoute // Now required for Tron too
        });

        // Approve USDC
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Expect event
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // Execute bridge
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

    // Override base test since we no longer support destination calls
    function testBase_Revert_BridgeWithInvalidDestinationCallFlag() public override {
        // This test is no longer relevant since destination calls are removed
        // We just verify that the hasDestinationCall flag doesn't affect the bridge
        vm.startPrank(USER_SENDER);

        bridgeData.hasDestinationCall = false; // Set to false since we don't support it

        // Approve the correct amount
        usdc.approve(
            _facetTestContractAddress,
            bridgeData.minAmount + TOKEN_SOLVER_REWARD
        );

        // Should work normally without destination calls
        EcoFacet.EcoData memory ecoData = getValidEcoData(false);

        // This should succeed without reverting
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }
}
