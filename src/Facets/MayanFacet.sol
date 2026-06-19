// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IMayan } from "../Interfaces/IMayan.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidConfig, InvalidNonEVMReceiver } from "../Errors/GenericErrors.sol";

/// @title Mayan Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Mayan Bridge
/// @dev HyperCore deposits (BridgeData.destinationChainId == LIFI_CHAIN_ID_HYPERCORE) are Mayan
///      Swift orders whose destAddr is Mayan's HCDepositor handler and whose real receiver is
///      encoded in customPayload[0:20]. For these the facet validates BridgeData.receiver against
///      the customPayload receiver instead of destAddr, but only after verifying destAddr equals
///      MAYAN_HYPERCORE_DEPOSITOR, so the customPayload is trusted only for genuine HCDepositor
///      orders.
/// @custom:version 1.3.0
contract MayanFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.mayan");

    /// @dev Mayan's sole HyperCore HCDepositor handler. HyperCore Swift v2 orders set this as
    ///      their destAddr while the real receiver lives in customPayload[0:20]. Mayan commits to
    ///      announcing any change in advance; rotating it requires a facet upgrade.
    address internal constant MAYAN_HYPERCORE_DEPOSITOR =
        0x56032241C0AdAb58A29b13E94fb595a4bc414e33;

    /// @dev Mayan's destChainId for HyperEVM (the chain the HCDepositor lives on). Genuine
    ///      HyperCore deposit orders always carry this value; it is one of the calldata fields
    ///      Mayan recommends verifying to identify a deposit order.
    uint256 internal constant MAYAN_HYPEREVM_DEST_CHAIN_ID = 47;

    IMayan public immutable MAYAN;

    /// @dev Mayan specific bridge data
    /// @param nonEVMReceiver The address of the non-EVM receiver if applicable
    /// @param mayanProtocol The address of the Mayan protocol final contract
    /// @param protocolData The protocol data for the Mayan protocol
    struct MayanData {
        bytes32 nonEVMReceiver;
        address mayanProtocol;
        bytes protocolData;
    }

    /// Errors ///
    error InvalidReceiver(address expected, address actual);
    error ProtocolDataTooShort();

    /// Constructor ///

    /// @notice Constructor for the contract.
    constructor(IMayan _mayan) {
        if (address(_mayan) == address(0)) revert InvalidConfig();

        MAYAN = _mayan;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Mayan
    /// @param _bridgeData The core information needed for bridging
    /// @param _mayanData Data specific to Mayan
    function startBridgeTokensViaMayan(
        ILiFi.BridgeData memory _bridgeData,
        MayanData calldata _mayanData
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

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Normalize the amount to 8 decimals
            _bridgeData.minAmount = _normalizeAmount(
                _bridgeData.minAmount,
                18
            );
        }

        _startBridge(_bridgeData, _mayanData);
    }

    /// @notice Performs a swap before bridging via Mayan
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _mayanData Data specific to Mayan
    function swapAndStartBridgeTokensViaMayan(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        MayanData memory _mayanData
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

        uint256 decimals;
        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);
        decimals = isNative
            ? 18
            : ERC20(_bridgeData.sendingAssetId).decimals();

        // Normalize the amount to 8 decimals
        _bridgeData.minAmount = _normalizeAmount(
            _bridgeData.minAmount,
            uint8(decimals)
        );

        // Native values are not passed as calldata
        if (!isNative) {
            // Update the protocol data with the new input amount
            _mayanData.protocolData = _replaceInputAmount(
                _mayanData.protocolData,
                _bridgeData.minAmount
            );
        }

        _startBridge(_bridgeData, _mayanData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Mayan
    /// @param _bridgeData The core information needed for bridging
    /// @param _mayanData Data specific to Mayan
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        MayanData memory _mayanData
    ) internal {
        // Validate receiver address
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            if (_mayanData.nonEVMReceiver == bytes32(0)) {
                revert InvalidNonEVMReceiver();
            }
            bytes32 receiver = _parseReceiver(
                _mayanData.protocolData,
                _bridgeData.destinationChainId
            );
            if (_mayanData.nonEVMReceiver != receiver) {
                revert InvalidNonEVMReceiver();
            }
        } else {
            address receiver = address(
                uint160(
                    uint256(
                        _parseReceiver(
                            _mayanData.protocolData,
                            _bridgeData.destinationChainId
                        )
                    )
                )
            );
            if (_bridgeData.receiver != receiver) {
                revert InvalidReceiver(_bridgeData.receiver, receiver);
            }
        }

        IMayan.PermitParams memory emptyPermitParams;

        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(MAYAN),
                _bridgeData.minAmount
            );

            MAYAN.forwardERC20(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                emptyPermitParams,
                _mayanData.mayanProtocol,
                _mayanData.protocolData
            );
        } else {
            MAYAN.forwardEth{ value: _bridgeData.minAmount }(
                _mayanData.mayanProtocol,
                _mayanData.protocolData
            );
        }

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _mayanData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    // @dev Parses the receiver address from the protocol data
    // @param protocolData The protocol data for the Mayan protocol
    // @param destinationChainId The bridge destination chain id; for LIFI_CHAIN_ID_HYPERCORE a
    //        Swift v2 customPayload receiver is preferred, otherwise it falls through to the
    //        destAddr switch below (so HCDepositInitiator and other selectors keep their
    //        fixed-offset parsing)
    // @return receiver The receiver address
    function _parseReceiver(
        bytes memory protocolData,
        uint256 destinationChainId
    ) internal pure returns (bytes32 receiver) {
        if (destinationChainId == LIFI_CHAIN_ID_HYPERCORE) {
            // Swift v2 HyperCore deposits encode the receiver in customPayload; other selectors
            // (e.g. HCDepositInitiator deposit/fastDeposit) fall through to the switch below.
            receiver = _parseHypercoreReceiver(protocolData);
            if (receiver != bytes32(0)) {
                return receiver;
            }
        }

        bytes4 selector;
        assembly {
            // Load the selector from the protocol data
            selector := mload(add(protocolData, 0x20))
            // Shift the selector to the right by 224 bits to match shape of literal in switch statement
            let shiftedSelector := shr(224, selector)
            switch shiftedSelector
            // Note: [*bytes32*] = location of receiver address
            case 0xa3a30834 {
                // 0xa3a30834 createOrderWithToken(address tokenIn,uint256 amountIn,(uint8 payloadType,bytes32 trader,bytes32 destAddr,uint16 destChainId,bytes32 referrerAddr,bytes32 tokenOut,uint64 minAmountOut,uint64 gasDrop,uint64 cancelFee,uint64 refundFee,uint64 deadline,uint8 referrerBps,uint8 auctionMode,bytes32 random) params,bytes customPayload)
                // destAddr is the 3rd word of OrderParams; tuple starts at calldata 0x44 -> destAddr at 0x84; mem: +0x20 length prefix -> mload at 0xa4
                receiver := mload(add(protocolData, 0xa4))
            }
            case 0x6147435b {
                // 0x6147435b createOrderWithSig(address tokenIn,uint256 amountIn,(uint8 payloadType,bytes32 trader,bytes32 destAddr,uint16 destChainId,bytes32 referrerAddr,bytes32 tokenOut,uint64 minAmountOut,uint64 gasDrop,uint64 cancelFee,uint64 refundFee,uint64 deadline,uint8 referrerBps,uint8 auctionMode,bytes32 random) params,bytes customPayload,uint256 submissionFee,bytes signedOrderHash,(uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s) permitParams)
                // destAddr is the 3rd word of OrderParams; tuple starts at calldata 0x44 -> destAddr at 0x84; mem: +0x20 length prefix -> mload at 0xa4
                receiver := mload(add(protocolData, 0xa4))
            }
            case 0x94454a5d {
                // 0x94454a5d bridgeWithFee(address,uint256,uint64,uint64,[*bytes32*],(uint32,bytes32,bytes32))
                receiver := mload(add(protocolData, 0xa4)) // MayanCircle::bridgeWithFee()
            }
            case 0x32ad465f {
                // 0x32ad465f bridgeWithLockedFee(address,uint256,uint64,uint256,(uint32,[*bytes32*],bytes32))
                receiver := mload(add(protocolData, 0xc4)) // MayanCircle::bridgeWithLockedFee()
            }
            case 0xafd9b706 {
                // 0xafd9b706 createOrder((address,uint256,uint64,[*bytes32*],uint16,bytes32,uint64,uint64,uint64,bytes32,uint8),(uint32,bytes32,bytes32))
                receiver := mload(add(protocolData, 0x84)) // MayanCircle::createOrder()
            }
            case 0x6111ad25 {
                // 0x6111ad25 swap((uint64,uint64,uint64),(bytes32,uint16,bytes32,[*bytes32*],uint16,bytes32,bytes32),bytes32,uint16,(uint256,uint64,uint64,bool,uint64,bytes),address,uint256)
                receiver := mload(add(protocolData, 0xe4)) // MayanSwap::swap()
            }
            case 0x1eb1cff0 {
                // 0x1eb1cff0 wrapAndSwapETH((uint64,uint64,uint64),(bytes32,uint16,bytes32,[*bytes32*],uint16,bytes32,bytes32),bytes32,uint16,(uint256,uint64,uint64,bool,uint64,bytes))
                receiver := mload(add(protocolData, 0xe4)) // MayanSwap::wrapAndSwapETH()
            }
            case 0xb866e173 {
                // 0xb866e173 createOrderWithEth((bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,[*bytes32*],uint16,bytes32,uint8,uint8,bytes32))
                receiver := mload(add(protocolData, 0x104)) // MayanSwift::createOrderWithEth()
            }
            case 0x8e8d142b {
                // 0x8e8d142b createOrderWithToken(address,uint256,(bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,[*bytes32*],uint16,bytes32,uint8,uint8,bytes32))
                receiver := mload(add(protocolData, 0x144)) // MayanSwift::createOrderWithToken()
            }
            case 0x1c59b7fc {
                // 0x1c59b7fc MayanCircle::createOrder((address,uint256,uint64,bytes32,uint16,bytes32,uint64,uint64,uint64,bytes32,uint8))
                receiver := mload(add(protocolData, 0x84))
            }
            case 0x9be95bb4 {
                // 0x9be95bb4 MayanCircle::bridgeWithLockedFee(address,uint256,uint64,uint256,uint32,bytes32)
                receiver := mload(add(protocolData, 0xc4))
            }
            case 0x2072197f {
                // 0x2072197f MayanCircle::bridgeWithFee(address,uint256,uint64,uint64,bytes32,uint32,uint8,bytes)
                receiver := mload(add(protocolData, 0xa4))
            }
            case 0xf58b6de8 {
                // 0xf58b6de8 FastMCTP::bridge(address,uint256,uint64,uint256,uint64,[*bytes32*],uint32,bytes32,uint8,uint8,uint32,bytes)
                receiver := mload(add(protocolData, 0xc4))
            }
            case 0x2337e236 {
                // 0x2337e236 FastMCTP::createOrder(address,uint256,uint256,uint32,uint32,(bytes32,[*bytes32*],uint64,uint64,uint64,uint64,uint64,bytes32,uint16,bytes32,uint8,uint8,bytes32))
                receiver := mload(add(protocolData, 0xe4))
            }
            case 0xe27dce37 {
                // 0xe27dce37 HCDepositInitiator::deposit(address,uint256,address,uint64,uint256,uint256,(uint64,([*address*],uint256,uint256,(bytes32,bytes32,uint8))))
                // @notice Important behavior regarding permits and receivers in Mayan bridge for Hypercore:
                // 1. The DepositPayload struct (tuple) only contains permit data, with no separate receiver field
                // 2. The permit signer in DepositPayload struct (not the trader (3rd argument)) is who receives the bridged funds
                // 3. While technically possible to bridge to a different receiver, it requires having that receiver's permit
                //
                // Implementation note:
                // Due to these constraints, the sender must act as the receiver
                // since they need to provide their own permit. This limitation is handled at the backend level
                // by disabling the option to specify a different receiver.
                //
                receiver := mload(add(protocolData, 0xe4))
            }
            case 0x4d1ed73b {
                // 0x4d1ed73b HCDepositInitiator::fastDeposit(address,uint256,address,uint256,uint64,bytes32,uint8,uint32,uint256,(uint64,([*address*],uint256,uint256,(bytes32,bytes32,uint8))))
                // @notice Important behavior regarding permits and receivers in Mayan bridge for Hypercore:
                // 1. The DepositPayload struct (tuple) only contains permit data, with no separate receiver field
                // 2. The permit signer in DepositPayload struct (not the trader (3rd argument)) is who receives the bridged funds
                // 3. While technically possible to bridge to a different receiver, it requires having that receiver's permit
                //
                // Implementation note:
                // Due to these constraints, the sender must act as the receiver
                // since they need to provide their own permit. This limitation is handled at the backend level
                // by disabling the option to specify a different receiver.
                //
                receiver := mload(add(protocolData, 0x164))
            }
            default {
                receiver := 0x0
            }
        }
    }

    // @dev Parses the HyperCore receiver from a Mayan Swift v2 order's customPayload.
    //      HyperCore deposits set destAddr to Mayan's HCDepositor handler and encode the real
    //      receiver as a left-aligned address in customPayload[0:20]
    //      (HCDepositor.parseCustomPayload: userWallet = customPayload[0:20]). The customPayload
    //      receiver is trusted only when destAddr (head word 4) equals MAYAN_HYPERCORE_DEPOSITOR,
    //      payloadType (head word 2) is 2, and destChainId (head word 5) is HyperEVM (47) - the
    //      calldata fields Mayan recommends verifying - so a non-deposit order yields 0.
    //      customPayload is a dynamic argument, so unlike
    //      _parseReceiver (which reads the static destAddr at a fixed slot) its location is read
    //      from the offset pointer at head word 16 - the same location Mayan decodes. Unknown
    //      selectors and non-handler orders return 0 so the caller's receiver check reverts.
    // @param protocolData The protocol data for the Mayan protocol
    // @return receiver The receiver address parsed from customPayload[0:20]
    function _parseHypercoreReceiver(
        bytes memory protocolData
    ) internal pure returns (bytes32 receiver) {
        bytes4 selector;
        assembly {
            let dataPtr := add(protocolData, 0x20)
            // Load the selector from the protocol data
            selector := mload(dataPtr)
            // Shift the selector to the right by 224 bits to match shape of literal in switch statement
            let shiftedSelector := shr(224, selector)
            switch shiftedSelector
            // destAddr (the handler) sits at 0xa4; customPayload is dynamic, so read its offset
            // pointer at head word 16 (data 0x204), then receiver = customPayload[0:20] (skip the
            // 0x20 length word). Only trust customPayload when destAddr is Mayan's HCDepositor.
            case 0xa3a30834 {
                // createOrderWithToken(...,bytes customPayload)
                // Trust customPayload only for genuine HyperCore deposits, using the calldata
                // fields Mayan recommends: destAddr (head word 4) is the HCDepositor handler,
                // payloadType (head word 2) is 2, and destChainId (head word 5) is HyperEVM (47).
                if and(
                    and(
                        eq(
                            mload(add(dataPtr, 0x84)),
                            MAYAN_HYPERCORE_DEPOSITOR
                        ),
                        eq(mload(add(dataPtr, 0x44)), 2)
                    ),
                    eq(mload(add(dataPtr, 0xa4)), MAYAN_HYPEREVM_DEST_CHAIN_ID)
                ) {
                    receiver := shr(
                        96,
                        mload(
                            add(add(dataPtr, 0x24), mload(add(dataPtr, 0x204)))
                        )
                    )
                }
            }
            case 0x6147435b {
                // createOrderWithSig(...,bytes customPayload,...)
                if and(
                    and(
                        eq(
                            mload(add(dataPtr, 0x84)),
                            MAYAN_HYPERCORE_DEPOSITOR
                        ),
                        eq(mload(add(dataPtr, 0x44)), 2)
                    ),
                    eq(mload(add(dataPtr, 0xa4)), MAYAN_HYPEREVM_DEST_CHAIN_ID)
                ) {
                    receiver := shr(
                        96,
                        mload(
                            add(add(dataPtr, 0x24), mload(add(dataPtr, 0x204)))
                        )
                    )
                }
            }
            default {
                receiver := 0x0
            }
        }
    }

    // @dev Normalizes the amount to 8 decimals
    // @param amount The amount to normalize
    // @param decimals The number of decimals in the asset
    function _normalizeAmount(
        uint256 amount,
        uint8 decimals
    ) internal pure returns (uint256) {
        if (decimals > 8) {
            amount /= 10 ** (decimals - 8);
            amount *= 10 ** (decimals - 8);
        }
        return amount;
    }

    // @dev Replaces the input amount in the protocol data
    // @param protocolData The protocol data for the Mayan protocol
    // @param inputAmount The new input amount
    // @return modifiedData The modified protocol data
    function _replaceInputAmount(
        bytes memory protocolData,
        uint256 inputAmount
    ) internal pure returns (bytes memory) {
        if (protocolData.length < 68) {
            revert ProtocolDataTooShort();
        }

        bytes memory modifiedData = new bytes(protocolData.length);
        bytes4 functionSelector = bytes4(protocolData[0]) |
            (bytes4(protocolData[1]) >> 8) |
            (bytes4(protocolData[2]) >> 16) |
            (bytes4(protocolData[3]) >> 24);

        uint256 amountIndex;
        // Only the wh swap method has the amount as last argument
        bytes4 swapSelector = 0x6111ad25;
        if (functionSelector == swapSelector) {
            amountIndex = protocolData.length - 256;
        } else {
            amountIndex = 36;
        }

        // Copy the function selector and params before amount in
        for (uint256 i = 0; i < amountIndex; i++) {
            modifiedData[i] = protocolData[i];
        }

        // Encode the amount and place it into the modified call data
        bytes memory encodedAmount = abi.encode(inputAmount);
        for (uint256 i = 0; i < 32; i++) {
            modifiedData[i + amountIndex] = encodedAmount[i];
        }

        // Copy the rest of the original data after the input argument
        for (uint256 i = amountIndex + 32; i < protocolData.length; i++) {
            modifiedData[i] = protocolData[i];
        }

        return modifiedData;
    }
}
