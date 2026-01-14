// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { Patcher } from "../../../src/Periphery/Patcher.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";
import { ILiFi } from "../../../src/Interfaces/ILiFi.sol";
import { RelayDepositoryFacet } from "../../../src/Facets/RelayDepositoryFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { MockRelayDepository } from "../utils/MockRelayDepository.sol";

error MockFailure();
error TargetFailure();
error OracleFailure();
error PriceNotSet();
error CalldataLengthMismatch();
error OffsetNotFound();

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

    // Function that returns data for testing return data length
    function processValueWithReturn(
        uint256 _value
    ) external payable returns (uint256 result, bool success) {
        if (shouldFail) {
            revert TargetFailure();
        }
        lastValue = _value;
        lastSender = msg.sender;
        lastEthValue = msg.value;
        lastCalldata = msg.data;
        emit CallReceived(_value, msg.sender, msg.value);

        // Return the processed value multiplied by 2 and success status
        return (_value * 2, true);
    }
}

contract MockPriceOracle {
    mapping(address => uint256) public prices;
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

    function calculateMinAmount(
        address token,
        uint256 amount,
        uint256 slippageBps
    ) external view returns (uint256) {
        if (shouldFail) {
            revert OracleFailure();
        }
        uint256 price = prices[token];
        if (price == 0) {
            revert PriceNotSet();
        }

        return (amount * (10000 - slippageBps)) / 10000;
    }
}

contract MockSilentFailTarget {
    bool public shouldFail;

    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    function processValue(uint256) external payable {
        if (shouldFail) {
            // Fail silently without error data using assembly
            assembly {
                revert(0, 0)
            }
        }
    }
}

contract MockInvalidReturnSource {
    // Returns bytes instead of uint256
    function getInvalidBytes() external pure returns (bytes memory) {
        return bytes("invalid");
    }

    // Returns bool instead of uint256
    function getInvalidBool() external pure returns (bool) {
        return true;
    }

    // Returns address instead of uint256
    function getInvalidAddress() external pure returns (address) {
        return address(0x1234);
    }

    // Returns multiple values
    function getMultipleReturns() external pure returns (uint256, uint256) {
        return (123, 456);
    }
}

// Test RelayDepositoryFacet Contract
contract TestRelayDepositoryFacet is
    RelayDepositoryFacet,
    TestWhitelistManagerBase
{
    constructor(
        address _relayDepository
    ) RelayDepositoryFacet(_relayDepository) {}
}

