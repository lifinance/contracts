// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../../../utils/TestBaseFacet.sol";
import { TestHelpers, MockUniswapDEX } from "../../../utils/TestHelpers.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { AcrossFacetV4 } from "lifi/Facets/AcrossFacetV4.sol";
import { IAcrossSpokePoolV4 } from "lifi/Interfaces/IAcrossSpokePoolV4.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";

/// @title TestAcrossFacetV4
/// @author LI.FI (https://li.fi)
/// @notice Stub contract for testing AcrossFacetV4 with mock DEX
/// @custom:version 1.0.0
contract TestAcrossFacetV4 is AcrossFacetV4 {
    constructor(
        IAcrossSpokePoolV4 _spokePool,
        bytes32 _wrappedNativeAddress
    ) AcrossFacetV4(_spokePool, _wrappedNativeAddress) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

/// @title AcrossFacetV4OutputAmountIntegrationTest
/// @author LI.FI (https://li.fi)
/// @notice Integration tests for AcrossFacetV4 outputAmount calculation with mock DEX
/// @custom:version 1.0.0
contract AcrossFacetV4OutputAmountIntegrationTest is
    TestBaseFacet,
    TestHelpers
{
    address internal constant SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;

    // Test contract instances
    TestAcrossFacetV4 internal acrossFacetV4;
    MockUniswapDEX internal mockDEX;

    // Test data
    AcrossFacetV4.AcrossV4Data internal validAcrossData;

    error InvalidQuoteTimestamp();

    function setUp() public {
        customBlockNumberForForking = 22989702;
        initTestBase();

        // Deploy and setup AcrossFacetV4
        acrossFacetV4 = new TestAcrossFacetV4(
            IAcrossSpokePoolV4(SPOKE_POOL),
            _convertAddressToBytes32(ADDRESS_WRAPPED_NATIVE)
        );
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

        setFacetAddressInTestBase(address(acrossFacetV4), "AcrossFacetV4");

        // Add Uniswap router to allowlist for base tests
        acrossFacetV4.addDex(ADDRESS_UNISWAP);
        acrossFacetV4.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        acrossFacetV4.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        // Setup bridge data
        bridgeData.bridge = "across";
        bridgeData.destinationChainId = 137; // Polygon

        // Setup Across data
        uint32 quoteTimestamp = uint32(block.timestamp);
        validAcrossData = AcrossFacetV4.AcrossV4Data({
            receiverAddress: _convertAddressToBytes32(USER_RECEIVER),
            refundAddress: _convertAddressToBytes32(USER_REFUND),
            sendingAssetId: _convertAddressToBytes32(address(usdc)),
            receivingAssetId: _convertAddressToBytes32(address(usdc)),
            outputAmount: 0, // Will be calculated by the contract
            outputAmountMultiplier: 1000000000000000000, // 100% (1e18)
            exclusiveRelayer: _convertAddressToBytes32(address(0)),
            quoteTimestamp: quoteTimestamp,
            fillDeadline: uint32(quoteTimestamp + 1000),
            exclusivityParameter: 0,
            message: ""
        });

        // Label addresses for better debugging
        vm.label(address(usdc), "MockUSDC");
        vm.label(address(dai), "MockDAI");
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

    /// @notice Test direct bridge without swap (6 decimals to 6 decimals)
    function test_DirectBridge6DecimalsTo6Decimals() public {
        vm.startPrank(USER_SENDER);

        // Setup: Direct bridge USDC (6 decimals) to USDC (6 decimals)
        bridgeData.sendingAssetId = address(usdc);
        validAcrossData.sendingAssetId = _convertAddressToBytes32(
            address(usdc)
        );
        bridgeData.minAmount = 100 * 10 ** 6; // 100 USDC
        validAcrossData.receivingAssetId = _convertAddressToBytes32(
            address(usdc)
        );

        // For direct bridges, the contract expects validAcrossData.outputAmount to be set
        validAcrossData.outputAmount = bridgeData.minAmount;

        // Approve USDC spending
        usdc.approve(address(diamond), 100 * 10 ** 6);

        // Expected event
        vm.expectEmit(true, true, true, true, address(acrossFacetV4));
        emit LiFiTransferStarted(bridgeData);

        // Verify SpokePool.deposit is called with expected args (focus on outputAmount)
        // For direct bridges, outputAmount is the value set in validAcrossData.outputAmount
        vm.expectCall(
            SPOKE_POOL,
            abi.encodeWithSelector(
                IAcrossSpokePoolV4.deposit.selector,
                validAcrossData.refundAddress,
                validAcrossData.receiverAddress,
                validAcrossData.sendingAssetId,
                validAcrossData.receivingAssetId,
                bridgeData.minAmount,
                validAcrossData.outputAmount,
                bridgeData.destinationChainId,
                validAcrossData.exclusiveRelayer,
                validAcrossData.quoteTimestamp,
                validAcrossData.fillDeadline,
                validAcrossData.exclusivityParameter,
                validAcrossData.message
            )
        );

        // Execute direct bridge
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// @notice Test direct bridge without swap (18 decimals to 18 decimals)
    function test_DirectBridge18DecimalsTo18Decimals() public {
        vm.startPrank(USER_SENDER);

        // Setup: Direct bridge DAI (18 decimals) to DAI (18 decimals)
        bridgeData.sendingAssetId = address(dai);
        validAcrossData.sendingAssetId = _convertAddressToBytes32(
            address(dai)
        );
        bridgeData.minAmount = 100 * 10 ** 18; // 100 DAI
        validAcrossData.receivingAssetId = _convertAddressToBytes32(
            address(dai)
        );

        // For direct bridges, the contract expects validAcrossData.outputAmount to be set
        validAcrossData.outputAmount = bridgeData.minAmount;

        // Approve DAI spending
        dai.approve(address(diamond), 100 * 10 ** 18);

        // Expected event
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        // Verify SpokePool.deposit is called with expected args (focus on outputAmount)
        // For direct bridges, outputAmount is the value set in validAcrossData.outputAmount
        vm.expectCall(
            SPOKE_POOL,
            abi.encodeWithSelector(
                IAcrossSpokePoolV4.deposit.selector,
                validAcrossData.refundAddress,
                validAcrossData.receiverAddress,
                validAcrossData.sendingAssetId,
                validAcrossData.receivingAssetId,
                bridgeData.minAmount,
                validAcrossData.outputAmount,
                bridgeData.destinationChainId,
                validAcrossData.exclusiveRelayer,
                validAcrossData.quoteTimestamp,
                validAcrossData.fillDeadline,
                validAcrossData.exclusivityParameter,
                validAcrossData.message
            )
        );

        // Execute direct bridge
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// @notice Test swap and bridge with 50% output amount multiplier
    function test_SwapAndBridgeWith50PercentMultiplier() public {
        vm.startPrank(USER_SENDER);

        // Setup: DAI (18 decimals) -> USDC (6 decimals) -> Bridge to USDC (6 decimals)
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(usdc); // USDC is the asset that will be bridged
        validAcrossData.sendingAssetId = _convertAddressToBytes32(
            address(usdc)
        );
        bridgeData.minAmount = 100 * 10 ** 6; // 100 USDC (expected output amount)

        // Setup mock DEX to return exactly 100 USDC (6 decimals)
        uint256 swapOutputAmount = 100 * 10 ** 6; // 100 USDC
        mockDEX = deployFundAndWhitelistMockDEX(
            address(diamond),
            address(usdc),
            swapOutputAmount,
            0 // Use default amountIn
        );
        acrossFacetV4.addDex(address(mockDEX));

        // Setup swap data
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = address(dai);
        path[1] = address(usdc);

        swapData.push(
            LibSwap.SwapData({
                callTo: address(mockDEX),
                approveTo: address(mockDEX),
                sendingAssetId: address(dai),
                receivingAssetId: address(usdc),
                fromAmount: 100 * 10 ** 18, // 100 DAI
                callData: abi.encodeWithSelector(
                    mockDEX.swapExactTokensForTokens.selector,
                    100 * 10 ** 18, // amountIn
                    100 * 10 ** 6, // amountOutMin
                    path,
                    address(diamond),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // Set output amount multiplier to 50% (1e18 base)
        validAcrossData.outputAmountMultiplier = 500_000_000_000_000_000; // 0.5e18
        validAcrossData.receivingAssetId = _convertAddressToBytes32(
            address(usdc)
        );

        // Approve DAI spending
        dai.approve(address(diamond), 100 * 10 ** 18);

        // Expected events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit AssetSwapped(
            bridgeData.transactionId,
            address(mockDEX),
            address(dai),
            address(usdc),
            100 * 10 ** 18,
            100 * 10 ** 6,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // Verify SpokePool.deposit is called with expected args (focus on outputAmount)
        uint256 expectedOutput = (bridgeData.minAmount *
            uint256(validAcrossData.outputAmountMultiplier)) / 1e18;
        vm.expectCall(
            SPOKE_POOL,
            abi.encodeWithSelector(
                IAcrossSpokePoolV4.deposit.selector,
                validAcrossData.refundAddress,
                validAcrossData.receiverAddress,
                validAcrossData.sendingAssetId,
                validAcrossData.receivingAssetId,
                bridgeData.minAmount,
                expectedOutput,
                bridgeData.destinationChainId,
                validAcrossData.exclusiveRelayer,
                validAcrossData.quoteTimestamp,
                validAcrossData.fillDeadline,
                validAcrossData.exclusivityParameter,
                validAcrossData.message
            )
        );

        // Execute swap and bridge
        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// @notice Test swap and bridge with 102% output amount multiplier
    function test_SwapAndBridgeWith102PercentMultiplier() public {
        vm.startPrank(USER_SENDER);

        // Setup: DAI (18 decimals) -> USDC (6 decimals) -> Bridge to USDC (6 decimals)
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(usdc);
        validAcrossData.sendingAssetId = _convertAddressToBytes32(
            address(usdc)
        );
        bridgeData.minAmount = 100 * 10 ** 6; // 100 USDC (expected output amount)

        // Setup mock DEX to return exactly 100 USDC (6 decimals)
        uint256 swapOutputAmount = 100 * 10 ** 6; // 100 USDC
        mockDEX = deployFundAndWhitelistMockDEX(
            address(diamond),
            address(usdc),
            swapOutputAmount,
            0 // Use default amountIn
        );
        acrossFacetV4.addDex(address(mockDEX));

        // Setup swap data
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = address(dai);
        path[1] = address(usdc);

        swapData.push(
            LibSwap.SwapData({
                callTo: address(mockDEX),
                approveTo: address(mockDEX),
                sendingAssetId: address(dai),
                receivingAssetId: address(usdc),
                fromAmount: 100 * 10 ** 18, // 100 DAI
                callData: abi.encodeWithSelector(
                    mockDEX.swapExactTokensForTokens.selector,
                    100 * 10 ** 18, // amountIn
                    100 * 10 ** 6, // amountOutMin
                    path,
                    address(diamond),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // Set output amount multiplier to 102% (1e18 base)
        validAcrossData.outputAmountMultiplier = 1020000000000000000; // 1.02e18
        validAcrossData.receivingAssetId = _convertAddressToBytes32(
            address(usdc)
        );

        // Approve DAI spending
        dai.approve(address(diamond), 100 * 10 ** 18);

        // Expected events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit AssetSwapped(
            bridgeData.transactionId,
            address(mockDEX),
            address(dai),
            address(usdc),
            100 * 10 ** 18,
            100 * 10 ** 6,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // Verify SpokePool.deposit is called with expected args (focus on outputAmount)
        uint256 expectedOutput = (bridgeData.minAmount *
            uint256(validAcrossData.outputAmountMultiplier)) / 1e18;
        vm.expectCall(
            SPOKE_POOL,
            abi.encodeWithSelector(
                IAcrossSpokePoolV4.deposit.selector,
                validAcrossData.refundAddress,
                validAcrossData.receiverAddress,
                validAcrossData.sendingAssetId,
                validAcrossData.receivingAssetId,
                bridgeData.minAmount,
                expectedOutput,
                bridgeData.destinationChainId,
                validAcrossData.exclusiveRelayer,
                validAcrossData.quoteTimestamp,
                validAcrossData.fillDeadline,
                validAcrossData.exclusivityParameter,
                validAcrossData.message
            )
        );

        // Execute swap and bridge
        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// @notice Test the current formula calculation with different decimal scenarios
    function test_CurrentFormulaCalculation() public {
        // Test the current formula: (minAmount * outputAmountMultiplier) / 1e30

        // Scenario 1: 6 decimals to 6 decimals with 100% multiplier
        uint256 minAmount = 100 * 10 ** 6; // 100 USDC
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)
        uint256 result = (minAmount * multiplier) / 1e30;

        // Expected: (100 * 10^6 * 1e18) / 1e30 = 100 * 10^(-6) = 0.0001
        // This shows the current formula is flawed for 6->6 conversion
        assertEq(
            result,
            0,
            "Current formula gives 0 for 6->6 conversion with 100% multiplier"
        );

        // Scenario 2: 18 decimals to 18 decimals with 100% multiplier
        minAmount = 100 * 10 ** 18; // 100 DAI
        multiplier = 1000000000000000000; // 1e18 (100%)
        result = (minAmount * multiplier) / 1e30;

        // Expected: (100 * 10^18 * 1e18) / 1e30 = 100 * 10^6
        // This shows the current formula is flawed for 18->18 conversion
        assertEq(
            result,
            100 * 10 ** 6,
            "Current formula gives wrong result for 18->18 conversion"
        );

        // Scenario 3: 6 decimals to 18 decimals with 1e30 multiplier
        minAmount = 100 * 10 ** 6; // 100 USDC
        multiplier = 1000000000000000000000000000000; // 1e30 (100% * 1e12)
        result = (minAmount * multiplier) / 1e30;

        // Expected: (100 * 10^6 * 1e30) / 1e30 = 100 * 10^6
        // This shows the current formula is flawed for 6->18 conversion
        assertEq(
            result,
            100 * 10 ** 6,
            "Current formula gives wrong result for 6->18 conversion"
        );
    }

    /// @notice Override base test to set correct sendingAssetId
    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC; // USDC is the asset that will be bridged

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // approval
        dai.approve(address(diamond), swapData[0].fromAmount);

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

        // Verify SpokePool.deposit is called with expected args (focus on outputAmount)
        // For swap and bridge, outputAmount is calculated using the outputAmountMultiplier
        uint256 expectedOutput = (bridgeData.minAmount *
            uint256(validAcrossData.outputAmountMultiplier)) / 1e18;
        vm.expectCall(
            SPOKE_POOL,
            abi.encodeWithSelector(
                IAcrossSpokePoolV4.deposit.selector,
                validAcrossData.refundAddress,
                validAcrossData.receiverAddress,
                validAcrossData.sendingAssetId,
                validAcrossData.receivingAssetId,
                bridgeData.minAmount,
                expectedOutput,
                bridgeData.destinationChainId,
                validAcrossData.exclusiveRelayer,
                validAcrossData.quoteTimestamp,
                validAcrossData.fillDeadline,
                validAcrossData.exclusivityParameter,
                validAcrossData.message
            )
        );

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    /// @notice Test the alternative formula calculation (divide by 1e18)
    function test_AlternativeFormulaCalculation() public {
        // Test the alternative formula: (minAmount * outputAmountMultiplier) / 1e18

        // Scenario 1: 6 decimals to 6 decimals with 100% multiplier
        uint256 minAmount = 100 * 10 ** 6; // 100 USDC
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)
        uint256 result = (minAmount * multiplier) / 1e18;

        // Expected: (100 * 10^6 * 1e18) / 1e18 = 100 * 10^6
        assertEq(
            result,
            100 * 10 ** 6,
            "Alternative formula works for 6->6 conversion"
        );

        // Scenario 2: 18 decimals to 18 decimals with 100% multiplier
        minAmount = 100 * 10 ** 18; // 100 DAI
        multiplier = 1000000000000000000; // 1e18 (100%)
        result = (minAmount * multiplier) / 1e18;

        // Expected: (100 * 10^18 * 1e18) / 1e18 = 100 * 10^18
        assertEq(
            result,
            100 * 10 ** 18,
            "Alternative formula works for 18->18 conversion"
        );

        // Scenario 3: 6 decimals to 18 decimals with 1e30 multiplier
        minAmount = 100 * 10 ** 6; // 100 USDC
        multiplier = 1000000000000000000000000000000; // 1e30 (100% * 1e12)
        result = (minAmount * multiplier) / 1e18;

        // Expected: (100 * 10^6 * 1e30) / 1e18 = 100 * 10^18
        assertEq(
            result,
            100 * 10 ** 18,
            "Alternative formula works for 6->18 conversion"
        );

        // Scenario 4: 18 decimals to 6 decimals with 1e6 multiplier
        minAmount = 100 * 10 ** 18; // 100 DAI
        multiplier = 1000000; // 1e6 (100% / 1e12)
        result = (minAmount * multiplier) / 1e18;

        // Expected: (100 * 10^18 * 1e6) / 1e18 = 100 * 10^6
        assertEq(
            result,
            100 * 10 ** 6,
            "Alternative formula works for 18->6 conversion"
        );
    }

    /// @notice Helper function to convert address to bytes32
    function _convertAddressToBytes32(
        address _address
    ) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_address)));
    }
}
