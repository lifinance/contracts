# FeeForwarder

## Description

Periphery contract that forwards various fee amounts directly to their destination wallets. This contract is highly gas-optimized and designed to be called by the LiFiDiamond after fees have been calculated for a swap or bridge execution.

If called by the LiFiDiamond, it's important that the diamond properly handles the remaining funds returned by the FeeForwarder, otherwise funds will remain in the diamond contract and could get stolen.

## Gas Optimizations

The contract implements several gas optimizations to minimize transaction costs:

- **No Length Validation**: Empty distribution arrays are allowed and will not revert (saves ~2,000-3,000 gas)
- **No Approval Checks**: The contract relies on natural failures when insufficient balance or approvals exist (saves ~2,000-3,000 gas)
- **No Zero Amount Validation**: Zero amounts are allowed and will succeed but transfer nothing (saves ~1,000-2,000 gas)
- **Single Loop for Native Fees**: Uses one optimized loop instead of separate validation and transfer loops (saves ~5,000-10,000 gas)

The native refund is derived from `msg.value` minus the sum of the distributed amounts rather than from the contract's balance. Accumulating that sum inside the existing loop and checking it against `msg.value` costs a measured +61 gas for one distribution, +84 for two and +107 for three — accepted deliberately, see [Security Considerations](#security-considerations).

## How To Use

The contract supports ERC20 and native assets with three dedicated functions.

### Forwarding ERC20 Fees

```solidity
/// @notice Forwards ERC20 token fees from the caller to the specified recipients
/// @param token address of the token being forwarded
/// @param distributions array of fee distributions containing recipients and amounts
function forwardERC20Fees(
    address token,
    FeeDistribution[] calldata distributions
)
```

**Important Notes:**

- The caller must have approved this contract to spend the tokens before calling this function
- Native token addresses (address(0)) will cause the transaction to revert naturally
- Empty arrays will succeed and emit the FeesForwarded event
- Zero amounts will succeed but transfer nothing

### Forwarding ERC20 Fees as a Share of the Output

```solidity
/// @notice Forwards bps shares of the caller's full ERC20 balance to the specified recipients
/// @param token address of the token being forwarded
/// @param distributions array of recipients and their shares in basis points
function forwardERC20FeesBps(
    address token,
    FeeBpsDistribution[] calldata distributions
)
```

Used as a swap step right after the swap that produces `token`, so the fee is a share of the actual output instead of a fixed amount computed off-chain from `toAmountMin`.

Each share is `balanceOf(caller) * bps / 10_000`, rounded down. The balance is read once before the first transfer; whatever the shares leave behind stays with the caller.

**Important Notes:**

- The caller must have approved this contract to spend the tokens
- Put **all** fees for `token` into a single call. A second call computes its shares from the balance the first one already reduced, so the fees compound
- The fee base is the caller's full balance of `token`, including any balance it held before the swap (same full-balance pattern as [OutputValidator](OutputValidator.md)). `GenericSwapFacetV3` pays that full balance to the receiver. The `SwapperV2` bridge flows credit only the balance increase, so there the fee on a pre-existing balance is borne by the user
- Reverts with `InvalidTotalBps(totalBps)` once the running total of the shares passes 10_000 bps; `totalBps` is the running total at that share
- Reverts with `InvalidReceiver` for a zero-address recipient, whatever its share
- A share that rounds to zero (or a 0 bps entry) is skipped instead of transferred, so tokens that revert on zero-value transfers don't fail the call. The recipient is still listed in the event with amount 0
- The `FeesForwarded` event carries the computed amounts, in input order
- ERC20 only: `address(0)` reverts with `NullAddrIsNotAnERC20Token`

**Using it in `GenericSwapFacetV3`:**

- Set `sendingAssetId` and `receivingAssetId` of the fee step to `token`, so the facet does not refund the step's sending asset as positive slippage
- Set `requiresDeposit` to `false`: with it set, the facet pulls `fromAmount` from the user
- `fromAmount` must be non-zero, and it does not affect the fee: the facet uses it to decide whether to renew its max approval to this contract, and reports it as the step's input amount in `AssetSwapped`. The fee step's `AssetSwapped` shows the facet's full balance as `toAmount`; the forwarded amounts are in `FeesForwarded`
- The facet checks `minAmountOut` against its balance **after** all steps, so pass the amount net of fees

### Forwarding Native Fees

```solidity
/// @notice Forwards native token fees to the specified recipients
/// @param distributions array of fee distributions containing recipients and amounts
function forwardNativeFees(
    FeeDistribution[] calldata distributions
) external payable
```

