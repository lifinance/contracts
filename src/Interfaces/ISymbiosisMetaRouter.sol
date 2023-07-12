// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface ISymbiosisMetaRouter {
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
