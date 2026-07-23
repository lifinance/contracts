# Vault Wrapper Exit Realizability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix review findings #3 (a short-paying underlying permanently bricks exits) and #4 (`max*` views ignore the underlying's own limits) as one design correction: exits realize what the source can actually pay, and every limit/preview view tells the truth about it.

**Architecture:** `redeem` becomes share-sourced and loss-tolerant — it burns the caller's shares, redeems the equivalent source position via a new `IYieldAdapter.withdrawUpTo` (delegatecall), and pays out actual proceeds (return value + `Withdraw` event carry actuals). `previewRedeem` mirrors that execution through a new realizable-value adapter view, so preview == execution even on a fee-charging source. `withdraw` (exact-out) stays strict — it keeps the `AdapterWithdrawShortfall` guard — but its `previewWithdraw` becomes cost-aware so a lossy source's exit fee is paid by the exiter, not silently socialized to remaining holders. All four `max*` views consult the source's own caps/liquidity through fail-soft adapter views (a reverting source view degrades to 0, never to an over-report). Deposit-side strictness (`AdapterDepositShortfall`, supply floor, `ZeroSharesMinted`) is unchanged; `totalAssets()` stays valuation-based (the exiter bears exit costs, not the remaining holders — documented asymmetry).

**Tech Stack:** Solidity `^0.8.29`, OZ v5 (`lib/openzeppelin-contracts-v5` via scoped remappings), Foundry, solmate mocks in tests.

**Branch / PR:** `fix/vault-wrapper-exit-realizability` → PR targets `fix/vault-wrapper-review-findings-2`. Commit each task separately.

**Versioning note:** The subsystem is unreleased (nothing deployed); all `@custom:version` tags stay `1.0.0` despite the interface change.

**Rules in scope:** `000-global-standards`, `002-architecture` (`[CONV:ARCH-VAULTWRAPPER]`), `099-finish`, `108-vault-wrapper` (`[CONV:VW-ADAPTERS]`, `[CONV:VW-OZ-VERSION]` — pragma `^0.8.29`, OZ v5 only, files stay under the scoped remapping paths).

---

## Setup before Task 1

The worktree may not have submodules initialized. From the repo checkout:

```bash
git submodule update --init lib/openzeppelin-contracts-v5 lib/openzeppelin-contracts-upgradeable lib/solmate lib/forge-std
forge build
```

Expected: clean build of the current branch state.

---

## File Structure

| File | Change |
|---|---|
| `src/VaultWrapper/interfaces/IYieldAdapter.sol` | Add 4 static views (`maxDeposit`, `maxWithdraw`, `previewWithdrawUpTo`, `previewWithdrawCost`) + 1 delegatecall method (`withdrawUpTo`) |
| `src/VaultWrapper/adapters/ERC4626Adapter.sol` | Implement the 5 new methods; fail-soft `_staticCallUint` helper |
| `src/VaultWrapper/LiFiVaultWrapper.sol` | Rewrite `redeem`/`previewRedeem`; cost-aware `previewWithdraw`; source-aware `maxDeposit`/`maxMint`/`maxWithdraw`/`maxRedeem`; NatSpec updates |
| `test/solidity/VaultWrapper/mocks/MockZeroAdapter.sol` | Stub the 5 new interface methods |
| `test/solidity/VaultWrapper/mocks/MockLossyERC4626.sol` | **New** — standard vault with exit fee (previews honest) |
| `test/solidity/VaultWrapper/mocks/MockShortPayingERC4626.sol` | **New** — non-standard vault that short-pays exits (previews lie) |
| `test/solidity/VaultWrapper/mocks/MockCappedERC4626.sol` | **New** — vault with deposit cap / liquidity cap / revert-toggled `max*` views |
| `test/solidity/VaultWrapper/adapters/ERC4626Adapter.t.sol` | Tests for the 5 new adapter methods (incl. delegatecall harness) |
| `test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol` | **New** — wrapper-level scenarios + conformance fuzz |
| `docs/VaultWrapper/ERC4626Adapter.md` | Rewrite Assumptions + Functions sections |
| `docs/VaultWrapper/LiFiVaultWrapper.md` | Exit semantics, limit views, valuation asymmetry |

Existing suites (`LiFiVaultWrapperFees.t.sol`, `LiFiVaultWrapperProtections.t.sol`, invariant suite, fork suite) are expected to keep passing; Task 6 reconciles any ≤1-wei rounding drift with justification.

---

## Design invariants (the contract the code must satisfy)

1. **Exits never brick on an honest source.** For any source that honestly implements ERC-4626 (even with exit fees or liquidity caps), `redeem(maxRedeem(owner))` succeeds.
2. **withdraw stays exact-out.** `withdraw(assets)` either delivers exactly `assets` to the receiver or reverts (`ERC4626ExceededMaxWithdraw` when beyond realizable limits, `AdapterWithdrawShortfall` when the source short-pays non-standardly).
3. **Previews match execution** in the same block for honest sources: `redeem` returns exactly `previewRedeem(shares)`; `withdraw` burns exactly `previewWithdraw(assets)`.
4. **No silent socialization.** An exiting user bears their own source-side exit cost. Other holders' `previewRedeem(balance)` is unchanged (±1 wei rounding dust) by someone else's exit.
5. **`max*` never over-reports.** `deposit(maxDeposit(r))`, `mint(maxMint(r))`, `withdraw(maxWithdraw(o))`, `redeem(maxRedeem(o))` never revert for honest sources. Under-reporting by rounding is acceptable (EIP-4626 compliant); over-reporting is a bug.
6. **A reverting source limit-view cannot break our views**: adapter `maxDeposit`/`maxWithdraw` degrade to 0 (fail-soft, conservative). Preview views bubble reverts (EIP-4626 allows preview reverts). Residual (documented, accepted): a source whose `previewWithdraw` itself reverts still blocks `redeem` — recovery is the beacon upgrade path.

---

### Task 1: `IYieldAdapter` v2 — interface, `ERC4626Adapter` implementation, mock stubs

**Files:**

- Modify: `src/VaultWrapper/interfaces/IYieldAdapter.sol`
- Modify: `src/VaultWrapper/adapters/ERC4626Adapter.sol`
- Modify: `test/solidity/VaultWrapper/mocks/MockZeroAdapter.sol`
- Modify: `test/solidity/VaultWrapper/mocks/MockERC4626Underlying.sol` (no change needed — resolveAsset-only mock; listed for awareness)
- Test: `test/solidity/VaultWrapper/adapters/ERC4626Adapter.t.sol`

- [ ] **Step 1: Write the failing tests** — append to `ERC4626AdapterTest` in `test/solidity/VaultWrapper/adapters/ERC4626Adapter.t.sol`. Replace the whole file with:

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { IYieldAdapter } from "lifi/VaultWrapper/interfaces/IYieldAdapter.sol";
import { MockERC4626Underlying } from "../mocks/MockERC4626Underlying.sol";
import { MockLossyERC4626 } from "../mocks/MockLossyERC4626.sol";
import { MockCappedERC4626 } from "../mocks/MockCappedERC4626.sol";

/// @dev Runs the adapter's delegatecall-only methods in its own storage context, the
///      way a wrapper would (the harness holds the source position).
contract AdapterCallHarness {
    function route(
        address _adapter,
        bytes memory _data
    ) external returns (uint256 result) {
        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, bytes memory ret) = _adapter.delegatecall(_data);
        require(ok, "ADAPTER_CALL_FAILED");
        result = abi.decode(ret, (uint256));
    }
}

