// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title FeeForwarder
/// @author LI.FI (https://li.fi)
/// @notice Forwards various fee amounts to designated recipients
/// @dev This contract is not intended to custody funds; any native balance is transient
///      within a single call. Stray balances remain recoverable by the owner via
///      WithdrawablePeriphery and are never paid out as a caller refund.
/// @custom:version 2.0.0
contract FeeForwarder is WithdrawablePeriphery {
    /// Types ///

    /// @notice Represents a single fee distribution to a recipient
    /// @param recipient The address that will receive the fee amount
    /// @param amount The amount of tokens to distribute to the recipient
    struct FeeDistribution {
        address recipient;
        uint256 amount;
    }

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

    /// @notice Forwards native token fees to the specified recipients
    /// @dev The unspent part of msg.value will be refunded to the caller. Transaction will revert if insufficient funds.
    ///      The tx will not revert if the array is empty, but will still emit the FeesForwarded event.
    /// @param _distributions Array of fee distributions containing recipients and amounts
    function forwardNativeFees(
        FeeDistribution[] calldata _distributions
    ) external payable {
        // we do not check the length of the distributions array to save gas

        // also we do not check sufficient msg.value / native balance to save gas
        // the tx will revert anyway in this case

        // forward all native fee amounts to the recipients
        uint256 totalDistributed;
        FeeDistribution calldata distribution;
        for (uint256 i; i < _distributions.length; ++i) {
            distribution = _distributions[i];

            // we do intentionally not check for amount == 0 to save gas

            totalDistributed += distribution.amount;

            LibAsset.transferNativeAsset(
                payable(distribution.recipient),
                distribution.amount
            );
        }

        // refund the unspent part of msg.value, not the contract's balance:
        // recipients receive native funds with all gas forwarded and can call back into
        // this function, so a balance-based refund would let them claim value that belongs
        // to another (possibly still executing) invocation. The checked subtraction also
        // rejects distributing more than the caller funded, which would otherwise draw on
        // a stray balance or on a parent call's undistributed funds.
        uint256 refundAmount = msg.value - totalDistributed;
        if (refundAmount != 0) {
            LibAsset.transferNativeAsset(payable(msg.sender), refundAmount);
        }

        emit FeesForwarded(LibAsset.NULL_ADDRESS, _distributions);
    }
}
