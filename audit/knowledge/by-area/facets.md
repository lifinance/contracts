# Facets — past findings

## LF-046 · HIGH · ChainflipFacet · fixed

**Recognition signal:** Receiver address for a non-EVM destination chain stored or passed as fixed-size bytes32/address20 instead of variable-length bytes — silent truncation risks loss of funds or DoS on the destination chain.

**Root cause:** ChainflipData.nonEVMReceiver is declared as bytes32 but Chainflip expects the bitcoin destination address as variable-length bytes (the SDK encodes 'tb1q…' as a >32-byte string). Forcing the address into a fixed 32-byte slot silently truncates it, so funds bridged to Bitcoin would be sent to a malformed address.

**Fix:** Receiver parameter changed from bytes32 to bytes so the full non-EVM address can be passed through without truncation. Fixed in d623247e1dd21cc96111b47edabd04be09a1747d.

**Source:** `2025.03.05_ChainflipFacet(v1.0.0).pdf` p.5-5 · `audit20250305::6.1.1`

---

## LF-135 · HIGH · AcrossV4SwapFacet · fixed

**Recognition signal:** A hard-coded chainId -> external-protocol-id table inside a facet without a corresponding exhaustive on-chain test, especially for less-popular chains or near-duplicate deployments.

**Root cause:** Hard-coded chainId->LZ eid mappings used XDC eid 30136 (wrong; correct 30365) and Plume eid 30318 belonging to legacy Plume chainId 98865 rather than 98866 (correct 30370). The bad mapping mixes two distinct Plume deployments and would cause the OFT sponsored path's destination-chain validation either to reject valid quotes or accept ones targeting the wrong chain.

**Fix:** Fixed in 8f46a81 by correcting both eids to 30365 (XDC) and 30370 (Plume).

**Source:** `2026.04.09_AcrossV4SwapFacet(v1.0.0).pdf` p.4-4 · `audit20260409::6.1.1`

---

## LF-015 · MEDIUM · AcrossFacetV3 · acknowledged

**Recognition signal:** Two parallel receiver / destination fields where the standard zero-address validation only covers the outer struct and is skipped (via a feature-flag branch) for the inner / bridge-specific field that is the actual on-chain recipient.

**Root cause:** validateBridgeData enforces non-zero _bridgeData.receiver, but the bridge actually forwards _acrossData.receiverAddress. The cross-check `_bridgeData.receiver != _acrossData.receiverAddress` only runs when hasDestinationCall is false, so with destination calls enabled the across-side receiverAddress is never compared and can legitimately be zero, allowing a bridge to address(0) and a misleading event that still reports _bridgeData.receiver.

**Fix:** Acknowledged but not patched; LI.FI considers guardrails sufficient and treats deliberate zero-address inputs as user error.

**Source:** `2024.10.07_AcrossV3.pdf` p.4-4 · `audit20241007::6.1.1`

---

## LF-029 · MEDIUM · DeBridgeDlnFacet · fixed

**Recognition signal:** Facet validating an ILiFi.BridgeData field (e.g. receiver) via the shared modifier while actually consuming a parallel bridge-specific struct field for the same role, leaving the latter unchecked.

**Root cause:** The validateBridgeData modifier checks _bridgeData.receiver != address(0), but the actual receiver passed to deBridge's createOrder comes from a separate _deBridgeData.receiver field. There is no sanity validation of _deBridgeData.receiver, so funds can be sent to address(0), where the resulting order also cannot be cancelled.

**Fix:** Added validation for the _deBridgeData receiver/payload alongside the existing _bridgeData checks. Fixed in f561360dde2629e4ff624a87784bc01989b38bc6.

**Source:** `2024.12.05_DeBridgeDlnFacet(v1.0.0).pdf` p.4-4 · `audit20241205::6.1.1`

---

## LF-030 · MEDIUM · DeBridgeDlnFacet · fixed

**Recognition signal:** Bridge integration reusing the destination receiver address as the destination-chain order/cancellation authority, without considering that the receiver may be a contract incapable of making the required cancel call.

**Root cause:** The facet sets orderAuthorityAddressDst = _deBridgeData.receiver. When the receiver is a smart contract that cannot make the destination-chain sendEvmOrderCancel call, no party can cancel an unfillable order, so funds get stuck until market conditions change (which may never happen).

**Fix:** Added a separate orderAuthorityDst field to DeBridgeDlnData so callers can pick an EOA cancellation authority independent of the receiver. Fixed in 8bcb3927ebab0780cb54ba6306f7ecca2a09ff55.

**Source:** `2024.12.05_DeBridgeDlnFacet(v1.0.0).pdf` p.4-5 · `audit20241205::6.1.2`

---

## LF-033 · MEDIUM · AcrossFacetPackedV3 · fixed

**Recognition signal:** Bridge facet hard-coding msg.sender into a destination-protocol role that later requires off-chain signing (ECDSA / EIP-712), without parameterizing that role for contract callers.

**Root cause:** startBridgeTokensViaAcrossV3NativeMin / ERC20Min pass msg.sender as the depositor to spokePool.depositV3. Across's speedUpV3Deposit requires the depositor to ECDSA-sign a message, which a smart-contract msg.sender cannot do, leaving such deposits stuck without the speed-up escape hatch and giving inconsistent behavior across functions in the same facet.

**Fix:** Added an explicit depositor parameter so non-EOA users can specify an EOA capable of signing speed-up messages. Fixed in 9a8ff404186a7df19d9dd5610a94b977bbfc233d.

**Source:** `2024.12.06_AcrossFacetPackedV3(v1.2.0).pdf` p.4-4 · `audit20241206::6.1.1`

---

## LF-088 · MEDIUM · MayanFacet · fixed

**Recognition signal:** Receiver-extraction logic mapped per external selector that picks a positionally-convenient address parameter (e.g. trader/sender) as the receiver instead of decoding the destination from the protocol-specific payload struct.

**Root cause:** When MayanFacet added support for Hypercore routes, the receiver decoder for the new deposit(0xe27dce37) and fastDeposit(0x4d1ed73b) selectors treats the third parameter (trader) as the destination receiver. The real receiver is inside the encoded depositPayload struct, so the receiver assertion will fail (or silently mismatch) when the user's sender differs from their destination wallet, causing permanent DoS for those flows.

**Fix:** Updated the decoder to extract the receiver address from depositPayload for both new selectors. Fixed in commits 2e9eeda, 74a57f9, b1f7ea4.

**Source:** `2025.08.25_MayanFacet(v1.2.2).pdf` p.4-4 · `audit20250825::6.1.1`

---

## LF-098 · MEDIUM · GardenFacet · fixed

**Recognition signal:** Reusing the destination-chain receiver as the source-chain refund/initiator/owner in a cross-chain HTLC or escrow — same-address-different-chain control mismatches can let an unrelated party claim funds.

**Root cause:** GardenFacet passes _bridgeData.receiver as the initiator parameter to Garden's HTLC initiateOnBehalf, which grants refund rights on the source chain after timelock expiry. The same address can be controlled by different parties on different chains (Safe with different owners, predictable CREATE deployments not yet deployed on source), so when a solver fails to redeem, whoever controls that address on the source chain can claim the refund.

**Fix:** GardenData extended with an explicit refundAddress field used as initiator, decoupling source-chain refund rights from the destination-chain receiver. Fixed in 7431c2d25d1106cc03542a9a29248c57f2e0f457.

**Source:** `2025.09.19_GardenFacet(v1.0.0).pdf` p.5-8 · `audit20250919::M-1`

---

## LF-111 · MEDIUM · EcoFacet · fixed

**Recognition signal:** Bridge facet integrating with an external protocol whose funding/deposit entrypoint silently no-ops on a duplicate-state input rather than reverting, combined with a downstream sweep/leftover-refund mechanism that distributes the contract's full balance to the current caller.

**Root cause:** Eco Protocol's Portal silently no-ops a second publishAndFund call for an already-funded intent (the onlyFundable modifier returns early without reverting), so a duplicate call to startBridgeTokensViaEco still pulls tokens from the user but never deposits them, leaving them in the diamond. SwapperV2's _refundLeftovers then sweeps the entire input-token balance to the next caller of swapAndStartBridge*, enabling theft of the trapped funds.

**Fix:** Added IEcoPortal.getRewardStatus() query and a precomputed intent hash check inside _startBridge that reverts with IntentAlreadyFunded() if the intent is not in Initial status. Fixed in PR lifinance/contracts/pull/1421.

**Source:** `2025.10.20_EcoFacet(v1.1.0).pdf` p.5-12 · `audit20251020::M-1`

---

## LF-112 · MEDIUM · EcoFacet · fixed

**Recognition signal:** Bridge facet binding a downstream refund/cancellation beneficiary to msg.sender on the assumption the caller is the end user, ignoring legitimate intermediaries such as Permit2 proxies, batch routers, or integrator contracts.

**Root cause:** EcoFacet hard-codes reward.creator to msg.sender when constructing the intent. When the caller is a relayer/proxy (Permit2Proxy) or an integrator contract rather than the end-user EOA, refunds for unfilled intents are delivered to that intermediate contract, where the actual user has no control over them.

**Fix:** Added an explicit refundRecipient / intentCreator parameter to EcoData so the user can choose the address that receives refunds on intent expiry. Fixed in PR lifinance/contracts/pull/1421.

**Source:** `2025.10.20_EcoFacet(v1.1.0).pdf` p.12-13 · `audit20251020::M-2`

---

