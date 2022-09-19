// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

interface ILiFi {
    /// Structs ///

    struct LiFiData {
        bytes32 transactionId;
        string integrator;
        address referrer;
        address sendingAssetId;
        address receivingAssetId;
        address receiver;
        uint256 destinationChainId;
        uint256 amount;
    }

    /// Events ///

    event LiFiTransferStarted(
        bytes32 indexed transactionId,
        string bridge,
        string bridgeData,
        string integrator,
        address referrer,
        address sendingAssetId,
        address receivingAssetId,
        address receiver,
        uint256 amount,
        uint256 destinationChainId,
        bool hasSourceSwap,
        bool hasDestinationCall
    );

    event LiFiTransferCompleted(
        bytes32 indexed transactionId,
        address receivingAssetId,
        address receiver,
        uint256 amount,
        uint256 timestamp
    );
}
