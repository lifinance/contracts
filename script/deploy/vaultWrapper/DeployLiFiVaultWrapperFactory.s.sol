// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Script, stdJson } from "forge-std/Script.sol";
import { DSTest } from "ds-test/test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ProxyAdmin } from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import { ERC1967Utils } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import { ICREATE3Factory } from "create3-factory/ICREATE3Factory.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeType, FeeBounds, FactoryInitParams, FEE_TYPE_COUNT } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @title DeployLiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Deploys and wires the vault wrapper system deterministically via the
///         shared CREATE3 factory: the dedicated 48h timelock, the vault wrapper
///         implementation, its upgradeable beacon, the vault wrapper factory (a
///         TransparentUpgradeableProxy in front of the factory logic), and the
///         ERC-4626 yield adapter. The timelock owns the factory, the beacon, and
///         the proxy's ProxyAdmin, so every factory slow-path call, every beacon
///         upgrade, and every factory-logic upgrade is gated by the 48h delay.
/// @dev Standalone forge-std Script (see [CONV:VW-DEPLOY-DIR]) — it does not extend
///      DeployScriptBase. Per-network parameters are read from the scoped
///      config/vaultWrapper.json under the `NETWORK` key; the only env vars are
///      PRIVATE_KEY, NETWORK, and DEPLOYSALT (the salt prefix). Deploy order:
///      TimelockController -> LiFiVaultWrapper(predicted factory proxy) ->
///      UpgradeableBeacon(impl, timelock) -> LiFiVaultWrapperFactory logic ->
///      ERC4626Adapter -> TransparentUpgradeableProxy(logic, admin owner=timelock,
///      initialize(...)). The adapter precedes the proxy because initialize seeds it
///      as approved and the factory rejects an adapter with no code.
///      Each contract is deployed through the CREATE3 factory under
///      its own salt, so the address depends only on (deployer, salt) and is
///      independent of constructor args and deploy order — mainnets sharing the same
///      CREATE3 factory therefore get matching system addresses, and the factory
///      PROXY address (salt "LiFiVaultWrapperFactory") can be predicted and bound into
///      the implementation before the proxy exists. The wrapper implementation binds
///      to the proxy, not the logic, so instances read live factory state through a
///      stable address across factory-logic upgrades. Deploying via the CREATE3 proxy
///      is safe here because every ownership/role is set from a constructor argument
///      or the proxy initializer, never msg.sender. Timelock roles: the LI.FI multisig is proposer AND canceller (OZ
///      grants both to each proposer); the executor role is open (address(0)); the
///      optional admin is renounced (address(0)), so the timelock is self-administered.
///      The factory's own configuration — approved adapter, underlying allowlist, fee
///      bounds, default split — is seeded in the proxy's initialize call, so the system
///      can deploy wrappers as soon as this script returns. Because the factory owner is
///      the 48h timelock, every LATER change to that configuration must be scheduled
///      through the timelock (see UpdateVaultWrapperConfig.s.sol).
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
    /// @notice Basis-point denominator (100%).
    uint256 internal constant BPS_DENOMINATOR = 10000;

    error ZeroPrivateKey();
    error ZeroCreate3Factory();
    error ZeroMultisig();
    error ZeroEmergencyPauser();
    error ZeroOnboardingManager();
    error ZeroLifiFeeRecipient();
    error BpsOutOfRange(uint256 value);
    error WiringMismatch(string field);

    struct DeployConfig {
        ICREATE3Factory create3Factory;
        address multisig;
        address emergencyPauser;
        address onboardingManager;
        address lifiFeeRecipient;
        uint16 defaultIntegratorShareBps;
        address[] allowedUnderlyings;
        FeeBounds[FEE_TYPE_COUNT] feeBounds;
    }

    /// @notice The contracts a deploy run resolved, passed to the post-deploy check.
    struct Deployed {
        LiFiVaultWrapperFactory factory;
        TimelockController timelock;
        UpgradeableBeacon beacon;
        LiFiVaultWrapper impl;
        address factoryLogic;
        address adapter;
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
        // The implementation only accepts initialize calls from the factory it is bound
        // to at construction; CREATE3 addresses depend on (deployer, salt) only, so the
        // factory's address is known before it exists.
        impl = LiFiVaultWrapper(
            _deploy(
                "LiFiVaultWrapper",
                abi.encodePacked(
                    type(LiFiVaultWrapper).creationCode,
                    abi.encode(_predict("LiFiVaultWrapperFactory"))
                )
            )
        );
        beacon = UpgradeableBeacon(
            _deployBeacon(address(impl), address(timelock))
        );
        address factoryLogic = _deploy(
            "LiFiVaultWrapperFactoryImpl",
            type(LiFiVaultWrapperFactory).creationCode
        );
        // The adapter is deployed BEFORE the factory proxy: the proxy runs
        // initialize in its constructor and seeds the adapter approval there, and
        // the factory rejects an adapter with no code.
        erc4626Adapter = ERC4626Adapter(
            _deploy("ERC4626Adapter", type(ERC4626Adapter).creationCode)
        );
        factory = LiFiVaultWrapperFactory(
            _deployFactoryProxy(
                _cfg,
                factoryLogic,
                address(beacon),
                address(timelock),
                address(erc4626Adapter)
            )
        );

        vm.stopBroadcast();

        _verifyWiring(
            _cfg,
            Deployed({
                factory: factory,
                timelock: timelock,
                beacon: beacon,
                impl: impl,
                factoryLogic: factoryLogic,
                adapter: address(erc4626Adapter)
            })
        );

        emit log_named_address("Timelock", address(timelock));
        emit log_named_address("Implementation", address(impl));
        emit log_named_address("Beacon", address(beacon));
        emit log_named_address("FactoryLogic", factoryLogic);
        emit log_named_address("Factory", address(factory));
        emit log_named_address("ProxyAdmin", _proxyAdmin(address(factory)));
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
        // Split must leave LI.FI a non-zero share (factory enforces < 100%).
        cfg.defaultIntegratorShareBps = _checkBps(
            json.readUint(
                string.concat(".", network, ".defaultIntegratorShareBps")
            ),
            BPS_DENOMINATOR - 1
        );
        cfg.allowedUnderlyings = json.readAddressArray(
            string.concat(".", network, ".allowedUnderlyings")
        );

        string[FEE_TYPE_COUNT] memory names = [
            "performance",
            "management",
            "deposit",
            "withdrawal"
        ];
        // Per-fee-type bps caps mirrored from LiFiVaultWrapperFactory's constants,
        // which it exposes no getter for. Narrowing an unchecked JSON value to uint16
        // would wrap a fat-fingered bound into a plausible one; checking against the
        // cap here fails on the real value instead.
        uint16[FEE_TYPE_COUNT] memory caps = [uint16(5000), 1000, 2000, 2000];
        for (uint256 i; i < FEE_TYPE_COUNT; ++i) {
            string memory base = string.concat(
                ".",
                network,
                ".feeBounds.",
                names[i]
            );
            cfg.feeBounds[i] = FeeBounds(
                _checkBps(
                    json.readUint(string.concat(base, ".minBps")),
                    caps[i]
                ),
                _checkBps(
                    json.readUint(string.concat(base, ".maxBps")),
                    caps[i]
                )
            );
        }
    }

    /// @notice Narrows a JSON bps value to uint16, reverting if it exceeds `_max`.
    /// @param _value The raw value read from config.
    /// @param _max The highest value accepted for this field.
    /// @return The value as uint16.
    function _checkBps(
        uint256 _value,
        uint256 _max
    ) internal pure returns (uint16) {
        if (_value > _max) revert BpsOutOfRange(_value);

        return uint16(_value);
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
    /// @param _d The contracts this run resolved.
    function _verifyWiring(
        DeployConfig memory _cfg,
        Deployed memory _d
    ) internal view {
        if (_d.timelock.getMinDelay() != MIN_DELAY)
            revert WiringMismatch("timelock.minDelay");
        if (!_d.timelock.hasRole(_d.timelock.PROPOSER_ROLE(), _cfg.multisig))
            revert WiringMismatch("timelock.proposer");
        if (!_d.timelock.hasRole(_d.timelock.CANCELLER_ROLE(), _cfg.multisig))
            revert WiringMismatch("timelock.canceller");

        if (_d.beacon.owner() != address(_d.timelock))
            revert WiringMismatch("beacon.owner");
        if (_d.beacon.implementation() != address(_d.impl))
            revert WiringMismatch("beacon.implementation");
        if (_d.impl.FACTORY() != address(_d.factory))
            revert WiringMismatch("impl.expectedFactory");

        address admin = _proxyAdmin(address(_d.factory));
        if (admin.code.length == 0)
            revert WiringMismatch("factory.proxyAdmin");
        if (ProxyAdmin(admin).owner() != address(_d.timelock))
            revert WiringMismatch("factory.proxyAdmin.owner");

        if (_d.factory.owner() != address(_d.timelock))
            revert WiringMismatch("factory.owner");
        if (_d.factory.beacon() != address(_d.beacon))
            revert WiringMismatch("factory.beacon");
        if (_d.factory.emergencyPauser() != _cfg.emergencyPauser)
            revert WiringMismatch("factory.emergencyPauser");
        if (_d.factory.onboardingManager() != _cfg.onboardingManager)
            revert WiringMismatch("factory.onboardingManager");
        if (_d.factory.lifiFeeRecipient() != _cfg.lifiFeeRecipient)
            revert WiringMismatch("factory.lifiFeeRecipient");

        _verifySeededConfig(_cfg, _d);

        // The proxy must delegate to exactly the logic deployed this run. CREATE3
        // salts exclude creation code, so a re-run that reuses the proxy salt keeps
        // the live implementation slot pointing at the old logic while the earlier
        // through-proxy checks still pass — this catches that stale linkage.
        address liveImpl = address(
            uint160(
                uint256(
                    vm.load(
                        address(_d.factory),
                        ERC1967Utils.IMPLEMENTATION_SLOT
                    )
                )
            )
        );
        if (liveImpl != _d.factoryLogic)
            revert WiringMismatch("factory.implementation");
    }

    /// @notice Asserts the factory carries the configuration seeded at initialize.
    /// @dev Split out of `_verifyWiring` to keep each within the complexity limit.
    ///      A stale proxy resolved under a reused salt still answers the governance
    ///      checks while carrying the previous run's config, so these are compared
    ///      against `_cfg` for the same reason the role wiring is.
    /// @param _cfg The intended deploy config.
    /// @param _d The contracts this run resolved.
    function _verifySeededConfig(
        DeployConfig memory _cfg,
        Deployed memory _d
    ) internal view {
        if (!_d.factory.approvedAdapter(_d.adapter))
            revert WiringMismatch("factory.approvedAdapter");
        if (
            _d.factory.defaultIntegratorShareBps() !=
            _cfg.defaultIntegratorShareBps
        ) revert WiringMismatch("factory.defaultIntegratorShareBps");

        for (uint256 i; i < _cfg.allowedUnderlyings.length; ++i) {
            if (!_d.factory.allowedUnderlying(_cfg.allowedUnderlyings[i]))
                revert WiringMismatch("factory.allowedUnderlying");
        }

        for (uint256 i; i < FEE_TYPE_COUNT; ++i) {
            (uint16 minBps, uint16 maxBps) = _d.factory.feeBounds(FeeType(i));
            if (
                minBps != _cfg.feeBounds[i].minBps ||
                maxBps != _cfg.feeBounds[i].maxBps
            ) revert WiringMismatch("factory.feeBounds");
        }
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

    /// @notice Deploys the factory's TransparentUpgradeableProxy, initialized in the
    ///         same call. The proxy is the stable "factory" address every wrapper reads
    ///         from; its ProxyAdmin (auto-deployed by the proxy) and the factory owner
    ///         are both the timelock.
    /// @param _cfg The validated deploy config (roles + fee recipient).
    /// @param _logic The factory logic contract the proxy delegates to.
    /// @param _beacon The beacon the factory clones instances from.
    /// @param _timelock The factory owner and the ProxyAdmin owner (subsystem governance).
    /// @param _adapter The yield adapter seeded as approved (must already be deployed).
    /// @return The deployed factory proxy address.
    function _deployFactoryProxy(
        DeployConfig memory _cfg,
        address _logic,
        address _beacon,
        address _timelock,
        address _adapter
    ) internal returns (address) {
        bytes memory initData = abi.encodeCall(
            LiFiVaultWrapperFactory.initialize,
            (
                FactoryInitParams({
                    beacon: _beacon,
                    owner: _timelock,
                    emergencyPauser: _cfg.emergencyPauser,
                    onboardingManager: _cfg.onboardingManager,
                    lifiFeeRecipient: _cfg.lifiFeeRecipient,
                    adapter: _adapter,
                    allowedUnderlyings: _cfg.allowedUnderlyings,
                    feeBounds: _cfg.feeBounds,
                    defaultIntegratorShareBps: _cfg.defaultIntegratorShareBps
                })
            )
        );

        return
            _deploy(
                "LiFiVaultWrapperFactory",
                abi.encodePacked(
                    type(TransparentUpgradeableProxy).creationCode,
                    abi.encode(_logic, _timelock, initData)
                )
            );
    }

    /// @notice Reads the ProxyAdmin address from a TransparentUpgradeableProxy's
    ///         ERC-1967 admin slot.
    /// @param _proxy The proxy to inspect.
    /// @return The proxy's ProxyAdmin address.
    function _proxyAdmin(address _proxy) internal view returns (address) {
        return
            address(
                uint160(uint256(vm.load(_proxy, ERC1967Utils.ADMIN_SLOT)))
            );
    }

    /// @notice The deterministic CREATE3 address `_name` will deploy to under the
    ///         current salt prefix and deployer.
    /// @param _name The contract name, appended to DEPLOYSALT to form the salt.
    /// @return The predicted contract address.
    function _predict(string memory _name) internal view returns (address) {
        return
            create3.getDeployed(
                deployer,
                keccak256(abi.encodePacked(saltPrefix, _name))
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
        address predicted = _predict(_name);
        bytes32 salt = keccak256(abi.encodePacked(saltPrefix, _name));

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
