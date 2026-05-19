# Periphery — past findings

## LF-021 · HIGH · Permit2Proxy · fixed

**Recognition signal:** Permit-style flow where token-pull authorization is signed but the downstream call target/calldata is left as caller-controlled arguments — any front-runner can hijack the pull and redirect the funds.

**Root cause:** callDiamondWithEIP2612Signature accepts a signed EIP-2612 permit but the diamondAddress and diamondCalldata are not part of the signed payload. An attacker can observe the pending transaction, extract the signature, and resubmit with malicious calldata/recipient to redirect the user's pulled tokens.

**Fix:** Calldata/diamond target are bound into the signed payload so the signature commits to the action being executed. Fixed in 0e3debb78abcdf9a9f934115338b611e16b039a0.

**Source:** `2024.11.22_Permit2Proxy.pdf` p.5-5 · `audit20241122::6.1.1`

---

## LF-082 · HIGH · Patcher · acknowledged

**Recognition signal:** A periphery contract that pulls tokens via transferFrom from msg.sender while invoking caller-supplied call targets/data, with no per-call approval pattern or sender/owner pairing.

**Root cause:** depositAndExecuteWithMultiplePatches / depositAndExecuteWithDynamicPatches accept arbitrary call targets and pull tokens from msg.sender via existing approvals. A second caller can use the user's outstanding Patcher approval to invoke transferFrom-style calldata against the original approver, draining funds.

**Fix:** Acknowledged in 68b91b10: documented as accepted risk in Patcher NatSpec and Patcher.md; no on-chain guard added.

**Source:** `2025.07.30_Patcher(v1.0.0).pdf` p.4-5 · `audit20250730::6.1.1`

---

## LF-001 · MEDIUM · RouteProcessor4 · fixed

**Recognition signal:** Native-asset transfer that uses `address(this).balance` as the amount in a path that should only forward a function-scoped local amount, in contracts that can hold native balances across calls.

**Root cause:** After unwrapping `amountIn` of WETH via `IWETH.withdraw`, the contract forwards `address(this).balance` to the user-supplied `to` address instead of `amountIn`. Any non-transient native balance held by the router (e.g., dust, mid-route balances) is therefore swept into `to` on every unwrap.

**Fix:** Forward only `amountIn` instead of `address(this).balance`. Fixed in commit c7053b38.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.4-4 · `audit20240201::3.1.1`

---

## LF-002 · MEDIUM · RouteProcessor4 · fixed

**Recognition signal:** Direct `IERC20.approve(...)` / `transfer(...)` calls on user-supplied tokens without going through SafeERC20 wrappers, in a router/aggregator that must support non-standard ERC20s.

**Root cause:** `IERC20(tokenIn).approve(pool, amountIn)` decodes the return value as `bool`. Tokens like USDT do not return any value from `approve()`, so the call reverts on ABI return-data decoding even though the on-chain effect succeeded.

**Fix:** Use OpenZeppelin SafeERC20 `safeIncreaseAllowance` (or equivalent) which tolerates non-standard return shapes. Fixed in commits bbb90746 and 5e854cc4.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.4-4 · `audit20240201::3.1.2`

---

## LF-003 · MEDIUM · RouteProcessor4 · fixed

**Recognition signal:** Use of `payable(...).transfer(amount)` (or `.send`) for native-asset payout to a user-supplied address.

**Root cause:** Native-token payout in `swapCurve()` uses `payable(to).transfer(amountOut)`. The 2300-gas stipend imposed by `transfer` is incompatible with recipients that perform non-trivial work on receive, and is brittle against future EVM gas-pricing changes.

**Fix:** Replace `.transfer` with `.call{value: ...}('')` and check the success flag. Fixed in commit 03ee79b2.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.5-5 · `audit20240201::3.1.3`

---

## LF-038 · MEDIUM · Permit2Proxy · fixed

**Recognition signal:** Submitting a user-signed EIP-2612 permit inside a multi-step transaction without wrapping the permit() call in try/catch so the surrounding logic still proceeds if the permit was front-run on-chain.

