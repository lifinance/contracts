// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.17;

import { IAxelarExecutable } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarExecutable.sol";
import { IAxelarGateway } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGateway.sol";
import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ExcessivelySafeCall } from "../Helpers/ExcessivelySafeCall.sol";

/// @title Axelar Executor
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing using Axelar
/// @custom:version 1.0.0
contract AxelarExecutor is IAxelarExecutable, Ownable, ReentrancyGuard {
    using LibBytes for bytes;
    using SafeERC20 for IERC20;
    using ExcessivelySafeCall for address;

    /// Errors ///
    error UnAuthorized();
    error ExecutionFailed();
    error NotAContract();

    /// Events ///
    event AxelarGatewaySet(address indexed gateway);
    event AxelarExecutionComplete(address indexed callTo, bytes4 selector);
    event AxelarExecutionFailed(
        address indexed callTo,
        bytes4 selector,
        address recoveryAddress
    );

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

        if (callTo == address(gateway)) revert UnAuthorized();
        if (!LibAsset.isContract(callTo)) revert NotAContract();

        // The remaining bytes should be calldata
        bytes memory callData = payload[20:];

        (bool success, ) = callTo.excessivelySafeCall(
            gasleft(),
            0,
            0,
            callData
        );
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
        address recoveryAddress = payload.toAddress(20);
        // The remaining bytes should be calldata
        bytes memory callData = payload[40:];
        // get ERC-20 address from gateway
        address tokenAddress = gateway.tokenAddresses(tokenSymbol);

        if (callTo == address(gateway) || !LibAsset.isContract(callTo)) {
            return
                _handleFailedExecution(
                    callTo,
                    bytes4(callData),
                    tokenAddress,
                    recoveryAddress,
                    amount
                );
        }

        // transfer received tokens to the recipient
        IERC20(tokenAddress).safeApprove(callTo, 0);
        IERC20(tokenAddress).safeApprove(callTo, amount);

        (bool success, ) = callTo.excessivelySafeCall(
            gasleft(),
            0,
            0,
            callData
        );
        if (!success) {
            return
                _handleFailedExecution(
                    callTo,
                    bytes4(callData),
                    tokenAddress,
                    recoveryAddress,
                    amount
                );
        }

        // leftover tokens not used by the contract
        uint256 allowanceLeft = IERC20(tokenAddress).allowance(
            address(this),
            callTo
        );
        if (allowanceLeft > 0) {
            IERC20(tokenAddress).safeTransfer(recoveryAddress, allowanceLeft);
        }
    }

    /// Internal Methods ///

    /// @dev handles a failed execution and sends tokens to a specified receiver
    /// @notice handles a failed execution and sends tokens to a specified receiver
    /// @param callTo The contract address to call
    /// @param selector The method called
    /// @param tokenAddress The token being sent with the call
    /// @param recoveryAddress The addres to send tokens to in case of failure
    /// @param amount Amount of tokens to send
    function _handleFailedExecution(
        address callTo,
        bytes4 selector,
        address tokenAddress,
        address recoveryAddress,
        uint256 amount
    ) private {
        emit AxelarExecutionFailed(callTo, selector, recoveryAddress);
        IERC20(tokenAddress).safeApprove(callTo, 0);
        IERC20(tokenAddress).safeTransfer(recoveryAddress, amount);
    }
}
