// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ILiFi} from "../Interfaces/ILiFi.sol";
import {ITokenMessenger} from "../Interfaces/ITokenMessenger.sol";
import {LiFiData} from "../Helpers/LiFiData.sol";
import {LibAsset} from "../Libraries/LibAsset.sol";
import {LibUtil} from "../Libraries/LibUtil.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ILiFi} from "../Interfaces/ILiFi.sol";
import {ITokenMessenger} from "../Interfaces/ITokenMessenger.sol";
import {LiFiData} from "../Helpers/LiFiData.sol";
import {LibAsset} from "../Libraries/LibAsset.sol";
import {LibSwap} from "../Libraries/LibSwap.sol";
import {SwapperV2} from "../Helpers/SwapperV2.sol";
import {Validatable} from "../Helpers/Validatable.sol";
import {InvalidReceiver, InvalidAmount, CannotBridgeToSameNetwork, InvalidConfig} from "../Errors/GenericErrors.sol";
import {InvalidCallData} from "../Errors/GenericErrors.sol";
import {LibDiamond} from "../Libraries/LibDiamond.sol";

struct PolymerCCTPData {
    // Token fee taken in USDC by the facet (optional; may be zero)
    uint256 polymerTokenFee;
    // CCTP fee caps/params
    uint256 maxCCTPFee;
    bytes32 nonEvmAddress; // Should only be nonzero if submitting to a nonEvm chain
    uint32 minFinalityThreshold; // MinFinalityThreshold for CCTP bridge, will be passed directly to tokenMessenger.depositForBurn method. Currently, the threshold < 1000 corresponds to fast path
}