**Root cause:** callDiamondWithEIP2612Signature calls ERC20.permit and then pulls funds in one transaction. An observer can submit the same permit signature directly to the ERC20 first, marking the nonce as used and causing the proxy's subsequent permit call to revert, blocking the user's intended action.

**Fix:** Fixed in bdf16c01 by wrapping the ERC20.permit call in a try/catch and continuing when allowance is already sufficient.

**Source:** `2025.01.10_Cantina_PreComp.pdf` p.4-6 · `audit20250110_1::3.1.1`

---

## LF-074 · MEDIUM · LiFiDEXAggregator · fixed

**Recognition signal:** Function pulls tokens at a wider integer width than it forwards them to the downstream callee, with neither a width check nor a refund of the truncated portion.

**Root cause:** swapIzumiV3 accepts amountIn as uint256 and pulls that full amount from the caller, but truncates it to uint128 when calling the Izumi pool. There is no validation that amountIn fits in uint128 and no refund of the discarded high bits, so any value above type(uint128).max is silently swapped only up to uint128 capacity while the truncated remainder remains trapped in the aggregator.

**Fix:** Fixed in d8935ac by reverting with InvalidCallData when amountIn exceeds type(uint128).max.

**Source:** `2025.06.30_LiFiDexAggregator(v1.11.0).pdf` p.5-5 · `audit20250630::6.1.1`

---

## LF-083 · MEDIUM · Patcher · fixed

**Recognition signal:** Reading a uint256 from a target via low-level call and abi.decode/bytes-cast without validating the target's function selector, return-type, or returndata length.

**Root cause:** _getDynamicValue executes a low-level call against a target and reinterprets the entire returndata as uint256 without checking the called function's return type or length. Non-uint256 return values (bytes, address, bool, larger encodings) are silently coerced into nonsensical numbers used to patch downstream calldata, which can mis-size token amounts and lose user funds.

**Fix:** Fixed in 68b91b10: partial mitigation via 32-byte length check; some 32-byte encoded types (bool, address) remain ambiguous and are documented as an accepted residual risk.

**Source:** `2025.07.30_Patcher(v1.0.0).pdf` p.4-5 · `audit20250730::6.2.1`

---

## LF-004 · LOW · RouteProcessor4 · acknowledged

**Recognition signal:** Assuming a uniform interface across different versions of an external protocol (e.g., legacy vs current Curve `exchange`) when decoding return data, instead of dispatching by pool type or measuring before/after balances.

**Root cause:** `swapCurve()` always decodes the return value of `exchange()` as `amountOut`. Legacy Curve pools' `exchange()` endpoint has no return value, so the call reverts even when the underlying swap would have succeeded with native token in.

**Fix:** Recommended to differentiate pool type and either use the matching interface or compute amountOut from before/after balances. LI.FI acknowledged: no fix because no legacy pools above $1k TVL exist.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.5-5 · `audit20240201::3.2.1`

---

## LF-005 · LOW · RouteProcessor4 · acknowledged

**Recognition signal:** Trusting a caller-supplied token identifier across a self-contained sub-routine without cross-checking it against the on-chain pool's token0/token1 metadata.

**Root cause:** `swapUniV2()` reads `tokenIn` from the stream and uses it both for the `transferFrom` and the swap amount recomputation, but never verifies that `tokenIn` is one of `pool.token0()` / `pool.token1()`. A malformed stream could pass an unrelated token while the pool swap is initiated against a different one.

**Fix:** Recommended adding a check that `tokenIn` matches one of the pool tokens. LI.FI acknowledged; relies on the off-chain library to construct streams correctly.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.5-5 · `audit20240201::3.2.2`

---

## LF-006 · LOW · RouteProcessor4 · fixed

**Recognition signal:** Sentinel value (`0`, `address(0)`, empty bytes) used to switch a function into a privileged or full-balance branch, while upstream callers can produce that value through normal rounding or user input.

**Root cause:** When share rounds down or the user supplies share=0, `amount` becomes 0 in the loop. `swap()` then forwards 0 to `bentoBridge()`, which interprets `amountIn == 0` as a sentinel to operate on the contract's full token balance (deposit excess or withdraw all), causing unintended deposits/withdrawals.

