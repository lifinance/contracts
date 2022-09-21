// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { IAxelarGasService } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGasService.sol";
import { IAxelarGateway } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGateway.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { RecoveryAddressCannotBeZero, NativeAssetNotSupported, TokenNotSupported, InvalidAmount, InvalidDestinationChain } from "../Errors/GenericErrors.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";

contract AxelarFacet is ReentrancyGuard {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.axelar");

    /// @notice The contract address of the gateway on the source chain.
    IAxelarGateway private immutable gateway;

    /// @notice The contract address of the gas service on the source chain.
    IAxelarGasService private immutable gasService;

    /// Types ///

    struct Storage {
        mapping(uint256 => string) chainIdToName;
    }

    /// @param destinationChain the chain to execute on
    /// @param destinationAddress the address of the LiFi contract on the destinationChain
    /// @param callTo the address of the contract to call
    /// @param callData the encoded calldata for the contract call
    struct AxelarCallParameters {
        uint256 destinationChain;
        address destinationAddress;
        address callTo;
        bytes callData;
    }

    /// Events ///

    event LifiXChainTXStarted(uint256 indexed destinationChain, address indexed callTo, bytes callData);
    event ChainNameRegistered(uint256 indexed chainID, string chainName);

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

    function setChainName(uint256 _chainId, string calldata _name) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();
        s.chainIdToName[_chainId] = _name;
        emit ChainNameRegistered(_chainId, _name);
    }

    /// @notice Initiates a cross-chain contract call via Axelar Network
    /// @param params the parameters for the cross-chain call
    function executeCallViaAxelar(AxelarCallParameters calldata params) external payable nonReentrant {
        Storage storage s = getStorage();
        bytes memory payload = abi.encodePacked(params.callTo, params.callData);

        string memory destinationChain = s.chainIdToName[params.destinationChain];
        if (bytes(destinationChain).length == 0) {
            revert InvalidDestinationChain();
        }
        string memory destinationAddress = Strings.toHexString(params.destinationAddress);

        // Pay gas up front
        gasService.payNativeGasForContractCall{ value: msg.value }(
            address(this),
            destinationChain,
            destinationAddress,
            payload,
            msg.sender
        );

        gateway.callContract(destinationChain, destinationAddress, payload);

        emit LifiXChainTXStarted(params.destinationChain, params.callTo, params.callData);
    }

    /// @notice Initiates a cross-chain contract call while sending a token via Axelar Network
    /// @param params the parameters for the cross-chain call
    /// @param token the address of token to send with the transaction
    /// @param amount the amount of tokens to send
    /// @param recoveryAddress the address to send the tokens to if the transaction fails on the destination chain
    function executeCallWithTokenViaAxelar(
        AxelarCallParameters calldata params,
        address token,
        uint256 amount,
        address recoveryAddress
    ) external payable nonReentrant {
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
            address tokenAddress = gateway.tokenAddresses(tokenSymbol);
            if (LibAsset.isNativeAsset(tokenAddress)) {
                revert TokenNotSupported();
            }
            LibAsset.transferFromERC20(tokenAddress, msg.sender, address(this), amount);
            LibAsset.maxApproveERC20(IERC20(tokenAddress), address(gateway), amount);
        }

        bytes memory payload = abi.encodePacked(params.callTo, recoveryAddress, params.callData);
        string memory destinationChain = s.chainIdToName[params.destinationChain];
        if (bytes(destinationChain).length == 0) {
            revert InvalidDestinationChain();
        }
        string memory destinationAddress = Strings.toHexString(params.destinationAddress);

        // Pay gas up front
        if (msg.value > 0) {
            _payGasWithToken(destinationChain, destinationAddress, tokenSymbol, amount, payload);
        }

        gateway.callContractWithToken(destinationChain, destinationAddress, payload, tokenSymbol, amount);

        emit LifiXChainTXStarted(params.destinationChain, params.callTo, params.callData);
    }

    function _payGasWithToken(
        string memory destinationChain,
        string memory destinationAddress,
        string memory symbol,
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

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
