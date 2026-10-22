// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";

import { InvalidCallData, OnlyContractOwner, ReentrancyError } from "lifi/Errors/GenericErrors.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";

import { AttestedBridgeFacet } from "lifi/Facets/AttestedBridgeFacet.sol";
import { ReentrancyGuard } from "lifi/Helpers/ReentrancyGuard.sol";
import { IAttester } from "lifi/Interfaces/IAttester.sol";
import { LibAttestableSelectors } from "lifi/Libraries/LibAttestableSelectors.sol";
import { LibPeripheryRegistry } from "lifi/Libraries/LibPeripheryRegistry.sol";
import { MockBridgeFacet } from "../../utils/MockBridgeFacet.sol";

contract RegistryProbeFacet {
    function probePeripheryRegistry(
        string calldata _name
    ) external view returns (address) {
        return LibPeripheryRegistry.get(_name);
    }
}

contract RecordingAttester is IAttester {
    bytes public lastFacetCalldata;
    bytes public lastAttesterData;
    bytes public lastMsgData;
    address public lastCaller;
    uint256 public calls;

    function attest(
        bytes calldata _facetCalldata,
        bytes calldata _attesterData
    ) external {
        lastFacetCalldata = _facetCalldata;
        lastAttesterData = _attesterData;
        lastMsgData = msg.data;
        lastCaller = msg.sender;
        ++calls;
    }
}

contract RevertingAttester is IAttester {
    error AttesterReverted(bytes payload);

    function attest(bytes calldata, bytes calldata) external pure {
        revert AttesterReverted(new bytes(300));
    }
}

contract ReenteringAttester is IAttester {
    function attest(bytes calldata, bytes calldata) external {
        AttestedBridgeFacet(msg.sender).setAttestableSelector(
            bytes4(0x12345678),
            true
        );
    }
}

contract SentinelFacet {
    error FacetWasCalled();
    error LongRevert(bytes payload);

    function sentinel() external payable {
        revert FacetWasCalled();
    }

    function loudRevert() external payable {
        revert LongRevert(new bytes(300));
    }
}

contract ReenteringFacet is ReentrancyGuard {
    function reenterGateway() external payable nonReentrant {
        AttestedBridgeFacet(address(this)).startBridgeAttested(msg.data, "");
    }
}

contract GatewayToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address _to, uint256 _amount) external {
        balanceOf[_to] += _amount;
    }

    function approve(
        address _spender,
        uint256 _amount
    ) external returns (bool) {
        allowance[msg.sender][_spender] = _amount;
        return true;
    }

    function transferFrom(
        address _from,
        address _to,
        uint256 _amount
    ) external returns (bool) {
        if (
            allowance[_from][msg.sender] < _amount ||
            balanceOf[_from] < _amount
        ) return false;
        allowance[_from][msg.sender] -= _amount;
        balanceOf[_from] -= _amount;
        balanceOf[_to] += _amount;
        return true;
    }
}

contract EchoRevertFacet {
    function echoRevert(bytes calldata _payload) external payable {
        assembly {
            calldatacopy(0, _payload.offset, _payload.length)
            revert(0, _payload.length)
        }
    }

    function returnsWord() external payable returns (uint256) {
        return 0xabcdef;
    }
}

contract EchoRevertAttester is IAttester {
    bytes internal payload;

    function setPayload(bytes calldata _payload) external {
        payload = _payload;
    }

    function attest(bytes calldata, bytes calldata) external view {
        bytes memory p = payload;
        assembly {
            revert(add(p, 0x20), mload(p))
        }
    }
}

contract ReturningAttester {
    uint256 public calls;

    function attest(
        bytes calldata,
        bytes calldata
    ) external returns (uint256, bytes memory) {
        ++calls;
        return (42, new bytes(300));
    }
}