## LF-136 · MEDIUM · AcrossV4SwapFacet · fixed

**Recognition signal:** Patching individual numeric fields of a routing struct on positive slippage while leaving an opaque bytes routerCalldata blob (generated for the pre-slippage amount) unmodified.

**Root cause:** On positive slippage, _callSpokePoolPeripherySwapAndBridge scales outputAmount, minExpectedInputTokenAmount and swapTokenAmount, but forwards routerCalldata unchanged. The opaque router calldata was produced by the backend for the original (smaller) amount, so the periphery executes a swap whose parameters disagree with the upper-layer struct.

**Fix:** Fixed in e6c6c82: switched to the sponsored-path strategy of bridging only the originally quoted amount and refunding the surplus to the user.

**Source:** `2026.04.09_AcrossV4SwapFacet(v1.0.0).pdf` p.4-4 · `audit20260409::6.2.1`

---

## LF-137 · MEDIUM · AcrossV4SwapFacet · acknowledged

**Recognition signal:** Scaling an external quote's output amount linearly with input size when the underlying fee/liquidity curve is not actually linear.

**Root cause:** SpokePool and SpokePoolPeriphery paths scale outputAmount linearly from the original quote ratio when positive slippage occurs. Across relayer fees and liquidity depth are not perfectly linear in input size, so the scaled outputAmount can exceed what any relayer is willing to fill, stranding funds until fillDeadline expires.

**Fix:** Acknowledged: Across team confirmed proportional adjustment is their recommended approach; treated as approximately linear at these sizes. No change.

**Source:** `2026.04.09_AcrossV4SwapFacet(v1.0.0).pdf` p.5-5 · `audit20260409::6.2.2`

---

## LF-011 · LOW · CalldataVerificationFacet · fixed

**Recognition signal:** Off-by-one length validation that uses strict-less-than (or strict-greater-than) where the minimum-valid case actually requires at least one byte beyond the fixed header, letting empty / zero-length variable-length tail fields slip through.

**Root cause:** The function's sanity check (callData.length < 484) treats exactly 484 bytes as valid, but a 484-byte calldata corresponds to an empty inner callData inside SwapData. Decoders relying on this validation can therefore proceed with structurally invalid input and return zeroed or attacker-shaped parameters.

**Fix:** Fixed in commit a4c2574f2f143dd732de02eeecb79db6c4864806 by changing the comparison to <= 484. Reviewer verified.

**Source:** `2024.09.02_CalldataVerificationFacet.pdf` p.4-4 · `audit20240902::6.1.1`

---

## LF-012 · LOW · EmergencyPauseFacet · fixed

**Recognition signal:** Admin recovery function takes a user-supplied list of components to exclude from re-activation without protecting the bootstrap/upgrade component itself, allowing a single misconfigured call to permanently disable upgrades.

**Root cause:** The unpauseDiamond function accepts an arbitrary blacklist of facets to skip when re-adding selectors, but does not exclude the DiamondCutFacet from this blacklist. Because DiamondCutFacet is the only path to add/remove facets, blacklisting it bricks all future upgrades — including re-adding any facet — and there is no safeguard or warning at the function boundary.

**Fix:** Fixed in 7709442ae76b0209a93c732c412fcb444216c618 by skipping DiamondCutFacet selectors during the unpause loop.

**Source:** `2024.09.13_EmergencyPauseFacet.pdf` p.5-5 · `audit20240913::6.1.1`

---

## LF-013 · LOW · EmergencyPauseFacet · fixed

**Recognition signal:** Lower-privilege role can invoke a destructive maintenance action against the very contract that contains the higher-privilege recovery action, with no self-protection of that recovery surface.

**Root cause:** The pauserWallet can both pause the diamond (removing all facet selectors) and call removeFacet on the EmergencyPauseFacet, leaving no facet that can re-add selectors via the diamond's normal flows. Privilege boundaries between the lower-trust pauserWallet and the diamond owner are not enforced on functions that can destroy the recovery path.

**Fix:** Fixed in d70d09b47dca3f36068311659510cc1764019f7a by restricting destructive operations on the EmergencyPauseFacet itself to the diamond owner.

**Source:** `2024.09.13_EmergencyPauseFacet.pdf` p.5-5 · `audit20240913::6.1.2`

---

## LF-014 · LOW · EmergencyPauseFacet · acknowledged

**Recognition signal:** Critical emergency action enumerates an unbounded protocol-state collection in a single transaction with no batching/pagination, becoming inoperable exactly when the protocol is most complex.

**Root cause:** pauseDiamond enumerates every facet's selectors in a single transaction via _getAllFacetFunctionSelectorsToBeRemoved with no pagination or batching. As the diamond accumulates facets, the unbounded loop exceeds the block gas limit, making the emergency pause unusable precisely when the diamond is largest.

**Fix:** Acknowledged; team relies on adding a new EmergencyPauseFacet and a watcher on the deploy pipeline rather than implementing pagination.

**Source:** `2024.09.13_EmergencyPauseFacet.pdf` p.5-6 · `audit20240913::6.1.3`

---

## LF-016 · LOW · AcrossFacetPackedV3 · fixed

**Recognition signal:** Function marked payable purely as a gas micro-optimization that has no native-token consumption path, leaving msg.value stuck in the contract where it can be swept or collide with other native-token flows.

**Root cause:** startBridgeTokensViaAcrossV3ERC20Min and startBridgeTokensViaAcrossV3ERC20Packed are declared payable for a small gas saving, but the ERC20 bridge path never consumes msg.value. Any native tokens accidentally sent along with the call are retained by the facet and become consumable by other facets that lack native-token accounting.

**Fix:** Fixed in commit ddc45f13a2007025fb62f8983d417b9a1ed233d4 by removing the payable keyword from the ERC20 entrypoints. Reviewer verified.

**Source:** `2024.10.07_AcrossV3.pdf` p.4-4 · `audit20241007::6.2.1`

---

## LF-017 · LOW · AcrossFacetPackedV3 · fixed

**Recognition signal:** Calldata encoder helper that emits an incomplete payload assuming the caller will concatenate additional trailing bytes off-chain, with no length self-check on the on-chain consumer to detect the missing tail.

**Root cause:** encode_startBridgeTokensViaAcrossV3*Packed produces calldata without the 28-byte referrer suffix that the on-chain facet expects to consume; the caller is expected to append it off-chain. If a user feeds the encoder output directly to the facet, msg.data length is short and the referrer bytes are silently truncated from the bridge call.

**Fix:** Referrer handling was removed from the packed flow entirely in commit f8cb0d8c4bfdba35686e63849095f63c516c5784, eliminating the latent footgun. Reviewer verified.

**Source:** `2024.10.07_AcrossV3.pdf` p.4-5 · `audit20241007::6.2.2`

---

## LF-018 · LOW · AcrossFacetPackedV3 · acknowledged

**Recognition signal:** Down-casting a wider identifier (bytes32 / uint256 / etc.) to a narrower type for packed encoding without surfacing the truncation back into the event / log used by off-chain indexers.

**Root cause:** encode_startBridgeTokensViaAcrossV3NativePacked and encode_startBridgeTokensViaAcrossV3ERC20Packed cast the incoming bytes32 transactionId down to bytes8 to fit the packed calldata layout. The LiFiAcrossTransfer event subsequently emits this truncated id, breaking off-chain transaction tracking and correlation across chains.

**Fix:** Acknowledged and accepted as a known gas trade-off; not patched.

**Source:** `2024.10.07_AcrossV3.pdf` p.5-5 · `audit20241007::6.2.3`

---

## LF-019 · LOW · EmergencyPauseFacet · acknowledged

**Recognition signal:** Admin loop that indexes the result of a registry lookup (e.g. facetFunctionSelectors) without first checking the returned array's length, turning a typo in admin input into an opaque panic that aborts the whole operation.

**Root cause:** The blacklist loop fetches facetFunctionSelectors(_blacklist[i]) and immediately indexes into it; if the address is not a registered facet, the returned array is empty and accessing the first element triggers an out-of-bounds panic. There is no guard or explicit error, so a typo in an admin-supplied address aborts the entire unpause with an opaque revert reason.

**Fix:** Not fixed. Acknowledged as an admin-only function where the operator is expected to craft inputs correctly.

**Source:** `2024.11.05_EmergencyPauseFacet_ReAudit.pdf` p.4-4 · `audit20241105::6.1.1`

---

## LF-025 · LOW · RelayFacet · acknowledged

**Recognition signal:** Bridging facet entrypoint that accepts pre-swap data and passes the result directly to a bridge call without asserting that the last swap's receiving asset matches the declared bridging asset.

**Root cause:** After swapping, the function does not check that the final receiving asset (`_swapData[last].receivingAssetId`) equals `_bridgeData.sendingAssetId`. A mismatched swap output passes the entry-level checks and only reverts deeper in the stack with no actionable error.

**Fix:** Acknowledged but not fixed - LI.FI optimizes for gas, and the mismatch causes a revert downstream anyway (though without a clear error message).

**Source:** `2024.12.02_RelayFacet(v1.0.0).pdf` p.4-4 · `audit20241202::6.1.1`

---

## LF-026 · LOW · RelayFacet · acknowledged

**Recognition signal:** Bridge integration where the source-chain refund recipient defaults to the contract address itself because the caller-supplied refund parameters are not set, even though the user has an EOA that should receive the refund.

