// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { InvalidConfig, InsufficientBalance, NullAddrIsNotAnERC20Token } from "../Errors/GenericErrors.sol";

/// @title FeeForwarder
/// @author LI.FI (https://li.fi)
/// @notice Forwards various fee amounts to designated recipients
/// @dev This contract is not intended to custody funds: a normal invocation forwards
///      everything it receives and leaves no net balance behind. A balance that does
///      accumulate anyway (e.g. a forced transfer) is never paid out as a caller refund
///      and is recoverable only by the owner via WithdrawablePeriphery.
/// @custom:version 2.1.0
contract FeeForwarder is WithdrawablePeriphery {
    /// Types ///

    /// @notice Represents a single fee distribution to a recipient
    /// @param recipient The address that will receive the fee amount
    /// @param amount The amount of tokens to distribute to the recipient
    struct FeeDistribution {
        address recipient;
        uint256 amount;
    }

    /// @notice Represents a fee share of the caller's token balance for a recipient
    /// @param recipient The address that will receive the fee share
    /// @param bps The share of the caller's balance in basis points (10_000 = 100%)
    struct FeeBpsDistribution {
        address recipient;
        uint16 bps;
    }

    /// Constants ///

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// Errors ///

    /// @notice Thrown when the bps shares of a call add up to more than 10_000
    /// @param totalBps The sum of all bps shares passed to the call
    error InvalidTotalBps(uint256 totalBps);

    /// Events ///

    /// @notice Emitted when fees are successfully forwarded to recipients
    /// @param token The address of the token that was forwarded (address(0) for native tokens)
    /// @param distributions Array of fee distributions that were processed
    event FeesForwarded(
        address indexed token,
        FeeDistribution[] distributions
    );

    /// Constructor ///

    /// @notice Initializes the FeeForwarder contract
    /// @param _owner The address that will be set as the owner of the contract
    constructor(address _owner) WithdrawablePeriphery(_owner) {
        if (_owner == address(0)) revert InvalidConfig();
    }

    /// External Methods ///

    /// @notice Forwards ERC20 token fees from the caller to the specified recipients
    /// @dev The caller must have approved this contract to spend the tokens before calling this function.
    ///      Native token transfers will fail naturally, saving gas by not checking explicitly.
    /// @param _token The address of the ERC20 token to forward
    /// @param _distributions Array of fee distributions containing recipients and amounts
    function forwardERC20Fees(
        address _token,
        FeeDistribution[] calldata _distributions
    ) external {
        // we do not check the length of the distributions array to save gas

        // also we do not check sufficient balance in msg.sender or approvals to save gas
        // the tx will revert anyway in these cases

        // forward all fee amounts to the recipients
        FeeDistribution calldata distribution;
        for (uint256 i; i < _distributions.length; ++i) {
            distribution = _distributions[i];

            // we do intentionally not check for amount == 0 to save gas

            LibAsset.transferFromERC20(
                _token,
                msg.sender,
                distribution.recipient,
                distribution.amount
            );
        }

        emit FeesForwarded(_token, _distributions);
    }

    /// @notice Forwards bps shares of the caller's full ERC20 balance to the specified recipients
    /// @dev Intended as a swap step after the swap that produces `_token`, to take fees as a share
    ///      of the actual output. All shares are computed from the balance read once before any
    ///      transfer, so every fee for `_token` must go in a single call: a second call would
    ///      compute its shares from the balance the first one already reduced.
    ///      The caller's full balance is the fee base, including any balance it held before the
    ///      swap (same full-balance pattern as OutputValidator).
    ///      Shares are rounded down and a share of zero is skipped (some tokens revert on
    ///      zero-value transfers); the event still lists it with amount 0.
    ///      The caller must have approved this contract to spend the tokens.
    /// @param _token The address of the ERC20 token to forward
    /// @param _distributions Array of recipients and their shares in basis points
    function forwardERC20FeesBps(
        address _token,
        FeeBpsDistribution[] calldata _distributions
    ) external {
        if (LibAsset.isNativeAsset(_token)) revert NullAddrIsNotAnERC20Token();

        uint256 balance = IERC20(_token).balanceOf(msg.sender);

        uint256 length = _distributions.length;
        FeeDistribution[] memory forwarded = new FeeDistribution[](length);
        uint256 totalBps;
        FeeBpsDistribution calldata distribution;
        for (uint256 i; i < length; ++i) {
            distribution = _distributions[i];

            uint256 bps = distribution.bps;
            // cannot overflow: the check below keeps totalBps <= 10_000 before each addition
            unchecked {
                totalBps += bps;
            }
            // checked before the transfer: past 10_000 the shares exceed the balance and the
            // transfer would revert first with a less specific error
            if (totalBps > BPS_DENOMINATOR) revert InvalidTotalBps(totalBps);

            uint256 amount = (balance * bps) / BPS_DENOMINATOR;
            forwarded[i] = FeeDistribution(distribution.recipient, amount);

            if (amount != 0) {
                LibAsset.transferFromERC20(
                    _token,
                    msg.sender,
                    distribution.recipient,
                    amount
                );
            }
        }

        emit FeesForwarded(_token, forwarded);
    }

    /// @notice Forwards native token fees to the specified recipients
    /// @dev The unspent part of msg.value will be refunded to the caller. An invocation may
    ///      never distribute more than its own msg.value: it reverts with InsufficientBalance
    ///      if the contract balance covered the shortfall, otherwise the failing transfer
    ///      reverts first with ETHTransferFailed.
    ///      The tx will not revert if the array is empty, but will still emit the FeesForwarded event.
    /// @param _distributions Array of fee distributions containing recipients and amounts
    function forwardNativeFees(
        FeeDistribution[] calldata _distributions
    ) external payable {
        // we do not check the length of the distributions array to save gas

        // forward all native fee amounts to the recipients
        uint256 totalDistributed;
        FeeDistribution calldata distribution;
        for (uint256 i; i < _distributions.length; ++i) {
            distribution = _distributions[i];

            // we do intentionally not check for amount == 0 to save gas

            uint256 amount = distribution.amount;
            unchecked {
                totalDistributed += amount;
            }

            LibAsset.transferNativeAsset(
                payable(distribution.recipient),
                amount
            );
        }

        // an invocation may only spend what its own caller funded: recipients receive
        // native funds with all gas forwarded and can call back into this function, so
        // spending against the contract balance would let a nested call draw on a stray
        // balance or on a parent call's still-undistributed funds
        if (totalDistributed > msg.value)
            revert InsufficientBalance(totalDistributed, msg.value);

        uint256 refundAmount;
        unchecked {
            refundAmount = msg.value - totalDistributed;
        }
        if (refundAmount != 0) {
            LibAsset.transferNativeAsset(payable(msg.sender), refundAmount);
        }

        emit FeesForwarded(LibAsset.NULL_ADDRESS, _distributions);
    }
}