**Important Notes:**

- Provide at least the sum of all fee amounts via `msg.value`
- The unspent part of `msg.value` is automatically returned to the caller
- Empty arrays will succeed, emit the FeesForwarded event, and refund all sent value
- Zero amounts will succeed but transfer nothing
- Transaction will revert if insufficient funds are provided (see [Error Handling](#error-handling))
- A balance already sitting in the contract is never paid out as a refund; only the owner can recover it

## Data Structures

### FeeDistribution Struct

```solidity
struct FeeDistribution {
  address recipient; // 20 bytes - The address that will receive the fee amount
  uint256 amount; // 32 bytes - The amount of tokens to distribute to the recipient
}
```

### FeeBpsDistribution Struct

```solidity
struct FeeBpsDistribution {
  address recipient; // The address that will receive the fee share
  uint16 bps; // The share of the caller's balance in basis points (10_000 = 100%)
}
```

## Events

### FeesForwarded

```solidity
event FeesForwarded(address indexed token, FeeDistribution[] distributions);
```

- **token**: The address of the token that was forwarded (address(0) for native tokens)
- **distributions**: Array of fee distributions that were processed (for `forwardERC20FeesBps`, the computed amounts)

**Note**: This event is always emitted, even for empty arrays, as it's outside the distribution loop.

## Error Handling

The contract uses minimal error checking for gas optimization:

- **InvalidConfig**: Thrown when constructor receives zero address as owner
- **InvalidReceiver**: Thrown when distribution recipient is zero address (via LibAsset; checked up front in `forwardERC20FeesBps`)
- **Natural Failures**: Insufficient balance or approvals will cause natural reverts
- **InvalidTotalBps(totalBps)**: Thrown by `forwardERC20FeesBps` when the shares add up to more than 10_000 bps; carries the running total at the first share past the limit
- **NullAddrIsNotAnERC20Token**: Thrown by `forwardERC20FeesBps` when `address(0)` is passed as the token
- **InsufficientBalance(required, balance)**: Thrown by `forwardNativeFees` when the distributions sum to more than `msg.value` **and** the contract's own balance was able to cover the shortfall — the invocation is refusing to spend funds its caller did not provide. Without such a balance the failing transfer reverts first with `ETHTransferFailed`, so under-funding surfaces as one of these two errors depending on whether a stray balance is present

## Security Considerations

- **Owner Recovery**: The contract inherits from `WithdrawablePeriphery`, enabling the owner to recover stray funds
- **No Fund Accumulation By Design**: A normal invocation forwards everything it receives and ends with no net balance. A balance that arrives some other way (e.g. a forced transfer) is not swept out by the next caller — it stays put until the owner recovers it, so a non-zero balance on this contract is stranded funds rather than an in-flight call
- **Automatic Refunds**: The unspent part of `msg.value` is automatically returned to the caller
- **Zero Address Protection**: Zero recipient addresses are validated and will revert
- **Reentrancy**: Native fees are paid out with all gas forwarded, so a recipient can call back into `forwardNativeFees` while the outer call is still running. Re-entry is not blocked; it is made unprofitable. Because each invocation refunds `msg.value` minus its own distributions, a nested call can never be paid from the outer call's undistributed funds or from a stray balance — it reverts with `InsufficientBalance` instead. A `nonReentrant` guard would block the nested call outright, but costs a measured +7,266 gas per call on this contract (a quarter of a single native distribution), because the repo's guard writes a storage slot and Solidity 0.8.17 has no transient storage.
- **Recipients Are Trusted For Liveness**: A fee recipient cannot take funds it was not allocated, but it can still make the whole call fail — by reverting in its `receive` hook, or by letting a failed nested call bubble up. `LibAsset.transferNativeAsset` has no `try/catch`, so any recipient failure reverts the entire invocation and, with it, the surrounding route. Only include recipients that are trusted not to grief.

## Gas Usage Estimates

| Operation                        | Gas Range      | Notes                          |
| -------------------------------- | -------------- | ------------------------------ |
| ERC20 Transfer (1 distribution)  | ~22,682-57,640 | Depends on token complexity    |
| ERC20 Transfer (multiple)        | ~86,458        | For large distributions        |
| Native Transfer (1 distribution) | ~22,211-30,894 | Depends on amount              |
| Native Transfer (multiple)       | ~49,563-61,328 | For multiple distributions     |
| Empty Arrays                     | ~15,509-21,514 | Events emitted, no transfers   |
| Zero Amounts                     | ~25,762-25,903 | Succeeds but transfers nothing |