**Fix:** Sushiswap repurposed the `amountIn == 0` sentinel: it now uses `from == INTERNAL_INPUT_SOURCE` to indicate liquidity is already at the pool. Fixed in commit a1d42b5a.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.6-6 · `audit20240201::3.2.3`

---

## LF-007 · LOW · RouteProcessor4 · fixed

**Recognition signal:** After a low-level `call`, wrapping `returnBytes` in `string(abi.encodePacked(...))` instead of bubbling the raw revert data via assembly when `success == false`.

**Root cause:** Failure path encodes `returnBytes` (raw revert data) via `string(abi.encodePacked(returnBytes))` and passes it as the `require` message. The structured ABI-encoded revert from the inner call is therefore lost and replaced by an unreadable string, hampering debugging and on-chain error matching.

**Fix:** Replace `require(success, ...)` with an assembly `revert(add(32, returnBytes), mload(returnBytes))` to bubble up the original revert data. Fixed in commit 4e34380d.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.6-6 · `audit20240201::3.2.4`

---

## LF-022 · LOW · Permit2Proxy · fixed

**Recognition signal:** EIP-712 typehash containing fields the contract no longer reads/enforces — drift between the signed schema and runtime checks erodes the meaning of the signature.

**Root cause:** The LiFiCall witness typehash hashes (tokenReceiver, diamondAddress, diamondCalldataHash) but tokenReceiver is no longer used by the current code path. The typehash therefore commits to a field that has no on-chain effect, creating a mismatch between what users sign and what the contract enforces.

**Fix:** tokenReceiver removed from the witness typehash so it reflects the actually-enforced parameters. Fixed in 6ab55d42168e4d58e2b1ffd24d60d7434a7a9ca6.

**Source:** `2024.11.22_Permit2Proxy.pdf` p.5-5 · `audit20241122::6.2.1`

---

## LF-023 · LOW · Permit2Proxy · fixed

**Recognition signal:** Intermediate proxy that forwards native value to a contract known to refund msg.sender, without implementing receive()/fallback — any refund branch in the callee will revert the whole flow.

**Root cause:** Many facets (AcrossFacet, CBridgeFacet, StargateFacetV2, etc.) refund excess native to msg.sender, which in this flow is Permit2Proxy. Without a receive() function the proxy rejects the refund, causing the underlying bridge call to revert when any leftover ETH is returned.

**Fix:** Added a receive() function and a path to forward refunded native back to the user. Fixed in 976966de7ba14d1782904ebe7bad1b3fd2e79281.

**Source:** `2024.11.22_Permit2Proxy.pdf` p.6-6 · `audit20241122::6.2.2`

---

## LF-024 · LOW · Permit2Proxy · acknowledged

**Recognition signal:** Stateless forwarding proxy that pulls user funds but does not snapshot/return residual balances after the downstream call — dust accumulates and can be taken by the next caller.

**Root cause:** callDiamondWithPermit2Witness/callDiamondWithPermit2/callDiamondWithEIP2612Signature pull tokens from the user and forward arbitrary calldata to the diamond but never sweep leftover token balances. Any dust held in the proxy can be consumed/transferred by a subsequent unrelated user's call.

**Fix:** Acknowledged; no code change applied.

**Source:** `2024.11.22_Permit2Proxy.pdf` p.6-6 · `audit20241122::6.2.3`

---

## LF-035 · LOW · ReceiverAcrossV3 · acknowledged

**Recognition signal:** Receiver/executor wrapper that fixes-input a swap call but never reconciles residual token balance against the incoming amount, relying on admin recovery rather than user refund.

**Root cause:** _swapAndCompleteBridgeTokens does not sweep residual balances after the executor swap completes. If the swap path does not consume the entire received bridged amount, the unused tokens stay in the contract until an admin recovers them via pullToken.

**Fix:** Acknowledged in favor of gas saving; LI.FI documents the behavior rather than sweeping.

**Source:** `2024.12.06_AcrossFacetPackedV3(v1.2.0).pdf` p.5-5 · `audit20241206::6.2.2`

---

## LF-047 · LOW · ReceiverChainflip · acknowledged

**Recognition signal:** Force-sending native ETH to a user-provided receiver in a catch/fallback branch with no further recovery path — a non-payable receiver will permanently revert the refund and lock funds.