contract ERC4626AdapterTest is Test {
    ERC4626Adapter internal adapter;
    MockERC20 internal token;
    MockERC4626 internal source;
    AdapterCallHarness internal harness;
    address internal assetToken = makeAddr("asset");
    address internal holder = makeAddr("holder");

    function setUp() public {
        adapter = new ERC4626Adapter();
        token = new MockERC20("Token", "TKN", 18);
        source = new MockERC4626(token, "Yield", "yTKN");
        harness = new AdapterCallHarness();
    }

    /// resolveAsset (existing behavior) ///

    function test_ResolveAssetReturnsAssetForValidVault() public {
        MockERC4626Underlying vault = new MockERC4626Underlying(assetToken);
        assertEq(adapter.resolveAsset(address(vault)), assetToken);
    }

    function test_ResolveAssetRevertsOnNoCode() public {
        vm.expectRevert(IYieldAdapter.AssetResolutionFailed.selector);
        adapter.resolveAsset(makeAddr("eoa"));
    }

    function test_ResolveAssetRevertsOnZeroAsset() public {
        MockERC4626Underlying vault = new MockERC4626Underlying(address(0));
        vm.expectRevert(IYieldAdapter.AssetResolutionFailed.selector);
        adapter.resolveAsset(address(vault));
    }

    /// max* passthrough ///

    function test_MaxDepositPassesThroughSourceCap() public {
        MockCappedERC4626 capped = new MockCappedERC4626(token);
        capped.setDepositCap(500e18);

        assertEq(adapter.maxDeposit(address(capped), holder), 500e18);
        assertEq(
            adapter.maxDeposit(address(source), holder),
            type(uint256).max
        );
    }

    function test_MaxWithdrawPassesThroughSourceLiquidity() public {
        MockCappedERC4626 capped = new MockCappedERC4626(token);
        _seed(address(capped), holder, 1_000e18);
        capped.setLiquidity(300e18);

        assertEq(adapter.maxWithdraw(address(capped), holder), 300e18);
    }

    function test_MaxViewsFallBackToZeroWhenSourceViewReverts() public {
        MockCappedERC4626 capped = new MockCappedERC4626(token);
        capped.setRevertOnLimitViews(true);

        assertEq(adapter.maxDeposit(address(capped), holder), 0);
        assertEq(adapter.maxWithdraw(address(capped), holder), 0);
    }

    /// previewWithdrawUpTo ///

    function test_PreviewWithdrawUpToMatchesRequestOnStandardSource() public {
        _seed(address(source), holder, 1_000e18);

        assertEq(
            adapter.previewWithdrawUpTo(address(source), holder, 400e18),
            400e18
        );
    }

    function test_PreviewWithdrawUpToCapsAtHolderPosition() public {
        _seed(address(source), holder, 100e18);

        // Requesting more than the position realizes only the position.
        assertEq(
            adapter.previewWithdrawUpTo(address(source), holder, 400e18),
            100e18
        );
    }

    function test_PreviewWithdrawUpToNetsSourceExitFee() public {
        // A lossy source grosses exact-out requests up itself, so a within-position
        // target still realizes in full; make the position smaller than the target
        // to force the whole-position haircut visible.
        MockLossyERC4626 small = new MockLossyERC4626(token, 100); // 1% exit fee
        _seed(address(small), holder, 100e18);
        uint256 realizable = adapter.previewWithdrawUpTo(
            address(small),
            holder,
            400e18
        );

        // Whole position redeemed, 1% fee carved out: 99e18.
        assertEq(realizable, 99e18);
    }

    /// previewWithdrawCost ///

    function test_PreviewWithdrawCostEqualsRequestOnStandardSource() public {
        _seed(address(source), holder, 1_000e18);

        assertEq(
            adapter.previewWithdrawCost(address(source), 400e18),
            400e18
        );
    }

    function test_PreviewWithdrawCostExceedsRequestOnLossySource() public {
        MockLossyERC4626 lossy = new MockLossyERC4626(token, 100); // 1% exit fee
        _seed(address(lossy), holder, 1_000e18);

        uint256 cost = adapter.previewWithdrawCost(address(lossy), 396e18);

        // Delivering 396e18 exact-out burns shares worth ~400e18 (1% fee grossed up).
        assertGt(cost, 396e18);
        assertApproxEqAbs(cost, 400e18, 2);
    }

    /// withdrawUpTo (delegatecall) ///

    function test_WithdrawUpToRealizesRequestOnStandardSource() public {
        _seed(address(source), address(harness), 1_000e18);

        uint256 withdrawn = harness.route(
            address(adapter),
            abi.encodeCall(
                IYieldAdapter.withdrawUpTo,
                (address(token), address(source), 400e18)
            )
        );

        assertEq(withdrawn, 400e18);
        assertEq(token.balanceOf(address(harness)), 400e18);
    }

    function test_WithdrawUpToCapsAtPositionInsteadOfReverting() public {
        _seed(address(source), address(harness), 100e18);

        uint256 withdrawn = harness.route(
            address(adapter),
            abi.encodeCall(
                IYieldAdapter.withdrawUpTo,
                (address(token), address(source), 400e18)
            )
        );

        assertEq(withdrawn, 100e18);
    }

    function test_WithdrawUpToReturnsActualProceedsFromLossySource() public {
        MockLossyERC4626 lossy = new MockLossyERC4626(token, 100); // 1% exit fee
        _seed(address(lossy), address(harness), 100e18);

        uint256 withdrawn = harness.route(
            address(adapter),
            abi.encodeCall(
                IYieldAdapter.withdrawUpTo,
                (address(token), address(lossy), 400e18)
            )
        );

        // Whole position, 1% source fee carved out.
        assertEq(withdrawn, 99e18);
        assertEq(token.balanceOf(address(harness)), 99e18);
    }

    /// Helpers ///

    function _seed(address _vault, address _receiver, uint256 _amount) internal {
        token.mint(address(this), _amount);
        token.approve(_vault, _amount);
        MockERC4626(_vault).deposit(_amount, _receiver);
    }
}
```

- [ ] **Step 2: Write the two new mocks the tests import.**

Create `test/solidity/VaultWrapper/mocks/MockLossyERC4626.sol`:

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ERC4626 } from "solmate/mixins/ERC4626.sol";

/// @notice STANDARD ERC-4626 vault with an exit fee: previews are honest (previewRedeem
///         nets the fee, previewWithdraw grosses shares up) and withdraw/redeem deliver
///         exactly what the previews promise. Fee assets stay in the vault. Models an
///         underlying that adds an exit fee after wrapper deployment.
contract MockLossyERC4626 is ERC4626 {
    uint256 internal constant BPS = 10_000;
    uint256 public immutable EXIT_FEE_BPS;

    constructor(
        ERC20 _asset,
        uint256 _exitFeeBps
    ) ERC4626(_asset, "Lossy Vault", "lossyTKN") {
        require(_exitFeeBps < BPS, "FEE_TOO_HIGH");
        EXIT_FEE_BPS = _exitFeeBps;
    }

    function totalAssets() public view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function previewRedeem(
        uint256 shares
    ) public view override returns (uint256 assets) {
        assets = super.previewRedeem(shares);
        assets -= (assets * EXIT_FEE_BPS) / BPS;
    }

    function previewWithdraw(
        uint256 assets
    ) public view override returns (uint256) {
        // Gross the exact-out request up so the net-of-fee payout equals `assets`.
        uint256 gross = (assets * BPS + (BPS - EXIT_FEE_BPS) - 1) /
            (BPS - EXIT_FEE_BPS);
        return super.previewWithdraw(gross);
    }

    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        return previewRedeem(balanceOf[owner]);
    }
}
```

Create `test/solidity/VaultWrapper/mocks/MockCappedERC4626.sol`:

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ERC4626 } from "solmate/mixins/ERC4626.sol";

