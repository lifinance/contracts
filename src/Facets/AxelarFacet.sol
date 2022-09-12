// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { IAxelarGasService } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGasService.sol";
import { IAxelarGateway } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGateway.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { IERC20 } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IERC20.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

contract AxelarFacet {
    /// Storage
    bytes32 internal constant NAMESPACE = hex"c7ba6016a551f7f07fd4821271b8773baf38cf0831912878e266bac50e0e4a9c"; // keccak256("com.lifi.facets.axelar")
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
        string memory destinationChain,
        string memory destinationAddress,
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
        string memory destinationChain,
        string memory destinationAddress,
        string memory symbol,
        uint256 amount,
        address callTo,
        bytes calldata callData
    ) external payable {
        Storage storage s = getStorage();

        address tokenAddress = s.gateway.tokenAddresses(symbol);
        LibAsset.transferFromERC20(tokenAddress, msg.sender, address(this), amount);
        IERC20(tokenAddress).approve(address(s.gateway), amount);

        bytes memory payload = abi.encodePacked(callTo, callData);

        // Pay gas up front
        if (msg.value > 0) {
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

        s.gateway.callContractWithToken(destinationChain, destinationAddress, payload, symbol, amount);
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
