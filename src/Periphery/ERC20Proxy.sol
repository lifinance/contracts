// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { UnAuthorized, InvalidConfig } from "../Errors/GenericErrors.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";

/// @title ERC20 Proxy
/// @author LI.FI (https://li.fi)
/// @notice Proxy contract for safely transferring ERC20 tokens for swaps/executions
/// @custom:version 1.2.0
contract ERC20Proxy is WithdrawablePeriphery {
    /// Storage ///
    mapping(address => bool) public authorizedCallers;

    /// Events ///
    event AuthorizationChanged(address indexed caller, bool authorized);

    /// @param _owner The owner of the contract (typically refundWallet). Must be non-zero.
    /// @param _executorAddress Predicted CREATE3 address of the Executor. The Executor is deployed
    /// *after* this proxy (its constructor needs the proxy address), but its CREATE3 address is known
    /// beforehand — so we authorize it here at construction and the proxy is fully configured from the
    /// start. This avoids a post-deploy setAuthorizedCaller, which is onlyOwner (= refundWallet) and so
    /// cannot be sent by the deploy wallet. Zero is allowed and skips pre-authorization (legacy/standalone
    /// deploys that authorize the Executor later via setAuthorizedCaller).
    constructor(
        address _owner,
        address _executorAddress
    ) WithdrawablePeriphery(_owner) {
        if (_owner == address(0)) revert InvalidConfig();
        if (_executorAddress != address(0)) {
            authorizedCallers[_executorAddress] = true;
            emit AuthorizationChanged(_executorAddress, true);
        }
    }

    /// @notice Sets whether or not a specified caller is authorized to call this contract
    /// @param caller the caller to change authorization for
    /// @param authorized specifies whether the caller is authorized (true/false)
    function setAuthorizedCaller(
        address caller,
        bool authorized
    ) external onlyOwner {
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
