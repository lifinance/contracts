// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { InvalidContract } from "../Errors/GenericErrors.sol";
import { FeeType, FeeBounds, FeeConfig, DeployParams } from "./LiFiVaultWrapperTypes.sol";
import { IYieldAdapter } from "./interfaces/IYieldAdapter.sol";
import { ILiFiVaultWrapper } from "./interfaces/ILiFiVaultWrapper.sol";
import { ILiFiVaultWrapperFactory } from "./interfaces/ILiFiVaultWrapperFactory.sol";
import { LibClone } from "solady/utils/LibClone.sol";

/// @title LiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Deploys per-integrator vault wrapper instances as deterministic beacon
///         proxies, gated by a curated underlying allowlist, per-fee-type bounds,
///         deploy authorization, and a factory-level global circuit breaker.
/// @custom:version 1.0.0
contract LiFiVaultWrapperFactory is
    TransferrableOwnership,
    ILiFiVaultWrapperFactory
{
    /// Constants ///

    /// @notice Immutable upper cap for the performance fee (bps); 50%.
    uint16 internal constant CAP_PERFORMANCE_BPS = 5000;
    /// @notice Immutable upper cap for the management fee (bps); 10%.
    uint16 internal constant CAP_MANAGEMENT_BPS = 1000;
    /// @notice Immutable upper cap for the deposit fee (bps); 20%.
    uint16 internal constant CAP_DEPOSIT_BPS = 2000;
    /// @notice Immutable upper cap for the withdrawal fee (bps); 20%.
    uint16 internal constant CAP_WITHDRAWAL_BPS = 2000;
    /// @notice Default integrator share of fees (bps) seeded for every fee type at deployment; 80% (LI.FI receives the remaining 20%).
    uint16 internal constant DEFAULT_INTEGRATOR_SHARE_BPS = 8000;
    /// @notice Basis-point denominator (100%).
    uint16 internal constant BPS_DENOMINATOR = 10000;

    /// @notice Role identifier reported by RoleRotated when the emergency pauser changes.
    bytes32 internal constant ROLE_EMERGENCY_PAUSER =
        keccak256("EMERGENCY_PAUSER");
    /// @notice Role identifier reported by RoleRotated when the onboarding manager changes.
    bytes32 internal constant ROLE_ONBOARDING_MANAGER =
        keccak256("ONBOARDING_MANAGER");

    /// Immutables ///

    /// @notice The UpgradeableBeacon holding the shared implementation every vault wrapper delegatecalls to.
    address public immutable beacon; // solhint-disable-line immutable-vars-naming

    /// Storage ///

    /// @notice Address authorized to toggle the global circuit breaker.
    address public emergencyPauser;
    /// @notice Address authorized to approve and revoke integrators.
    address public onboardingManager;
    /// @notice Whether deposits are globally halted; read by every vault wrapper.
    bool public globalPaused;

    /// @notice Whether a yield source is permitted as a wrapper underlying.
    mapping(address => bool) public allowedUnderlying;
    /// @notice Whether an integrator may self-deploy its own wrapper instances.
    mapping(address => bool) public approvedIntegrator;
    /// @notice Whether a yield adapter is approved for use in deployments.
    mapping(address => bool) public approvedAdapter;
    /// @notice Adjustable min/max fee bps per fee type, within the immutable caps.
    mapping(FeeType => FeeBounds) public feeBounds;
    /// @notice Default share of the underlying-generated fees (bps) routed to the
    ///         integrator; LI.FI receives the remaining (100% - this value). Read by
    ///         vault wrappers when splitting fees with the integrator.
    uint16 public defaultIntegratorShareBps;

    /// @notice Deployed instance address keyed by its CREATE2 salt; non-zero means the salt is taken.
    mapping(bytes32 => address) public instanceBySalt;
    /// @notice Whether an address is a wrapper instance deployed by this factory.
    mapping(address => bool) public isInstance;
    /// @notice Every wrapper instance deployed by this factory, in deployment order.
    address[] internal allInstances;

    /// Modifiers ///

    modifier onlyEmergencyPauser() {
        if (msg.sender != emergencyPauser) revert NotEmergencyPauser();
        _;
    }

    modifier onlyOnboardingManager() {
        if (msg.sender != onboardingManager) revert NotOnboardingManager();
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
            _owner == address(0) ||
            _emergencyPauser == address(0) ||
            _onboardingManager == address(0)
        ) revert ZeroAddress();
        if (_beacon.code.length == 0) revert InvalidContract();

        beacon = _beacon;
        emergencyPauser = _emergencyPauser;
        onboardingManager = _onboardingManager;
        defaultIntegratorShareBps = DEFAULT_INTEGRATOR_SHARE_BPS;
    }

    /// Config (owner / timelock) ///

    /// @notice Add or remove a yield source from the deploy allowlist.
    function setUnderlyingAllowed(
        address _underlying,
        bool _allowed
    ) external onlyOwner {
        if (_underlying == address(0)) revert ZeroAddress();
        allowedUnderlying[_underlying] = _allowed;
        emit UnderlyingAllowedSet(_underlying, _allowed);
    }

    /// @notice Approve or revoke a yield adapter usable in deployments.
    function setAdapterApproved(
        address _adapter,
        bool _approved
    ) external onlyOwner {
        if (_adapter == address(0)) revert ZeroAddress();
        approvedAdapter[_adapter] = _approved;
        emit AdapterApprovedSet(_adapter, _approved);
    }

    /// @notice Set adjustable min/max bps bounds for a fee type (within the immutable cap).
    function setFeeBounds(
        FeeType _feeType,
        uint16 _minBps,
        uint16 _maxBps
    ) external onlyOwner {
        if (_minBps > _maxBps || _maxBps > _cap(_feeType))
            revert InvalidFeeBounds();
        feeBounds[_feeType] = FeeBounds(_minBps, _maxBps);
        emit FeeBoundsSet(_feeType, _minBps, _maxBps);
    }

    /// @notice Set the default integrator share (bps) of the underlying-generated fees;
    ///         LI.FI implicitly receives the remaining (100% - this value). Read by vault
    ///         wrappers when applying the split (see S1).
    function setDefaultSplit(uint16 _integratorBps) external onlyOwner {
        if (_integratorBps > BPS_DENOMINATOR) revert InvalidSplit();
        defaultIntegratorShareBps = _integratorBps;
        emit DefaultSplitSet(_integratorBps);
    }

    /// @notice Rotate the emergency pauser role.
    function setEmergencyPauser(address _newPauser) external onlyOwner {
        if (_newPauser == address(0)) revert ZeroAddress();
        address prev = emergencyPauser;
        emergencyPauser = _newPauser;
        emit RoleRotated(ROLE_EMERGENCY_PAUSER, prev, _newPauser);
    }

    /// @notice Rotate the onboarding manager role.
    function setOnboardingManager(address _newManager) external onlyOwner {
        if (_newManager == address(0)) revert ZeroAddress();
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
        if (_integrator == address(0)) revert ZeroAddress();
        approvedIntegrator[_integrator] = _approved;
        emit IntegratorApprovedSet(_integrator, _approved);
    }

    /// Global circuit breaker (emergency pauser) ///

    /// @notice Halt deposits across every vault wrapper.
    function globalPause() external onlyEmergencyPauser {
        globalPaused = true;
        emit GlobalPauseSet(true, msg.sender);
    }

    /// @notice Resume deposits across every vault wrapper.
    function globalUnpause() external onlyEmergencyPauser {
        globalPaused = false;
        emit GlobalPauseSet(false, msg.sender);
    }

    /// Views ///

    /// @notice Number of wrapper instances deployed by this factory.
    function instancesLength() external view returns (uint256) {
        return allInstances.length;
    }

    /// @notice All wrapper instances deployed by this factory.
    function getAllInstances() external view returns (address[] memory) {
        return allInstances;
    }

    /// @notice A bounded slice of deployed instances, for enumeration at scale.
    /// @param _offset Start index into the instance list.
    /// @param _limit Maximum number of instances to return.
    /// @return page The instances in [_offset, min(_offset + _limit, length)).
    function getInstances(
        uint256 _offset,
        uint256 _limit
    ) external view returns (address[] memory page) {
        uint256 total = allInstances.length;
        if (_offset >= total) return new address[](0);
        uint256 end = _offset + _limit;
        if (end > total) end = total;
        page = new address[](end - _offset);
        for (uint256 i; i < page.length; ++i) {
            page[i] = allInstances[_offset + i];
        }
    }

    /// @notice The deterministic address a vault wrapper will have for the given key.
    function predictAddress(
        address _integrator,
        address _adapter,
        address _underlying,
        uint256 _nonce
    ) external view returns (address) {
        return
            LibClone.predictDeterministicAddressERC1967BeaconProxy(
                beacon,
                _salt(_integrator, _adapter, _underlying, _nonce),
                address(this)
            );
    }

    /// Internal ///

    function _salt(
        address _integrator,
        address _adapter,
        address _underlying,
        uint256 _nonce
    ) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(_integrator, _adapter, _underlying, _nonce));
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
    /// @return instance The address of the newly deployed vault wrapper.
    function deploy(
        DeployParams calldata _params
    ) external returns (address instance) {
        if (msg.sender != onboardingManager) {
            if (!approvedIntegrator[msg.sender])
                revert IntegratorNotApproved();
            if (_params.integrator != msg.sender) revert IntegratorMismatch();
        }
        if (_params.integrator == address(0)) revert ZeroAddress();
        if (!approvedAdapter[_params.adapter]) revert AdapterNotApproved();
        if (!allowedUnderlying[_params.underlying])
            revert UnderlyingNotAllowed();

        address asset = _probeViaAdapter(_params.adapter, _params.underlying);

        if (_params.chainLockId != 0 && _params.chainLockId != block.chainid)
            revert ChainLockMismatch();

        _validateFees(_params.fees);

        bytes32 salt = _salt(
            _params.integrator,
            _params.adapter,
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

        emit WrapperDeployed(
            instance,
            _params.integrator,
            _params.underlying,
            _params.adapter,
            _params.chainLockId,
            _params.nonce,
            salt
        );

        ILiFiVaultWrapper(instance).initialize(
            asset,
            _params.underlying,
            _params.adapter,
            _params.integrator,
            _params.chainLockId,
            _params.fees,
            _params.initData
        );
    }

    function _probeViaAdapter(
        address _adapter,
        address _underlying
    ) internal view returns (address asset) {
        try IYieldAdapter(_adapter).probe(_underlying) returns (address a) {
            if (a == address(0)) revert UnderlyingProbeFailed();
            asset = a;
        } catch {
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