/// @notice ERC-4626 vault with a deposit cap and a withdrawal-liquidity cap, both
///         reported by its max* views and enforced on execution; the views can also be
///         toggled to revert, exercising the adapter's fail-soft fallback.
contract MockCappedERC4626 is ERC4626 {
    uint256 public depositCap = type(uint256).max;
    uint256 public liquidity = type(uint256).max;
    bool public revertOnLimitViews;

    error LimitViewsDisabled();

    constructor(ERC20 _asset) ERC4626(_asset, "Capped Vault", "capTKN") {}

    function totalAssets() public view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function setDepositCap(uint256 _cap) external {
        depositCap = _cap;
    }

    function setLiquidity(uint256 _liquidity) external {
        liquidity = _liquidity;
    }

    function setRevertOnLimitViews(bool _revert) external {
        revertOnLimitViews = _revert;
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (revertOnLimitViews) revert LimitViewsDisabled();
        return depositCap;
    }

    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        if (revertOnLimitViews) revert LimitViewsDisabled();
        uint256 owned = convertToAssets(balanceOf[owner]);
        return owned < liquidity ? owned : liquidity;
    }

    function beforeWithdraw(uint256 assets, uint256) internal view override {
        require(assets <= liquidity, "INSUFFICIENT_LIQUIDITY");
    }

    function afterDeposit(uint256 assets, uint256) internal view override {
        require(assets <= depositCap, "DEPOSIT_CAP");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail to compile** (interface methods missing):

```bash
forge test --match-path "test/solidity/VaultWrapper/adapters/ERC4626Adapter.t.sol" -vv
```

Expected: compile error — `previewWithdrawUpTo`/`withdrawUpTo`/`maxDeposit` etc. are not members of the adapter/interface.

- [ ] **Step 4: Extend `src/VaultWrapper/interfaces/IYieldAdapter.sol`.** Append the following functions before the closing brace (keep existing content and NatSpec; extend the contract-level `@dev` call-mode note to cover the new members — `maxDeposit`/`maxWithdraw`/`previewWithdrawUpTo`/`previewWithdrawCost` join the ordinary-static-call class, `withdrawUpTo` joins the delegatecall class):

```solidity
    /// @notice Max assets the yield source currently accepts from `_holder` on a deposit.
    /// @dev Ordinary static call. MUST be fail-soft: if the source's own limit view
    ///      reverts or is malformed, return 0 (conservatively closed) rather than
    ///      reverting or over-reporting — the wrapper's EIP-4626 `max*` views must
    ///      never revert because of the source.
    /// @param _underlying The protocol-specific yield source identifier.
    /// @param _holder The depositing account (the wrapper).
    /// @return maxAssets The max assets the source accepts; 0 when unknown.
    function maxDeposit(
        address _underlying,
        address _holder
    ) external view returns (uint256 maxAssets);

    /// @notice Max assets `_holder` can currently pull out of the yield source
    ///         (position and source-side liquidity combined).
    /// @dev Ordinary static call. Fail-soft like `maxDeposit`: 0 when unknown.
    /// @param _underlying The protocol-specific yield source identifier.
    /// @param _holder The account whose position is exited (the wrapper).
    /// @return maxAssets The max assets realizable; 0 when unknown.
    function maxWithdraw(
        address _underlying,
        address _holder
    ) external view returns (uint256 maxAssets);

    /// @notice Assets actually receivable if `_holder` tried to realize `_assets`
    ///         from the yield source right now, capped at `_holder`'s position.
    /// @dev Ordinary static call; the static mirror of `withdrawUpTo`, and MUST use
    ///      the same share math so previews match execution. Per EIP-4626 preview
    ///      semantics it does NOT cap at source-side liquidity limits (only at the
    ///      position); it MAY revert if the source's preview reverts.
    /// @param _underlying The protocol-specific yield source identifier.
    /// @param _holder The account whose position is valued (the wrapper).
    /// @param _assets The realization target, in assets.
    /// @return assets The assets the source would actually pay out.
    function previewWithdrawUpTo(
        address _underlying,
        address _holder,
        uint256 _assets
    ) external view returns (uint256 assets);

    /// @notice Position value consumed to deliver exactly `_assets` out of the yield
    ///         source (>= `_assets` when the source charges exit fees).
    /// @dev Ordinary static call, used by the wrapper's exact-out `previewWithdraw` so
    ///      the exiting user's shares — not the remaining holders — pay the source's
    ///      exit cost. Rounds up (conservative for the vault). MAY revert if the
    ///      source's preview reverts.
    /// @param _underlying The protocol-specific yield source identifier.
    /// @param _assets The exact assets to be delivered.
    /// @return cost The position value consumed, in assets.
    function previewWithdrawCost(
        address _underlying,
        uint256 _assets
    ) external view returns (uint256 cost);

    /// @notice Realizes up to `_assets` of `_asset` from `_underlying` into the wrapper,
    ///         paying out whatever the source can actually deliver instead of reverting
    ///         on a shortfall.
    /// @dev DELEGATECALL ONLY — runs in the wrapper's context (see `withdraw`). Redeems
    ///      the source shares nominally worth `_assets`, capped at the wrapper's whole
    ///      position, and reports the measured balance delta. MUST NOT touch adapter
    ///      storage. This is the loss-tolerant exit primitive backing the wrapper's
    ///      `redeem`; the strict exact-out primitive remains `withdraw`.
    /// @param _asset The ERC20 asset to receive (lands on the wrapper).
    /// @param _underlying The yield source to realize from.
    /// @param _assets The realization target, in assets.
    /// @return withdrawn The amount of `_asset` actually returned to the wrapper.
    function withdrawUpTo(
        address _asset,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 withdrawn);
```

- [ ] **Step 5: Implement in `src/VaultWrapper/adapters/ERC4626Adapter.sol`.** Add after the existing `withdraw` function (and update the contract-level `@dev` note: the "standard ERC-4626" assumption now applies to the strict `deposit`/`withdraw` pair only; the `*UpTo` pair and the fail-soft limit views are the degraded-mode surface):

```solidity
    /// @inheritdoc IYieldAdapter
    function maxDeposit(
        address _underlying,
        address _holder
    ) external view returns (uint256 maxAssets) {
        (bool ok, uint256 value) = _staticCallUint(
            _underlying,
            abi.encodeCall(IERC4626.maxDeposit, (_holder))
        );
        return ok ? value : 0;
    }

    /// @inheritdoc IYieldAdapter
    function maxWithdraw(
        address _underlying,
        address _holder
    ) external view returns (uint256 maxAssets) {
        (bool ok, uint256 value) = _staticCallUint(
            _underlying,
            abi.encodeCall(IERC4626.maxWithdraw, (_holder))
        );
        return ok ? value : 0;
    }

    /// @inheritdoc IYieldAdapter
    function previewWithdrawUpTo(
        address _underlying,
        address _holder,
        uint256 _assets
    ) external view returns (uint256 assets) {
        IERC4626 source = IERC4626(_underlying);
        uint256 shares = source.previewWithdraw(_assets);
        uint256 held = source.balanceOf(_holder);
        if (shares > held) shares = held;
        if (shares == 0) return 0;

        return source.previewRedeem(shares);
    }

    /// @inheritdoc IYieldAdapter
    function previewWithdrawCost(
        address _underlying,
        uint256 _assets
    ) external view returns (uint256 cost) {
        IERC4626 source = IERC4626(_underlying);

        // previewMint values the burned shares rounding UP, the conservative
        // direction for the wrapper (the exiter's cost is never understated).
        return source.previewMint(source.previewWithdraw(_assets));
    }

    /// @inheritdoc IYieldAdapter
    function withdrawUpTo(
        address _asset,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 withdrawn) {
        IERC4626 source = IERC4626(_underlying);
        uint256 shares = source.previewWithdraw(_assets);
        uint256 held = source.balanceOf(address(this));
        if (shares > held) shares = held;
        if (shares == 0) return 0;

        uint256 balanceBefore = IERC20(_asset).balanceOf(address(this));
        source.redeem({
            shares: shares,
            receiver: address(this),
            owner: address(this)
        });
        withdrawn = IERC20(_asset).balanceOf(address(this)) - balanceBefore;
    }

    /// @dev Fail-soft staticcall returning a uint256: `ok = false` on revert, missing
    ///      code, or malformed return data, so limit views can degrade to 0 instead of
    ///      bubbling a source failure into the wrapper's EIP-4626 `max*` views.
    function _staticCallUint(
        address _target,
        bytes memory _callData
    ) private view returns (bool ok, uint256 value) {
        (bool success, bytes memory ret) = _target.staticcall(_callData);
        if (!success || ret.length < 32) return (false, 0);

        return (true, abi.decode(ret, (uint256)));
    }
```

- [ ] **Step 6: Stub the new methods in `test/solidity/VaultWrapper/mocks/MockZeroAdapter.sol`** (append inside the contract):

```solidity
    function maxDeposit(address, address) external pure returns (uint256) {
        return 0;
    }

    function maxWithdraw(address, address) external pure returns (uint256) {
        return 0;
    }

    function previewWithdrawUpTo(
        address,
        address,
        uint256
    ) external pure returns (uint256) {
        return 0;
    }

    function previewWithdrawCost(
        address,
        uint256
    ) external pure returns (uint256) {
        return 0;
    }

    function withdrawUpTo(
        address,
        address,
        uint256
    ) external pure returns (uint256) {
        return 0;
    }
```

- [ ] **Step 7: Run the adapter tests, verify all pass:**

```bash
forge test --match-path "test/solidity/VaultWrapper/adapters/ERC4626Adapter.t.sol" -vv
```

Expected: PASS (all tests). Also `forge build` compiles the whole tree (the wrapper itself is untouched so far).

- [ ] **Step 8: Lint and commit:**

```bash
bunx solhint src/VaultWrapper/interfaces/IYieldAdapter.sol src/VaultWrapper/adapters/ERC4626Adapter.sol "test/solidity/VaultWrapper/mocks/Mock*.sol"
git add src/VaultWrapper/interfaces/IYieldAdapter.sol src/VaultWrapper/adapters/ERC4626Adapter.sol test/solidity/VaultWrapper/mocks/ test/solidity/VaultWrapper/adapters/ERC4626Adapter.t.sol
git commit -m "feat(VaultWrapper): add realizable-exit and limit views to IYieldAdapter"
```

---

### Task 2: Deposit-side limits — `maxDeposit`/`maxMint` consult the source cap

**Files:**

- Modify: `src/VaultWrapper/LiFiVaultWrapper.sol` (the `maxDeposit`/`maxMint` overrides)
- Test: `test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol` (new file, deposit-limit section)

- [ ] **Step 1: Create the new test file with the deposit-limit tests:**

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { FeeConfig, FeeType } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFeeTestBase } from "test/solidity/VaultWrapper/VaultWrapperFeeTestBase.sol";
import { MockCappedERC4626 } from "test/solidity/VaultWrapper/mocks/MockCappedERC4626.sol";
import { MockLossyERC4626 } from "test/solidity/VaultWrapper/mocks/MockLossyERC4626.sol";