/// @title PolymerCCTPFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging USDC through Polymer CCTP
/// @custom:version 1.0.0
contract PolymerCCTPFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable, LiFiData {
    error InvalidSendingAsset(address actual, address expected);
    event PolymerCCTPFeeSent(uint256 bridgeAmount, uint256 polymerFee, uint32 minFinalityThreshold);

    ITokenMessenger public immutable TOKEN_MESSENGER;
    address public immutable USDC;
    address payable public immutable POLYMER_FEE_RECEIVER;

    // Note: We don't use validateBridgeData here due to gas optimization
    modifier validatePolymerData(ILiFi.BridgeData memory _bridgeData, PolymerCCTPData calldata _polymerData) {
        // Note: There are more checks within the _startBridge method so we don't strictly follow CEI, but this should be fine given checks should ensure that we only ever interact with USDC
        if (_bridgeData.minAmount == 0) {
            revert InvalidAmount();
        }
        if (_bridgeData.destinationChainId == block.chainid) {
            revert CannotBridgeToSameNetwork();
        }

        _;
    }

    constructor(address _tokenMessenger, address _usdc, address _polymerFeeReceiver) {
        if (_tokenMessenger == address(0) || _usdc == address(0) || _polymerFeeReceiver == address(0)) {
            revert InvalidConfig();
        }

        TOKEN_MESSENGER = ITokenMessenger(_tokenMessenger);
        USDC = _usdc;
        POLYMER_FEE_RECEIVER = payable(_polymerFeeReceiver);
    }

    /// @notice Sets a max approval from lifiDiamond to TokenMessenger
    /// It is safe to set a max approval since the diamond is designed to not hold any funds (that could otherwise be stolen if TokenMessenger turns malicious)
    /// We also don't need to store the initialization status of this facet since it will not break from being initialized multiple times (plus it's an admin-only function)
    function initPolymerCCTP() external virtual {
        LibDiamond.enforceIsContractOwner();

        // TODO - confirm during audit that:
        // 1.) We can just do a one-time max approve instead of doing an as-needed approve within the startBridge method.
        // 2.) We don't need to safeApprove and can just use approve since we're only ever transferring usdc
        IERC20(USDC).approve(address(TOKEN_MESSENGER), type(uint256).max);
    }

    /// @notice Bridges USDC via PolymerCCTP
    /// @param _bridgeData The core bridge data
    /// @param _polymerData Data specific to PolymerCCTP
    /// @notice Requires caller to approve the LifiDiamondProxy of the bridge amount + polymerFee
    function startBridgeTokensViaPolymerCCTP(ILiFi.BridgeData memory _bridgeData, PolymerCCTPData calldata _polymerData)
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validatePolymerData(_bridgeData, _polymerData)
        onlyAllowSourceToken(_bridgeData, USDC)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        // TODO: Do we need this check if it's always going to be usdc?
        LibAsset.transferFromERC20(USDC, msg.sender, address(this), _bridgeData.minAmount);

        _startBridge(_bridgeData, _polymerData);
    }

    /// @notice Performs a swap before bridging via PolymerCCTP
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _polymerData Data specific to PolymerCCTP
    function swapAndStartBridgeTokensViaPolymerCCTP(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        PolymerCCTPData calldata _polymerData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validatePolymerData(_bridgeData, _polymerData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId, _bridgeData.minAmount, _swapData, payable(msg.sender)
        );

        _startBridge(_bridgeData, _polymerData);
    }

    /// @dev Contains the business logic for the bridge via PolymerCCTP
    /// @param _bridgeData The core information needed for bridging
    /// @param _polymerData Data specific to PolymerCCTP
    function _startBridge(ILiFi.BridgeData memory _bridgeData, PolymerCCTPData calldata _polymerData) internal {
        LibAsset.transferERC20(USDC, POLYMER_FEE_RECEIVER, _polymerData.polymerTokenFee);

        // This case first for gas ops since it will likely be triggered more often
        uint256 bridgeAmount = _bridgeData.minAmount - _polymerData.polymerTokenFee;
        if (_bridgeData.receiver != NON_EVM_ADDRESS) {
            // _bridgeData.receiver != NON_EVM_ADDRESS -> mint to _bridgeData.receiver
            if (_bridgeData.receiver == address(0)) {
                revert InvalidReceiver();
            }

            TOKEN_MESSENGER.depositForBurn(
                bridgeAmount,
                _chainIdToDomainId(_bridgeData.destinationChainId),
                bytes32(uint256(uint160(_bridgeData.receiver))),
                USDC,
                bytes32(0), // Unrestricted caller
                _polymerData.maxCCTPFee, // maxFee - 0 means no fee limit
                _polymerData.minFinalityThreshold // minFinalityThreshold - use default
            );
        } else {
            // _bridgeData.receiver == NON_EVM_ADDRESS -> mint to _polymerData.nonEvmAddress
            if (_polymerData.nonEvmAddress == bytes32(0)) {
                revert InvalidReceiver();
            }
            TOKEN_MESSENGER.depositForBurn(
                bridgeAmount,
                _chainIdToDomainId(_bridgeData.destinationChainId),
                _polymerData.nonEvmAddress,
                USDC,
                bytes32(0), // Unrestricted caller
                _polymerData.maxCCTPFee, // maxFee - 0 means no fee limit
                _polymerData.minFinalityThreshold // minFinalityThreshold - use default
            );
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId, _bridgeData.destinationChainId, _polymerData.nonEvmAddress
            );
        }

        // Emitting a specific event for Polymer CCTP bridges greatly simplifies off-chain relayer filtering, despite it containing redundant information as emitted in the token messenger's depositForBurn event
        emit PolymerCCTPFeeSent(_bridgeData.minAmount, _polymerData.polymerTokenFee, _polymerData.minFinalityThreshold);

        // Emit Li.Fi standard event
        emit LiFiTransferStarted(BridgeData(
                _bridgeData.transactionId,
                _bridgeData.bridge,
                _bridgeData.integrator,
                _bridgeData.referrer,
                _bridgeData.sendingAssetId,
                _bridgeData.receiver,
                bridgeAmount,
                _bridgeData.destinationChainId,
                _bridgeData.hasSourceSwaps,
                _bridgeData.hasDestinationCall
            ));
    }

    /// @notice Get CCTP domain ID for destination chain
    /// @param chainId LIFI specific chain id
    /// @return CCTP domain ID recognized by TokenMessenger
    function _chainIdToDomainId(uint256 chainId) internal pure returns (uint32) {
        // Mainnet chain IDs
        if (chainId == 1) {
            return 0; // Ethereum
        }
        if (chainId == 43114) {
            return 1; // Avalanche
        }
        if (chainId == 10) {
            return 2; // OP Mainnet
        }
        if (chainId == 42161) {
            return 3; // Arbitrum
        }
        if (chainId == LIFI_CHAIN_ID_SOLANA) {
            return 5; // Solana
        }
        if (chainId == 8453) {
            return 6; // Base
        }
        if (chainId == 137) {
            return 7; // Polygon PoS
        }
        if (chainId == 130) {
            return 10; // Unichain
        }
        if (chainId == 59144) {
            return 11; // Linea
        }
        if (chainId == 81224) {
            return 12; // Codex
        }
        if (chainId == 146) {
            return 13; // Sonic
        }
        if (chainId == 480) {
            return 14; // World Chain
        }
        if (chainId == 1329) {
            return 16; // Sei
        }
        if (chainId == 56) {
            return 17; // BNB Smart Chain
        }
        if (chainId == 50) {
            return 18; // XDC
        }
        if (chainId == 999) {
            return 19; // HyperEVM
        }
        if (chainId == 57073) {
            return 21; // Ink
        }
        if (chainId == 98866) {
            return 22; // Plume
        }

        // Testnet chain IDs
        if (chainId == 11155111) {
            return 0; // Sepolia
        }
        if (chainId == 11155420) {
            return 2; // OP Sepolia
        }
        if (chainId == 84532) {
            return 6; // Base Sepolia
        }

        revert InvalidCallData();
    }
}