**Root cause:** After a destination-swap attempt fails, the catch branch calls receiver.safeTransferETH(amount) unconditionally to the user-supplied receiver. If the receiver is a contract that cannot receive native ETH, the refund reverts and the funds become stuck because there is no further fallback (e.g. leaving funds in the receiver for later recovery).

**Fix:** Acknowledged; LI.FI prefers not to let funds fall back to its own contract. No code change applied.

**Source:** `2025.03.05_ChainflipFacet(v1.0.0).pdf` p.5-6 · `audit20250305::6.2.1`

---

## LF-049 · LOW · LiFiDEXAggregator · acknowledged

**Recognition signal:** Final-balance-delta slippage check on a recipient that can be re-entered or asynchronously credited mid-swap (e.g. via a callback) — recipient-side balance manipulation invalidates the slippage guarantee.

**Root cause:** processRouteInternal only checks the recipient's final balance after all hops complete. With Velodrome V2 callbacks the recipient contract is invoked inside the swap and can artificially raise its own output-token balance, so the final-balance slippage check passes even when the pool delivered less than amountOutMin.

**Fix:** Acknowledged out of scope; documentation/comments added to warn integrators in a507f1e795f9e50b9d02655c3c06f126975f73b6.

**Source:** `2025.04.11_LiFiDEXAggregator(v1.7.0).pdf` p.4-4 · `audit20250411::6.1.1`

---

## LF-050 · LOW · LiFiDEXAggregator · fixed

**Recognition signal:** Boolean flag decoded from a calldata/stream byte using > 0 instead of == 1 — non-canonical inputs can take paths the protocol did not intend to expose.

**Root cause:** swapVelodromeV2 reads the callback flag via stream.readUint8() > 0, treating any value 1..255 as 'callback enabled'. Documentation contracts a strict equality to 1, so route encodings with non-canonical flag bytes can trigger unintended callback paths.

**Fix:** Comparison changed to == 1 to enforce strict canonical encoding. Fixed in 92302f00d184e89f9683208fd48e02a8bf0a4a5f.

**Source:** `2025.04.11_LiFiDEXAggregator(v1.7.0).pdf` p.4-4 · `audit20250411::6.1.2`

---

## LF-058 · LOW · ReceiverStargateV2 · fixed

**Recognition signal:** Try/catch wrapping a user-facing swap/execution that, on failure, silently delivers a different (worse) outcome to the receiver, when the outer call's gas is attacker-controlled.

**Root cause:** LayerZero V2's EndPoint allows anyone to invoke lzCompose with attacker-controlled gas. ReceiverStargateV2._swapAndCompleteBridgeTokens executes the swap inside a try/catch that, on revert, falls back to transferring only the un-swapped tokens to the receiver. An attacker can therefore call lzCompose with just enough gas to pass the recoverGas pre-check but not enough for the swap, deterministically forcing the catch path.

**Fix:** Fixed in commit e3b354db (either restrict lzCompose caller to authorized executors, or remove the gas reservation so OOG bubbles up instead of entering catch).

**Source:** `2025.05.08_Cantina_Comp.pdf` p.4-7 · `audit20250508::3.1.1`

---

## LF-061 · LOW · Permit2Proxy, DeBridgeDlnFacet · fixed

**Recognition signal:** Cross-chain order or escrow that captures msg.sender as the cancel/refund beneficiary when the call originates from a proxy or relayer (so msg.sender is not the end user).

**Root cause:** When constructing a DeBridge OrderCreation through Permit2Proxy, msg.sender at the facet layer is the Permit2Proxy itself (since the proxy delegate-calls the diamond). Hardcoding allowedCancelBeneficiarySrc to msg.sender therefore pins refunds to the proxy address on cancel. DeBridge's cancellation flow enforces this beneficiary, so the user permanently loses the refund.

**Fix:** Fixed in commit 6ba0608f, switching allowedCancelBeneficiarySrc to an empty bytes array per DeBridge documentation (lets the orderAuthorityAddressDst choose the refund recipient at cancel time).

**Source:** `2025.05.08_Cantina_Comp.pdf` p.14-15 · `audit20250508::3.1.4`

