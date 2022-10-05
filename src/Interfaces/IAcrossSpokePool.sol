// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IAcrossSpokePool {
    function deposit(
        address recipient, // Recipient address
        address originToken, // Address of the token
        uint256 amount, // Token amount
        uint256 destinationChainId, // ⛓ id
        uint64 relayerFeePct, // see #Fees Calculation
        uint32 quoteTimestamp // Timestamp for the quote creation
    ) external payable;
}