/// @notice Exit realizability and source-limit awareness (review findings #3/#4):
///         loss-tolerant redeem, cost-aware exact-out withdraw, and max*/preview views
///         that consult the underlying's own caps, liquidity, and realizable values.
contract LiFiVaultWrapperExitRealizabilityTest is VaultWrapperFeeTestBase {
    uint16 internal constant DEPOSIT_FEE = 100; // 1%
    uint16 internal constant WITHDRAW_FEE = 50; // 0.5%

    MockCappedERC4626 internal capped;

    function setUp() public override {
        super.setUp();
        FeeConfig memory fees;
        wrapper = _newWrapper(fees);
        capped = new MockCappedERC4626(asset);
    }

    /// Deposit-side limits (finding #4) ///

    function test_MaxDepositReflectsSourceCap() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(500e18);

        assertEq(w.maxDeposit(alice), 500e18);
    }

    function test_MaxDepositGrossesUpForDepositFee() public {
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Deposit)] = DEPOSIT_FEE;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(500e18);

        uint256 max = w.maxDeposit(alice);

        // The fee is skimmed before forwarding, so the user-facing max is the cap
        // grossed up by the deposit fee — and depositing it must succeed.
        assertGt(max, 500e18);
        asset.mint(alice, max);
        vm.startPrank(alice);
        asset.approve(address(w), max);
        w.deposit(max, alice);
        vm.stopPrank();
    }

    function test_MaxDepositUnlimitedWhenSourceUncapped() public {
        assertEq(wrapper.maxDeposit(alice), type(uint256).max);
    }

    function test_MaxDepositZeroWhenSourceLimitViewReverts() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setRevertOnLimitViews(true);

        assertEq(w.maxDeposit(alice), 0);
        assertEq(w.maxMint(alice), 0);
    }

    function test_MaxMintConvertsCappedMaxDeposit() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(500e18);

        uint256 maxShares = w.maxMint(alice);

        assertEq(maxShares, w.previewDeposit(w.maxDeposit(alice)));
        // Minting the advertised max must succeed.
        uint256 assetsNeeded = w.previewMint(maxShares);
        asset.mint(alice, assetsNeeded);
        vm.startPrank(alice);
        asset.approve(address(w), assetsNeeded);
        w.mint(maxShares, alice);
        vm.stopPrank();
    }

    function test_MaxMintUnlimitedWhenSourceUncapped() public {
        assertEq(wrapper.maxMint(alice), type(uint256).max);
    }

    function test_MaxDepositStillZeroWhenPaused() public {
        vm.prank(vaultAdmin);
        wrapper.pause();

        assertEq(wrapper.maxDeposit(alice), 0);
        assertEq(wrapper.maxMint(alice), 0);
    }
}
```

- [ ] **Step 2: Run to verify the new deposit-limit tests fail:**

```bash
forge test --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol" -vv
```

Expected: FAIL — `test_MaxDepositReflectsSourceCap` and the fee/gross-up tests fail (current `maxDeposit` returns `type(uint256).max` regardless of the cap); the pause test passes (existing behavior).

- [ ] **Step 3: Implement in `src/VaultWrapper/LiFiVaultWrapper.sol`.** Replace the bodies of `maxDeposit` and `maxMint` (keep the pause/gate NatSpec, extend it with the source-cap sentence):

```solidity
    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while any pause source is engaged, or while the access gate rejects
    ///      the receiver, so EIP-4626 consumers see the vault as closed to deposits and do
    ///      not build deposits that would revert. Mirrors `deposit`'s guards; a reverting
    ///      gate reverts this view too (fail-closed, like the entrypoint). Otherwise
    ///      reports the source's own acceptance cap (via the adapter, fail-soft to 0)
    ///      grossed up by the deposit fee — the max a caller can actually push through
    ///      `deposit` without the source rejecting the forward.
    function maxDeposit(
        address receiver
    ) public view override returns (uint256) {
        if (depositsPaused() || !_depositAllowed(receiver)) return 0;

        uint256 cap = IYieldAdapter(adapter).maxDeposit(
            underlying,
            address(this)
        );
        if (cap == type(uint256).max) return cap;

        uint256 fee = LibVaultWrapperMath.feeOnRaw(
            cap,
            _rate(FeeType.Deposit)
        );
        unchecked {
            uint256 gross = cap + fee;
            return gross < cap ? type(uint256).max : gross;
        }
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while any pause source is engaged, or while the access gate rejects
    ///      the receiver (see `maxDeposit`). Otherwise converts the asset-side max into
    ///      shares via `previewDeposit`, preserving the unlimited sentinel.
    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        if (assets == 0) return 0;
        if (assets == type(uint256).max) return type(uint256).max;

        return previewDeposit(assets);
    }
