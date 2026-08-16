// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

/// @title IYieldAdapter
/// @author LI.FI (https://li.fi)
/// @notice Adapter abstraction over a yield source (ERC-4626 vault, Aave market, ...).
///         The factory depends only on `resolveAsset`; a vault wrapper instance routes
///         its deposits, withdrawals, and valuation through the other methods so that
///         support for a new yield source is added by deploying a new adapter rather
///         than changing the factory or the wrapper implementation.
/// @dev Methods split by how the wrapper invokes them, and this split is a security
///      invariant adapters MUST honour:
///      - `resolveAsset`, `totalAssets`, `previewWithdrawCost`, and `previewWithdrawUpTo`
///        are invoked as ordinary (static) calls and run in the adapter's own context;
///        they take an explicit `_holder`/`_underlying` and MUST be free of side effects.
///      - `deposit`, `withdraw`, and `withdrawUpTo` are invoked via `delegatecall` and
///        therefore run in the wrapper's context: `address(this)`, token balances, and
///        yield-source positions are the wrapper's. They MUST be stateless with respect
///        to adapter storage (no reads or writes of adapter state) so a shared adapter
///        cannot corrupt or be corrupted by the wrapper's storage layout; they may only
///        act on their arguments and external calls.
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

    /// @notice Position value the source consumes to deliver exactly `_assets` out.
    /// @dev Ordinary static call; used by the wrapper's exact-out `previewWithdraw` so
    ///      the exiting user's shares — not the remaining holders — pay the source's
    ///      exit cost. Returns >= `_assets` when the source charges an exit fee. Rounds
    ///      up (conservative for the vault). MAY revert if the source's preview reverts.
    /// @param _underlying The yield source identifier.
    /// @param _assets The net assets to be delivered out of the source.
    /// @return cost The position value consumed to deliver `_assets`.
    function previewWithdrawCost(
        address _underlying,
        uint256 _assets
    ) external view returns (uint256 cost);

    /// @notice Assets actually delivered if `_holder` realizes up to `_assets` of position
    ///         value right now (net of any source exit fee), capped at `_holder`'s position.
    /// @dev Ordinary static call; the static mirror of `withdrawUpTo` and MUST use the same
    ///      share math so `previewRedeem` matches `redeem`. Does NOT cap at source
    ///      liquidity limits (only at the position). MAY revert if the source preview reverts.
    /// @param _underlying The yield source identifier.
    /// @param _holder The account whose position is valued (the wrapper).
    /// @param _assets The position value to realize, capped at `_holder`'s position.
    /// @return delivered The assets the source would deliver.
    function previewWithdrawUpTo(
        address _underlying,
        address _holder,
        uint256 _assets
    ) external view returns (uint256 delivered);

    /// @notice Realizes up to `_assets` of position value from `_underlying` into the wrapper
    ///         (exact-in), paying out whatever the source delivers rather than targeting an
    ///         exact asset amount.
    /// @dev DELEGATECALL ONLY — runs in the wrapper's context (see `withdraw`). Redeems the
    ///      source-share slice worth `_assets`, capped at the wrapper's whole position.
    ///      Reports the measured asset balance delta. MUST NOT touch adapter storage.
    /// @param _asset The ERC20 asset withdrawn (lands on the wrapper).
    /// @param _underlying The yield source to realize from.
    /// @param _assets The position value to realize, capped at the wrapper's position.
    /// @return withdrawn The assets returned to the wrapper.
    function withdrawUpTo(
        address _asset,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 withdrawn);

    /// @notice Gross position value `_holder` may withdraw from `_underlying` right now, capped
    ///         by the source's current withdrawal/redemption liquidity limits.
    /// @dev Ordinary static call; runs in the adapter's context, so the holder is passed
    ///      explicitly. Returns the source's floor valuation (`convertToAssets`) of
    ///      `min(_holder's position, source maxRedeem)` — deliberately the GROSS valuation, not
    ///      the fee-netted `previewRedeem` the sibling `previewWithdrawUpTo` uses, because the
    ///      wrapper feeds this straight into its own gross-denominated share math
    ///      (`_convertToShares`) to clamp `maxRedeem`/`maxWithdraw` to the shares the source can
    ///      honor; any source exit fee is applied separately by the wrapper's realizable redeem
    ///      path. This keeps the EIP-4626 guarantee that an exit within `maxRedeem` never
    ///      reverts. Equals the full position value on a source with no active liquidity limit.
    ///      Does NOT net the source's exit fee or the wrapper's own fees. MAY revert if the
    ///      source's views revert (the wrapper treats a reverting source view as fail-closed,
    ///      matching its existing preview posture).
    /// @param _underlying The yield source identifier.
    /// @param _holder The account whose position is valued (the wrapper).
    /// @return assets The gross, source-liquidity-capped position value.
    function maxWithdrawableValue(
        address _underlying,
        address _holder
    ) external view returns (uint256 assets);
}
