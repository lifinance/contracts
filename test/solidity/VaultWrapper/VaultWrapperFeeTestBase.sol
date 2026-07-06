// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeType, FeeConfig, DeployParams } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Shared scaffolding for the vault-wrapper fee-engine suites: the direct
///         beacon-proxy setup (real inflatable `MockERC4626`), the factory stack for
///         live `feeBounds`, deposit/yield/loss simulation, the crystallizing dust
///         deposit, and the split-counter sums.
abstract contract VaultWrapperFeeTestBase is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal wrapper;
    LiFiVaultWrapperFactory internal factory;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal owner = makeAddr("owner");

    uint256 internal constant DEPOSIT = 1_000e18;
    uint16 internal constant MGMT_RATE = 200; // 2% / year
    uint16 internal constant SPLIT = 8000; // integrator share used for every fee type here
    uint256 internal constant YEAR = 365 days;

    /// @dev Dust `_crystallize` deposits. 1 wei suffices while the underlying's own PPS
    ///      is 1:1; suites that inflate the underlying raise it (solmate's MockERC4626
    ///      reverts ZERO_SHARES on a forward once its PPS exceeds 1).
    uint256 internal crystallizeDust = 1;

    event FeeConfigUpdated(FeeType indexed feeType, uint16 newRateBps);

    event DilutionFeeAccrued(
        FeeType indexed feeType,
        uint256 feeShares,
        uint256 integratorShares
    );

    event AssetFeeCharged(
        FeeType indexed feeType,
        uint256 feeAssets,
        uint256 integratorAssets
    );

    /// @dev This test contract is the `factory` for the direct beacon-proxy wrappers (it
    ///      deploys and initializes them), so the wrapper reads the global circuit breaker
    ///      back from here.
    function globalPaused() external pure returns (bool) {
        return false;
    }

    function setUp() public virtual {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            address(this)
        );
    }

    function _newWrapper(
        FeeConfig memory _fees
    ) internal returns (LiFiVaultWrapper) {
        return _newWrapperWithSplits(_fees, [SPLIT, SPLIT, SPLIT, SPLIT]);
    }

    function _newWrapperWithSplits(
        FeeConfig memory _fees,
        uint16[4] memory _splits
    ) internal returns (LiFiVaultWrapper w) {
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(adapter),
                vaultAdmin,
                _splits,
                _fees,
                ""
            )
        );

        w = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );
    }

    /// @dev Stands up the full factory stack and deploys an instance with one fee type
    ///      configured, so `setFeeRate` reads live `feeBounds` (0.._maxBps for that type).
    function _stackWithFactory(
        FeeType _feeType,
        uint16 _rate,
        uint16 _maxBps
    ) internal {
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            makeAddr("pauser"),
            makeAddr("onboarder"),
            makeAddr("lifiRecipient")
        );

        vm.startPrank(owner);
        factory.setAdapterApproved(address(adapter), true);
        factory.setUnderlyingAllowed(address(underlying), true);
        factory.setFeeBounds(_feeType, 0, _maxBps);
        vm.stopPrank();

        uint16[4] memory rates;
        rates[uint8(_feeType)] = _rate;
        DeployParams memory p = DeployParams({
            namespace: bytes32("Coinbase"),
            vaultWrapperAdmin: vaultAdmin,
            adapter: address(adapter),
            underlying: address(underlying),
            nonce: 0,
            fees: FeeConfig({ rateBps: rates }),
            integratorShareBps: [
                type(uint16).max,
                type(uint16).max,
                type(uint16).max,
                type(uint16).max
            ],
            initData: ""
        });

        vm.prank(makeAddr("onboarder"));
        wrapper = LiFiVaultWrapper(factory.deploy(p));
    }

    /// @dev Total dilution fee-shares accrued, both sides of the at-accrual split.
    function _accruedFeeShares() internal view returns (uint256) {
        return
            uint256(wrapper.lifiFeeShares()) + wrapper.integratorFeeShares();
    }

    /// @dev Total asset-side fees accrued, both sides of the at-accrual split.
    function _accruedFeeAssets() internal view returns (uint256) {
        return
            uint256(wrapper.lifiFeeAssets()) + wrapper.integratorFeeAssets();
    }

    function _deposit(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);
        wrapper.deposit(_amount, _from);
        vm.stopPrank();
    }

    function _simulateYield(uint256 _amount) internal {
        asset.mint(address(underlying), _amount);
    }

    function _simulateLoss(uint256 _amount) internal {
        deal(
            address(asset),
            address(underlying),
            asset.balanceOf(address(underlying)) - _amount
        );
    }

    /// @dev Triggers `_accrueFees` via a dust deposit (solmate's
    ///      MockERC4626 reverts ZERO_SHARES on a 0 forward, so a bare zero deposit
    ///      cannot be used). The accrual runs before the deposit's own mint, so fee
    ///      bookkeeping is exact regardless of the dust; it is netted out where exact
    ///      accounting is checked.
    function _crystallize() internal {
        asset.mint(address(this), crystallizeDust);
        asset.approve(address(wrapper), crystallizeDust);
        wrapper.deposit(crystallizeDust, address(this));
    }
}
