// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
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
    address public immutable chainflipVault;

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
    /// @param dstToken Token to be received on the destination chain (uint32)
    /// @param cfParameters Additional metadata for future features (currently unused)
    struct ChainflipData {
        uint32 dstToken;
        bytes32 nonEvmAddress;
        bytes cfParameters;
    }

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _chainflipVault Address of the Chainflip vault contract
    constructor(address _chainflipVault) {
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

    /// @dev Contains the business logic for the bridge via Chainflip
    /// @param _bridgeData The core information needed for bridging
    /// @param _chainflipData Data specific to Chainflip
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        ChainflipData calldata _chainflipData
    ) internal {
        // Map the destination chain ID to Chainflip format
        uint32 dstChain;
        if (_bridgeData.destinationChainId == CHAIN_ID_ETHEREUM) {
            dstChain = CHAINFLIP_ID_ETHEREUM;
        } else if (_bridgeData.destinationChainId == CHAIN_ID_ARBITRUM) {
            dstChain = CHAINFLIP_ID_ARBITRUM;
        } else if (_bridgeData.destinationChainId == CHAIN_ID_SOLANA) {
            dstChain = CHAINFLIP_ID_SOLANA;
        } else if (_bridgeData.destinationChainId == CHAIN_ID_BITCOIN) {
            dstChain = CHAINFLIP_ID_BITCOIN;
        } else {
            revert("ChainflipFacet: Unsupported destination chain");
        }

        // Handle address encoding based on destination chain type
        bytes memory encodedDstAddress;
        if (_bridgeData.receiver == LibAsset.NON_EVM_ADDRESS) {
            // For non-EVM chains (Solana, Bitcoin), use the raw bytes32 from chainflipData
            if (_chainflipData.nonEvmAddress == bytes32(0)) {
                revert EmptyNonEvmAddress();
            }
            encodedDstAddress = abi.encodePacked(_chainflipData.nonEvmAddress);

            // Emit special event for non-EVM transfers
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _chainflipData.nonEvmAddress
            );
        } else {
            // For EVM chains, encode the address
            encodedDstAddress = abi.encodePacked(_bridgeData.receiver);
        }

        // Validate destination call flag matches message presence
        if (
            _bridgeData.hasDestinationCall !=
            (_chainflipData.cfParameters.length > 0)
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
                    _chainflipData.cfParameters, // Used as message for CCM
                    0, // Gas budget - currently unused by Chainflip
                    _chainflipData.cfParameters // Additional parameters
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
                chainflipVault,
                _bridgeData.minAmount
            );

            if (_bridgeData.hasDestinationCall) {
                IChainflipVault(chainflipVault).xCallToken(
                    dstChain,
                    encodedDstAddress,
                    _chainflipData.dstToken,
                    _chainflipData.cfParameters, // Used as message for CCM
                    0, // Gas budget - currently unused by Chainflip
                    IERC20(_bridgeData.sendingAssetId),
                    _bridgeData.minAmount,
                    _chainflipData.cfParameters // Additional parameters
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
}
