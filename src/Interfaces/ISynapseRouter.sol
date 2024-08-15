// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

interface ISynapseRouter {
    /// @notice Struct representing a request for SynapseRouter.
    /// @dev tokenIn is supplied separately.
    /// @param swapAdapter Adapter address that will perform the swap.
    ///                    Address(0) specifies a "no swap" query.
    /// @param tokenOut Token address to swap to.
    /// @param minAmountOut Minimum amount of tokens to receive after the swap,
    ///                     or tx will be reverted.
    /// @param deadline Latest timestamp for when the transaction needs to be executed,
    ///                 or tx will be reverted.
    /// @param rawParams ABI-encoded params for the swap that will be passed to `swapAdapter`.
    ///                  Should be SynapseParams for swaps via SynapseAdapter.
    struct SwapQuery {
        address swapAdapter;
        address tokenOut;
        uint256 minAmountOut;
        uint256 deadline;
        bytes rawParams;
    }

    /// @notice Struct representing a request for a swap quote from a bridge token.
    /// @dev tokenOut is passed externally.
    /// @param symbol Bridge token symbol: unique token ID consistent among all chains.
    /// @param amountIn Amount of bridge token to start with, before the bridge fee is applied.
    struct DestRequest {
        string symbol;
        uint256 amountIn;
    }

    /// @notice Struct representing a bridge token.
    ///         Used as the return value in view functions.
    /// @param symbol Bridge token symbol: unique token ID consistent among all chains.
    /// @param token Bridge token address.
    struct BridgeToken {
        string symbol;
        address token;
    }

    /// @notice Initiate a bridge transaction with an optional swap on both origin
    ///         and destination chains.
    /// @dev Note This method is payable.
    ///      If token is ETH_ADDRESS, this method should be invoked with `msg.value = amountIn`.
    ///      If token is ERC20, the tokens will be pulled from msg.sender (use `msg.value = 0`).
    ///      Make sure to approve this contract for spending `token` beforehand.
    ///      originQuery.tokenOut should never be ETH_ADDRESS, bridge only works with ERC20 tokens.
    ///
    ///      `token` is always a token user is sending.
    ///      In case token requires a wrapper token to be bridge,
    ///      use underlying address for `token` instead of the wrapper one.
    ///
    ///      `originQuery` contains instructions for the swap on origin chain.
    ///      As above, originQuery.tokenOut should always use the underlying address.
    ///      In other words, the concept of wrapper token is fully abstracted away from the end user.
    ///
    ///      `originQuery` is supposed to be fetched using SynapseRouter.getOriginAmountOut().
    ///      Alternatively one could use an external adapter for more complex swaps on the origin chain.
    ///
    ///      `destQuery` is supposed to be fetched using SynapseRouter.getDestinationAmountOut().
    ///      Complex swaps on destination chain are not supported for the time being.
    ///      Check contract description above for more details.
    /// @param to Address to receive tokens on destination chain.
    /// @param chainId Destination chain id.
    /// @param token Initial token for the bridge transaction to be pulled from the user.
    /// @param amount Amount of the initial tokens for the bridge transaction.
    /// @param originQuery Origin swap query. Empty struct indicates no swap is required.
    /// @param destQuery Destination swap query. Empty struct indicates no swap is required.
    function bridge(
        address to,
        uint256 chainId,
        address token,
        uint256 amount,
        SwapQuery memory originQuery,
        SwapQuery memory destQuery
    ) external payable;

    /// @notice Finds the best path between `tokenIn` and every supported bridge token
    ///         from the given list, treating the swap as "origin swap",
    ///         without putting any restrictions on the swap.
    /// @dev Will NOT revert if any of the tokens are not supported,
    ///      instead will return an empty query for that symbol.
    ///      Check (query.minAmountOut != 0): this is true only if the swap is possible
    ///      and bridge token is supported.
    ///      The returned queries with minAmountOut != 0 could be used as `originQuery`
    ///      with SynapseRouter.
    /// Note: It is possible to form a SwapQuery off-chain using alternative SwapAdapter
    ///       for the origin swap.
    /// @param tokenIn Initial token that user wants to bridge/swap.
    /// @param tokenSymbols List of symbols representing bridge tokens.
    /// @param amountIn Amount of tokens user wants to bridge/swap.
    /// @return originQueries List of structs that could be used as `originQuery` in SynapseRouter.
    ///                       minAmountOut and deadline fields will need to be adjusted
    ///                       based on the user settings.
    function getOriginAmountOut(
        address tokenIn,
        string[] memory tokenSymbols,
        uint256 amountIn
    ) external view returns (SwapQuery[] memory originQueries);

    /// @notice Finds the best path between every supported bridge token from
    ///         the given list and `tokenOut`, treating the swap as "destination swap",
    ///         limiting possible actions to those available for every bridge token.
    /// @dev Will NOT revert if any of the tokens are not supported,
    ///      instead will return an empty query for that symbol.
    /// Note: It is NOT possible to form a SwapQuery off-chain using alternative SwapAdapter
    ///       for the destination swap.
    ///       For the time being, only swaps through the Synapse-supported pools
    ///       are available on destination chain.
    /// @param requests List of structs with following information:
    ///                 - symbol: unique token ID consistent among all chains.
    ///                 - amountIn: amount of bridge token to start with,
    ///                              before the bridge fee is applied.
    /// @param tokenOut Token user wants to receive on destination chain.
    /// @return destQueries List of structs that could be used as `destQuery` in SynapseRouter.
    ///                     minAmountOut and deadline fields will need to be adjusted based
    ///                     on the user settings.
    function getDestinationAmountOut(
        DestRequest[] memory requests,
        address tokenOut
    ) external view returns (SwapQuery[] memory destQueries);

    /// @notice Gets the list of all bridge tokens (and their symbols),
    ///         such that destination swap from a bridge token to `tokenOut` is possible.
    /// @param tokenOut Token address to swap to on destination chain
    /// @return tokens List of structs with following information:
    ///                - symbol: unique token ID consistent among all chains
    ///                - token: bridge token address
    function getConnectedBridgeTokens(
        address tokenOut
    ) external view returns (BridgeToken[] memory tokens);
}
