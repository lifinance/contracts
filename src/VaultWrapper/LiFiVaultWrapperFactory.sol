// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { InvalidContract } from "../Errors/GenericErrors.sol";
import { FeeType, FeeBounds, FeeConfig, DeployParams } from "./LiFiVaultWrapperTypes.sol";
import { IYieldAdapter } from "./interfaces/IYieldAdapter.sol";
import { ILiFiVaultWrapper } from "./interfaces/ILiFiVaultWrapper.sol";
import { ILiFiVaultWrapperFactory } from "./interfaces/ILiFiVaultWrapperFactory.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";

/// @title LiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Deploys per-integrator vault wrapper instances as deterministic beacon
///         proxies, gated by a curated underlying allowlist, per-fee-type bounds,
///         deploy authorization, and a factory-level global circuit breaker.
///         This contract does not custody user funds; it only deploys and
///         configures wrapper instances.
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
    /// @notice Integrator fee share (bps) applied when a deploy does not override it; 80% (LI.FI receives the remaining 20%).
    uint16 internal constant DEFAULT_INTEGRATOR_SHARE_BPS = 8000;
    /// @notice Sentinel for DeployParams.integratorShareBps meaning "inherit the factory default".
    uint16 internal constant USE_DEFAULT_SPLIT = type(uint16).max;
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
    address public immutable BEACON;

    /// Storage ///

    /// @notice Address authorized to toggle the global circuit breaker.
    address public emergencyPauser;
    /// @notice Address authorized to approve and revoke integrators.
    address public onboardingManager;
    /// @notice Recipient of LI.FI's fee share; read live by every vault wrapper at
    ///         distribution, so an integrator cannot redirect LI.FI's cut.
    address public lifiFeeRecipient;
    /// @notice Whether deposits are globally halted; read by every vault wrapper.
    bool public globalPaused;

    /// @notice Whether a yield source is permitted as a wrapper underlying.
    mapping(address => bool) public allowedUnderlying;
    /// @notice Deployer authorized to deploy under an integrator namespace, keyed by
    ///         namespace (e.g. "Coinbase"); assigned by the onboarding manager.
    mapping(bytes32 => address) public approvedIntegratorDeployer;
    /// @notice Whether a yield adapter is approved for use in deployments.
    mapping(address => bool) public approvedAdapter;
    /// @notice Adjustable min/max fee bps per fee type, within the immutable caps.
    mapping(FeeType => FeeBounds) public feeBounds;
    /// @notice Integrator fee share (bps) applied to a deploy that does not override
    ///         it; LI.FI receives the remaining (100% - this value). Snapshotted into
    ///         each instance at deploy.
    uint16 public defaultIntegratorShareBps;

    /// @notice Whether an address is a wrapper instance deployed by this factory.
    mapping(address => bool) public isInstance;

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
    /// @param _onboardingManager Address authorized to assign/revoke the deployer for each integrator namespace.
    /// @param _lifiFeeRecipient Recipient of LI.FI's fee share.
    constructor(
        address _beacon,
        address _owner,
        address _emergencyPauser,
        address _onboardingManager,
        address _lifiFeeRecipient
    ) TransferrableOwnership(_owner) {
        if (
            _beacon == address(0) ||
            _owner == address(0) ||
            _emergencyPauser == address(0) ||
            _onboardingManager == address(0) ||
            _lifiFeeRecipient == address(0)
        ) revert ZeroAddress();
        if (!LibAsset.isContract(_beacon)) revert InvalidContract();

        BEACON = _beacon;
        emergencyPauser = _emergencyPauser;
        onboardingManager = _onboardingManager;
        lifiFeeRecipient = _lifiFeeRecipient;
        defaultIntegratorShareBps = DEFAULT_INTEGRATOR_SHARE_BPS;
    }

    /// Config (owner / timelock) ///

    /// @notice Add or remove a yield source from the deploy allowlist.
    /// @param _underlying The yield source (e.g. an ERC-4626 vault) to toggle.
    /// @param _allowed    True to allow as a wrapper underlying, false to remove.
    function setUnderlyingAllowed(
        address _underlying,
        bool _allowed
    ) external onlyOwner {
        if (_underlying == address(0)) revert ZeroAddress();
        allowedUnderlying[_underlying] = _allowed;
        emit UnderlyingAllowedSet(_underlying, _allowed);
    }

    /// @notice Approve or revoke a yield adapter usable in deployments.
    /// @param _adapter  The yield adapter to toggle.
    /// @param _approved True to approve the adapter, false to revoke it.
    function setAdapterApproved(
        address _adapter,
        bool _approved
    ) external onlyOwner {
        if (_adapter == address(0)) revert ZeroAddress();
        if (_approved && !LibAsset.isContract(_adapter))
            revert InvalidContract();
        approvedAdapter[_adapter] = _approved;
        emit AdapterApprovedSet(_adapter, _approved);
    }

    /// @notice Set adjustable min/max bps bounds for a fee type (within the immutable cap).
    /// @param _feeType The fee type whose bounds are being set.
    /// @param _minBps  Lowest rate (bps) an instance may set for the fee type.
    /// @param _maxBps  Highest rate (bps) an instance may set; must not exceed the cap.
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

    /// @notice Set the default integrator fee share (bps) applied to deploys that don't
    ///         override it; LI.FI implicitly receives the remaining (100% - this value).
    /// @param _integratorBps The integrator's default share (bps); must be < 100% so
    ///        LI.FI always retains a non-zero share.
    function setDefaultSplit(uint16 _integratorBps) external onlyOwner {
        if (_integratorBps >= BPS_DENOMINATOR) revert InvalidSplit();
        defaultIntegratorShareBps = _integratorBps;
        emit DefaultSplitSet(_integratorBps);
    }

    /// @notice Set the recipient of LI.FI's fee share, read live by vault wrappers.
    /// @param _recipient The address that receives LI.FI's fee share.
    function setLifiFeeRecipient(address _recipient) external onlyOwner {
        if (_recipient == address(0)) revert ZeroAddress();
        lifiFeeRecipient = _recipient;
        emit LifiFeeRecipientSet(_recipient);
    }

    /// @notice Rotate the emergency pauser role.
    /// @param _newPauser The new emergency pauser address.
    function setEmergencyPauser(address _newPauser) external onlyOwner {
        if (_newPauser == address(0)) revert ZeroAddress();
        address prev = emergencyPauser;
        emergencyPauser = _newPauser;
        emit RoleRotated(ROLE_EMERGENCY_PAUSER, prev, _newPauser);
    }

    /// @notice Rotate the onboarding manager role.
    /// @param _newManager The new onboarding manager address.
    function setOnboardingManager(address _newManager) external onlyOwner {
        if (_newManager == address(0)) revert ZeroAddress();
        address prev = onboardingManager;
        onboardingManager = _newManager;
        emit RoleRotated(ROLE_ONBOARDING_MANAGER, prev, _newManager);
    }

    /// Integrator onboarding (onboarding manager) ///

    /// @notice Assign or revoke the deployer authorized to deploy under a namespace.
    /// @dev Set `_deployer` to the zero address to revoke the namespace. The
    ///      namespace is the salt seed, so reassigning it does not move the
    ///      addresses of instances already deployed under it.
    /// @param _namespace The integrator namespace (e.g. "Coinbase").
    /// @param _deployer The address allowed to deploy under it (zero to revoke).
    function setApprovedIntegratorDeployer(
        bytes32 _namespace,
        address _deployer
    ) external onlyOnboardingManager {
        if (_namespace == bytes32(0)) revert ZeroNamespace();
        approvedIntegratorDeployer[_namespace] = _deployer;
        emit IntegratorDeployerSet(_namespace, _deployer);
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

    /// Deploy ///

    /// @notice Deploy a new wrapper instance under an integrator namespace.
    /// @dev Caller must be the onboarding manager, or the deployer assigned to
    ///      `_params.namespace`. A self-serve deployer (not the onboarding manager)
    ///      may only set an integrator share at or below `defaultIntegratorShareBps`,
    ///      so it can give LI.FI more than the default cut but never less; the
    ///      onboarding manager may set any share up to 100%.
    ///      Deploys are intentionally allowed while `globalPaused` is set: a new
    ///      instance is a beacon proxy that reads the same live flag, so it is frozen
    ///      from birth and poses no deposit risk.
    /// @param _params The deployment parameters.
    /// @return instance The address of the newly deployed vault wrapper.
    function deploy(
        DeployParams calldata _params
    ) external returns (address instance) {
        if (_params.namespace == bytes32(0)) revert ZeroNamespace();
        if (
            msg.sender != onboardingManager &&
            approvedIntegratorDeployer[_params.namespace] != msg.sender
        ) revert NotApprovedDeployer();
        if (_params.vaultWrapperAdmin == address(0)) revert ZeroAddress();
        if (!approvedAdapter[_params.adapter]) revert AdapterNotApproved();
        if (!allowedUnderlying[_params.underlying])
            revert UnderlyingNotAllowed();

        address asset = _resolveAssetViaAdapter(
            _params.adapter,
            _params.underlying
        );

        _validateFees(_params.fees);

        uint16 integratorShareBps = _params.integratorShareBps;
        if (integratorShareBps == USE_DEFAULT_SPLIT) {
            integratorShareBps = defaultIntegratorShareBps;
        } else if (integratorShareBps >= BPS_DENOMINATOR) {
            revert InvalidSplit();
        } else if (
            msg.sender != onboardingManager &&
            integratorShareBps > defaultIntegratorShareBps
        ) {
            revert IntegratorShareAboveDefault();
        }

        bytes32 salt = _salt(
            _params.namespace,
            _params.adapter,
            _params.underlying,
            _params.nonce
        );
        // Reusing a salt reverts in Create2 (CREATE2 to an existing address).
        instance = Create2.deploy(0, salt, _proxyInitCode());

        isInstance[instance] = true;

        emit WrapperDeployed(
            instance,
            _params.namespace,
            _params.underlying,
            _params.adapter,
            asset,
            _params.vaultWrapperAdmin,
            integratorShareBps,
            _params.nonce,
            salt
        );

        ILiFiVaultWrapper(instance).initialize(
            asset,
            _params.underlying,
            _params.adapter,
            _params.vaultWrapperAdmin,
            integratorShareBps,
            _params.fees,
            _params.initData
        );
    }

    /// Views ///

    /// @notice The deterministic address a vault wrapper will have for the given key.
    /// @param _namespace The integrator namespace that owns the instance.
    /// @param _adapter The yield adapter the instance routes through.
    /// @param _underlying The wrapped yield source.
    /// @param _nonce Caller-supplied disambiguator.
    /// @return The address the instance will be deployed to for these inputs.
    function predictAddress(
        bytes32 _namespace,
        address _adapter,
        address _underlying,
        uint256 _nonce
    ) external view returns (address) {
        return
            Create2.computeAddress(
                _salt(_namespace, _adapter, _underlying, _nonce),
                keccak256(_proxyInitCode()),
                address(this)
            );
    }

    /// Internal ///

    /// @notice Derives the CREATE2 salt that fixes a wrapper instance's address.
    /// @dev The namespace is chain-independent (e.g. "Coinbase"), so identical inputs
    ///      yield the same salt on every chain even when the integrator uses different
    ///      deployers/admins per chain. Cross-chain address parity additionally
    ///      requires the factory (the CREATE2 deployer) and the beacon (baked into the
    ///      proxy creation code) to sit at identical addresses on each chain, which is
    ///      the deterministic-deploy concern of S14 (EXSC-420). `_nonce` disambiguates
    ///      multiple instances for the same (namespace, adapter, underlying) triple.
    /// @param _namespace The integrator namespace that owns the instance.
    /// @param _adapter The yield adapter the instance routes through.
    /// @param _underlying The wrapped yield source.
    /// @param _nonce Caller-supplied disambiguator.
    /// @return The CREATE2 salt.
    function _salt(
        bytes32 _namespace,
        address _adapter,
        address _underlying,
        uint256 _nonce
    ) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(_namespace, _adapter, _underlying, _nonce));
    }

    /// @notice CREATE2 init code for a wrapper instance: the OZ BeaconProxy
    ///         creation code with the beacon as constructor arg and empty init
    ///         data (the factory calls initialize separately after deploy).
    /// @dev Used by both deploy and predictAddress so the init-code hash that
    ///      fixes the instance address is identical on both paths.
    /// @return The beacon-proxy init code.
    function _proxyInitCode() internal view returns (bytes memory) {
        return
            abi.encodePacked(
                type(BeaconProxy).creationCode,
                abi.encode(BEACON, bytes(""))
            );
    }

    /// @notice Returns the immutable bytecode cap (bps) for a fee type.
    /// @param _feeType The fee type to look up.
    /// @return The highest rate (bps) governance may ever set for this fee type.
    function _cap(FeeType _feeType) internal pure returns (uint16) {
        uint16[4] memory caps = [
            CAP_PERFORMANCE_BPS,
            CAP_MANAGEMENT_BPS,
            CAP_DEPOSIT_BPS,
            CAP_WITHDRAWAL_BPS
        ];
        return caps[uint256(_feeType)];
    }

    /// @notice Resolves the underlying's ERC20 asset via the approved adapter.
    /// @dev The adapter is trusted to revert on an unusable underlying (it is
    ///      governance-approved and code-checked at approval); this guards only
    ///      against an adapter that returns the zero address without reverting.
    /// @param _adapter The approved yield adapter.
    /// @param _underlying The yield source to resolve.
    /// @return asset The ERC20 token the underlying is denominated in.
    function _resolveAssetViaAdapter(
        address _adapter,
        address _underlying
    ) internal view returns (address asset) {
        asset = IYieldAdapter(_adapter).resolveAsset(_underlying);
        if (asset == address(0)) revert IYieldAdapter.AssetResolutionFailed();
    }

    /// @notice Validates a fee config against the per-type bounds and caps.
    /// @dev Disabled fee types must carry a zero rate; an enabled rate must sit
    ///      within both the immutable cap and the owner-set bounds. Unset bounds
    ///      default to 0..0, so an enabled fee with no configured bounds fails
    ///      closed.
    /// @param _fees The per-fee-type rates and enabled flags to validate.
    function _validateFees(FeeConfig calldata _fees) internal view {
        for (uint8 i; i <= uint8(type(FeeType).max); ++i) {
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
