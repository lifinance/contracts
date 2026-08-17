// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { FeeConfig, DeployParams, FeeReceiver } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFactoryStackBase } from "test/solidity/VaultWrapper/VaultWrapperFactoryStackBase.sol";
import { VaultWrapperInvariantHandler } from "test/solidity/VaultWrapper/invariant/VaultWrapperInvariantHandler.sol";
import { MockFeeERC4626 } from "test/solidity/VaultWrapper/mocks/MockFeeERC4626.sol";
import { MockLiquidityCappedERC4626 } from "test/solidity/VaultWrapper/mocks/MockLiquidityCappedERC4626.sol";
import { VaultWrapperCappedSourceInvariantHandler } from "test/solidity/VaultWrapper/invariant/VaultWrapperInvariantHandler.sol";

/// @notice Shared stateful invariant suite for the assembled vault wrapper (EXSC-421 / S12). A
///         handler drives randomized multi-actor sequences — deposits, mints, withdrawals,
///         redeems, fee distributions, fee retunes, pause toggles, and injected yield/loss/time
///         — against one wrapper charging all four fee types over an underlying source. The
///         underlying source is a virtual seam (`_deployUnderlying`) so the exact same suite runs
///         over both a plain no-fee source and a source charging its own exit fee (EXSC-421 /
///         S12 exit-cost-awareness): idle assets and the wrapper's own share balance always
///         exactly back the booked fee counters, the performance high-water mark never regresses
///         (asserted in the handler), depositors can never extract more than was deposited plus
///         injected yield, exits never pay out more than the burned shares were worth at exit,
///         and no shares are minted or burned outside the tracked holder set. The suite runs
///         `fail-on-revert = true`, so a pause that ever blocked an exit — or any other
///         unexpected revert — fails a run.
abstract contract VaultWrapperInvariantBase is VaultWrapperFactoryStackBase {
    // Governance-set bounds equal to the immutable bytecode caps, so the handler can retune
    // each fee across its whole legal range.
    uint16 internal constant PERF_CAP = 5000;
    uint16 internal constant MGMT_CAP = 1000;
    uint16 internal constant DEPOSIT_CAP = 2000;
    uint16 internal constant WITHDRAWAL_CAP = 2000;

    // Initial deploy-time rates (all within the caps above).
    uint16 internal constant PERF_RATE = 1000;
    uint16 internal constant MGMT_RATE = 200;
    uint16 internal constant DEPOSIT_RATE = 50;
    uint16 internal constant WITHDRAWAL_RATE = 50;

    uint16 internal constant SPLIT = 8000; // integrator share of every fee type
    uint16 internal constant RECEIVER_1_BPS = 6000;
    uint16 internal constant RECEIVER_2_BPS = 4000;

    // 1% exit fee, used only by the fee-charging-source subclass.
    uint16 internal constant SOURCE_FEE_BPS = 100;

    MockERC20 internal asset;
    MockERC4626 internal underlying;
    VaultWrapperInvariantHandler internal handler;

    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal integrator1 = makeAddr("integrator1");
    address internal integrator2 = makeAddr("integrator2");
    address internal sourceFeeSink = makeAddr("sourceFeeSink");

    /// @dev Subclass seam: the underlying source under test. Base = plain no-fee mock.
    function _deployUnderlying(
        MockERC20 _asset
    ) internal virtual returns (MockERC4626) {
        return new MockERC4626(_asset, "Yield Token", "yTKN");
    }

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = _deployUnderlying(asset);

        _bringUpFactory(
            address(underlying),
            [PERF_CAP, MGMT_CAP, DEPOSIT_CAP, WITHDRAWAL_CAP]
        );
        _deployWrapper(_deployParams());

        handler = _deployHandler();

        targetContract(address(handler));
        targetSelector(
            FuzzSelector({ addr: address(handler), selectors: _actions() })
        );
    }

    /// @dev Subclass seam: the handler under test. Base = plain handler.
    function _deployHandler()
        internal
        virtual
        returns (VaultWrapperInvariantHandler)
    {
        return
            new VaultWrapperInvariantHandler(
                wrapper,
                asset,
                underlying,
                factory,
                vaultAdmin
            );
    }

    /// @dev The idle asset balance is exactly the deposit/withdrawal fees booked but not yet
    ///      distributed: nothing enters the wrapper's own balance except routed asset fees, and a
    ///      fee distribution transfers out precisely the booked amounts.
    function invariant_idleAssetsMatchBookedAssetFees() public view {
        assertEq(
            asset.balanceOf(address(wrapper)),
            uint256(wrapper.lifiFeeAssets()) + wrapper.integratorFeeAssets(),
            "idle assets diverged from booked asset fees"
        );
    }

    /// @dev The wrapper's own share balance is exactly the dilution fee-shares booked but not
    ///      yet distributed: performance/management fees mint shares to the wrapper, and a fee
    ///      distribution transfers out precisely the booked amounts.
    function invariant_wrapperSharesMatchBookedFeeShares() public view {
        assertEq(
            wrapper.balanceOf(address(wrapper)),
            uint256(wrapper.lifiFeeShares()) + wrapper.integratorFeeShares(),
            "wrapper share balance diverged from booked fee shares"
        );
    }

    /// @dev Depositors can never withdraw more, in aggregate, than was ever deposited plus the
    ///      yield injected into the underlying; fees and losses only ever reduce the payout.
    function invariant_depositorsNeverExtractMoreThanFunded() public view {
        assertLe(
            handler.ghostAssetsOut(),
            handler.ghostAssetsIn() + handler.ghostYield(),
            "depositors extracted more than was funded"
        );
    }

    /// @dev No shares exist outside the known holder set (the three actors, the wrapper's own
    ///      fee-share balance, and the three fee recipients), so total supply is fully
    ///      accounted for and none is silently minted or burned elsewhere.
    function invariant_shareSupplyFullyAccounted() public view {
        uint256 sum = wrapper.balanceOf(address(wrapper)) +
            wrapper.balanceOf(lifiRecipient) +
            wrapper.balanceOf(integrator1) +
            wrapper.balanceOf(integrator2);
        for (uint256 i; i < 3; ++i) {
            sum += wrapper.balanceOf(handler.actors(i));
        }

        assertEq(
            sum,
            wrapper.totalSupply(),
            "shares exist outside the tracked holder set"
        );
    }

    /// @dev An exit can lose value to a source exit fee or a loss, but can NEVER pay the
    ///      exiter more than their burned shares were worth at exit — otherwise the exit
    ///      created value at the remaining holders' expense (dilution). Cost-aware
    ///      previewWithdraw and realizable redeem both enforce this per-exit; the ghost
    ///      totals prove it holds cumulatively under arbitrary interleavings.
    function invariant_ExitsNeverCreateValueForExiter() public view {
        assertLe(
            handler.cumulativePaidOut(),
            handler.cumulativeSliceValue(),
            "an exit paid out more than the burned shares were worth"
        );
    }

    /// @dev The value of each actor's `maxRedeem` never exceeds what the source can currently
    ///      pay the wrapper — the liquidity clamp is honored. On an unlimited source this is
    ///      the full position; on a capped source it tracks the cap. Complements the
    ///      fail-on-revert proof that a `redeem` bounded to `maxRedeem` never reverts.
    function invariant_MaxRedeemWithinSourceLiquidity() public view {
        uint256 realizable = adapter.maxWithdrawableValue(
            address(underlying),
            address(wrapper)
        );
        for (uint256 i; i < 3; ++i) {
            assertLe(
                wrapper.convertToAssets(wrapper.maxRedeem(handler.actors(i))),
                realizable,
                "maxRedeem value exceeds source liquidity"
            );
        }
    }

    function _deployParams() private view returns (DeployParams memory) {
        uint16[4] memory rates = [
            PERF_RATE,
            MGMT_RATE,
            DEPOSIT_RATE,
            WITHDRAWAL_RATE
        ];
        FeeReceiver[] memory receivers = new FeeReceiver[](2);
        receivers[0] = FeeReceiver({
            wallet: integrator1,
            bps: RECEIVER_1_BPS
        });
        receivers[1] = FeeReceiver({
            wallet: integrator2,
            bps: RECEIVER_2_BPS
        });

        return
            DeployParams({
                namespace: bytes32("LI.FI-Earn"),
                vaultWrapperAdmin: vaultAdmin,
                adapter: address(adapter),
                underlying: address(underlying),
                nonce: 0,
                fees: FeeConfig({ rateBps: rates }),
                integratorShareBps: [SPLIT, SPLIT, SPLIT, SPLIT],
                accessGate: address(0),
                receivers: receivers
            });
    }

    /// @dev The handler entrypoints the fuzzer may call; the ghost/actor getters are excluded.
    function _actions()
        internal
        pure
        virtual
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](10);
        selectors[0] = VaultWrapperInvariantHandler.deposit.selector;
        selectors[1] = VaultWrapperInvariantHandler.mint.selector;
        selectors[2] = VaultWrapperInvariantHandler.withdraw.selector;
        selectors[3] = VaultWrapperInvariantHandler.redeem.selector;
        selectors[4] = VaultWrapperInvariantHandler.distributeFees.selector;
        selectors[5] = VaultWrapperInvariantHandler.injectYield.selector;
        selectors[6] = VaultWrapperInvariantHandler.injectLoss.selector;
        selectors[7] = VaultWrapperInvariantHandler.warp.selector;
        selectors[8] = VaultWrapperInvariantHandler.setFee.selector;
        selectors[9] = VaultWrapperInvariantHandler.togglePause.selector;
    }
}