**Root cause:** When the Relay bridge refunds on the source chain (expired/invalid quote, mismatched depositor, destination unavailable, etc.), the refund recipient defaults to the diamond address. Refunded funds are not automatically forwarded to the original user, leaving them effectively stranded unless reclaimed via admin action.

**Fix:** Acknowledged. Not fixable on smart contract side; must be addressed at the API layer by setting `refundTo` and `refundOnOrigin` parameters in the relay quote.

**Source:** `2024.12.02_RelayFacet(v1.0.0).pdf` p.4-4 · `audit20241202::6.1.3`

---

## LF-027 · LOW · RelayFacet · fixed

**Recognition signal:** Two parallel receiver fields (EVM vs non-EVM) where the modifier validates only the EVM one, while non-EVM destinations route through the unvalidated alternate field.

**Root cause:** `validateBridgeData` enforces `_bridgeData.receiver != address(0)`, but when bridging to non-EVM chains the actual receiver is carried in `_relayData.nonEVMReceiver`, which is never checked for emptiness. The EVM-side check is thus a no-op while the actually-used field is unvalidated.

**Fix:** Add explicit non-empty check on `_relayData.nonEVMReceiver` for non-EVM destinations. Fixed in commit f285130f.

**Source:** `2024.12.02_RelayFacet(v1.0.0).pdf` p.5-5 · `audit20241202::6.1.4`

---

## LF-031 · LOW · DeBridgeDlnFacet · fixed

**Recognition signal:** Bridge order construction leaving an optional refund-recipient field empty, deferring the choice to a downstream actor instead of pinning the refund to the on-chain initiator.

**Root cause:** When allowedCancelBeneficiarySrc is empty, the orderAuthorityAddressDst can choose any refund address on the source chain at cancel time, making refund accuracy dependent on a correctly behaving order authority instead of being pinned to the actual bridge initiator.

**Fix:** Set allowedCancelBeneficiarySrc = msg.sender when building the OrderCreation in _startBridge so refunds always go back to the initiator. Fixed in 92d87722236f0d58992b7baac378b42501087f8c.

**Source:** `2024.12.05_DeBridgeDlnFacet(v1.0.0).pdf` p.5-6 · `audit20241205::6.2.1`

---

## LF-032 · LOW · DeBridgeDlnFacet · acknowledged

**Recognition signal:** Init function that writes an initialized flag in storage but does not require !initialized as a precondition, leaving the bulk-config path callable repeatedly by admin.

**Root cause:** initDeBridgeDln is owner-protected but never checks the storage's initialized flag before writing. The flag is set to true after init but no subsequent invocation reverts, so the same admin function can be used to wholesale rewrite the chain-id mapping bypassing the regular per-entry setter path.

**Fix:** LI.FI acknowledged and kept the behavior to allow future re-initialization upgrades; recommended check (revert AlreadyInitialized when sm.initialized) was not applied.

**Source:** `2024.12.05_DeBridgeDlnFacet(v1.0.0).pdf` p.6-7 · `audit20241205::6.2.3`

---

## LF-034 · LOW · AcrossFacetPackedV3 · acknowledged

**Recognition signal:** Gas-optimized packed entrypoints that omit sanity checks on user-provided fields because calldata is 'assumed to be backend-generated', without on-chain enforcement that the caller is the backend.

**Root cause:** All four packed/min entrypoints skip basic sanity checks (receiver != 0, sendingAssetId != 0, inputAmount > 0, sane fillDeadline/quoteTimestamp, valid chain id). The functions trust calldata produced by the LI.FI API; if a user composes calldata directly with errors, funds can be sent to a wrong address or bridged with invalid parameters.

**Fix:** Acknowledged. LI.FI states the facet is only meant to be used with calldata generated by their API and declined to add gas-costly validation; recommended users rely on provided encode helpers.

**Source:** `2024.12.06_AcrossFacetPackedV3(v1.2.0).pdf` p.4-5 · `audit20241206::6.2.1`

---

## LF-042 · LOW · GlacisFacet · fixed

**Recognition signal:** Bridge facet that forwards a user-supplied refund/recovery address to an external protocol without validating it is non-zero, where the external protocol treats that address as the authoritative refund destination.

**Root cause:** Both bridge entrypoints accept GlacisData.refundAddress as user input but never validate it. The Glacis airlift uses this address to refund failed bridge attempts. A zero address (e.g., from a frontend bug or careless caller) silently passes through and refunds are permanently lost.

**Fix:** Fixed in commit f5cdbc279f0f15ed469650d5b9b4185c0c668547 by adding a zero-address revert before invoking airlift.send.

**Source:** `2025.02.19_GlacisFacet(v1.0.0).pdf` p.5-5 · `audit20250219::6.1.1`

---

## LF-048 · LOW · ChainflipFacet · acknowledged

**Recognition signal:** Encoding EVM-shaped payloads (Solidity structs, address-typed receiver) into cross-chain messages without branching on EVM vs non-EVM destination — assumptions about destination ABI silently break when the route is non-EVM.

**Root cause:** When hasDestinationCall is true the facet abi.encodes (transactionId, dstCallSwapData, bridgeData.receiver) where SwapData is EVM-native and receiver is an address. For non-EVM destination chains the encoded message and the receiver field are not interpretable on the destination, so destination calls toward Bitcoin/Solana would silently fail or be malformed.

**Fix:** Acknowledged. LI.FI states the API does not route destination calls to non-EVM chains, but no on-chain guard was added; users bypassing the API remain exposed.

**Source:** `2025.03.05_ChainflipFacet(v1.0.0).pdf` p.5-6 · `audit20250305::6.2.2`

---

## LF-059 · LOW · DexManagerFacet · fixed

**Recognition signal:** for-loop with manual unchecked counter increment that lives only in the happy path, alongside an early-continue (or branch) that does not advance the counter.

**Root cause:** The loop body uses a manually-unchecked-incremented counter, but the early-continue branch for already-allowed dexes skips the increment. Any duplicate or pre-existing-allowed entry pins the loop on the same index until the transaction runs out of gas.

**Fix:** Fixed in commit 47e4d8d7 by incrementing i inside the continue branch as well.

**Source:** `2025.05.08_Cantina_Comp.pdf` p.7-8 · `audit20250508::3.1.2`

---

## LF-060 · LOW · GasZipFacet · fixed

**Recognition signal:** Address-to-bytes32 conversion via the uint256 intermediate (zero-pads on the left) where the downstream integration or non-EVM target expects right-padded bytes32, especially when invariant checks lock both sides to the same wrong encoding.

**Root cause:** GasZipV2 requires bytes32 receivers to be right-padded (e.g. via bytes32(bytes20(uint160(addr)))). The facet's invariant check uses bytes32(uint256(uint160(addr))), which left-pads. Correctly-formatted requests always revert with InvalidCallData, and users who match the buggy encoding by left-padding their input pass the check but bridge funds to address(0) on the destination chain. The bug is camouflaged because the facet's tests use the same incorrect encoding.

**Fix:** Fixed in commit 30caee47 by switching the conversion to bytes32(bytes20(uint160(_bridgeData.receiver))) and updating tests.

**Source:** `2025.05.08_Cantina_Comp.pdf` p.8-14 · `audit20250508::3.1.3`

---

## LF-063 · LOW · CelerIMFacetBase, RelayerCelerIM · fixed

**Recognition signal:** Cross-chain code that hardcodes or auto-derives a contract address (e.g. address(this), address(relayer), CREATE-deployed clone) and assumes byte-identical addresses across chains, without handling chains with non-standard address derivation (zkSync Era, Starknet, etc.).

**Root cause:** The facet sets _bridgeData.receiver = address(relayer) (the source-chain relayer it just deployed). It implicitly assumes the same address is used on every chain. zkSync derives contract addresses via a different CREATE scheme, so the source-chain relayer address has no code on zkSync (and vice-versa). Celer's executeTransfer then has no destination contract to call and refunds are also impossible.

**Fix:** Fixed in commit b4ffcb7b by removing CelerIMFacet and RelayerCelerIM from zkSync entirely.

**Source:** `2025.05.08_Cantina_Comp.pdf` p.17-19 · `audit20250508::3.1.6`

---

## LF-064 · LOW · HopFacet, HopFacetOptimized · fixed

**Recognition signal:** Bridge/integration facet that forwards msg.value = amount + extraFee to a downstream contract that strictly requires msg.value == amount (or ignores msg.value for ERC20), so the extra fee is either rejected or silently consumed.

**Root cause:** Hop's L1_Bridge enforces msg.value == amount for native transfers and ignores msg.value for ERC20 transfers (fees are taken from the token amount). HopFacet always forwards nativeFee + minAmount for native and nativeFee for ERC20, which means: native transfers revert via Hop's internal check unless nativeFee is zero, and ERC20 transfers silently lose the entire nativeFee with no refund.

**Fix:** Fixed in commit b04aaaf9. Synchronize msg.value with _bridgeData.minAmount and stop forwarding native value when bridging ERC20s.

**Source:** `2025.05.08_Cantina_Comp.pdf` p.19-21 · `audit20250508::3.1.7`

---

## LF-071 · LOW · PioneerFacet · fixed

**Recognition signal:** Off-chain-coordinated bridging facet that accepts a user-supplied refund/recovery address without enforcing it is non-zero (or otherwise sane).

**Root cause:** `refundAddress` is the off-chain solver's only path to return funds when bridging fails, but the facet accepts it without rejecting `address(0)`. An invalid refund address registered during bridging guarantees permanent loss of user funds if the bridge does not complete.

