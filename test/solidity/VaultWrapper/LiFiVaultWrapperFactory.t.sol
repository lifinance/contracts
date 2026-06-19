// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ILiFiVaultWrapperFactory } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapperFactory.sol";
import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { LibClone } from "solady/utils/LibClone.sol";
import { FeeType, DeployParams, FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { UnAuthorized, InvalidContract } from "lifi/Errors/GenericErrors.sol";
import { MockERC4626Underlying } from "./mocks/MockERC4626Underlying.sol";

contract LiFiVaultWrapperFactoryTest is Test {
    LiFiVaultWrapperFactory internal factory;
    UpgradeableBeacon internal beacon;
    MockVaultWrapper internal impl;
    ERC4626Adapter internal adapter;

    address internal owner = makeAddr("owner");
    address internal pauser = makeAddr("pauser");
    address internal onboarder = makeAddr("onboarder");
    address internal deployer = makeAddr("deployer");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    bytes32 internal constant NS = bytes32("Coinbase");
    MockERC4626Underlying internal underlying;
    address internal assetToken = makeAddr("asset");

    function setUp() public virtual {
        impl = new MockVaultWrapper();
        beacon = new UpgradeableBeacon(address(impl));
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            pauser,
            onboarder
        );
        adapter = new ERC4626Adapter();
        vm.prank(owner);
        factory.setAdapterApproved(address(adapter), true);
    }

    function test_ConstructorSetsRolesBeaconAndDefaultSplit() public view {
        assertEq(factory.BEACON(), address(beacon));
        assertEq(factory.owner(), owner);
        assertEq(factory.emergencyPauser(), pauser);
        assertEq(factory.onboardingManager(), onboarder);
        assertEq(factory.defaultIntegratorShareBps(), 8000);
        assertFalse(factory.globalPaused());
    }

    function test_ConstructorRevertsOnZeroBeacon() public {
        vm.expectRevert();
        new LiFiVaultWrapperFactory(address(0), owner, pauser, onboarder);
    }

    function test_OwnerSetsUnderlyingAllowed() public {
        address u = makeAddr("underlying");
        vm.expectEmit(true, false, false, true, address(factory));
        emit ILiFiVaultWrapperFactory.UnderlyingAllowedSet(u, true);
        vm.prank(owner);
        factory.setUnderlyingAllowed(u, true);
        assertTrue(factory.allowedUnderlying(u));
    }

    function test_NonOwnerCannotSetUnderlyingAllowed() public {
        vm.expectRevert(UnAuthorized.selector);
        factory.setUnderlyingAllowed(makeAddr("underlying"), true);
    }

    function test_OwnerSetsFeeBounds() public {
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Performance, 100, 4000);
        (uint16 minBps, uint16 maxBps) = factory.feeBounds(
            FeeType.Performance
        );
        assertEq(minBps, 100);
        assertEq(maxBps, 4000);
    }

    function test_SetFeeBoundsRevertsAboveCap() public {
        vm.prank(owner);
        vm.expectRevert(ILiFiVaultWrapperFactory.InvalidFeeBounds.selector);
        factory.setFeeBounds(FeeType.Performance, 0, 6000); // cap is 5000
    }

    function test_SetFeeBoundsRevertsMinAboveMax() public {
        vm.prank(owner);
        vm.expectRevert(ILiFiVaultWrapperFactory.InvalidFeeBounds.selector);
        factory.setFeeBounds(FeeType.Deposit, 500, 100);
    }

    function test_OwnerSetsDefaultSplit() public {
        vm.prank(owner);
        factory.setDefaultSplit(3000);
        assertEq(factory.defaultIntegratorShareBps(), 3000);
    }

    function test_SetDefaultSplitRevertsAbove100Percent() public {
        vm.prank(owner);
        vm.expectRevert(ILiFiVaultWrapperFactory.InvalidSplit.selector);
        factory.setDefaultSplit(10001);
    }

    function test_OnboardingManagerAssignsDeployer() public {
        vm.expectEmit(true, true, false, false, address(factory));
        emit ILiFiVaultWrapperFactory.IntegratorDeployerSet(NS, deployer);
        vm.prank(onboarder);
        factory.setApprovedIntegratorDeployer(NS, deployer);
        assertEq(factory.approvedIntegratorDeployer(NS), deployer);
    }

    function test_NonOnboardingManagerCannotAssignDeployer() public {
        vm.prank(owner);
        vm.expectRevert(
            ILiFiVaultWrapperFactory.NotOnboardingManager.selector
        );
        factory.setApprovedIntegratorDeployer(NS, deployer);
    }

    function test_AssignDeployerRevertsOnZeroNamespace() public {
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapperFactory.ZeroNamespace.selector);
        factory.setApprovedIntegratorDeployer(bytes32(0), deployer);
    }

    function test_EmergencyPauserTogglesGlobalPause() public {
        vm.prank(pauser);
        factory.globalPause();
        assertTrue(factory.globalPaused());
        vm.prank(pauser);
        factory.globalUnpause();
        assertFalse(factory.globalPaused());
    }

    function test_NonPauserCannotGlobalPause() public {
        vm.prank(owner);
        vm.expectRevert(ILiFiVaultWrapperFactory.NotEmergencyPauser.selector);
        factory.globalPause();
    }

    function test_OwnerRotatesRoles() public {
        address newPauser = makeAddr("newPauser");
        vm.prank(owner);
        factory.setEmergencyPauser(newPauser);
        assertEq(factory.emergencyPauser(), newPauser);

        vm.prank(pauser);
        vm.expectRevert(ILiFiVaultWrapperFactory.NotEmergencyPauser.selector);
        factory.globalPause(); // old pauser lost power
    }

    function test_OwnerRotatesOnboardingManager() public {
        address newManager = makeAddr("newManager");
        vm.prank(owner);
        factory.setOnboardingManager(newManager);
        assertEq(factory.onboardingManager(), newManager);

        vm.prank(onboarder);
        vm.expectRevert(
            ILiFiVaultWrapperFactory.NotOnboardingManager.selector
        );
        factory.setApprovedIntegratorDeployer(NS, deployer); // old manager lost power
    }

    function test_PredictAddressIsDeterministicAndNonceVaries() public {
        address u = makeAddr("underlying");
        address a = factory.predictAddress(NS, address(adapter), u, 0);
        address b = factory.predictAddress(NS, address(adapter), u, 0);
        address c = factory.predictAddress(NS, address(adapter), u, 1);
        assertEq(a, b);
        assertTrue(a != c);
        assertTrue(a != address(0));
    }

    function _enableUnderlyingAndBounds() internal {
        underlying = new MockERC4626Underlying(assetToken);
        vm.startPrank(owner);
        factory.setUnderlyingAllowed(address(underlying), true);
        factory.setFeeBounds(FeeType.Performance, 0, 5000);
        vm.stopPrank();
    }

    function _params(
        uint256 nonce_
    ) internal view returns (DeployParams memory p) {
        uint16[4] memory rates = [uint16(1000), 0, 0, 0];
        bool[4] memory enabled = [true, false, false, false];
        p = DeployParams({
            namespace: NS,
            vaultWrapperAdmin: vaultAdmin,
            adapter: address(adapter),
            underlying: address(underlying),
            nonce: nonce_,
            fees: FeeConfig({ rateBps: rates, enabled: enabled }),
            integratorShareBps: type(uint16).max, // inherit factory default
            initData: hex"1234"
        });
    }

    function test_OnboardingManagerDeploysAndWiresClone() public {
        _enableUnderlyingAndBounds();
        DeployParams memory p = _params(0);

        address predicted = factory.predictAddress(
            NS,
            address(adapter),
            address(underlying),
            0
        );

        vm.prank(onboarder);
        address instance = factory.deploy(p);

        assertEq(instance, predicted);
        assertTrue(factory.isInstance(instance));

        MockVaultWrapper w = MockVaultWrapper(instance);
        assertTrue(w.initialized());
        assertEq(w.asset(), assetToken);
        assertEq(w.underlying(), address(underlying));
        assertEq(w.adapter(), address(adapter));
        assertEq(w.vaultWrapperAdmin(), vaultAdmin);
        assertEq(w.integratorShareBps(), 8000); // factory default
        assertEq(w.feeRate(uint8(FeeType.Performance)), 1000);
        assertTrue(w.feeEnabled(uint8(FeeType.Performance)));
        assertEq(w.initData(), hex"1234");
    }

    function test_WrapperDeployedEmitsAssetAndSplit() public {
        _enableUnderlyingAndBounds();
        DeployParams memory p = _params(0);
        address predicted = factory.predictAddress(
            NS,
            address(adapter),
            address(underlying),
            0
        );
        bytes32 expectedSalt = keccak256(
            abi.encode(NS, address(adapter), address(underlying), uint256(0))
        );

        vm.expectEmit(true, true, true, true, address(factory));
        emit ILiFiVaultWrapperFactory.WrapperDeployed(
            predicted,
            NS,
            address(underlying),
            address(adapter),
            assetToken,
            vaultAdmin,
            8000, // factory default
            0,
            expectedSalt
        );
        vm.prank(onboarder);
        factory.deploy(p);
    }

    function test_AssignedDeployerSelfDeploys() public {
        _enableUnderlyingAndBounds();
        vm.prank(onboarder);
        factory.setApprovedIntegratorDeployer(NS, deployer);

        DeployParams memory p = _params(0);
        vm.prank(deployer);
        address instance = factory.deploy(p);
        assertTrue(factory.isInstance(instance));
    }

    function test_DeployWithSplitOverride() public {
        _enableUnderlyingAndBounds();
        DeployParams memory p = _params(0);
        p.integratorShareBps = 5000;
        vm.prank(onboarder);
        address instance = factory.deploy(p);
        assertEq(MockVaultWrapper(instance).integratorShareBps(), 5000);
    }

    function test_SelfDeployerSetsSplit() public {
        _enableUnderlyingAndBounds();
        vm.prank(onboarder);
        factory.setApprovedIntegratorDeployer(NS, deployer);
        DeployParams memory p = _params(0);
        p.integratorShareBps = 7000;
        vm.prank(deployer);
        address instance = factory.deploy(p);
        assertEq(MockVaultWrapper(instance).integratorShareBps(), 7000);
    }

    function test_DeployRevertsOnSplitAbove100Percent() public {
        _enableUnderlyingAndBounds();
        DeployParams memory p = _params(0);
        p.integratorShareBps = 10001;
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapperFactory.InvalidSplit.selector);
        factory.deploy(p);
    }

    function test_UnassignedCallerCannotDeploy() public {
        _enableUnderlyingAndBounds();
        DeployParams memory p = _params(0);
        vm.prank(makeAddr("random"));
        vm.expectRevert(ILiFiVaultWrapperFactory.NotApprovedDeployer.selector);
        factory.deploy(p);
    }

    function test_DeployerCannotUseUnassignedNamespace() public {
        _enableUnderlyingAndBounds();
        vm.prank(onboarder);
        factory.setApprovedIntegratorDeployer(NS, deployer);
        DeployParams memory p = _params(0);
        p.namespace = bytes32("Acme"); // deployer is only assigned to NS
        vm.prank(deployer);
        vm.expectRevert(ILiFiVaultWrapperFactory.NotApprovedDeployer.selector);
        factory.deploy(p);
    }

    function test_DeployRevertsOnZeroNamespace() public {
        _enableUnderlyingAndBounds();
        DeployParams memory p = _params(0);
        p.namespace = bytes32(0);
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapperFactory.ZeroNamespace.selector);
        factory.deploy(p);
    }

    function test_DeployRevertsOnZeroVaultAdmin() public {
        _enableUnderlyingAndBounds();
        DeployParams memory p = _params(0);
        p.vaultWrapperAdmin = address(0);
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapperFactory.ZeroAddress.selector);
        factory.deploy(p);
    }

    function test_DeployRevertsOnDisallowedUnderlying() public {
        underlying = new MockERC4626Underlying(assetToken);
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Performance, 0, 5000);
        DeployParams memory p = _params(0);
        vm.prank(onboarder);
        vm.expectRevert(
            ILiFiVaultWrapperFactory.UnderlyingNotAllowed.selector
        );
        factory.deploy(p);
    }

    function test_DeployRevertsOnAssetResolutionFailureNoCode() public {
        address notAVault = makeAddr("eoa");
        vm.startPrank(owner);
        factory.setUnderlyingAllowed(notAVault, true);
        factory.setFeeBounds(FeeType.Performance, 0, 5000);
        vm.stopPrank();
        DeployParams memory p = _params(0);
        p.underlying = notAVault;
        vm.prank(onboarder);
        vm.expectRevert(
            ILiFiVaultWrapperFactory.AssetResolutionFailed.selector
        );
        factory.deploy(p);
    }

    function test_DeployRevertsOnFeeAboveBound() public {
        _enableUnderlyingAndBounds(); // perf bounds 0..5000
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Performance, 0, 500); // tighten max to 5%
        DeployParams memory p = _params(0); // rate 1000 = 10%
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapperFactory.FeeRateAboveBound.selector);
        factory.deploy(p);
    }

    function test_DeployRevertsOnFeeAboveCap() public {
        _enableUnderlyingAndBounds();
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Management, 0, 1000); // mgmt cap is 1000
        DeployParams memory p = _params(0);
        uint16[4] memory rates = [uint16(0), 1500, 0, 0]; // 15% > 10% cap
        bool[4] memory enabled = [false, true, false, false];
        p.fees = FeeConfig({ rateBps: rates, enabled: enabled });
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapperFactory.FeeRateAboveCap.selector);
        factory.deploy(p);
    }

    function test_DeployRevertsOnDisabledFeeWithNonZeroRate() public {
        _enableUnderlyingAndBounds();
        DeployParams memory p = _params(0);
        p.fees.enabled[0] = false; // disabled but rate is 1000
        vm.prank(onboarder);
        vm.expectRevert(
            ILiFiVaultWrapperFactory.DisabledFeeMustBeZero.selector
        );
        factory.deploy(p);
    }

    function test_DeployRevertsOnEnabledFeeWithUnsetBounds() public {
        // Underlying allowed, but Performance bounds never configured (default 0..0):
        // an enabled non-zero rate must fail closed.
        underlying = new MockERC4626Underlying(assetToken);
        vm.prank(owner);
        factory.setUnderlyingAllowed(address(underlying), true);
        DeployParams memory p = _params(0); // Performance rate 1000, enabled
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapperFactory.FeeRateAboveBound.selector);
        factory.deploy(p);
    }

    function test_DuplicateDeployReverts() public {
        _enableUnderlyingAndBounds();
        DeployParams memory p = _params(0);
        vm.prank(onboarder);
        factory.deploy(p);
        vm.prank(onboarder);
        vm.expectRevert(LibClone.DeploymentFailed.selector);
        factory.deploy(p);
    }

    function test_TracksDeployedInstances() public {
        _enableUnderlyingAndBounds();
        vm.startPrank(onboarder);
        address i0 = factory.deploy(_params(0));
        address i1 = factory.deploy(_params(1));
        vm.stopPrank();

        assertTrue(i0 != i1);
        assertTrue(factory.isInstance(i0));
        assertTrue(factory.isInstance(i1));
        assertFalse(factory.isInstance(makeAddr("notAnInstance")));
    }

    function test_DeployRevertsOnUnapprovedAdapter() public {
        _enableUnderlyingAndBounds();
        ERC4626Adapter rogue = new ERC4626Adapter();
        DeployParams memory p = _params(0);
        p.adapter = address(rogue); // never approved
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapperFactory.AdapterNotApproved.selector);
        factory.deploy(p);
    }

    function test_PredictAddressVariesByAdapter() public {
        ERC4626Adapter other = new ERC4626Adapter();
        address u = makeAddr("underlying");
        address withA = factory.predictAddress(NS, address(adapter), u, 0);
        address withB = factory.predictAddress(NS, address(other), u, 0);
        assertTrue(withA != withB);
    }

    function test_OwnerSetsAdapterApproved() public {
        address a = address(new ERC4626Adapter());
        vm.expectEmit(true, false, false, true, address(factory));
        emit ILiFiVaultWrapperFactory.AdapterApprovedSet(a, true);
        vm.prank(owner);
        factory.setAdapterApproved(a, true);
        assertTrue(factory.approvedAdapter(a));
    }

    function test_NonOwnerCannotSetAdapterApproved() public {
        vm.expectRevert(UnAuthorized.selector);
        factory.setAdapterApproved(makeAddr("adapter2"), true);
    }

    function test_SetAdapterApprovedRevertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(ILiFiVaultWrapperFactory.ZeroAddress.selector);
        factory.setAdapterApproved(address(0), true);
    }

    function test_SetAdapterApprovedRevertsOnNonContract() public {
        vm.prank(owner);
        vm.expectRevert(InvalidContract.selector);
        factory.setAdapterApproved(makeAddr("eoa"), true);
    }
}
