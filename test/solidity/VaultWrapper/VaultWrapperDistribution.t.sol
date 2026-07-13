// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { LibVaultWrapperMath } from "lifi/VaultWrapper/libraries/LibVaultWrapperMath.sol";
import { FeeType, FeeConfig, DeployParams, FeeReceiver } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice A blacklisting ERC20: `transfer` reverts to any blocked address (mirrors USDC).
///         Used to exercise the distributeFees redirect-failed-integrator-payout-to-LI.FI path.
contract BlacklistERC20 is MockERC20 {
    mapping(address => bool) public blocked;

    error RecipientBlocked();

    constructor() MockERC20("Block", "BLK", 18) {}

    function setBlocked(address _account, bool _isBlocked) external {
        blocked[_account] = _isBlocked;
    }

    function transfer(
        address _to,
        uint256 _amount
    ) public override returns (bool) {
        if (blocked[_to]) revert RecipientBlocked();
        return super.transfer(_to, _amount);
    }
}

/// @notice Integration tests for the LiFiVaultWrapper fee distribution layer (EXSC-411, S3):
///         receiver config, the permissionless `distributeFees` paying out the per-recipient
///         counters booked at accrual (no re-split at distribution) over both fee pools (idle
///         asset + dilution shares), the 1..50 wallet fan-out with last-receiver remainder, and the
///         redirect-failed-integrator-payout-to-LI.FI behaviour. Fees are driven through real
///         deposit/withdraw/time accrual (the S2 engine), not seeded directly. Pause-bypass
///         coverage is deferred to S5 integration.
contract VaultWrapperDistributionTest is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapperFactory internal factory;
    LiFiVaultWrapper internal wrapper;

    address internal owner = makeAddr("owner");
    address internal onboarder = makeAddr("onboarder");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal alice = makeAddr("alice");

    uint256 internal constant DEPOSIT = 1_000e18;
    uint16 internal constant SPLIT = 8000; // 80% integrator / 20% LI.FI
    uint16 internal constant DEP_RATE = 100; // 1%
    uint16 internal constant WD_RATE = 100; // 1%
    uint16 internal constant MGMT_RATE = 200; // 2% / year
    uint256 internal constant YEAR = 365 days;

    event ReceiversSet(FeeReceiver[] receivers);
    event FeePoolDistributed(
        address indexed token,
        uint256 lifiAmount,
        uint256 integratorAmount
    );
    event IntegratorPayoutRedirected(
        address indexed receiver,
        address indexed token,
        uint256 amount
    );

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            address(this)
        );
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            makeAddr("pauser"),
            onboarder,
            lifiRecipient
        );

        vm.startPrank(owner);
        factory.setAdapterApproved(address(adapter), true);
        factory.setUnderlyingAllowed(address(underlying), true);
        factory.setFeeBounds(FeeType.Management, 0, 1000);
        factory.setFeeBounds(FeeType.Deposit, 0, 2000);
        factory.setFeeBounds(FeeType.Withdrawal, 0, 2000);
        vm.stopPrank();
    }

    /// Receiver configuration ///

    function test_InitConfiguresReceivers() public {
        address[] memory wallets = _wallets3();
        uint16[] memory bps = _bps3();
        wrapper = _deploy(_assetFees(), SPLIT, wallets, bps);

        (, uint16 secondBps) = wrapper.integratorFeeReceivers(1);
        assertEq(secondBps, 3000);
        wrapper.integratorFeeReceivers(2); // third receiver exists
        vm.expectRevert();
        wrapper.integratorFeeReceivers(3); // no fourth: exactly three configured
    }

    function testRevert_InitRejectsEmptyReceivers() public {
        address[] memory wallets = new address[](0);
        uint16[] memory bps = new uint16[](0);
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapper.InvalidReceiverCount.selector);
        factory.deploy(_params(_assetFees(), SPLIT, wallets, bps));
    }

    function testRevert_InitRejectsBpsSumNot100() public {
        address[] memory wallets = _single(makeAddr("r"));
        uint16[] memory bps = new uint16[](1);
        bps[0] = 9999;
        vm.prank(onboarder);
        vm.expectRevert(ILiFiVaultWrapper.ReceiverBpsSumNot100.selector);
        factory.deploy(_params(_assetFees(), SPLIT, wallets, bps));
    }

    function test_SetIntegratorReceiversOnlyAdmin() public {
        wrapper = _deploy(
            _assetFees(),
            SPLIT,
            _single(makeAddr("r")),
            _full()
        );

        FeeReceiver[] memory receivers = _receivers(
            _single(makeAddr("new")),
            _full()
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                address(this)
            )
        );
        wrapper.setIntegratorFeeReceivers(receivers);

        vm.expectEmit(false, false, false, true, address(wrapper));
        emit ReceiversSet(receivers);
        vm.prank(vaultAdmin);
        wrapper.setIntegratorFeeReceivers(receivers);
        (address firstWallet, ) = wrapper.integratorFeeReceivers(0);
        assertEq(firstWallet, makeAddr("new"));
    }

    function testRevert_SetIntegratorReceiversValidation() public {
        wrapper = _deploy(
            _assetFees(),
            SPLIT,
            _single(makeAddr("r")),
            _full()
        );
        vm.startPrank(vaultAdmin);

        FeeReceiver[] memory tooMany = new FeeReceiver[](51);
        vm.expectRevert(ILiFiVaultWrapper.InvalidReceiverCount.selector);
        wrapper.setIntegratorFeeReceivers(tooMany);

        FeeReceiver[] memory zero = _receivers(_single(address(0)), _full());
        vm.expectRevert(ILiFiVaultWrapper.ZeroReceiver.selector);
        wrapper.setIntegratorFeeReceivers(zero);

        uint16[] memory badSum = new uint16[](1);
        badSum[0] = 9999;
        FeeReceiver[] memory badBps = _receivers(
            _single(makeAddr("r")),
            badSum
        );
        vm.expectRevert(ILiFiVaultWrapper.ReceiverBpsSumNot100.selector);
        wrapper.setIntegratorFeeReceivers(badBps);

        vm.stopPrank();
    }

    function test_SetIntegratorFeeReceiversAccepts50Wallets() public {
        wrapper = _deploy(
            _assetFees(),
            SPLIT,
            _single(makeAddr("r")),
            _full()
        );

        FeeReceiver[] memory fifty = new FeeReceiver[](50);
        for (uint256 i; i < 50; ++i) {
            fifty[i] = FeeReceiver({
                wallet: makeAddr(string.concat("w", vm.toString(i))),
                bps: 200 // 50 * 200 = 10_000
            });
        }

        vm.expectEmit(false, false, false, true, address(wrapper));
        emit ReceiversSet(fifty);
        vm.prank(vaultAdmin);
        wrapper.setIntegratorFeeReceivers(fifty);

        (address lastWallet, uint16 lastBps) = wrapper.integratorFeeReceivers(
            49
        );
        assertEq(lastWallet, makeAddr("w49"));
        assertEq(lastBps, 200);
        vm.expectRevert();
        wrapper.integratorFeeReceivers(50); // no 51st: exactly 50 configured
    }

    function test_SetReceiversThenDistributeUsesNewReceivers() public {
        address oldReceiver = makeAddr("oldReceiver");
        address newReceiver = makeAddr("newReceiver");
        wrapper = _deploy(_assetFees(), SPLIT, _single(oldReceiver), _full());
        _deposit(alice, DEPOSIT);

        // Fees accrued against the old receiver set but were never distributed.
        uint256 integratorPart = wrapper.integratorFeeAssets();
        assertGt(integratorPart, 0);

        // Rotate receivers before distributing: the accrued total follows the new set.
        vm.prank(vaultAdmin);
        wrapper.setIntegratorFeeReceivers(
            _receivers(_single(newReceiver), _full())
        );

        wrapper.distributeFees();

        assertEq(asset.balanceOf(newReceiver), integratorPart);
        assertEq(asset.balanceOf(oldReceiver), 0);
    }

    function test_DistributeFeesSkipsZeroShareReceiver() public {
        // Two receivers: a 1-bps wallet and a 9999-bps wallet. With a tiny fee pool the
        // 1-bps wallet's proportional share rounds down to 0 and is skipped; the last
        // wallet absorbs the whole integrator total, so nothing is stranded.
        address dust = makeAddr("dust"); // 1 bps
        address bulk = makeAddr("bulk"); // 9999 bps
        address[] memory wallets = new address[](2);
        wallets[0] = dust;
        wallets[1] = bulk;
        uint16[] memory bps = new uint16[](2);
        bps[0] = 1;
        bps[1] = 9999;
        wrapper = _deploy(_assetFees(), SPLIT, wallets, bps);

        _deposit(alice, 200_000); // tiny deposit → integrator fee pool < 10_000 wei

        uint256 integratorPart = wrapper.integratorFeeAssets();
        assertGt(integratorPart, 0);
        assertLt(integratorPart, 10_000); // ensures the 1-bps share floors to 0

        wrapper.distributeFees();

        assertEq(asset.balanceOf(dust), 0); // zero-share receiver skipped
        assertEq(asset.balanceOf(bulk), integratorPart); // last absorbs it all
    }

    /// Fee distribution — split correctness ///

    function test_DistributeFeesSplitsAssetPool() public {
        wrapper = _deploy(
            _assetFees(),
            SPLIT,
            _single(makeAddr("r")),
            _full()
        );
        _deposit(alice, DEPOSIT);

        // The split was applied at accrual; distributeFees pays out exactly the tracked parts.
        uint256 lifiPart = wrapper.lifiFeeAssets();
        uint256 integratorPart = wrapper.integratorFeeAssets();
        uint256 fee = lifiPart + integratorPart;
        assertGt(fee, 0);
        assertEq(integratorPart, (fee * SPLIT) / 10_000);

        vm.expectEmit(true, false, false, true, address(wrapper));
        emit FeePoolDistributed(address(asset), lifiPart, integratorPart);
        wrapper.distributeFees();

        assertEq(_accruedFeeAssets(), 0);
        assertEq(asset.balanceOf(lifiRecipient), lifiPart);
        assertEq(asset.balanceOf(makeAddr("r")), integratorPart);
        assertEq(
            asset.balanceOf(lifiRecipient) + asset.balanceOf(makeAddr("r")),
            fee
        );
    }

    function test_DistributeFeesSplitsSharePool() public {
        wrapper = _deploy(_mgmtFees(), SPLIT, _single(makeAddr("r")), _full());
        _deposit(alice, DEPOSIT);
        vm.warp(block.timestamp + YEAR);

        uint256 expectedShares = _pendingShares();
        assertGt(expectedShares, 0);
        uint256 integratorPart = (expectedShares * SPLIT) / 10_000;
        uint256 lifiPart = expectedShares - integratorPart;

        wrapper.distributeFees();

        assertEq(_accruedFeeShares(), 0);
        assertEq(wrapper.balanceOf(address(wrapper)), 0);
        assertEq(wrapper.balanceOf(lifiRecipient), lifiPart);
        assertEq(wrapper.balanceOf(makeAddr("r")), integratorPart);
    }

    function test_DistributeFeesFansAcrossWalletsWithRemainderToLast() public {
        address[] memory wallets = _wallets3();
        wrapper = _deploy(_assetFees(), SPLIT, wallets, _bps3());
        _deposit(alice, DEPOSIT);

        uint256 integratorPart = wrapper.integratorFeeAssets();
        assertGt(integratorPart, 0);
        uint256 w0 = (integratorPart * 5000) / 10_000;
        uint256 w1 = (integratorPart * 3000) / 10_000;
        uint256 w2 = integratorPart - w0 - w1; // last absorbs remainder

        wrapper.distributeFees();

        assertEq(asset.balanceOf(wallets[0]), w0);
        assertEq(asset.balanceOf(wallets[1]), w1);
        assertEq(asset.balanceOf(wallets[2]), w2);
        assertEq(w0 + w1 + w2, integratorPart);
    }

    /// Fee distribution — robustness ///

    function test_DistributeFeesRedirectsFailedIntegratorTransferToLifi()
        public
    {
        // Rebuild the stack on a blacklisting asset so a blocked integrator wallet reverts.
        _useBlacklistAsset();
        address blocked = makeAddr("blocked");
        wrapper = _deploy(_assetFees(), SPLIT, _single(blocked), _full());
        _deposit(alice, DEPOSIT);

        uint256 fee = _accruedFeeAssets();
        uint256 integratorPart = wrapper.integratorFeeAssets();
        BlacklistERC20(address(asset)).setBlocked(blocked, true);

        vm.expectEmit(true, true, false, true, address(wrapper));
        emit IntegratorPayoutRedirected(
            blocked,
            address(asset),
            integratorPart
        );
        wrapper.distributeFees(); // must not revert

        // Blocked wallet got nothing; its share was redirected to LI.FI on top of LI.FI's part.
        assertEq(asset.balanceOf(blocked), 0);
        assertEq(asset.balanceOf(lifiRecipient), fee);
        assertEq(_accruedFeeAssets(), 0);
    }

    function test_DistributeFeesRedirectsOnlyFailedWalletWithinFanOut()
        public
    {
        // A single blocked wallet inside a multi-wallet fan-out redirects only its own share
        // to LI.FI; the other wallets are still paid in full and distributeFees does not revert.
        _useBlacklistAsset();
        address[] memory wallets = _wallets3();
        wrapper = _deploy(_assetFees(), SPLIT, wallets, _bps3()); // 50% / 30% / 20%
        _deposit(alice, DEPOSIT);

        uint256 lifiPart = wrapper.lifiFeeAssets();
        uint256 integratorPart = wrapper.integratorFeeAssets();
        uint256 share0 = (integratorPart * 5000) / 10_000;
        uint256 share1 = (integratorPart * 3000) / 10_000;
        uint256 share2 = integratorPart - share0 - share1; // last absorbs remainder

        // Block only the middle wallet.
        BlacklistERC20(address(asset)).setBlocked(wallets[1], true);

        vm.expectEmit(true, true, false, true, address(wrapper));
        emit IntegratorPayoutRedirected(wallets[1], address(asset), share1);
        wrapper.distributeFees(); // must not revert

        assertEq(asset.balanceOf(wallets[0]), share0);
        assertEq(asset.balanceOf(wallets[1]), 0); // blocked: got nothing
        assertEq(asset.balanceOf(wallets[2]), share2);
        // LI.FI receives its booked part plus only the blocked wallet's redirected share.
        assertEq(asset.balanceOf(lifiRecipient), lifiPart + share1);
        assertEq(_accruedFeeAssets(), 0);
    }

    function test_DistributeFeesIsPermissionless() public {
        wrapper = _deploy(
            _assetFees(),
            SPLIT,
            _single(makeAddr("r")),
            _full()
        );
        _deposit(alice, DEPOSIT);

        vm.prank(makeAddr("randomCaller"));
        wrapper.distributeFees();

        assertEq(_accruedFeeAssets(), 0);
    }

    function test_DistributeFeesCrystallizesPendingManagementWithoutAnOperation()
        public
    {
        wrapper = _deploy(_mgmtFees(), SPLIT, _single(makeAddr("r")), _full());
        _deposit(alice, DEPOSIT);
        vm.warp(block.timestamp + YEAR);

        // No deposit/withdraw between the warp and the call: distributeFees itself must accrue.
        assertEq(_accruedFeeShares(), 0);
        wrapper.distributeFees();

        assertEq(_accruedFeeShares(), 0); // accrued then fully distributed
        assertGt(wrapper.balanceOf(makeAddr("r")), 0);
        assertGt(wrapper.balanceOf(lifiRecipient), 0);
    }

    function test_DistributeFeesWorksWhileDepositsPaused() public {
        wrapper = _deploy(_mgmtFees(), SPLIT, _single(makeAddr("r")), _full());
        _deposit(alice, DEPOSIT);
        vm.warp(block.timestamp + YEAR);

        // Deposits paused: deposit/mint accrual cannot run on inflows, so distributeFees itself
        // must accrue the pending management fee and still pay it out.
        vm.prank(vaultAdmin);
        wrapper.pause();

        wrapper.distributeFees();

        assertGt(wrapper.balanceOf(lifiRecipient), 0);
        assertGt(wrapper.balanceOf(makeAddr("r")), 0);
        assertEq(_accruedFeeShares(), 0);
    }

    function test_DistributeFeesNoOpWhenNothingAccrued() public {
        wrapper = _deploy(_mgmtFees(), SPLIT, _single(makeAddr("r")), _full());
        _deposit(alice, DEPOSIT);

        wrapper.distributeFees(); // same block, nothing accrued
        assertEq(asset.balanceOf(lifiRecipient), 0);
        assertEq(wrapper.balanceOf(lifiRecipient), 0);
    }

    function test_DistributeFeesReadsLifiRecipientLive() public {
        wrapper = _deploy(
            _assetFees(),
            SPLIT,
            _single(makeAddr("r")),
            _full()
        );
        _deposit(alice, DEPOSIT);

        address newRecipient = makeAddr("newLifiRecipient");
        vm.prank(owner);
        factory.setLifiFeeRecipient(newRecipient);

        wrapper.distributeFees();
        assertGt(asset.balanceOf(newRecipient), 0);
        assertEq(asset.balanceOf(lifiRecipient), 0);
    }

    function test_ZeroIntegratorSplitSendsAllToLifi() public {
        wrapper = _deploy(_assetFees(), 0, _single(makeAddr("r")), _full());
        _deposit(alice, DEPOSIT);

        // A zero split books everything to LI.FI at accrual.
        uint256 fee = wrapper.lifiFeeAssets();
        assertGt(fee, 0);
        assertEq(wrapper.integratorFeeAssets(), 0);
        wrapper.distributeFees();

        assertEq(asset.balanceOf(lifiRecipient), fee);
        assertEq(asset.balanceOf(makeAddr("r")), 0);
    }

    /// Helpers ///

    function _useBlacklistAsset() internal {
        asset = MockERC20(address(new BlacklistERC20()));
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        vm.startPrank(owner);
        factory.setUnderlyingAllowed(address(underlying), true);
        vm.stopPrank();
    }

    function _assetFees() internal pure returns (FeeConfig memory) {
        uint16[4] memory rates = [uint16(0), 0, DEP_RATE, WD_RATE];
        return FeeConfig({ rateBps: rates });
    }

    function _mgmtFees() internal pure returns (FeeConfig memory) {
        uint16[4] memory rates = [uint16(0), MGMT_RATE, 0, 0];
        return FeeConfig({ rateBps: rates });
    }

    function _deploy(
        FeeConfig memory _fees,
        uint16 _split,
        address[] memory _wallets,
        uint16[] memory _bps
    ) internal returns (LiFiVaultWrapper) {
        vm.prank(onboarder);
        return
            LiFiVaultWrapper(
                factory.deploy(_params(_fees, _split, _wallets, _bps))
            );
    }

    function _params(
        FeeConfig memory _fees,
        uint16 _split,
        address[] memory _wallets,
        uint16[] memory _bps
    ) internal view returns (DeployParams memory) {
        return
            DeployParams({
                namespace: bytes32("Coinbase"),
                vaultWrapperAdmin: vaultAdmin,
                adapter: address(adapter),
                underlying: address(underlying),
                nonce: 0,
                fees: _fees,
                integratorShareBps: [_split, _split, _split, _split],
                accessGate: address(0),
                receivers: _receivers(_wallets, _bps)
            });
    }

    /// @dev Zips parallel wallet/bps arrays into the FeeReceiver[] the wrapper takes.
    function _receivers(
        address[] memory _wallets,
        uint16[] memory _bps
    ) internal pure returns (FeeReceiver[] memory r) {
        r = new FeeReceiver[](_wallets.length);
        for (uint256 i; i < _wallets.length; ++i) {
            r[i] = FeeReceiver({ wallet: _wallets[i], bps: _bps[i] });
        }
    }

    function _single(address _a) internal pure returns (address[] memory w) {
        w = new address[](1);
        w[0] = _a;
    }

    function _full() internal pure returns (uint16[] memory b) {
        b = new uint16[](1);
        b[0] = 10_000;
    }

    function _wallets3() internal returns (address[] memory w) {
        w = new address[](3);
        w[0] = makeAddr("w0");
        w[1] = makeAddr("w1");
        w[2] = makeAddr("w2");
    }

    function _bps3() internal pure returns (uint16[] memory b) {
        b = new uint16[](3);
        b[0] = 5000;
        b[1] = 3000;
        b[2] = 2000;
    }

    /// @dev Total asset-side fees tracked, both sides of the at-accrual split.
    function _accruedFeeAssets() internal view returns (uint256) {
        return
            uint256(wrapper.lifiFeeAssets()) + wrapper.integratorFeeAssets();
    }

    /// @dev Total dilution fee-shares tracked, both sides of the at-accrual split.
    function _accruedFeeShares() internal view returns (uint256) {
        return
            uint256(wrapper.lifiFeeShares()) + wrapper.integratorFeeShares();
    }

    function _pendingShares() internal view returns (uint256) {
        uint256 supply = wrapper.totalSupply();
        uint256 assets = wrapper.totalAssets();
        uint256 elapsed = block.timestamp - wrapper.lastMgmtAccrual();
        uint256 feeAssets = LibVaultWrapperMath.managementFeeAssets(
            assets,
            MGMT_RATE,
            elapsed
        );
        return
            LibVaultWrapperMath.dilutionShares(feeAssets, supply, assets, 0);
    }

    function _deposit(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);
        wrapper.deposit(_amount, _from);
        vm.stopPrank();
    }
}