**Fix:** Revert if `_pioneerData.refundAddress == address(0)`. Fixed in commit cd009186.

**Source:** `2025.06.26_PioneerFacet(v1.0.0).pdf` p.4-4 · `audit20250626::6.1.1`

---

## LF-072 · LOW · PioneerFacet · fixed

**Recognition signal:** Bridging entrypoint that relies on a user-supplied `transactionId`/correlation id for off-chain processing without rejecting `bytes32(0)`.

**Root cause:** Pioneer bridging uses `transactionId` as the off-chain solver's identifier for the order. The facet accepts `bytes32(0)` without rejecting it; an empty id may confuse off-chain solvers and cause inconsistent state for that user.

**Fix:** Revert if `_bridgeData.transactionId == bytes32(0)`. Fixed in commit 3d0ab5e2.

**Source:** `2025.06.26_PioneerFacet(v1.0.0).pdf` p.4-4 · `audit20250626::6.1.2`

---

## LF-079 · LOW · AllBridgeFacet · acknowledged

**Recognition signal:** Caller-supplied fee value is forwarded to a downstream bridge without an upper bound derived from the bridge's own on-chain quote, and the downstream does not refund overpayment.

**Root cause:** The user-supplied _allBridgeData.fees parameter is forwarded to the AllBridge router without comparison against the on-chain quote (getTransactionCost + getMessageCost). The router itself does not refund overpayment, so any fees the user provides above the actual cost are absorbed by the router and unrecoverable.

**Fix:** Acknowledged; team added documentation describing the behavior in commit d354cfa0129198d80d47f4ba6f70f05871a214a1 rather than capping at the on-chain quote.

**Source:** `2025.07.18_AllBridgeFacet(v2.1.0).pdf` p.5-5 · `audit20250718::6.1.1`

---

## LF-091 · LOW · AcrossFacetPackedV4 · fixed

**Recognition signal:** Truncating a 32-byte non-EVM receiver into a 20-byte address field during calldata decoding, losing data needed to identify the off-chain destination.

**Root cause:** The packed-calldata decoders set bridgeData.receiver = address(uint160(uint256(bytes32(...)))), discarding the upper 12 bytes of a 32-byte receiver. For non-EVM destinations (Solana etc.) the raw bytes32 receiver is not round-trippable and a 32-byte value with 12 leading zero bytes can be misclassified as an EVM address.

**Fix:** Fixed in 5e797a1 by special-casing receivers with 12 leading zero bytes as EVM and keeping the full bytes32 receiver in acrossData.receiverAddress for non-EVM flows.

**Source:** `2025.09.01_AcrossV4(v1.0.0).pdf` p.4-5 · `audit20250901::6.1.1`

---

## LF-092 · LOW · AcrossFacetV4 · acknowledged

**Recognition signal:** Computing a critical downstream amount via fixed-point multiplication and division without asserting the result is non-zero when the inputs are user/backend-controlled.

**Root cause:** outputAmount is computed as (minAmount * outputAmountMultiplier) / 1e18 with no post-condition check. If outputAmountMultiplier is zero or the numerator is below 1e18, the result rounds to zero and an Across intent is created with zero output, locking user funds.

**Fix:** Acknowledged in commit a265751: backend produces the multiplier so calldata is trusted; a disclaimer comment was added instead of an on-chain guard.

**Source:** `2025.09.01_AcrossV4(v1.0.0).pdf` p.4-5 · `audit20250901::6.1.2`

---

## LF-093 · LOW · AcrossFacetV4 · fixed

**Recognition signal:** Forwarding a user-supplied refund/recovery address to an external bridge without validating it is non-zero, leaving no recovery path for stuck transfers.

**Root cause:** _startBridge forwards _acrossData.refundAddress to the spoke pool without checking != bytes32(0). A zero refundAddress means refunds for unfulfilled or expired intents cannot be received, leading to permanent fund loss.

**Fix:** Fixed in ed698cc by adding an explicit revert when refundAddress is bytes32(0).

**Source:** `2025.09.01_AcrossV4(v1.0.0).pdf` p.4-6 · `audit20250901::6.1.3`

---

## LF-099 · LOW · EcoFacet · fixed

**Recognition signal:** Receiver-validation logic that treats the NON_EVM sentinel as authorized for any destination unless another branch explicitly rejects it, instead of whitelisting only the chains that legitimately use NON_EVM_ADDRESS.

**Root cause:** `_validateEcoData()` branches on `receiver == NON_EVM_ADDRESS` and applies Solana-specific validation only when `isSolanaDestination` is true; the non-Solana branch merely checks that `encodedRoute` is non-empty. A user can therefore submit a NON_EVM_ADDRESS receiver to a regular EVM-compatible chain (e.g., TRON) and pass validation, producing an inconsistent on-chain order.

**Fix:** Reject NON_EVM_ADDRESS receiver unless `isSolanaDestination`. Fixed in commit ca999e8.

**Source:** `2025.10.01_EcoFacet(v1.0.0).pdf` p.4-4 · `audit20251001::6.1.1`

---

## LF-100 · LOW · EcoFacet · fixed

**Recognition signal:** `payable` bridging entrypoint whose underlying call uses `value: 0` and does not refund leftover msg.value (missing `refundExcessNative`-style modifier).

**Root cause:** `startBridgeTokensViaEco` is `payable` but the Eco portal is called with `value: 0` and no native asset is bridged or refunded, so any native sent stays in the diamond. `swapAndStartBridgeTokensViaEco` lacks the `refundExcessNative` modifier, so leftover msg.value after swaps is never returned to the user.

**Fix:** Make `startBridgeTokensViaEco` non-payable and add `refundExcessNative` to `swapAndStartBridgeTokensViaEco`. Fixed in commit 8ee81f6.

**Source:** `2025.10.01_EcoFacet(v1.0.0).pdf` p.4-5 · `audit20251001::6.1.2`

---

## LF-101 · LOW · EcoFacet · fixed

**Recognition signal:** Variable-length address validation that enforces only the upper bound or only a non-zero length, while the chain's address format mandates a specific length range.

**Root cause:** `_validateSolanaReceiver()` checks only `length == 0` and `length > 44`, despite a code comment stating Solana addresses must be 32-44 chars. A `nonEVMReceiver` of length 1-31 passes validation and could result in funds bridged to an invalid Solana destination.

**Fix:** Replace zero-length check with `length < 32 || length > 44`. Fixed in commit 94b00df.

**Source:** `2025.10.01_EcoFacet(v1.0.0).pdf` p.5-6 · `audit20251001::6.1.3`

---

## LF-102 · LOW · EcoFacet · fixed

**Recognition signal:** Conditional event emission keyed on the length of an optional user-controlled field rather than the actual underlying state (destination chain, asset class, etc.) the event is meant to signal.

**Root cause:** `_startBridge` emits `BridgeToNonEVMChain` based on `_ecoData.nonEVMReceiver.length > 0` rather than the actual destination chain. Because validation never requires `nonEVMReceiver` to be empty on EVM destinations, a user can populate that field while bridging to a regular EVM chain and pollute event logs with a false non-EVM signal.

**Fix:** Switch event guard to destination-chain-id based check (e.g., `destinationChainId == LIFI_CHAIN_ID_SOLANA`). Fixed in commit e3249ef.

**Source:** `2025.10.01_EcoFacet(v1.0.0).pdf` p.6-6 · `audit20251001::6.1.4`

---

## LF-104 · LOW · UnitFacet · acknowledged

**Recognition signal:** Bridge or escrow facet that funnels user assets to a destination address authenticated only by a single off-chain signer, with no on-chain allow-list, cooldown, or challenge window.

**Root cause:** The deposit address that user funds are routed to is delivered by an EIP-712 signature from a backend signer. There is no on-chain registry, whitelist, cooldown, or challenger gate that proves the destination is a legitimate Unit Protocol address. A compromised signer or backend can route every bridge to an attacker-controlled address.

**Fix:** Acknowledged (mitigated off-chain). The backend re-signs P-256 MPC-verified guardian signatures into EIP-712; LI.FI agreed to relay the on-chain hardening recommendation to the Unit team.

**Source:** `2025.10.07_UnitFacet(v1.0.0).pdf` p.4-4 · `audit20251007::6.1.1`

---

## LF-105 · LOW · UnitFacet · acknowledged

**Recognition signal:** swap-then-bridge flow where the bridge step assumes a specific output asset (native or specific ERC20) but never asserts that the last swap's receivingAssetId matches that expected asset.

**Root cause:** The function performs an arbitrary swap then unconditionally treats the output as native ETH (passes the result amount to LibAsset.transferNativeAsset). If a misconfigured swap yields an ERC20, the transfer either reverts only when there is insufficient native balance or behaves incorrectly. There is no explicit check that swapData[length-1].receivingAssetId == NULL_ADDRESS.

**Fix:** Acknowledged; LI.FI relies on the implicit revert from insufficient native balance to fail-stop instead of adding an explicit guard.

**Source:** `2025.10.07_UnitFacet(v1.0.0).pdf` p.4-6 · `audit20251007::6.1.2`

---

## LF-106 · LOW · UnitFacet · acknowledged

**Recognition signal:** Signature verified over input parameters that are subsequently mutated (e.g., by a swap, slippage adjustment, or fee deduction) before the authorized side-effect executes.

**Root cause:** _verifySignature reads bridgeData.minAmount before the swap mutates it; _depositAndSwap then overwrites minAmount with the swap output before _startBridge. The bridged amount is therefore not the one the backend signed for, so the signed authorization no longer binds the actual cross-chain transfer amount.