---

## LF-062 · LOW · Permit2Proxy · fixed

**Recognition signal:** Try/catch around an external call that uses only `catch Error(string)` or `catch Panic(uint)` (no generic `catch (bytes memory)` / `catch`) when the goal is to swallow ANY revert reason from the callee.

**Root cause:** The frontrun mitigation wraps the ERC20Permit.permit call in `try ... catch Error(string memory)`, which only catches Solidity revert(string). Tokens that revert with custom errors, panics, or empty data fall straight through, so an attacker that frontruns and consumes the permit can still grief callers whose tokens use those revert types.

**Fix:** Fixed in commit 85952e3e by adding a generic `catch (bytes memory) { revert("Unexpected permit failure"); }` to cover all revert shapes.

**Source:** `2025.05.08_Cantina_Comp.pdf` p.15-17 · `audit20250508::3.1.5`

---

## LF-065 · LOW · LiFiDEXAggregator · fixed

**Recognition signal:** try/catch around a router/pool call that treats any revert as a method-missing fallback and silently routes to a different swap path, masking unrelated failures.

**Root cause:** The try/catch around swapSupportingFeeOnInputTokens assumes the only failure mode is the method not existing on the pool, but any revert path (insufficient allowance, slippage triggered, OOG, access control, overflows, invalid parameters) falls through into the standard swap() call. The catch branch silently rerouting to a different swap function can produce semantically incorrect behavior for fee-on-transfer tokens.

**Fix:** Fixed in 6da37c48d1f521395c41148a9b38651858ba9812 by removing the try/catch and letting the call revert naturally.

**Source:** `2025.05.10_LiFiDexAggregator(v1.9.0).pdf` p.4-4 · `audit20250510::6.1.1`

---

## LF-075 · LOW · LiFiDEXAggregator · fixed

**Recognition signal:** Hardcoded numeric bounds in a DEX integration are taken from rounded "reasonable" values rather than the integration's actual valid-range constants, causing the call to drift outside the supported domain.

**Root cause:** The price-boundary parameters passed to Izumi's swapX2Y/swapY2X are set to -80000 and 80000, which sit outside the protocol's documented valid range of -79999 to 79999. Passing out-of-range bounds causes Izumi to behave unpredictably, so swaps may revert or settle at unintended prices.

**Fix:** Fixed in 36c3bbc by passing the correct price-boundary values to the Izumi swap functions.

**Source:** `2025.06.30_LiFiDexAggregator(v1.11.0).pdf` p.6-6 · `audit20250630::6.2.1`

---

## LF-128 · LOW · ReceiverOIF · fixed

**Recognition signal:** Cross-chain receiver decodes a final-destination address from caller-controlled payload and forwards it without a zero-address check, relying on a downstream contract to catch the burn.

**Root cause:** outputFilled ABI-decodes (transactionId, swapData, receiver) from caller-supplied executionData and forwards receiver directly to the Executor without checking that it is non-zero. If the downstream Executor also does not validate, the tokens will be sent to address(0) and effectively burned.

**Fix:** Fixed in 1ecae5a by validating that the decoded receiver is not the zero address in outputFilled.

**Source:** `2025.12.15_ReceiverOIF(v1.0.0).pdf` p.5-5 · `audit20251215::6.1.1`

---

## LF-008 · INFO · RouteProcessor4 · acknowledged

**Recognition signal:** Admin setter (privilege grant, pause toggle, immutable bootstrap) that mutates state controlling fund flow without emitting a corresponding event for off-chain monitoring.

**Root cause:** Constructor and admin setters (`setPriviledge()`, `pause()`, `resume()`) mutate critical state but emit no events. Off-chain monitoring cannot detect privilege grants or pause toggles, weakening incident response and audit trail for an emergency-pause router.

**Fix:** Recommended emitting events on every admin state change. LI.FI acknowledged; argued these functions should never fire outside an emergency.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.12-12 · `audit20240201::3.4.11`

---

## LF-009 · INFO · RouteProcessor4 · acknowledged

**Recognition signal:** Multi-hop swap router that enforces slippage only on the final output amount and uses `0` as `minAmountOut` for intermediate hops in the call to the underlying DEX.

