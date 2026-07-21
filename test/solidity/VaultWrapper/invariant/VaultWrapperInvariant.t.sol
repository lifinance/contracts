// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { FeeConfig, DeployParams, FeeReceiver } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFactoryStackBase } from "test/solidity/VaultWrapper/VaultWrapperFactoryStackBase.sol";
import { VaultWrapperInvariantHandler } from "test/solidity/VaultWrapper/invariant/VaultWrapperInvariantHandler.sol";

/// @notice Stateful invariant suite for the assembled vault wrapper (EXSC-421 / S12). A handler
///         drives randomized multi-actor sequences — deposits, mints, withdrawals, redeems,
///         fee distributions, fee retunes, pause toggles, and injected yield/loss/time — against one
///         wrapper charging all four fee types over an inflatable mock underlying. The math
///         library is already property-fuzzed in isolation; this suite proves the stateful
///         composition holds under arbitrary interleavings: idle assets and the wrapper's own
///         share balance always exactly back the booked fee counters, the performance
///         high-water mark never regresses (asserted in the handler), depositors can never
///         extract more than was deposited plus injected yield, and no shares are minted or
///         burned outside the tracked holder set. The suite runs `fail-on-revert = true`, so a
///         pause that ever blocked an exit — or any other unexpected revert — fails a run.
contract VaultWrapperInvariantTest is VaultWrapperFactoryStackBase {
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

    MockERC20 internal asset;
    MockERC4626 internal underlying;
    VaultWrapperInvariantHandler internal handler;

    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal integrator1 = makeAddr("integrator1");
    address internal integrator2 = makeAddr("integrator2");

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");

        _bringUpFactory(
            address(underlying),
            [PERF_CAP, MGMT_CAP, DEPOSIT_CAP, WITHDRAWAL_CAP]
        );
        _deployWrapper(_deployParams());

        handler = new VaultWrapperInvariantHandler(
            wrapper,
            asset,
            underlying,
            factory,
            vaultAdmin
        );

        targetContract(address(handler));
        targetSelector(
            FuzzSelector({ addr: address(handler), selectors: _actions() })
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
    function _actions() private pure returns (bytes4[] memory selectors) {
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