**Fix:** Acknowledged; LI.FI treats the signature as authorizing initiation, not the post-swap amount.

**Source:** `2025.10.07_UnitFacet(v1.0.0).pdf` p.5-6 · `audit20251007::6.1.3`

---

## LF-115 · LOW · WhitelistManagerFacet, LibAllowList · fixed

**Recognition signal:** Two-mapping invariant (e.g. allow-list bool + reverse-index uint) where a remove/cleanup path early-returns based on one mapping and skips clearing the other, leaving an inconsistent state that cannot be undone through the normal admin path.

**Root cause:** The DexManager-to-WhitelistManager migration relies on an off-chain list of selectors to clear; any selector missed by the off-chain list stays true in selectorAllowList but has no entry in selectorToIndex. The remove path in _removeAllowedSelector early-returns when oneBasedIndex == 0, so the leftover whitelisted selector can never be removed and stays callable.

**Fix:** Fixed in PR#1376: _removeAllowedSelector now unconditionally deletes als.selectorAllowList[_selector] before checking the index, so imperfect off-chain cleanup cannot leave selectors stuck in the on/true state.

**Source:** `2025.11.04_WhitelistManagerFacet(v1.0.0).pdf` p.7-8 · `audit20251104::L-2`

---

## LF-118 · LOW · LiFiIntentEscrowFacet · fixed

**Recognition signal:** Event/flag describing whether a destination call exists that is hardcoded false (or set independently of actual behavior) while another struct field carries calldata that is executed after delivery.

**Root cause:** The facet applies the doesNotContainDestinationCalls modifier (forcing _bridgeData.hasDestinationCall = false) yet simultaneously forwards a non-empty _lifiIntentData.outputCall, which the OIF documentation defines as calldata executed after token delivery. Consumers of LiFiTransferStarted therefore see a flag that contradicts the actual on-destination behavior, breaking downstream monitoring and risk filters.

**Fix:** Fixed in commit 67d51637 by removing the doesNotContainDestinationCalls modifier and synchronizing the flag with the actual outputCall presence.

**Source:** `2025.11.19_LiFiIntentEscrowFacet(v1.0.0).pdf` p.4-4 · `audit20251119::6.1.1`

---

## LF-119 · LOW · LiFiIntentEscrowFacet · fixed

**Recognition signal:** Intent/escrow flow that accepts a user-specified output amount and forwards it to a solver/settler without validating it is non-zero.

**Root cause:** The intent's outputAmount is forwarded to the OIF settler without a non-zero check. If outputAmount is 0, a solver can satisfy the intent by sending zero tokens to the user while collecting the entire deposit on the source chain.

**Fix:** Fixed in commit e769f33 by reverting when outputAmount == 0.

**Source:** `2025.11.19_LiFiIntentEscrowFacet(v1.0.0).pdf` p.4-4 · `audit20251119::6.1.2`

---

## LF-120 · LOW · LiFiIntentEscrowFacet · fixed

**Recognition signal:** Refund/recovery address taken from user input and forwarded to an external settler without a zero-address guard.

**Root cause:** The user-supplied depositAndRefundAddress is forwarded to the settler without a non-zero check. A zero value (e.g., from a frontend bug) leaves refunds unreachable.

**Fix:** Fixed in commit 7346115 by reverting with InvalidReceiver when depositAndRefundAddress is zero.

**Source:** `2025.11.19_LiFiIntentEscrowFacet(v1.0.0).pdf` p.4-4 · `audit20251119::6.1.3`

---

## LF-132 · LOW · LiFiIntentEscrowFacet · fixed

**Recognition signal:** Multiple refund paths in one entrypoint that send leftover funds to two different recipients (depositor-supplied address vs. msg.sender), so a relayer-or-forwarder caller silently captures part of the refund.

**Root cause:** swapAndStartBridgeTokensViaLiFiIntentEscrow routes refund types differently: positive slippage to depositAndRefundAddress, but excess native ETH and swap leftovers via refundExcessNative(msg.sender). When msg.sender is a relayer/forwarder this misdirects user refunds to the relayer.

**Fix:** Resolved in df0c3c2: aligned slippage refunds. Excess native flow kept on msg.sender across all facets to avoid implementation fragmentation; broader cross-facet fix deferred.

**Source:** `2026.01.30_LiFiIntentEscrowFacet(v1.1.0).pdf` p.4-4 · `audit20260130::6.1.1`

---

## LF-138 · LOW · AcrossV4SwapFacet · acknowledged

**Recognition signal:** A facet that enforces a backend signature on some swap-API targets but selectively bypasses it for others, creating an asymmetric trust model across otherwise-similar entry paths.

**Root cause:** _verifySignatureIfRequired enforces the LI.FI backend EIP-712 signature only for SpokePool and SpokePoolPeriphery targets, returning early for SponsoredOFTSrcPeriphery and SponsoredCCTPSrcPeriphery. The two sponsored paths therefore accept any caller-crafted calldata as long as downstream periphery checks pass, breaking a uniform trust model.

**Fix:** Acknowledged: sponsored paths are considered LI.FI-internal-only; risk accepted.

**Source:** `2026.04.09_AcrossV4SwapFacet(v1.0.0).pdf` p.5-7 · `audit20260409::6.3.1`

---

## LF-139 · LOW · AcrossV4SwapFacet · fixed

**Recognition signal:** Forwarding the original msg.value to a downstream payable call inside a function that may have already consumed part of that ETH for an internal swap.

**Root cause:** _callSponsoredOftDeposit forwards the original msg.value to the LayerZero deposit for messaging fees. When called via swapAndStartBridgeTokensViaAcrossV4Swap with a native-to-ERC20 source swap, the swap already consumed part of the contract's ETH, so forwarding msg.value reverts and the OFT path becomes unusable with native source swaps.

**Fix:** Fixed in 5db76ea by tracking the native amount actually needed for LZ fees rather than blindly forwarding msg.value.

**Source:** `2026.04.09_AcrossV4SwapFacet(v1.0.0).pdf` p.7-7 · `audit20260409::6.3.3`

---

## LF-140 · LOW · AcrossV4SwapFacet · fixed

**Recognition signal:** Token-address validation branch that is performed for ERC20 inputs but silently skipped for the native-token case, deferring all correctness to an off-chain signature.

**Root cause:** When isNative == true, both the SpokePool and SpokePoolPeriphery paths skip the token-address check that ERC20 flows perform against _bridgeData.sendingAssetId, leaving correctness of the native-token address entirely to the backend signature.

**Fix:** Fixed in e36cd4a by enforcing that the decoded native token matches the expected wrapped-native constant.

**Source:** `2026.04.09_AcrossV4SwapFacet(v1.0.0).pdf` p.7-7 · `audit20260409::6.3.4`

---

## LF-141 · LOW · AcrossV4SwapFacet · fixed

**Recognition signal:** Performing a refund/transfer at the very top of a function before downstream parameter checks, so a failing check reverts an already-attempted state-changing transfer.

**Root cause:** In both _callSponsoredOftDeposit and _callSponsoredCctpDepositForBurn, the positive-slippage refund transfer happens before subsequent input checks (refundRecipient/receiver/amount/burnToken validations). This violates checks-effects-interactions and masks the real failure cause when later validations revert.

**Fix:** Fixed in de6a839 by moving the refund block after all validation checks in both sponsored paths.

**Source:** `2026.04.09_AcrossV4SwapFacet(v1.0.0).pdf` p.7-9 · `audit20260409::6.3.5`

---

## LF-142 · LOW · AcrossV4SwapFacet · fixed

**Recognition signal:** Inconsistent zero-address validation for an equivalent 'refund recipient' field across multiple sibling code paths in the same contract.

**Root cause:** Three of four AcrossV4SwapFacet paths explicitly reject a zero depositor/refund address, but the SponsoredCCTP path does not, relying on a downstream LibAsset.transferERC20 NULL_ADDRESS check that only triggers when positive slippage occurs.

**Fix:** Fixed in 93dda97 by adding an explicit refundRecipient != address(0) check before the positive-slippage block.

**Source:** `2026.04.09_AcrossV4SwapFacet(v1.0.0).pdf` p.8-8 · `audit20260409::6.3.6`

---

## LF-144 · LOW · DeBridgeDlnFacet · fixed

**Recognition signal:** Bridging order configuration where the only path to cancel/refund flows through a single user-supplied destination authority field, while the facet performs no sanity check (zero/empty) on that field.

**Root cause:** Because `allowedCancelBeneficiarySrc` is hardcoded to empty in `_startBridge`, all cancellation and refund authority resides exclusively with `orderAuthorityAddressDst`. The facet does not check that `_deBridgeData.orderAuthorityDst` is non-empty/non-zero, so a misconfigured order is uncancellable and unrefundable, permanently stranding funds if unfilled.

**Fix:** Revert if `_deBridgeData.orderAuthorityDst.length == 0`. Fixed in commit 36a8922.

**Source:** `2026.04.30_DeBridgeDlnFacet(v1.1.0).pdf` p.4-4 · `audit20260430::6.1.1`

---

## LF-145 · LOW · DeBridgeDlnFacet · acknowledged

**Recognition signal:** Authority/permission field set to `msg.sender` inside a facet, where the same facet is reachable indirectly via a proxy/meta-tx contract that becomes msg.sender instead of the real user.

