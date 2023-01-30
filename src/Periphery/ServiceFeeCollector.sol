// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

/// @title Service Fee Collector
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for collecting service fees
contract ServiceFeeCollector is TransferrableOwnership {
    /// Events ///
    event GasFeeCollected(
        address receiver,
        uint256 dstChainId,
        uint256 amountCollected
    );
    event InsuranceFeeCollected(
        address receiver,
        uint256 dstChainId,
        uint256 amountCollected
    );

    /// Constructor ///
    constructor(address _owner) TransferrableOwnership(_owner) {}

    /// External Methods ///

    /// @notice Collects the gas fee from the caller
    /// @param receiver The address to send the collected gas fee to
    /// @param dstChainId The chain ID of the destination chain
    function collectGasFee(address receiver, uint256 dstChainId) external {
        emit GasFeeCollected(receiver, dstChainId, msg.value);
    }

    /// @notice Collects the insurance fee from the caller
    /// @param receiver The address to send the collected insurance fee to
    /// @param dstChainId The chain ID of the destination chain
    function collectInsuranceFee(address receiver, uint256 dstChainId)
        external
    {
        emit InsuranceFeeCollected(receiver, dstChainId, msg.value);
    }

    /// @notice Withdraws native asset from the contract
    function withdraw() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }
}