**Root cause:** The router only enforces a final balance check against `amountOutMin` for `tokenOut`. Intermediate swaps (notably `swapCurve` which passes `0` to `pool.exchange(...)`) have no per-leg slippage guard, so MEV/sandwich attacks on intermediate legs are only constrained by the global output check, which may admit large mid-route losses if the route does not strictly chain through the protected output token.

**Fix:** Per-leg minOut would add overhead; LI.FI acknowledged and chose not to fix.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.8-8 · `audit20240201::3.4.2`

---

## LF-010 · INFO · RouteProcessor4 · fixed

**Recognition signal:** Granting a fresh ERC20 allowance on every call without first resetting to 0 when integrating with tokens or external contracts that may not consume the full allowance.

**Root cause:** If a Curve pool's `exchange()` does not consume the full allowance, the router is left with a non-zero allowance for that token/pool pair. Subsequent `swapCurve()` calls will invoke `approve(pool, amountIn)` again, which reverts on tokens like USDT that require approval be reset to 0 first, DoS-ing the path.

**Fix:** If `approve()` reverts, fall back to `approve(..., 0)` then `approve(..., amountIn)`. Fixed in commit bbb90746.

**Source:** `2024.02.01_LiFiDexAggregator(v1.0.0).pdf` p.9-9 · `audit20240201::3.4.4`

---

## LF-036 · INFO · ReceiverAcrossV3 · acknowledged

**Recognition signal:** Cross-protocol message receiver that executes arbitrary swap calldata while relying solely on an external contract's reentrancy lock rather than its own.

**Root cause:** handleV3AcrossMessage runs an arbitrary swap via the Executor without its own reentrancy guard, relying on Across SpokePool's external nonReentrant. If the upstream guard is ever removed or bypassed, or if a future code path is reached without going through SpokePool, defence-in-depth is absent.

**Fix:** Acknowledged; LI.FI did not add a local reentrancy guard.

**Source:** `2024.12.06_AcrossFacetPackedV3(v1.2.0).pdf` p.5-6 · `audit20241206::6.3.1`

---

## LF-051 · INFO · LiFiDEXAggregator · mitigated

**Recognition signal:** Router/aggregator that forwards calls to a user-specified pool address triggering a recipient hook — recipients that trust msg.sender as a 'valid pool' without explicit allowlist can be tricked into running attacker-controlled inputs.

**Root cause:** The pool address is taken from a user-controlled stream and the Velodrome V2 hook on the recipient does not validate that the caller is a legitimate pool. An attacker can supply a malicious 'pool' so the recipient's hook is invoked from the aggregator with attacker-chosen data, with impact depending on the recipient's hook logic.

**Fix:** Documentation added warning integrators not to trust hook callers without validating the pool. Fixed in 778d22b1bbf1133bc2d583cb9a1d38b1fcf50ee4.

**Source:** `2025.04.11_LiFiDEXAggregator(v1.7.0).pdf` p.5-5 · `audit20250411::6.3.1`

---

## LF-052 · INFO · LiFiDEXAggregator · fixed

**Recognition signal:** Stream/calldata-decoded addresses (pool, recipient) used directly in transfers/calls with no zero-address guard — malformed inputs silently send funds to or call address(0).

**Root cause:** swapVelodromeV2 reads the pool and to addresses from the input stream and uses them without zero-address checks. A malformed route encoding can cause a swap to address(0), losing tokens, or an interaction with address(0) as the pool.

**Fix:** Added explicit zero-address reverts for pool and to. Fixed in 97781cd4f0c7fd7286401fc22f69f0c2fe22317f.

**Source:** `2025.04.11_LiFiDEXAggregator(v1.7.0).pdf` p.6-6 · `audit20250411::6.3.5`

---

## LF-066 · INFO · LiFiDEXAggregator · fixed

**Recognition signal:** Boolean control flag decoded from a byte stream as `> 0` rather than equality with the documented sentinel value, letting any non-zero byte select the alternate code path.

**Root cause:** The flag is decoded as stream.readUint8() > 0, so any value from 1-255 enters the supportsFeeOnTransfer branch even though the documentation specifies only 1. A caller (or a buggy off-chain encoder) that emits a sentinel byte other than 1 will silently take a different swap path than intended.