// Not TestBaseFacet: the gateway has no startBridgeTokensVia entrypoints for its base tests
abstract contract GatewayDiamondTestBase is Test {
    event MockBridged(
        address indexed token,
        address indexed from,
        uint256 amount,
        uint256 value
    );
    event AttestableSelectorSet(bytes4 indexed selector, bool enabled);

    string internal constant BRIDGE_ATTESTER_KEY = "BridgeAttester";
    uint256 internal constant AMOUNT = 5e18;
    bytes internal constant ATTESTER_DATA =
        hex"00112233445566778899aabbccddeeff";

    address internal diamond;
    GatewayToken internal token;

    function setUp() public virtual {
        diamond = address(
            new LiFiDiamond(address(this), address(new DiamondCutFacet()))
        );
        token = new GatewayToken();

        bytes4[] memory gateway = new bytes4[](3);
        gateway[0] = AttestedBridgeFacet.startBridgeAttested.selector;
        gateway[1] = AttestedBridgeFacet.setAttestableSelector.selector;
        gateway[2] = AttestedBridgeFacet.isAttestableSelector.selector;
        bytes4[] memory registry = new bytes4[](2);
        registry[0] = PeripheryRegistryFacet
            .registerPeripheryContract
            .selector;
        registry[1] = PeripheryRegistryFacet.getPeripheryContract.selector;
        bytes4[] memory probe = new bytes4[](1);
        probe[0] = RegistryProbeFacet.probePeripheryRegistry.selector;
        bytes4[] memory bridge = new bytes4[](1);
        bridge[0] = MockBridgeFacet.bridge.selector;
        bytes4[] memory sentinel = new bytes4[](2);
        sentinel[0] = SentinelFacet.sentinel.selector;
        sentinel[1] = SentinelFacet.loudRevert.selector;
        bytes4[] memory reentering = new bytes4[](1);
        reentering[0] = ReenteringFacet.reenterGateway.selector;

        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](6);
        cut[0] = LibDiamond.FacetCut(
            address(new AttestedBridgeFacet()),
            LibDiamond.FacetCutAction.Add,
            gateway
        );
        cut[1] = LibDiamond.FacetCut(
            address(new PeripheryRegistryFacet()),
            LibDiamond.FacetCutAction.Add,
            registry
        );
        cut[2] = LibDiamond.FacetCut(
            address(new RegistryProbeFacet()),
            LibDiamond.FacetCutAction.Add,
            probe
        );
        cut[3] = LibDiamond.FacetCut(
            address(new MockBridgeFacet()),
            LibDiamond.FacetCutAction.Add,
            bridge
        );
        cut[4] = LibDiamond.FacetCut(
            address(new SentinelFacet()),
            LibDiamond.FacetCutAction.Add,
            sentinel
        );
        cut[5] = LibDiamond.FacetCut(
            address(new ReenteringFacet()),
            LibDiamond.FacetCutAction.Add,
            reentering
        );
        DiamondCutFacet(diamond).diamondCut(cut, address(0), "");
    }

    function _readyBridge() internal returns (RecordingAttester attester) {
        attester = new RecordingAttester();
        _registerAttester(address(attester));
        _enable(MockBridgeFacet.bridge.selector);
        _fundAndApprove(AMOUNT);
    }

    function _registerAttester(address _attester) internal {
        PeripheryRegistryFacet(diamond).registerPeripheryContract(
            BRIDGE_ATTESTER_KEY,
            _attester
        );
    }

    function _enable(bytes4 _selector) internal {
        AttestedBridgeFacet(diamond).setAttestableSelector(_selector, true);
    }

    function _fundAndApprove(uint256 _amount) internal {
        token.mint(address(this), _amount);
        token.approve(diamond, type(uint256).max);
    }

    function _bridgeCall() internal view returns (bytes memory) {
        return
            abi.encodeCall(MockBridgeFacet.bridge, (address(token), AMOUNT));
    }

    function _callDiamond(bytes memory _data, uint256 _value) internal {
        (bool ok, bytes memory ret) = diamond.call{ value: _value }(_data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _withSelector(
        bytes memory _data,
        bytes4 _selector
    ) internal pure returns (bytes memory out) {
        out = bytes.concat(_data);
        for (uint256 i; i < 4; ++i) {
            out[i] = _selector[i];
        }
    }

    function _tail(
        bytes memory _data
    ) internal pure returns (bytes memory out) {
        bytes memory encoded = abi.encode(_data);
        out = new bytes(encoded.length - 32);
        for (uint256 i; i < out.length; ++i) {
            out[i] = encoded[i + 32];
        }
    }

    function _attestableSlot(
        bytes4 _selector
    ) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(_selector, LibAttestableSelectors.NAMESPACE));
    }

    function _facetSlot(bytes4 _selector) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _selector,
                    keccak256("diamond.standard.diamond.storage")
                )
            );
    }

    function _bridgeAttesterSlot() internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    BRIDGE_ATTESTER_KEY,
                    LibPeripheryRegistry.NAMESPACE
                )
            );
    }

    function _assertRead(
        bytes32[] memory _reads,
        bytes32 _slot
    ) internal pure {
        bool read;
        for (uint256 i; i < _reads.length && !read; ++i) {
            read = _reads[i] == _slot;
        }
        assertTrue(read, "slot not read");
    }

    function _assertNotRead(
        bytes32[] memory _reads,
        bytes32 _slot
    ) internal pure {
        for (uint256 i; i < _reads.length; ++i) {
            assertTrue(_reads[i] != _slot, "slot read before the revert");
        }
    }
}

