// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title VaultWrapperPausable
/// @author LI.FI (https://li.fi)
/// @notice Pause mixin for a vault wrapper. Deposits (and any future inflow such as V2
///         reward injection) can be halted from three independent sources: the LI.FI
///         emergency authority (instance pause), the integrator (its own clone), and the
///         factory-level global circuit breaker read live. Withdrawals are deliberately
///         NOT gated here so user exits stay open under every pause combination.
/// @dev Abstract: the concrete wrapper supplies the two pause authorities and the global
///      flag via the `_emergencyPauseAuthority`/`_integratorPauseAuthority`/`_globalPaused`
///      hooks (they live in the wrapper's storage / are read from the factory). The two
///      instance flags are separate so neither authority can lift the other's pause.
/// @custom:version 1.0.0
abstract contract VaultWrapperPausable {
    /// Storage ///

    /// @notice Whether the LI.FI emergency authority has paused this instance's deposits.
    bool public emergencyPaused;
    /// @notice Whether the integrator has paused its own clone's deposits.
    bool public integratorPaused;

    /// Events ///

    /// @notice Emitted when the LI.FI emergency authority toggles the instance pause.
    /// @param paused The new emergency-pause state.
    /// @param by The emergency authority that toggled it.
    event EmergencyPauseSet(bool paused, address indexed by);

    /// @notice Emitted when the integrator toggles its clone pause.
    /// @param paused The new integrator-pause state.
    /// @param by The integrator authority that toggled it.
    event IntegratorPauseSet(bool paused, address indexed by);

    /// Errors ///

    /// @notice Thrown when a deposit is attempted while any pause source is engaged.
    error DepositsPaused();
    /// @notice Thrown when the caller is not the LI.FI emergency authority.
    error NotEmergencyPauser();
    /// @notice Thrown when the caller is not the integrator authority.
    error NotIntegratorAdmin();

    /// Hooks (implemented by the wrapper) ///

    /// @dev The LI.FI emergency authority allowed to toggle `emergencyPaused`
    ///      (read live from the factory so a rotation propagates to every instance).
    function _emergencyPauseAuthority()
        internal
        view
        virtual
        returns (address);

    /// @dev The integrator authority allowed to toggle `integratorPaused`.
    function _integratorPauseAuthority()
        internal
        view
        virtual
        returns (address);

    /// @dev The factory-level global circuit-breaker state, read live.
    function _globalPaused() internal view virtual returns (bool);

    /// Modifiers ///

    modifier onlyEmergencyPauser() {
        if (msg.sender != _emergencyPauseAuthority())
            revert NotEmergencyPauser();
        _;
    }

    modifier onlyIntegratorAdmin() {
        if (msg.sender != _integratorPauseAuthority())
            revert NotIntegratorAdmin();
        _;
    }

    /// Pause controls ///

    /// @notice Pause this instance's deposits (LI.FI emergency authority).
    function emergencyPause() external onlyEmergencyPauser {
        emergencyPaused = true;
        emit EmergencyPauseSet(true, msg.sender);
    }

    /// @notice Resume this instance's deposits (LI.FI emergency authority).
    function emergencyUnpause() external onlyEmergencyPauser {
        emergencyPaused = false;
        emit EmergencyPauseSet(false, msg.sender);
    }

    /// @notice Pause this clone's deposits (integrator).
    function integratorPause() external onlyIntegratorAdmin {
        integratorPaused = true;
        emit IntegratorPauseSet(true, msg.sender);
    }

    /// @notice Resume this clone's deposits (integrator).
    function integratorUnpause() external onlyIntegratorAdmin {
        integratorPaused = false;
        emit IntegratorPauseSet(false, msg.sender);
    }

    /// Views ///

    /// @notice Whether deposits are currently halted by any pause source.
    /// @return True if the instance is emergency-paused, integrator-paused, or the
    ///         factory global circuit breaker is engaged.
    function depositsPaused() public view returns (bool) {
        return emergencyPaused || integratorPaused || _globalPaused();
    }

    /// @dev Reverts when any pause source is engaged. Wired into deposit/mint only —
    ///      never into withdraw/redeem — so exits remain open during a pause.
    function _requireDepositsNotPaused() internal view {
        if (depositsPaused()) revert DepositsPaused();
    }
}
