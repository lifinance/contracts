# LI.FI audit knowledge — lessons

Generated from `findings.json` by the `extract-audit-knowledge` skill. Do not hand-edit.

## Totals

- Findings: 147
- Audits with at least one finding: 44
- Audits processed (zero findings): 37
- Audits processed total: 81
- Audits unprocessable (PDF corrupt): 2

## By severity

| critical | high | medium | low | info |
| --- | --- | --- | --- | --- |
| 0 | 4 | 18 | 67 | 58 |

## By area

| facets | periphery | libraries | security | helpers | cross-cutting |
| --- | --- | --- | --- | --- | --- |
| 92 | 44 | 8 | 2 | 0 | 1 |

## Coverage gaps

**Unprocessable audits** — PDFs in `audit/reports/` that could not be read (corruption). Re-obtain from auditor and re-run extraction:
- `audit20251208` — PDF file is permanently corrupted in the repository (and on github.com): xref/catalog destroyed, UTF-8 replacement bytes baked into binary stream — qpdf/pdftotext/pdfinfo all fail. Findings cannot be extracted from this report.
- `audit20251229` — PDF file is corrupted (missing /Root dictionary, illegal characters, broken xref); not recoverable with qpdf/pdftotext. Both working tree and git-committed copy are damaged.

**Zero-finding audits (37)** — read successfully but produced no in-scope findings (either 0 issues reported, or all issues were gas/style/code-quality with no security path):

- `audit20240814`, `audit20241014`, `audit20241107`, `audit20241203`, `audit20250109_1`, `audit20250109_2`
- `audit20250109_3`, `audit20250117_1`, `audit20250117_2`, `audit20250117_3`, `audit20250117_4`, `audit20250220`
- `audit20250228`, `audit20250327`, `audit20250413`, `audit20250415`, `audit20250416`, `audit20250422`
- `audit20250515`, `audit20250608`, `audit20250629`, `audit20250629_1`, `audit20250706`
- `audit20250706_01`, `audit20250728`, `audit20250822`, `audit20250921`, `audit20251015`, `audit20251113`
- `audit20251203_2`, `audit20251215_1`, `audit20251215_2`, `audit20251219`, `audit20251225`, `audit20251231`
- `audit20260320`, `audit20260423`

## Index

