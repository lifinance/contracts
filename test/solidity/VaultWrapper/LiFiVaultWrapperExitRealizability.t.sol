// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { FeeConfig, FeeType } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFeeTestBase } from "test/solidity/VaultWrapper/VaultWrapperFeeTestBase.sol";
import { MockCappedERC4626 } from "test/solidity/VaultWrapper/mocks/MockCappedERC4626.sol";

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
