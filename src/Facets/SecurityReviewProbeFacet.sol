// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

interface IWETHProbe {
    function deposit() external payable;
    function withdraw(uint256) external;
}

error ProbeTransferFailed();

/// @title SecurityReviewProbeFacet
/// @notice EPHEMERAL test fixture to validate the EXP-440 security-review
///         pipeline end-to-end in CI. NOT a real facet — delete after the
///         test run. Contains deliberate positive controls (should be
///         flagged) and negative controls (should NOT be flagged).
contract SecurityReviewProbeFacet {
    address internal weth;

    // POSITIVE CONTROL — lf-046: bytes32 non-EVM receiver truncates >32B addrs.
    struct BridgeParams {
        uint256 amount;
        bytes32 nonEvmReceiver;
    }

    // NEGATIVE CONTROL — lf-046 must NOT fire: Solana addrs are genuinely 32B.
    struct SolanaParams {
        uint256 amount;
        bytes32 solanaReceiver;
    }

    // POSITIVE CONTROL — lf-003: payable.transfer caps gas at 2300.
    function payoutBad(address recipient, uint256 amount) external {
        payable(recipient).transfer(amount);
    }

    // NEGATIVE CONTROL — lf-003 must NOT fire: call{value:} is the safe form.
    function payoutGood(address recipient, uint256 amount) external {
        (bool ok, ) = recipient.call{ value: amount }("");
        if (!ok) revert ProbeTransferFailed();
    }

    // POSITIVE CONTROL — lf-001: forwards the whole contract balance.
    function wrapAllBad() external {
        IWETHProbe(weth).deposit{ value: address(this).balance }();
    }
}
