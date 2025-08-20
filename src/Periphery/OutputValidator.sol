// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";

/// @title OutputValidator
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for validating swap output amounts
/// @custom:version 1.0.0
contract OutputValidator is TransferrableOwnership {
    using SafeTransferLib for address;

    /// Constructor ///
    /// @param _owner The address of the contract owner
    constructor(address _owner) TransferrableOwnership(_owner) {
        if (_owner == address(0)) revert InvalidCallData();
    }

    /// External Methods ///

    /// @notice Validates swap output amount and transfers excess tokens to validation wallet
    /// @param tokenAddress The address of the token to validate
    /// @param expectedAmount The expected amount of tokens
    /// @param validationWalletAddress The address to send excess tokens to
    function validateOutput(
        address tokenAddress,
        uint256 expectedAmount,
        address validationWalletAddress
    ) external payable {
        // we do not validate the expected amount to save gas
        // tokens are not lost, even if amount == 0 (tokens will be forwarded to validation wallet)
        // token and wallet addresses are validated in LibAsset

        uint256 actualAmount;
        bool isNative = tokenAddress == LibAsset.NULL_ADDRESS;

        // We assume that actualAmount > expectedAmount without validating it to save gas
        if (isNative) {
            // native: actualAmount is sent to this contract as msg.value
            actualAmount = address(this).balance;

            // return expectedAmount to msg.sender (in any case)
            LibAsset.transferAsset(
                tokenAddress,
                payable(msg.sender),
                expectedAmount
            );

            // transfer excess to validation wallet
            LibAsset.transferAsset(
                tokenAddress,
                payable(validationWalletAddress),
                actualAmount - expectedAmount
            );
        } else {
            // ERC20: actualAmount is the ERC20 balance of the calling contract
            actualAmount = ERC20(tokenAddress).balanceOf(msg.sender);

            // transfer excess to validation wallet
            tokenAddress.safeTransferFrom(
                msg.sender,
                validationWalletAddress,
                actualAmount - expectedAmount
            );
        }
    }
}