```

- [ ] **Step 4: Run the tests, verify they pass:**

```bash
forge test --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol" -vv
```

Expected: PASS.

- [ ] **Step 5: Run the neighboring suites to catch regressions** (pause suite asserts `maxDeposit == 0` under pause; protections/fees use uncapped solmate mock, `maxDeposit` must still report unlimited):

```bash
forge test --match-path "test/solidity/VaultWrapper/*.t.sol" -q
```

Expected: PASS (no behavioral change for uncapped sources).

- [ ] **Step 6: Lint and commit:**

```bash
bunx solhint src/VaultWrapper/LiFiVaultWrapper.sol test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol
git add src/VaultWrapper/LiFiVaultWrapper.sol test/solidity/VaultWrapper/
git commit -m "fix(VaultWrapper): maxDeposit/maxMint consult the underlying's own cap"
```

---

### Task 3: Loss-tolerant, share-sourced `redeem` + realizable `previewRedeem` (finding #3)

**Files:**

- Modify: `src/VaultWrapper/LiFiVaultWrapper.sol` (`redeem`, `previewRedeem`, new `_redeemRealizable`; NatSpec on `_transferOut`)
- Create: `test/solidity/VaultWrapper/mocks/MockShortPayingERC4626.sol`
- Test: `test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol` (redeem section)

- [ ] **Step 1a: Create `test/solidity/VaultWrapper/mocks/MockShortPayingERC4626.sol`:**

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ERC4626 } from "solmate/mixins/ERC4626.sol";

/// @notice NON-STANDARD ERC-4626 vault: previews promise the full amount but every
///         exit delivers `SHORTFALL` wei less (e.g. a fee-on-transfer asset or a
///         misbehaving source). Exercises the wrapper's strict exact-out guard and
///         the loss-tolerant redeem pass-through.
contract MockShortPayingERC4626 is ERC4626 {
    uint256 public constant SHORTFALL = 1;

    constructor(
        ERC20 _asset
    ) ERC4626(_asset, "ShortPaying Vault", "shortTKN") {}

    function totalAssets() public view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override returns (uint256 shares) {
        shares = previewWithdraw(assets);
        _useAllowance(owner, shares);
        _burn(owner, shares);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
        _shortPay(receiver, assets);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override returns (uint256 assets) {
        assets = previewRedeem(shares);
        require(assets != 0, "ZERO_ASSETS");
        _useAllowance(owner, shares);
        _burn(owner, shares);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
        _shortPay(receiver, assets);
    }

    function _useAllowance(address owner, uint256 shares) private {
        if (msg.sender == owner) return;
        uint256 allowed = allowance[owner][msg.sender];
        if (allowed != type(uint256).max)
            allowance[owner][msg.sender] = allowed - shares;
    }

    function _shortPay(address receiver, uint256 assets) private {
        uint256 paid = assets > SHORTFALL ? assets - SHORTFALL : 0;
        require(asset.transfer(receiver, paid), "TRANSFER_FAILED");
    }
}
```

- [ ] **Step 1b: Append the failing tests** to `LiFiVaultWrapperExitRealizabilityTest`:

```solidity
    /// Loss-tolerant redeem (finding #3) ///

    function test_RedeemSurvivesSourceTurningLossy() public {
        // The bricking scenario from the finding: the underlying adds an exit fee
        // AFTER deposits are in. Old behavior: AdapterWithdrawShortfall forever.
        FeeConfig memory fees;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100); // 1% exit fee
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 shares = w.balanceOf(alice);
        uint256 quoted = w.previewRedeem(shares);

        vm.prank(alice);
        uint256 paid = w.redeem(shares, alice, alice);

        // The haircut lands on the exiting user, exits keep working, and the
        // preview told the truth about it.
        assertEq(paid, quoted);
        assertEq(asset.balanceOf(alice), paid);
        assertApproxEqAbs(paid, (DEPOSIT * 99) / 100, 2);
    }

    function test_RedeemPassesShortfallThroughOnShortPayingSource() public {
        FeeConfig memory fees;
        MockShortPayingERC4626 short = new MockShortPayingERC4626(asset);
        LiFiVaultWrapper w = _newWrapperFor(
            address(short),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 shares = w.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = w.redeem(shares, alice, alice);

        // Previews cannot see a lying source, but the exit still works and only
        // the exiter absorbs the withheld wei.
        assertEq(paid, DEPOSIT - short.SHORTFALL());
        assertEq(asset.balanceOf(alice), paid);
    }

    function test_RedeemSlippageOverloadGuardsLossyProceeds() public {
        FeeConfig memory fees;
        MockShortPayingERC4626 short = new MockShortPayingERC4626(asset);
        LiFiVaultWrapper w = _newWrapperFor(
            address(short),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 shares = w.balanceOf(alice);
        uint256 quoted = w.previewRedeem(shares); // over-promises by SHORTFALL

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SlippageExceeded.selector,
                quoted - short.SHORTFALL(),
                quoted
            )
        );

        w.redeem(shares, alice, alice, quoted);
    }

    function test_RedeemReturnValueAndEventCarryActualProceeds() public {
        _deposit(alice, DEPOSIT);
        uint256 shares = wrapper.balanceOf(alice);
        uint256 quoted = wrapper.previewRedeem(shares);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(wrapper));
        emit Withdraw(alice, alice, alice, quoted, shares);
        uint256 paid = wrapper.redeem(shares, alice, alice);

        assertEq(paid, quoted);
    }

    function test_RedeemChargesWithdrawalFeeOnActualProceeds() public {
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = WITHDRAW_FEE;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        wrapper = w; // point the base-class fee counters helper at this instance

        uint256 shares = w.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = w.redeem(shares, alice, alice);

        // Fee basis is what the source actually paid, not the pre-loss valuation:
        // fee + payout == actual proceeds, and the fee is feeOnTotal(actual).
        uint256 actual = paid + _accruedFeeAssets();
        assertApproxEqAbs(actual, (DEPOSIT * 99) / 100, 2);
        assertEq(asset.balanceOf(address(w)), _accruedFeeAssets());
    }

    function test_RedeemAllowanceStillEnforced() public {
        _deposit(alice, DEPOSIT);
        uint256 shares = wrapper.balanceOf(alice);

        vm.prank(bob);
        vm.expectRevert(); // ERC20InsufficientAllowance
        wrapper.redeem(shares, bob, alice);

        vm.prank(alice);
        wrapper.approve(bob, shares);

        vm.prank(bob);
        uint256 paid = wrapper.redeem(shares, bob, alice);

        assertEq(asset.balanceOf(bob), paid);
        assertEq(wrapper.balanceOf(alice), 0);
    }

    /// Helpers ///

    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

    function _depositTo(
        LiFiVaultWrapper _w,
        address _from,
        uint256 _amount
    ) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(_w), _amount);
        _w.deposit(_amount, _from);
        vm.stopPrank();
    }
```

Add the missing imports at the top of the test file:

```solidity
import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { MockShortPayingERC4626 } from "test/solidity/VaultWrapper/mocks/MockShortPayingERC4626.sol";
```

- [ ] **Step 2: Run to verify the redeem tests fail:**

```bash
forge test --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol" -vv
```

Expected: FAIL — `test_RedeemSurvivesSourceTurningLossy` and `test_RedeemPassesShortfallThroughOnShortPayingSource` revert `AdapterWithdrawShortfall`.

- [ ] **Step 3: Rewrite `redeem` and `previewRedeem` in `src/VaultWrapper/LiFiVaultWrapper.sol`.**

Replace the existing `redeem(uint256,address,address)` override with:

```solidity
    /// @inheritdoc ERC4626Upgradeable
    /// @dev Share-sourced and loss-tolerant (exact-in): burns the shares, realizes their
    ///      valuation from the yield source via the adapter's `withdrawUpTo`, and pays out
    ///      whatever the source actually delivered (net of the withdrawal fee, which is
    ///      charged on actual proceeds). A source that pays under valuation — an exit fee
    ///      added after deployment, a fee-on-transfer asset — reduces THIS caller's payout
    ///      instead of bricking every exit; `previewRedeem` mirrors the same realizable
    ///      math so honest sources still preview exactly, and the EIP-5143 overload
    ///      bounds the damage from a lying one. The exact-out counterpart `withdraw`
    ///      stays strict (`AdapterWithdrawShortfall`). Return value and `Withdraw` event
    ///      carry actual proceeds. Deliberately NOT floor-checked (see
    ///      `_enforceSupplyFloor` for why exits are exempt): an exit must always be able
    ///      to empty the caller's position.
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256) {
        _checkExitAccess(owner, receiver);
        _accrueFees();

        uint256 maxShares = maxRedeem(owner);
        if (shares > maxShares)
            revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);

        return _redeemRealizable(_msgSender(), receiver, owner, shares);
    }
```

