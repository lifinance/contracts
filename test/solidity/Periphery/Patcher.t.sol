// SPDX-License-Identifier: Unlicensed
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";
import { Patcher } from "lifi/Periphery/Patcher.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { RelayFacet } from "lifi/Facets/RelayFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";

// Custom errors for gas optimization
error MockFailure();
error TargetFailure();
error OracleFailure();
error PriceNotSet();

// Mock contract that returns dynamic values
contract MockValueSource {
    uint256 public value;
    bool public shouldFail;

    function setValue(uint256 _value) external {
        value = _value;
    }

    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    function getValue() external view returns (uint256) {
        if (shouldFail) {
            revert MockFailure();
        }
        return value;
    }

    function getBalance(
        address token,
        address account
    ) external view returns (uint256) {
        if (shouldFail) {
            revert MockFailure();
        }
        return ERC20(token).balanceOf(account);
    }

    function getMultipleValues() external view returns (uint256, uint256) {
        if (shouldFail) {
            revert MockFailure();
        }
        return (value, value * 2);
    }
}

// Mock target contract for testing calls
contract MockTarget {
    uint256 public lastValue;
    address public lastSender;
    uint256 public lastEthValue;
    bytes public lastCalldata;
    bool public shouldFail;

    event CallReceived(uint256 value, address sender, uint256 ethValue);

    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    function processValue(uint256 _value) external payable {
        if (shouldFail) {
            revert TargetFailure();
        }
        lastValue = _value;
        lastSender = msg.sender;
        lastEthValue = msg.value;
        lastCalldata = msg.data;
        emit CallReceived(_value, msg.sender, msg.value);
    }

    function processMultipleValues(
        uint256 _value1,
        uint256 _value2
    ) external payable {
        if (shouldFail) {
            revert TargetFailure();
        }
        lastValue = _value1 + _value2;
        lastSender = msg.sender;
        lastEthValue = msg.value;
        lastCalldata = msg.data;
        emit CallReceived(_value1 + _value2, msg.sender, msg.value);
    }

    function processComplexData(
        uint256 _amount,
        address /* _token */,
        uint256 _deadline
    ) external payable {
        if (shouldFail) {
            revert TargetFailure();
        }
        lastValue = _amount + _deadline;
        lastSender = msg.sender;
        lastEthValue = msg.value;
        lastCalldata = msg.data;
        emit CallReceived(_amount + _deadline, msg.sender, msg.value);
    }
}

// Mock price oracle for calculating dynamic minimum amounts
contract MockPriceOracle {
    mapping(address => uint256) public prices; // Price in USD with 18 decimals
    bool public shouldFail;

    function setPrice(address token, uint256 price) external {
        prices[token] = price;
    }

    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    function getPrice(address token) external view returns (uint256) {
        if (shouldFail) {
            revert OracleFailure();
        }
        return prices[token];
    }

    // Calculate minimum amount with slippage protection
    function calculateMinAmount(
        address token,
        uint256 amount,
        uint256 slippageBps // basis points (e.g., 300 = 3%)
    ) external view returns (uint256) {
        if (shouldFail) {
            revert OracleFailure();
        }
        uint256 price = prices[token];
        if (price == 0) {
            revert PriceNotSet();
        }

        // Apply slippage: minAmount = amount * (10000 - slippageBps) / 10000
        return (amount * (10000 - slippageBps)) / 10000;
    }
}

