// Interface for Stargate V2
/// @custom:version 1.0.0
// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.17;

/// @notice Stargate implementation type.
enum StargateType {
    Pool,
    OFT
}

/// @notice Ticket data for bus ride.
struct Ticket {
    uint72 ticketId;
    bytes passengerBytes;
}

/// @title Interface for Stargate.
/// @notice Defines an API for sending tokens to destination chains.
interface IStargate {
    /**
     * @dev Struct representing token parameters for the OFT send() operation.
     */
    struct SendParam {
        uint32 dstEid; // Destination endpoint ID.
        bytes32 to; // Recipient address.
        uint256 amountLD; // Amount to send in local decimals.
        uint256 minAmountLD; // Minimum amount to send in local decimals.
        bytes extraOptions; // Additional options supplied by the caller to be used in the LayerZero message.
        bytes composeMsg; // The composed message for the send() operation.
        bytes oftCmd; // The OFT command to be executed, unused in default OFT implementations.
    }

    /**
     * @dev Struct representing OFT limit information.
     * @dev These amounts can change dynamically and are up the the specific oft implementation.
     */
    struct OFTLimit {
        uint256 minAmountLD; // Minimum amount in local decimals that can be sent to the recipient.
        uint256 maxAmountLD; // Maximum amount in local decimals that can be sent to the recipient.
    }

    /**
     * @dev Struct representing OFT receipt information.
     */
    struct OFTReceipt {
        uint256 amountSentLD; // Amount of tokens ACTUALLY debited from the sender in local decimals.
        // @dev In non-default implementations, the amountReceivedLD COULD differ from this value.
        uint256 amountReceivedLD; // Amount of tokens to be received on the remote side.
    }

    /**
     * @dev Struct representing OFT fee details.
     * @dev Future proof mechanism to provide a standardized way to communicate fees to things like a UI.
     */
    struct OFTFeeDetail {
        int256 feeAmountLD; // Amount of the fee in local decimals.
        string description; // Description of the fee.
    }

    struct MessagingFee {
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    struct MessagingReceipt {
        bytes32 guid;
        uint64 nonce;
        MessagingFee fee;
    }

    /// @dev This function is same as `send` in OFT interface but returns the ticket data if in the bus ride mode,
    /// which allows the caller to ride and drive the bus in the same transaction.
    function sendToken(
        SendParam calldata _sendParam,
        MessagingFee calldata _fee,
        address _refundAddress
    )
        external
        payable
        returns (
            MessagingReceipt memory msgReceipt,
            OFTReceipt memory oftReceipt,
            Ticket memory ticket
        );

    /**
     * @notice Provides a quote for OFT-related operations.
     * @param _sendParam The parameters for the send operation.
     * @return limit The OFT limit information.
     * @return oftFeeDetails The details of OFT fees.
     * @return receipt The OFT receipt information.
     */
    function quoteOFT(
        SendParam calldata _sendParam
    )
        external
        view
        returns (
            OFTLimit memory,
            OFTFeeDetail[] memory oftFeeDetails,
            OFTReceipt memory
        );

    /**
     * @notice Provides a quote for the send() operation.
     * @param _sendParam The parameters for the send() operation.
     * @param _payInLzToken Flag indicating whether the caller is paying in the LZ token.
     * @return fee The calculated LayerZero messaging fee from the send() operation.
     *
     * @dev MessagingFee: LayerZero msg fee
     *  - nativeFee: The native fee.
     *  - lzTokenFee: The lzToken fee.
     */
    function quoteSend(
        SendParam calldata _sendParam,
        bool _payInLzToken
    ) external view returns (MessagingFee memory);
}

interface ITokenMessaging {
    function assetIds(address tokenAddress) external returns (uint16);

    function stargateImpls(uint16 assetId) external returns (address);
}