**Root cause:** DLN's `givePatchAuthoritySrc` is set to `msg.sender`. When the facet is invoked indirectly via Permit2Proxy (`callDiamondWithEIP2612Signature`, `callDiamondWithPermit2*`), `msg.sender` inside the facet is the Permit2Proxy contract address, not the end user. Permit2Proxy exposes no patch endpoint, so the economic owner has no path to patch their own order.

**Fix:** Acknowledged - LI.FI argues the destination authority gives sufficient control. No contract change.

**Source:** `2026.04.30_DeBridgeDlnFacet(v1.1.0).pdf` p.4-4 · `audit20260430::6.1.2`

---

## LF-020 · INFO · EmergencyPauseFacet · acknowledged

**Recognition signal:** Admin-callable function that accepts an unconstrained list of facets/selectors to remove and does not blacklist itself or the emergency-pause facet, allowing the safety mechanism to be removed in a single transaction.

**Root cause:** The unpause flow accepts an arbitrary blacklist of facets to remove from the diamond. Nothing prevents the owner from including the EmergencyPauseFacet itself in that list, which removes its selectors and irreversibly disables the emergency-pause kill-switch for the diamond.

**Fix:** Not fixed. Acknowledged; the team will handle this function with extra caution operationally.

**Source:** `2024.11.05_EmergencyPauseFacet_ReAudit.pdf` p.5-5 · `audit20241105::appendix`

---

## LF-028 · INFO · RelayFacet · fixed

**Recognition signal:** Bridge facet that forwards an off-chain-supplied unique order/quote identifier without a contract-side mapping to mark it as consumed, leaving replay protection entirely to the external service.

**Root cause:** `requestId` from the Relay quote is forwarded but the facet does not record consumed IDs. If the same `requestId` is replayed (the off-chain Relay side may not deduplicate within msg.data), funds are spent again on the source chain even though they will eventually be refunded.

**Fix:** Add a mapping to track consumed `requestId`s and reject duplicates. Fixed in commit 4b3535fb.

**Source:** `2024.12.02_RelayFacet(v1.0.0).pdf` p.5-5 · `audit20241202::6.2.2`

---

## LF-037 · INFO · AcrossFacetV3 · acknowledged

**Recognition signal:** User-controlled multiplier or scaling factor applied via fixed-point math (e.g. * X / 1e18) with no min/max bounds, where extreme values produce either trivially-small results (silent loss) or implausibly-large results (waste / DoS).

**Root cause:** swapAndStartBridgeTokensViaAcrossV3 computes outputAmount = (minAmount * outputAmountPercent) / 1e18 with no minimum or maximum check on outputAmountPercent. A near-zero value yields an essentially zero output (loss of funds on the destination), and a value greatly above 1e18 yields an unrealistically inflated output that would be rejected by Across but wastes user gas and may emit misleading state.

**Fix:** Acknowledged but not patched; LI.FI argues that source/destination decimal mismatch makes a generic bound incorrect and chose not to add the limit. Reviewer suggested at least a non-zero guard.

**Source:** `2025.01.06_AcrossFacetV3(v1.1.0).pdf` p.4-4 · `audit20250106::6.1.1`

---

## LF-043 · INFO · GlacisFacet · acknowledged

**Recognition signal:** Facet that forwards a user-controlled `value:` to an external call without asserting that msg.value supplied by the caller covers it.

**Root cause:** The facet passes _glacisData.nativeFee to airlift.send{value: ...} without checking that the caller actually supplied that value via msg.value. If the LiFiDiamond ever holds native balance (intentionally or not), a user could pay the bridge's native fee out of the diamond's funds.

**Fix:** Acknowledged; LI.FI prioritized gas savings, accepting that the diamond is not expected to hold native balance.

**Source:** `2025.02.19_GlacisFacet(v1.0.0).pdf` p.5-5 · `audit20250219::6.2.1`

---

## LF-044 · INFO · GlacisFacet · fixed

**Recognition signal:** Bridge facet exposing entrypoints for an external integration that does not support native assets but omitting an upfront noNativeAsset / asset-type guard.

**Root cause:** Glacis Airlift does not support bridging the native asset, but GlacisFacet exposes both bridge entrypoints without the noNativeAsset guard. Native-asset attempts revert several frames down inside the external airlift contract with an opaque custom-error selector.

**Fix:** Fixed in commit f9276e33393986022f90b48fd0c5a025fa9702b6 by adding the noNativeAsset modifier to both bridge functions.

**Source:** `2025.02.19_GlacisFacet(v1.0.0).pdf` p.6-6 · `audit20250219::6.2.2`

---

## LF-045 · INFO · GlacisFacet · acknowledged

**Recognition signal:** swap-then-bridge function that uses _bridgeData.sendingAssetId for the bridge step without asserting that the last swap's receivingAssetId matches.

**Root cause:** The function depositAndSwaps user assets, then bridges using _bridgeData.sendingAssetId, without confirming that swapData[length-1].receivingAssetId equals that bridging asset. A misconfigured route can leave funds in an unintended token while the bridge call attempts to transfer the wrong asset, causing a late and opaque revert.

**Fix:** Acknowledged; LI.FI argues the call would revert anyway since the diamond does not hold funds.

**Source:** `2025.02.19_GlacisFacet(v1.0.0).pdf` p.5-7 · `audit20250219::6.2.3`

---

## LF-068 · INFO · GnosisBridgeFacet · acknowledged

**Recognition signal:** Bridge facet that issues max ERC20 approval to an external router on every bridge call instead of the exact transfer amount, accepting larger blast radius for gas savings.

**Root cause:** _startBridge uses LibAsset.maxApproveERC20 on the Gnosis Bridge Router. Although the facet never holds balances persistently (funds flow through atomically), any future bug or compromise of the router would have a larger blast radius than a per-call exact-amount approval.

**Fix:** Acknowledged as an intentional design choice across facets for gas efficiency; no change made.

**Source:** `2025.06.03_GnosisBridgeFacet(v2.0.0).pdf` p.4-4 · `audit20250603::6.1.1`

---

## LF-069 · INFO · GnosisBridgeFacet · fixed

**Recognition signal:** swapAndBridge entrypoint that validates the bridge's sending asset against an allowlist but does not also assert the last swap step's output equals that asset.

**Root cause:** The facet checks that bridgeData.sendingAssetId is DAI or USDS, but never verifies that swapData[last].receivingAssetId matches it. A swap chain producing Token X while the bridge expects Token Y would not be caught, potentially attempting to bridge the wrong asset.

**Fix:** Added a require that _swapData[last].receivingAssetId == _bridgeData.sendingAssetId, reverting with InvalidSendingToken otherwise. Fixed in 05ff21c84a27e110a71960f26b44499e33ef5fee.

**Source:** `2025.06.03_GnosisBridgeFacet(v2.0.0).pdf` p.4-4 · `audit20250603::6.1.2`

---

## LF-073 · INFO · PioneerFacet · acknowledged

**Recognition signal:** Bridging entrypoint that accepts pre-bridge swap data and forwards to the bridge step without asserting the last swap's receiving asset matches the declared bridging asset.

**Root cause:** After the pre-bridge swap, the facet does not assert `_bridgeData.sendingAssetId == _swapData[last].receivingAssetId`. Mismatch is caught implicitly by the subsequent transfer to the Pioneer EOA reverting on insufficient balance.

**Fix:** Acknowledged - relies on the implicit revert when the contract holds the wrong asset; no contract change.

**Source:** `2025.06.26_PioneerFacet(v1.0.0).pdf` p.5-5 · `audit20250626::6.2.3`

---

## LF-080 · INFO · AllBridgeFacet · fixed

**Recognition signal:** Bridge facet supports a non-EVM destination path but is missing the project-wide BridgeToNonEVM* event that captures the non-EVM receiver bytes for indexers and monitoring.

**Root cause:** _startBridge supports bridging to non-EVM destinations but, unlike sibling facets, never emits the BridgeToNonEVMChain event with the non-EVM receiver bytes. This breaks the convention that off-chain indexers and security tooling depend on to track non-EVM destination addresses.

**Fix:** Fixed in 240e8072a23c400a7ca870b8500ed0fc61d2b0df by emitting BridgeToNonEVMChain on the non-EVM path.

**Source:** `2025.07.18_AllBridgeFacet(v2.1.0).pdf` p.4-5 · `audit20250718::6.2.3`

---

## LF-081 · INFO · MayanFacet, DeBridgeDlnFacet · fixed

**Recognition signal:** Facet constructor stores immutable external-protocol addresses without zero-address validation, diverging from the codebase's other facets that all validate.

**Root cause:** The constructors of MayanFacet and DeBridgeDlnFacet store immutable bridge/router addresses passed in at deploy time without checking that they are non-zero. A misconfigured deployment can permanently brick the facet because the addresses are immutable.

**Fix:** Fixed in af2a8591fa2db65563dd02c353163450bdff79be by validating constructor params in both facets.

**Source:** `2025.07.18_AllBridgeFacet(v2.1.0).pdf` p.6-6 · `audit20250718::6.2.5`

---

## LF-089 · INFO · RelayDepositoryFacet · acknowledged

**Recognition signal:** Facet that uses bridgeData fields only to populate emitted events while the authoritative bridge parameters live off-chain, allowing user-supplied event metadata to drift from the actual transfer.

**Root cause:** The facet stores all real transfer details off-chain inside Relay's orderId; on-chain it only forwards the orderId and uses bridgeData.receiver/destinationChain solely to populate the LiFiTransferStarted event. A user can therefore submit bridgeData with arbitrary receiver/destinationChain values that do not match the actual off-chain order, and downstream consumers of the event have no way to detect the divergence. The facet also does not emit BridgeToNonEVMChainBytes32 when the off-chain destination is Solana.

