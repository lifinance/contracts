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
import { InformationMismatch, InvalidConfig, InvalidReceiver } from "../Errors/GenericErrors.sol";

/// @title Chainflip Facet
/// @author LI.FI (https://li.fi)
/// @notice Allows bridging assets via Chainflip
/// @custom:version 1.0.0
contract ChainflipFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Events ///
    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint256 indexed destinationChainId,
        bytes receiver
    );

    /// Errors ///
    error EmptyNonEvmAddress();
    error UnsupportedChainflipChainId();

    /// Storage ///

    // solhint-disable-next-line immutable-vars-naming
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

    /// @notice Parameters specific to Chainflip bridge operations
    /// @param nonEVMReceiver Destination address for non-EVM chains (Solana, Bitcoin)
    /// @param dstToken Chainflip specific token identifier on the destination chain
    /// @param dstCallReceiver Receiver contract address used for destination calls. Ignored if no destination call
    /// @param dstCallSwapData Swap data to be used in destination calls. Ignored if no destination call
    /// @param gasAmount Gas budget for the call on the destination chain
    /// @param cfParameters Additional parameters for future features
    struct ChainflipData {
        bytes nonEVMReceiver;
        uint32 dstToken;
        address dstCallReceiver;
        LibSwap.SwapData[] dstCallSwapData;
        uint256 gasAmount;
        bytes cfParameters;
    }

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _chainflipVault Address of the Chainflip vault contract
    constructor(IChainflipVault _chainflipVault) {
        if (address(_chainflipVault) == address(0)) {
            revert InvalidConfig();
        }
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
    /// @param _chainflipData Data specific to Chainflip, including Chainflip token identifiers and parameters
    /// @dev Handles both EVM and non-EVM destinations, native and ERC20 tokens, and cross-chain messaging
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        ChainflipData calldata _chainflipData
    ) internal {
        uint32 dstChain = _getChainflipChainId(_bridgeData.destinationChainId);
        bool isNativeAsset = LibAsset.isNativeAsset(
            _bridgeData.sendingAssetId
        );

        // Handle address encoding based on destination chain type
        bytes memory encodedDstAddress;
        if (_bridgeData.receiver == LibAsset.NON_EVM_ADDRESS) {
            if (_chainflipData.nonEVMReceiver.length == 0) {
                revert EmptyNonEvmAddress();
            }
            encodedDstAddress = _chainflipData.nonEVMReceiver;

            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _chainflipData.nonEVMReceiver
            );
        } else {
            // For EVM chains, use dstCallReceiver if there's a destination call, otherwise use bridge receiver
            address receiverAddress = _bridgeData.hasDestinationCall
                ? _chainflipData.dstCallReceiver
                : _bridgeData.receiver;

            if (receiverAddress == address(0)) {
                revert InvalidReceiver();
            }

            encodedDstAddress = abi.encodePacked(receiverAddress);
        }

        // Handle ERC20 token approval outside the if/else to avoid code duplication
        if (!isNativeAsset) {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(chainflipVault),
                _bridgeData.minAmount
            );
        }

        // Handle destination calls
        if (_bridgeData.hasDestinationCall) {
            if (_chainflipData.dstCallSwapData.length == 0) {
                revert InformationMismatch();
            }

            bytes memory message = abi.encode(
                _bridgeData.transactionId,
                _chainflipData.dstCallSwapData,
                _bridgeData.receiver
            );

            if (isNativeAsset) {
                chainflipVault.xCallNative{ value: _bridgeData.minAmount }(
                    dstChain,
                    encodedDstAddress,
                    _chainflipData.dstToken,
                    message,
                    _chainflipData.gasAmount,
                    _chainflipData.cfParameters
                );
            } else {
                chainflipVault.xCallToken(
                    dstChain,
                    encodedDstAddress,
                    _chainflipData.dstToken,
                    message,
                    _chainflipData.gasAmount,
                    IERC20(_bridgeData.sendingAssetId),
                    _bridgeData.minAmount,
                    _chainflipData.cfParameters
                );
            }
        } else {
            if (_chainflipData.dstCallSwapData.length > 0) {
                revert InformationMismatch();
            }

            if (isNativeAsset) {
                chainflipVault.xSwapNative{ value: _bridgeData.minAmount }(
                    dstChain,
                    encodedDstAddress,
                    _chainflipData.dstToken,
                    _chainflipData.cfParameters
                );
            } else {
                chainflipVault.xSwapToken(
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

    /// @notice Converts LiFi internal chain IDs to Chainflip chain IDs
    /// @param destinationChainId The LiFi chain ID to convert
    /// @return The corresponding Chainflip chain ID
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
