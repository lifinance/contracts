// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { IAxelarGasService } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGasService.sol";
import { IAxelarGateway } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGateway.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { RecoveryAddressCannotBeZero, NativeAssetNotSupported, TokenNotSupported, InvalidAmount } from "../Errors/GenericErrors.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

contract AxelarFacet {
    /// Storage
    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.axelar");

    /// Events ///
    event LifiXChainTXStarted(uint256 indexed destinationChain, address indexed callTo, bytes callData);

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
        uint256 destinationChain,
        address destinationAddress,
        address callTo,
        bytes calldata callData
    ) external payable {
        Storage storage s = getStorage();
        bytes memory payload = abi.encodePacked(callTo, callData);

        string memory _destinationChain = Strings.toHexString(destinationChain);
        string memory _destinationAddress = Strings.toHexString(destinationAddress);

        // Pay gas up front
        s.gasReceiver.payNativeGasForContractCall{ value: msg.value }(
            address(this),
            _destinationChain,
            _destinationAddress,
            payload,
            msg.sender
        );

        s.gateway.callContract(_destinationChain, _destinationAddress, payload);
        emit LifiXChainTXStarted(destinationChain, callTo, callData);
    }

    /// @notice Initiates a cross-chain contract call while sending a token via Axelar Network
    /// @param destinationChain the chain to execute on
    /// @param destinationAddress the address of the LiFi contract on the destinationChain
    /// @param token the address of token to send with the transaction
    /// @param amount the amount of tokens to send
    /// @param callTo the address of the contract to call
    /// @param callData the encoded calldata for the contract call
    function executeCallWithTokenViaAxelar(
        uint256 destinationChain,
        address destinationAddress,
        address token,
        uint256 amount,
        address callTo,
        address recoveryAddress,
        bytes calldata callData
    ) external payable {
        if (recoveryAddress == address(0)) {
            revert RecoveryAddressCannotBeZero();
        }
        if (LibAsset.isNativeAsset(token)) {
            revert NativeAssetNotSupported();
        }
        if (amount == 0) {
            revert InvalidAmount();
        }

        string memory tokenSymbol = ERC20(token).symbol();
        Storage storage s = getStorage();
        {
            address tokenAddress = s.gateway.tokenAddresses(tokenSymbol);
            if (tokenAddress == address(0)) {
                revert TokenNotSupported();
            }
            LibAsset.transferFromERC20(tokenAddress, msg.sender, address(this), amount);
            LibAsset.maxApproveERC20(IERC20(tokenAddress), address(s.gateway), amount);
        }

        bytes memory payload = abi.encodePacked(callTo, recoveryAddress, callData);
        string memory _destinationChain = Strings.toHexString(destinationChain);
        string memory _destinationAddress = Strings.toHexString(destinationAddress);

        // Pay gas up front
        if (msg.value > 0) {
            _payGasWithToken(s, _destinationChain, _destinationAddress, tokenSymbol, amount, payload);
        }

        s.gateway.callContractWithToken(_destinationChain, _destinationAddress, payload, tokenSymbol, amount);
        emit LifiXChainTXStarted(destinationChain, callTo, callData);
    }

    function _payGasWithToken(
        Storage storage s,
        string memory destinationChain,
        string memory destinationAddress,
        string memory symbol,
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