/// @notice Invariant suite over a plain, no-fee ERC-4626 source.
contract VaultWrapperInvariantTest is VaultWrapperInvariantBase {}

/// @notice Same invariant suite over a compliant source charging a 1% exit fee that
///         leaves the source vault — proving cost-aware exits never dilute stayers even
///         when the source imposes an exit cost.
contract VaultWrapperFeeSourceInvariantTest is VaultWrapperInvariantBase {
    function _deployUnderlying(
        MockERC20 _asset
    ) internal override returns (MockERC4626) {
        return
            new MockFeeERC4626(
                _asset,
                "Yield Token",
                "yTKN",
                SOURCE_FEE_BPS,
                sourceFeeSink
            );
    }
}

/// @notice Same invariant suite over a source whose withdrawal liquidity is fuzzed up and
///         down — proving the wrapper's liquidity-aware `max*` never over-report and a redeem
///         within `maxRedeem` never reverts even as source liquidity shifts.
contract VaultWrapperCappedSourceInvariantTest is VaultWrapperInvariantBase {
    function _deployUnderlying(
        MockERC20 _asset
    ) internal override returns (MockERC4626) {
        return new MockLiquidityCappedERC4626(_asset, "Yield Token", "yTKN");
    }

    function _deployHandler()
        internal
        override
        returns (VaultWrapperInvariantHandler)
    {
        return
            new VaultWrapperCappedSourceInvariantHandler(
                wrapper,
                asset,
                underlying,
                factory,
                vaultAdmin
            );
    }

    // `withdraw` is deliberately omitted: on a liquidity-capped source the exact-out withdraw
    // path can revert at EITHER the share-rounding boundary OR a source-liquidity boundary, and
    // it is not the guaranteed exit. Its boundary behavior is covered by the no-fee/fee-source
    // suites (share-rounding) and the wrapper unit tests (liquidity clamp + ExceededMaxWithdraw).
    // This suite exercises the guaranteed `redeem` path and the max-view clamp under shifting
    // liquidity.
    function _actions()
        internal
        pure
        override
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](10);
        selectors[0] = VaultWrapperInvariantHandler.deposit.selector;
        selectors[1] = VaultWrapperInvariantHandler.mint.selector;
        selectors[2] = VaultWrapperInvariantHandler.redeem.selector;
        selectors[3] = VaultWrapperInvariantHandler.distributeFees.selector;
        selectors[4] = VaultWrapperInvariantHandler.injectYield.selector;
        selectors[5] = VaultWrapperInvariantHandler.injectLoss.selector;
        selectors[6] = VaultWrapperInvariantHandler.warp.selector;
        selectors[7] = VaultWrapperInvariantHandler.setFee.selector;
        selectors[8] = VaultWrapperInvariantHandler.togglePause.selector;
        selectors[9] = VaultWrapperCappedSourceInvariantHandler
            .setLiquidity
            .selector;
    }
}
