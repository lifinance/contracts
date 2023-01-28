// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

/// @title Service Fee Collector
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for collecting service fees
contract ServiceFeeCollector is TransferrableOwnership {
    /// Events ///
    event GasFeeCollected();
    event InsuranceFeeCollected();

    /// Constructor ///
    constructor(address _owner) TransferrableOwnership(_owner) {}

    /// External Methods ///

    /// @notice Collects the gas fee from the caller
    /// @param _gasFee The gas fee to collect
    function collectGasFee(uint256 _gasFee) external {
        emit GasFeeCollected();
    }

    /// @notice Collects the insurance fee from the caller
    /// @param _insuranceFee The insurance fee to collect
    function collectInsuranceFee(uint256 _insuranceFee) external {
        emit InsuranceFeeCollected();
    }
}
