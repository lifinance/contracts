// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IChainflipVault } from "../Interfaces/IChainflip.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InformationMismatch } from "../Errors/GenericErrors.sol";

/// @title Chainflip Facet
/// @author LI.FI (https://li.fi)
/// @notice Allows bridging assets via Chainflip
/// @custom:version 1.0.0
contract ChainflipFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Events ///
    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint256 indexed destinationChainId,
        bytes32 receiver
    );

    /// Errors ///
    error EmptyNonEvmAddress();
    error UnsupportedChainflipChainId();

    /// Storage ///

    IChainflipVault public immutable chainflipVault;
    uint256 private constant CHAIN_ID_ETHEREUM = 1;
    uint256 private constant CHAIN_ID_ARBITRUM = 42161;
    uint256 private constant CHAIN_ID_SOLANA = 1151111081099710;
    uint256 private constant CHAIN_ID_BITCOIN = 20000000000001;
    uint32 private constant CHAINFLIP_ID_ETHEREUM = 1;
    uint32 private constant CHAINFLIP_ID_ARBITRUM = 4;
    uint32 private constant CHAINFLIP_ID_SOLANA = 5;
    uint32 private constant CHAINFLIP_ID_BITCOIN = 3;

    /// Types ///

    /// @dev Parameters specific to Chainflip bridge
    /// @param nonEVMReceiver Destination address for non-EVM chains (Solana, Bitcoin)
    /// @param dstToken Token to be received on the destination chain (uint32)
    /// @param message Message that is passed to the destination address for cross-chain messaging
    /// @param gasAmount Gas budget for the call on the destination chain
    /// @param cfParameters Additional metadata for future features
    struct ChainflipData {
        bytes32 nonEVMReceiver;
        uint32 dstToken;
        bytes message;
        uint256 gasAmount;
        bytes cfParameters;
    }

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _chainflipVault Address of the Chainflip vault contract
    constructor(IChainflipVault _chainflipVault) {
        chainflipVault = _chainflipVault;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Chainflip
    /// @param _bridgeData The core information needed for bridging
    /// @param _chainflipData Data specific to Chainflip
    function startBridgeTokensViaChainflip(
        ILiFi.BridgeData memory _bridgeData,
        ChainflipData calldata _chainflipData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _chainflipData);
    }

    /// @notice Performs a swap before bridging via Chainflip
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _chainflipData Data specific to Chainflip
    function swapAndStartBridgeTokensViaChainflip(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        ChainflipData calldata _chainflipData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _chainflipData);
    }

    /// Internal Methods ///

    /// @notice Contains the business logic for bridging via Chainflip
    /// @param _bridgeData The core information needed for bridging, including sending/receiving details
    /// @param _chainflipData Data specific to Chainflip, including destination token and parameters
    /// @dev Handles both EVM and non-EVM destinations, native and ERC20 tokens, and cross-chain messaging
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        ChainflipData calldata _chainflipData
    ) internal {
        uint32 dstChain = _getChainflipChainId(_bridgeData.destinationChainId);

        // Handle address encoding based on destination chain type
        bytes memory encodedDstAddress;
        if (_bridgeData.receiver == LibAsset.NON_EVM_ADDRESS) {
            // For non-EVM chains (Solana, Bitcoin), use the raw bytes32 from chainflipData
            if (_chainflipData.nonEVMReceiver == bytes32(0)) {
                revert EmptyNonEvmAddress();
            }
            encodedDstAddress = abi.encodePacked(
                _chainflipData.nonEVMReceiver
            );

            // Emit special event for non-EVM transfers
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _chainflipData.nonEVMReceiver
            );
        } else {
            // For EVM chains, encode the address
            encodedDstAddress = abi.encodePacked(_bridgeData.receiver);
        }

        // Validate destination call flag matches message presence
        if (
            _bridgeData.hasDestinationCall !=
            (_chainflipData.message.length > 0)
        ) {
            revert InformationMismatch();
        }

        // Handle native token case with or without CCM
        if (_bridgeData.sendingAssetId == address(0)) {
            if (_bridgeData.hasDestinationCall) {
                IChainflipVault(chainflipVault).xCallNative{
                    value: _bridgeData.minAmount
                }(
                    dstChain,
                    encodedDstAddress,
                    _chainflipData.dstToken,
                    _chainflipData.message,
                    _chainflipData.gasAmount,
                    _chainflipData.cfParameters
                );
            } else {
                IChainflipVault(chainflipVault).xSwapNative{
                    value: _bridgeData.minAmount
                }(
                    dstChain,
                    encodedDstAddress,
                    _chainflipData.dstToken,
                    _chainflipData.cfParameters
                );
            }
        }
        // Handle ERC20 token case with or without CCM
        else {
            // Approve vault to spend tokens
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(chainflipVault),
                _bridgeData.minAmount
            );

            if (_bridgeData.hasDestinationCall) {
                IChainflipVault(chainflipVault).xCallToken(
                    dstChain,
                    encodedDstAddress,
                    _chainflipData.dstToken,
                    _chainflipData.message,
                    _chainflipData.gasAmount,
                    IERC20(_bridgeData.sendingAssetId),
                    _bridgeData.minAmount,
                    _chainflipData.cfParameters
                );
            } else {
                IChainflipVault(chainflipVault).xSwapToken(
                    dstChain,
                    encodedDstAddress,
                    _chainflipData.dstToken,
                    IERC20(_bridgeData.sendingAssetId),
                    _bridgeData.minAmount,
                    _chainflipData.cfParameters
                );
            }
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Converts LiFi chain IDs to Chainflip chain IDs
    /// @param destinationChainId The LiFi chain ID to convert
    /// @return The corresponding Chainflip chain ID (uint32)
    /// @dev Supports Ethereum (1), Arbitrum (4), Solana (5), and Bitcoin (3)
    /// @dev Reverts if the destination chain is not supported
    function _getChainflipChainId(
        uint256 destinationChainId
    ) internal pure returns (uint32) {
        if (destinationChainId == CHAIN_ID_ETHEREUM) {
            return CHAINFLIP_ID_ETHEREUM;
        } else if (destinationChainId == CHAIN_ID_ARBITRUM) {
            return CHAINFLIP_ID_ARBITRUM;
        } else if (destinationChainId == CHAIN_ID_SOLANA) {
            return CHAINFLIP_ID_SOLANA;
        } else if (destinationChainId == CHAIN_ID_BITCOIN) {
            return CHAINFLIP_ID_BITCOIN;
        } else {
            revert UnsupportedChainflipChainId();
        }
    }
}
