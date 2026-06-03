// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";

/// @title OutputValidator
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for validating swap output amounts
/// @notice This contract is designed to not hold any funds which is why it's safe to work with (full) balances
/// @notice Accidentally stuck funds can be recovered by the owner via the provided withdrawal functions
/// @dev Output is measured as the caller's *full* balance of the given token, the same full-balance pattern
///      used across the protocol's swap facets (e.g. GenericSwapFacetV3 sends its full receivingAsset balance
///      to the receiver). It must therefore only be used as a whitelisted swap step inside an atomic LI.FI
///      route: any pre-existing balance the caller holds for `tokenAddress` is treated as output and forwarded
///      to `validationWalletAddress`. Since the Diamond is not designed to custody funds between transactions,
///      such balances are incidental dust that is already sweepable protocol-wide; no active user funds are at risk.
/// @custom:version 1.0.0
contract OutputValidator is WithdrawablePeriphery {
    /// Events ///

    /// @notice Emitted when excess output (positive slippage) is forwarded to the validation wallet
    /// @param token The forwarded token (LibAsset.NULL_ADDRESS for native)
    /// @param validationWallet The address that received the excess
    /// @param excessAmount The amount forwarded to the validation wallet
    event OutputValidated(
        address indexed token,
        address indexed validationWallet,
        uint256 excessAmount
    );

    /// Constructor ///
    constructor(address _owner) WithdrawablePeriphery(_owner) {
        if (_owner == address(0)) revert InvalidCallData();
    }

    /// External Methods ///

    /// @notice Validates native token swap output amount and transfers excess tokens to validation wallet
    /// @dev This function requires a msg.value to handle excess tokens, otherwise it cannot work as expected
    /// @dev Native payouts are capped by msg.value: pre-existing native held by the caller is counted towards
    ///      `outputAmount` but can never be transferred out by this contract. In the intended integration the
    ///      caller forwards only the excess as msg.value with expectedAmount == 0, so the full msg.value is
    ///      forwarded to the validation wallet.
    /// @param expectedAmount The expected amount of native tokens
    /// @param validationWalletAddress The address to send excess tokens to
    function validateNativeOutput(
        uint256 expectedAmount,
        address validationWalletAddress
    ) external payable {
        // we do not validate the expectedAmount to save gas
        // tokens are not lost, even if expectedAmount == 0 (>> all tokens will be forwarded to validation wallet)
        // wallet address is validated in LibAsset

        // outputAmount is calculated as what was sent to this contract as msg.value plus the remaining native
        // balance of the sending contract (msg.sender)
        uint256 outputAmount = msg.sender.balance + msg.value;

        // only continue if outputAmount is greater than expectedAmount
        if (outputAmount > expectedAmount) {
            // calculate the excess amount
            uint256 excessAmount = outputAmount - expectedAmount;

            if (excessAmount >= msg.value) {
                // if excess is equal/more than what was sent, forward all msg.value to validation wallet
                // skip the transfer when nothing was sent to avoid a wasteful zero-value native call
                if (msg.value > 0) {
                    LibAsset.transferAsset(
                        LibAsset.NULL_ADDRESS,
                        payable(validationWalletAddress),
                        msg.value
                    );

                    emit OutputValidated(
                        LibAsset.NULL_ADDRESS,
                        validationWalletAddress,
                        msg.value
                    );
                }
            } else {
                // forward excess to validation wallet
                LibAsset.transferAsset(
                    LibAsset.NULL_ADDRESS,
                    payable(validationWalletAddress),
                    excessAmount
                );

                emit OutputValidated(
                    LibAsset.NULL_ADDRESS,
                    validationWalletAddress,
                    excessAmount
                );

                // return remaining balance to msg.sender
                // excessAmount < msg.value here, so the refund is always greater than zero
                LibAsset.transferAsset(
                    LibAsset.NULL_ADDRESS,
                    payable(msg.sender),
                    msg.value - excessAmount
                );
            }
        } else if (msg.value > 0) {
            // no excess: refund whatever was sent. when msg.value == 0 there is
            // nothing to return, so we intentionally do nothing (no else branch)
            LibAsset.transferAsset(
                LibAsset.NULL_ADDRESS,
                payable(msg.sender),
                msg.value
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
        uint256 outputAmount = IERC20(tokenAddress).balanceOf(msg.sender);

        // make sure we do not attempt any token transfers if there is no excess amount
        if (outputAmount > expectedAmount) {
            uint256 excessAmount = outputAmount - expectedAmount;

            // transfer excess tokens to validation wallet
            // no need to validate the tokenAddress, tx will fail if address is invalid
            LibAsset.transferFromERC20(
                tokenAddress,
                msg.sender,
                validationWalletAddress,
                excessAmount
            );

            emit OutputValidated(
                tokenAddress,
                validationWalletAddress,
                excessAmount
            );
        }
    }
}
