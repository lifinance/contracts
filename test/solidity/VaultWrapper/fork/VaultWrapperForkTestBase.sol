// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { LibVaultWrapperMath } from "lifi/VaultWrapper/libraries/LibVaultWrapperMath.sol";
import { FeeType, FeeConfig, DeployParams, IntegratorReceivers } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Shared scaffolding for vault-wrapper fork scenarios: forks a live chain at a
///         pinned block, stands up the full factory stack against a REAL ERC-4626 yield
///         source (not a mock), and deploys one wrapper instance charging all four fee
///         types with a two-wallet integrator split. Yield is driven by the underlying's
///         own native accrual under `vm.warp` — the fidelity a mock underlying cannot give.
///         Concrete suites supply the chain/vault via the `_forkBlock`/`_rpcEnvVar`/
///         `_underlyingVault` hooks. Expectation helpers mirror the exact `LibVaultWrapperMath`
///         sequence `_accrueFees` crystallizes in, so per-operation fee accrual can be
///         checked against an independently recomputed value.
abstract contract VaultWrapperForkTestBase is Test {
    IERC20 internal asset;
    IERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal wrapper;
    LiFiVaultWrapperFactory internal factory;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal integrator1 = makeAddr("integrator1");
    address internal integrator2 = makeAddr("integrator2");

    // Fee rates for the standard fork scenario, all within the factory bytecode caps
    // (perf 50% / mgmt 10% / deposit 20% / withdrawal 20%).
    uint16 internal constant PERF_RATE = 1000; // 10% of gains above the high-water mark
    uint16 internal constant MGMT_RATE = 200; // 2% / year
    uint16 internal constant DEPOSIT_RATE = 50; // 0.5% on entry
    uint16 internal constant WITHDRAWAL_RATE = 50; // 0.5% on exit
    uint16 internal constant SPLIT = 8000; // integrator receives 80% of every fee type

    // First integrator wallet's cut of the integrator side; the second absorbs the rest.
    uint16 internal constant RECEIVER_1_BPS = 6000;
    uint16 internal constant RECEIVER_2_BPS = 4000;

    /// @dev Balance each actor is funded with in `setUp`; deposits draw from it and flows
    ///      are tracked via balance deltas.
    uint256 internal constant FUNDING = 100_000e6;

    function setUp() public virtual {
        vm.createSelectFork(vm.envString(_rpcEnvVar()), _forkBlock());

        underlying = IERC4626(_underlyingVault());
        asset = IERC20(underlying.asset());
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
        factory.setFeeBounds(FeeType.Performance, 0, PERF_RATE);
        factory.setFeeBounds(FeeType.Management, 0, MGMT_RATE);
        factory.setFeeBounds(FeeType.Deposit, 0, DEPOSIT_RATE);
        factory.setFeeBounds(FeeType.Withdrawal, 0, WITHDRAWAL_RATE);
        vm.stopPrank();

        vm.prank(onboarder);
        wrapper = LiFiVaultWrapper(factory.deploy(_standardDeployParams()));

        _fund(alice, FUNDING);
        _fund(bob, FUNDING);
        _fund(carol, FUNDING);
    }

    /// @dev Chain to fork, as an `ETH_NODE_URI_*` env var name.
    function _rpcEnvVar() internal pure virtual returns (string memory);

    /// @dev Pinned block for reproducibility; scenarios warp forward from here.
    function _forkBlock() internal pure virtual returns (uint256);

    /// @dev The real ERC-4626 yield source the wrapper wraps.
    function _underlyingVault() internal pure virtual returns (address);

    /// @dev All four fee types enabled, 80% integrator split, two integrator payout wallets.
    function _standardDeployParams()
        internal
        view
        returns (DeployParams memory)
    {
        uint16[4] memory rates = [
            PERF_RATE,
            MGMT_RATE,
            DEPOSIT_RATE,
            WITHDRAWAL_RATE
        ];
        bool[4] memory enabled = [true, true, true, true];

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
                receivers: _standardReceivers()
            });
    }

    /// @dev Two integrator payout wallets splitting the integrator side 60/40.
    function _standardReceivers()
        internal
        view
        returns (IntegratorReceivers memory r)
    {
        address[] memory wallets = new address[](2);
        wallets[0] = integrator1;
        wallets[1] = integrator2;
        uint16[] memory bps = new uint16[](2);
        bps[0] = RECEIVER_1_BPS;
        bps[1] = RECEIVER_2_BPS;
        r = IntegratorReceivers({ wallets: wallets, bps: bps });
    }

    /// @dev Sets an actor's asset balance and verifies the cheatcode took (native USDC is a
    ///      proxy; a silently failed `deal` would make later assertions misleading).
    function _fund(address _to, uint256 _amount) internal {
        deal(address(asset), _to, _amount);
        assertEq(
            asset.balanceOf(_to),
            _amount,
            "deal did not set asset balance"
        );
    }

    function _deposit(
        address _from,
        uint256 _assets
    ) internal returns (uint256 shares) {
        vm.startPrank(_from);
        asset.approve(address(wrapper), _assets);
        shares = wrapper.deposit(_assets, _from);
        vm.stopPrank();
    }

    function _redeem(
        address _from,
        uint256 _shares
    ) internal returns (uint256 assets) {
        vm.prank(_from);
        assets = wrapper.redeem(_shares, _from, _from);
    }

    /// @dev Warps forward and asserts the underlying's price per share strictly rose, so a
    ///      scenario cannot silently pass over a block/period where Morpho did not accrue
    ///      (which would make every performance-fee assertion vacuous).
    function _warpWithAccrual(uint256 _period) internal {
        // Probe the vault's total assets (which reflects Morpho's lazily-accrued interest to
        // `block.timestamp`) rather than a per-share price: MetaMorpho uses a large virtual-
        // share offset, so a small fixed share probe rounds to zero and hides the accrual.
        uint256 assetsBefore = underlying.totalAssets();
        vm.warp(block.timestamp + _period);
        assertGt(
            underlying.totalAssets(),
            assetsBefore,
            "underlying did not accrue over warp"
        );
    }

    /// @dev The wrapper's price per share (PPS_SCALE-scaled), on the same convention the
    ///      performance watermark is measured against.
    function _pps() internal view returns (uint256) {
        return
            LibVaultWrapperMath.pricePerShare(
                wrapper.totalSupply(),
                wrapper.totalAssets(),
                0
            );
    }

    /// @dev Total dilution shares booked to the fee counters (both split sides).
    function _accruedFeeShares() internal view returns (uint256) {
        return
            uint256(wrapper.lifiFeeShares()) + wrapper.integratorFeeShares();
    }

    /// @dev Total asset-side fees booked to the fee counters (both split sides).
    function _accruedFeeAssets() internal view returns (uint256) {
        return
            uint256(wrapper.lifiFeeAssets()) + wrapper.integratorFeeAssets();
    }

    /// @dev Management dilution the wrapper will crystallize on the next operation, given
    ///      the supply/assets it will see at that moment.
    function _expectedMgmt(
        uint256 _supply,
        uint256 _assets
    ) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - wrapper.lastMgmtAccrual();
        uint256 feeAssets = LibVaultWrapperMath.managementFeeAssets({
            _totalAssets: _assets,
            _rateBps: wrapper.feeRate(uint8(FeeType.Management)),
            _elapsed: elapsed
        });

        return
            LibVaultWrapperMath.dilutionShares({
                _feeAssets: feeAssets,
                _totalSupply: _supply,
                _totalAssets: _assets,
                _decimalsOffset: 0
            });
    }

    /// @dev Performance dilution the wrapper will crystallize on the next operation, given
    ///      the (post-management) supply and assets it will see at that moment.
    function _expectedPerf(
        uint256 _supply,
        uint256 _assets
    ) internal view returns (uint256) {
        uint256 feeAssets = LibVaultWrapperMath.performanceFeeAssets({
            _totalAssets: _assets,
            _totalSupply: _supply,
            _hwmPps: wrapper.perfHighWaterMarkPps(),
            _rateBps: wrapper.feeRate(uint8(FeeType.Performance)),
            _decimalsOffset: 0
        });

        return
            LibVaultWrapperMath.dilutionShares({
                _feeAssets: feeAssets,
                _totalSupply: _supply,
                _totalAssets: _assets,
                _decimalsOffset: 0
            });
    }

    /// @dev Total dilution the wrapper will crystallize next, mirroring `_accrueFees`'s
    ///      management-then-performance sequence (performance is charged on the
    ///      post-management supply).
    function _expectedDilution(
        uint256 _supply,
        uint256 _assets
    ) internal view returns (uint256) {
        uint256 mgmt = _expectedMgmt(_supply, _assets);

        return mgmt + _expectedPerf(_supply + mgmt, _assets);
    }
}