**Fix:** Fixed in 401b4a62bbdfd77d63c4e102952b0aadbad10d74 by switching to strict equality with a FEE_ON_TRANSFER_FLAG constant.

**Source:** `2025.05.10_LiFiDexAggregator(v1.9.0).pdf` p.4-4 · `audit20250510::6.2.1`

---

## LF-067 · INFO · LiFiDEXAggregator · fixed

**Recognition signal:** Stream-decoded address parameters (pool, recipient) used directly in external calls without the zero-address and sentinel-address checks that adjacent functions enforce.

**Root cause:** Pool and recipient addresses are read directly from the stream and passed to the swap call with no checks against address(0) or the IMPOSSIBLE_POOL_ADDRESS sentinel, unlike other swap functions in the same contract. A malformed stream can send funds to address(0) or trigger an interaction with the sentinel pool.

**Fix:** Fixed in a18db220dc3fcb3484962d7552600286184c5800 by validating pool, recipient, and the sentinel before issuing the swap call.

**Source:** `2025.05.10_LiFiDexAggregator(v1.9.0).pdf` p.5-5 · `audit20250510::6.2.3`

---

## LF-076 · INFO · LiFiDEXAggregator · fixed

**Recognition signal:** An enum-like uint8 read from user-controlled calldata is forwarded to an external protocol without a bounds check against the documented set of valid mode values.

**Root cause:** withdrawMode is a uint8 read from the encoded stream and forwarded directly to SyncSwap, which only defines modes 0–2. No bounds check exists, so a caller can supply 3–255 and reach downstream code paths whose behavior is undefined for this integration.

**Fix:** Fixed in ec277e6 by reverting with InvalidCallData when withdrawMode > 2.

**Source:** `2025.06.30_LiFiDexAggregator(v1.11.0).pdf` p.6-7 · `audit20250630::6.4.1`

---

## LF-077 · INFO · LiFiDEXAggregator · fixed

**Recognition signal:** Two sibling branches in the same function diverge in how they handle a sentinel/special-case input — one validates explicitly, the other only documents the case in a comment.

**Root cause:** For SyncSwap V1 pools the code explicitly reverts on INTERNAL_INPUT_SOURCE, but the V2 branch only documents this case in a comment and silently falls through without a revert. The asymmetry leaves the V2 path open to unexpected source-routing values that aren't validated.

**Fix:** Fixed in ad4b814 by adding the explicit revert for the V2 branch matching the V1 behavior.

**Source:** `2025.06.30_LiFiDexAggregator(v1.11.0).pdf` p.7-7 · `audit20250630::6.4.2`

---

## LF-078 · INFO · LiFiDEXAggregator · fixed

**Recognition signal:** Newly added DEX handler accepts critical addresses from packed calldata and forwards them to external calls without the zero-address/sentinel validations that exist in every neighboring handler.

**Root cause:** swapIzumiV3 decodes pool, direction, and recipient from the raw stream and forwards them straight into the Izumi pool call. There is no check that pool is non-zero or not the IMPOSSIBLE_POOL_ADDRESS sentinel, and no check that recipient is non-zero, in contrast with sibling DEX handlers that validate these.

**Fix:** Fixed in 36c3bbc by validating pool, the IMPOSSIBLE_POOL_ADDRESS sentinel, and recipient before forwarding the call.

**Source:** `2025.06.30_LiFiDexAggregator(v1.11.0).pdf` p.7-8 · `audit20250630::6.4.4`

---

## LF-084 · INFO · Patcher · fixed

**Recognition signal:** Granting unbounded ERC20 approvals to caller-supplied external targets without resetting allowance after the external call.

**Root cause:** Patcher grants unlimited (type(uint256).max) ERC20 approvals to user-supplied execution targets and does not reset them after the call. Compromised or buggy target contracts can drain the residual allowance if any tokens are later held by Patcher.

**Fix:** Fixed in 699218d7 by adjusting approval flow and documenting the behaviour.

**Source:** `2025.07.30_Patcher(v1.0.0).pdf` p.5-5 · `audit20250730::6.4.1`

