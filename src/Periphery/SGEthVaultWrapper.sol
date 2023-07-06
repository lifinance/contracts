// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ISGEthVault } from "../Interfaces/ISGEthVault.sol";

/// @title SGEthVaultWrapper
/// @author LI.FI (https://li.fi)
/// @notice Wrapper for wrapping ETH into sgETH for use as part of a swap step
/// @custom:version 1.0.0
contract SGEthVaultWrapper is ReentrancyGuard {
    using SafeERC20 for ISGEthVault;

    /// State

    /// @notice Address of the sgETH vault
    ISGEthVault public immutable sgEthVault;

    /// constructor

    /// @param _sgEthVault Address of the sgETH vault
    constructor(ISGEthVault _sgEthVault) {
        sgEthVault = _sgEthVault;
    }

    /// @notice Wrap ETH into sgETH
    function deposit() external payable nonReentrant {
        sgEthVault.deposit{ value: msg.value }();
        sgEthVault.safeTransfer(msg.sender, msg.value);
    }

    /// @notice Unwrap sgETH into ETH
    /// @param amount Amount of sgETH to unwrap
    function withdraw(uint256 amount) external nonReentrant {
        sgEthVault.safeTransferFrom(msg.sender, address(this), amount);
        sgEthVault.withdraw(amount);
        LibAsset.transferAsset(address(0), payable(msg.sender), amount);
    }
}
