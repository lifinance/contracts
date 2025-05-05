// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibSwap } from "./LibSwap.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { InvalidReceiver, NullAddrIsNotAValidSpender, InvalidAmount, NullAddrIsNotAnERC20Token } from "../Errors/GenericErrors.sol";

/// @title LibAsset
/// @custom:version 2.0.0
/// @notice This library contains helpers for dealing with onchain transfers
///         of assets, including accounting for the native asset `assetId`
///         conventions and any noncompliant ERC20 transfers
library LibAsset {
    using SafeTransferLib for address;
    using SafeTransferLib for address payable;

    address internal constant NULL_ADDRESS = address(0);

    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    /// @dev All native assets use the empty address for their asset id
    ///      by convention

    address internal constant NATIVE_ASSETID = NULL_ADDRESS;

    /// @dev EIP-7702 delegation designator prefix for Account Abstraction
    bytes3 internal constant DELEGATION_DESIGNATOR = 0xef0100;

    /// @notice Gets the balance of the inheriting contract for the given asset
    /// @param assetId The asset identifier to get the balance of
    /// @return Balance held by contracts using this library (returns 0 if assetId does not exist)
    function getOwnBalance(address assetId) internal view returns (uint256) {
        return
            isNativeAsset(assetId)
                ? address(this).balance
                : assetId.balanceOf(address(this));
    }

    /// @notice Wrapper function to transfer a given asset (native or erc20) to
    ///         some recipient. Should handle all non-compliant return value
    ///         tokens as well by using the SafeERC20 contract by open zeppelin.
    /// @param assetId Asset id for transfer (address(0) for native asset,
    ///                token address for erc20s)
    /// @param recipient Address to send asset to
    /// @param amount Amount to send to given recipient
    function transferAsset(
        address assetId,
        address payable recipient,
        uint256 amount
    ) internal {
        if (isNativeAsset(assetId)) {
            transferNativeAsset(recipient, amount);
        } else {
            transferERC20(assetId, recipient, amount);
        }
    }

    /// @notice Transfers ether from the inheriting contract to a given
    ///         recipient
    /// @param recipient Address to send ether to
    /// @param amount Amount to send to given recipient
    function transferNativeAsset(
        address payable recipient,
        uint256 amount
    ) private {
        // make sure a meaningful receiver address was provided
        if (recipient == NULL_ADDRESS) revert InvalidReceiver();

        // transfer native asset (will revert if target reverts or contract has insufficient balance)
        recipient.safeTransferETH(amount);
    }

    /// @notice Transfers tokens from the inheriting contract to a given recipient
    /// @param assetId Token address to transfer
    /// @param recipient Address to send tokens to
    /// @param amount Amount to send to given recipient
    function transferERC20(
        address assetId,
        address recipient,
        uint256 amount
    ) private {
        // make sure a meaningful receiver address was provided
        if (recipient == NULL_ADDRESS) {
            revert InvalidReceiver();
        }

        // transfer ERC20 assets (will revert if target reverts or contract has insufficient balance)
        assetId.safeTransfer(recipient, amount);
    }

    /// @notice Transfers tokens from a sender to a given recipient
    /// @param assetId Token address to transfer
    /// @param from Address of sender/owner
    /// @param recipient Address of recipient/spender
    /// @param amount Amount to transfer from owner to spender
    function transferFromERC20(
        address assetId,
        address from,
        address recipient,
        uint256 amount
    ) internal {
        // check if native asset
        if (isNativeAsset(assetId)) {
            revert NullAddrIsNotAnERC20Token();
        }

        // make sure a meaningful receiver address was provided
        if (recipient == NULL_ADDRESS) {
            revert InvalidReceiver();
        }

        // transfer ERC20 assets (will revert if target reverts or contract has insufficient balance)
        assetId.safeTransferFrom(from, recipient, amount);
    }

    /// @notice Pulls tokens from msg.sender
    /// @param assetId Token address to transfer
    /// @param amount Amount to transfer from owner
    function depositAsset(address assetId, uint256 amount) internal {
        // make sure a meaningful amount was provided
        if (amount == 0) revert InvalidAmount();

        // check if native asset
        if (isNativeAsset(assetId)) {
            // ensure msg.value is equal or greater than amount
            if (msg.value < amount) revert InvalidAmount();
        } else {
            // transfer ERC20 assets (will revert if target reverts or contract has insufficient balance)
            assetId.safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    function depositAssets(LibSwap.SwapData[] calldata swaps) internal {
        for (uint256 i = 0; i < swaps.length; ) {
            LibSwap.SwapData calldata swap = swaps[i];
            if (swap.requiresDeposit) {
                depositAsset(swap.sendingAssetId, swap.fromAmount);
            }
            unchecked {
                i++;
            }
        }
    }

    /// @notice If the current allowance is insufficient, the allowance for a given spender
    ///         is set to MAX_UINT.
    /// @param assetId Token address to transfer
    /// @param spender Address to give spend approval to
    /// @param amount allowance amount required for current transaction
    function maxApproveERC20(
        IERC20 assetId,
        address spender,
        uint256 amount
    ) internal {
        approveERC20(assetId, spender, amount, type(uint256).max);
    }

    /// @notice If the current allowance is insufficient, the allowance for a given spender
    ///         is set to the amount provided
    /// @param assetId Token address to transfer
    /// @param spender Address to give spend approval to
    /// @param requiredAllowance Allowance required for current transaction
    /// @param setAllowanceTo The amount the allowance should be set to if current allowance is insufficient
    function approveERC20(
        IERC20 assetId,
        address spender,
        uint256 requiredAllowance,
        uint256 setAllowanceTo
    ) internal {
        if (isNativeAsset(address(assetId))) {
            return;
        }

        // make sure a meaningful spender address was provided
        if (spender == NULL_ADDRESS) {
            revert NullAddrIsNotAValidSpender();
        }

        // check if allowance is sufficient, otherwise set allowance to provided amount
        // If the initial attempt to approve fails, attempts to reset the approved amount to zero,
        // then retries the approval again (some tokens, e.g. USDT, requires this).
        // Reverts upon failure
        if (assetId.allowance(address(this), spender) < requiredAllowance) {
            address(assetId).safeApproveWithRetry(spender, setAllowanceTo);
        }
    }

    /// @notice Determines whether the given assetId is the native asset
    /// @param assetId The asset identifier to evaluate
    /// @return Boolean indicating if the asset is the native asset
    function isNativeAsset(address assetId) internal pure returns (bool) {
        return assetId == NATIVE_ASSETID;
    }

    /// @notice Checks if the given address is a contract (including EIP‑7702 AA‑wallets)
    ///         Returns true for any account with runtime code or with the 0xef0100 prefix (EIP‑7702).
    ///         Limitations:
    ///         - Still returns false during construction phase of a contract
    ///         - Cannot distinguish between EOA and self-destructed contract
    /// @param account The address to be checked
    function isContract(address account) internal view returns (bool) {
        uint256 size;
        bytes memory code = new bytes(23); // 3 bytes prefix + 20 bytes address

        assembly {
            size := extcodesize(account)
            extcodecopy(account, add(code, 0x20), 0, 23)
        }

        // Check for delegation designator prefix (0xef0100) >> EIP7702
        bytes3 prefix = bytes3(code);

        if (prefix == DELEGATION_DESIGNATOR) {
            // Extract the delegate address (next 20 bytes after prefix)
            address delegateAddr;
            assembly {
                delegateAddr := mload(add(add(code, 0x20), 3))
                // Shift right to get proper alignment (12 bytes * 8 bits = 96 bits)
                delegateAddr := shr(96, delegateAddr)
            }

            // Check if the delegate address has code
            uint256 delegateSize;
            assembly {
                delegateSize := extcodesize(delegateAddr)
            }

            return delegateSize > 0;
        }

        // Traditional check for contract code
        return size > 0;
    }
}
