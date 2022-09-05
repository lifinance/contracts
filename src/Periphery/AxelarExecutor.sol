// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.13;

import { IAxelarExecutable } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarExecutable.sol";
import { IAxelarGateway } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGateway.sol";
import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";

contract AxelarExecutor is IAxelarExecutable, Ownable, ReentrancyGuard {
    using LibBytes for bytes;
    using SafeERC20 for IERC20;

    /// Errors ///
    error ExecutionFailed();

    /// Events ///
    event AxelarGatewaySet(address indexed gateway);
    event AxelarExecutionComplete(address indexed callTo, bytes4 selector);

    /// Constructor ///
    constructor(address _owner, address _gateway) IAxelarExecutable(_gateway) {
        transferOwnership(_owner);
        emit AxelarGatewaySet(_gateway);
    }

    /// External Methods ///

    /// @notice set the Axelar gateway
    /// @param _gateway the Axelar gateway address
    function setAxelarGateway(address _gateway) external onlyOwner {
        gateway = IAxelarGateway(_gateway);
        emit AxelarGatewaySet(_gateway);
    }

    /// Internal Methods ///

    /// @dev override of IAxelarExecutable _execute()
    /// @notice handles the parsing and execution of the payload
    /// @param payload the abi.encodePacked payload [callTo:callData]
    function _execute(
        string memory,
        string memory,
        bytes calldata payload
    ) internal override nonReentrant {
        // The first 20 bytes of the payload are the callee address
        address callTo = payload.toAddress(0);

        // The remaining bytes should be calldata
        bytes memory callData = payload.slice(20, payload.length - 20);

        (bool success, ) = callTo.call(callData);
        if (!success) revert ExecutionFailed();
        emit AxelarExecutionComplete(callTo, bytes4(callData));
    }

    /// @dev override of IAxelarExecutable _executeWithToken()
    /// @notice handles the parsing and execution of the payload
    /// @param payload the abi.encodePacked payload [callTo:callData]
    /// @param tokenSymbol symbol of the token being bridged
    /// @param amount of tokens being bridged
    function _executeWithToken(
        string memory,
        string memory,
        bytes calldata payload,
        string memory tokenSymbol,
        uint256 amount
    ) internal override nonReentrant {
        // The first 20 bytes of the payload are the callee address
        address callTo = payload.toAddress(0);

        // The remaining bytes should be calldata
        bytes memory callData = payload.slice(20, payload.length - 20);

        // get ERC-20 address from gateway
        address tokenAddress = gateway.tokenAddresses(tokenSymbol);

        // transfer received tokens to the recipient
        IERC20(tokenAddress).safeApprove(callTo, amount);

        (bool success, ) = callTo.call(callData);
        if (!success) revert ExecutionFailed();
    }
}
