// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { IBlast } from "../Interfaces/IBlast.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title BlastGasFeeFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for configuring and claiming gas fees on the Blast network
/// @custom:version 1.0.0
contract BlastGasFeeFacet {
    /// Storage ///

    /// @notice Blast precompile address for gas fee management
    IBlast public constant BLAST =
        IBlast(0x4300000000000000000000000000000000000002);

    /// @notice The address that will receive claimed gas fees
    address public immutable GAS_FEE_RECIPIENT;

    /// Events ///

    /// @notice Emitted when gas mode is configured
    event GasModeConfigured();

    /// @notice Emitted when gas fees are claimed
    /// @param recipient The address that received the gas fees
    /// @param amount The amount of gas fees claimed
    event GasFeesClaimed(address indexed recipient, uint256 amount);

    /// Constructor ///

    /// @notice Initializes the BlastGasFeeFacet contract
    /// @param _gasFeeRecipient The address that will receive claimed gas fees
    constructor(address _gasFeeRecipient) {
        if (_gasFeeRecipient == address(0)) {
            revert InvalidConfig();
        }
        GAS_FEE_RECIPIENT = _gasFeeRecipient;
    }

    /// External Methods ///

    /// @notice Configures the contract to use claimable gas mode
    /// @dev This enables the contract to accumulate gas fees. Can be called multiple times safely.
    function configureGasMode() external {
        LibDiamond.enforceIsContractOwner();

        BLAST.configureClaimableGas();

        emit GasModeConfigured();
    }

    /// @notice Claims all accumulated gas fees and sends them to the configured recipient
    function claimGasFees() external {
        LibDiamond.enforceIsContractOwner();

        uint256 amount = BLAST.claimAllGas(address(this), GAS_FEE_RECIPIENT);

        emit GasFeesClaimed(GAS_FEE_RECIPIENT, amount);
    }
}
