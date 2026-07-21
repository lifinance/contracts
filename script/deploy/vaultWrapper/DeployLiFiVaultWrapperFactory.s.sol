// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script, stdJson } from "forge-std/Script.sol";
import { DSTest } from "ds-test/test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { ICREATE3Factory } from "create3-factory/ICREATE3Factory.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";

/// @title DeployLiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Deploys and wires the vault wrapper system deterministically via the
///         shared CREATE3 factory: the dedicated 48h timelock, the vault wrapper
///         implementation, its upgradeable beacon, the vault wrapper factory, and
///         the ERC-4626 yield adapter. The timelock owns both the factory and the
///         beacon, so every factory slow-path call and every beacon upgrade is
///         gated by the 48h delay.
/// @dev Standalone forge-std Script (see [CONV:VW-DEPLOY-DIR]) — it does not extend
///      DeployScriptBase. Per-network parameters are read from the scoped
///      config/vaultWrapper.json under the `NETWORK` key; the only env vars are
///      PRIVATE_KEY, NETWORK, and DEPLOYSALT (the salt prefix). Deploy order:
///      TimelockController -> LiFiVaultWrapper -> UpgradeableBeacon(impl, timelock) ->
///      LiFiVaultWrapperFactory(beacon, owner=timelock, ...) -> ERC4626Adapter. Each
///      contract is deployed through the CREATE3 factory under its own salt, so the
///      address depends only on (deployer, salt) and is independent of constructor
///      args and deploy order — mainnets sharing the same CREATE3 factory therefore
///      get matching system addresses. Deploying via the CREATE3 proxy is safe here
///      because every ownership/role is set from a constructor argument, never
///      msg.sender. Timelock roles: the LI.FI multisig is proposer AND canceller (OZ
///      grants both to each proposer); the executor role is open (address(0)); the
///      optional admin is renounced (address(0)), so the timelock is self-administered.
///      Because the factory owner is the 48h timelock, post-deploy configuration —
///      setAdapterApproved / setUnderlyingAllowed / setFeeBounds / setDefaultSplit,
///      required before any wrapper can be deployed — must be scheduled through the
///      timelock (see UpdateVaultWrapperConfig.s.sol).
///
///      Dry-run (no broadcast):
///        NETWORK=mainnet DEPLOYSALT=... PRIVATE_KEY=... \
///        forge script script/deploy/vaultWrapper/DeployLiFiVaultWrapperFactory.s.sol
///      Broadcast + verify: append `--broadcast --verify`.
/// @custom:version 1.0.0
contract DeployLiFiVaultWrapperFactory is Script, DSTest {
    using stdJson for string;

    /// @notice The dedicated governance delay for the vault wrapper subsystem.
    uint256 internal constant MIN_DELAY = 48 hours;

    error ZeroPrivateKey();
    error ZeroCreate3Factory();
    error ZeroMultisig();
    error ZeroEmergencyPauser();
    error ZeroOnboardingManager();
    error ZeroLifiFeeRecipient();
    error WiringMismatch(string field);

    struct DeployConfig {
        ICREATE3Factory create3Factory;
        address multisig;
        address emergencyPauser;
        address onboardingManager;
        address lifiFeeRecipient;
    }

    ICREATE3Factory internal create3;
    address internal deployer;
    string internal saltPrefix;

    /// @notice Deploys and wires the full vault wrapper system from config/vaultWrapper.json.
    /// @return factory The deployed vault wrapper factory.
    /// @return timelock The dedicated 48h timelock owning the factory and beacon.
    /// @return beacon The upgradeable beacon holding the wrapper implementation.
    /// @return impl The vault wrapper implementation behind the beacon.
    /// @return erc4626Adapter The ERC-4626 yield adapter.
    function run()
        public
        returns (
            LiFiVaultWrapperFactory factory,
            TimelockController timelock,
            UpgradeableBeacon beacon,
            LiFiVaultWrapper impl,
            ERC4626Adapter erc4626Adapter
        )
    {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        if (deployerPrivateKey == 0) revert ZeroPrivateKey();

        return
            deploySystem(
                _readConfig(),
                deployerPrivateKey,
                vm.envString("DEPLOYSALT")
            );
    }

    /// @notice Deploys and wires the system from an in-memory config. Shared by
    ///         `run()` (env/config path) and tests (direct-call path).
    /// @param _cfg The deploy config (CREATE3 factory, multisig, roles, fee recipient).
    /// @param _deployerPrivateKey The broadcasting deployer key.
    /// @param _saltPrefix The shared CREATE3 salt prefix (DEPLOYSALT).
    /// @return factory The deployed vault wrapper factory.
    /// @return timelock The dedicated 48h timelock owning the factory and beacon.
    /// @return beacon The upgradeable beacon holding the wrapper implementation.
    /// @return impl The vault wrapper implementation behind the beacon.
    /// @return erc4626Adapter The ERC-4626 yield adapter.
    function deploySystem(
        DeployConfig memory _cfg,
        uint256 _deployerPrivateKey,
        string memory _saltPrefix
    )
        public
        returns (
            LiFiVaultWrapperFactory factory,
            TimelockController timelock,
            UpgradeableBeacon beacon,
            LiFiVaultWrapper impl,
            ERC4626Adapter erc4626Adapter
        )
    {
        _validate(_cfg);
        deployer = vm.addr(_deployerPrivateKey);
        saltPrefix = _saltPrefix;
        create3 = _cfg.create3Factory;

        vm.startBroadcast(_deployerPrivateKey);

        timelock = TimelockController(payable(_deployTimelock(_cfg.multisig)));
        impl = LiFiVaultWrapper(
            _deploy("LiFiVaultWrapper", type(LiFiVaultWrapper).creationCode)
        );
        beacon = UpgradeableBeacon(
            _deployBeacon(address(impl), address(timelock))
        );
        factory = LiFiVaultWrapperFactory(
            _deployFactory(_cfg, address(beacon), address(timelock))
        );
        erc4626Adapter = ERC4626Adapter(
            _deploy("ERC4626Adapter", type(ERC4626Adapter).creationCode)
        );

        vm.stopBroadcast();

        _verifyWiring(_cfg, factory, timelock, beacon, impl);

        emit log_named_address("Timelock", address(timelock));
        emit log_named_address("Implementation", address(impl));
        emit log_named_address("Beacon", address(beacon));
        emit log_named_address("Factory", address(factory));
        emit log_named_address("ERC4626Adapter", address(erc4626Adapter));
    }

    /// @notice Reads the target network's config from config/vaultWrapper.json.
    /// @return cfg The deploy config for `NETWORK` (validated in `deploySystem`).
    function _readConfig() internal view returns (DeployConfig memory cfg) {
        string memory network = vm.envString("NETWORK");
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/vaultWrapper.json"
        );
        string memory json = vm.readFile(path);

        cfg.create3Factory = ICREATE3Factory(
            json.readAddress(string.concat(".", network, ".create3Factory"))
        );
        cfg.multisig = json.readAddress(
            string.concat(".", network, ".multisig")
        );
        cfg.emergencyPauser = json.readAddress(
            string.concat(".", network, ".emergencyPauser")
        );
        cfg.onboardingManager = json.readAddress(
            string.concat(".", network, ".onboardingManager")
        );
        cfg.lifiFeeRecipient = json.readAddress(
            string.concat(".", network, ".lifiFeeRecipient")
        );
    }

    /// @notice Reverts if any required config address is the zero address.
    /// @param _cfg The deploy config to validate.
    function _validate(DeployConfig memory _cfg) internal pure {
        if (address(_cfg.create3Factory) == address(0))
            revert ZeroCreate3Factory();
        if (_cfg.multisig == address(0)) revert ZeroMultisig();
        if (_cfg.emergencyPauser == address(0)) revert ZeroEmergencyPauser();
        if (_cfg.onboardingManager == address(0))
            revert ZeroOnboardingManager();
        if (_cfg.lifiFeeRecipient == address(0)) revert ZeroLifiFeeRecipient();
    }

    /// @notice Asserts every deployed contract carries the intended governance wiring.
    /// @dev CREATE3 salts exclude constructor args, so re-running with the same
    ///      DEPLOYSALT after correcting a role/config value resolves the STALE
    ///      contract (via `_deploy`'s idempotency skip) instead of applying the new
    ///      value. This post-deploy check compares the live wiring against `_cfg`
    ///      and reverts `WiringMismatch` if a stale deployment carries the old roles,
    ///      turning a silent governance error into a loud failure that tells the
    ///      operator to deploy under a fresh DEPLOYSALT.
    /// @param _cfg The intended deploy config.
    /// @param _factory The resolved factory.
    /// @param _timelock The resolved timelock.
    /// @param _beacon The resolved beacon.
    /// @param _impl The resolved implementation.
    function _verifyWiring(
        DeployConfig memory _cfg,
        LiFiVaultWrapperFactory _factory,
        TimelockController _timelock,
        UpgradeableBeacon _beacon,
        LiFiVaultWrapper _impl
    ) internal view {
        if (_timelock.getMinDelay() != MIN_DELAY)
            revert WiringMismatch("timelock.minDelay");
        if (!_timelock.hasRole(_timelock.PROPOSER_ROLE(), _cfg.multisig))
            revert WiringMismatch("timelock.proposer");
        if (!_timelock.hasRole(_timelock.CANCELLER_ROLE(), _cfg.multisig))
            revert WiringMismatch("timelock.canceller");

        if (_beacon.owner() != address(_timelock))
            revert WiringMismatch("beacon.owner");
        if (_beacon.implementation() != address(_impl))
            revert WiringMismatch("beacon.implementation");

        if (_factory.owner() != address(_timelock))
            revert WiringMismatch("factory.owner");
        if (_factory.BEACON() != address(_beacon))
            revert WiringMismatch("factory.beacon");
        if (_factory.emergencyPauser() != _cfg.emergencyPauser)
            revert WiringMismatch("factory.emergencyPauser");
        if (_factory.onboardingManager() != _cfg.onboardingManager)
            revert WiringMismatch("factory.onboardingManager");
        if (_factory.lifiFeeRecipient() != _cfg.lifiFeeRecipient)
            revert WiringMismatch("factory.lifiFeeRecipient");
    }

    /// @notice Deploys the dedicated 48h timelock (proposer/canceller = multisig,
    ///         open executor, self-administered).
    /// @param _multisig The LI.FI multisig granted proposer and canceller roles.
    /// @return The deployed timelock address.
    function _deployTimelock(address _multisig) internal returns (address) {
        address[] memory proposers = new address[](1);
        proposers[0] = _multisig;
        address[] memory executors = new address[](1);
        executors[0] = address(0);

        return
            _deploy(
                "LiFiVaultWrapperTimelock",
                abi.encodePacked(
                    type(TimelockController).creationCode,
                    abi.encode(MIN_DELAY, proposers, executors, address(0))
                )
            );
    }

    /// @notice Deploys the upgradeable beacon owned by the timelock.
    /// @param _impl The wrapper implementation the beacon points at.
    /// @param _timelock The beacon owner (subsystem governance).
    /// @return The deployed beacon address.
    function _deployBeacon(
        address _impl,
        address _timelock
    ) internal returns (address) {
        return
            _deploy(
                "LiFiVaultWrapperBeacon",
                abi.encodePacked(
                    type(UpgradeableBeacon).creationCode,
                    abi.encode(_impl, _timelock)
                )
            );
    }

    /// @notice Deploys the vault wrapper factory owned by the timelock.
    /// @param _cfg The validated deploy config (roles + fee recipient).
    /// @param _beacon The beacon the factory clones instances from.
    /// @param _timelock The factory owner (subsystem governance).
    /// @return The deployed factory address.
    function _deployFactory(
        DeployConfig memory _cfg,
        address _beacon,
        address _timelock
    ) internal returns (address) {
        return
            _deploy(
                "LiFiVaultWrapperFactory",
                abi.encodePacked(
                    type(LiFiVaultWrapperFactory).creationCode,
                    abi.encode(
                        _beacon,
                        _timelock,
                        _cfg.emergencyPauser,
                        _cfg.onboardingManager,
                        _cfg.lifiFeeRecipient
                    )
                )
            );
    }

    /// @notice Deploys `creationCode` through the CREATE3 factory under a per-contract
    ///         salt, skipping deployment if the deterministic address already has code.
    /// @param _name The contract name, appended to DEPLOYSALT to form the salt.
    /// @param _creationCode The full init code (creation bytecode + abi-encoded constructor args).
    /// @return deployed The deterministic contract address.
    function _deploy(
        string memory _name,
        bytes memory _creationCode
    ) internal returns (address deployed) {
        bytes32 salt = keccak256(abi.encodePacked(saltPrefix, _name));
        address predicted = create3.getDeployed(deployer, salt);

        if (predicted.code.length != 0) {
            emit log_named_address(
                string.concat(_name, " already deployed"),
                predicted
            );
            return predicted;
        }

        deployed = create3.deploy(salt, _creationCode);
    }
}
