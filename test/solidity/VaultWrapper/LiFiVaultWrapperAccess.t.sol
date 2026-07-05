// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { VaultWrapperAccessControl } from "lifi/VaultWrapper/VaultWrapperAccessControl.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeConfig, FeeType, AccessConfig, ListBackend, ListGate } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { MockVaultAccessControl, RevertingVaultAccessControl } from "./mocks/MockVaultAccessControl.sol";
import { MockSanctionsOracle, RevertingSanctionsOracle } from "./mocks/MockSanctionsOracle.sol";
import { MockGatedERC4626 } from "./mocks/MockGatedERC4626.sol";

contract LiFiVaultWrapperAccessTest is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal yieldAdapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal wrapper;

    MockVaultAccessControl internal accessAdapter;
    MockSanctionsOracle internal oracle;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant DEPOSIT = 1_000e18;

    event ListBackendSet(ListGate indexed gate, ListBackend backend);
    event ListUpdated(
        ListGate indexed gate,
        address indexed account,
        bool listed
    );
    event AllowMerkleRootSet(bytes32 indexed root);
    event ExternalAdapterSet(address indexed adapter);
    event SanctionsOracleSet(address indexed oracle);
    event AllowProven(bytes32 indexed root, address indexed account);

    /// @dev This test contract acts as the deploying factory, so the wrapper reads the
    ///      global circuit breaker back from here.
    function globalPaused() external pure returns (bool) {
        return false;
    }

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        yieldAdapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            address(this)
        );
        accessAdapter = new MockVaultAccessControl();
        oracle = new MockSanctionsOracle();
    }

    /// Helpers ///

    function _cfg() internal pure returns (AccessConfig memory config) {
        config = AccessConfig({
            allowBackend: ListBackend.Disabled,
            denyBackend: ListBackend.Disabled,
            externalAdapter: address(0),
            sanctionsOracle: address(0),
            allowMerkleRoot: bytes32(0)
        });
    }

    function _noFees() internal pure returns (FeeConfig memory fees) {
        fees = FeeConfig({
            rateBps: [uint16(0), 0, 0, 0],
            enabled: [false, false, false, false]
        });
    }

    function _newWrapper(
        AccessConfig memory _config
    ) internal returns (LiFiVaultWrapper) {
        return _newWrapperWithFees(_config, _noFees());
    }

    function _newWrapperWithFees(
        AccessConfig memory _config,
        FeeConfig memory _fees
    ) internal returns (LiFiVaultWrapper w) {
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(yieldAdapter),
                vaultAdmin,
                [uint16(8000), 8000, 8000, 8000],
                _fees,
                abi.encode(_config)
            )
        );

        w = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );
    }

    function _deposit(
        LiFiVaultWrapper _w,
        address _from,
        uint256 _amount,
        address _receiver
    ) internal returns (uint256 shares) {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(_w), _amount);
        shares = _w.deposit(_amount, _receiver);
        vm.stopPrank();
    }

    function _expectDepositRevert(
        LiFiVaultWrapper _w,
        address _from,
        address _receiver,
        bytes memory _revertData
    ) internal {
        asset.mint(_from, DEPOSIT);
        vm.startPrank(_from);
        asset.approve(address(_w), DEPOSIT);
        vm.expectRevert(_revertData);

        _w.deposit(DEPOSIT, _receiver);
        vm.stopPrank();
    }

    /// @dev OZ standard-tree leaf: double-hashed so a leaf can never collide with an
    ///      internal node.
    function _leaf(address _account) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(_account))));
    }

    /// @dev OZ MerkleProof sorted-pair (commutative) node hash.
    function _hashPair(
        bytes32 _a,
        bytes32 _b
    ) internal pure returns (bytes32) {
        return
            _a < _b
                ? keccak256(bytes.concat(_a, _b))
                : keccak256(bytes.concat(_b, _a));
    }

    /// @dev Two-leaf tree over (alice, bob): each account's proof is the other's leaf.
    function _aliceBobRoot() internal view returns (bytes32) {
        return _hashPair(_leaf(alice), _leaf(bob));
    }

    function _proofFor(
        address _other
    ) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = _leaf(_other);
    }

    /// Initialization ///

    function test_EmptyInitDataConfiguresOpenInstance() public {
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(yieldAdapter),
                vaultAdmin,
                [uint16(8000), 8000, 8000, 8000],
                _noFees(),
                ""
            )
        );
        wrapper = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );

        AccessConfig memory config = wrapper.accessConfig();
        assertEq(uint8(config.allowBackend), uint8(ListBackend.Disabled));
        assertEq(uint8(config.denyBackend), uint8(ListBackend.Disabled));
        assertEq(config.externalAdapter, address(0));
        assertEq(config.sanctionsOracle, address(0));
        assertEq(config.allowMerkleRoot, bytes32(0));
        assertTrue(wrapper.sharesTransferable());

        _deposit(wrapper, alice, DEPOSIT, alice);
        assertGt(wrapper.balanceOf(alice), 0);
    }

    function test_InitializeDecodesAndStoresAccessConfig() public {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.Merkle;
        config.allowMerkleRoot = _aliceBobRoot();
        config.denyBackend = ListBackend.Mapping;
        config.sanctionsOracle = address(oracle);
        wrapper = _newWrapper(config);

        AccessConfig memory stored = wrapper.accessConfig();
        assertEq(uint8(stored.allowBackend), uint8(ListBackend.Merkle));
        assertEq(uint8(stored.denyBackend), uint8(ListBackend.Mapping));
        assertEq(stored.externalAdapter, address(0));
        assertEq(stored.sanctionsOracle, address(oracle));
        assertEq(stored.allowMerkleRoot, _aliceBobRoot());
    }

    function test_InitializeEmitsConfigEvents() public {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.External;
        config.denyBackend = ListBackend.External;
        config.externalAdapter = address(accessAdapter);
        config.sanctionsOracle = address(oracle);

        vm.expectEmit(true, false, false, true);
        emit ListBackendSet(ListGate.Allow, ListBackend.External);
        vm.expectEmit(true, false, false, true);
        emit ListBackendSet(ListGate.Deny, ListBackend.External);
        vm.expectEmit(true, false, false, false);
        emit ExternalAdapterSet(address(accessAdapter));
        vm.expectEmit(true, false, false, false);
        emit SanctionsOracleSet(address(oracle));

        _newWrapper(config);
    }

    function testRevert_InitializeRejectsMerkleDenyGate() public {
        AccessConfig memory config = _cfg();
        config.denyBackend = ListBackend.Merkle;

        vm.expectRevert(
            VaultWrapperAccessControl.InvalidAccessConfig.selector
        );

        _newWrapper(config);
    }

    function testRevert_InitializeRejectsExternalGateWithoutAdapter() public {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.External;

        vm.expectRevert(
            VaultWrapperAccessControl.InvalidAccessConfig.selector
        );

        _newWrapper(config);
    }

    function testRevert_InitializeRejectsMerkleAllowWithoutRoot() public {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.Merkle;

        vm.expectRevert(
            VaultWrapperAccessControl.InvalidAccessConfig.selector
        );

        _newWrapper(config);
    }

    function testRevert_InitializeRejectsMalformedInitData() public {
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(yieldAdapter),
                vaultAdmin,
                [uint16(8000), 8000, 8000, 8000],
                _noFees(),
                hex"1234"
            )
        );

        vm.expectRevert();

        new BeaconProxy(address(beacon), initCall);
    }

    /// Mapping allowlist ///

    function _mappingAllowWrapper() internal returns (LiFiVaultWrapper w) {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.Mapping;
        w = _newWrapper(config);

        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        vm.prank(vaultAdmin);
        w.updateList(ListGate.Allow, accounts, true);
    }

    function test_MappingAllowlist_AllowsListedReceiver() public {
        wrapper = _mappingAllowWrapper();

        _deposit(wrapper, alice, DEPOSIT, alice);

        assertGt(wrapper.balanceOf(alice), 0);
        assertTrue(wrapper.isListed(ListGate.Allow, alice));
    }

    function testRevert_MappingAllowlist_BlocksUnlistedReceiver() public {
        wrapper = _mappingAllowWrapper();

        _expectDepositRevert(
            wrapper,
            bob,
            bob,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                bob
            )
        );
    }

    function test_MappingAllowlist_ValidatesReceiverNotSender() public {
        wrapper = _mappingAllowWrapper();

        // Unlisted sender depositing for a listed receiver passes: the perimeter is on
        // who may hold shares, not on who routes the deposit (Composer dual-path).
        _deposit(wrapper, bob, DEPOSIT, alice);
        assertGt(wrapper.balanceOf(alice), 0);

        // Listed sender depositing for an unlisted receiver is blocked.
        _expectDepositRevert(
            wrapper,
            alice,
            carol,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                carol
            )
        );
    }

    function testRevert_MappingAllowlist_GatesMintPath() public {
        wrapper = _mappingAllowWrapper();
        asset.mint(bob, DEPOSIT);
        vm.startPrank(bob);
        asset.approve(address(wrapper), DEPOSIT);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                bob
            )
        );

        wrapper.mint(DEPOSIT, bob);
        vm.stopPrank();
    }

    function test_UpdateList_AddAndRemove() public {
        wrapper = _mappingAllowWrapper();
        address[] memory accounts = new address[](1);
        accounts[0] = bob;

        vm.expectEmit(true, true, false, true, address(wrapper));
        emit ListUpdated(ListGate.Allow, bob, true);

        vm.prank(vaultAdmin);
        wrapper.updateList(ListGate.Allow, accounts, true);

        _deposit(wrapper, bob, DEPOSIT, bob);
        assertGt(wrapper.balanceOf(bob), 0);

        vm.expectEmit(true, true, false, true, address(wrapper));
        emit ListUpdated(ListGate.Allow, bob, false);

        vm.prank(vaultAdmin);
        wrapper.updateList(ListGate.Allow, accounts, false);

        _expectDepositRevert(
            wrapper,
            bob,
            bob,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                bob
            )
        );
    }

    function testRevert_UpdateList_OnlyOwner() public {
        wrapper = _mappingAllowWrapper();
        address[] memory accounts = new address[](1);
        accounts[0] = stranger;

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );

        wrapper.updateList(ListGate.Allow, accounts, true);
    }

    /// Mapping denylist ///

    function _mappingDenyWrapper() internal returns (LiFiVaultWrapper w) {
        AccessConfig memory config = _cfg();
        config.denyBackend = ListBackend.Mapping;
        w = _newWrapper(config);

        address[] memory accounts = new address[](1);
        accounts[0] = bob;
        vm.prank(vaultAdmin);
        w.updateList(ListGate.Deny, accounts, true);
    }

    function test_MappingDenylist_OpenForCleanReceivers() public {
        wrapper = _mappingDenyWrapper();

        _deposit(wrapper, alice, DEPOSIT, alice);

        assertGt(wrapper.balanceOf(alice), 0);
    }

    function testRevert_MappingDenylist_BlocksDeniedReceiver() public {
        wrapper = _mappingDenyWrapper();

        _expectDepositRevert(
            wrapper,
            bob,
            bob,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverDenied.selector,
                bob
            )
        );
    }

    function test_MappingDenylist_ValidatesReceiverNotSender() public {
        wrapper = _mappingDenyWrapper();

        // A denied sender routing a deposit to a clean receiver passes: the denylist
        // gates who may hold shares, not who pays.
        _deposit(wrapper, bob, DEPOSIT, alice);

        assertGt(wrapper.balanceOf(alice), 0);
    }

    /// Both gates at once ///

    function test_BothGates_RequireAllowedAndNotDenied() public {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.Mapping;
        config.denyBackend = ListBackend.Mapping;
        wrapper = _newWrapper(config);

        address[] memory listed = new address[](2);
        listed[0] = alice;
        listed[1] = bob;
        vm.startPrank(vaultAdmin);
        wrapper.updateList(ListGate.Allow, listed, true);
        address[] memory denied = new address[](1);
        denied[0] = bob;
        wrapper.updateList(ListGate.Deny, denied, true);
        vm.stopPrank();

        // Allowed and clean: passes.
        _deposit(wrapper, alice, DEPOSIT, alice);
        assertGt(wrapper.balanceOf(alice), 0);

        // Allowed but denied: the deny gate still blocks.
        _expectDepositRevert(
            wrapper,
            bob,
            bob,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverDenied.selector,
                bob
            )
        );

        // Clean but not allowed: the allow gate blocks first.
        _expectDepositRevert(
            wrapper,
            carol,
            carol,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                carol
            )
        );
    }

    /// Merkle allowlist ///

    function _merkleAllowWrapper() internal returns (LiFiVaultWrapper w) {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.Merkle;
        config.allowMerkleRoot = _aliceBobRoot();
        w = _newWrapper(config);
    }

    function test_MerkleAllowlist_ProveThenDeposit() public {
        wrapper = _merkleAllowWrapper();

        // Membership alone is not enough: the proof must be submitted first.
        _expectDepositRevert(
            wrapper,
            alice,
            alice,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                alice
            )
        );

        vm.expectEmit(true, true, false, false, address(wrapper));
        emit AllowProven(_aliceBobRoot(), alice);

        wrapper.proveAllowed(alice, _proofFor(bob));

        assertTrue(wrapper.isProvenAllowed(alice));
        _deposit(wrapper, alice, DEPOSIT, alice);
        assertGt(wrapper.balanceOf(alice), 0);
    }

    function test_ProveAllowed_IsPermissionless() public {
        wrapper = _merkleAllowWrapper();

        vm.prank(stranger);
        wrapper.proveAllowed(bob, _proofFor(alice));

        assertTrue(wrapper.isProvenAllowed(bob));
    }

    function testRevert_ProveAllowed_RejectsInvalidProof() public {
        wrapper = _merkleAllowWrapper();

        vm.expectRevert(
            abi.encodeWithSelector(
                VaultWrapperAccessControl.InvalidMerkleProof.selector,
                carol
            )
        );

        wrapper.proveAllowed(carol, _proofFor(alice));
    }

    function test_SetAllowMerkleRoot_RotationInvalidatesCache() public {
        wrapper = _merkleAllowWrapper();
        wrapper.proveAllowed(alice, _proofFor(bob));
        _deposit(wrapper, alice, DEPOSIT, alice);

        // Rotate to a single-leaf tree over carol (root == leaf, empty proof).
        bytes32 newRoot = _leaf(carol);

        vm.expectEmit(true, false, false, false, address(wrapper));
        emit AllowMerkleRootSet(newRoot);

        vm.prank(vaultAdmin);
        wrapper.setAllowMerkleRoot(newRoot);

        // Alice's cached membership died with the old root.
        assertFalse(wrapper.isProvenAllowed(alice));
        _expectDepositRevert(
            wrapper,
            alice,
            alice,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                alice
            )
        );

        wrapper.proveAllowed(carol, new bytes32[](0));
        _deposit(wrapper, carol, DEPOSIT, carol);
        assertGt(wrapper.balanceOf(carol), 0);
    }

    function testRevert_SetAllowMerkleRoot_OnlyOwner() public {
        wrapper = _merkleAllowWrapper();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );

        wrapper.setAllowMerkleRoot(bytes32(uint256(1)));
    }

    function testRevert_SetAllowMerkleRoot_RejectsZeroRootWhileMerkleActive()
        public
    {
        wrapper = _merkleAllowWrapper();

        vm.prank(vaultAdmin);
        vm.expectRevert(
            VaultWrapperAccessControl.InvalidAccessConfig.selector
        );

        wrapper.setAllowMerkleRoot(bytes32(0));
    }

    /// External adapter ///

    function _externalAllowWrapper() internal returns (LiFiVaultWrapper w) {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.External;
        config.externalAdapter = address(accessAdapter);
        w = _newWrapper(config);
    }

    function test_ExternalAllowGate_FollowsAdapterPredicate() public {
        wrapper = _externalAllowWrapper();
        accessAdapter.setAllowed(alice, true);

        _deposit(wrapper, alice, DEPOSIT, alice);
        assertGt(wrapper.balanceOf(alice), 0);

        _expectDepositRevert(
            wrapper,
            bob,
            bob,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                bob
            )
        );
    }

    function test_ExternalDenyGate_FollowsAdapterPredicate() public {
        AccessConfig memory config = _cfg();
        config.denyBackend = ListBackend.External;
        config.externalAdapter = address(accessAdapter);
        wrapper = _newWrapper(config);
        accessAdapter.setDenied(bob, true);

        _deposit(wrapper, alice, DEPOSIT, alice);
        assertGt(wrapper.balanceOf(alice), 0);

        _expectDepositRevert(
            wrapper,
            bob,
            bob,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverDenied.selector,
                bob
            )
        );
    }

    function testRevert_ExternalGate_FailsClosedOnBrokenAdapter() public {
        RevertingVaultAccessControl broken = new RevertingVaultAccessControl();
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.External;
        config.externalAdapter = address(broken);
        wrapper = _newWrapper(config);

        _expectDepositRevert(
            wrapper,
            alice,
            alice,
            abi.encodeWithSelector(
                RevertingVaultAccessControl.AdapterBroken.selector
            )
        );
    }

    function testRevert_SetExternalAdapter_OnlyOwner() public {
        wrapper = _externalAllowWrapper();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );

        wrapper.setExternalAdapter(address(0));
    }

    function testRevert_SetExternalAdapter_RejectsZeroWhileExternalActive()
        public
    {
        wrapper = _externalAllowWrapper();

        vm.prank(vaultAdmin);
        vm.expectRevert(
            VaultWrapperAccessControl.InvalidAccessConfig.selector
        );

        wrapper.setExternalAdapter(address(0));
    }

    /// Sanctions oracle ///

    function _oracleWrapper() internal returns (LiFiVaultWrapper w) {
        AccessConfig memory config = _cfg();
        config.sanctionsOracle = address(oracle);
        w = _newWrapper(config);
    }

    function test_Oracle_ScreensReceiverNotSender() public {
        wrapper = _oracleWrapper();
        oracle.setSanctioned(bob, true);

        // Clean receiver passes even when the sender is sanctioned.
        _deposit(wrapper, bob, DEPOSIT, alice);
        assertGt(wrapper.balanceOf(alice), 0);

        _expectDepositRevert(
            wrapper,
            alice,
            bob,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.AccountSanctioned.selector,
                bob
            )
        );
    }

    function test_Oracle_AppliesOnTopOfAllowlist() public {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.Mapping;
        config.sanctionsOracle = address(oracle);
        wrapper = _newWrapper(config);

        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        vm.prank(vaultAdmin);
        wrapper.updateList(ListGate.Allow, accounts, true);
        oracle.setSanctioned(alice, true);

        _expectDepositRevert(
            wrapper,
            alice,
            alice,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.AccountSanctioned.selector,
                alice
            )
        );
    }

    function test_Oracle_DisabledViaZeroAddress() public {
        wrapper = _oracleWrapper();
        oracle.setSanctioned(alice, true);

        vm.expectEmit(true, false, false, false, address(wrapper));
        emit SanctionsOracleSet(address(0));

        vm.prank(vaultAdmin);
        wrapper.setSanctionsOracle(address(0));

        _deposit(wrapper, alice, DEPOSIT, alice);
        assertGt(wrapper.balanceOf(alice), 0);
    }

    function testRevert_Oracle_FailsClosedOnBrokenOracle() public {
        RevertingSanctionsOracle broken = new RevertingSanctionsOracle();
        AccessConfig memory config = _cfg();
        config.sanctionsOracle = address(broken);
        wrapper = _newWrapper(config);

        _expectDepositRevert(
            wrapper,
            alice,
            alice,
            abi.encodeWithSelector(
                RevertingSanctionsOracle.OracleBroken.selector
            )
        );
    }

    function testRevert_SetSanctionsOracle_OnlyOwner() public {
        wrapper = _oracleWrapper();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );

        wrapper.setSanctionsOracle(address(0));
    }

    /// Transfer coupling ///

    function test_Transfer_OpenWhenNoGateActive() public {
        wrapper = _newWrapper(_cfg());
        uint256 shares = _deposit(wrapper, alice, DEPOSIT, alice);

        assertTrue(wrapper.sharesTransferable());

        vm.prank(alice);
        wrapper.transfer(bob, shares);

        assertEq(wrapper.balanceOf(bob), shares);
    }

    function testRevert_Transfer_FrozenWhileAllowGateActive() public {
        wrapper = _mappingAllowWrapper();
        uint256 shares = _deposit(wrapper, alice, DEPOSIT, alice);

        assertFalse(wrapper.sharesTransferable());

        vm.prank(alice);
        vm.expectRevert(
            VaultWrapperAccessControl.SharesNotTransferable.selector
        );

        wrapper.transfer(bob, shares);
    }

    function testRevert_Transfer_FrozenWhileDenyGateActive() public {
        wrapper = _mappingDenyWrapper();
        uint256 shares = _deposit(wrapper, alice, DEPOSIT, alice);

        assertFalse(wrapper.sharesTransferable());

        vm.prank(alice);
        vm.expectRevert(
            VaultWrapperAccessControl.SharesNotTransferable.selector
        );

        wrapper.transfer(carol, shares);
    }

    function testRevert_TransferFrom_FrozenWhileGateActive() public {
        wrapper = _mappingAllowWrapper();
        uint256 shares = _deposit(wrapper, alice, DEPOSIT, alice);

        vm.prank(alice);
        wrapper.approve(bob, shares);

        vm.prank(bob);
        vm.expectRevert(
            VaultWrapperAccessControl.SharesNotTransferable.selector
        );

        wrapper.transferFrom(alice, bob, shares);
    }

    function test_Transfer_ReEnabledWhenGatesDisabled() public {
        wrapper = _mappingAllowWrapper();
        uint256 shares = _deposit(wrapper, alice, DEPOSIT, alice);

        vm.prank(vaultAdmin);
        wrapper.setListBackend(ListGate.Allow, ListBackend.Disabled);

        assertTrue(wrapper.sharesTransferable());

        vm.prank(alice);
        wrapper.transfer(bob, shares);

        assertEq(wrapper.balanceOf(bob), shares);
    }

    function test_Transfer_OracleOnlyScreensRecipient() public {
        wrapper = _oracleWrapper();
        uint256 shares = _deposit(wrapper, alice, DEPOSIT, alice);
        oracle.setSanctioned(bob, true);

        // Oracle alone does not freeze transfers...
        assertTrue(wrapper.sharesTransferable());

        vm.prank(alice);
        wrapper.transfer(carol, shares / 2);

        assertEq(wrapper.balanceOf(carol), shares / 2);

        // ...but a sanctioned recipient cannot acquire shares.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultWrapperAccessControl.AccountSanctioned.selector,
                bob
            )
        );

        wrapper.transfer(bob, shares / 2);
    }

    function test_Transfer_SanctionedSenderMayStillTransferOut() public {
        wrapper = _oracleWrapper();
        uint256 shares = _deposit(wrapper, alice, DEPOSIT, alice);
        oracle.setSanctioned(alice, true);

        // The oracle screens recipients, not senders: freezing a holder's assets is a
        // custodial posture the wrapper deliberately avoids.
        vm.prank(alice);
        wrapper.transfer(carol, shares);

        assertEq(wrapper.balanceOf(carol), shares);
    }

    function test_Transfer_FeeSweepFromWrapperExemptWhileGateActive() public {
        AccessConfig memory config = _cfg();
        config.allowBackend = ListBackend.Mapping;
        FeeConfig memory fees = _noFees();
        fees.rateBps[uint8(FeeType.Management)] = 200;
        fees.enabled[uint8(FeeType.Management)] = true;
        wrapper = _newWrapperWithFees(config, fees);

        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        vm.prank(vaultAdmin);
        wrapper.updateList(ListGate.Allow, accounts, true);

        _deposit(wrapper, alice, DEPOSIT, alice);
        vm.warp(block.timestamp + 30 days);
        _deposit(wrapper, alice, DEPOSIT, alice);

        uint256 feeShares = wrapper.balanceOf(address(wrapper));
        assertGt(feeShares, 0);

        // Payouts from the wrapper's own fee-share balance stay possible while the
        // perimeter is active (S3's sweep path), even to a receiver off the list.
        vm.prank(address(wrapper));
        wrapper.transfer(carol, feeShares);

        assertEq(wrapper.balanceOf(carol), feeShares);
    }

    /// Withdrawals are never gated ///

    function test_Withdraw_OpenAfterRemovalFromAllowlist() public {
        wrapper = _mappingAllowWrapper();
        _deposit(wrapper, alice, DEPOSIT, alice);

        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        vm.prank(vaultAdmin);
        wrapper.updateList(ListGate.Allow, accounts, false);

        uint256 maxAssets = wrapper.maxWithdraw(alice);
        vm.prank(alice);
        wrapper.withdraw(maxAssets, alice, alice);

        assertEq(wrapper.balanceOf(alice), 0);
        assertEq(asset.balanceOf(alice), maxAssets);
    }

    function test_Redeem_OpenForSanctionedHolderAndForeignReceiver() public {
        wrapper = _oracleWrapper();
        uint256 shares = _deposit(wrapper, alice, DEPOSIT, alice);
        oracle.setSanctioned(alice, true);

        // Exit stays structurally open for a holder sanctioned after entry, and the
        // asset receiver is not access-checked either (assets, not shares, leave).
        vm.prank(alice);
        wrapper.redeem(shares, bob, alice);

        assertEq(wrapper.balanceOf(alice), 0);
        assertGt(asset.balanceOf(bob), 0);
    }

    function test_Withdraw_OpenWhileDenyGateListsHolder() public {
        wrapper = _mappingDenyWrapper();
        _deposit(wrapper, alice, DEPOSIT, alice);

        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        vm.prank(vaultAdmin);
        wrapper.updateList(ListGate.Deny, accounts, true);

        uint256 maxAssets = wrapper.maxWithdraw(alice);
        vm.prank(alice);
        wrapper.withdraw(maxAssets, alice, alice);

        assertEq(wrapper.balanceOf(alice), 0);
    }

    /// Backend toggles ///

    function test_SetListBackend_TogglesGateOnAndOff() public {
        wrapper = _newWrapper(_cfg());

        // Open instance: anyone deposits.
        _deposit(wrapper, bob, DEPOSIT, bob);

        vm.expectEmit(true, false, false, true, address(wrapper));
        emit ListBackendSet(ListGate.Allow, ListBackend.Mapping);

        vm.prank(vaultAdmin);
        wrapper.setListBackend(ListGate.Allow, ListBackend.Mapping);

        // Gate on (empty list): closed until seeded.
        _expectDepositRevert(
            wrapper,
            bob,
            bob,
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                bob
            )
        );

        vm.prank(vaultAdmin);
        wrapper.setListBackend(ListGate.Allow, ListBackend.Disabled);

        _deposit(wrapper, bob, DEPOSIT, bob);
        assertGt(wrapper.balanceOf(bob), 0);
    }

    function testRevert_SetListBackend_RejectsMerkleDenyGate() public {
        wrapper = _newWrapper(_cfg());

        vm.prank(vaultAdmin);
        vm.expectRevert(
            VaultWrapperAccessControl.InvalidAccessConfig.selector
        );

        wrapper.setListBackend(ListGate.Deny, ListBackend.Merkle);
    }

    function testRevert_SetListBackend_RejectsExternalWithoutAdapter() public {
        wrapper = _newWrapper(_cfg());

        vm.prank(vaultAdmin);
        vm.expectRevert(
            VaultWrapperAccessControl.InvalidAccessConfig.selector
        );

        wrapper.setListBackend(ListGate.Allow, ListBackend.External);
    }

    function test_SetListBackend_ExternalAfterAdapterConfigured() public {
        wrapper = _newWrapper(_cfg());

        vm.startPrank(vaultAdmin);
        wrapper.setExternalAdapter(address(accessAdapter));
        wrapper.setListBackend(ListGate.Allow, ListBackend.External);
        vm.stopPrank();

        accessAdapter.setAllowed(alice, true);
        _deposit(wrapper, alice, DEPOSIT, alice);

        assertGt(wrapper.balanceOf(alice), 0);
    }

    function testRevert_SetListBackend_RejectsMerkleWithoutRoot() public {
        wrapper = _newWrapper(_cfg());

        vm.prank(vaultAdmin);
        vm.expectRevert(
            VaultWrapperAccessControl.InvalidAccessConfig.selector
        );

        wrapper.setListBackend(ListGate.Allow, ListBackend.Merkle);
    }

    function testRevert_SetListBackend_OnlyOwner() public {
        wrapper = _newWrapper(_cfg());

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );

        wrapper.setListBackend(ListGate.Allow, ListBackend.Mapping);
    }

    /// View mirror ///

    function test_CheckDepositAccess_MirrorsExecution() public {
        wrapper = _mappingAllowWrapper();

        // Passes silently for a listed receiver.
        wrapper.checkDepositAccess(alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                VaultWrapperAccessControl.ReceiverNotAllowed.selector,
                bob
            )
        );

        wrapper.checkDepositAccess(bob);
    }

    /// EIP-4626 limit views ///

    function test_MaxDepositAndMint_ZeroForGatedReceiver() public {
        wrapper = _mappingAllowWrapper();

        // Listed receiver sees the open limit, gated receiver sees 0 (EIP-4626: limits
        // MUST factor in user-specific restrictions), and the view does not revert.
        assertGt(wrapper.maxDeposit(alice), 0);
        assertGt(wrapper.maxMint(alice), 0);
        assertEq(wrapper.maxDeposit(bob), 0);
        assertEq(wrapper.maxMint(bob), 0);
    }

    function test_MaxDeposit_ZeroOnBrokenOracleWithoutReverting() public {
        RevertingSanctionsOracle broken = new RevertingSanctionsOracle();
        AccessConfig memory config = _cfg();
        config.sanctionsOracle = address(broken);
        wrapper = _newWrapper(config);

        // The execution path fails closed by reverting; the limit view fails closed
        // by reporting 0 — EIP-4626 forbids maxDeposit/maxMint from reverting.
        assertEq(wrapper.maxDeposit(alice), 0);
        assertEq(wrapper.maxMint(alice), 0);
    }

    /// Gated underlying (perimeter of the wrapped vault) ///

    function test_GatedUnderlying_RevertsBubbleUpVerbatim() public {
        MockGatedERC4626 gated = new MockGatedERC4626(asset);
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(gated),
                address(yieldAdapter),
                vaultAdmin,
                [uint16(8000), 8000, 8000, 8000],
                _noFees(),
                ""
            )
        );
        wrapper = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );

        // The underlying's own access control rejects the non-onboarded wrapper loudly
        // (no silent bypass of the wrapped vault's perimeter)...
        _expectDepositRevert(
            wrapper,
            alice,
            alice,
            abi.encodeWithSelector(
                MockGatedERC4626.DepositorNotWhitelisted.selector,
                address(wrapper)
            )
        );

        // ...and deposits work once the underlying's operator onboards the wrapper.
        gated.setWhitelisted(address(wrapper), true);
        _deposit(wrapper, alice, DEPOSIT, alice);

        assertGt(wrapper.balanceOf(alice), 0);
    }
}