// Test RelayFacet Contract
contract TestRelayFacet is RelayFacet {
    constructor(
        address _relayReceiver,
        address _relaySolver
    ) RelayFacet(_relayReceiver, _relaySolver) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract PatcherTest is DSTest {
    // solhint-disable immutable-vars-naming
    Vm internal immutable vm = Vm(HEVM_ADDRESS);

    // Events for testing
    event CallReceived(uint256 value, address sender, uint256 ethValue);
    event LiFiTransferStarted(ILiFi.BridgeData bridgeData);

    Patcher internal patcher;
    MockValueSource internal valueSource;
    MockTarget internal target;
    ERC20 internal token;
    MockPriceOracle internal priceOracle;
    TestRelayFacet internal relayFacet;

    // RelayFacet setup variables
    address internal constant RELAY_RECEIVER =
        0xa5F565650890fBA1824Ee0F21EbBbF660a179934;
    uint256 internal privateKey = 0x1234567890;
    address internal relaySolver;

    function setUp() public {
        // Set up our test contracts
        patcher = new Patcher();
        valueSource = new MockValueSource();
        target = new MockTarget();
        token = new ERC20("Test Token", "TEST", 18);
        priceOracle = new MockPriceOracle();

        // Set up real RelayFacet for testing
        relaySolver = vm.addr(privateKey);
        relayFacet = new TestRelayFacet(RELAY_RECEIVER, relaySolver);
    }

    // Test successful single patch execution
    function testExecuteWithDynamicPatches_Success() public {
        // Set up dynamic value
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        // Prepare calldata with placeholder value (0)
        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0) // This will be patched
        );

        // Define offset where the value should be patched (after selector, at parameter position)
        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4; // Skip 4-byte selector

        // Prepare value getter calldata
        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        // Expect the CallReceived event to be emitted with the patched value
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(dynamicValue, address(patcher), 0);

        // Execute with dynamic patches
        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0, // no ETH value
            originalCalldata,
            offsets,
            false // regular call, not delegatecall
        );

        // Verify execution was successful
        assertEq(target.lastValue(), dynamicValue);
        assertEq(target.lastSender(), address(patcher));
        assertEq(target.lastEthValue(), 0);
    }

    // Test successful execution with ETH value
    function testExecuteWithDynamicPatches_WithEthValue() public {
        uint256 dynamicValue = 54321;
        uint256 ethValue = 1 ether;

        valueSource.setValue(dynamicValue);
        vm.deal(address(patcher), ethValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        // Expect the CallReceived event to be emitted with the patched value and ETH
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(dynamicValue, address(patcher), ethValue);

        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            ethValue,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), dynamicValue);
        assertEq(target.lastEthValue(), ethValue);
    }

    // Test multiple patches with same value
    function testExecuteWithDynamicPatches_MultipleOffsets() public {
        uint256 dynamicValue = 98765;
        valueSource.setValue(dynamicValue);

        // Calldata with two parameters that should both be patched with the same value
        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processMultipleValues.selector,
            uint256(0), // First parameter to patch
            uint256(0) // Second parameter to patch
        );

        uint256[] memory offsets = new uint256[](2);
        offsets[0] = 4; // First parameter offset
        offsets[1] = 36; // Second parameter offset (4 + 32)

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        // Expect the CallReceived event to be emitted with the sum of both values
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(dynamicValue * 2, address(patcher), 0);

        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), dynamicValue * 2); // Sum of both values
    }

    // Test multiple patches with different values
    function testExecuteWithMultiplePatches_Success() public {
        uint256 value1 = 11111;
        uint256 value2 = 22222;

        // Set up two value sources
        MockValueSource valueSource2 = new MockValueSource();
        valueSource.setValue(value1);
        valueSource2.setValue(value2);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processMultipleValues.selector,
            uint256(0), // Will be patched with value1
            uint256(0) // Will be patched with value2
        );

        // Set up arrays for multiple patches
        address[] memory valueSources = new address[](2);
        valueSources[0] = address(valueSource);
        valueSources[1] = address(valueSource2);

        bytes[] memory valueGetters = new bytes[](2);
        valueGetters[0] = abi.encodeWithSelector(
            valueSource.getValue.selector
        );
        valueGetters[1] = abi.encodeWithSelector(
            valueSource2.getValue.selector
        );

        uint256[][] memory offsetGroups = new uint256[][](2);
        offsetGroups[0] = new uint256[](1);
        offsetGroups[0][0] = 4; // First parameter
        offsetGroups[1] = new uint256[](1);
        offsetGroups[1][0] = 36; // Second parameter

        // Expect the CallReceived event to be emitted with the sum of both values
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(value1 + value2, address(patcher), 0);

        patcher.executeWithMultiplePatches(
            valueSources,
            valueGetters,
            address(target),
            0,
            originalCalldata,
            offsetGroups,
            false
        );

        assertEq(target.lastValue(), value1 + value2);
    }

    // Test delegatecall execution
    function testExecuteWithDynamicPatches_Delegatecall() public {
        uint256 dynamicValue = 77777;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            true // delegatecall
        );

        // Note: In delegatecall, the target's storage won't be modified
        // but the call should still succeed
    }

    // Test error when getting dynamic value fails
    function testExecuteWithDynamicPatches_FailedToGetDynamicValue() public {
        valueSource.setShouldFail(true);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.expectRevert(Patcher.FailedToGetDynamicValue.selector);
        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Test error when patch offset is invalid
    function testExecuteWithDynamicPatches_InvalidPatchOffset() public {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = originalCalldata.length; // Invalid offset (beyond data length)

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.expectRevert(Patcher.InvalidPatchOffset.selector);
        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Test error when arrays have mismatched lengths
    function testExecuteWithMultiplePatches_MismatchedArrayLengths() public {
        address[] memory valueSources = new address[](2);
        valueSources[0] = address(valueSource);
        valueSources[1] = address(valueSource);

        bytes[] memory valueGetters = new bytes[](1); // Mismatched length
        valueGetters[0] = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        uint256[][] memory offsetGroups = new uint256[][](2);
        offsetGroups[0] = new uint256[](1);
        offsetGroups[1] = new uint256[](1);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        vm.expectRevert(Patcher.MismatchedArrayLengths.selector);
        patcher.executeWithMultiplePatches(
            valueSources,
            valueGetters,
            address(target),
            0,
            originalCalldata,
            offsetGroups,
            false
        );
    }

    // Test complex scenario with token balance patching
    function testExecuteWithDynamicPatches_TokenBalance() public {
        // Mint tokens to an account
        address holder = address(0x1234);
        uint256 balance = 1000 ether;
        token.mint(holder, balance);

        // Prepare calldata that uses the token balance
        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processComplexData.selector,
            uint256(0), // amount - will be patched with balance
            address(token),
            block.timestamp + 1 hours
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4; // Patch the amount parameter

        // Use balanceOf call to get dynamic value
        bytes memory valueGetter = abi.encodeWithSelector(
            token.balanceOf.selector,
            holder
        );

        // Expect the CallReceived event to be emitted with the patched balance
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(
            balance + block.timestamp + 1 hours,
            address(patcher),
            0
        );

        patcher.executeWithDynamicPatches(
            address(token),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), balance + block.timestamp + 1 hours);
    }

    // Test that target call failure is properly handled
    function testExecuteWithDynamicPatches_TargetCallFailure() public {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);
        target.setShouldFail(true);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        (bool success, bytes memory returnData) = patcher
            .executeWithDynamicPatches(
                address(valueSource),
                valueGetter,
                address(target),
                0,
                originalCalldata,
                offsets,
                false
            );

        // The patcher should return false for failed calls, not revert
        assertTrue(!success);
        // Return data should contain the revert reason
        assertTrue(returnData.length > 0);
    }

    // Test edge case with empty offsets array
    function testExecuteWithDynamicPatches_EmptyOffsets() public {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(99999) // This value should remain unchanged
        );

        uint256[] memory offsets = new uint256[](0); // Empty offsets

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        // Expect the CallReceived event to be emitted with the original value (no patching)
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(99999, address(patcher), 0);

        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), 99999); // Original value should be preserved
    }

    // Test multiple patches on the same offset (should overwrite)
    function testExecuteWithMultiplePatches_SameOffset() public {
        uint256 value1 = 11111;
        uint256 value2 = 22222;

        MockValueSource valueSource2 = new MockValueSource();
        valueSource.setValue(value1);
        valueSource2.setValue(value2);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        address[] memory valueSources = new address[](2);
        valueSources[0] = address(valueSource);
        valueSources[1] = address(valueSource2);

        bytes[] memory valueGetters = new bytes[](2);
        valueGetters[0] = abi.encodeWithSelector(
            valueSource.getValue.selector
        );
        valueGetters[1] = abi.encodeWithSelector(
            valueSource2.getValue.selector
        );

        uint256[][] memory offsetGroups = new uint256[][](2);
        offsetGroups[0] = new uint256[](1);
        offsetGroups[0][0] = 4; // Same offset
        offsetGroups[1] = new uint256[](1);
        offsetGroups[1][0] = 4; // Same offset (should overwrite)

        // Expect the CallReceived event to be emitted with the last written value
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(value2, address(patcher), 0);

        patcher.executeWithMultiplePatches(
            valueSources,
            valueGetters,
            address(target),
            0,
            originalCalldata,
            offsetGroups,
            false
        );

        assertEq(target.lastValue(), value2); // Should have the last written value
    }

    // Test with zero value
    function testExecuteWithDynamicPatches_ZeroValue() public {
        uint256 dynamicValue = 0;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(12345) // Will be overwritten with 0
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        // Expect the CallReceived event to be emitted with the zero value
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(0, address(patcher), 0);

        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), 0);
    }

    // Test with maximum uint256 value
    function testExecuteWithDynamicPatches_MaxValue() public {
        uint256 dynamicValue = type(uint256).max;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        // Expect the CallReceived event to be emitted with the max value
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(type(uint256).max, address(patcher), 0);

        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), type(uint256).max);
    }

    // Test realistic BridgeData minAmount patching with price oracle using real RelayFacet
    function testExecuteWithDynamicPatches_RelayFacetMinAmount() public {
        // Set up token price and slippage
        uint256 tokenPrice = 2000 * 1e18; // $2000 per token
        uint256 slippageBps = 300; // 3% slippage
        priceOracle.setPrice(address(token), tokenPrice);

        // Create BridgeData with placeholder minAmount (0)
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("test-tx-id"),
            bridge: "relay",
            integrator: "TestIntegrator",
            referrer: address(0x1234),
            sendingAssetId: address(token),
            receiver: address(0x5678),
            minAmount: 0, // This will be patched
            destinationChainId: 8453, // Base
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        // Create RelayData
        RelayFacet.RelayData memory relayData = RelayFacet.RelayData({
            requestId: bytes32("test-request-id"),
            nonEVMReceiver: bytes32(0),
            receivingAssetId: bytes32(uint256(uint160(address(0xDEF)))),
            signature: ""
        });

        // Sign the RelayData
        relayData.signature = signData(bridgeData, relayData);

        // Set up token balance and approval for the Patcher
        uint256 bridgeAmount = 1000 ether;
        uint256 expectedMinAmount = (bridgeAmount * (10000 - slippageBps)) /
            10000; // 970 ether

        // Mint tokens to the Patcher contract
        token.mint(address(patcher), expectedMinAmount);

        // Approve the RelayFacet to spend tokens from the Patcher
        vm.prank(address(patcher));
        token.approve(address(relayFacet), expectedMinAmount);

        // Encode the RelayFacet call with placeholder minAmount
        bytes memory originalCalldata = abi.encodeWithSelector(
            relayFacet.startBridgeTokensViaRelay.selector,
            bridgeData,
            relayData
        );

        // Use the offset we found: 260 bytes
        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 260;

        // Prepare oracle call to calculate minAmount with slippage
        bytes memory valueGetter = abi.encodeWithSelector(
            priceOracle.calculateMinAmount.selector,
            address(token),
            bridgeAmount,
            slippageBps
        );

        // Expect the LiFiTransferStarted event to be emitted
        ILiFi.BridgeData memory expectedBridgeData = bridgeData;
        expectedBridgeData.minAmount = expectedMinAmount; // Use the already calculated value

        vm.expectEmit(true, true, true, true, address(relayFacet));
        emit LiFiTransferStarted(expectedBridgeData);

        patcher.executeWithDynamicPatches(
            address(priceOracle),
            valueGetter,
            address(relayFacet),
            0,
            originalCalldata,
            offsets,
            false
        );

        // The fact that the call succeeded means the patching worked correctly
        // We can't verify the exact minAmount since the real RelayFacet doesn't store state
    }

    // Test BridgeData patching with token balance as minAmount using RelayFacet
    function testExecuteWithDynamicPatches_RelayFacetTokenBalance() public {
        // Set up a user with token balance
        uint256 tokenBalance = 500 ether;

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("balance-patch-tx"),
            bridge: "relay",
            integrator: "TestIntegrator",
            referrer: address(0x1234),
            sendingAssetId: address(token),
            receiver: address(1337),
            minAmount: 0, // Will be patched with user's balance
            destinationChainId: 8453, // Base
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        RelayFacet.RelayData memory relayData = RelayFacet.RelayData({
            requestId: bytes32("balance-patch-request"),
            nonEVMReceiver: bytes32(0),
            receivingAssetId: bytes32(uint256(uint160(address(0xDEF)))),
            signature: ""
        });

        // Sign the RelayData
        relayData.signature = signData(bridgeData, relayData);

        // Set up token balance and approval for the Patcher
        token.mint(address(patcher), tokenBalance);

        // Approve the RelayFacet to spend tokens from the Patcher
        vm.prank(address(patcher));
        token.approve(address(relayFacet), tokenBalance);

        bytes memory originalCalldata = abi.encodeWithSelector(
            relayFacet.startBridgeTokensViaRelay.selector,
            bridgeData,
            relayData
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 260; // minAmount offset

        // Use token.balanceOf to get dynamic value
        bytes memory valueGetter = abi.encodeWithSelector(
            token.balanceOf.selector,
            patcher
        );

        // Expect the LiFiTransferStarted event to be emitted
        ILiFi.BridgeData memory expectedBridgeData = bridgeData;
        expectedBridgeData.minAmount = tokenBalance;

        vm.expectEmit(true, true, true, true, address(relayFacet));
        emit LiFiTransferStarted(expectedBridgeData);

        patcher.executeWithDynamicPatches(
            address(token),
            valueGetter,
            address(relayFacet),
            0,
            originalCalldata,
            offsets,
            false
        );

        // The fact that the call succeeded means the patching worked correctly
    }

    // Test error handling when oracle fails during BridgeData patching with RelayFacet
    function testExecuteWithDynamicPatches_RelayFacetOracleFailure() public {
        priceOracle.setShouldFail(true);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("fail-tx"),
            bridge: "relay",
            integrator: "TestIntegrator",
            referrer: address(0x1234),
            sendingAssetId: address(token),
            receiver: address(0x5678),
            minAmount: 0,
            destinationChainId: 8453,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        RelayFacet.RelayData memory relayData = RelayFacet.RelayData({
            requestId: bytes32("fail-request"),
            nonEVMReceiver: bytes32(0),
            receivingAssetId: bytes32(uint256(uint160(address(0xDEF)))),
            signature: ""
        });

        // Sign the RelayData
        relayData.signature = signData(bridgeData, relayData);

        bytes memory originalCalldata = abi.encodeWithSelector(
            relayFacet.startBridgeTokensViaRelay.selector,
            bridgeData,
            relayData
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 260;

        bytes memory valueGetter = abi.encodeWithSelector(
            priceOracle.calculateMinAmount.selector,
            address(token),
            1000 ether,
            300
        );

        vm.expectRevert(Patcher.FailedToGetDynamicValue.selector);
        patcher.executeWithDynamicPatches(
            address(priceOracle),
            valueGetter,
            address(relayFacet),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Helper function to sign RelayData
    function signData(
        ILiFi.BridgeData memory _bridgeData,
        RelayFacet.RelayData memory _relayData
    ) internal view returns (bytes memory) {
        bytes32 message = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(
                    abi.encodePacked(
                        _relayData.requestId,
                        block.chainid,
                        bytes32(uint256(uint160(address(relayFacet)))),
                        bytes32(uint256(uint160(_bridgeData.sendingAssetId))),
                        _getMappedChainId(_bridgeData.destinationChainId),
                        _bridgeData.receiver == LibAsset.NON_EVM_ADDRESS
                            ? _relayData.nonEVMReceiver
                            : bytes32(uint256(uint160(_bridgeData.receiver))),
                        _relayData.receivingAssetId
                    )
                )
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, message);
        bytes memory signature = abi.encodePacked(r, s, v);
        return signature;
    }

    function _getMappedChainId(
        uint256 chainId
    ) internal pure returns (uint256) {
        if (chainId == 20000000000001) {
            return 8253038;
        }

        if (chainId == 1151111081099710) {
            return 792703809;
        }

        return chainId;
    }
}