Add the private workflow right below (mirrors OZ's `_withdraw` allowance/burn/event sequence, with the tolerant transfer-out in place of `_transferOut`):

```solidity
    /// @dev Redeem workflow: OZ's `_withdraw` sequence (allowance spend, burn, event)
    ///      with a loss-tolerant realization instead of the strict `_transferOut`. The
    ///      share valuation is computed BEFORE the burn (the burn changes the supply the
    ///      valuation divides by), post-accrual so pending fee-shares are already minted.
    ///      The withdrawal fee is charged on ACTUAL proceeds via `feeOnTotal`, so fee and
    ///      payout always sum to what the source paid — nothing strands unattributed, and
    ///      a shortfall shrinks fee and payout together. A zero-valuation dust redeem
    ///      skips the adapter round-trip entirely (mirroring `_transferOut`'s zero
    ///      short-circuit), so sources that reject zero-share redemptions cannot block it.
    function _redeemRealizable(
        address _caller,
        address _receiver,
        address _owner,
        uint256 _shares
    ) private returns (uint256 assets) {
        uint256 gross = _convertToAssets(_shares, Math.Rounding.Floor);
        if (_caller != _owner) _spendAllowance(_owner, _caller, _shares);
        _burn(_owner, _shares);

        if (gross != 0) {
            uint256 withdrawn = _routeThroughAdapter(
                abi.encodeCall(
                    IYieldAdapter.withdrawUpTo,
                    (asset(), underlying, gross)
                )
            );
            uint256 fee = LibVaultWrapperMath.feeOnTotal(
                withdrawn,
                _rate(FeeType.Withdrawal)
            );
            _routeFee(FeeType.Withdrawal, fee);
            assets = withdrawn - fee;
            if (assets != 0) {
                SafeERC20.safeTransfer(IERC20(asset()), _receiver, assets);
            }
        }

        emit Withdraw(_caller, _receiver, _owner, assets, _shares);
    }
```

Replace the existing `previewRedeem` override with:

```solidity
    /// @inheritdoc ERC4626Upgradeable
    /// @dev Realizable-value preview: mirrors `redeem`'s execution exactly — the shares'
    ///      valuation is pushed through the adapter's static `previewWithdrawUpTo` (the
    ///      same source math `withdrawUpTo` executes), then the withdrawal fee is carved
    ///      out of the realizable amount. On a standard source this equals the plain
    ///      valuation-based preview; on a fee-charging source it truthfully quotes the
    ///      caller's post-haircut proceeds, keeping preview == execution.
    function previewRedeem(
        uint256 shares
    ) public view override returns (uint256) {
        uint256 gross = _convertToAssets(shares, Math.Rounding.Floor);
        if (gross == 0) return 0;

        uint256 realizable = IYieldAdapter(adapter).previewWithdrawUpTo(
            underlying,
            address(this),
            gross
        );

        return
            realizable -
            LibVaultWrapperMath.feeOnTotal(
                realizable,
                _rate(FeeType.Withdrawal)
            );
    }
```

Update `_transferOut`'s NatSpec first sentence to scope it to the exact-out path only (it no longer serves `redeem`): change "OZ's `_withdraw` keeps ownership of the allowance spend, share burn, and `Withdraw` event; this overrides only its `_transferOut` seam..." to note "Serves the exact-out `withdraw` path only — `redeem` exits through `_redeemRealizable`."

- [ ] **Step 4: Run the new suite and the immediately affected suites:**

```bash
forge test --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol" -vv
forge test --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperProtections.t.sol" --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperFees.t.sol" --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperPerformanceFee.t.sol" -q
```

Expected: new suite PASSES. Existing suites: expect exact parity on the standard mock (`feeOnTotal(gross)` and the old `feeOnRaw(net)` are designed as exact inverses). If any assertion drifts, it must be ≤1 wei and rounding-direction-justified — investigate each one before adjusting the expectation, and say why in the commit message.

- [ ] **Step 5: Lint and commit:**

```bash
bunx solhint src/VaultWrapper/LiFiVaultWrapper.sol test/solidity/VaultWrapper/mocks/MockShortPayingERC4626.sol
git add src/VaultWrapper/LiFiVaultWrapper.sol test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol test/solidity/VaultWrapper/mocks/MockShortPayingERC4626.sol
git commit -m "fix(VaultWrapper): share-sourced loss-tolerant redeem with realizable previews"
```

---

### Task 4: Cost-aware `previewWithdraw` + liquidity-aware `maxWithdraw`/`maxRedeem` (finding #4 exit side)

**Files:**

- Modify: `src/VaultWrapper/LiFiVaultWrapper.sol` (`previewWithdraw`, `maxWithdraw`, `maxRedeem`)
- Test: `test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol` (exact-out section)

- [ ] **Step 1: Append the failing tests:**

```solidity
    /// Cost-aware exact-out withdraw (no socialization) ///

    function test_WithdrawDoesNotSocializeSourceExitFee() public {
        FeeConfig memory fees;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100); // 1% exit fee
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        _depositTo(w, bob, DEPOSIT);

        uint256 bobQuoteBefore = w.previewRedeem(w.balanceOf(bob));
        uint256 half = DEPOSIT / 2;

        vm.prank(alice);
        uint256 burned = w.withdraw(half, alice, alice);

        // Alice received exactly `half`, and her shares — not Bob's value — paid the
        // source's 1% exit fee: her burn is ~1% more than the no-fee burn would be.
        assertEq(asset.balanceOf(alice), half);
        assertGt(burned, w.previewDeposit(half));
        // Bob's redeemable value is untouched (±1 wei rounding dust).
        assertApproxEqAbs(
            w.previewRedeem(w.balanceOf(bob)),
            bobQuoteBefore,
            1
        );
    }

    function test_WithdrawStaysStrictOnShortPayingSource() public {
        FeeConfig memory fees;
        MockShortPayingERC4626 short = new MockShortPayingERC4626(asset);
        LiFiVaultWrapper w = _newWrapperFor(
            address(short),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 half = DEPOSIT / 2;

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.AdapterWithdrawShortfall.selector,
                half,
                half - short.SHORTFALL()
            )
        );

        w.withdraw(half, alice, alice);
    }

    /// Liquidity-aware exit limits ///

    function test_MaxWithdrawReflectsSourceLiquidity() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        capped.setLiquidity(100e18);

        uint256 max = w.maxWithdraw(alice);

        assertLe(max, 100e18);
        vm.prank(alice);
        w.withdraw(max, alice, alice); // must not revert

        // And one wei above the advertised max must revert (over-report check).
        vm.prank(alice);
        vm.expectRevert();
        w.withdraw(max + 1, alice, alice);
    }

    function test_MaxRedeemReflectsSourceLiquidity() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        capped.setLiquidity(100e18);

        uint256 maxShares = w.maxRedeem(alice);

        assertLt(maxShares, w.balanceOf(alice));
        vm.prank(alice);
        w.redeem(maxShares, alice, alice); // must not revert
    }

    function test_MaxExitViewsUnchangedOnUncappedSource() public {
        _deposit(alice, DEPOSIT);

        assertEq(wrapper.maxRedeem(alice), wrapper.balanceOf(alice));
        assertEq(
            wrapper.maxWithdraw(alice),
            wrapper.previewRedeem(wrapper.balanceOf(alice))
        );
    }

    function test_MaxExitViewsZeroWhenSourceLimitViewReverts() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        capped.setRevertOnLimitViews(true);

        // Fail-soft: liquidity reads as 0, so exits report closed instead of the
        // views reverting (conservative, EIP-4626 max* MUST NOT revert).
        assertEq(w.maxWithdraw(alice), 0);
        assertEq(w.maxRedeem(alice), 0);
    }
```

- [ ] **Step 2: Run to verify they fail:**

```bash
forge test --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol" -vv
```

Expected: FAIL — socialization test (Bob's quote drops), liquidity tests (`maxWithdraw` over-reports, `withdraw(max)` reverts inside the source).

- [ ] **Step 3: Implement in `src/VaultWrapper/LiFiVaultWrapper.sol`.**

Replace `previewWithdraw`:

```solidity
    /// @inheritdoc ERC4626Upgradeable
    /// @dev Cost-aware exact-out preview: the shares to burn are priced off the position
    ///      value the source will actually consume to deliver `assets` plus the
    ///      withdrawal fee (adapter `previewWithdrawCost`, >= the owed amount when the
    ///      source charges exit fees), not off the owed amount alone. The exiting caller
    ///      therefore pays their own source-side exit cost; with the old owed-based
    ///      preview that cost silently diluted the remaining holders. Equals the old
    ///      preview exactly on a standard source (cost == owed).
    function previewWithdraw(
        uint256 assets
    ) public view override returns (uint256) {
        uint256 owed = assets +
            LibVaultWrapperMath.feeOnRaw(assets, _rate(FeeType.Withdrawal));
        uint256 cost = IYieldAdapter(adapter).previewWithdrawCost(
            underlying,
            owed
        );

        return _convertToShares(cost, Math.Rounding.Ceil);
    }
```

Replace `maxWithdraw` and `maxRedeem`:

```solidity
    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while the access gate flags the owner as sanctioned, mirroring
    ///      `withdraw`'s exit freeze (the asset receiver is unknowable in this view and
    ///      is checked in the entrypoint only). Otherwise the binding limit is the
    ///      smaller of what the owner's shares realize (`previewRedeem`, realizable- and
    ///      fee-aware) and what the source's liquidity allows net of the withdrawal fee
    ///      (adapter `maxWithdraw`, fail-soft to 0 — a broken source view reads as
    ///      closed, never as unlimited).
    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        if (_sanctioned(owner)) return 0;

        uint256 fromBalance = previewRedeem(balanceOf(owner));
        uint256 liquidity = IYieldAdapter(adapter).maxWithdraw(
            underlying,
            address(this)
        );
        uint256 fromLiquidity = liquidity -
            LibVaultWrapperMath.feeOnTotal(
                liquidity,
                _rate(FeeType.Withdrawal)
            );

        return fromBalance < fromLiquidity ? fromBalance : fromLiquidity;
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while the access gate flags the owner as sanctioned (see
    ///      `maxWithdraw`). Otherwise caps the owner's share balance by the source's
    ///      realizable liquidity converted to shares — a redeem beyond that would burn
    ///      shares the source cannot pay for. When the source's liquidity covers the
    ///      whole position the cap cannot bind and the balance is returned untouched
    ///      (also avoiding conversion overflow on unlimited-liquidity sentinels).
    function maxRedeem(address owner) public view override returns (uint256) {
        if (_sanctioned(owner)) return 0;

        uint256 balance = balanceOf(owner);
        uint256 liquidity = IYieldAdapter(adapter).maxWithdraw(
            underlying,
            address(this)
        );
        if (liquidity >= totalAssets()) return balance;

        uint256 fromLiquidity = _convertToShares(
            liquidity,
            Math.Rounding.Floor
        );

        return balance < fromLiquidity ? balance : fromLiquidity;
    }
```

- [ ] **Step 4: Run the suite; handle the round-trip wei edge if it appears.**

```bash
forge test --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol" -vv
```

If `withdraw(maxWithdraw(owner))` reverts by one share-scale wei (the `previewWithdraw(previewRedeem(balance))` round-trip landing at `balance + ε`), tighten `fromBalance` conservatively inside `maxWithdraw`:

```solidity
        if (
            fromBalance != 0 &&
            previewWithdraw(fromBalance) > balanceOf(owner)
        ) fromBalance -= 1;
```

(1 asset-wei ≈ `10 ** offset` shares, so a single decrement clears any 1-share overshoot. Only add this if the fuzz/unit tests demonstrate the need — don't pre-add dead code.)

Expected: PASS.

- [ ] **Step 5: Run all VaultWrapper suites** (fees/protections/access/pause/distribution use the uncapped standard mock — `previewWithdraw` must be value-identical there):

```bash
forge test --match-path "test/solidity/VaultWrapper/*.t.sol" -q
```

Expected: PASS, modulo justified ≤1-wei adjustments (same policy as Task 3 Step 4).

- [ ] **Step 6: Lint and commit:**

```bash
bunx solhint src/VaultWrapper/LiFiVaultWrapper.sol
git add src/VaultWrapper/LiFiVaultWrapper.sol test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol
git commit -m "fix(VaultWrapper): cost-aware previewWithdraw and liquidity-aware exit limits"
```

---

### Task 5: Conformance fuzz — the six design invariants under fuzzing

**Files:**

- Test: `test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol` (fuzz section)

- [ ] **Step 1: Append the fuzz tests:**

```solidity
    /// Conformance fuzz ///

    /// @dev Invariant 5: advertised maxima never over-report, across cap/liquidity/fee
    ///      combinations on an honest capped source.
    function testFuzz_AdvertisedMaximaNeverRevert(
        uint256 _depositCap,
        uint256 _liquidity,
        uint256 _seedAmount,
        uint16 _withdrawFeeBps
    ) public {
        _depositCap = bound(_depositCap, 1e6, 1_000_000e18);
        _liquidity = bound(_liquidity, 1e6, 1_000_000e18);
        _seedAmount = bound(_seedAmount, 1e6, _depositCap);
        _withdrawFeeBps = uint16(bound(_withdrawFeeBps, 0, 500));

        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = _withdrawFeeBps;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(_depositCap);
        _depositTo(w, alice, _seedAmount);
        capped.setLiquidity(_liquidity);

        // deposit(maxDeposit) — skip the unlimited sentinel.
        uint256 maxDep = w.maxDeposit(bob);
        if (maxDep != 0 && maxDep != type(uint256).max) {
            uint256 amount = maxDep > 1_000_000e18 ? 1_000_000e18 : maxDep;
            asset.mint(bob, amount);
            vm.startPrank(bob);
            asset.approve(address(w), amount);
            w.deposit(amount, bob);
            vm.stopPrank();
        }

        // withdraw(maxWithdraw) and redeem(maxRedeem) for the seeded holder.
        uint256 maxW = w.maxWithdraw(alice);
        if (maxW != 0) {
            vm.prank(alice);
            w.withdraw(maxW, alice, alice);
        }
        uint256 maxR = w.maxRedeem(alice);
        if (maxR != 0) {
            vm.prank(alice);
            w.redeem(maxR, alice, alice);
        }
    }

    /// @dev Invariant 3: preview == execution in the same block, on a lossy-but-honest
    ///      source, for both exit entrypoints.
    function testFuzz_PreviewsMatchExecutionOnLossySource(
        uint256 _amount,
        uint256 _exitPart,
        uint16 _sourceFeeBps,
        uint16 _withdrawFeeBps
    ) public {
        _amount = bound(_amount, 1e12, 1_000_000e18);
        _sourceFeeBps = uint16(bound(_sourceFeeBps, 0, 1000));
        _withdrawFeeBps = uint16(bound(_withdrawFeeBps, 0, 500));

        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = _withdrawFeeBps;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, _sourceFeeBps);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, _amount);

        // redeem: returned assets equal the preview exactly.
        uint256 shares = w.balanceOf(alice);
        uint256 sharePart = bound(_exitPart, 1, shares);
        uint256 quotedAssets = w.previewRedeem(sharePart);

        vm.prank(alice);
        uint256 paid = w.redeem(sharePart, alice, alice);

        assertEq(paid, quotedAssets, "redeem != previewRedeem");

        // withdraw: burned shares equal the preview exactly.
        uint256 maxW = w.maxWithdraw(alice);
        if (maxW == 0) return;
        uint256 assetsOut = bound(_exitPart, 1, maxW);
        uint256 quotedShares = w.previewWithdraw(assetsOut);

        vm.prank(alice);
        uint256 burned = w.withdraw(assetsOut, alice, alice);

        assertEq(burned, quotedShares, "withdraw != previewWithdraw");
        assertEq(asset.balanceOf(alice), paid + assetsOut);
    }

    /// @dev Invariant 4: an exiting user cannot dilute remaining holders through the
    ///      exact-out path on a lossy source.
    function testFuzz_WithdrawNeverDilutesRemainingHolders(
        uint256 _amount,
        uint256 _exitPart,
        uint16 _sourceFeeBps
    ) public {
        _amount = bound(_amount, 1e12, 1_000_000e18);
        _sourceFeeBps = uint16(bound(_sourceFeeBps, 0, 1000));

        FeeConfig memory fees;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, _sourceFeeBps);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, _amount);
        _depositTo(w, bob, _amount);

        uint256 bobBefore = w.previewRedeem(w.balanceOf(bob));
        uint256 maxW = w.maxWithdraw(alice);
        if (maxW == 0) return;
        uint256 assetsOut = bound(_exitPart, 1, maxW);

        vm.prank(alice);
        w.withdraw(assetsOut, alice, alice);

        // Bob's realizable value never drops by more than rounding dust.
        assertGe(w.previewRedeem(w.balanceOf(bob)) + 2, bobBefore);
    }
```

- [ ] **Step 2: Run with a raised fuzz budget:**

```bash
FOUNDRY_FUZZ_RUNS=2000 forge test --match-path "test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol" --match-test "testFuzz" -vv
```

Expected: PASS. Failures here are design bugs, not test bugs — fix rounding directions in the Task 3/4 code (the documented conservative directions: valuations Floor, costs/fees Ceil), not the assertions. The two tolerance constants (±2 wei) are the only sanctioned slack.

- [ ] **Step 3: Commit:**

```bash
git add test/solidity/VaultWrapper/LiFiVaultWrapperExitRealizability.t.sol
git commit -m "test(VaultWrapper): conformance fuzz for realizable exits and limit views"
```

---

### Task 6: Full-subsystem reconciliation (invariant + fork + factory/scripts suites)

**Files:**

- Possibly modify: `test/solidity/VaultWrapper/invariant/VaultWrapperInvariantHandler.sol` (only if its bounds assume the old `maxWithdraw`)
- No source changes expected.

- [ ] **Step 1: Run every VaultWrapper suite including invariants:**

```bash
forge test --match-path "test/solidity/VaultWrapper/**" -q
```

Expected: PASS. The invariant handler drives withdrawals through the wrapper's own `maxWithdraw`, which is now realizable-aware — self-consistent by construction. If a handler assumption breaks (e.g. it computes an expected burn from `convertToShares` instead of `previewWithdraw`), update the handler to quote through the wrapper's previews — the previews are now the source of truth for execution.

- [ ] **Step 2: Run the full repo test suite once** (Diamond suites must be untouched — the subsystem is isolated, this is the proof):

```bash
forge test -q
```

Expected: PASS with no non-VaultWrapper diffs. (Fork suites skip without RPC env vars — note that in the task summary if skipped.)

- [ ] **Step 3: Commit** (only if the handler needed changes):

```bash
git add test/solidity/VaultWrapper/invariant/
git commit -m "test(VaultWrapper): align invariant handler with realizable exit previews"
```

---

### Task 7: Documentation and NatSpec sweep

**Files:**

- Modify: `docs/VaultWrapper/ERC4626Adapter.md`
- Modify: `docs/VaultWrapper/LiFiVaultWrapper.md`
- Modify: `src/VaultWrapper/LiFiVaultWrapper.sol` (contract-level `@dev` only)

- [ ] **Step 1: `docs/VaultWrapper/ERC4626Adapter.md`** — rewrite the "Assumptions" section and extend "Functions":

  - Assumptions: the **strict pair** (`deposit`/`withdraw`) still assumes a standard ERC-4626 over a non-fee-on-transfer asset and reverts the wrapper's exact-out flow on shortfall. The **realizable pair** (`previewWithdrawUpTo`/`withdrawUpTo`) tolerates lossy sources by construction. The **limit views** (`maxDeposit`/`maxWithdraw`) are fail-soft (0 on a reverting/malformed source view). `previewWithdrawCost` prices exact-out exits so the exiter bears source fees. Share-side dilution on deposit (a source crediting fewer shares) remains uncaught — unchanged.
  - Functions: add the five new signatures with one-line descriptions (copy the interface NatSpec summaries).

- [ ] **Step 2: `docs/VaultWrapper/LiFiVaultWrapper.md`** — add an "Exit semantics" section:

  - `redeem` (exact-in): loss-tolerant, share-sourced; pays actual proceeds; withdrawal fee charged on actual proceeds; `previewRedeem` quotes realizable value; use the EIP-5143 overload to bound proceeds from a misbehaving source.
  - `withdraw` (exact-out): strict; delivers exactly the requested assets or reverts; shares burned are cost-aware so source exit fees are never socialized.
  - `max*` views: consult the source's caps/liquidity through the adapter, fail-soft to 0.
  - Valuation asymmetry (deliberate): `totalAssets()`/PPS/fee accrual remain valuation-based while exits realize; the exiter bears exit costs, not remaining holders. PPS is therefore an upper bound on per-share proceeds for fee-charging sources.
  - Residual risk (accepted): a source whose `previewWithdraw` itself reverts blocks `redeem`; recovery is the beacon upgrade (48h timelock).

- [ ] **Step 3: `LiFiVaultWrapper.sol` contract-level `@dev`** — in the block describing deposits/withdrawals, replace the sentence about exits with two sentences covering the strict/tolerant split and the valuation asymmetry (same content as the doc section, compressed).

- [ ] **Step 4: Commit:**

```bash
git add docs/VaultWrapper/ src/VaultWrapper/LiFiVaultWrapper.sol
git commit -m "docs(VaultWrapper): document realizable exit semantics and limit views"
```

---

### Task 8: Finish checklist (rule 099)

- [ ] **Step 1: Lint everything touched:**

```bash
bunx solhint "src/VaultWrapper/**/*.sol" "test/solidity/VaultWrapper/**/*.sol"
```

Expected: clean (fix anything reported).

- [ ] **Step 2: Full test run** (final): `forge test -q` — record the result in the PR.

- [ ] **Step 3: `healthCheckInvariants` check** — the VaultWrapper subsystem is standalone (not a facet/periphery), so `script/deploy/healthCheckInvariants.ts` needs no change; state this in the PR body.

- [ ] **Step 4: Self-review pass** (mechanical/semantic/executable sweep per rule 099), push, and flip the PR from the plan to the implementation:

```bash
git push -u origin fix/vault-wrapper-exit-realizability
```

Update the PR body's status section, keep it as draft until CI + bot reviewers (CodeRabbit, Aikido) are clean, then remove the plan file in a final commit (`git rm docs/superpowers/plans/2026-07-23-vault-wrapper-exit-realizability.md`) if the team prefers plans not to merge into `dev-vault-wrapper` — ask in the PR.

---

## Out of scope (tracked separately)

- **Finding #5** (a reverting access gate bricks the `max*` views fail-closed): separate fix. This plan only ensures *source*-side view failures can't revert our views (fail-soft adapter limit views); the gate path is untouched.
- **Ticket linkage**: PR #2097 (the findings-1 batch) still carries a TODO for its EXSC ticket; this PR should reference the same ticket once created.
- **`deposit`-side realizability** (a source charging entry fees in shares): explicitly unsupported, unchanged — the `AdapterDepositShortfall` guard and the adapter docs still declare it out of scope; such sources need a dedicated adapter.
