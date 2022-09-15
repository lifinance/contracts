// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

/// @title ERC20 Proxy
/// @author LI.FI (https://li.fi)
/// @notice Proxy contract for safely transferring ERC20 tokens for swaps/executions
contract ERC20Proxy is Ownable {
    /// Storage ///
    mapping(address => bool) public authorizedCallers;

    /// Errors ///
    error UnAuthorized();

    /// Events ///
    event AuthorizationChanged(address indexed caller, bool authorized);

    /// Constructor
    constructor(address _owner) {
        transferOwnership(_owner);
    }

    /// @notice Sets whether or not a specified caller is authorized to call this contract
    /// @param caller the caller to change authorization for
    /// @param authorized specifies whether the caller is authorized (true/false)
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit AuthorizationChanged(caller, authorized);
    }

    /// @notice Transfers tokens from one address to another specified address
    /// @param tokenAddress the ERC20 contract address of the token to send
    /// @param from the address to transfer from
    /// @param to the address to transfer to
    /// @param amount the amount of tokens to send
    function transferFrom(
        address tokenAddress,
        address from,
        address to,
        uint256 amount
    ) external {
        if (!authorizedCallers[msg.sender]) revert UnAuthorized();

        LibAsset.transferFromERC20(tokenAddress, from, to, amount);
    }
}
