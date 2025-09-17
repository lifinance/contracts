// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAllBridge } from "../Interfaces/IAllBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { InvalidConfig, InvalidNonEVMReceiver, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";

/// @title Allbridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through AllBridge
/// @custom:version 2.1.1
contract AllBridgeFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    uint256 private constant ALLBRIDGE_ID_ETHEREUM = 1;
    uint256 private constant ALLBRIDGE_ID_BSC = 2;
    uint256 private constant ALLBRIDGE_ID_TRON = 3;
    uint256 private constant ALLBRIDGE_ID_SOLANA = 4;
    uint256 private constant ALLBRIDGE_ID_POLYGON = 5;
    uint256 private constant ALLBRIDGE_ID_ARBITRUM = 6;
    uint256 private constant ALLBRIDGE_ID_AVALANCHE = 8;
    uint256 private constant ALLBRIDGE_ID_BASE = 9;
    uint256 private constant ALLBRIDGE_ID_OPTIMISM = 10;
    uint256 private constant ALLBRIDGE_ID_CELO = 11;
    uint256 private constant ALLBRIDGE_ID_SONIC = 12;
    uint256 private constant ALLBRIDGE_ID_SUI = 13;
    uint256 private constant ALLBRIDGE_ID_UNICHAIN = 14;

    error UnsupportedAllBridgeChainId();

    /// @notice The contract address of the AllBridge router on the source chain.
    // solhint-disable-next-line immutable-vars-naming
    IAllBridge private immutable ALLBRIDGE;

    /// @notice The struct for the AllBridge data.
    /// @param recipient The address of the token receiver after bridging.
    /// @param fees The amount of token to pay the messenger and the bridge
    /// @param receiveToken The token to receive on the destination chain.
    /// @param nonce A random nonce to associate with the tx.
    /// @param messenger The messenger protocol enum
    /// @param payFeeWithSendingAsset Whether to pay the relayer fee with the sending asset or not
    struct AllBridgeData {
        bytes32 recipient;
        uint256 fees;
        bytes32 receiveToken;
        uint256 nonce;
        IAllBridge.MessengerProtocol messenger;
        bool payFeeWithSendingAsset;
    }

    /// @notice Initializes the AllBridge contract
    /// @param _allBridge The address of the AllBridge contract
    constructor(IAllBridge _allBridge) {
        if (address(_allBridge) == address(0)) revert InvalidConfig();

        ALLBRIDGE = _allBridge;
    }

    /// @notice Bridge tokens to another chain via AllBridge
    /// @param _bridgeData The bridge data struct
    function startBridgeTokensViaAllBridge(
        ILiFi.BridgeData memory _bridgeData,
        AllBridgeData calldata _allBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _allBridgeData);
    }

    /// @notice Bridge tokens to another chain via AllBridge
    /// @param _bridgeData The bridge data struct
    /// @param _swapData The swap data struct
    /// @param _allBridgeData The AllBridge data struct
    function swapAndStartBridgeTokensViaAllBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AllBridgeData calldata _allBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _allBridgeData);
    }

    /// @notice Bridge tokens to another chain via AllBridge
    /// @param _bridgeData The bridge data struct
    /// @param _allBridgeData The allBridge data struct for AllBridge specicific data
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AllBridgeData calldata _allBridgeData
    ) internal {
        // we do not validate _allBridgeData.fees here due to gas optimization reasons
        // our backend ensures that the fees are correct

        // get allbridge (custom) destination chain id
        uint256 destinationChainId = _getAllBridgeChainId(
            _bridgeData.destinationChainId
        );

        // validate receiver address
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            // destination chain is non-EVM
            // make sure it's non-zero (we cannot validate further)
            if (_allBridgeData.recipient == bytes32(0))
                revert InvalidNonEVMReceiver();

            // emit event for non-EVM chain
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                destinationChainId,
                _allBridgeData.recipient
            );
        } else {
            // destination chain is EVM
            // make sure that bridgeData and allBridgeData receiver addresses match
            if (
                _bridgeData.receiver !=
                address(uint160(uint256(_allBridgeData.recipient)))
            ) revert InvalidReceiver();
        }

        // set max approval to allBridge, if current allowance is insufficient
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(ALLBRIDGE),
            _bridgeData.minAmount
        );

        // check if bridge fee should be paid with sending or native asset
        if (_allBridgeData.payFeeWithSendingAsset) {
            // pay fee with sending asset
            ALLBRIDGE.swapAndBridge(
                bytes32(uint256(uint160(_bridgeData.sendingAssetId))),
                _bridgeData.minAmount,
                _allBridgeData.recipient,
                destinationChainId,
                _allBridgeData.receiveToken,
                _allBridgeData.nonce,
                _allBridgeData.messenger,
                _allBridgeData.fees
            );
        } else {
            // pay fee with native asset
            ALLBRIDGE.swapAndBridge{ value: _allBridgeData.fees }(
                bytes32(uint256(uint160(_bridgeData.sendingAssetId))),
                _bridgeData.minAmount,
                _allBridgeData.recipient,
                destinationChainId,
                _allBridgeData.receiveToken,
                _allBridgeData.nonce,
                _allBridgeData.messenger,
                0
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Converts LiFi internal chain IDs to AllBridge chain IDs
    /// @param _destinationChainId The LiFi chain ID to convert
    /// @return The corresponding Chainflip chain ID
    /// @dev Reverts if the destination chain is not supported
    function _getAllBridgeChainId(
        uint256 _destinationChainId
    ) internal pure returns (uint256) {
        // first try to match cases where chainId is the same and does not need to be mapped
        if (
            _destinationChainId == ALLBRIDGE_ID_ETHEREUM ||
            _destinationChainId == ALLBRIDGE_ID_OPTIMISM
        ) return _destinationChainId;
        // all others have custom chainIds
        else if (_destinationChainId == LIFI_CHAIN_ID_BSC)
            return ALLBRIDGE_ID_BSC;
        else if (_destinationChainId == LIFI_CHAIN_ID_TRON)
            return ALLBRIDGE_ID_TRON;
        else if (_destinationChainId == LIFI_CHAIN_ID_SOLANA)
            return ALLBRIDGE_ID_SOLANA;
        else if (_destinationChainId == LIFI_CHAIN_ID_POLYGON)
            return ALLBRIDGE_ID_POLYGON;
        else if (_destinationChainId == LIFI_CHAIN_ID_ARBITRUM)
            return ALLBRIDGE_ID_ARBITRUM;
        else if (_destinationChainId == LIFI_CHAIN_ID_AVALANCHE)
            return ALLBRIDGE_ID_AVALANCHE;
        else if (_destinationChainId == LIFI_CHAIN_ID_BASE)
            return ALLBRIDGE_ID_BASE;
        else if (_destinationChainId == LIFI_CHAIN_ID_CELO)
            return ALLBRIDGE_ID_CELO;
        else if (_destinationChainId == LIFI_CHAIN_ID_SUI)
            return ALLBRIDGE_ID_SUI;
        else if (_destinationChainId == LIFI_CHAIN_ID_SONIC)
            return ALLBRIDGE_ID_SONIC;
        else if (_destinationChainId == LIFI_CHAIN_ID_UNICHAIN)
            return ALLBRIDGE_ID_UNICHAIN;
        // revert if no match found
        else revert UnsupportedAllBridgeChainId();
    }
}
