// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IAcrossSpokePool {
    function deposit(
        address recipient, // Recipient address
        address originToken, // Address of the token
        uint256 amount, // Token amount
        uint256 destinationChainId, // ⛓ id
        int64 relayerFeePct, // see #Fees Calculation
        uint32 quoteTimestamp, // Timestamp for the quote creation
        bytes memory message, // Arbitrary data that can be used to pass additional information to the recipient along with the tokens.
        uint256 maxCount // Used to protect the depositor from frontrunning to guarantee their quote remains valid.
    ) external payable;
}
