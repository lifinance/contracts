// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeType, DeployParams } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Shared factory-stack bring-up for the vault-wrapper fork and invariant suites:
///         deploys the adapter, beacon, and factory, approves the adapter and the underlying,
///         sets all four fee bounds, and deploys one wrapper instance from the factory. The two
///         suites differ only in the underlying (real fork vault vs inflatable mock) and the
///         bound/deploy-param values, which they pass in rather than re-copying the sequence.
abstract contract VaultWrapperFactoryStackBase is Test {
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapperFactory internal factory;
    LiFiVaultWrapper internal wrapper;

    address internal lifiRecipient = makeAddr("lifiRecipient");

    /// @dev Deploys adapter+beacon+factory, approves `_underlying`, and sets the four fee bounds
    ///      to `_bounds` (performance, management, deposit, withdrawal). Leaves `adapter` and
    ///      `factory` set so the caller can build its `DeployParams` before `_deployWrapper`.
    function _bringUpFactory(
        address _underlying,
        uint16[4] memory _bounds
    ) internal {
        adapter = new ERC4626Adapter();
        // The implementation binds the factory allowed to call initialize at
        // construction; the factory is the second CREATE after the implementation
        // (beacon in between), so its address is predictable here.
        address predictedFactory = vm.computeCreateAddress(
            address(this),
            vm.getNonce(address(this)) + 2
        );
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper(predictedFactory)),
            makeAddr("beaconOwner")
        );
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            makeAddr("owner"),
            makeAddr("pauser"),
            makeAddr("onboarder"),
            lifiRecipient
        );

        vm.startPrank(makeAddr("owner"));
        factory.setAdapterApproved(address(adapter), true);
        factory.setUnderlyingAllowed(_underlying, true);
        factory.setFeeBounds(FeeType.Performance, 0, _bounds[0]);
        factory.setFeeBounds(FeeType.Management, 0, _bounds[1]);
        factory.setFeeBounds(FeeType.Deposit, 0, _bounds[2]);
        factory.setFeeBounds(FeeType.Withdrawal, 0, _bounds[3]);
        vm.stopPrank();
    }

    /// @dev Deploys one wrapper instance from `_params` as the onboarding manager; stores it in
    ///      `wrapper` and returns it.
    function _deployWrapper(
        DeployParams memory _params
    ) internal returns (LiFiVaultWrapper) {
        vm.prank(makeAddr("onboarder"));
        wrapper = LiFiVaultWrapper(factory.deploy(_params));

        return wrapper;
    }
}
