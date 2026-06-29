// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title VaultWrapperPausable
/// @author LI.FI (https://li.fi)
/// @notice Pause mixin for a vault wrapper. Deposits (and any future inflow such as V2
///         reward injection) can be halted from two independent sources: the integrator
///         (its own clone) and the factory-level global circuit breaker read live. The
///         LI.FI emergency authority acts only through that factory-level global breaker —
///         it has no per-instance pause here. Withdrawals are deliberately NOT gated so
///         user exits stay open under every pause combination.
/// @dev Abstract: the concrete wrapper supplies the integrator pause authority and the
///      global flag via the `_integratorPauseAuthority`/`_globalPaused` hooks (they live in
///      the wrapper's storage / are read from the factory).
/// @custom:version 1.0.0
abstract contract VaultWrapperPausable {
    /// Storage ///

    /// @notice Whether the integrator has paused its own clone's deposits.
    bool public integratorPaused;

    /// @dev Reserved slots so this mixin can gain state in a future upgrade without
    ///      shifting the storage of contracts that inherit after it. Append-only; never
    ///      reorder fields or the inheriting contract's base list. (See LiFiVaultWrapper.)
    uint256[50] private __gap;

    /// Events ///

    /// @notice Emitted when the integrator toggles its clone pause.
    /// @param paused The new integrator-pause state.
    /// @param by The integrator authority that toggled it.
    event IntegratorPauseSet(bool paused, address indexed by);

    /// Errors ///

    /// @notice Thrown when a deposit is attempted while any pause source is engaged.
    error DepositsPaused();
    /// @notice Thrown when the caller is not the integrator authority.
    error NotIntegratorAdmin();

    /// Hooks (implemented by the wrapper) ///

    /// @dev The integrator authority allowed to toggle `integratorPaused`.
    function _integratorPauseAuthority()
        internal
        view
        virtual
        returns (address);

    /// @dev The factory-level global circuit-breaker state, read live.
    function _globalPaused() internal view virtual returns (bool);

    /// Modifiers ///

    modifier onlyIntegratorAdmin() {
        if (msg.sender != _integratorPauseAuthority())
            revert NotIntegratorAdmin();
        _;
    }

    /// Pause controls ///

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
    /// @return True if the instance is integrator-paused or the factory global circuit
    ///         breaker is engaged.
    function depositsPaused() public view returns (bool) {
        return integratorPaused || _globalPaused();
    }

    /// @dev Reverts when any pause source is engaged. Wired into deposit/mint only —
    ///      never into withdraw/redeem — so exits remain open during a pause.
    function _requireDepositsNotPaused() internal view {
        if (depositsPaused()) revert DepositsPaused();
    }
}
