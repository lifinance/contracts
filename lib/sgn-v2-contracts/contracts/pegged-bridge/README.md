# Pegged Token Bridge

Goal: Token T exists on chain A but not on chain B, and we would like to support a 1:1 pegged token T' on chain B.

Approach: Deploy a PeggedToken ([example](./tokens/MultiBridgeToken.sol)) on chain B with zero initial supply, and config SGN (through gov) to mark it as 1:1 pegged to the chain A’s original token. Anyone can lock original token T on chain A’s OriginalTokenVault contract to trigger mint of pegged token T’ on chain B through the PeggedTokenBridge contract accordingly.

## Basic workflows

### Deposit original token on chain A and mint pegged token on chain B

1. User calls [deposit](./OriginalTokenVault.sol#L72) on chain A to lock original tokens in chain A’s vault contract.
2. SGN generates the [Mint proto msg](../libraries/proto/pegged.proto#L14) cosigned by validators, and call [mint](./PeggedTokenBridge.sol#L55) function on chain B.

### Burn pegged token on chain B and withdraw original token on chain A

1. User calls [burn](./PeggedTokenBridge.sol#L104) on chain B to burn the pegged token.
2. SGN generates the [Withdraw proto msg](../libraries/proto/pegged.proto#L34) cosigned by validators, and call [withdraw](./OriginalTokenVault.sol#L131) function on chain A.

### Burn pegged token on chain B (PeggedTokenBridgeV2) and mint pegged token on chain C

1. User calls [burn](./PeggedTokenBridgeV2.sol#L116) on chain B to burn the pegged token, specifying chain C's chainId as `toChainId`.
2. SGN generates the [Mint proto msg](../libraries/proto/pegged.proto#L14) cosigned by validators, and call [mint](./PeggedTokenBridge.sol#L55) function on chain C.

## Safeguard monitoring

Anyone can verify the correctness of the pegged bridge behavior by tracking the contract events ([Deposit](./OriginalTokenVault.sol#L31), [Withdrawn](./OriginalTokenVault.sol#L39), [Mint](./PeggedTokenBridge.sol#L24), [Burn](./PeggedTokenBridge.sol#L39)), and verifying the `refChainId` and `refId` fields of `Mint` and `Withdrawn` events according to the code comments ([example](./OriginalTokenVault.sol#L44-L53)).

For example, if we catch a `Withdrawn` event on chain A with `refChainId` of chain B and a `refId`, then we should be able to find a `Burn` event on chain B with `burnId` equals to `refId`, and then compare values of other fields of these two events.
