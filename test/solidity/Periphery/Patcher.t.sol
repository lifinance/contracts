// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { Patcher } from "../../../src/Periphery/Patcher.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";
import { ILiFi } from "../../../src/Interfaces/ILiFi.sol";
import { RelayFacet } from "../../../src/Facets/RelayFacet.sol";
import { LibAsset } from "../../../src/Libraries/LibAsset.sol";
import { LibAllowList } from "../../../src/Libraries/LibAllowList.sol";

error MockFailure();
error TargetFailure();
error OracleFailure();
error PriceNotSet();

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

contract PatcherTest is TestBase {
    event CallReceived(uint256 value, address sender, uint256 ethValue);

    Patcher internal patcher;
    MockValueSource internal valueSource;
    MockTarget internal target;
    MockSilentFailTarget internal silentFailTarget;
    ERC20 internal token;
    MockPriceOracle internal priceOracle;
    TestRelayFacet internal relayFacet;

    address internal constant RELAY_RECEIVER =
        0xa5F565650890fBA1824Ee0F21EbBbF660a179934;
    uint256 internal privateKey = 0x1234567890;
    address internal relaySolver;

    function setUp() public {
        initTestBase();
        patcher = new Patcher();
        valueSource = new MockValueSource();
        target = new MockTarget();
        silentFailTarget = new MockSilentFailTarget();
        token = new ERC20("Test Token", "TEST", 18);
        priceOracle = new MockPriceOracle();

        relaySolver = vm.addr(privateKey);
        relayFacet = new TestRelayFacet(RELAY_RECEIVER, relaySolver);
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

    // Tests price oracle integration with RelayFacet for dynamic minAmount
    function test_ExecuteWithDynamicPatches_RelayFacetMinAmount() public {
        uint256 tokenPrice = 2000 * 1e18;
        uint256 slippageBps = 300;
        priceOracle.setPrice(address(token), tokenPrice);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("test-tx-id"),
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
            requestId: bytes32("test-request-id"),
            nonEVMReceiver: bytes32(0),
            receivingAssetId: bytes32(uint256(uint160(address(0xDEF)))),
            signature: ""
        });

        relayData.signature = signData(bridgeData, relayData);

        uint256 bridgeAmount = 1000 ether;
        uint256 expectedMinAmount = (bridgeAmount * (10000 - slippageBps)) /
            10000;

        token.mint(address(patcher), expectedMinAmount);

        vm.prank(address(patcher));
        token.approve(address(relayFacet), expectedMinAmount);

        uint256 relaySolverBalanceBefore = token.balanceOf(relaySolver);

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
            bridgeAmount,
            slippageBps
        );

        ILiFi.BridgeData memory expectedBridgeData = bridgeData;
        expectedBridgeData.minAmount = expectedMinAmount;

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

        uint256 relaySolverBalanceAfter = token.balanceOf(relaySolver);
        assertEq(
            relaySolverBalanceAfter,
            relaySolverBalanceBefore + expectedMinAmount
        );
    }

    // Tests balance-based bridging with RelayFacet
    function test_ExecuteWithDynamicPatches_RelayFacetTokenBalance() public {
        uint256 tokenBalance = 500 ether;

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32("balance-patch-tx"),
            bridge: "relay",
            integrator: "TestIntegrator",
            referrer: address(0x1234),
            sendingAssetId: address(token),
            receiver: address(1337),
            minAmount: 0,
            destinationChainId: 8453,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        RelayFacet.RelayData memory relayData = RelayFacet.RelayData({
            requestId: bytes32("balance-patch-request"),
            nonEVMReceiver: bytes32(0),
            receivingAssetId: bytes32(uint256(uint160(address(0xDEF)))),
            signature: ""
        });

        relayData.signature = signData(bridgeData, relayData);

        token.mint(address(patcher), tokenBalance);

        vm.prank(address(patcher));
        token.approve(address(relayFacet), tokenBalance);

        uint256 relaySolverBalanceBefore = token.balanceOf(relaySolver);

        bytes memory originalCalldata = abi.encodeWithSelector(
            relayFacet.startBridgeTokensViaRelay.selector,
            bridgeData,
            relayData
        );

        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 260;

        bytes memory valueGetter = abi.encodeWithSelector(
            token.balanceOf.selector,
            patcher
        );

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

        uint256 relaySolverBalanceAfter = token.balanceOf(relaySolver);
        assertEq(
            relaySolverBalanceAfter,
            relaySolverBalanceBefore + tokenBalance
        );
    }

    // Tests oracle failure in bridge context
    function testRevert_ExecuteWithDynamicPatches_RelayFacetOracleFailure()
        public
    {
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

        relayData.signature = signData(bridgeData, relayData);

        uint256 relaySolverBalanceBefore = token.balanceOf(relaySolver);

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

        uint256 relaySolverBalanceAfter = token.balanceOf(relaySolver);
        assertEq(relaySolverBalanceAfter, relaySolverBalanceBefore);
    }

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
}
