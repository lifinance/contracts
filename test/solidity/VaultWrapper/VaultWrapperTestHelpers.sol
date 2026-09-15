// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Vm } from "forge-std/Vm.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ERC1967Utils } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import { FeeReceiver } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";

/// @notice Minimal valid integrator receiver set: a single wallet holding 100% of the
///         fan-out. Shared by the VaultWrapper test suites that don't exercise distribution,
///         so the construction isn't re-implemented per file.
/// @return r The single-wallet receiver set (wallet `0xFEE1`, 10_000 bps).
function defaultReceivers() pure returns (FeeReceiver[] memory r) {
    r = new FeeReceiver[](1);
    r[0] = FeeReceiver({ wallet: address(0xFEE1), bps: 10_000 });
}

/// @notice Brings up the full factory topology for tests the way the production deploy
///         script does: a wrapper implementation bound to the factory PROXY address, a
///         beacon over it, and the factory logic behind a TransparentUpgradeableProxy
///         initialized in the same call. Centralizes the CREATE-nonce prediction of the
///         proxy so individual suites don't re-derive it.
library VaultWrapperFactoryDeployer {
    // Lowercase `vm` is the forge-std cheatcode idiom; keep it so call sites read
    // like the rest of the suite.
    // solhint-disable-next-line const-name-snakecase
    Vm private constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Deploys logic + impl + beacon + proxy, wiring the wrapper impl to the proxy.
    /// @dev Internal library functions are inlined, so every `new` and nonce read resolves
    ///      against the calling test contract. Order after the logic CREATE: impl (nonce n),
    ///      beacon (n+1), proxy (n+2); the impl is bound to the predicted proxy at n+2. The
    ///      ProxyAdmin the proxy spawns is a CREATE from the proxy, not the caller, so it
    ///      does not shift the caller nonce.
    /// @param _beaconOwner The beacon owner (governs beacon upgrades).
    /// @param _factoryOwner The factory Ownable2Step owner and the ProxyAdmin owner.
    /// @param _emergencyPauser The factory emergency pauser role.
    /// @param _onboardingManager The factory onboarding manager role.
    /// @param _lifiFeeRecipient The LI.FI fee recipient.
    /// @return beacon The deployed beacon.
    /// @return factory The factory, typed at its proxy address.
    function deploy(
        address _beaconOwner,
        address _factoryOwner,
        address _emergencyPauser,
        address _onboardingManager,
        address _lifiFeeRecipient
    )
        internal
        returns (UpgradeableBeacon beacon, LiFiVaultWrapperFactory factory)
    {
        LiFiVaultWrapperFactory logic = new LiFiVaultWrapperFactory();

        address predictedProxy = vm.computeCreateAddress(
            address(this),
            vm.getNonce(address(this)) + 2
        );
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper(predictedProxy)),
            _beaconOwner
        );

        bytes memory initData = abi.encodeCall(
            LiFiVaultWrapperFactory.initialize,
            (
                address(beacon),
                _factoryOwner,
                _emergencyPauser,
                _onboardingManager,
                _lifiFeeRecipient
            )
        );
        factory = LiFiVaultWrapperFactory(
            address(
                new TransparentUpgradeableProxy(
                    address(logic),
                    _factoryOwner,
                    initData
                )
            )
        );
    }

    /// @notice The ProxyAdmin address behind a TransparentUpgradeableProxy.
    /// @param _proxy The proxy to inspect.
    /// @return The proxy's ProxyAdmin (reads the ERC-1967 admin slot).
    function proxyAdmin(address _proxy) internal view returns (address) {
        return
            address(
                uint160(uint256(vm.load(_proxy, ERC1967Utils.ADMIN_SLOT)))
            );
    }
}
