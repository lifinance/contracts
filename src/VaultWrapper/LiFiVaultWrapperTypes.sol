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
    // Charged on share-price gains above the high-water mark, crystallized by
    // minting dilution shares to the wrapper at accrual time.
    Performance,
    // Time-based rate on AUM (annualized bps), crystallized by minting dilution
    // shares to the wrapper for the elapsed time at accrual time.
    Management,
    // Charged on entry: skimmed from the deposited assets before they are
    // forwarded to the yield source, held idle in the wrapper.
    Deposit,
    // Charged on exit: redeemed from the yield source on top of the assets
    // owed to the receiver, held idle in the wrapper.
    Withdrawal
}

// Number of FeeType members; sizes every per-fee-type array and bounds the
// accrual/validation loops. Must equal the count of FeeType members (Solidity
// does not allow deriving an array length from `type(FeeType).max`).
uint256 constant FEE_TYPE_COUNT = 4;

/// @notice Per-instance fee selection, indexed by FeeType ordinal.
struct FeeConfig {
    uint16[FEE_TYPE_COUNT] rateBps; // Rate in bps for each FeeType (index = ordinal); 0 = disabled.
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
    FeeConfig fees; // Per-fee-type rates (0 = disabled); validated against bounds/caps.
    uint16[FEE_TYPE_COUNT] integratorShareBps; // Integrator's fee share (bps) per FeeType (index = ordinal); type(uint16).max = factory default, else must be < 100%.
    bytes initData; // Opaque wrapper-side config forwarded to the instance's initialize.
    FeeReceiver[] receivers; // Integrator payout wallets + their bps split; validated on the instance at initialize.
}

/// @notice A single integrator payout wallet and its basis-point share, packed into one slot
///         (address + uint16). A wrapper instance holds 1..50 non-zero wallets whose bps sum
///         to exactly 10_000 (100%), validated together at initialize.
struct FeeReceiver {
    address wallet; // Payout wallet (non-zero).
    uint16 bps; // Share in bps.
}
