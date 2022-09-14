// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { IAxelarGasService } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGasService.sol";
import { IAxelarGateway } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGateway.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { RecoveryAddressCannotBeZero } from "../Errors/GenericErrors.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";

contract AxelarFacet {
    /// Storage
    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.axelar");
    struct Storage {
        IAxelarGateway gateway;
        IAxelarGasService gasReceiver;
    }

    /// Init
    function initAxelar(address _gateway, address _gasReceiver) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();
        s.gateway = IAxelarGateway(_gateway);
        s.gasReceiver = IAxelarGasService(_gasReceiver);
    }

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
        Storage storage s = getStorage();
        bytes memory payload = abi.encodePacked(callTo, callData);

        // Pay gas up front
        s.gasReceiver.payNativeGasForContractCall{ value: msg.value }(
            address(this),
            destinationChain,
            destinationAddress,
            payload,
            msg.sender
        );

        s.gateway.callContract(destinationChain, destinationAddress, payload);
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

        Storage storage s = getStorage();
        {
            address tokenAddress = s.gateway.tokenAddresses(symbol);
            LibAsset.transferFromERC20(tokenAddress, msg.sender, address(this), amount);
            LibAsset.maxApproveERC20(IERC20(tokenAddress), address(s.gateway), amount);
        }
        
        bytes memory payload = abi.encodePacked(callTo, recoveryAddress, callData);

        // Pay gas up front
        if (msg.value > 0) {
            _payGasWithToken(s, destinationChain, destinationAddress, symbol, amount, payload);
        }

        s.gateway.callContractWithToken(destinationChain, destinationAddress, payload, symbol, amount);
    }

    function _payGasWithToken(
        Storage storage s,
        string calldata destinationChain,
        string calldata destinationAddress,
        string calldata symbol,
        uint256 amount,
        bytes memory payload
    ) private {
        s.gasReceiver.payNativeGasForContractCallWithToken{ value: msg.value }(
            address(this),
            destinationChain,
            destinationAddress,
            payload,
            symbol,
            amount,
            msg.sender
        );
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
