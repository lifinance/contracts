// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "../../Helpers/TransferrableOwnership.sol";
import { InvalidConfig, InvalidContract, UnAuthorized } from "../../Errors/GenericErrors.sol";
import { FeeType, FeeBounds, FeeConfig, DeployParams } from "./LiFiVaultWrapperTypes.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ILiFiVaultWrapper } from "./interfaces/ILiFiVaultWrapper.sol";
import { LibClone } from "solady/utils/LibClone.sol";

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

    /// Config (owner / timelock) ///

    /// @notice Add or remove an ERC4626 vault from the deploy allowlist.
    function setUnderlyingAllowed(
        address _underlying,
        bool _allowed
    ) external onlyOwner {
        if (_underlying == address(0)) revert InvalidConfig();
        allowedUnderlying[_underlying] = _allowed;
        emit UnderlyingAllowedSet(_underlying, _allowed);
    }

    /// @notice Set adjustable min/max bps bounds for a fee type (within the immutable cap).
    function setFeeBounds(
        FeeType _feeType,
        uint16 _minBps,
        uint16 _maxBps
    ) external onlyOwner {
        if (_minBps > _maxBps || _maxBps > _cap(_feeType))
            revert InvalidConfig();
        feeBounds[_feeType] = FeeBounds(_minBps, _maxBps);
        emit FeeBoundsSet(_feeType, _minBps, _maxBps);
    }

    /// @notice Set the default LI.FI share (bps) applied to new instances for a fee type.
    function setDefaultSplit(
        FeeType _feeType,
        uint16 _lifiBps
    ) external onlyOwner {
        if (_lifiBps > BPS_DENOMINATOR) revert InvalidConfig();
        defaultLifiShareBps[_feeType] = _lifiBps;
        emit DefaultSplitSet(_feeType, _lifiBps);
    }

    /// @notice Rotate the emergency pauser role.
    function setEmergencyPauser(address _newPauser) external onlyOwner {
        if (_newPauser == address(0)) revert InvalidConfig();
        address prev = emergencyPauser;
        emergencyPauser = _newPauser;
        emit RoleRotated(ROLE_EMERGENCY_PAUSER, prev, _newPauser);
    }

    /// @notice Rotate the onboarding manager role.
    function setOnboardingManager(address _newManager) external onlyOwner {
        if (_newManager == address(0)) revert InvalidConfig();
        address prev = onboardingManager;
        onboardingManager = _newManager;
        emit RoleRotated(ROLE_ONBOARDING_MANAGER, prev, _newManager);
    }

    /// Integrator onboarding (onboarding manager) ///

    /// @notice Approve or revoke an integrator's right to self-deploy instances.
    function setIntegratorApproved(
        address _integrator,
        bool _approved
    ) external onlyOnboardingManager {
        if (_integrator == address(0)) revert InvalidConfig();
        approvedIntegrator[_integrator] = _approved;
        emit IntegratorApprovedSet(_integrator, _approved);
    }

    /// Global circuit breaker (emergency pauser) ///

    /// @notice Halt deposits across every clone.
    function globalPause() external onlyEmergencyPauser {
        globalPaused = true;
        emit GlobalPauseSet(true, msg.sender);
    }

    /// @notice Resume deposits across every clone.
    function globalUnpause() external onlyEmergencyPauser {
        globalPaused = false;
        emit GlobalPauseSet(false, msg.sender);
    }

    /// @notice Whether deposits are globally halted; read by every clone.
    function isGlobalPaused() external view returns (bool) {
        return globalPaused;
    }

    /// Views ///

    /// @notice The deterministic address a clone will have for the given key.
    function predictAddress(
        address _integrator,
        address _underlying,
        uint256 _nonce
    ) external view returns (address) {
        return
            LibClone.predictDeterministicAddressERC1967BeaconProxy(
                beacon,
                _salt(_integrator, _underlying, _nonce),
                address(this)
            );
    }

    /// Internal ///

    function _salt(
        address _integrator,
        address _underlying,
        uint256 _nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(_integrator, _underlying, _nonce));
    }

    function _cap(FeeType _feeType) internal pure returns (uint16) {
        if (_feeType == FeeType.Performance) return CAP_PERFORMANCE_BPS;
        if (_feeType == FeeType.Management) return CAP_MANAGEMENT_BPS;
        if (_feeType == FeeType.Deposit) return CAP_DEPOSIT_BPS;
        return CAP_WITHDRAWAL_BPS;
    }

    /// @notice Deploy a new wrapper instance for an integrator.
    /// @dev Caller must be the onboarding manager, or an approved integrator
    ///      deploying for itself (`_params.integrator == msg.sender`).
    /// @param _params The deployment parameters.
    /// @return instance The address of the newly deployed wrapper clone.
    function deploy(
        DeployParams calldata _params
    ) external returns (address instance) {
        if (msg.sender != onboardingManager) {
            if (!approvedIntegrator[msg.sender]) revert UnAuthorized();
            if (_params.integrator != msg.sender) revert IntegratorMismatch();
        }
        if (_params.integrator == address(0)) revert InvalidConfig();
        if (!allowedUnderlying[_params.underlying])
            revert UnderlyingNotAllowed();

        address asset = _probeUnderlying(_params.underlying);

        if (_params.chainLockId != 0 && _params.chainLockId != block.chainid)
            revert ChainLockMismatch();

        _validateFees(_params.fees);

        bytes32 salt = _salt(
            _params.integrator,
            _params.underlying,
            _params.nonce
        );
        if (instanceBySalt[salt] != address(0)) revert InstanceAlreadyExists();

        instance = LibClone.deployDeterministicERC1967BeaconProxy(
            beacon,
            salt
        );

        instanceBySalt[salt] = instance;
        isInstance[instance] = true;
        allInstances.push(instance);

        ILiFiVaultWrapper(instance).initialize(
            asset,
            _params.underlying,
            _params.integrator,
            _params.chainLockId,
            _params.fees,
            _params.initData
        );

        emit WrapperDeployed(
            instance,
            _params.integrator,
            _params.underlying,
            _params.chainLockId,
            _params.nonce,
            salt
        );
    }

    function _probeUnderlying(
        address _underlying
    ) internal view returns (address asset) {
        if (_underlying.code.length == 0) revert UnderlyingProbeFailed();
        try IERC4626(_underlying).asset() returns (address a) {
            if (a == address(0)) revert UnderlyingProbeFailed();
            asset = a;
        } catch {
            revert UnderlyingProbeFailed();
        }
        try IERC4626(_underlying).totalAssets() returns (uint256) {} catch {
            revert UnderlyingProbeFailed();
        }
    }

    function _validateFees(FeeConfig calldata _fees) internal view {
        for (uint8 i; i < 4; ++i) {
            if (!_fees.enabled[i]) {
                if (_fees.rateBps[i] != 0) revert DisabledFeeMustBeZero();
                continue;
            }
            uint16 rate = _fees.rateBps[i];
            if (rate > _cap(FeeType(i))) revert FeeRateAboveCap();
            FeeBounds memory b = feeBounds[FeeType(i)];
            if (rate < b.minBps || rate > b.maxBps) revert FeeRateAboveBound();
        }
    }
}
