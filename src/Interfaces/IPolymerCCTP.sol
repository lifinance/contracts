// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {ILiFi} from "../Interfaces/ILiFi.sol";

struct PolymerCCTPData {
    uint256 polymerTokenFee;
    uint256 maxCCTPFee;
    bytes32 nonEvmAddress; // Should only be nonzero if submitting to a nonEvm chain
    uint32 minFinalityThreshold;
}

interface IPolymerCCTPFacet {
    error InvalidAddress();
    error InvalidBridgeAmount();
    error InvalidBridgeReceiver();
    error InvalidSendingAsset( address actual, address expected);

    event PolymerCCTPFeeSent( uint256 bridgeAmount, uint256 polymerFee, uint32 minFinalityThreshold);

    function startBridgeTokensViaPolymerCCTP(ILiFi.BridgeData memory _bridgeData, PolymerCCTPData calldata _polymerData)
        external
        payable;
}