| ID | Title | Severity | Area | Contracts | Status |
| --- | --- | --- | --- | --- | --- |
| LF-001 | wrapNative() drains entire native token balance instead of unwrapped amount | medium | periphery | RouteProcessor4 | fixed |
| LF-002 | swapCurve() approve() reverts on tokens that return no bool (USDT) | medium | periphery | RouteProcessor4 | fixed |
| LF-003 | swapCurve() uses .transfer() with 2300-gas stipend to send native tokens | medium | periphery | RouteProcessor4 | fixed |
| LF-004 | exchange() reverts when swapping legacy Curve pool with native token | low | periphery | RouteProcessor4 | acknowledged |
| LF-005 | swapUniV2 does not validate that tokenIn belongs to the pool | low | periphery | RouteProcessor4 | acknowledged |
| LF-006 | distributeAndSwap() can call swap() with amount of 0, triggering bentoBridge full-balance flow | low | periphery | RouteProcessor4 | fixed |
| LF-007 | Revert reason bubbled up incorrectly in transferValueAndprocessRoute() | low | periphery | RouteProcessor4 | fixed |
| LF-008 | No events emitted when admin parameters bentoBox, priviledgedUsers, or paused are modified | info | periphery | RouteProcessor4 | acknowledged |
| LF-009 | Per-leg slippage protection missing; intermediate swaps have minOut hardcoded to 0 | info | periphery | RouteProcessor4 | acknowledged |
| LF-010 | swapCurve() approve() leaves non-zero allowance that bricks future swaps for USDT-like tokens | info | periphery | RouteProcessor4 | fixed |
| LF-011 | extractGenericSwapParameters length check uses >= 484 instead of > 484, accepting calldata with empty SwapData | low | facets | CalldataVerificationFacet | fixed |
| LF-012 | DiamondCutFacet can be accidentally permanently disabled by including it in the unpause blacklist | low | facets | EmergencyPauseFacet | fixed |
| LF-013 | pauserWallet can brick the diamond by pausing then removing the EmergencyPauseFacet itself | low | facets | EmergencyPauseFacet | fixed |
| LF-014 | pauseDiamond can run out of gas as the number of facets grows because there is no pagination | low | facets | EmergencyPauseFacet | acknowledged |
| LF-015 | Across receiver address can be address(0) when destination call flag is enabled, bypassing zero-receiver validation | medium | facets | AcrossFacetV3 | acknowledged |
| LF-016 | ERC20 bridging functions marked payable allow native ETH to be stuck in the contract | low | facets | AcrossFacetPackedV3 | fixed |
| LF-017 | Packed Across calldata encoders silently drop trailing referrer bytes when used directly without out-of-band concatenation | low | facets | AcrossFacetPackedV3 | fixed |
| LF-018 | transactionId truncated from bytes32 to bytes8 in packed Across encoders, producing 75% data loss in events | low | facets | AcrossFacetPackedV3 | acknowledged |
| LF-019 | unpauseDiamond reverts with a panic when an unknown facet address is supplied in the blacklist array | low | facets | EmergencyPauseFacet | acknowledged |
| LF-020 | EmergencyPauseFacet can be removed by the diamond owner during unpause, permanently disabling emergency-pause capability | info | facets | EmergencyPauseFacet | acknowledged |
| LF-021 | Frontrunning callDiamondWithEIP2612Signature steals user funds via unsigned diamond calldata | high | periphery | Permit2Proxy | fixed |
| LF-022 | Witness typehash includes fields not used in the newer Permit2 implementation | low | periphery | Permit2Proxy | fixed |
| LF-023 | Permit2Proxy lacks receive() so native refunds from the Diamond revert | low | periphery | Permit2Proxy | fixed |
| LF-024 | Dust left in Permit2Proxy after diamond calls is claimable by next caller | low | periphery | Permit2Proxy | acknowledged |
| LF-025 | swapAndStartBridgeTokensViaRelay does not validate swap output token equals sendingAssetId | low | facets | RelayFacet | acknowledged |
| LF-026 | Source-chain refunds from Relay are sent to the diamond contract rather than the user | low | facets | RelayFacet | acknowledged |
| LF-027 | Redundant validateBridgeData receiver check while bridging to Solana/Bitcoin | low | facets | RelayFacet | fixed |
| LF-028 | RelayFacet does not prevent requestId replay | info | facets | RelayFacet | fixed |
| LF-029 | DeBridgeDlnFacet validates _bridgeData.receiver but bridges to _deBridgeData.receiver, allowing zero/invalid receiver | medium | facets | DeBridgeDlnFacet | fixed |
| LF-030 | Non-EOA receiver becomes orderAuthorityAddressDst and cannot call sendEvmOrderCancel, permanently locking funds | medium | facets | DeBridgeDlnFacet | fixed |
| LF-031 | allowedCancelBeneficiarySrc left empty allows orderAuthorityAddressDst to redirect refunds away from the original sender | low | facets | DeBridgeDlnFacet | fixed |
| LF-032 | initDeBridgeDln does not gate on sm.initialized, allowing re-initialization of facet storage | low | facets | DeBridgeDlnFacet | acknowledged |
| LF-033 | AcrossFacetPackedV3 hard-codes depositor=msg.sender in non-packed entries, blocking speedUpV3Deposit for contract callers | medium | facets | AcrossFacetPackedV3 | fixed |
| LF-034 | AcrossFacetPackedV3 packed/min entrypoints lack zero-address, amount and timestamp validation, enabling fund loss on bad calldata | low | facets | AcrossFacetPackedV3 | acknowledged |
| LF-035 | Failed/partial swapData in ReceiverAcrossV3.handleV3AcrossMessage leaves dust trapped in the receiver contract | low | periphery | ReceiverAcrossV3 | acknowledged |
| LF-036 | ReceiverAcrossV3.handleV3AcrossMessage lacks nonReentrant modifier despite executing untrusted swap calldata | info | periphery | ReceiverAcrossV3 | acknowledged |
| LF-037 | outputAmountPercent on AcrossFacetV3 swap-and-bridge has no bounds, allowing inflated or zero output amounts | info | facets | AcrossFacetV3 | acknowledged |
| LF-038 | Griefing via frontrunning of callDiamondWithEIP2612Signature - attacker consumes user's permit signature before contract call | medium | periphery | Permit2Proxy | fixed |
| LF-039 | Missing min/max bounds for Gas.zip deposit amounts in GasZipFacet/GasZipPeriphery | low | cross-cutting | GasZipFacet, GasZipPeriphery | acknowledged |
| LF-040 | onlyRoleOrOpenRole exposes timelock-admin actions if role is granted to address(0) | low | security | LiFiTimelockController | fixed |
| LF-041 | Emergency unpause function bypasses timelock delay | info | security | LiFiTimelockController | acknowledged |
| LF-042 | GlacisFacet does not validate that GlacisData.refundAddress is non-zero, risking permanent loss of bridge refunds | low | facets | GlacisFacet | fixed |
| LF-043 | GlacisFacet does not verify msg.value covers nativeFee, allowing callers to drain native balance the diamond may hold | info | facets | GlacisFacet | acknowledged |
| LF-044 | GlacisFacet lacks noNativeAsset modifier, so native-asset bridges revert deep in the external call instead of failing fast with a clear error | info | facets | GlacisFacet | fixed |
| LF-045 | GlacisFacet.swapAndStartBridgeTokensViaGlacis does not assert the last swap's output asset equals the bridge's sendingAssetId | info | facets | GlacisFacet | acknowledged |
| LF-046 | Improper receiver address encoding for Bitcoin chain truncates non-EVM destination address | high | facets | ChainflipFacet | fixed |
| LF-047 | Permanent loss of funds when refund receiver cannot accept native ETH in catch branch | low | periphery | ReceiverChainflip | acknowledged |
| LF-048 | Destination-call message encoding assumes EVM SwapData when destination chain is non-EVM | low | facets | ChainflipFacet | acknowledged |
| LF-049 | MEV exposure when Velodrome V2 callback recipient can boost its own balance during the swap | low | periphery | LiFiDEXAggregator | acknowledged |
| LF-050 | Velodrome V2 callback flag accepts any non-zero byte instead of strict 1 | low | periphery | LiFiDEXAggregator | fixed |
| LF-051 | swapVelodromeV2 can be used to invoke arbitrary recipient hooks without sender validation | info | periphery | LiFiDEXAggregator | mitigated |
| LF-052 | swapVelodromeV2 missing zero-address validation for pool and recipient | info | periphery | LiFiDEXAggregator | fixed |
| LF-053 | depositAssets does not aggregate msg.value across multiple native-asset swaps, allowing the same ETH to be counted multiple times | medium | libraries | LibAsset | acknowledged |
| LF-054 | transferFromERC20 silently succeeds when called with the native asset placeholder address | medium | libraries | LibAsset | fixed |
| LF-055 | approveERC20 reverts on native asset instead of no-op, breaking the prior LibAsset contract | low | libraries | LibAsset | fixed |
| LF-056 | isContract is spoofable to true by EIP-7702 delegation to address(0) | low | libraries | LibAsset | fixed |
| LF-057 | isContract uses only keccak256("") as the empty-codehash sentinel, misclassifying never-interacted addresses | info | libraries | LibAsset | fixed |
| LF-058 | ReceiverStargateV2 does not verify lzCompose caller, enabling gas-griefing that forces fallback to source-token transfer | low | periphery | ReceiverStargateV2 | fixed |
| LF-059 | DexManagerFacet.batchAddDex can enter an infinite loop when a dex is already allowed | low | facets | DexManagerFacet | fixed |
| LF-060 | GasZipFacet's address-to-bytes32 conversion uses left-padding, breaking all bridges and silently directing funds to address(0) when caller compensates | low | facets | GasZipFacet | fixed |
| LF-061 | Permit2Proxy sets allowedCancelBeneficiarySrc=msg.sender on DeBridge orders, causing canceled-order refunds to land in the proxy instead of the user | low | periphery | Permit2Proxy, DeBridgeDlnFacet | fixed |
| LF-062 | Permit2Proxy catches only string Error reverts, leaving panic and custom-error reverts uncaught and exploitable for griefing | low | periphery | Permit2Proxy | fixed |
| LF-063 | CelerIMFacetBase assumes RelayerCelerIM has the same address across chains, but CREATE-opcode-driven address derivation differs on zkSync, sending bridged funds to a non-existent address | low | facets | CelerIMFacetBase, RelayerCelerIM | fixed |
| LF-064 | HopFacet forwards msg.value = minAmount + nativeFee, but Hop bridge requires value == amount, leaking nativeFee and double-charging ERC20 users | low | facets | HopFacet, HopFacetOptimized | fixed |
| LF-065 | swapAlgebra falls back from swapSupportingFeeOnInputTokens to swap() on any error, masking unrelated failures | low | periphery | LiFiDEXAggregator | fixed |
| LF-066 | swapAlgebra activates fee-on-transfer route on any non-zero flag value instead of strict equality with 1 | info | periphery | LiFiDEXAggregator | fixed |
| LF-067 | swapAlgebra does not sanity-check pool and recipient addresses decoded from the stream | info | periphery | LiFiDEXAggregator | fixed |
| LF-068 | GnosisBridgeFacet grants unlimited router approval every bridge call instead of approving exact amount | info | facets | GnosisBridgeFacet | acknowledged |
| LF-069 | swapAndStartBridgeTokensViaGnosisBridge does not assert final swap output token equals bridgeData.sendingAssetId | info | facets | GnosisBridgeFacet | fixed |
| LF-070 | LibAsset.isContract() classifies sub-23-byte contracts as EOAs | info | libraries | LibAsset | acknowledged |
| LF-071 | PioneerFacet does not sanity-check refundAddress | low | facets | PioneerFacet | fixed |
| LF-072 | PioneerFacet does not sanity-check transactionId | low | facets | PioneerFacet | fixed |
| LF-073 | swapAndStartBridgeTokensViaPioneer does not validate swap output equals bridging asset | info | facets | PioneerFacet | acknowledged |
| LF-074 | Unsafe uint256-to-uint128 cast of swap amount in swapIzumiV3 permanently locks excess funds | medium | periphery | LiFiDEXAggregator | fixed |
| LF-075 | swapIzumiV3 uses out-of-range tick boundaries (-80000/80000) instead of the valid -79999/79999 | low | periphery | LiFiDEXAggregator | fixed |
| LF-076 | Missing sanity check on withdrawMode in swapSyncSwap allows out-of-domain values | info | periphery | LiFiDEXAggregator | fixed |
| LF-077 | swapSyncSwap V2 branch missing explicit INTERNAL_INPUT_SOURCE handling that the V1 branch has | info | periphery | LiFiDEXAggregator | fixed |
| LF-078 | swapIzumiV3 forwards decoded pool/recipient from the stream without zero-address or sentinel checks | info | periphery | LiFiDEXAggregator | fixed |
| LF-079 | AllBridgeFacet does not cap _allBridgeData.fees, so any overpayment is permanently lost | low | facets | AllBridgeFacet | acknowledged |
| LF-080 | AllBridgeFacet bridges to non-EVM chains without emitting the BridgeToNonEVMChain event | info | facets | AllBridgeFacet | fixed |
| LF-081 | MayanFacet and DeBridgeDlnFacet constructors do not validate their address parameters | info | facets | MayanFacet, DeBridgeDlnFacet | fixed |
| LF-082 | Front-running of Patcher depositAndExecute functions lets a malicious caller steal approved tokens | high | periphery | Patcher | acknowledged |
| LF-083 | _getDynamicValue blindly casts arbitrary return-types to uint256, allowing malformed patches | medium | periphery | Patcher | fixed |
| LF-084 | Unlimited token approvals to unknown external targets in Patcher | info | periphery | Patcher | fixed |
| LF-085 | Patcher execution functions emit no events for off-chain tracking | info | periphery | Patcher | fixed |
| LF-086 | Patcher silently transfers caller's entire approved balance regardless of requested amount | info | periphery | Patcher | fixed |
| LF-087 | Patcher does not refund excess native/ERC20 sent or approved beyond what target consumes | info | periphery | Patcher | fixed |
| LF-088 | MayanFacet decodes the trader address as final receiver for Hypercore deposit/fastDeposit selectors instead of the receiver embedded in depositPayload | medium | facets | MayanFacet | fixed |
| LF-089 | BridgeData receiver and destinationChain are emitted but not enforced by RelayDepositoryFacet, weakening event-based off-chain accounting | info | facets | RelayDepositoryFacet | acknowledged |
| LF-090 | RelayDepositoryFacet may forward more than the off-chain order specifies, relying on Relay solver to refund the difference | info | facets | RelayDepositoryFacet | acknowledged |
| LF-091 | Lossy decode for non-EVM receiver address in AcrossFacetPackedV4 decoders | low | facets | AcrossFacetPackedV4 | fixed |
| LF-092 | Missing zero-check for derived outputAmount after multiplier scaling in AcrossFacetV4 | low | facets | AcrossFacetV4 | acknowledged |
| LF-093 | Missing non-zero validation for refundAddress passed to Across spoke pool | low | facets | AcrossFacetV4 | fixed |
| LF-094 | Owner can execute arbitrary external calls via executeCallAndWithdraw on AcrossFacetPackedV4 | info | facets | AcrossFacetPackedV4 | acknowledged |
| LF-095 | Possible burn to zero address in ReceiverAcrossV4 swap-failure fallback | info | periphery | ReceiverAcrossV4 | acknowledged |
| LF-096 | Incorrect calldata length validation in decode_startBridgeTokensViaAcrossV4NativePacked | info | facets | AcrossFacetPackedV4 | fixed |
| LF-097 | Missing BridgeToNonEVMChain event when bridging to non-EVM destinations | info | facets | GardenFacet | fixed |
| LF-098 | Destination receiver address reused as source-chain refund initiator can be stolen on source | medium | facets | GardenFacet | fixed |
| LF-099 | EcoFacet accepts NON_EVM_ADDRESS receiver for non-Solana EVM chains without rejection | low | facets | EcoFacet | fixed |
| LF-100 | Excess native tokens sent to EcoFacet bridging functions are permanently locked | low | facets | EcoFacet | fixed |
| LF-101 | Solana receiver length lower-bound validation missing | low | facets | EcoFacet | fixed |
| LF-102 | BridgeToNonEVMChain event emitted on EVM destinations when nonEVMReceiver is non-empty | low | facets | EcoFacet | fixed |
| LF-103 | _buildReward() does not validate prover address or rewardDeadline | info | facets | EcoFacet | fixed |
| LF-104 | UnitFacet unconditionally trusts the backend-signed depositAddress with no on-chain verification of its association with the Unit Protocol | low | facets | UnitFacet | acknowledged |
| LF-105 | UnitFacet.swapAndStartBridgeTokensViaUnit does not verify that the post-swap token is native ETH before calling transferNativeAsset | low | facets | UnitFacet | acknowledged |
| LF-106 | UnitFacet verifies backend signature against pre-swap minAmount but bridges the post-swap minAmount, weakening the signed authorization | low | facets | UnitFacet | acknowledged |
| LF-107 | UnitFacet._startBridge enforces minimum amounts only on Ethereum and Plasma, silently accepting dust transfers on every other chain | info | facets | UnitFacet | fixed |
| LF-108 | UnitFacet checks the signature deadline after executing the signature-recovery work, wasting gas and surfacing failures late | info | facets | UnitFacet | fixed |
| LF-109 | UnitFacet has no replay protection on backend signatures; the same signed message can be reused before deadline | info | facets | UnitFacet | fixed |
| LF-110 | Positive swap slippage in EcoFacet pre-bridge swap is silently captured by the solver instead of the user | info | facets | EcoFacet | fixed |
| LF-111 | Duplicate intent funding in EcoFacet traps user funds and lets attacker sweep them via swap leftovers refund | medium | facets | EcoFacet | fixed |
| LF-112 | Eco intent refund on expiry sent to msg.sender (Permit2Proxy/integrator) instead of the real user, losing funds | medium | facets | EcoFacet | fixed |
| LF-113 | Migration input list of selectors-to-remove can be incomplete, leaving stale whitelisted selectors after migration | info | facets | WhitelistManagerFacet | mitigated |
| LF-114 | Whitelisting contracts and selectors in separate mappings allows any cross-combination to be permitted | low | libraries | LibAllowList, WhitelistManagerFacet | mitigated |
| LF-115 | Selector cleared from index but left true in allow-list mapping becomes permanently un-removable after migration | low | facets | WhitelistManagerFacet, LibAllowList | fixed |
| LF-116 | Unbounded contracts/selectors arrays in LibAllowList getters can exceed block gas and break whitelist visibility | info | libraries | LibAllowList, WhitelistManagerFacet | acknowledged |
| LF-117 | WhitelistManagerFacet v1->v2 migration lacks coverage that legacy state is fully cleared, risking corrupted state and data loss | info | facets | WhitelistManagerFacet, LibAllowList | fixed |
| LF-118 | LiFiIntentEscrowFacet emits LiFiTransferStarted with hasDestinationCall=false even when OIF outputCall executes calldata on the destination | low | facets | LiFiIntentEscrowFacet | fixed |
| LF-119 | LiFiIntentEscrowFacet does not validate outputAmount, letting a solver settle with zero tokens and steal the entire deposit | low | facets | LiFiIntentEscrowFacet | fixed |
| LF-120 | LiFiIntentEscrowFacet does not validate depositAndRefundAddress, risking refund loss on a zero address | low | facets | LiFiIntentEscrowFacet | fixed |
| LF-121 | LiFiIntentEscrowFacet does not handle non-EVM destinations; bridging to Solana/Bitcoin reverts or loses funds | info | facets | LiFiIntentEscrowFacet | acknowledged |
| LF-122 | LiFiIntentEscrowFacet does not validate MandateOutput's outputOracle and outputSettler, allowing zero values that yield unexpected refunds or behavior | info | facets | LiFiIntentEscrowFacet | raised |
| LF-123 | LiFiIntentEscrowFacet grants unbounded ERC20 allowance to the OIF settler via maxApproveERC20 | info | facets | LiFiIntentEscrowFacet | acknowledged |
| LF-124 | swapAndStartBridgeTokensViaPolymerCCTP missing validation that final swap output is USDC | info | facets | PolymerCCTPFacet | acknowledged |
| LF-125 | Insufficient bridgeAmount validation can underflow or trigger zero-amount bridging | info | facets | PolymerCCTPFacet | acknowledged |
| LF-126 | Testnet chain IDs mapped to mainnet CCTP domains, mis-routing testnet inputs to mainnet | info | facets | PolymerCCTPFacet | fixed |
| LF-127 | MegaETH bridge accepts unvalidated assetIdOnL2, allowing zero-address L2 token to reach depositERC20To | info | facets | MegaETHBridgeFacet | fixed |
| LF-128 | ReceiverOIF.outputFilled decodes a receiver from executionData without zero-address validation | low | periphery | ReceiverOIF | fixed |
| LF-129 | ReceiverOIF has no slippage protection; users must embed minOut inside the swap calldata | info | periphery | ReceiverOIF | acknowledged |
| LF-130 | ReceiverOIF leaves residual ERC20 approval to the Executor after each swap completes | info | periphery | ReceiverOIF | acknowledged |
| LF-131 | Fee-on-transfer tokens permanently burn the NEAR Intents quote ID while underfunding the bridge | info | facets | NEARIntentsFacet | fixed |
| LF-132 | Inconsistent refund recipient: positive slippage goes to depositAndRefundAddress but excess native ETH and swap leftovers go to msg.sender | low | facets | LiFiIntentEscrowFacet | fixed |
| LF-133 | Misleading InvalidReceiver error used for zero depositAndRefundAddress validation | info | facets | LiFiIntentEscrowFacet | fixed |
| LF-134 | Polymer CCTP non-EVM path validates nonEVMReceiver but not solanaReceiverATA, leaving inconsistent zero-receiver coverage | info | facets | PolymerCCTPFacet | fixed |
| LF-135 | Incorrect LayerZero endpoint IDs for XDC and Plume in AcrossV4SwapFacet._chainIdToLzEid | high | facets | AcrossV4SwapFacet | fixed |
| LF-136 | Router calldata not adjusted in SpokePoolPeriphery positive-slippage path creates inconsistent SwapAndDepositData | medium | facets | AcrossV4SwapFacet | fixed |
| LF-137 | Linear scaling of outputAmount on positive slippage may exceed relayer-fillable bounds | medium | facets | AcrossV4SwapFacet | acknowledged |
| LF-138 | Backend EIP-712 signature verification skipped for sponsored OFT/CCTP paths in AcrossV4SwapFacet | low | facets | AcrossV4SwapFacet | acknowledged |
| LF-139 | Full msg.value forwarded to sponsored OFT deposit can exceed available balance after native source swap | low | facets | AcrossV4SwapFacet | fixed |
| LF-140 | Native asset inputToken/swapToken not validated against WRAPPED_NATIVE in AcrossV4SwapFacet signature-gated paths | low | facets | AcrossV4SwapFacet | fixed |
| LF-141 | Positive-slippage refund executes before input validation in sponsored OFT and CCTP paths | low | facets | AcrossV4SwapFacet | fixed |
| LF-142 | Missing refundRecipient != address(0) validation in CCTP sponsored path | low | facets | AcrossV4SwapFacet | fixed |
| LF-143 | hasDestinationCall flag always false even when forwarded Across calldata contains a destination message | info | facets | AcrossV4SwapFacet | acknowledged |
| LF-144 | Missing validation of orderAuthorityDst strands DLN cancel/refund flow | low | facets | DeBridgeDlnFacet | fixed |
| LF-145 | givePatchAuthoritySrc = msg.sender assigns DLN patch authority to Permit2Proxy on permit flows | low | facets | DeBridgeDlnFacet | acknowledged |
| LF-146 | wrapStETHToWstETH and unwrapWstETHToStETH lack a minimum-amount-out slippage parameter | info | periphery | LidoWrapper | acknowledged |
| LF-147 | validateBridgeDataLiFiIntentEscrow modifier omits zero-check on destinationChainId, allowing zero/uninitialized destination | info | facets | LiFiIntentEscrowFacet | acknowledged |
