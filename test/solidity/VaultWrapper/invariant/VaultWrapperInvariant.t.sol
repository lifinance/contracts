// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeType, FeeConfig, DeployParams, IntegratorReceivers } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperInvariantHandler } from "test/solidity/VaultWrapper/invariant/VaultWrapperInvariantHandler.sol";

/// @notice Stateful invariant suite for the assembled vault wrapper (EXSC-421 / S12). A handler
///         drives randomized multi-actor sequences — deposits, mints, withdrawals, redeems,
///         sweeps, fee retunes, pause toggles, and injected yield/loss/time — against one
///         wrapper charging all four fee types over an inflatable mock underlying. The math
///         library is already property-fuzzed in isolation; this suite proves the stateful
///         composition holds under arbitrary interleavings: idle assets and the wrapper's own
///         share balance always exactly back the booked fee counters, the performance
///         high-water mark never regresses (asserted in the handler), depositors can never
///         extract more than was deposited plus injected yield, and no shares are minted or
///         burned outside the tracked holder set. The suite runs `fail-on-revert = true`, so a
///         pause that ever blocked an exit — or any other unexpected revert — fails a run.
contract VaultWrapperInvariantTest is Test {
    // Governance-set bounds equal to the immutable bytecode caps, so the handler can retune
    // each fee across its whole legal range.
    uint16 internal constant PERF_CAP = 5000;
    uint16 internal constant MGMT_CAP = 1000;
    uint16 internal constant DEPOSIT_CAP = 2000;
    uint16 internal constant WITHDRAWAL_CAP = 2000;

    // Initial deploy-time rates (all within the caps above).
    uint16 internal constant PERF_RATE = 1000;
    uint16 internal constant MGMT_RATE = 200;
    uint16 internal constant DEPOSIT_RATE = 50;
    uint16 internal constant WITHDRAWAL_RATE = 50;

    uint16 internal constant SPLIT = 8000; // integrator share of every fee type
    uint16 internal constant RECEIVER_1_BPS = 6000;
    uint16 internal constant RECEIVER_2_BPS = 4000;

    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal wrapper;
    LiFiVaultWrapperFactory internal factory;
    VaultWrapperInvariantHandler internal handler;

    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal integrator1 = makeAddr("integrator1");
    address internal integrator2 = makeAddr("integrator2");

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            makeAddr("beaconOwner")
        );

        address owner = makeAddr("owner");
        address onboarder = makeAddr("onboarder");
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
        factory.setFeeBounds(FeeType.Performance, 0, PERF_CAP);
        factory.setFeeBounds(FeeType.Management, 0, MGMT_CAP);
        factory.setFeeBounds(FeeType.Deposit, 0, DEPOSIT_CAP);
        factory.setFeeBounds(FeeType.Withdrawal, 0, WITHDRAWAL_CAP);

        vm.stopPrank();

        vm.prank(onboarder);
        wrapper = LiFiVaultWrapper(factory.deploy(_deployParams()));

        handler = new VaultWrapperInvariantHandler(
            wrapper,
            asset,
            underlying,
            factory,
            vaultAdmin
        );

        targetContract(address(handler));
        targetSelector(
            FuzzSelector({ addr: address(handler), selectors: _actions() })
        );
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 32
    /// forge-config: default.invariant.fail-on-revert = true
    /// @dev The idle asset balance is exactly the deposit/withdrawal fees booked but not yet
    ///      swept: nothing enters the wrapper's own balance except routed asset fees, and a
    ///      sweep transfers out precisely the booked amounts.
    function invariant_idleAssetsMatchBookedAssetFees() public view {
        assertEq(
            asset.balanceOf(address(wrapper)),
            uint256(wrapper.lifiFeeAssets()) + wrapper.integratorFeeAssets(),
            "idle assets diverged from booked asset fees"
        );
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 32
    /// forge-config: default.invariant.fail-on-revert = true
    /// @dev The wrapper's own share balance is exactly the dilution fee-shares booked but not
    ///      yet swept: performance/management fees mint shares to the wrapper, and a sweep
    ///      transfers out precisely the booked amounts.
    function invariant_wrapperSharesMatchBookedFeeShares() public view {
        assertEq(
            wrapper.balanceOf(address(wrapper)),
            uint256(wrapper.lifiFeeShares()) + wrapper.integratorFeeShares(),
            "wrapper share balance diverged from booked fee shares"
        );
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 32
    /// forge-config: default.invariant.fail-on-revert = true
    /// @dev Depositors can never withdraw more, in aggregate, than was ever deposited plus the
    ///      yield injected into the underlying; fees and losses only ever reduce the payout.
    function invariant_depositorsNeverExtractMoreThanFunded() public view {
        assertLe(
            handler.ghostAssetsOut(),
            handler.ghostAssetsIn() + handler.ghostYield(),
            "depositors extracted more than was funded"
        );
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 32
    /// forge-config: default.invariant.fail-on-revert = true
    /// @dev No shares exist outside the known holder set (the three actors, the wrapper's own
    ///      fee-share balance, and the three sweep recipients), so total supply is fully
    ///      accounted for and none is silently minted or burned elsewhere.
    function invariant_shareSupplyFullyAccounted() public view {
        uint256 sum = wrapper.balanceOf(address(wrapper)) +
            wrapper.balanceOf(lifiRecipient) +
            wrapper.balanceOf(integrator1) +
            wrapper.balanceOf(integrator2);
        for (uint256 i; i < 3; ++i) {
            sum += wrapper.balanceOf(handler.actors(i));
        }

        assertEq(
            sum,
            wrapper.totalSupply(),
            "shares exist outside the tracked holder set"
        );
    }

    function _deployParams() private view returns (DeployParams memory) {
        uint16[4] memory rates = [
            PERF_RATE,
            MGMT_RATE,
            DEPOSIT_RATE,
            WITHDRAWAL_RATE
        ];
        bool[4] memory enabled = [true, true, true, true];

        address[] memory wallets = new address[](2);
        wallets[0] = integrator1;
        wallets[1] = integrator2;
        uint16[] memory bps = new uint16[](2);
        bps[0] = RECEIVER_1_BPS;
        bps[1] = RECEIVER_2_BPS;

        return
            DeployParams({
                namespace: bytes32("LI.FI-Earn"),
                vaultWrapperAdmin: vaultAdmin,
                adapter: address(adapter),
                underlying: address(underlying),
                nonce: 0,
                fees: FeeConfig({ rateBps: rates, enabled: enabled }),
                integratorShareBps: [SPLIT, SPLIT, SPLIT, SPLIT],
                initData: "",
                receivers: IntegratorReceivers({ wallets: wallets, bps: bps })
            });
    }

    /// @dev The handler entrypoints the fuzzer may call; the ghost/actor getters are excluded.
    function _actions() private pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](10);
        selectors[0] = VaultWrapperInvariantHandler.deposit.selector;
        selectors[1] = VaultWrapperInvariantHandler.mint.selector;
        selectors[2] = VaultWrapperInvariantHandler.withdraw.selector;
        selectors[3] = VaultWrapperInvariantHandler.redeem.selector;
        selectors[4] = VaultWrapperInvariantHandler.sweep.selector;
        selectors[5] = VaultWrapperInvariantHandler.injectYield.selector;
        selectors[6] = VaultWrapperInvariantHandler.injectLoss.selector;
        selectors[7] = VaultWrapperInvariantHandler.warp.selector;
        selectors[8] = VaultWrapperInvariantHandler.setFee.selector;
        selectors[9] = VaultWrapperInvariantHandler.togglePause.selector;
    }
}
