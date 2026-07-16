// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script, stdJson } from "forge-std/Script.sol";
import { DSTest } from "ds-test/test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { FeeType, FEE_TYPE_COUNT } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @title UpdateVaultWrapperConfig
/// @author LI.FI (https://li.fi)
/// @notice Builds the 48h-timelock batch that seeds / reconciles the vault wrapper
///         factory configuration from config/vaultWrapper.json: adapter approval,
///         underlying allowlist, per-fee-type bounds, and the default integrator
///         split. Because the factory owner is the timelock, none of these setters
///         can be called directly — the batch must be scheduled by the LI.FI
///         multisig (the timelock proposer), and executed after the 48h delay. The
///         first run is a hard prerequisite: no wrapper can be deployed until at
///         least one adapter is approved and one underlying is allowed.
/// @dev Standalone forge-std Script (see [CONV:VW-DEPLOY-DIR]). This script does NOT
///      broadcast — the deployer is not a timelock proposer. It reads the live
///      factory state and emits the exact `scheduleBatch` and `executeBatch`
///      calldata (target = the timelock) for the multisig to submit via the Safe.
///      It is idempotent: an operation is included only when the desired value
///      differs from the current on-chain value, so a re-run after a partial apply
///      produces a smaller batch (or an empty one).
///
///      Env: NETWORK, FACTORY (deployed factory), TIMELOCK (its owner), ADAPTER
///      (the ERC-4626 adapter to approve). Optional CONFIG_SALT (timelock op salt;
///      default keccak256("LiFiVaultWrapperConfig")).
///
///      Note: setApprovedIntegratorDeployer is onboarding-manager-gated (not the
///      timelock) and is handled separately, not by this batch.
/// @custom:version 1.0.0
contract UpdateVaultWrapperConfig is Script, DSTest {
    using stdJson for string;

    error ZeroFactory();
    error ZeroTimelock();
    error ZeroAdapter();

    struct Desired {
        uint16 defaultIntegratorShareBps;
        uint16[FEE_TYPE_COUNT] feeMinBps;
        uint16[FEE_TYPE_COUNT] feeMaxBps;
        address[] allowedUnderlyings;
    }

    struct Batch {
        address[] targets;
        uint256[] values;
        bytes[] payloads;
        bytes32 predecessor;
        bytes32 salt;
        uint256 delay;
    }

    LiFiVaultWrapperFactory internal factory;
    string internal json;
    string internal network;

    /// @notice Reads config + live state and emits the timelock config batch calldata.
    /// @return batch The scheduled operations and timelock parameters.
    function run() public returns (Batch memory batch) {
        address factoryAddress = vm.envAddress("FACTORY");
        address timelock = vm.envAddress("TIMELOCK");
        address adapter = vm.envAddress("ADAPTER");
        if (factoryAddress == address(0)) revert ZeroFactory();
        if (timelock == address(0)) revert ZeroTimelock();
        if (adapter == address(0)) revert ZeroAdapter();

        factory = LiFiVaultWrapperFactory(factoryAddress);
        network = vm.envString("NETWORK");
        json = vm.readFile(
            string.concat(vm.projectRoot(), "/config/vaultWrapper.json")
        );

        batch = buildBatch(factory, adapter, _readDesired());

        _logBatch(timelock, batch);
    }

    /// @notice Builds the timelock batch by diffing desired config against live state.
    ///         Public so tests can drive it with an in-memory Desired.
    /// @param _factory The deployed vault wrapper factory whose state is diffed.
    /// @param _adapter The ERC-4626 adapter to approve.
    /// @param _d The desired split, per-fee-type bounds, and allowlist.
    /// @return batch The operations (target = factory) plus timelock parameters.
    function buildBatch(
        LiFiVaultWrapperFactory _factory,
        address _adapter,
        Desired memory _d
    ) public view returns (Batch memory batch) {
        uint256 maxOps = 2 + FEE_TYPE_COUNT + _d.allowedUnderlyings.length;
        address[] memory targets = new address[](maxOps);
        bytes[] memory payloads = new bytes[](maxOps);
        uint256 n;

        if (!_factory.approvedAdapter(_adapter)) {
            payloads[n] = abi.encodeCall(
                _factory.setAdapterApproved,
                (_adapter, true)
            );
            targets[n++] = address(_factory);
        }

        for (uint256 i; i < _d.allowedUnderlyings.length; ++i) {
            if (_factory.allowedUnderlying(_d.allowedUnderlyings[i])) continue;
            payloads[n] = abi.encodeCall(
                _factory.setUnderlyingAllowed,
                (_d.allowedUnderlyings[i], true)
            );
            targets[n++] = address(_factory);
        }

        for (uint256 i; i < FEE_TYPE_COUNT; ++i) {
            (uint16 curMin, uint16 curMax) = _factory.feeBounds(FeeType(i));
            if (curMin == _d.feeMinBps[i] && curMax == _d.feeMaxBps[i])
                continue;
            payloads[n] = abi.encodeCall(
                _factory.setFeeBounds,
                (FeeType(i), _d.feeMinBps[i], _d.feeMaxBps[i])
            );
            targets[n++] = address(_factory);
        }

        if (
            _factory.defaultIntegratorShareBps() !=
            _d.defaultIntegratorShareBps
        ) {
            payloads[n] = abi.encodeCall(
                _factory.setDefaultSplit,
                (_d.defaultIntegratorShareBps)
            );
            targets[n++] = address(_factory);
        }

        batch.targets = _trim(targets, n);
        batch.payloads = _trimBytes(payloads, n);
        batch.values = new uint256[](n);
        batch.predecessor = bytes32(0);
        batch.salt = vm.envOr(
            "CONFIG_SALT",
            keccak256("LiFiVaultWrapperConfig")
        );
        batch.delay = _factory.owner() == address(0)
            ? 0
            : TimelockController(payable(_factory.owner())).getMinDelay();
    }

    /// @notice Reads the desired config for `NETWORK` from config/vaultWrapper.json.
    /// @return d The desired split, per-fee-type bounds, and allowlist.
    function _readDesired() internal view returns (Desired memory d) {
        d.defaultIntegratorShareBps = uint16(
            json.readUint(
                string.concat(".", network, ".defaultIntegratorShareBps")
            )
        );
        d.allowedUnderlyings = json.readAddressArray(
            string.concat(".", network, ".allowedUnderlyings")
        );

        string[FEE_TYPE_COUNT] memory names = [
            "performance",
            "management",
            "deposit",
            "withdrawal"
        ];
        for (uint256 i; i < FEE_TYPE_COUNT; ++i) {
            string memory base = string.concat(
                ".",
                network,
                ".feeBounds.",
                names[i]
            );
            d.feeMinBps[i] = uint16(
                json.readUint(string.concat(base, ".minBps"))
            );
            d.feeMaxBps[i] = uint16(
                json.readUint(string.concat(base, ".maxBps"))
            );
        }
    }

    /// @notice Logs the batch and the timelock scheduleBatch/executeBatch calldata.
    /// @param _timelock The timelock the batch targets.
    /// @param _batch The built batch.
    function _logBatch(address _timelock, Batch memory _batch) internal {
        if (_batch.targets.length == 0) {
            emit log("Vault wrapper config already in sync - empty batch");
            return;
        }

        emit log_named_address("Timelock", _timelock);
        emit log_named_uint("Operations", _batch.targets.length);
        emit log_named_uint("Delay (s)", _batch.delay);

        bytes memory scheduleCalldata = abi.encodeCall(
            TimelockController.scheduleBatch,
            (
                _batch.targets,
                _batch.values,
                _batch.payloads,
                _batch.predecessor,
                _batch.salt,
                _batch.delay
            )
        );
        bytes memory executeCalldata = abi.encodeCall(
            TimelockController.executeBatch,
            (
                _batch.targets,
                _batch.values,
                _batch.payloads,
                _batch.predecessor,
                _batch.salt
            )
        );

        emit log_named_bytes("scheduleBatch calldata", scheduleCalldata);
        emit log_named_bytes(
            "executeBatch calldata (after delay)",
            executeCalldata
        );
    }

    /// @notice Copies the first `_n` entries of an address array into an exact-size array.
    function _trim(
        address[] memory _arr,
        uint256 _n
    ) internal pure returns (address[] memory out) {
        out = new address[](_n);
        for (uint256 i; i < _n; ++i) out[i] = _arr[i];
    }

    /// @notice Copies the first `_n` entries of a bytes array into an exact-size array.
    function _trimBytes(
        bytes[] memory _arr,
        uint256 _n
    ) internal pure returns (bytes[] memory out) {
        out = new bytes[](_n);
        for (uint256 i; i < _n; ++i) out[i] = _arr[i];
    }
}
