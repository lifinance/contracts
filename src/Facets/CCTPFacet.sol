// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ITokenMessenger } from "../Interfaces/ITokenMessenger.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { CannotBridgeToSameNetwork, InvalidAmount, InvalidCallData, InvalidConfig, InvalidNonEVMReceiver, InvalidReceiver, InvalidSendingToken, NotInitialized, UnsupportedChainId } from "../Errors/GenericErrors.sol";

/// @title CCTPFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging USDC through Circle's CCTP v2 (TokenMessengerV2)
/// @dev This contract is not intended to custody user funds; any USDC it holds is transient
///      within a single bridge call and should not persist.
/// @dev Circle Forwarding Service: for destinations other than HyperCore and Stellar, a
///      non-empty hookData asks Circle to deliver (complete the mint of) the transfer on the
///      destination chain. Such a hook must start with the 24-byte "cctp-forward" header, so it
///      can only ever be a delivery request (hasDestinationCall stays false). The mint always
///      goes to the validated mintRecipient (BridgeData.receiver, or solanaReceiverATA for
///      Solana) with destinationCaller == bytes32(0), so a hook cannot redirect funds: a bad hook
///      only means Circle does not deliver, and anyone can still complete the mint.
/// @dev HyperCore deposits (BridgeData.destinationChainId == LIFI_CHAIN_ID_HYPERCORE) burn USDC
///      toward the HyperEVM CCTP domain with hook data that Circle's CctpForwarder on HyperEVM
///      uses to deposit into HyperCore. For these flows the facet mints to the pinned forwarder
///      (mintRecipient == destinationCaller == HYPERCORE_CCTP_FORWARDER) and validates that the
///      receiver encoded in hookData[32:52] equals BridgeData.receiver, so emitted events always
///      carry the real end user. Rotating the forwarder requires a facet upgrade.
/// @dev Stellar deposits (BridgeData.destinationChainId == LIFI_CHAIN_ID_STELLAR) are non-EVM:
///      BridgeData.receiver is the NON_EVM_ADDRESS sentinel and the real recipient travels as a
///      Stellar strkey inside hookData, because a Stellar account can never be a CCTP mintRecipient
///      directly (see STELLAR_CCTP_FORWARDER). USDC is minted to the pinned Stellar forwarder,
///      which forwards it to that strkey.
/// @dev SECURITY — UNVALIDATED RECEIVER (Stellar): the Stellar strkey is not a 20-byte EVM
///      address, so the facet CANNOT verify it on-chain against BridgeData.receiver, and it is
///      NOT cross-checked against the nonEVMReceiver emitted in BridgeToNonEVMChainBytes32. The
///      facet only enforces hookData's internal length consistency. Correct routing relies
///      entirely on trusted (LI.FI API) calldata generation — integrators MUST treat the Stellar
///      receiver as NOT enforced on-chain.
/// @dev Solana deposits (BridgeData.destinationChainId == LIFI_CHAIN_ID_SOLANA) are non-EVM:
///      BridgeData.receiver is the NON_EVM_ADDRESS sentinel, the CCTP mintRecipient is the
///      recipient's USDC Associated Token Account (solanaReceiverATA), and the event receiver
///      emitted in BridgeToNonEVMChainBytes32 is the recipient owner wallet (nonEVMReceiver).
///      Both are required to be non-zero, but neither is 20-byte EVM-shaped, so the facet
///      CANNOT verify them against each other or against BridgeData.receiver on-chain. Their
///      consistency (ATA == the wallet's USDC ATA) relies entirely on trusted (LI.FI API)
///      calldata generation.
/// @custom:version 1.0.0
contract CCTPFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// @notice bytes32(0) allows any address to complete the CCTP transfer on destination chain
    bytes32 private constant UNRESTRICTED_DESTINATION_CALLER = bytes32(0);

    /// @notice Header every Circle Forwarding Service hook starts with: "cctp-forward",
    ///         right-padded with zero bytes to 24 bytes.
    ///         https://developers.circle.com/cctp/concepts/forwarding-service
    bytes24 internal constant CCTP_FORWARD_HEADER = bytes24("cctp-forward");

    /// @notice Circle's CctpForwarder on HyperEVM (0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757),
    ///         pre-encoded as the bytes32 mintRecipient/destinationCaller. HyperCore hook flows
    ///         mint to this contract, which alone may execute the message and deposits the USDC
    ///         into HyperCore for the receiver encoded in the hook data.
    ///         https://developers.circle.com/cctp/references/hypercore-contract-addresses
    bytes32 internal constant HYPERCORE_CCTP_FORWARDER =
        0x000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e45757;

    /// @notice Circle's CctpForwarder on Stellar mainnet
    ///         (CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T), pre-encoded as the
    ///         bytes32 mintRecipient/destinationCaller (the forwarder's raw 32-byte contract id).
    ///         A Stellar account can never be a CCTP mintRecipient directly: CCTP stores only the
    ///         raw 32 bytes without the strkey type prefix, so the protocol assumes the recipient
    ///         is a contract and USDC minted to a bare account is unrecoverable. All Stellar
    ///         deposits therefore mint to this forwarder, which alone may execute the message and
    ///         forwards the USDC to the strkey recipient carried in the hook data.
    ///         Rotating the forwarder requires a facet upgrade.
    ///         https://developers.circle.com/cctp/references/stellar-contracts
    bytes32 internal constant STELLAR_CCTP_FORWARDER =
        0x72bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf291;

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.cctp");

    /// @notice The address of the TokenMessengerV2 contract on the current chain
    /// @dev Facet-scoped name: TOKEN_MESSENGER() is already routed to PolymerCCTPFacet
    ITokenMessenger public immutable CCTP_TOKEN_MESSENGER;
    /// @notice The address of the USDC token on the current chain
    /// @dev Facet-scoped name: USDC() is already routed to CelerCircleBridgeFacet
    address public immutable CCTP_USDC;

    struct CCTPData {
        // maximum fee to pay on the destination domain, specified in units of burnToken.
        // When hookData requests Circle delivery it must also cover the forwarding fee.
        uint256 maxCCTPFee;
        // The non-EVM recipient emitted in BridgeToNonEVMChainBytes32. Should only be nonzero
        // if submitting to a nonEVM chain; required for Stellar and Solana. For Solana this is
        // the recipient's owner wallet (NOT a token account) — the relayer derives the ATA
        // from it.
        bytes32 nonEVMReceiver;
        // For Solana: the receiver's Associated Token Account (ATA) for USDC. Used as the
        // CCTP mintRecipient; must be the USDC ATA of nonEVMReceiver.
        bytes32 solanaReceiverATA;
        // the minimum finality at which a burn message will be attested to, passed directly to
        // TokenMessengerV2. 1000 = fast path, 2000 = standard path
        uint32 minFinalityThreshold;
        // Recipient of swap leftovers and excess native on the swap entrypoint. msg.sender
        // may be a relayer or the Permit2Proxy, so refunds must route to an explicit address
        // rather than the caller. Only consumed by swapAndStartBridgeTokensViaCCTP.
        address refundRecipient;
        // Hook data appended to the burn message.
        // HyperCore: required, CctpForwarder hook encoding bridgeData.receiver at [32:52].
        // Stellar: required, magic (24) + version (4) + strkey length L (4) + strkey (L).
        // Any other destination: optional; if non-empty it must start with
        // CCTP_FORWARD_HEADER (Circle Forwarding Service delivery request).
        bytes hookData;
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

    event CCTPChainMappingsInitialized(ChainIdConfig[] chainIdConfigs);

    event CCTPChainIdToDomainIdSet(uint256 indexed chainId, uint32 domainId);

    event CCTPChainIdToDomainIdUnset(uint256 indexed chainId);

    /// Modifiers ///

    // Alternative to validateBridgeData for gas optimization (receiver check is done in
    // _validateDestination)
    modifier validateCCTPBridgeData(ILiFi.BridgeData memory _bridgeData) {
        if (_bridgeData.minAmount == 0) {
            revert InvalidAmount();
        }
        if (_bridgeData.destinationChainId == block.chainid) {
            revert CannotBridgeToSameNetwork();
        }

        _;
    }

    /// Constructor ///

    /// @notice Initializes the CCTPFacet with required addresses
    /// @param _tokenMessenger Address of the TokenMessengerV2 contract
    /// @param _usdc Address of the USDC token
    constructor(address _tokenMessenger, address _usdc) {
        if (_tokenMessenger == address(0) || _usdc == address(0)) {
            revert InvalidConfig();
        }

        CCTP_TOKEN_MESSENGER = ITokenMessenger(_tokenMessenger);
        CCTP_USDC = _usdc;
    }

    /// @notice Initializes the facet: max USDC approval for TokenMessenger and chain ID to CCTP
    ///         domain ID mappings
    /// @param _chainIdConfigs Chain ID configuration data
    /// @dev Max approval is safe since the diamond is designed to not hold funds.
    ///      Re-initialization is idempotent for approval and overwrites mappings.
    /// @dev https://developers.circle.com/cctp/cctp-supported-blockchains#cctp-v2-supported-domains
    function initCCTP(ChainIdConfig[] calldata _chainIdConfigs) external {
        if (_chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();

        IERC20(CCTP_USDC).approve(
            address(CCTP_TOKEN_MESSENGER),
            type(uint256).max
        );

        Storage storage sm = getStorage();

        for (uint256 i = 0; i < _chainIdConfigs.length; ) {
            sm.cctpDomainIds[_chainIdConfigs[i].chainId] =
                _chainIdConfigs[i].domainId +
                1;

            unchecked {
                ++i;
            }
        }

        sm.chainMappingsInitialized = true;

        emit CCTPChainMappingsInitialized(_chainIdConfigs);
    }

    /// @notice Sets the CCTP domain ID for one or more chain IDs
    /// @param _chainIdConfigs Chain ID configuration data
    function setCCTPChainIdToDomainId(
        ChainIdConfig[] calldata _chainIdConfigs
    ) external {
        if (_chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();
        Storage storage sm = getStorage();

        if (!sm.chainMappingsInitialized) {
            revert NotInitialized();
        }

        for (uint256 i = 0; i < _chainIdConfigs.length; ) {
            uint256 chainId = _chainIdConfigs[i].chainId;
            uint32 domainId = _chainIdConfigs[i].domainId;

            sm.cctpDomainIds[chainId] = domainId + 1;
            emit CCTPChainIdToDomainIdSet(chainId, domainId);

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Removes the CCTP domain ID mapping for a given chain ID
    /// @param _chainId LI.FI chain ID
    function unsetCCTPChainIdToDomainId(uint256 _chainId) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage sm = getStorage();

        if (!sm.chainMappingsInitialized) {
            revert NotInitialized();
        }

        delete sm.cctpDomainIds[_chainId];

        emit CCTPChainIdToDomainIdUnset(_chainId);
    }

    /// @notice Gets the CCTP domain ID for a given chain ID
    /// @param _chainId LI.FI chain ID
    /// @return domainId CCTP domain ID recognized by TokenMessengerV2
    function getCCTPChainIdToDomainId(
        uint256 _chainId
    ) external view returns (uint32 domainId) {
        return _chainIdToDomainId(_chainId);
    }

    /// @notice Bridges USDC via CCTP
    /// @param _bridgeData The core bridge data
    /// @param _cctpData Data specific to CCTP
    /// @dev Requires the caller to approve the diamond for _bridgeData.minAmount of USDC
    function startBridgeTokensViaCCTP(
        ILiFi.BridgeData memory _bridgeData,
        CCTPData calldata _cctpData
    )
        external
        nonReentrant
        validateCCTPBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, CCTP_USDC)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.transferFromERC20(
            CCTP_USDC,
            msg.sender,
            address(this),
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _cctpData);
    }

    /// @notice Performs a swap before bridging via CCTP
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _cctpData Data specific to CCTP
    function swapAndStartBridgeTokensViaCCTP(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CCTPData calldata _cctpData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_cctpData.refundRecipient))
        validateCCTPBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, CCTP_USDC)
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        // Deterministic revert instead of a late failure in refundExcessNative that only
        // surfaces when fee drift leaves an excess.
        if (_cctpData.refundRecipient == address(0)) {
            revert InvalidCallData();
        }

        // onlyAllowSourceToken pins sendingAssetId to USDC, but not the final swap output.
        // Without this a swap ending in another token would bridge USDC the diamond already
        // holds.
        if (
            _swapData.length > 0 &&
            _swapData[_swapData.length - 1].receivingAssetId != CCTP_USDC
        ) {
            revert InvalidSendingToken();
        }

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(_cctpData.refundRecipient)
        );

        _startBridge(_bridgeData, _cctpData);
    }

    /// @dev Contains the business logic for the bridge via CCTP
    /// @param _bridgeData The core information needed for bridging
    /// @param _cctpData Data specific to CCTP
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        CCTPData calldata _cctpData
    ) internal {
        _validateDestination(_bridgeData, _cctpData);

        uint256 destinationChainId = _bridgeData.destinationChainId;
        uint32 domainId = _chainIdToDomainId(destinationChainId);

        if (destinationChainId == LIFI_CHAIN_ID_HYPERCORE) {
            // Mint to the pinned forwarder (never to the receiver directly) and restrict
            // execution to it; the forwarder deposits into HyperCore for the validated receiver
            _depositForBurn(
                _bridgeData.minAmount,
                domainId,
                HYPERCORE_CCTP_FORWARDER,
                HYPERCORE_CCTP_FORWARDER,
                _cctpData
            );
        } else if (_bridgeData.receiver != NON_EVM_ADDRESS) {
            _depositForBurn(
                _bridgeData.minAmount,
                domainId,
                LibBytes.toBytes32(_bridgeData.receiver),
                UNRESTRICTED_DESTINATION_CALLER,
                _cctpData
            );
        } else if (destinationChainId == LIFI_CHAIN_ID_STELLAR) {
            // Mint to the pinned Stellar forwarder (never a Stellar account directly) and
            // restrict execution to it; the forwarder credits the strkey in the hook data
            _depositForBurn(
                _bridgeData.minAmount,
                domainId,
                STELLAR_CCTP_FORWARDER,
                STELLAR_CCTP_FORWARDER,
                _cctpData
            );

            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                destinationChainId,
                _cctpData.nonEVMReceiver
            );
        } else {
            // Only Solana reaches this branch (see _validateDestination). CCTP mints to the
            // receiver's USDC ATA, while the event carries the owner wallet so the relayer can
            // derive the ATA itself.
            _depositForBurn(
                _bridgeData.minAmount,
                domainId,
                _cctpData.solanaReceiverATA,
                UNRESTRICTED_DESTINATION_CALLER,
                _cctpData
            );

            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                destinationChainId,
                _cctpData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Validates receiver and hookData against the destination before any burn
    /// @param _bridgeData The core information needed for bridging
    /// @param _cctpData Data specific to CCTP
    function _validateDestination(
        ILiFi.BridgeData memory _bridgeData,
        CCTPData calldata _cctpData
    ) internal pure {
        uint256 destinationChainId = _bridgeData.destinationChainId;

        if (destinationChainId == LIFI_CHAIN_ID_HYPERCORE) {
            _validateHyperCore(_bridgeData, _cctpData);
            return;
        }

        if (destinationChainId == LIFI_CHAIN_ID_STELLAR) {
            _validateStellar(_bridgeData, _cctpData);
            return;
        }

        // Any other destination: a hook may only be a Circle Forwarding Service delivery
        // request, never an arbitrary payload for a destination contract.
        if (
            _cctpData.hookData.length > 0 &&
            (_cctpData.hookData.length < 24 ||
                bytes24(_cctpData.hookData[0:24]) != CCTP_FORWARD_HEADER)
        ) {
            revert InvalidCallData();
        }

        // The receiver kind must match the destination kind: the NON_EVM_ADDRESS sentinel is
        // only valid for Solana here, and a real EVM address must never target Solana.
        // Otherwise CCTP would either mint to an address the events do not show, or burn a
        // zero-padded EVM address to a domain where it is unclaimable.
        bool isSolanaDestination = destinationChainId == LIFI_CHAIN_ID_SOLANA;
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            if (!isSolanaDestination) {
                revert InvalidReceiver();
            }
            if (_cctpData.nonEVMReceiver == bytes32(0)) {
                revert InvalidNonEVMReceiver();
            }
            if (_cctpData.solanaReceiverATA == bytes32(0)) {
                revert InvalidConfig();
            }
        } else if (isSolanaDestination || _bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
    }

    /// @dev Same checks as PolymerCCTPFacet v3.1.0. Without a valid hook the USDC would
    ///      mint on HyperEVM and never reach HyperCore. CctpForwarder hook layout: magic (24)
    ///      + version (4) + payload length (4), then the recipient address at [32:52]. The
    ///      forwarder credits the account encoded there, so it must equal the declared receiver.
    /// @param _bridgeData The core information needed for bridging
    /// @param _cctpData Data specific to CCTP
    function _validateHyperCore(
        ILiFi.BridgeData memory _bridgeData,
        CCTPData calldata _cctpData
    ) private pure {
        if (
            _bridgeData.receiver == NON_EVM_ADDRESS ||
            _cctpData.hookData.length < 52
        ) {
            revert InvalidCallData();
        }

        if (
            _bridgeData.receiver == address(0) ||
            address(bytes20(_cctpData.hookData[32:52])) != _bridgeData.receiver
        ) {
            revert InvalidReceiver();
        }
    }

    /// @dev Same checks as PolymerCCTPFacet v3.1.0. Hook layout: magic (24) + version (4)
    ///      + strkey length L (4) + strkey (L). hookData.length must exceed the 32-byte header
    ///      (L == 0 leaves the USDC burned but stuck), and L must equal the trailing size so a
    ///      truncated or padded hook cannot reach the forwarder. The version bytes [24:28] are
    ///      intentionally not validated; Circle's Stellar forwarder rejects a wrong version.
    /// @param _bridgeData The core information needed for bridging
    /// @param _cctpData Data specific to CCTP
    function _validateStellar(
        ILiFi.BridgeData memory _bridgeData,
        CCTPData calldata _cctpData
    ) private pure {
        if (
            _bridgeData.receiver != NON_EVM_ADDRESS ||
            _cctpData.nonEVMReceiver == bytes32(0) ||
            _cctpData.hookData.length <= 32
        ) {
            revert InvalidCallData();
        }

        if (
            uint32(bytes4(_cctpData.hookData[28:32])) !=
            _cctpData.hookData.length - 32
        ) {
            revert InvalidCallData();
        }
    }

    /// @dev Burns USDC via TokenMessengerV2, with the hook appended when one is provided
    /// @param _amount Amount of USDC to burn
    /// @param _domainId Destination CCTP domain
    /// @param _mintRecipient Mint recipient on the destination domain
    /// @param _destinationCaller Caller allowed to complete the mint (bytes32(0) = anyone)
    /// @param _cctpData Data specific to CCTP
    function _depositForBurn(
        uint256 _amount,
        uint32 _domainId,
        bytes32 _mintRecipient,
        bytes32 _destinationCaller,
        CCTPData calldata _cctpData
    ) private {
        if (_cctpData.hookData.length == 0) {
            CCTP_TOKEN_MESSENGER.depositForBurn(
                _amount,
                _domainId,
                _mintRecipient,
                CCTP_USDC,
                _destinationCaller,
                _cctpData.maxCCTPFee,
                _cctpData.minFinalityThreshold
            );
            return;
        }

        CCTP_TOKEN_MESSENGER.depositForBurnWithHook(
            _amount,
            _domainId,
            _mintRecipient,
            CCTP_USDC,
            _destinationCaller,
            _cctpData.maxCCTPFee,
            _cctpData.minFinalityThreshold,
            _cctpData.hookData
        );
    }

    /// @notice Get CCTP domain ID for destination chain
    /// @param _chainId LI.FI specific chain id
    /// @return CCTP domain ID recognized by TokenMessengerV2
    function _chainIdToDomainId(
        uint256 _chainId
    ) internal view returns (uint32) {
        uint32 storedDomainId = getStorage().cctpDomainIds[_chainId];
        if (storedDomainId == 0) revert UnsupportedChainId(_chainId);
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
