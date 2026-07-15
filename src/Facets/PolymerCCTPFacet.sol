// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ITokenMessenger } from "../Interfaces/ITokenMessenger.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { CannotBridgeToSameNetwork, InvalidAmount, InvalidConfig, InvalidReceiver, NotInitialized, UnsupportedChainId } from "../Errors/GenericErrors.sol";

/// @title PolymerCCTPFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging USDC through Polymer CCTP
/// @custom:version 2.1.0
contract PolymerCCTPFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// @notice bytes32(0) allows any address to complete the CCTP transfer on destination chain
    bytes32 private constant UNRESTRICTED_DESTINATION_CALLER = bytes32(0);

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.polymercctp");

    /// @notice The address of the TokenMessenger contract on the current chain
    ITokenMessenger public immutable TOKEN_MESSENGER;
    /// @notice The address of the USDC token on the current chain
    address public immutable USDC;
    /// @notice The address that receives Polymer fees in USDC
    address payable public immutable POLYMER_FEE_RECEIVER;

    struct PolymerCCTPData {
        // Token fee taken in USDC by the facet (optional; may be zero)
        uint256 polymerTokenFee;
        // maximum fee to pay on the destination domain, specified in units of burnToken
        uint256 maxCCTPFee;
        // Should only be nonzero if submitting to a nonEVM chain
        bytes32 nonEVMReceiver;
        // For Solana: the receiver's Associated Token Account (ATA) for USDC
        bytes32 solanaReceiverATA;
        // the minimum finality at which a burn message will be attested to, will be passed directly to tokenMessenger.depositForBurn method.
        // 1000 = fast path, 2000 = standard path
        uint32 minFinalityThreshold;
    }

    struct ChainIdConfig {
        uint256 chainId;
        uint32 domainId;
    }

    struct Storage {
        // Stores domainId + 1 so domain 0 remains distinguishable from unset entries
        mapping(uint256 => uint32) cctpDomainIds;
        bool chainMappingsInitialized;
    }

    /// Events ///

    /// @notice Emitted when a Polymer CCTP bridge transaction is initiated
    /// @dev This event is used by Polymer off-chain component to pick up the transaction
    /// @param bridgeAmount The total amount being bridged (before fee deduction)
    /// @param polymerFee The fee amount taken by Polymer in USDC
    /// @param minFinalityThreshold The minimum finality threshold for the bridge (1000 = fast path, 2000 = standard path)
    event PolymerCCTPFeeSent(
        uint256 bridgeAmount,
        uint256 polymerFee,
        uint32 minFinalityThreshold
    );

    event PolymerCCTPChainMappingsInitialized(ChainIdConfig[] chainIdConfigs);

    event ChainIdToDomainIdSet(uint256 indexed chainId, uint32 domainId);

    event ChainIdToDomainIdUnset(uint256 indexed chainId);

    /// Modifiers ///

    // Alternative to validateBridgeData modifier for gas optimization (receiver check is done in _startBridge)
    modifier validatePolymerData(
        ILiFi.BridgeData memory _bridgeData,
        PolymerCCTPData calldata _polymerData
    ) {
        // Note: There are more checks within the _startBridge method so we don't strictly follow CEI, but this should be fine given checks should ensure that we only ever interact with USDC
        if (_bridgeData.minAmount == 0) {
            revert InvalidAmount();
        }
        if (_bridgeData.destinationChainId == block.chainid) {
            revert CannotBridgeToSameNetwork();
        }

        _;
    }

    /// Constructor ///

    /// @notice Initializes the PolymerCCTPFacet with required addresses
    /// @param _tokenMessenger Address of the TokenMessenger contract
    /// @param _usdc Address of the USDC token
    /// @param _polymerFeeReceiver Address that receives Polymer fees
    constructor(
        address _tokenMessenger,
        address _usdc,
        address _polymerFeeReceiver
    ) {
        if (
            _tokenMessenger == address(0) ||
            _usdc == address(0) ||
            _polymerFeeReceiver == address(0)
        ) {
            revert InvalidConfig();
        }

        TOKEN_MESSENGER = ITokenMessenger(_tokenMessenger);
        USDC = _usdc;
        POLYMER_FEE_RECEIVER = payable(_polymerFeeReceiver);
    }

    /// @notice Initializes the facet: max USDC approval for TokenMessenger and chain ID to CCTP domain ID mappings
    /// @param chainIdConfigs Chain ID configuration data
    /// @dev Max approval is safe since the diamond is designed to not hold funds. Re-initialization is idempotent for approval and overwrites mappings.
    /// @dev https://developers.circle.com/cctp/cctp-supported-blockchains#cctp-v2-supported-domains
    function initPolymerCCTP(
        ChainIdConfig[] calldata chainIdConfigs
    ) external {
        if (chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();

        IERC20(USDC).approve(address(TOKEN_MESSENGER), type(uint256).max);

        Storage storage sm = getStorage();

        for (uint256 i = 0; i < chainIdConfigs.length; ) {
            sm.cctpDomainIds[chainIdConfigs[i].chainId] =
                chainIdConfigs[i].domainId +
                1;

            unchecked {
                ++i;
            }
        }

        sm.chainMappingsInitialized = true;
        emit PolymerCCTPChainMappingsInitialized(chainIdConfigs);
    }

    /// @notice Sets the CCTP domain ID for one or more chain IDs
    /// @param chainIdConfigs Chain ID configuration data
    function setChainIdToDomainId(
        ChainIdConfig[] calldata chainIdConfigs
    ) external {
        if (chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();
        Storage storage sm = getStorage();

        if (!sm.chainMappingsInitialized) {
            revert NotInitialized();
        }

        for (uint256 i = 0; i < chainIdConfigs.length; ) {
            uint256 chainId = chainIdConfigs[i].chainId;
            uint32 domainId = chainIdConfigs[i].domainId;

            sm.cctpDomainIds[chainId] = domainId + 1;
            emit ChainIdToDomainIdSet(chainId, domainId);

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Removes the CCTP domain ID mapping for a given chain ID
    /// @param _chainId LI.FI chain ID
    function unsetChainIdToDomainId(uint256 _chainId) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage sm = getStorage();

        if (!sm.chainMappingsInitialized) {
            revert NotInitialized();
        }

        delete sm.cctpDomainIds[_chainId];
        emit ChainIdToDomainIdUnset(_chainId);
    }

    /// @notice Gets the CCTP domain ID for a given chain ID
    /// @param _chainId LI.FI chain ID
    /// @return domainId CCTP domain ID recognized by TokenMessenger
    function getChainIdToDomainId(
        uint256 _chainId
    ) external view returns (uint32 domainId) {
        return _chainIdToDomainId(_chainId);
    }

    /// @notice Bridges USDC via PolymerCCTP
    /// @param _bridgeData The core bridge data
    /// @param _polymerData Data specific to PolymerCCTP
    /// @notice Requires caller to approve the LifiDiamondProxy of the bridge amount + polymerFee
    function startBridgeTokensViaPolymerCCTP(
        ILiFi.BridgeData memory _bridgeData,
        PolymerCCTPData calldata _polymerData
    )
        external
        nonReentrant
        validatePolymerData(_bridgeData, _polymerData)
        onlyAllowSourceToken(_bridgeData, USDC)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        // We intentionally use transferFromERC20 here since the facet only supports one token: USDC
        LibAsset.transferFromERC20(
            USDC,
            msg.sender,
            address(this),
            _bridgeData.minAmount
        );

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
        validatePolymerData(_bridgeData, _polymerData)
        onlyAllowSourceToken(_bridgeData, USDC)
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        _startBridge(_bridgeData, _polymerData);
    }

    /// @dev Contains the business logic for the bridge via PolymerCCTP
    /// @param _bridgeData The core information needed for bridging
    /// @param _polymerData Data specific to PolymerCCTP
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        PolymerCCTPData calldata _polymerData
    ) internal {
        LibAsset.transferERC20(
            USDC,
            POLYMER_FEE_RECEIVER,
            _polymerData.polymerTokenFee
        );

        // we do not prevent error cases here like the following to save gas:
        // `if (_bridgeData.minAmount <= _polymerData.polymerTokenFee) revert InvalidAmount();`
        // the facet is designed to work with calldata generated by LI.FI API which ensures correct calldata

        uint256 bridgeAmount = _bridgeData.minAmount -
            _polymerData.polymerTokenFee;

        uint256 destinationChainId = _bridgeData.destinationChainId;

        // This case first for gas ops since it will likely be triggered more often
        if (_bridgeData.receiver != NON_EVM_ADDRESS) {
            // _bridgeData.receiver != NON_EVM_ADDRESS -> mint to _bridgeData.receiver
            if (_bridgeData.receiver == address(0)) {
                revert InvalidReceiver();
            }

            TOKEN_MESSENGER.depositForBurn(
                bridgeAmount,
                _chainIdToDomainId(destinationChainId),
                // TODO: migrate to LibBytes.toBytes32 — see LibBytes v1.1.0
                bytes32(uint256(uint160(_bridgeData.receiver))),
                USDC,
                UNRESTRICTED_DESTINATION_CALLER,
                _polymerData.maxCCTPFee, // maxFee - 0 means no fee limit
                _polymerData.minFinalityThreshold // minFinalityThreshold - use default
            );
        } else {
            // For Solana, CCTP expects the ATA as mintRecipient; for other non-EVM, use nonEVMReceiver.
            bool isSolanaDestination = destinationChainId ==
                LIFI_CHAIN_ID_SOLANA;

            bytes32 mintRecipient = isSolanaDestination
                ? _polymerData.solanaReceiverATA
                : _polymerData.nonEVMReceiver;

            if (mintRecipient == bytes32(0)) {
                if (isSolanaDestination) revert InvalidConfig();
                revert InvalidReceiver();
            }

            TOKEN_MESSENGER.depositForBurn(
                bridgeAmount,
                _chainIdToDomainId(destinationChainId),
                mintRecipient,
                USDC,
                UNRESTRICTED_DESTINATION_CALLER,
                _polymerData.maxCCTPFee, // maxFee - 0 means no fee limit
                _polymerData.minFinalityThreshold // minFinalityThreshold - use default
            );

            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                destinationChainId,
                _polymerData.nonEVMReceiver
            );
        }

        // Emitting a specific event for Polymer CCTP bridges greatly simplifies off-chain relayer filtering, despite it containing redundant information as emitted in the token messenger's depositForBurn event
        emit PolymerCCTPFeeSent(
            _bridgeData.minAmount,
            _polymerData.polymerTokenFee,
            _polymerData.minFinalityThreshold
        );

        // Emit Li.Fi standard event
        emit LiFiTransferStarted(
            BridgeData(
                _bridgeData.transactionId,
                _bridgeData.bridge,
                _bridgeData.integrator,
                _bridgeData.referrer,
                _bridgeData.sendingAssetId,
                _bridgeData.receiver,
                bridgeAmount,
                destinationChainId,
                _bridgeData.hasSourceSwaps,
                _bridgeData.hasDestinationCall
            )
        );
    }

    /// @notice Get CCTP domain ID for destination chain
    /// @param chainId LIFI specific chain id
    /// @return CCTP domain ID recognized by TokenMessenger
    function _chainIdToDomainId(
        uint256 chainId
    ) internal view returns (uint32) {
        uint32 storedDomainId = getStorage().cctpDomainIds[chainId];
        if (storedDomainId == 0) revert UnsupportedChainId(chainId);
        // Stored as domainId + 1 so unset (0) is distinct from Ethereum domain 0
        return storedDomainId - 1;
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
