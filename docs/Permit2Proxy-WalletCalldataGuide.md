# Permit2Proxy: Wallet Integration & Calldata Guide

For backend developers integrating gasless flows with the LI.FI diamond via Permit2Proxy. This guide explains which function to use, how to encode calldata, and how to support a new ERC-1271 wallet type.

---

## 1. Concept

- **Permit2Proxy** pulls tokens from the user (using a signed permit or Permit2), then executes **`diamondCalldata`** on the LI.FI diamond (e.g. bridge, swap). The proxy holds no funds; it approves the diamond and forwards the call.
- **Caller = signer**: All entrypoints except `callDiamondWithPermit2Witness` require `msg.sender` to be the wallet that signed (front-run protection). The witness flow takes `signer` as a parameter, so a relayer can submit on behalf of the signer.
- **`diamondCalldata`**: Raw ABI-encoded call to the diamond—same as the calldata of a normal transaction to the diamond (selector + encoded arguments). The proxy does not modify it.

---

## 2. Which Function to Choose

| Scenario | Function | Token / Wallet |
|----------|----------|----------------|
| Token has no EIP-2612; use Uniswap Permit2 | `callDiamondWithPermit2(diamondCalldata, permit, signature)` | Any ERC-20; wallet signs Permit2 `PermitTransferFrom`. Spender = Permit2Proxy. |
| Same, but signature bound to diamond + calldata (replay-safe) | `callDiamondWithPermit2Witness(diamondCalldata, signer, permit, signature)` | Any ERC-20; sign Permit2 **with witness** (LiFiCall: diamond + `keccak256(diamondCalldata)`). Caller can be anyone; signer is explicit. |
| Token has classic EIP-2612 `permit(owner, spender, value, deadline, v, r, s)` | `callDiamondWithEIP2612Signature(token, amount, deadline, v, r, s, diamondCalldata)` | Token uses ecrecover; owner is EOA or contract that exposes standard permit. |
| Token has `permit(..., bytes)` and owner is an ERC-1271 contract (e.g. smart wallet) | `callDiamondWithEIP2612Signature(token, amount, deadline, signature, diamondCalldata)` | Token passes `bytes` to owner’s `isValidSignature`; format is **wallet-defined**. Backend builds full signature bytes per wallet type. Uses IERC20Permit7597. |
| Token has EIP-3009 `receiveWithAuthorization` (v,r,s or bytes) | `callDiamondWithEIP3009Signature(...)` | **Only EIP-3009 path we support.** Front-run safe (only the proxy can execute). Tokens that only have `transferWithAuthorization` are not supported—that path can be front-run so we do not expose it. Caller must be the signer. |

---

## 3. Encoding `diamondCalldata`

`diamondCalldata` is the exact calldata the diamond would receive if the user had approved it and sent the transaction themselves.

**Example (Solidity):**

```solidity
// Call a view on the diamond (e.g. facetAddress for a selector)
bytes memory diamondCalldata = abi.encodeWithSelector(
    IDiamondLoupe.facetAddress.selector,
    bytes4(0x1626ba7e)
);

// Example: start a bridge (selector + your bridge params)
bytes memory diamondCalldata = abi.encodeWithSelector(
    ISomeFacet.startBridge.selector,
    bridgeData
);
```

**Example (TypeScript / ethers):**

```ts
const iface = new ethers.Interface(["function startBridge((...))"]);
const diamondCalldata = iface.encodeFunctionData("startBridge", [bridgeData]);
```

Use the diamond ABI and the same encoding you would use for a direct `LIFI_DIAMOND.call(diamondCalldata)`.

---

## 4. Permit2 Flow (`callDiamondWithPermit2`)

1. Build **PermitTransferFrom**: `permitted: { token, amount }`, `nonce`, `deadline`. Spender in the signed message must be the **Permit2Proxy** address (so the proxy can call `permitTransferFrom`).
2. Build EIP-712 digest: Permit2 domain (name `"Permit2"`, chainId, Permit2 address) + typehash for `PermitTransferFrom` (token, amount, spender, nonce, deadline). Prefix with `\x19\x01`.
3. Sign the digest with the user’s key → `signature`.
4. Call `callDiamondWithPermit2(diamondCalldata, permit, signature)` with **msg.sender = signer**.

