// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

/// @title IYieldAdapter
/// @author LI.FI (https://li.fi)
/// @notice Adapter abstraction over a yield source (ERC-4626 vault, Aave market, ...).
///         The factory depends only on `resolveAsset`; a vault wrapper instance routes
///         its deposits, withdrawals, and valuation through the other methods so that
///         support for a new yield source is added by deploying a new adapter rather
///         than changing the factory or the wrapper implementation.
/// @dev Methods split by how the wrapper invokes them, and this split is a security
///      invariant adapters MUST honour:
///      - `resolveAsset` and `totalAssets` are invoked as ordinary (static) calls and
///        run in the adapter's own context; they take an explicit `_holder`/`_underlying`
///        and MUST be free of side effects.
///      - `deposit` and `withdraw` are invoked via `delegatecall` and therefore run in
///        the wrapper's context: `address(this)`, token balances, and yield-source
///        positions are the wrapper's. They MUST be stateless with respect to adapter
///        storage (no reads or writes of adapter state) so a shared adapter cannot
///        corrupt or be corrupted by the wrapper's storage layout; they may only act on
///        their arguments and external calls.
/// @custom:version 1.0.0
interface IYieldAdapter {
    /// @notice Thrown when the adapter cannot resolve the underlying's asset.
    error AssetResolutionFailed();

    /// @notice Resolves the ERC20 asset deposited into `_underlying` for this
    ///         adapter's protocol.
    /// @dev MUST revert if the asset cannot be resolved (wrong protocol, not a
    ///      contract, zero asset). Invoked as an ordinary call by the factory.
    /// @param _underlying The protocol-specific yield source identifier.
    /// @return asset The ERC20 token deposited into the yield source.
    function resolveAsset(
        address _underlying
    ) external view returns (address asset);

    /// @notice Reports the assets `_holder` can currently redeem from `_underlying`.
    /// @dev Invoked as an ordinary (static) call; runs in the adapter's context, so the
    ///      holder is passed explicitly rather than read from `address(this)`.
    /// @param _underlying The protocol-specific yield source identifier.
    /// @param _holder The account whose yield-source position is valued (the wrapper).
    /// @return assets The value of `_holder`'s position denominated in the asset.
    function totalAssets(
        address _underlying,
        address _holder
    ) external view returns (uint256 assets);

    /// @notice Routes `_assets` of `_asset` held by the wrapper into `_underlying`.
    /// @dev DELEGATECALL ONLY — runs in the wrapper's context, so it spends the
    ///      wrapper's `_asset` balance and the resulting yield-source position accrues to
    ///      the wrapper. MUST NOT touch adapter storage.
    /// @param _asset The ERC20 asset to deposit (the wrapper holds the balance).
    /// @param _underlying The yield source to deposit into.
    /// @param _assets The amount of `_asset` to deposit.
    /// @return deposited The amount of `_asset` accepted by the yield source.
    function deposit(
        address _asset,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 deposited);

    /// @notice Pulls `_assets` of `_asset` back from `_underlying` into the wrapper.
    /// @dev DELEGATECALL ONLY — runs in the wrapper's context, so it redeems the
    ///      wrapper's yield-source position and the `_asset` lands on the wrapper.
    ///      MUST NOT touch adapter storage.
    /// @param _asset The ERC20 asset to withdraw (lands on the wrapper).
    /// @param _underlying The yield source to withdraw from.
    /// @param _assets The amount of `_asset` to withdraw.
    /// @return withdrawn The amount of `_asset` returned to the wrapper.
    function withdraw(
        address _asset,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 withdrawn);
}
