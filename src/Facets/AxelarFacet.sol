// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { IAxelarGasService } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGasService.sol";
import { IAxelarGateway } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGateway.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { RecoveryAddressCannotBeZero } from "../Errors/GenericErrors.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";

contract AxelarFacet {
    /// Storage

    /// @notice The contract address of the gateway on the source chain.
    IAxelarGateway private immutable gateway;

    /// @notice The contract address of the gas service on the source chain.
    IAxelarGasService private immutable gasService;

    /// Errors
    error SymbolDoesNotExist();

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _gateway The contract address of the gateway on the source chain.
    /// @param _gasService The contract address of the gas service on the source chain.
    constructor(IAxelarGateway _gateway, IAxelarGasService _gasService) {
        gateway = _gateway;
        gasService = _gasService;
    }

    /// External Methods ///

    /// @notice Initiates a cross-chain contract call via Axelar Network
    /// @param destinationChain the chain to execute on
    /// @param destinationAddress the address of the LiFi contract on the destinationChain
    /// @param callTo the address of the contract to call
    /// @param callData the encoded calldata for the contract call
    function executeCallViaAxelar(
        string calldata destinationChain,
        string calldata destinationAddress,
        address callTo,
        bytes calldata callData
    ) external payable {
        bytes memory payload = abi.encodePacked(callTo, callData);

        // Pay gas up front
        gasService.payNativeGasForContractCall{ value: msg.value }(
            address(this),
            destinationChain,
            destinationAddress,
            payload,
            msg.sender
        );

        gateway.callContract(destinationChain, destinationAddress, payload);
    }

    /// @notice Initiates a cross-chain contract call while sending a token via Axelar Network
    /// @param destinationChain the chain to execute on
    /// @param destinationAddress the address of the LiFi contract on the destinationChain
    /// @param symbol the symbol of the token to send with the transaction
    /// @param amount the amount of tokens to send
    /// @param callTo the address of the contract to call
    /// @param callData the encoded calldata for the contract call
    function executeCallWithTokenViaAxelar(
        string calldata destinationChain,
        string calldata destinationAddress,
        string calldata symbol,
        uint256 amount,
        address callTo,
        address recoveryAddress,
        bytes calldata callData
    ) external payable {
        if (recoveryAddress == address(0)) {
            revert RecoveryAddressCannotBeZero();
        }

        {
            address tokenAddress = gateway.tokenAddresses(symbol);
            if (LibAsset.isNativeAsset(tokenAddress)) {
                revert SymbolDoesNotExist();
            }
            LibAsset.transferFromERC20(tokenAddress, msg.sender, address(this), amount);
            LibAsset.maxApproveERC20(IERC20(tokenAddress), address(gateway), amount);
        }

        bytes memory payload = abi.encodePacked(callTo, recoveryAddress, callData);

        // Pay gas up front
        if (msg.value > 0) {
            _payGasWithToken(destinationChain, destinationAddress, symbol, amount, payload);
        }

        gateway.callContractWithToken(destinationChain, destinationAddress, payload, symbol, amount);
    }

    function _payGasWithToken(
        string calldata destinationChain,
        string calldata destinationAddress,
        string calldata symbol,
        uint256 amount,
        bytes memory payload
    ) private {
        gasService.payNativeGasForContractCallWithToken{ value: msg.value }(
            address(this),
            destinationChain,
            destinationAddress,
            payload,
            symbol,
            amount,
            msg.sender
        );
    }
}