---

## LF-085 · INFO · Patcher · fixed

**Recognition signal:** Privileged or user-callable functions that execute arbitrary external calls without emitting an event capturing target, calldata, or amounts.

**Root cause:** All four functions that patch and execute external calldata complete without emitting any event, leaving indexers and monitoring with no on-chain trace of what was executed against which target.

**Fix:** Fixed in 68f8b1c0 by adding events to the four execution functions.

**Source:** `2025.07.30_Patcher(v1.0.0).pdf` p.6-6 · `audit20250730::6.4.3`

---

## LF-086 · INFO · Patcher · fixed

**Recognition signal:** An entrypoint that takes a 'requested amount' parameter but actually pulls the caller's full pre-approved allowance, with the discrepancy undocumented.

**Root cause:** _depositAndApprove (used by depositAndExecuteWithMultiplePatches / depositAndExecuteWithDynamicPatches) transferFroms the caller's entire approved balance, ignoring the amount field in the calldata. Integrators expecting amount-bounded transfers can lose funds.

**Fix:** Fixed in f25baadc by documenting the behaviour explicitly.

**Source:** `2025.07.30_Patcher(v1.0.0).pdf` p.6-6 · `audit20250730::6.4.4`

---

## LF-087 · INFO · Patcher · fixed

**Recognition signal:** A pass-through periphery that pulls native or tokens for downstream calls but does not refund unspent amounts back to the caller, leaving dust in a contract reachable by anyone.

**Root cause:** If the dynamic patched value is less than deposited tokens, the target does not spend the full approval, or msg.value exceeds the value parameter, excess assets stay in Patcher and can be swept by anyone since execution targets are unconstrained.

**Fix:** Fixed in f25baadc by documenting that any excess is locked / stealable and recommending msg.value == value as a sanity check.

**Source:** `2025.07.30_Patcher(v1.0.0).pdf` p.6-6 · `audit20250730::6.4.5`

---

## LF-095 · INFO · ReceiverAcrossV4 · acknowledged

**Recognition signal:** A fallback/error-path token transfer to an address taken directly from cross-chain payload without validating it is non-zero.

**Root cause:** When a destination swap fails, tokens are forwarded to the receiver decoded from the Across message without checking receiver != address(0). A malformed or buggy upstream message can route funds to 0x0 irrecoverably.

**Fix:** Acknowledged: LI.FI relies on backend-produced data correctness; no on-chain check added.

**Source:** `2025.09.01_AcrossV4(v1.0.0).pdf` p.5-7 · `audit20250901::6.2.4`

---

## LF-129 · INFO · ReceiverOIF · acknowledged

**Recognition signal:** Cross-chain receiver executes user-supplied swap calldata without any contract-level minOut check, delegating slippage protection entirely to the encoded calldata's target.

**Root cause:** outputFilled does not enforce any minimum output amount or aggregate slippage threshold around the inner swap. The only protection is whatever the SwapData calldata itself encodes, which depends entirely on the swap target. If the user's encoded calldata lacks slippage protection, the swap can settle at extreme adverse prices without reverting.

**Fix:** Documentation added in c6ead50 noting that slippage protection must be embedded in the SwapData by the caller.

**Source:** `2025.12.15_ReceiverOIF(v1.0.0).pdf` p.5-5 · `audit20251215::6.2.1`

---

## LF-130 · INFO · ReceiverOIF · acknowledged

**Recognition signal:** Helper contract that approves a trusted-but-upgradable downstream contract before each call does not zero the allowance afterwards, leaving accumulating standing approvals from non-zero-allowance approval flows.

**Root cause:** _swapAndCompleteBridgeTokens grants ERC20 approval to the Executor before the swap call but never resets the allowance to zero afterwards. Any residual allowance compounds across invocations and would be usable by a future-compromised or buggy Executor.

**Fix:** Acknowledged; team argues ReceiverOIF cannot meaningfully hold tokens because anyone can craft a withdrawal call, so a residual Executor approval is treated as insignificant.

**Source:** `2025.12.15_ReceiverOIF(v1.0.0).pdf` p.6-6 · `audit20251215::6.2.2`
