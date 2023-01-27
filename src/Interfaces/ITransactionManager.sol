// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.17;

interface ITransactionManager {
    // Structs

    // Holds all data that is constant between sending and
    // receiving chains. The hash of this is what gets signed
    // to ensure the signature can be used on both chains.
    struct InvariantTransactionData {
        address receivingChainTxManagerAddress;
        address user;
        address router;
        address initiator; // msg.sender of sending side
        address sendingAssetId;
        address receivingAssetId;
        address sendingChainFallback; // funds sent here on cancel
        address receivingAddress;
        address callTo;
        uint256 sendingChainId;
        uint256 receivingChainId;
        bytes32 callDataHash; // hashed to prevent free option
        bytes32 transactionId;
    }

    // All Transaction data, constant and variable
    struct TransactionData {
        address receivingChainTxManagerAddress;
        address user;
        address router;
        address initiator; // msg.sender of sending side
        address sendingAssetId;
        address receivingAssetId;
        address sendingChainFallback;
        address receivingAddress;
        address callTo;
        bytes32 callDataHash;
        bytes32 transactionId;
        uint256 sendingChainId;
        uint256 receivingChainId;
        uint256 amount;
        uint256 expiry;
        uint256 preparedBlockNumber; // Needed for removal of active blocks on fulfill/cancel
    }

    /**
     * Arguments for calling prepare()
     * @param invariantData The data for a crosschain transaction that will
     *                      not change between sending and receiving chains.
     *                      The hash of this data is used as the key to store
     *                      the inforamtion that does change between chains
     *                      (amount,expiry,preparedBlock) for verification
     * @param amount The amount of the transaction on this chain
     * @param expiry The block.timestamp when the transaction will no longer be
     *               fulfillable and is freely cancellable on this chain
     * @param encryptedCallData The calldata to be executed when the tx is
     *                          fulfilled. Used in the function to allow the user
     *                          to reconstruct the tx from events. Hash is stored
     *                          onchain to prevent shenanigans.
     * @param encodedBid The encoded bid that was accepted by the user for this
     *                   crosschain transfer. It is supplied as a param to the
     *                   function but is only used in event emission
     * @param bidSignature The signature of the bidder on the encoded bid for
     *                     this transaction. Only used within the function for
     *                     event emission. The validity of the bid and
     *                     bidSignature are enforced offchain
     * @param encodedMeta The meta for the function
     */
    struct PrepareArgs {
        InvariantTransactionData invariantData;
        uint256 amount;
        uint256 expiry;
        bytes encryptedCallData;
        bytes encodedBid;
        bytes bidSignature;
        bytes encodedMeta;
    }

    // called in the following order (in happy case)
    // 1. prepare by user on sending chain
    function prepare(PrepareArgs calldata args)
        external
        payable
        returns (TransactionData memory);
}