**Fix:** Acknowledged in commit 9d86e488b6f651205605dd65cb0086caed8507c3 with added contract and docs comments.

**Source:** `2025.08.25_RelayDepositoryFacet(v1.0.0).pdf` p.6-7 · `audit20250825_1::I-02`

---

## LF-090 · INFO · RelayDepositoryFacet · acknowledged

**Recognition signal:** Bridge integration that forwards full swap output (including positive slippage) instead of the off-chain-quoted input amount, relying on the external solver to refund the difference rather than returning excess to the user on-chain.

**Root cause:** When a preswap step produces positive slippage, the facet forwards the full swap output to RelayDepository even though the off-chain order specified a smaller input. Refund of the overpaid amount is entirely dependent on Relay's solver implementation, which is an off-chain trust assumption not enforced on-chain.

**Fix:** Acknowledged in commit 898c77f65632565d1de12013e08dd61681335b32 with contract/docs comments and a recommendation to monitor for solver behavior changes.

**Source:** `2025.08.25_RelayDepositoryFacet(v1.0.0).pdf` p.7-8 · `audit20250825_1::I-03`

---

## LF-094 · INFO · AcrossFacetPackedV4 · acknowledged

**Recognition signal:** An onlyOwner function that performs an unrestricted low-level call to a caller-supplied target with caller-supplied calldata and no whitelist or timelock.

**Root cause:** executeCallAndWithdraw lets onlyOwner call any _callTo with arbitrary _callData and no whitelist or timelock. A compromised or malicious owner can revoke approvals, drain partner contracts, or otherwise weaponize the contract.

**Fix:** Acknowledged: function is not added to the diamond and only standalone packedFacet is affected, used by a small set of partners.

**Source:** `2025.09.01_AcrossV4(v1.0.0).pdf` p.5-7 · `audit20250901::6.2.3`

---

## LF-096 · INFO · AcrossFacetPackedV4 · fixed

**Recognition signal:** Packed-calldata decoder whose declared minimum-length check is smaller than the highest byte index it indexes into.

**Root cause:** Decoder validates data.length < 188 but then accesses data[216:220] for exclusivityDeadline and data[220:] for message, allowing inputs of length 188-219 to pass validation while producing out-of-bounds reads of packed fields.

**Fix:** Fixed in 4bce2a1 (raising threshold to 220); later partially reverted as the related sendingAssetId parameter was removed in subsequent PRs.

**Source:** `2025.09.01_AcrossV4(v1.0.0).pdf` p.7-7 · `audit20250901::6.2.6`

---

## LF-097 · INFO · GardenFacet · fixed

**Recognition signal:** Cross-chain facet handling non-EVM destinations without emitting the standardized non-EVM bridging event or carrying a non-EVM-shaped receiver field — observability gap that also signals the address-encoding limitation.

**Root cause:** GardenFacet's primary use-case is bridging to Bitcoin and BTC derivatives, but it does not emit the protocol-standard BridgeToNonEVMChain event and has no nonEvmReceiver field in GardenData. Off-chain indexers cannot reliably distinguish/track non-EVM transfers, and the bridgeData.receiver cannot fit a Bitcoin-format address.

**Fix:** Added nonEvmReceiver field and BridgeToNonEVMChain event emission for non-EVM destinations. Fixed in 818de27b64a73879c91dbddc3195be03bafdc08f.

**Source:** `2025.09.19_GardenFacet(v1.0.0).pdf` p.10-11 · `audit20250919::I-3`

---

## LF-103 · INFO · EcoFacet · fixed

**Recognition signal:** Bridging facet that forwards user-supplied prover/relayer/deadline configuration into an external order without sanity-checking address-zero and timestamp-in-future invariants.

**Root cause:** `_buildReward()` passes user-supplied `prover` and `rewardDeadline` into the Eco Reward struct without checking that prover is non-zero or that the deadline is non-zero and in the future. Invalid configuration silently produces an unfundable or unprovable order.

**Fix:** Validate `prover != address(0)` and `rewardDeadline > block.timestamp`. Fixed in commit 0c8f825.

**Source:** `2025.10.01_EcoFacet(v1.0.0).pdf` p.8-9 · `audit20251001::6.3.1`

---

## LF-107 · INFO · UnitFacet · fixed

**Recognition signal:** Chain-id switch with explicit cases for a subset of chains and an implicit fall-through that allows the same function to operate on any other chain with no validation.

**Root cause:** The chain-id switch contains explicit minimum-amount branches for chain IDs 1 (Ethereum) and 9745 (Plasma) and falls through with no guard for every other chain. Users can therefore originate a bridge from an unsupported chain with arbitrarily small amounts; the off-chain Unit Protocol cannot process them and funds risk being stuck.

**Fix:** Fixed in commit 40b6c94e by adding an UnsupportedChain revert in the else branch.

**Source:** `2025.10.07_UnitFacet(v1.0.0).pdf` p.6-8 · `audit20251007::6.2.1`

---

## LF-108 · INFO · UnitFacet · fixed

**Recognition signal:** Signature verification that performs ecrecover/hashing before checking the cheap expiration timestamp, so expired signatures consume the full verification cost.

**Root cause:** The deadline comparison occurs after the expensive parts of _verifySignature complete. Stale signatures are still rejected, but the contract reaches that decision only after performing avoidable work.

**Fix:** Fixed in commit e1648970 by moving the deadline check to the top of _verifySignature.

**Source:** `2025.10.07_UnitFacet(v1.0.0).pdf` p.7-9 · `audit20251007::6.2.3`

---

## LF-109 · INFO · UnitFacet · fixed

**Recognition signal:** Backend-signed authorization with no nonce / no used-signature tracking, where uniqueness relies solely on a future deadline.

**Root cause:** _verifySignature checks only the signer and the deadline. There is no nonce, transactionId allowlist, or used-signature mapping. While Unit Protocol's deposit addresses are tied to receivers (limiting third-party theft), the signature can still be replayed by the same user (or anyone) before expiry.

**Fix:** Fixed in commit 32a032515 by adding transactionId-based replay protection.

**Source:** `2025.10.07_UnitFacet(v1.0.0).pdf` p.8-8 · `audit20251007::6.2.5`

---

## LF-110 · INFO · EcoFacet · fixed

**Recognition signal:** Bridge facet that funds a downstream vault using a totalAmount field encoding swap output, without skimming the delta between actual swap output and the intended minAmount back to the user.

**Root cause:** The intent's reward.tokens.amount encodes a totalAmount (intent + reward + any positive slippage). When swap output exceeds _bridgeData.minAmount, the surplus is included in the funded vault amount and ends up claimed by the solver upon fill, rather than refunded to the user. The pre-existing code comment understated this by claiming excess remains in the diamond.

**Fix:** Updated swapAndStartBridgeTokensViaEco to detect actualAmountAfterSwap > minAmount and transfer the positive slippage back to msg.sender before bridging. Fixed in PR lifinance/contracts/pull/1421.

**Source:** `2025.10.20_EcoFacet(v1.1.0).pdf` p.15-17 · `audit20251020::I-3`

---

## LF-113 · INFO · WhitelistManagerFacet · mitigated

**Recognition signal:** Off-chain-derived input to an irreversible on-chain migration / state cleanup where missing entries leave dangerous residual state, with no on-chain consistency check to flag the gap.

**Root cause:** The off-chain-supplied _selectorsToRemove list for migration is assembled by parsing historical events across many chains, an error-prone process. Selectors absent from the list silently survive the migration with no on-chain detection, and one of the already-whitelisted contracts is a token (DEGENx on Base) for which an accidentally-whitelisted transferFrom selector would let any user drain outstanding approvals.

**Fix:** Acknowledged; LI.FI aggregates the selector list from three sources (on-chain scan, sigs.json, whitelist.json) as defense in depth, and added a token-detection guard that rejects any contract whose decimals() returns 0-255. Reviewer verified.

**Source:** `2025.11.04_WhitelistManagerFacet(v1.0.0).pdf` p.9-11 · `audit20251104::I-2`

---

## LF-117 · INFO · WhitelistManagerFacet, LibAllowList · fixed

**Recognition signal:** One-shot storage-migration function whose tests assert only the new structure's happy path, without verifying the legacy storage layout was zeroed and all derived indices remain consistent.

**Root cause:** The migration path from the legacy whitelist (V1) to the new granular system (V2) was not exercised by tests covering full state-clear-then-rebuild semantics. Without tests verifying mappings, arrays, reference counts, and indices are in sync after migration, latent bugs corrupting whitelist storage could pass unnoticed.

**Fix:** Added migration-completeness and state-consistency tests covering legacy clearing, queryability via getters, and index integrity. Fixed in commit bb32542.

**Source:** `2025.11.04_WhitelistManagerFacet(v1.0.0)_1.pdf` p.5-5 · `audit20251104_1::6.2.4`

---

## LF-121 · INFO · LiFiIntentEscrowFacet · acknowledged

**Recognition signal:** Bridge facet that interacts with non-EVM-aware downstream protocols but lacks the standard NON_EVM_ADDRESS / receiver-encoding branch present in sibling facets.

**Root cause:** Other LI.FI facets switch to a NON_EVM_ADDRESS sentinel and handle bridgeData.receiver specially for non-EVM destinations. The escrow facet has no such branch and the OIF settler call assumes an EVM receiver, so non-EVM intents either revert or send funds to a malformed receiver.

