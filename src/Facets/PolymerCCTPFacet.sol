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
import { CannotBridgeToSameNetwork, InvalidAmount, InvalidCallData, InvalidConfig, InvalidReceiver, NotInitialized, UnsupportedChainId } from "../Errors/GenericErrors.sol";

/// @title PolymerCCTPFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging USDC through Polymer CCTP
/// @dev HyperCore deposits (BridgeData.destinationChainId == LIFI_CHAIN_ID_HYPERCORE) burn USDC
///      toward the HyperEVM CCTP domain with hook data that Circle's CctpForwarder on HyperEVM
///      uses to deposit into HyperCore. For these flows the facet mints to the pinned forwarder
///      (mintRecipient == destinationCaller == HYPERCORE_CCTP_FORWARDER) and validates that the
///      receiver encoded in hookData[32:52] equals BridgeData.receiver, so emitted events always
///      carry the real end user. Hooks toward any other destination are rejected. Rotating the
///      forwarder requires a facet upgrade.
/// @dev Stellar deposits (BridgeData.destinationChainId == LIFI_CHAIN_ID_STELLAR) are non-EVM:
///      BridgeData.receiver is the NON_EVM_ADDRESS sentinel and the real recipient travels as a
///      Stellar strkey inside hookData, because a Stellar account can never be a CCTP mintRecipient
///      directly (see STELLAR_CCTP_FORWARDER). USDC is minted to the pinned Stellar forwarder,
///      which forwards it to that strkey.
/// @dev SECURITY — UNVALIDATED RECEIVER (Stellar): unlike the HyperCore corridor, the Stellar
///      strkey is not a 20-byte EVM address, so the facet CANNOT verify it on-chain against
///      BridgeData.receiver, and it is NOT cross-checked against the nonEVMReceiver emitted in
///      BridgeToNonEVMChainBytes32. The facet only enforces hookData's internal length consistency
///      (see _startBridge). The strkey that actually receives the funds and the nonEVMReceiver used
///      for off-chain tracking can therefore diverge. Correct routing relies entirely on trusted
///      (LI.FI API) calldata generation — integrators MUST treat the Stellar receiver as NOT
///      enforced on-chain.
/// @custom:version 3.0.0
contract PolymerCCTPFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// @notice bytes32(0) allows any address to complete the CCTP transfer on destination chain
    bytes32 private constant UNRESTRICTED_DESTINATION_CALLER = bytes32(0);

    /// @notice Circle's CctpForwarder on HyperEVM (0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757),
    ///         pre-encoded as the bytes32 mintRecipient/destinationCaller. HyperCore hook flows
    ///         mint to this contract, which alone may execute the message and deposits the USDC
    ///         into HyperCore for the receiver encoded in the hook data (see _startBridge).
    ///         https://developers.circle.com/cctp/references/hypercore-contract-addresses
    bytes32 internal constant HYPERCORE_CCTP_FORWARDER =
        bytes32(uint256(uint160(0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757)));

    /// @notice Circle's CctpForwarder on Stellar mainnet
    ///         (CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T), pre-encoded as the
    ///         bytes32 mintRecipient/destinationCaller (the forwarder's raw 32-byte contract id).
    ///         A Stellar account can never be a CCTP mintRecipient directly: CCTP stores only the
    ///         raw 32 bytes without the strkey type prefix, so the protocol assumes the recipient
    ///         is a contract and USDC minted to a bare account is unrecoverable. All Stellar
    ///         deposits therefore mint to this forwarder, which alone may execute the message and
    ///         forwards the USDC to the strkey recipient carried in the hook data (see _startBridge).
    ///         Rotating the forwarder requires a facet upgrade.
    ///         https://developers.circle.com/cctp/references/stellar-contracts
    bytes32 internal constant STELLAR_CCTP_FORWARDER =
        0x72bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf291;

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
        // Recipient of swap leftovers and excess native on the swap entrypoint. msg.sender
        // may be a relayer or the Permit2Proxy, so refunds must route to an explicit address
        // rather than the caller. Only consumed by swapAndStartBridgeTokensViaPolymerCCTP.
        address refundRecipient;
        // CctpForwarder hook data. For HyperCore it must encode bridgeData.receiver at bytes
        // [32:52]. For Stellar it carries the forwardRecipient strkey: magic (24) + version (4) +
        // length L (4) + strkey (L). Required if destinationChainId is LIFI_CHAIN_ID_HYPERCORE
        // or LIFI_CHAIN_ID_STELLAR; must be empty otherwise.
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
        refundExcessNative(payable(_polymerData.refundRecipient))
        validatePolymerData(_bridgeData, _polymerData)
        onlyAllowSourceToken(_bridgeData, USDC)
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        // msg.sender may be a relayer or the Permit2Proxy, so refunds must go to an explicit
        // recipient. Check up front for a deterministic revert instead of a late failure in
        // refundExcessNative that only surfaces when fee drift leaves an excess.
        if (_polymerData.refundRecipient == address(0)) {
            revert InvalidCallData();
        }

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(_polymerData.refundRecipient)
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
        // Corridor dispatch: HyperCore and Stellar require a forwarder hook; hooks
        // toward any other destination are unsupported. Add new corridors as
        // additional arms.
        if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_HYPERCORE) {
            // Without a valid hook the USDC would mint on HyperEVM and never
            // reach HyperCore
            if (
                _bridgeData.receiver == NON_EVM_ADDRESS ||
                _polymerData.hookData.length < 52
            ) {
                revert InvalidCallData();
            }

            // CctpForwarder hook layout: magic (24 bytes) + version (4) +
            // payload length (4), then the recipient address at [32:52].
            // The forwarder credits the account encoded there, so it must
            // equal the declared receiver or events would misreport the
            // beneficiary and calldata could redirect funds unnoticed.
            if (
                address(bytes20(_polymerData.hookData[32:52])) !=
                _bridgeData.receiver
            ) {
                revert InvalidReceiver();
            }
        } else if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_STELLAR) {
            // Stellar is non-EVM: the receiver is the NON_EVM_ADDRESS sentinel and the real
            // recipient travels as a strkey in the hook data (a Stellar account can never be a
            // CCTP mintRecipient; see STELLAR_CCTP_FORWARDER). The raw account is carried in
            // nonEVMReceiver for off-chain relayer tracking. The strkey is not a 20-byte EVM
            // address, so it cannot be validated against _bridgeData.receiver.
            // Hook layout: magic (24) + version (4) + strkey length L (4) + strkey (L).
            if (
                _bridgeData.receiver != NON_EVM_ADDRESS ||
                _polymerData.nonEVMReceiver == bytes32(0) ||
                _polymerData.hookData.length < 32
            ) {
                revert InvalidCallData();
            }

            // Reject a hook whose declared payload length disagrees with its actual size,
            // so a truncated or padded hook cannot reach the forwarder.
            if (
                uint32(bytes4(_polymerData.hookData[28:32])) !=
                _polymerData.hookData.length - 32
            ) {
                revert InvalidCallData();
            }
        } else {
            // Non-corridor destinations carry no forwarder hook, and the receiver kind
            // must match the destination kind: the NON_EVM_ADDRESS sentinel is only valid
            // for whitelisted non-EVM destinations (Solana here; Stellar and HyperCore are
            // handled by the arms above), and a real EVM address must never target a
            // non-EVM destination. Without these guards CCTP would either mint to the low
            // 20 bytes of nonEVMReceiver on an EVM chain while events show the sentinel, or
            // burn a zero-padded EVM address to a non-EVM domain where it is unclaimable.
            if (_polymerData.hookData.length > 0) {
                revert InvalidCallData();
            }

            bool isSolanaDestination = _bridgeData.destinationChainId ==
                LIFI_CHAIN_ID_SOLANA;
            if (_bridgeData.receiver == NON_EVM_ADDRESS) {
                if (!isSolanaDestination) {
                    revert InvalidReceiver();
                }
            } else if (isSolanaDestination) {
                revert InvalidReceiver();
            }
        }

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

        uint32 domainId = _chainIdToDomainId(destinationChainId);

        // This case first for gas ops since it will likely be triggered more often
        if (_bridgeData.receiver != NON_EVM_ADDRESS) {
            // _bridgeData.receiver != NON_EVM_ADDRESS -> mint to _bridgeData.receiver
            if (_bridgeData.receiver == address(0)) {
                revert InvalidReceiver();
            }

            if (destinationChainId == LIFI_CHAIN_ID_HYPERCORE) {
                // Mint to the pinned forwarder (never to the receiver directly) and
                // restrict execution to it; the forwarder then deposits into
                // HyperCore for the receiver validated above
                TOKEN_MESSENGER.depositForBurnWithHook(
                    bridgeAmount,
                    domainId,
                    HYPERCORE_CCTP_FORWARDER,
                    USDC,
                    HYPERCORE_CCTP_FORWARDER,
                    _polymerData.maxCCTPFee,
                    _polymerData.minFinalityThreshold,
                    _polymerData.hookData
                );
            } else {
                TOKEN_MESSENGER.depositForBurn(
                    bridgeAmount,
                    domainId,
                    bytes32(uint256(uint160(_bridgeData.receiver))),
                    USDC,
                    UNRESTRICTED_DESTINATION_CALLER,
                    _polymerData.maxCCTPFee, // maxFee - 0 means no fee limit
                    _polymerData.minFinalityThreshold
                );
            }
        } else if (destinationChainId == LIFI_CHAIN_ID_STELLAR) {
            // Mint to the pinned Stellar forwarder (never a Stellar account directly) and
            // restrict execution to it; the forwarder credits the strkey recipient carried in
            // the hook data validated above.
            TOKEN_MESSENGER.depositForBurnWithHook(
                bridgeAmount,
                domainId,
                STELLAR_CCTP_FORWARDER,
                USDC,
                STELLAR_CCTP_FORWARDER,
                _polymerData.maxCCTPFee, // maxFee - 0 means no fee limit
                _polymerData.minFinalityThreshold,
                _polymerData.hookData
            );

            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                destinationChainId,
                _polymerData.nonEVMReceiver
            );
        } else {
            // Only Solana reaches this branch: Stellar and HyperCore are handled above, and
            // the dispatch guard rejects the sentinel for any other destination. CCTP expects
            // the receiver's USDC ATA as mintRecipient, and that same ATA is emitted so the
            // event can never diverge from the actual mint target.
            if (_polymerData.solanaReceiverATA == bytes32(0)) {
                revert InvalidConfig();
            }

            TOKEN_MESSENGER.depositForBurn(
                bridgeAmount,
                domainId,
                _polymerData.solanaReceiverATA,
                USDC,
                UNRESTRICTED_DESTINATION_CALLER,
                _polymerData.maxCCTPFee, // maxFee - 0 means no fee limit
                _polymerData.minFinalityThreshold
            );

            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                destinationChainId,
                _polymerData.solanaReceiverATA
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
