// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title LiFiData
/// @author Li.Finance (https://li.finance)
/// @notice A storage for LI.FI-internal config data (addresses, chainIDs, etc.)
/// @custom:version 1.0.0
contract LiFiData {
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    uint256 internal constant LIFI_CHAIN_ID_ETHEREUM = 1;
    uint256 internal constant LIFI_CHAIN_ID_BSC = 56;
    uint256 internal constant LIFI_CHAIN_ID_TRON = 0;
    uint256 internal constant LIFI_CHAIN_ID_SOLANA = 1151111081099710;
    uint256 internal constant LIFI_CHAIN_ID_POLYGON = 137;
    uint256 internal constant LIFI_CHAIN_ID_ARBITRUM = 42161;
    uint256 internal constant LIFI_CHAIN_ID_AVALANCHE = 43114;
    uint256 internal constant LIFI_CHAIN_ID_BASE = 8453;
    uint256 internal constant LIFI_CHAIN_ID_OPTIMISM = 10;
    uint256 internal constant LIFI_CHAIN_ID_CELO = 42220;
    uint256 internal constant LIFI_CHAIN_ID_SUI = 9270000000000000;
}