**Fix:** Acknowledged; v1.0.0 ships EVM-only with a planned future update for non-EVM chains.

**Source:** `2025.11.19_LiFiIntentEscrowFacet(v1.0.0).pdf` p.4-5 · `audit20251119::6.2.1`

---

## LF-122 · INFO · LiFiIntentEscrowFacet · raised

**Recognition signal:** Struct destined for a downstream settler containing bytes32 oracle/settler identifiers that are passed through without zero-or-invalid validation.

**Root cause:** outputOracle and outputSettler are bytes32 fields of MandateOutput passed through without validation. Zero or otherwise invalid values typically just trigger refunds, but malformed flows still degrade UX and could surface unexpected protocol-level outcomes.

**Fix:** Status not recorded in the PDF (the LI.FI response line is empty).

**Source:** `2025.11.19_LiFiIntentEscrowFacet(v1.0.0).pdf` p.5-5 · `audit20251119::6.2.2`

---

## LF-123 · INFO · LiFiIntentEscrowFacet · acknowledged

**Recognition signal:** ERC20 approval to a downstream integration set to type(uint256).max (or via a max-approval helper) when the caller could just as easily set the exact per-call amount.

**Root cause:** maxApproveERC20 sets approval to type(uint256).max on the settler when allowance is insufficient. A bug or compromise in the settler can drain every token the diamond currently holds approval for, even across unrelated transactions.

**Fix:** Acknowledged; the LI.FI team accepts the unbounded approval pattern.

**Source:** `2025.11.19_LiFiIntentEscrowFacet(v1.0.0).pdf` p.5-5 · `audit20251119::6.2.3`

---

## LF-124 · INFO · PolymerCCTPFacet · acknowledged

**Recognition signal:** Single-asset bridging facet that enforces source-token whitelist on `bridgeData` but does not assert that `_swapData[last].receivingAssetId` matches the same whitelisted asset.

**Root cause:** The facet only supports USDC, enforced on `sendingAssetId` via the `onlyAllowSourceToken` modifier. The post-swap output token is not asserted to match USDC, so an inconsistent swap reverts deep in the bridge call without a clear error.

**Fix:** Acknowledged. Mismatched swap output would revert because the diamond lacks the required USDC, and the `onlyAllowSourceToken` modifier on `bridgeData.sendingAssetId` provides indirect protection; no contract change.

**Source:** `2025.12.01_PolymerCCTPFacet(v1.0.0).pdf` p.4-4 · `audit20251201::6.1.2`

---

## LF-125 · INFO · PolymerCCTPFacet · acknowledged

**Recognition signal:** Subtracting a user-supplied fee from a user-supplied total without validating fee ≤ total, leaving the protocol to rely on Solidity's checked subtraction to catch the case.

**Root cause:** `bridgeAmount = _bridgeData.minAmount - _polymerData.polymerTokenFee` is computed without ordering checks. If `polymerTokenFee >= minAmount`, the subtraction underflows (revert) or yields a zero-amount bridge that is wasted work.

**Fix:** Acknowledged - won't fix to save gas; LI.FI added documentation in commit e31eef9 instead.

**Source:** `2025.12.01_PolymerCCTPFacet(v1.0.0).pdf` p.5-5 · `audit20251201::6.1.4`

---

## LF-126 · INFO · PolymerCCTPFacet · fixed

**Recognition signal:** Chain-ID-to-domain mapping that includes both mainnet and testnet entries in the same production lookup, allowing a testnet chain ID on a mainnet deployment to silently resolve to a mainnet target.

**Root cause:** `_chainIdToDomainId()` maps Sepolia / OP Sepolia / Base Sepolia chain IDs to the same CCTP domain IDs as their mainnet counterparts. A user mistakenly supplying a testnet chain ID on a mainnet deployment will have USDC bridged to the mainnet destination instead of reverting.

**Fix:** Remove testnet chain ID mappings from the production `_chainIdToDomainId()` function. Fixed in commit 15bca15.

**Source:** `2025.12.01_PolymerCCTPFacet(v1.0.0).pdf` p.5-6 · `audit20251201::6.1.6`

---

## LF-127 · INFO · MegaETHBridgeFacet · fixed

**Recognition signal:** User-supplied address forwarded to an external bridge / vault deposit function without any zero-address guard, where the external contract's own validation is assumed but never confirmed.

**Root cause:** The MegaETHData.assetIdOnL2 field is forwarded directly into bridge.depositERC20To without a zero-address check on the non-requiresDepositTo branch. A user supplying address(0) (accidentally or maliciously) can drive a bridge call with a zero L2-token, which downstream may mint to an unusable token address or otherwise produce undefined behavior.

**Fix:** Fixed in commit 740b0d9 by adding `if (LibUtil.isZeroAddress(_megaETHData.assetIdOnL2)) revert InvalidAssetIdOnL2();` before the depositERC20To call. Reviewer verified.

**Source:** `2025.12.03_MegaETHBridgeFacet(v1.0.0).pdf` p.4-5 · `audit20251203_1::6.2.3`

---

## LF-131 · INFO · NEARIntentsFacet · fixed

**Recognition signal:** Single-use off-chain quote/order identifier marked consumed before the actual on-chain transferred balance is validated, so a fee-on-transfer token (or any balance-shrinking transfer) silently wastes the quote.

**Root cause:** The facet records the quote ID as consumed before validating that the actual delivered token balance matches the quoted amount. For fee-on-transfer tokens the received amount is strictly less than the supplied amount, so the bridge step fails (or underfunds), yet the quote ID has already been marked used and cannot be reused or refunded.

**Fix:** Fixed in 4e5b2ec by documenting the limitation in the contract; protocol team will warn users off-chain not to use fee-on-transfer tokens with this facet.

**Source:** `2025.12.16_NEARIntentsFacet(v1.0.0).pdf` p.5-5 · `audit20251216::6.2.2`

---

## LF-133 · INFO · LiFiIntentEscrowFacet · fixed

**Recognition signal:** Reusing an unrelated semantic error (e.g. receiver-zero) for a different field's zero-address validation, hiding the real failure source from integrators.

**Root cause:** _startBridge reverts InvalidReceiver() when depositAndRefundAddress is zero, but that field is semantically the depositor / refund recipient, not the destination receiver, masking the real cause of the revert for integrators.

**Fix:** Fixed in df0c3c (dedicated error for the depositAndRefundAddress zero check).

**Source:** `2026.01.30_LiFiIntentEscrowFacet(v1.1.0).pdf` p.4-5 · `audit20260130::6.2.1`

---

## LF-134 · INFO · PolymerCCTPFacet · fixed

**Recognition signal:** Parallel non-EVM-receiver fields where one is validated at the facet level and the sibling is delegated entirely to a downstream contract's check, creating inconsistent error surfaces and reliance on external invariants.

**Root cause:** _startBridge explicitly reverts on nonEVMReceiver == bytes32(0) but leaves solanaReceiverATA unchecked, relying on the downstream TokenMessenger to enforce mintRecipient != 0. The two branches therefore fail with different errors at different call-stack depths, and the facet-level guarantee is incomplete and brittle to changes in the external CCTP contract.

**Fix:** Fixed in commit 59d992d by adding an explicit zero-value check on solanaReceiverATA when destinationChainId == LIFI_CHAIN_ID_SOLANA, mirroring the EcoFacet pattern. Reviewer verified.

**Source:** `2026.02.16_PolymerCCTPFacet(v2.0.0).pdf` p.4-4 · `audit20260216::6.1.1`

---

## LF-143 · INFO · AcrossV4SwapFacet · acknowledged

**Recognition signal:** Emitting a 'has destination call' analytics flag based only on the outer wrapper while the inner cross-chain message field that triggers remote execution is not consulted.

**Root cause:** AcrossV4SwapFacet enforces doesNotContainDestinationCalls on bridgeData but the inner SpokePool/Periphery calldata can carry a non-empty Across message that triggers destination-side execution. The LiFiTransferStarted event therefore emits hasDestinationCall = false even when a destination call effectively happens. AcrossFacetV4 cross-checks message length vs the flag; the swap facet does not.

**Fix:** Acknowledged: LI.FI treats destinationCall=true as 'LI.FI-added destination calls only'; the Across swap API is treated as one opaque operation.

**Source:** `2026.04.09_AcrossV4SwapFacet(v1.0.0).pdf` p.10-12 · `audit20260409::6.5.3`

---

## LF-147 · INFO · LiFiIntentEscrowFacet · acknowledged

**Recognition signal:** Facet-specific validateBridgeData modifier that checks receiver and minAmount but skips destinationChainId != 0, leaving a single field of BridgeData unvalidated at the facet entry.

**Root cause:** The validateBridgeDataLiFiIntentEscrow() modifier only rejects a zero receiver and a zero minAmount, but does not check that _bridgeData.destinationChainId != 0. A malformed or misconfigured input can therefore pass facet-level validation with destinationChainId == 0, causing LiFiTransferStarted to be emitted with an invalid destination and any downstream off-chain routing to consume bad metadata.

**Fix:** LI.FI acknowledged but declined to add the check to keep validateBridgeData modifiers consistent across facets (the check did not exist in the prior version). No code change landed.

**Source:** `2026.02.05_LiFiIntentEscrowFacet(v1.0.1,v1.1.1).pdf` p.4-4 · `audit20260205::6.1.2`