contract AttestedBridgeFacetTest is GatewayDiamondTestBase {
    function test_IAttesterSelectorMatchesAttestSignature() public pure {
        assertEq(
            IAttester.attest.selector,
            bytes4(keccak256("attest(bytes,bytes)"))
        );
    }

    function test_GatewaySelectorConstantsMatchTheFacet() public pure {
        assertEq(
            LibAttestableSelectors.START_BRIDGE_ATTESTED,
            AttestedBridgeFacet.startBridgeAttested.selector
        );
        assertEq(
            LibAttestableSelectors.SET_ATTESTABLE_SELECTOR,
            AttestedBridgeFacet.setAttestableSelector.selector
        );
        assertEq(
            LibAttestableSelectors.IS_ATTESTABLE_SELECTOR,
            AttestedBridgeFacet.isAttestableSelector.selector
        );
        assertEq(
            LibAttestableSelectors.NAMESPACE,
            keccak256("com.lifi.library.attestable_selectors")
        );
    }

    function testRevert_SetAttestableSelectorFromNonOwner() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(OnlyContractOwner.selector);

        AttestedBridgeFacet(diamond).setAttestableSelector(
            MockBridgeFacet.bridge.selector,
            true
        );
    }

    function testRevert_SetAttestableSelectorForEachGatewaySelector() public {
        bytes4[3] memory own = [
            AttestedBridgeFacet.startBridgeAttested.selector,
            AttestedBridgeFacet.setAttestableSelector.selector,
            AttestedBridgeFacet.isAttestableSelector.selector
        ];
        for (uint256 i; i < own.length; ++i) {
            vm.expectRevert(
                LibAttestableSelectors.GatewaySelectorNotAttestable.selector
            );

            AttestedBridgeFacet(diamond).setAttestableSelector(own[i], true);
        }
    }

    function test_SetAttestableSelectorEmitsAndWritesOneSlot() public {
        bytes4 selector = MockBridgeFacet.bridge.selector;
        assertFalse(
            AttestedBridgeFacet(diamond).isAttestableSelector(selector)
        );

        vm.expectEmit(true, true, true, true, diamond);
        emit AttestableSelectorSet(selector, true);
        vm.record();

        AttestedBridgeFacet(diamond).setAttestableSelector(selector, true);

        (, bytes32[] memory writes) = vm.accesses(diamond);
        assertEq(writes.length, 1);
        assertEq(writes[0], _attestableSlot(selector));
        assertTrue(
            AttestedBridgeFacet(diamond).isAttestableSelector(selector)
        );

        vm.expectEmit(true, true, true, true, diamond);
        emit AttestableSelectorSet(selector, false);

        AttestedBridgeFacet(diamond).setAttestableSelector(selector, false);

        assertFalse(
            AttestedBridgeFacet(diamond).isAttestableSelector(selector)
        );
    }

    function testRevert_CallDataBelowFourBytes() public {
        for (uint256 length; length < 4; ++length) {
            vm.expectRevert(InvalidCallData.selector);

            AttestedBridgeFacet(diamond).startBridgeAttested(
                new bytes(length),
                ATTESTER_DATA
            );
        }
    }

    function testRevert_DisabledSelectorBeforeAnyLookup() public {
        _registerAttester(address(new RecordingAttester()));
        bytes memory call = _bridgeCall();
        vm.record();
        vm.expectRevert(AttestedBridgeFacet.SelectorNotAttestable.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);

        (bytes32[] memory reads, ) = vm.accesses(diamond);
        _assertRead(reads, _attestableSlot(MockBridgeFacet.bridge.selector));
        _assertNotRead(reads, _facetSlot(MockBridgeFacet.bridge.selector));
        _assertNotRead(reads, _bridgeAttesterSlot());
    }

    function testRevert_SelectorNotAttestableAfterRevocation() public {
        _registerAttester(address(new RecordingAttester()));
        _enable(MockBridgeFacet.bridge.selector);
        AttestedBridgeFacet(diamond).setAttestableSelector(
            MockBridgeFacet.bridge.selector,
            false
        );
        bytes memory call = _bridgeCall();
        vm.expectRevert(AttestedBridgeFacet.SelectorNotAttestable.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);
    }

    function testRevert_CannotDispatchTheGateway() public {
        _registerAttester(address(new RecordingAttester()));
        bytes memory inner = abi.encodeCall(
            AttestedBridgeFacet.startBridgeAttested,
            (_bridgeCall(), ATTESTER_DATA)
        );
        vm.expectRevert(AttestedBridgeFacet.SelectorNotAttestable.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(inner, ATTESTER_DATA);
    }

    function testRevert_EnabledSelectorWithoutFacet() public {
        _registerAttester(address(new RecordingAttester()));
        _enable(bytes4(0xdeadbeef));
        vm.expectRevert(LibDiamond.FunctionDoesNotExist.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(
            hex"deadbeef",
            ATTESTER_DATA
        );
    }

    function testRevert_FunctionDoesNotExistBeforeAttesterLookup() public {
        _enable(bytes4(0xdeadbeef));
        vm.record();
        vm.expectRevert(LibDiamond.FunctionDoesNotExist.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(
            hex"deadbeef",
            ATTESTER_DATA
        );

        (bytes32[] memory reads, ) = vm.accesses(diamond);
        _assertRead(reads, _facetSlot(bytes4(0xdeadbeef)));
        _assertNotRead(reads, _bridgeAttesterSlot());
    }

    function testRevert_UnregisteredAttesterBeforeDispatch() public {
        _enable(SentinelFacet.sentinel.selector);
        bytes memory call = abi.encodeCall(SentinelFacet.sentinel, ());
        vm.expectRevert(AttestedBridgeFacet.AttesterNotRegistered.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);

        _registerAttester(address(new RecordingAttester()));
        vm.expectRevert(SentinelFacet.FacetWasCalled.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);
    }

    function testRevert_AttesterWithoutCodeBeforeDispatch() public {
        _registerAttester(makeAddr("attester without code"));
        _enable(SentinelFacet.sentinel.selector);
        bytes memory call = abi.encodeCall(SentinelFacet.sentinel, ());
        vm.expectRevert(AttestedBridgeFacet.AttesterNotRegistered.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);
    }

    function testRevert_FacetRevertBubblesUnchanged() public {
        RecordingAttester attester = new RecordingAttester();
        _registerAttester(address(attester));
        _enable(MockBridgeFacet.bridge.selector);
        _enable(SentinelFacet.loudRevert.selector);
        bytes memory call = _bridgeCall();
        vm.expectRevert(MockBridgeFacet.TransferFromFailed.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);

        call = abi.encodeCall(SentinelFacet.loudRevert, ());
        vm.expectRevert(
            abi.encodeWithSelector(
                SentinelFacet.LongRevert.selector,
                new bytes(300)
            )
        );

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);

        assertEq(attester.calls(), 0);
    }

    function testRevert_AttesterRevertBubblesUnchanged() public {
        _registerAttester(address(new RevertingAttester()));
        _enable(MockBridgeFacet.bridge.selector);
        _fundAndApprove(AMOUNT);
        bytes memory call = _bridgeCall();
        vm.expectRevert(
            abi.encodeWithSelector(
                RevertingAttester.AttesterReverted.selector,
                new bytes(300)
            )
        );

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);
    }

    function test_AttestsTheIdenticalBytes() public {
        RecordingAttester attester = _readyBridge();
        bytes memory call = _bridgeCall();

        vm.expectEmit(true, true, true, true, diamond);
        emit MockBridged(address(token), address(this), AMOUNT, 0);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);

        assertEq(attester.calls(), 1);
        assertEq(attester.lastCaller(), diamond);
        assertEq(attester.lastFacetCalldata(), call);
        assertEq(attester.lastAttesterData(), ATTESTER_DATA);
        assertEq(
            attester.lastMsgData(),
            abi.encodeCall(IAttester.attest, (call, ATTESTER_DATA))
        );
        assertEq(token.balanceOf(diamond), AMOUNT);
    }

    function test_ForwardsTrailingCalldataVerbatim() public {
        RecordingAttester attester = _readyBridge();
        bytes memory call = _bridgeCall();
        bytes memory outer = bytes.concat(
            abi.encodeCall(
                AttestedBridgeFacet.startBridgeAttested,
                (call, ATTESTER_DATA)
            ),
            hex"c0ffee0000000000000001"
        );

        _callDiamond(outer, 0);

        assertEq(attester.lastFacetCalldata(), call);
        assertEq(attester.lastAttesterData(), ATTESTER_DATA);
        assertEq(
            attester.lastMsgData(),
            _withSelector(outer, IAttester.attest.selector)
        );
    }

    function test_ForwardsOverlappingRegionsVerbatim() public {
        RecordingAttester attester = _readyBridge();
        bytes memory call = _bridgeCall();
        bytes memory outer = abi.encodePacked(
            AttestedBridgeFacet.startBridgeAttested.selector,
            uint256(0x40),
            uint256(0x40),
            _tail(call)
        );

        _callDiamond(outer, 0);

        assertEq(attester.lastFacetCalldata(), call);
        assertEq(attester.lastAttesterData(), call);
        assertEq(
            attester.lastMsgData(),
            _withSelector(outer, IAttester.attest.selector)
        );
        assertEq(token.balanceOf(diamond), AMOUNT);
    }

    function test_ValueReachesTheFacetAndNotTheAttester() public {
        RecordingAttester attester = _readyBridge();
        bytes memory call = _bridgeCall();
        vm.deal(address(this), 1 ether);

        vm.expectEmit(true, true, true, true, diamond);
        emit MockBridged(address(token), address(this), AMOUNT, 1 ether);

        AttestedBridgeFacet(diamond).startBridgeAttested{ value: 1 ether }(
            call,
            ATTESTER_DATA
        );

        assertEq(attester.calls(), 1);
        assertEq(address(attester).balance, 0);
        assertEq(diamond.balance, 1 ether);
    }

    function test_WritesNoDiamondStorage() public {
        RecordingAttester attester = _readyBridge();
        bytes memory call = _bridgeCall();
        vm.record();

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);

        (, bytes32[] memory writes) = vm.accesses(diamond);
        assertEq(writes.length, 0);
        assertEq(attester.calls(), 1);
    }

    function testRevert_ReentryFromTheDispatchedFacetHitsTheSharedGuard()
        public
    {
        _registerAttester(address(new RecordingAttester()));
        _enable(ReenteringFacet.reenterGateway.selector);
        bytes memory call = abi.encodeCall(ReenteringFacet.reenterGateway, ());
        vm.expectRevert(ReentrancyError.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);
    }

    function testRevert_AttesterReentryIsNotPrivileged() public {
        _registerAttester(address(new ReenteringAttester()));
        _enable(MockBridgeFacet.bridge.selector);
        _fundAndApprove(AMOUNT);
        bytes memory call = _bridgeCall();
        vm.expectRevert(OnlyContractOwner.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);
    }

    function test_LibPeripheryRegistryMatchesTheRegistryFacetSlot() public {
        bytes32 namespace = 0xddb1a97e204589b19d70796e7a3363c86670116d11313290b7a7eb064a8f3da1;
        bytes32 slot = 0x2ea1c0530bb78d2f977ca48354f502a4489c9a6563d07a122a90ebb900c253fd;
        string memory key = "BridgeAttester";
        address attester = makeAddr("attester");

        _registerAttester(attester);

        assertEq(keccak256(bytes(key)), keccak256(bytes(BRIDGE_ATTESTER_KEY)));
        assertEq(LibPeripheryRegistry.NAMESPACE, namespace);
        assertEq(
            keccak256(bytes("com.lifi.facets.periphery_registry")),
            namespace
        );
        assertEq(keccak256(abi.encodePacked(key, namespace)), slot);
        assertEq(
            PeripheryRegistryFacet(diamond).getPeripheryContract(key),
            attester
        );
        assertEq(
            RegistryProbeFacet(diamond).probePeripheryRegistry(key),
            attester
        );
        assertEq(address(uint160(uint256(vm.load(diamond, slot)))), attester);
    }
}

