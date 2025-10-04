// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title FeeForwarder
/// @author LI.FI (https://li.fi)
/// @notice Forwards various fee amounts to designated recipients
/// @custom:version 1.0.0
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
        for (uint256 i; i < _distributions.length; ) {
            FeeDistribution calldata distribution = _distributions[i];

            // we do intentionally not check for amount == 0 to save gas

            LibAsset.transferFromERC20(
                _token,
                msg.sender,
                distribution.recipient,
                distribution.amount
            );

            unchecked {
                ++i;
            }
        }

        emit FeesForwarded(_token, _distributions);
    }

    /// @notice Forwards native token fees to the specified recipients
    /// @dev Any excess native tokens sent will be refunded to the caller. Transaction will revert if insufficient funds.
    ///      The tx will not revert if the array is empty, but will still emit the FeesForwarded event.
    /// @param _distributions Array of fee distributions containing recipients and amounts
    function forwardNativeFees(
        FeeDistribution[] calldata _distributions
    ) external payable {
        // we do not check the length of the distributions array to save gas

        // also we do not check sufficient msg.value / native balance to save gas
        // the tx will revert anyway in this case

        // forward all native fee amounts to the recipients
        for (uint256 i; i < _distributions.length; ) {
            FeeDistribution calldata distribution = _distributions[i];

            // we do intentionally not check for amount == 0 to save gas

            LibAsset.transferNativeAsset(
                payable(distribution.recipient),
                distribution.amount
            );

            unchecked {
                ++i;
            }
        }

        // return any remaining native tokens to the caller
        // since the contract is designed to not hold any funds and does not collect any dust
        // we can safely return the remaining native balance to the caller
        uint256 remainingNativeBalance = address(this).balance;
        if (remainingNativeBalance != 0) {
            LibAsset.transferNativeAsset(
                payable(msg.sender),
                remainingNativeBalance
            );
        }

        emit FeesForwarded(address(0), _distributions);
    }
}
