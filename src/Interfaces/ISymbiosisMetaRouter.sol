// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface ISymbiosisMetaRouter {
    /// @notice entry point data to Symbiosis contracts
    /// @param firstSwapCalldata calldata for the dex swap to get corresponding asset (USDC) on init chain
    /// @param secondSwapCalldata calldata for swapping wrapped assets on managing chain, wUSDC_eth->wUSDC_polygon
    /// @param approvedTokens set of token for firstSwapCalldata and secondSwapCalldata approving
    /// @param firstDexRouter entry point for firstSwapCalldata
    /// @param secondDexRouter entry point for secondSwapCalldata
    /// @param entry amount of tokens
    /// @param nativeIn native token in amount or not
    /// @param relayRecipient inner object of bridge provided from API
    /// @param otherSideCalldata calldata with unwrapping and swap on dest chain (if packed)
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
     * @notice Method that starts the Meta Routing
     * @dev external + internal swap for burn scheme, only external for synth scheme
     * @dev calls the next method on the other side
     * @param _metarouteTransaction metaRoute offchain transaction data
     */
    function metaRoute(
        MetaRouteTransaction calldata _metarouteTransaction
    ) external payable;
}
