// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";

/// @title OutputValidator
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for validating swap output amounts
/// @notice This contract is designed to not hold any funds which is why it's safe to work with (full) balances
/// @notice Accidentally stuck funds can easily be recovered (by anyone) using the provided public functions
/// @custom:version 1.0.0
contract OutputValidator is WithdrawablePeriphery {
    using SafeTransferLib for address;

    /// Constructor ///
    constructor(address _owner) WithdrawablePeriphery(_owner) {
        if (_owner == address(0)) revert InvalidCallData();
    }

    /// External Methods ///

    /// @notice Validates native token swap output amount and transfers excess tokens to validation wallet
    /// @dev This function requires a msg.value, otherwise it cannot work as expected. We do not know if and
    ///      how much excessTokens there are.
    /// @param expectedAmount The expected amount of native tokens
    /// @param validationWalletAddress The address to send excess tokens to
    function validateNativeOutput(
        uint256 expectedAmount,
        address validationWalletAddress
    ) external payable {
        // we do not validate the expectedAmount to save gas
        // tokens are not lost, even if expectedAmount == 0 (>> all tokens will be forwarded to validation wallet)
        // wallet address is validated in LibAsset

        // calculate the excess amount
        // outputAmount is calculated as what was sent to this contract as msg.value plus the remaining native
        // balance of the sending contract (msg.sender)
        uint256 excessAmount = (address(msg.sender).balance + msg.value) -
            expectedAmount;

        if (excessAmount >= msg.value) {
            // if excess is equal/more than what was sent, forward all msg.value to validation wallet
            LibAsset.transferAsset(
                LibAsset.NULL_ADDRESS,
                payable(validationWalletAddress),
                msg.value
            );
        } else {
            // forward excess to validation wallet
            LibAsset.transferAsset(
                LibAsset.NULL_ADDRESS,
                payable(validationWalletAddress),
                excessAmount
            );

            // return remaining balance to msg.sender (in any case)
            LibAsset.transferAsset(
                LibAsset.NULL_ADDRESS,
                payable(msg.sender),
                msg.value - excessAmount
            );
        }
    }

    /// @notice Validates ERC20 token swap output amount and transfers excess tokens to validation wallet
    /// @param tokenAddress The address of the ERC20 token to validate
    /// @param expectedAmount The expected amount of tokens
    /// @param validationWalletAddress The address to send excess tokens to
    function validateERC20Output(
        address tokenAddress,
        uint256 expectedAmount,
        address validationWalletAddress
    ) external {
        // we do not validate the expected amount to save gas
        // tokens are not lost, even if amount == 0 (all tokens will be forwarded to validation wallet)

        // ERC20: outputAmount is the ERC20 balance of the calling contract
        // an approval needs to be set from msg.sender to this contract with at least == excessAmount
        // the case that outputAmount < expectedAmount should not be possible, since the diamond ensures that
        // minAmountOut is received from a swap and that same value is used as expectedAmount for this call
        uint256 excessAmount = ERC20(tokenAddress).balanceOf(msg.sender) -
            expectedAmount;

        // make sure we do not attempt any token transfers if there is no excess amount
        if (excessAmount > 0) {
            // validate wallet address
            if (validationWalletAddress == address(0)) {
                revert InvalidCallData();
            }

            // transfer excess to validation wallet
            // no need to validate the tokenAddress, it will fail if it's an invalid address
            tokenAddress.safeTransferFrom(
                msg.sender,
                validationWalletAddress,
                excessAmount
            );
        }
    }
}
