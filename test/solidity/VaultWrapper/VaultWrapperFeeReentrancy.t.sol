// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeType, FeeConfig, DeployParams, FeeReceiver } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

interface IReenterHook {
    function onTokensReceived() external;
}

/// @notice ERC20 whose `transfer` hands control to a registered recipient mid-transfer,
///         modelling an ERC-777-style asset. Used to drive a reentrant `setFeeRate` from
///         inside a `distributeFees` payout.
contract ReenteringHookERC20 is MockERC20 {
    address public hookTarget;

    constructor() MockERC20("Hook", "HK", 18) {}

    function setHookTarget(address _target) external {
        hookTarget = _target;
    }

    function transfer(
        address _to,
        uint256 _amount
    ) public override returns (bool ok) {
        ok = super.transfer(_to, _amount);
        if (hookTarget != address(0) && _to == hookTarget) {
            IReenterHook(_to).onTokensReceived();
        }
    }
}

/// @notice The wrapper `owner` AND an integrator fee receiver. When paid its fee share it
///         reenters `setFeeRate` (permitted by `onlyOwner`, since it is the owner) to change
///         a rate mid-distribution — the reentrancy the guard must block.
contract ReenteringFeeOwner is IReenterHook {
    LiFiVaultWrapper private wrapper;
    FeeType private feeType;
    uint16 private sentinelRate;

    function configure(
        LiFiVaultWrapper _wrapper,
        FeeType _feeType,
        uint16 _sentinelRate
    ) external {
        wrapper = _wrapper;
        feeType = _feeType;
        sentinelRate = _sentinelRate;
    }

    function onTokensReceived() external override {
        wrapper.setFeeRate(feeType, sentinelRate);
    }
}

/// @notice Regression for the #2092 review finding 6: `distributeFees` rewrites the fee
///         counters after the payout transfers, so a fee booked reentrantly during a
///         transfer hook would be erased. `setFeeRate` is the only `_accrueFees` caller
///         outside the entry/exit/`distributeFees` reentrancy guard; guarding it makes the
///         post-transfer rewrite safe. This suite proves a payout hook cannot reenter it.
contract VaultWrapperFeeReentrancyTest is Test {
    ReenteringHookERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapperFactory internal factory;
    LiFiVaultWrapper internal wrapper;
    ReenteringFeeOwner internal ownerHook;

    address internal owner = makeAddr("owner");
    address internal onboarder = makeAddr("onboarder");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal alice = makeAddr("alice");

    uint256 internal constant DEPOSIT = 1_000e18;
    uint16 internal constant SPLIT = 8000; // 80% integrator / 20% LI.FI
    uint16 internal constant DEP_RATE = 100; // 1%
    uint16 internal constant WD_RATE = 100; // 1%
    uint16 internal constant SENTINEL_RATE = 200; // distinct in-bounds rate the hook tries to set

    function setUp() public {
        asset = new ReenteringHookERC20();
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        ownerHook = new ReenteringFeeOwner();

        // The implementation binds the factory allowed to call initialize; the factory is
        // the second CREATE after the implementation (beacon in between).
        address predictedFactory = vm.computeCreateAddress(
            address(this),
            vm.getNonce(address(this)) + 2
        );
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper(predictedFactory)),
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
        factory.setFeeBounds(FeeType.Deposit, 0, 2000);
        factory.setFeeBounds(FeeType.Withdrawal, 0, 2000);
        vm.stopPrank();

        // The reentering hook contract is both the vault owner and the sole integrator fee
        // receiver, so paying it its asset-side share fires the hook mid-distribution.
        uint16[4] memory rates = [uint16(0), 0, DEP_RATE, WD_RATE];
        FeeReceiver[] memory receivers = new FeeReceiver[](1);
        receivers[0] = FeeReceiver({
            wallet: address(ownerHook),
            bps: 10_000
        });

        vm.prank(onboarder);
        wrapper = LiFiVaultWrapper(
            factory.deploy(
                DeployParams({
                    namespace: bytes32("Coinbase"),
                    vaultWrapperAdmin: address(ownerHook),
                    adapter: address(adapter),
                    underlying: address(underlying),
                    nonce: 0,
                    fees: FeeConfig({ rateBps: rates }),
                    integratorShareBps: [SPLIT, SPLIT, SPLIT, SPLIT],
                    accessGate: address(0),
                    receivers: receivers
                })
            )
        );
    }

    function test_SetFeeRateCannotBeReenteredFromDistributionHook() public {
        _deposit(alice, DEPOSIT);
        asset.setHookTarget(address(ownerHook));
        ownerHook.configure(wrapper, FeeType.Withdrawal, SENTINEL_RATE);

        uint256 integratorPart = wrapper.integratorFeeAssets();
        uint256 lifiPart = wrapper.lifiFeeAssets();
        assertGt(integratorPart, 0);
        assertGt(lifiPart, 0);

        wrapper.distributeFees(); // must not revert

        // The reentrant setFeeRate reverted under the guard, so its whole transfer reverted:
        // the integrator payout failed and is retained, and the rate is unchanged. Without the
        // guard the hook would succeed — paying the wallet and flipping the rate to SENTINEL.
        assertEq(asset.balanceOf(address(ownerHook)), 0);
        assertEq(wrapper.integratorFeeAssets(), integratorPart);
        assertEq(wrapper.feeRate(uint8(FeeType.Withdrawal)), WD_RATE);

        // LI.FI's recipient has no hook, so its side pays out normally and is not held hostage.
        assertEq(asset.balanceOf(lifiRecipient), lifiPart);
        assertEq(wrapper.lifiFeeAssets(), 0);
    }

    function _deposit(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);
        wrapper.deposit(_amount, _from);
        vm.stopPrank();
    }
}
