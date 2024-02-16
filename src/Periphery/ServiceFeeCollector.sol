// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

/// @title Service Fee Collector
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for collecting service fees (gas/insurance)
/// @custom:version 1.0.1
contract ServiceFeeCollector is TransferrableOwnership {
    /// Errors ///
    error TransferFailure();
    error NotEnoughNativeForFees();

    /// Events ///
    event GasFeesCollected(
        address indexed token,
        uint256 indexed chainId,
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

    // solhint-disable-next-line no-empty-blocks
    constructor(address _owner) TransferrableOwnership(_owner) {}

    /// External Methods ///

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
    /// @param receiver The address to insure
    function collectNativeInsuranceFees(address receiver) external payable {
        emit InsuranceFeesCollected(
            LibAsset.NULL_ADDRESS,
            receiver,
            msg.value
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
        address[] calldata tokenAddresses
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
