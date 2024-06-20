// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface ISymbiosisMetaRouter {
    /// @notice entry point data to Symbiosis contracts
    /// @param firstSwapCalldata calldata for the dex swap to get corresponding asset (USDC) on init chain
    /// @param secondSwapCalldata legacy calldata from v1, should be empty
    /// @param approvedTokens set of token for firstSwapCalldata, and o bridgingCalldata
    /// @param firstDexRouter entry point for firstSwapCalldata
    /// @param secondDexRouter legacy entry point from v1, should be empty
    /// @param amount of tokens
    /// @param nativeIn native token in amount or not
    /// @param relayRecipient entry point to bridge provided from API
    /// @param otherSideCalldata bridging calldata
    struct MetaRouteTransaction {
        bytes firstSwapCalldata;
        bytes secondSwapCalldata;
        address[] approvedTokens;
        address firstDexRouter;
        address secondDexRouter;
        uint256 amount;
        bool nativeIn;
        address relayRecipient;
        bytes otherSideCalldata;
    }

    /**
     * @notice Method that starts the Meta Routing in Symbiosis
     * @param _metarouteTransaction metaRoute offchain transaction data
     */
    function metaRoute(
        MetaRouteTransaction calldata _metarouteTransaction
    ) external payable;
}
