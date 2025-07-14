// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title LiFiData
/// @author Li.Finance (https://li.finance)
/// @notice A storage for LI.FI-internal config data (addresses, chainIDs, etc.)
/// @custom:version 1.0.0
contract LiFiData {
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    // LI.FI non-EVM Custom Chain IDs (IDs are made up by the LI.FI team)
    uint256 internal constant LIFI_CHAIN_ID_BCH = 20000000000002;
    uint256 internal constant LIFI_CHAIN_ID_BTC = 20000000000001;
    uint256 internal constant LIFI_CHAIN_ID_DGE = 20000000000004;
    uint256 internal constant LIFI_CHAIN_ID_LTC = 20000000000003;
    uint256 internal constant LIFI_CHAIN_ID_SOLANA = 1151111081099710;
    uint256 internal constant LIFI_CHAIN_ID_SUI = 9270000000000000;
    uint256 internal constant LIFI_CHAIN_ID_TRON = 0; //TODO: update with correct chainId
    uint256 internal constant LIFI_CHAIN_ID_TER = 1161011141099710; //TODO: update with full name
    uint256 internal constant LIFI_CHAIN_ID_OAS = 111971151099710; //TODO: update with full name
}