contract AttestedBridgeFacetFuzzTest is GatewayDiamondTestBase {
    function setUp() public override {
        super.setUp();
        bytes4[] memory sel = new bytes4[](2);
        sel[0] = EchoRevertFacet.echoRevert.selector;
        sel[1] = EchoRevertFacet.returnsWord.selector;
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        cut[0] = LibDiamond.FacetCut(
            address(new EchoRevertFacet()),
            LibDiamond.FacetCutAction.Add,
            sel
        );
        DiamondCutFacet(diamond).diamondCut(cut, address(0), "");
    }

    function test_ForwardsIdenticalBytesForAnyInput(
        uint96 amount,
        bytes calldata attesterData,
        bytes calldata trailing
    ) public {
        RecordingAttester attester = _readyBridge();
        bytes memory call = abi.encodeCall(
            MockBridgeFacet.bridge,
            (address(token), uint256(amount) % AMOUNT)
        );
        bytes memory outer = bytes.concat(
            abi.encodeCall(
                AttestedBridgeFacet.startBridgeAttested,
                (call, attesterData)
            ),
            trailing
        );

        _callDiamond(outer, 0);

        assertEq(
            attester.lastMsgData(),
            _withSelector(outer, IAttester.attest.selector)
        );
        assertEq(attester.lastFacetCalldata(), call);
        assertEq(attester.lastAttesterData(), attesterData);
    }

    function test_AnyValueReachesTheFacetOnly(uint96 value) public {
        RecordingAttester attester = _readyBridge();
        vm.deal(address(this), value);

        vm.expectEmit(true, true, true, true, diamond);
        emit MockBridged(address(token), address(this), AMOUNT, value);

        AttestedBridgeFacet(diamond).startBridgeAttested{ value: value }(
            _bridgeCall(),
            ATTESTER_DATA
        );

        assertEq(address(attester).balance, 0);
        assertEq(diamond.balance, value);
    }

    function testRevert_FacetRevertBubblesAnyPayload(
        bytes calldata payload
    ) public {
        _registerAttester(address(new RecordingAttester()));
        _enable(EchoRevertFacet.echoRevert.selector);
        bytes memory call = abi.encodeCall(
            EchoRevertFacet.echoRevert,
            (payload)
        );
        vm.expectRevert(payload);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);
    }

    function testRevert_AttesterRevertBubblesAnyPayload(
        bytes calldata payload
    ) public {
        EchoRevertAttester attester = new EchoRevertAttester();
        attester.setPayload(payload);
        _registerAttester(address(attester));
        _enable(MockBridgeFacet.bridge.selector);
        _fundAndApprove(AMOUNT);
        vm.expectRevert(payload);

        AttestedBridgeFacet(diamond).startBridgeAttested(
            _bridgeCall(),
            ATTESTER_DATA
        );
    }

    function test_AttesterReturnDataIsIgnored() public {
        ReturningAttester attester = new ReturningAttester();
        _registerAttester(address(attester));
        _enable(MockBridgeFacet.bridge.selector);
        _fundAndApprove(AMOUNT);

        AttestedBridgeFacet(diamond).startBridgeAttested(
            _bridgeCall(),
            ATTESTER_DATA
        );

        assertEq(attester.calls(), 1);
    }

    function test_FacetReturnDataIsDiscarded() public {
        _registerAttester(address(new RecordingAttester()));
        _enable(EchoRevertFacet.returnsWord.selector);
        bytes memory outer = abi.encodeCall(
            AttestedBridgeFacet.startBridgeAttested,
            (abi.encodeCall(EchoRevertFacet.returnsWord, ()), ATTESTER_DATA)
        );

        (bool ok, bytes memory ret) = diamond.call(outer);

        assertTrue(ok);
        assertEq(ret.length, 0);
    }

    function testRevert_AttesterDataHeadOutOfBoundsBeforeAnyLookup() public {
        _readyBridge();
        bytes memory outer = abi.encodeCall(
            AttestedBridgeFacet.startBridgeAttested,
            (_bridgeCall(), ATTESTER_DATA)
        );
        uint256 bad = outer.length + 100;
        assembly {
            mstore(add(outer, 0x44), bad)
        }
        vm.record();

        (bool ok, bytes memory ret) = diamond.call(outer);

        assertFalse(ok);
        assertEq(ret.length, 0);
        (bytes32[] memory reads, ) = vm.accesses(diamond);
        _assertNotRead(
            reads,
            _attestableSlot(MockBridgeFacet.bridge.selector)
        );
        _assertNotRead(reads, _bridgeAttesterSlot());
    }

    /// @dev Heads 0x40 and 0x20: attesterData is the facetCalldata length word.
    function test_SelfReferentialHeadsForwardVerbatim() public {
        RecordingAttester attester = _readyBridge();
        bytes memory call = _bridgeCall();
        bytes memory outer = abi.encodePacked(
            AttestedBridgeFacet.startBridgeAttested.selector,
            uint256(0x40),
            uint256(0x20),
            _tail(call)
        );

        _callDiamond(outer, 0);

        assertEq(attester.lastFacetCalldata(), call);
        assertEq(attester.lastAttesterData(), abi.encode(call.length));
        assertEq(
            attester.lastMsgData(),
            _withSelector(outer, IAttester.attest.selector)
        );
    }

    function test_SetAttestableSelectorForAnySelector(
        bytes4 selector,
        bool enabled
    ) public {
        vm.assume(
            selector != AttestedBridgeFacet.startBridgeAttested.selector &&
                selector !=
                AttestedBridgeFacet.setAttestableSelector.selector &&
                selector != AttestedBridgeFacet.isAttestableSelector.selector
        );

        vm.expectEmit(true, true, true, true, diamond);
        emit AttestableSelectorSet(selector, enabled);
        vm.record();

        AttestedBridgeFacet(diamond).setAttestableSelector(selector, enabled);

        (, bytes32[] memory writes) = vm.accesses(diamond);
        assertEq(writes.length, 1);
        assertEq(writes[0], _attestableSlot(selector));
        assertEq(
            AttestedBridgeFacet(diamond).isAttestableSelector(selector),
            enabled
        );
    }

    function testRevert_SetAttestableSelectorFromAnyNonOwner(
        address caller,
        bytes4 selector,
        bool enabled
    ) public {
        vm.assume(caller != address(this));
        vm.prank(caller);
        vm.expectRevert(OnlyContractOwner.selector);

        AttestedBridgeFacet(diamond).setAttestableSelector(selector, enabled);
    }

    function testRevert_DisabledSelectorForAnyCall(
        bytes4 selector,
        bytes calldata tail
    ) public {
        _registerAttester(address(new RecordingAttester()));
        bytes memory call = bytes.concat(selector, tail);
        vm.expectRevert(AttestedBridgeFacet.SelectorNotAttestable.selector);

        AttestedBridgeFacet(diamond).startBridgeAttested(call, ATTESTER_DATA);
    }

    function test_RegistryGetMatchesTheRegistryFacetForAnyKey(
        string calldata key,
        address value
    ) public {
        PeripheryRegistryFacet(diamond).registerPeripheryContract(key, value);

        assertEq(
            RegistryProbeFacet(diamond).probePeripheryRegistry(key),
            value
        );
        assertEq(
            PeripheryRegistryFacet(diamond).getPeripheryContract(key),
            value
        );
        bytes32 slot = keccak256(
            abi.encodePacked(key, LibPeripheryRegistry.NAMESPACE)
        );
        assertEq(address(uint160(uint256(vm.load(diamond, slot)))), value);
    }
}
