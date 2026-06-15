// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "../../Helpers/TransferrableOwnership.sol";
import { InvalidConfig, InvalidContract, UnAuthorized } from "../../Errors/GenericErrors.sol";
import { FeeType, FeeBounds } from "./LiFiVaultWrapperTypes.sol";

/// @title LiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Deploys per-integrator vault wrapper instances as deterministic beacon
///         proxies, gated by a curated underlying allowlist, per-fee-type bounds,
///         deploy authorization, and a factory-level global circuit breaker.
/// @custom:version 1.0.0
contract LiFiVaultWrapperFactory is TransferrableOwnership {
    /// Constants ///

    uint16 internal constant CAP_PERFORMANCE_BPS = 5000;
    uint16 internal constant CAP_MANAGEMENT_BPS = 1000;
    uint16 internal constant CAP_DEPOSIT_BPS = 2000;
    uint16 internal constant CAP_WITHDRAWAL_BPS = 2000;
    uint16 internal constant DEFAULT_LIFI_SHARE_BPS = 2000;
    uint16 internal constant BPS_DENOMINATOR = 10000;

    bytes32 internal constant ROLE_EMERGENCY_PAUSER =
        keccak256("EMERGENCY_PAUSER");
    bytes32 internal constant ROLE_ONBOARDING_MANAGER =
        keccak256("ONBOARDING_MANAGER");

    /// Storage ///

    // solhint-disable-next-line immutable-vars-naming
    address public immutable beacon;

    address public emergencyPauser;
    address public onboardingManager;
    bool public globalPaused;

    mapping(address => bool) public allowedUnderlying;
    mapping(address => bool) public approvedIntegrator;
    mapping(FeeType => FeeBounds) public feeBounds;
    mapping(FeeType => uint16) public defaultLifiShareBps;

    mapping(bytes32 => address) public instanceBySalt;
    mapping(address => bool) public isInstance;
    address[] internal allInstances;

    /// Errors ///

    error UnderlyingNotAllowed();
    error UnderlyingProbeFailed();
    error ChainLockMismatch();
    error FeeRateAboveBound();
    error FeeRateAboveCap();
    error DisabledFeeMustBeZero();
    error IntegratorMismatch();
    error InstanceAlreadyExists();

    /// Events ///

    event WrapperDeployed(
        address indexed instance,
        address indexed integrator,
        address indexed underlying,
        uint256 chainLockId,
        uint256 nonce,
        bytes32 salt
    );
    event UnderlyingAllowedSet(address indexed underlying, bool allowed);
    event FeeBoundsSet(FeeType indexed feeType, uint16 minBps, uint16 maxBps);
    event DefaultSplitSet(FeeType indexed feeType, uint16 lifiBps);
    event IntegratorApprovedSet(address indexed integrator, bool approved);
    event GlobalPauseSet(bool paused, address indexed by);
    event RoleRotated(bytes32 indexed role, address oldAddr, address newAddr);

    /// Modifiers ///

    modifier onlyEmergencyPauser() {
        if (msg.sender != emergencyPauser) revert UnAuthorized();
        _;
    }

    modifier onlyOnboardingManager() {
        if (msg.sender != onboardingManager) revert UnAuthorized();
        _;
    }

    /// Constructor ///

    /// @notice Initializes the factory with a beacon and role addresses.
    /// @param _beacon        Address of the UpgradeableBeacon holding the wrapper implementation.
    /// @param _owner         Address that will own the factory.
    /// @param _emergencyPauser Address authorized to trigger global pause.
    /// @param _onboardingManager Address authorized to manage integrator allowlist.
    constructor(
        address _beacon,
        address _owner,
        address _emergencyPauser,
        address _onboardingManager
    ) TransferrableOwnership(_owner) {
        if (
            _beacon == address(0) ||
            _emergencyPauser == address(0) ||
            _onboardingManager == address(0)
        ) revert InvalidConfig();
        if (_beacon.code.length == 0) revert InvalidContract();

        beacon = _beacon;
        emergencyPauser = _emergencyPauser;
        onboardingManager = _onboardingManager;

        for (uint8 i; i < 4; ++i) {
            defaultLifiShareBps[FeeType(i)] = DEFAULT_LIFI_SHARE_BPS;
        }
    }
}
