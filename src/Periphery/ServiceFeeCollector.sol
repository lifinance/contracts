// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

/// @title Service Fee Collector
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for collecting service fees (gas/insurance)
contract ServiceFeeCollector is TransferrableOwnership {
    /// Errors ///
    error TransferFailure();
    error NotEnoughNativeForFees();

    /// Events ///
    event GasFeesCollected(
        address indexed token,
        address indexed receiver,
        uint256 feeAmount
    );

    event InsuranceFeesCollected(
        address indexed token,
        address indexed receiver,
        uint256 feeAmount
    );

    event FeesWithdrawn(
        address indexed token,
        address indexed to,
        uint256 amount
    );

    /// Constructor ///

    constructor(address _owner) TransferrableOwnership(_owner) {}

    /// External Methods ///

    /// @notice Collects gas fees
    /// @param tokenAddress The address of the token to collect
    /// @param feeAmount The amount of fees to collect
    /// @param receiver The address to send gas to on the destination chain
    function collectTokenGasFees(
        address tokenAddress,
        uint256 feeAmount,
        address receiver
    ) external {
        LibAsset.depositAsset(tokenAddress, feeAmount);
        emit GasFeesCollected(tokenAddress, receiver, feeAmount);
    }

    /// @notice Collects gas fees in native token
    /// @param feeAmount The amount of native token to collect
    /// @param receiver The address to send gas to on destination chain
    function collectNativeGasFees(
        uint256 feeAmount,
        address receiver
    ) external payable {
        if (msg.value < feeAmount) revert NotEnoughNativeForFees();
        uint256 remaining = msg.value - (feeAmount);
        // Prevent extra native token from being locked in the contract
        if (remaining > 0) {
            (bool success, ) = payable(msg.sender).call{ value: remaining }(
                ""
            );
            if (!success) {
                revert TransferFailure();
            }
        }
        emit GasFeesCollected(LibAsset.NULL_ADDRESS, receiver, feeAmount);
    }

    /// @notice Collects insurance fees
    /// @param tokenAddress The address of the token to collect
    /// @param feeAmount The amount of fees to collect
    /// @param receiver The address to insure
    function collectTokenInsuranceFees(
        address tokenAddress,
        uint256 feeAmount,
        address receiver
    ) external {
        LibAsset.depositAsset(tokenAddress, feeAmount);
        emit InsuranceFeesCollected(tokenAddress, receiver, feeAmount);
    }

    /// @notice Collects insurance fees in native token
    /// @param feeAmount The amount of native token to collect
    /// @param receiver The address to insure
    function collectNativeInsuranceFees(
        uint256 feeAmount,
        address receiver
    ) external payable {
        if (msg.value < feeAmount) revert NotEnoughNativeForFees();
        uint256 remaining = msg.value - (feeAmount);
        // Prevent extra native token from being locked in the contract
        if (remaining > 0) {
            (bool success, ) = payable(msg.sender).call{ value: remaining }(
                ""
            );
            if (!success) {
                revert TransferFailure();
            }
        }
        emit InsuranceFeesCollected(
            LibAsset.NULL_ADDRESS,
            receiver,
            feeAmount
        );
    }

    /// @notice Withdraws fees
    /// @param tokenAddress The address of the token to withdraw fees for
    function withdrawFees(address tokenAddress) external onlyOwner {
        uint256 balance = LibAsset.getOwnBalance(tokenAddress);
        LibAsset.transferAsset(tokenAddress, payable(msg.sender), balance);
        emit FeesWithdrawn(tokenAddress, msg.sender, balance);
    }

    /// @notice Batch withdraws fees
    /// @param tokenAddresses The addresses of the tokens to withdraw fees for
    function batchWithdrawFees(
        address[] memory tokenAddresses
    ) external onlyOwner {
        uint256 length = tokenAddresses.length;
        uint256 balance;
        for (uint256 i = 0; i < length; ) {
            balance = LibAsset.getOwnBalance(tokenAddresses[i]);
            LibAsset.transferAsset(
                tokenAddresses[i],
                payable(msg.sender),
                balance
            );
            emit FeesWithdrawn(tokenAddresses[i], msg.sender, balance);
            unchecked {
                ++i;
            }
        }
    }
}