Parameter order: **diamondCalldata first**, then permit struct, then signature.

---

## 4.1 Permit2 with Witness (`callDiamondWithPermit2Witness`)

The witness flow binds the signature to the **LI.FI diamond address** and **keccak256(diamondCalldata)**. A signed permit cannot be replayed with different calldata or a different diamond. Use this when you want the signer's approval to be valid only for a specific diamond call.

1. Build **PermitTransferFrom** as in §4, with spender = **Permit2Proxy**.
2. Build the **witness**: `LiFiCall(diamondAddress: LIFI_DIAMOND, diamondCalldataHash: keccak256(diamondCalldata))`. The contract uses `WITNESS_TYPE_STRING` and `WITNESS_TYPEHASH` for EIP-712; you can get the exact message hash from the proxy via **`getPermit2MsgHash(diamondCalldata, token, amount, nonce, deadline)`**.
3. Sign the **PermitTransferFrom with witness** digest (Permit2's `PermitTransferFromWithWitness` type, with your witness type string) → `signature`.
4. Call `callDiamondWithPermit2Witness(diamondCalldata, signer, permit, signature)`. **msg.sender** can be anyone (e.g. relayer); **signer** is the address that signed and must hold the tokens.

Parameter order: **diamondCalldata**, **signer**, **permit**, **signature**.

### Permit2 nonce helpers

- **`nextNonce(owner)`** — Returns the first valid nonce for `owner` (starting from 0). Use when signing a single permit.
- **`nextNonceAfter(owner, start)`** — Returns the first valid nonce after `start`. Use when signing multiple permits in sequence and you need the next unused nonce.

---

## 5. EIP-2612 Classic Flow (7-arg overload)

For tokens with `permit(owner, spender, value, deadline, v, r, s)`:

1. Get token `DOMAIN_SEPARATOR()` and `nonces(owner)`.
2. Build EIP-712 digest: `Permit(owner, spender, value, nonce, deadline)` with the token’s domain.
3. Sign → (v, r, s).
4. Call `callDiamondWithEIP2612Signature(tokenAddress, amount, deadline, v, r, s, diamondCalldata)` with **msg.sender = owner**.

---

## 6. EIP-2612 `permit(..., bytes)` for ERC-1271 Wallets

Tokens (e.g. native USDC) may implement `permit(owner, spender, value, deadline, bytes calldata signature)`. The token forwards the permit hash and `signature` to the **owner** (the wallet contract), which implements ERC-1271: `isValidSignature(bytes32 hash, bytes memory signature)`. The **format of `signature` is defined by the wallet**, not by the token. The backend must build the full signature bytes for the wallet type and call `callDiamondWithEIP2612Signature(token, amount, deadline, signature, diamondCalldata)`.

### 6.1 Building the permit hash

1. Same as classic EIP-2612: `Permit(owner, spender, value, nonce, deadline)` with the token’s `DOMAIN_SEPARATOR`.
2. Some wallets wrap the hash (e.g. `replaySafeHash(hash)`). If the wallet exposes such a function, the user must sign the wrapped hash; otherwise sign the standard permit hash.

### 6.2 Coinbase Smart Wallet example

- **Coinbase Smart Wallet + Arb. native USDC:** Build the EIP-2612 permit digest (token `DOMAIN_SEPARATOR`, `Permit(owner, spender, value, nonce, deadline)`), sign it to get (r, s, v), then set `signature = abi.encode(ownerIndex, abi.encodePacked(r, s, v))` and call `callDiamondWithEIP2612Signature(token, amount, deadline, signature, diamondCalldata)` with `msg.sender = wallet`.

Coinbase expects:

```solidity
signature = abi.encode(ownerIndex, abi.encodePacked(r, s, v))
```

Build that off-chain and pass it as the `signature` argument.

**Example (pseudo):**

```ts
const rsv = ethers.concat([sig.r, sig.s, sig.v]);
const signature = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "bytes"],
  [ownerIndex, rsv]
);
// Then: callDiamondWithEIP2612Signature(token, amount, deadline, signature, diamondCalldata)
```

---

## 7. Adding a New Wallet Type (permit(..., bytes))

To support a new ERC-1271 wallet with a token that has `permit(..., bytes)`:

1. **Confirm token interface**  
   Token must expose `permit(owner, spender, value, deadline, bytes calldata)` (e.g. ERC-7597 style). Not the 7-arg `permit(..., v, r, s)`.

2. **Discover the wallet’s signature format**  
   Inspect the wallet’s ERC-1271 path: what does it expect as the second argument of `isValidSignature(hash, signature)`?  
   - Read the wallet contract or docs.  
   - Look for decoding of `signature` (e.g. `abi.decode(signature, (uint256, bytes))` or similar).

3. **Build permit hash and sign**  
   Standard EIP-2612 permit hash; apply any wallet-specific wrapper (e.g. replay-safe hash) if required. Sign to get (v, r, s).

4. **Format signature bytes off-chain**  
   Build the full `signature` bytes to match the wallet’s expected format (e.g. raw 65-byte `abi.encodePacked(r,s,v)`, or ABI-encoded structs).

5. **Call the proxy**  
   Call `callDiamondWithEIP2612Signature(tokenAddress, amount, deadline, signature, diamondCalldata)` with **msg.sender = wallet** (the permit owner).

---

## 8. EIP-3009 receiveWithAuthorization (only supported EIP-3009 path)

We support **only** **receiveWithAuthorization** for EIP-3009. We do **not** support **transferWithAuthorization**: the token allows anyone to submit a signed transferWithAuthorization, so it can be front-run (another party can consume the nonce and move tokens to the proxy before the user's diamond call runs). To avoid liability for front-run losses on transactions we produce, we do not expose that path.

**`callDiamondWithEIP3009Signature`** uses the token's **receiveWithAuthorization**. The token requires **`msg.sender == to`** (the payee), so only the Permit2Proxy can execute when `to` is the proxy—front-run safe. Use this for EIP-3009 tokens that implement receiveWithAuthorization (e.g. USDC).

1. Build EIP-712 digest: typehash `ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)` with the token's domain, `from` = signer, `to` = **Permit2Proxy** address.
2. Sign → (v, r, s) or encode as wallet-specific `bytes` for ERC-7598.
3. Call `callDiamondWithEIP3009Signature(tokenAddress, amount, validAfter, validBefore, nonce, v, r, s, diamondCalldata)` or the overload with `signature` (bytes). **msg.sender must be the signer.**

---

## 9. Quick Reference

| Entrypoint | Main use | Calldata order |
|------------|----------|----------------|
| `callDiamondWithPermit2` | Permit2; any token | `(diamondCalldata, permit, signature)` |
| `callDiamondWithPermit2Witness` | Permit2 with witness (diamond + calldata bound) | `(diamondCalldata, signer, permit, signature)` |
| `getPermit2MsgHash` | View: EIP-712 message hash for witness permit signing | `(diamondCalldata, assetId, amount, nonce, deadline)` |
| `nextNonce` / `nextNonceAfter` | View: next valid Permit2 nonce for an owner | `(owner)` or `(owner, start)` |
| `callDiamondWithEIP2612Signature` (7 args) | Classic permit(v,r,s) | `(token, amount, deadline, v, r, s, diamondCalldata)` |
| `callDiamondWithEIP2612Signature` (5 args) | permit(..., bytes); ERC-1271 / ERC-7597 | `(token, amount, deadline, signature, diamondCalldata)` |
| `callDiamondWithEIP3009Signature` (9 args) | EIP-3009 receiveWithAuthorization (v,r,s) | `(token, amount, validAfter, validBefore, nonce, v, r, s, diamondCalldata)` |
| `callDiamondWithEIP3009Signature` (7 args) | EIP-3009 receiveWithAuthorization (bytes) | `(token, amount, validAfter, validBefore, nonce, signature, diamondCalldata)` |

All EIP-2612 and EIP-3009 flows: **msg.sender must be the permit/authorization signer.** Permit2: **msg.sender must be the signer** for `callDiamondWithPermit2`; for `callDiamondWithPermit2Witness`, **signer** is a parameter and can differ from msg.sender (e.g. relayer submits).