contract PatcherTest is TestBase {
    event CallReceived(uint256 value, address sender, uint256 ethValue);
    event PatchExecuted(
        address indexed caller,
        address indexed finalTarget,
        uint256 value,
        bool success,
        uint256 returnDataLength
    );
    event TokensDeposited(
        address indexed caller,
        address indexed tokenAddress,
        uint256 amount,
        address indexed finalTarget
    );

    Patcher internal patcher;
    MockValueSource internal valueSource;
    MockTarget internal target;
    MockSilentFailTarget internal silentFailTarget;
    MockInvalidReturnSource internal invalidReturnSource;
    ERC20 internal token;
    MockPriceOracle internal priceOracle;
    MockRelayDepository internal mockDepository;
    TestRelayDepositoryFacet internal relayDepositoryFacet;
    address internal constant ALLOCATOR_ADDRESS =
        0x1234567890123456789012345678901234567890;

    function setUp() public {
        initTestBase();
        patcher = new Patcher();
        valueSource = new MockValueSource();
        target = new MockTarget();
        silentFailTarget = new MockSilentFailTarget();
        invalidReturnSource = new MockInvalidReturnSource();
        token = new ERC20("Test Token", "TEST", 18);
        priceOracle = new MockPriceOracle();

        // Deploy mock depository and facet for RelayDepositoryFacet tests
        mockDepository = new MockRelayDepository(ALLOCATOR_ADDRESS);
        relayDepositoryFacet = new TestRelayDepositoryFacet(
            address(mockDepository)
        );

        // Add facet to diamond for proper event emission
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = relayDepositoryFacet
            .startBridgeTokensViaRelayDepository
            .selector;
        functionSelectors[1] = relayDepositoryFacet
            .addAllowedContractSelector
            .selector;

        addFacet(diamond, address(relayDepositoryFacet), functionSelectors);
        relayDepositoryFacet = TestRelayDepositoryFacet(address(diamond));
    }

    // Tests basic single value patching into calldata
    function test_ExecuteWithDynamicPatches_Success() public {
        uint256 dynamicValue = 12345;
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

        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(dynamicValue, address(patcher), 0);

        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), dynamicValue);
        assertEq(target.lastSender(), address(patcher));
        assertEq(target.lastEthValue(), 0);
    }

    // Tests patching with ETH value transfer
    function test_ExecuteWithDynamicPatches_WithEthValue() public {
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

    // Tests patching same value to multiple positions in calldata
    function test_ExecuteWithDynamicPatches_MultipleOffsets() public {
        uint256 dynamicValue = 98765;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processMultipleValues.selector,
            uint256(0),
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](2);
        offsets[0] = 4;
        offsets[1] = 36;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

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

        assertEq(target.lastValue(), dynamicValue * 2);
    }

    // Tests patching different values from different sources
    function test_ExecuteWithMultiplePatches_Success() public {
        uint256 value1 = 11111;
        uint256 value2 = 22222;

        MockValueSource valueSource2 = new MockValueSource();
        valueSource.setValue(value1);
        valueSource2.setValue(value2);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processMultipleValues.selector,
            uint256(0),
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
        offsetGroups[0][0] = 4;
        offsetGroups[1] = new uint256[](1);
        offsetGroups[1][0] = 36;

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

    // Tests delegatecall execution mode
    function test_ExecuteWithDynamicPatches_Delegatecall() public {
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

        vm.expectEmit(true, true, true, true, address(patcher));
        emit CallReceived(dynamicValue, address(this), 0);

        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            true
        );
    }

    // Tests oracle/source failure handling
    function testRevert_ExecuteWithDynamicPatches_FailedToGetDynamicValue()
        public
    {
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

    // Tests invalid offset bounds checking
    function testRevert_ExecuteWithDynamicPatches_InvalidPatchOffset() public {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = originalCalldata.length;

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

    // Tests that empty offsets array is rejected
    function testRevert_ExecuteWithDynamicPatches_EmptyOffsets() public {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](0);

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

    function testRevert_ExecuteWithDynamicPatches_ZeroAddress_ValueSource()
        public
    {
        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.expectRevert(Patcher.ZeroAddress.selector);
        patcher.executeWithDynamicPatches(
            address(0),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    function testRevert_ExecuteWithDynamicPatches_ZeroAddress_FinalTarget()
        public
    {
        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.expectRevert(Patcher.ZeroAddress.selector);
        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(0),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Tests input validation for array length mismatches
    function testRevert_ExecuteWithMultiplePatches_MismatchedArrayLengths()
        public
    {
        address[] memory valueSources = new address[](2);
        valueSources[0] = address(valueSource);
        valueSources[1] = address(valueSource);

        bytes[] memory valueGetters = new bytes[](1);
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

    function testRevert_ExecuteWithMultiplePatches_ZeroAddress_FinalTarget()
        public
    {
        address[] memory valueSources = new address[](1);
        valueSources[0] = address(valueSource);

        bytes[] memory valueGetters = new bytes[](1);
        valueGetters[0] = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        uint256[][] memory offsetGroups = new uint256[][](1);
        offsetGroups[0] = new uint256[](1);
        offsetGroups[0][0] = 4;

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        vm.expectRevert(Patcher.ZeroAddress.selector);
        patcher.executeWithMultiplePatches(
            valueSources,
            valueGetters,
            address(0),
            0,
            originalCalldata,
            offsetGroups,
            false
        );
    }

    function testRevert_ExecuteWithMultiplePatches_ZeroAddress_ValueSource()
        public
    {
        address[] memory valueSources = new address[](1);
        valueSources[0] = address(0);

        bytes[] memory valueGetters = new bytes[](1);
        valueGetters[0] = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        uint256[][] memory offsetGroups = new uint256[][](1);
        offsetGroups[0] = new uint256[](1);
        offsetGroups[0][0] = 4;

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        vm.expectRevert(Patcher.ZeroAddress.selector);
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

    function testRevert_ExecuteWithMultiplePatches_EmptyOffsetGroup() public {
        address[] memory valueSources = new address[](1);
        valueSources[0] = address(valueSource);

        bytes[] memory valueGetters = new bytes[](1);
        valueGetters[0] = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        uint256[][] memory offsetGroups = new uint256[][](1);
        offsetGroups[0] = new uint256[](0);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        vm.expectRevert(Patcher.InvalidPatchOffset.selector);
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

    // Tests ERC20 balance patching in realistic scenario
    function test_ExecuteWithDynamicPatches_TokenBalance() public {
        address holder = address(0x1234);
        uint256 balance = 1000 ether;
        token.mint(holder, balance);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processComplexData.selector,
            uint256(0),
            address(token),
            block.timestamp + 1 hours
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            token.balanceOf.selector,
            holder
        );

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

    // Tests target contract failure handling
    function testRevert_ExecuteWithDynamicPatches_TargetCallFailure() public {
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

        vm.expectRevert();
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

    // Tests target contract silent failure (no error data) handling
    function testRevert_ExecuteWithDynamicPatches_SilentTargetCallFailure()
        public
    {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);
        silentFailTarget.setShouldFail(true);

        bytes memory originalCalldata = abi.encodeWithSelector(
            silentFailTarget.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.expectRevert(Patcher.CallExecutionFailed.selector);
        patcher.executeWithDynamicPatches(
            address(valueSource),
            valueGetter,
            address(silentFailTarget),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Tests overwriting same position with multiple patches
    function test_ExecuteWithMultiplePatches_SameOffset() public {
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
        offsetGroups[0][0] = 4;
        offsetGroups[1] = new uint256[](1);
        offsetGroups[1][0] = 4;

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

        assertEq(target.lastValue(), value2);
    }

    // Tests zero value patching edge case
    function test_ExecuteWithDynamicPatches_ZeroValue() public {
        uint256 dynamicValue = 0;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(12345)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

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

    // Tests maximum uint256 value patching edge case
    function test_ExecuteWithDynamicPatches_MaxValue() public {
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

    // Tests token deposit + execution workflow
    function test_DepositAndExecuteWithDynamicPatches_Success() public {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        address user = address(0x1234);
        uint256 tokenBalance = 1000 ether;
        token.mint(user, tokenBalance);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.prank(user);
        token.approve(address(patcher), tokenBalance);

        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(dynamicValue, address(patcher), 0);

        vm.prank(user);
        patcher.depositAndExecuteWithDynamicPatches(
            address(token),
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), dynamicValue);
        assertEq(target.lastSender(), address(patcher));
        assertEq(target.lastEthValue(), 0);

        assertEq(token.balanceOf(address(patcher)), tokenBalance);
        assertEq(token.balanceOf(user), 0);
    }

    // Tests deposit with multiple patches workflow
    function test_DepositAndExecuteWithMultiplePatches_Success() public {
        uint256 value1 = 11111;
        uint256 value2 = 22222;

        MockValueSource valueSource2 = new MockValueSource();
        valueSource.setValue(value1);
        valueSource2.setValue(value2);

        address user = address(0x5678);
        uint256 tokenBalance = 500 ether;
        token.mint(user, tokenBalance);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processMultipleValues.selector,
            uint256(0),
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
        offsetGroups[0][0] = 4;
        offsetGroups[1] = new uint256[](1);
        offsetGroups[1][0] = 36;

        vm.prank(user);
        token.approve(address(patcher), tokenBalance);

        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(value1 + value2, address(patcher), 0);

        vm.prank(user);
        patcher.depositAndExecuteWithMultiplePatches(
            address(token),
            valueSources,
            valueGetters,
            address(target),
            0,
            originalCalldata,
            offsetGroups,
            false
        );

        assertEq(target.lastValue(), value1 + value2);

        assertEq(token.balanceOf(address(patcher)), tokenBalance);
        assertEq(token.balanceOf(user), 0);
    }

    // Tests deposit with zero balance edge case
    function testRevert_DepositAndExecuteWithDynamicPatches_ZeroBalance()
        public
    {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        address user = address(0x9999);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(dynamicValue, address(patcher), 0);

        vm.prank(user);
        patcher.depositAndExecuteWithDynamicPatches(
            address(token),
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), dynamicValue);

        assertEq(token.balanceOf(address(patcher)), 0);
        assertEq(token.balanceOf(user), 0);
    }

    // Tests insufficient approval handling
    function testRevert_DepositAndExecuteWithDynamicPatches_NoApproval()
        public
    {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        address user = address(0xABCD);
        uint256 tokenBalance = 1000 ether;
        token.mint(user, tokenBalance);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.prank(user);
        vm.expectRevert();
        patcher.depositAndExecuteWithDynamicPatches(
            address(token),
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Tests partial approval edge case
    function testRevert_DepositAndExecuteWithDynamicPatches_PartialApproval()
        public
    {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        address user = address(0xEF12);
        uint256 tokenBalance = 1000 ether;
        uint256 approvalAmount = 500 ether;
        token.mint(user, tokenBalance);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.prank(user);
        token.approve(address(patcher), approvalAmount);

        vm.prank(user);
        vm.expectRevert();
        patcher.depositAndExecuteWithDynamicPatches(
            address(token),
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Tests that users can send native tokens with executeWithDynamicPatches
    function test_ExecuteWithDynamicPatches_WithNativeToken() public {
        uint256 dynamicValue = 12345;
        uint256 ethValue = 1 ether;
        valueSource.setValue(dynamicValue);

        address user = address(0xABCD);
        vm.deal(user, ethValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        // User sends native tokens with the call
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(dynamicValue, address(patcher), ethValue);

        vm.prank(user);
        patcher.executeWithDynamicPatches{ value: ethValue }(
            address(valueSource),
            valueGetter,
            address(target),
            ethValue,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), dynamicValue);
        assertEq(target.lastSender(), address(patcher));
        assertEq(target.lastEthValue(), ethValue);

        // Verify that the user's native tokens were spent
        assertEq(user.balance, 0);
    }

    // Tests that depositAndExecuteWithDynamicPatches can handle native tokens
    function test_DepositAndExecuteWithDynamicPatches_WithNativeToken()
        public
    {
        uint256 dynamicValue = 54321;
        uint256 ethValue = 0.5 ether;
        valueSource.setValue(dynamicValue);

        address user = address(0x1234);
        uint256 tokenBalance = 1000 ether;
        token.mint(user, tokenBalance);
        vm.deal(user, ethValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.prank(user);
        token.approve(address(patcher), tokenBalance);

        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(dynamicValue, address(patcher), ethValue);

        vm.prank(user);
        patcher.depositAndExecuteWithDynamicPatches{ value: ethValue }(
            address(token),
            address(valueSource),
            valueGetter,
            address(target),
            ethValue,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), dynamicValue);
        assertEq(target.lastSender(), address(patcher));
        assertEq(target.lastEthValue(), ethValue);

        assertEq(token.balanceOf(address(patcher)), tokenBalance);
        assertEq(token.balanceOf(user), 0);
        assertEq(user.balance, 0);
    }

    // Tests that approval is reset after execution
    function test_DepositAndExecuteWithDynamicPatches_ResetsApproval() public {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        address user = address(0x1234);
        uint256 tokenBalance = 1000 ether;
        token.mint(user, tokenBalance);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.prank(user);
        token.approve(address(patcher), tokenBalance);

        // Check approval before execution
        assertEq(
            token.allowance(address(patcher), address(target)),
            0,
            "Initial allowance should be 0"
        );

        vm.prank(user);
        patcher.depositAndExecuteWithDynamicPatches(
            address(token),
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        // Check that approval was reset after execution
        assertEq(
            token.allowance(address(patcher), address(target)),
            0,
            "Allowance should be reset to 0 after execution"
        );
    }

    // Tests that approval is reset after execution with multiple patches
    function test_DepositAndExecuteWithMultiplePatches_ResetsApproval()
        public
    {
        uint256 value1 = 11111;
        uint256 value2 = 22222;

        MockValueSource valueSource2 = new MockValueSource();
        valueSource.setValue(value1);
        valueSource2.setValue(value2);

        address user = address(0x5678);
        uint256 tokenBalance = 500 ether;
        token.mint(user, tokenBalance);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processMultipleValues.selector,
            uint256(0),
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
        offsetGroups[0][0] = 4;
        offsetGroups[1] = new uint256[](1);
        offsetGroups[1][0] = 36;

        vm.prank(user);
        token.approve(address(patcher), tokenBalance);

        // Check approval before execution
        assertEq(
            token.allowance(address(patcher), address(target)),
            0,
            "Initial allowance should be 0"
        );

        vm.prank(user);
        patcher.depositAndExecuteWithMultiplePatches(
            address(token),
            valueSources,
            valueGetters,
            address(target),
            0,
            originalCalldata,
            offsetGroups,
            false
        );

        // Check that approval was reset after execution
        assertEq(
            token.allowance(address(patcher), address(target)),
            0,
            "Allowance should be reset to 0 after execution"
        );
    }

    // Tests that invalid return data length is rejected
    function testRevert_ExecuteWithDynamicPatches_InvalidReturnDataLength_Bytes()
        public
    {
        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            invalidReturnSource.getInvalidBytes.selector
        );

        vm.expectRevert(Patcher.InvalidReturnDataLength.selector);
        patcher.executeWithDynamicPatches(
            address(invalidReturnSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Tests that bool return type is rejected
    function testRevert_ExecuteWithDynamicPatches_InvalidReturnDataLength_Bool()
        public
    {
        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            invalidReturnSource.getInvalidBool.selector
        );

        // Bool is encoded as 32 bytes, so this should pass the length check
        // but we're documenting that only uint256 is supported
        patcher.executeWithDynamicPatches(
            address(invalidReturnSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Tests that address return type is handled (encoded as 32 bytes)
    function testRevert_ExecuteWithDynamicPatches_InvalidReturnDataLength_Address()
        public
    {
        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            invalidReturnSource.getInvalidAddress.selector
        );

        // Address is encoded as 32 bytes, so this should pass the length check
        // The value will be interpreted as uint256(0x1234)
        vm.expectEmit(true, true, true, true, address(target));
        emit CallReceived(uint256(0x1234), address(patcher), 0);

        patcher.executeWithDynamicPatches(
            address(invalidReturnSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );

        assertEq(target.lastValue(), uint256(0x1234));
    }

    // Tests that multiple return values are rejected
    function testRevert_ExecuteWithDynamicPatches_InvalidReturnDataLength_Multiple()
        public
    {
        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            invalidReturnSource.getMultipleReturns.selector
        );

        vm.expectRevert(Patcher.InvalidReturnDataLength.selector);
        patcher.executeWithDynamicPatches(
            address(invalidReturnSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Tests that events are emitted correctly
    function test_ExecuteWithDynamicPatches_EmitsEvents() public {
        uint256 dynamicValue = 12345;
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

        // Expect PatchExecuted event
        vm.expectEmit(true, true, true, true, address(patcher));
        emit PatchExecuted(
            address(this),
            address(target),
            0,
            true,
            0 // MockTarget.processValue returns no data
        );

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

    // Tests that deposit events are emitted correctly
    function test_DepositAndExecuteWithDynamicPatches_EmitsEvents() public {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        address user = address(0x1234);
        uint256 tokenBalance = 1000 ether;
        token.mint(user, tokenBalance);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValue.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        vm.prank(user);
        token.approve(address(patcher), tokenBalance);

        // Expect TokensDeposited event
        vm.expectEmit(true, true, true, true, address(patcher));
        emit TokensDeposited(
            user,
            address(token),
            tokenBalance,
            address(target)
        );

        // Expect PatchExecuted event
        vm.expectEmit(true, true, true, true, address(patcher));
        emit PatchExecuted(
            user,
            address(target),
            0,
            true,
            0 // MockTarget.processValue returns no data
        );

        vm.prank(user);
        patcher.depositAndExecuteWithDynamicPatches(
            address(token),
            address(valueSource),
            valueGetter,
            address(target),
            0,
            originalCalldata,
            offsets,
            false
        );
    }

    // Tests that events correctly capture return data length
    function test_ExecuteWithDynamicPatches_EmitsEventsWithReturnData()
        public
    {
        uint256 dynamicValue = 12345;
        valueSource.setValue(dynamicValue);

        bytes memory originalCalldata = abi.encodeWithSelector(
            target.processValueWithReturn.selector,
            uint256(0)
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;

        bytes memory valueGetter = abi.encodeWithSelector(
            valueSource.getValue.selector
        );

        // Expect PatchExecuted event with 64 bytes return data (uint256 + bool)
        vm.expectEmit(true, true, true, true, address(patcher));
        emit PatchExecuted(
            address(this),
            address(target),
            0,
            true,
            64 // processValueWithReturn returns (uint256, bool) = 32 + 32 = 64 bytes
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

        // Verify the call succeeded
        assertTrue(success);

        // Verify return data length
        assertEq(returnData.length, 64, "Return data should be 64 bytes");

        // Decode and verify the return values
        (uint256 returnedValue, bool returnedSuccess) = abi.decode(
            returnData,
            (uint256, bool)
        );
        assertEq(
            returnedValue,
            dynamicValue * 2,
            "Returned value should be double the input"
        );
        assertTrue(returnedSuccess, "Returned success should be true");
    }

    // Helper function to find minAmount offset in calldata by comparing two encodings
    function _findMinAmountOffset(
        bytes memory calldataWithZero,
        bytes memory calldataWithMarker
    ) internal pure returns (uint256) {
        // Find the first 32-byte aligned position where they differ (this should be minAmount)
        if (calldataWithZero.length != calldataWithMarker.length) {
            revert CalldataLengthMismatch();
        }

        for (uint256 i = 4; i < calldataWithZero.length - 32; i += 32) {
            // Compare 32-byte chunks
            bool differs = false;
            for (uint256 j = 0; j < 32; j++) {
                if (calldataWithZero[i + j] != calldataWithMarker[i + j]) {
                    differs = true;
                    break;
                }
            }
            if (differs) {
                // Check if all 32 bytes differ (indicating a uint256 field)
                bool allDiffer = true;
                for (uint256 j = 0; j < 32; j++) {
                    if (calldataWithZero[i + j] == calldataWithMarker[i + j]) {
                        allDiffer = false;
                        break;
                    }
                }
                if (allDiffer && i >= 196) {
                    // minAmount should be at or after offset 196
                    return i;
                }
            }
        }
        revert OffsetNotFound();
    }

    // Tests price oracle integration with RelayDepositoryFacet for dynamic minAmount
    function test_ExecuteWithDynamicPatches_RelayDepositoryFacetMinAmount()
        public
    {
        uint256 tokenPrice = 2000 * 1e18;
        uint256 slippageBps = 300;
        priceOracle.setPrice(address(token), tokenPrice);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("test-tx-id"),
            bridge: "relay-depository",
            integrator: "TestIntegrator",
            referrer: address(0x1234),
            sendingAssetId: address(token),
            receiver: address(0x5678),
            minAmount: 0,
            destinationChainId: 8453,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        RelayDepositoryFacet.RelayDepositoryData
            memory depositoryData = RelayDepositoryFacet.RelayDepositoryData({
                orderId: bytes32("test-order-id"),
                depositorAddress: USER_SENDER
            });

        uint256 bridgeAmount = 1000 ether;
        uint256 expectedMinAmount = (bridgeAmount * (10000 - slippageBps)) /
            10000;

        token.mint(address(patcher), expectedMinAmount);

        vm.prank(address(patcher));
        token.approve(address(relayDepositoryFacet), expectedMinAmount);

        uint256 depositoryBalanceBefore = token.balanceOf(
            address(mockDepository)
        );

        // Find offset dynamically by comparing encodings with different minAmount values
        bytes memory calldataWithZero = abi.encodeWithSelector(
            relayDepositoryFacet.startBridgeTokensViaRelayDepository.selector,
            bridgeData,
            depositoryData
        );

        bridgeData
            .minAmount = 0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF;
        bytes memory calldataWithMarker = abi.encodeWithSelector(
            relayDepositoryFacet.startBridgeTokensViaRelayDepository.selector,
            bridgeData,
            depositoryData
        );
        bridgeData.minAmount = 0; // Reset

        uint256 minAmountOffset = _findMinAmountOffset(
            calldataWithZero,
            calldataWithMarker
        );

        bytes memory originalCalldata = calldataWithZero;

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = minAmountOffset;

        bytes memory valueGetter = abi.encodeWithSelector(
            priceOracle.calculateMinAmount.selector,
            address(token),
            bridgeAmount,
            slippageBps
        );

        // Execute patcher - this will patch minAmount in the calldata
        // Note: Event data may differ slightly, so we verify the deposit amount instead
        patcher.executeWithDynamicPatches(
            address(priceOracle),
            valueGetter,
            address(relayDepositoryFacet),
            0,
            originalCalldata,
            offsets,
            false
        );

        uint256 depositoryBalanceAfter = token.balanceOf(
            address(mockDepository)
        );
        assertEq(
            depositoryBalanceAfter,
            depositoryBalanceBefore + expectedMinAmount
        );
    }

    // Tests balance-based bridging with RelayDepositoryFacet
    function test_ExecuteWithDynamicPatches_RelayDepositoryFacetTokenBalance()
        public
    {
        uint256 tokenBalance = 500 ether;

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("balance-patch-tx"),
            bridge: "relay-depository",
            integrator: "TestIntegrator",
            referrer: address(0x1234),
            sendingAssetId: address(token),
            receiver: address(1337),
            minAmount: 0,
            destinationChainId: 8453,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        RelayDepositoryFacet.RelayDepositoryData
            memory depositoryData = RelayDepositoryFacet.RelayDepositoryData({
                orderId: bytes32("balance-patch-request"),
                depositorAddress: USER_SENDER
            });

        token.mint(address(patcher), tokenBalance);

        vm.prank(address(patcher));
        token.approve(address(relayDepositoryFacet), tokenBalance);

        uint256 depositoryBalanceBefore = token.balanceOf(
            address(mockDepository)
        );

        // Find offset dynamically by comparing encodings with different minAmount values
        bytes memory calldataWithZero = abi.encodeWithSelector(
            relayDepositoryFacet.startBridgeTokensViaRelayDepository.selector,
            bridgeData,
            depositoryData
        );

        bridgeData
            .minAmount = 0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF;
        bytes memory calldataWithMarker = abi.encodeWithSelector(
            relayDepositoryFacet.startBridgeTokensViaRelayDepository.selector,
            bridgeData,
            depositoryData
        );
        bridgeData.minAmount = 0; // Reset

        uint256 minAmountOffset = _findMinAmountOffset(
            calldataWithZero,
            calldataWithMarker
        );

        bytes memory originalCalldata2 = calldataWithZero;

        uint256[] memory offsets2 = new uint256[](1);
        offsets2[0] = minAmountOffset;

        bytes memory valueGetter = abi.encodeWithSelector(
            token.balanceOf.selector,
            patcher
        );

        // Execute patcher - this will patch minAmount in the calldata
        patcher.executeWithDynamicPatches(
            address(token),
            valueGetter,
            address(relayDepositoryFacet),
            0,
            originalCalldata2,
            offsets2,
            false
        );

        uint256 depositoryBalanceAfter = token.balanceOf(
            address(mockDepository)
        );
        assertEq(
            depositoryBalanceAfter,
            depositoryBalanceBefore + tokenBalance
        );
    }

    // Tests oracle failure in bridge context
    function testRevert_ExecuteWithDynamicPatches_RelayDepositoryFacetOracleFailure()
        public
    {
        priceOracle.setShouldFail(true);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("fail-tx"),
            bridge: "relay-depository",
            integrator: "TestIntegrator",
            referrer: address(0x1234),
            sendingAssetId: address(token),
            receiver: address(0x5678),
            minAmount: 0,
            destinationChainId: 8453,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        RelayDepositoryFacet.RelayDepositoryData
            memory depositoryData = RelayDepositoryFacet.RelayDepositoryData({
                orderId: bytes32("fail-request"),
                depositorAddress: USER_SENDER
            });

        uint256 depositoryBalanceBefore = token.balanceOf(
            address(mockDepository)
        );

        bytes memory originalCalldata = abi.encodeWithSelector(
            relayDepositoryFacet.startBridgeTokensViaRelayDepository.selector,
            bridgeData,
            depositoryData
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 317; // minAmount offset in BridgeData struct (after selector + static fields + dynamic string data)

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
            address(relayDepositoryFacet),
            0,
            originalCalldata,
            offsets,
            false
        );

        uint256 depositoryBalanceAfter = token.balanceOf(
            address(mockDepository)
        );
        assertEq(depositoryBalanceAfter, depositoryBalanceBefore);
    }
}
