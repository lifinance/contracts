// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title LiFiVaultWrapperTypes
/// @author LI.FI (https://li.fi)
/// @notice Shared value types for the LI.FI vault wrapper subsystem.
/// @custom:version 1.0.0
/// @dev Declared at file level rather than inside an interface so the factory,
///      the wrapper, both of their interfaces, and the adapters can import them
///      directly without depending on one another (an interface owner would
///      force unrelated contracts to import that interface and risk circular
///      imports). File-level structs/enums are referenced by their bare name.

/// @notice Fee categories a wrapper instance can charge. Each member's ordinal
///         indexes the FeeConfig arrays and the factory's per-type bounds/caps.
enum FeeType {
    Performance,
    Management,
    Deposit,
    Withdrawal
}

/// @notice Per-instance fee selection, indexed by FeeType ordinal.
struct FeeConfig {
    uint16[4] rateBps; // Rate in bps for each FeeType (index = ordinal).
    bool[4] enabled; // Whether each FeeType is active; a disabled type must carry a zero rate.
}

/// @notice Owner-adjustable min/max rate (bps) for a single fee type, within the immutable cap.
struct FeeBounds {
    uint16 minBps; // Lowest rate an instance may set for the fee type.
    uint16 maxBps; // Highest rate an instance may set; must not exceed the fee type's cap.
}

/// @notice Inputs for a single `deploy` call.
struct DeployParams {
    bytes32 namespace; // Integrator identity seeding the salt (e.g. "Coinbase"); must be assigned to the caller.
    address vaultWrapperAdmin; // Per-vault controller granted the instance admin role.
    address adapter; // Approved yield adapter; resolves the underlying's ERC20 asset.
    address underlying; // Protocol-specific yield source (e.g. an ERC-4626 vault).
    uint256 nonce; // Disambiguates instances sharing the same (namespace, adapter, underlying).
    FeeConfig fees; // Per-fee-type rates and enabled flags; validated against bounds/caps.
    uint16 integratorShareBps; // Integrator's fee share (bps); type(uint16).max = factory default, else must be <= 100%.
    bytes initData; // Opaque wrapper-side config forwarded to the instance's initialize.
}
