#!/bin/bash
#
# universalCast helpers: call, send, sendRaw, sendValue, code for Tron and EVM.
# Must be sourced after helperFunctions.sh (or after isTronNetwork, getTronEnv, getRPCUrl,
# getPrivateKey, and sendOrPropose are defined). Do not run standalone.

# universalCall: Read-only contract calls for both Tron and EVM networks.
# Abstracts the Tron vs EVM differentiation using isTronNetwork/getTronEnv helpers.
#
# Usage: universalCall NETWORK TARGET SIGNATURE [ARGS...]
#   NETWORK   - Network name (e.g., "arbitrum", "tron", "tronshasta")
#   TARGET    - Target contract address
#   SIGNATURE - Function signature with return type (e.g., "balanceOf(address) returns (uint256)")
#   ARGS      - Optional: Function arguments (variadic)
#
# Routing:
#   - Tron: Uses troncast call with --env
#   - EVM: Uses cast call with --rpc-url
#
# Returns: Output from cast/troncast call, exit code preserved
# Example: universalCall "arbitrum" "$DIAMOND" "owner() returns (address)"
# Example: universalCall "tron" "$DIAMOND" "facetAddress(bytes4) returns (address)" "0x12345678"
function universalCall() {
  local NETWORK="$1"
  local TARGET="$2"
  local SIGNATURE="$3"
  shift 3
  local ARGS=("$@")

  if [[ -z "$NETWORK" || -z "$TARGET" || -z "$SIGNATURE" ]]; then
    echo "Error: universalCall requires network, target, and signature" >&2
    return 1
  fi

  local OUTPUT
  local EXIT_CODE

  if isTronNetwork "$NETWORK"; then
    local TRON_ENV
    TRON_ENV=$(getTronEnv "$NETWORK")
    if [[ ${#ARGS[@]} -gt 0 ]]; then
      OUTPUT=$(bun troncast call "$TARGET" "$SIGNATURE" "${ARGS[@]}" --env "$TRON_ENV" 2>&1)
    else
      OUTPUT=$(bun troncast call "$TARGET" "$SIGNATURE" --env "$TRON_ENV" 2>&1)
    fi
    EXIT_CODE=$?
  else
    local RPC_URL
    RPC_URL=$(getRPCUrl "$NETWORK") || {
      echo "Error: Failed to get RPC URL for $NETWORK" >&2
      return 1
    }
    if [[ ${#ARGS[@]} -gt 0 ]]; then
      OUTPUT=$(cast call "$TARGET" "$SIGNATURE" "${ARGS[@]}" --rpc-url "$RPC_URL" 2>&1)
    else
      OUTPUT=$(cast call "$TARGET" "$SIGNATURE" --rpc-url "$RPC_URL" 2>&1)
    fi
    EXIT_CODE=$?
  fi

  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "$OUTPUT" >&2
    return 1
  fi
  printf '%s' "$OUTPUT"
  return 0
}

# universalSend: State-changing transactions for both Tron and EVM networks.
# Generates calldata using `cast calldata` and delegates to sendOrPropose for all
# network/environment routing (Tron vs EVM, staging vs production).
#
# Usage: universalSend NETWORK ENVIRONMENT TARGET SIGNATURE [ARGS] [TIMELOCK] [PRIVATE_KEY_OVERRIDE]
#   NETWORK     - Network name (e.g., "arbitrum", "tron", "tronshasta")
#   ENVIRONMENT - "production" or "staging"
#   TARGET      - Contract address to call
#   SIGNATURE   - Function signature (e.g., "transfer(address,uint256)")
#   ARGS        - Optional: Arguments for cast calldata (space-separated, arrays in brackets)
#   TIMELOCK    - Optional: "true" to wrap in timelock (EVM production only)
#   PRIVATE_KEY_OVERRIDE - Optional: hex key; when set, use instead of getPrivateKey(network, environment)
#
# Routing (handled by sendOrPropose):
#   - Tron (any env): Direct send via troncast (no Safe/timelock support)
#   - EVM production: Propose to Safe via propose-to-safe.ts (optional timelock)
#   - EVM staging: Direct send via cast
#
# Example: universalSend "arbitrum" "staging" "$DIAMOND" "setFee(uint256)" "100"
# Example: universalSend "arbitrum" "production" "$DIAMOND" "batchSet(address[],bytes4[],bool)" '[addr1,addr2] [0x1234] true' "true"
# Example: universalSend "mainnet" "production" "$DIAMOND" "pauseDiamond()" "" "" "$PRIVATE_KEY_PAUSER_WALLET"
function universalSend() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local TARGET="$3"
  local SIGNATURE="$4"
  local ARGS="$5"
  local TIMELOCK="${6:-false}"
  local PRIVATE_KEY_OVERRIDE="${7:-}"

  if [[ -z "$NETWORK" || -z "$ENVIRONMENT" || -z "$TARGET" || -z "$SIGNATURE" ]]; then
    echo "Error: universalSend requires network, environment, target, and signature" >&2
    return 1
  fi

  # Generate calldata from signature and args
  local CALLDATA
  if [[ -n "$ARGS" ]]; then
    CALLDATA=$(cast calldata "$SIGNATURE" $ARGS 2>&1)
  else
    CALLDATA=$(cast calldata "$SIGNATURE" 2>&1)
  fi
  local CALLDATA_EXIT_CODE=$?

  if [[ $CALLDATA_EXIT_CODE -ne 0 || ! "$CALLDATA" =~ ^0x ]]; then
    echo "Error: Failed to generate calldata for $SIGNATURE" >&2
    echo "Args: $ARGS" >&2
    echo "Output: $CALLDATA" >&2
    return 1
  fi

  # Delegate to sendOrPropose for all network/environment routing
  sendOrPropose "$NETWORK" "$ENVIRONMENT" "$TARGET" "$CALLDATA" "$TIMELOCK" "$PRIVATE_KEY_OVERRIDE"
  return $?
}

# universalSendRaw: Direct send with pre-built calldata (Tron or EVM). Used by sendOrPropose
# for Tron (any env) and EVM staging. Does not handle EVM production Safe proposal.
#
# Usage: universalSendRaw NETWORK ENVIRONMENT TARGET CALLDATA [PRIVATE_KEY_OVERRIDE]
#   NETWORK     - Network name (e.g., "arbitrum", "tron")
#   ENVIRONMENT - "production" or "staging" (for getPrivateKey when override not set)
#   TARGET      - Contract address to call
#   CALLDATA    - Hex calldata (must start with 0x)
#   PRIVATE_KEY_OVERRIDE - Optional: hex key; when set, use instead of getPrivateKey(network, environment)
#
# Returns: Exit code of troncast send / cast send
function universalSendRaw() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local TARGET="$3"
  local CALLDATA="$4"
  local PRIVATE_KEY_OVERRIDE="${5:-}"

  if [[ -z "$NETWORK" || -z "$ENVIRONMENT" || -z "$TARGET" || -z "$CALLDATA" ]]; then
    echo "Error: universalSendRaw requires network, environment, target, and calldata" >&2
    return 1
  fi
  if [[ ! "$CALLDATA" =~ ^0x ]]; then
    echo "Error: universalSendRaw calldata must start with 0x" >&2
    return 1
  fi

  if [[ -n "$PRIVATE_KEY_OVERRIDE" ]]; then
    PRIVATE_KEY="$PRIVATE_KEY_OVERRIDE"
  else
    PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") || {
      echo "Error: universalSendRaw failed to get private key for $NETWORK and $ENVIRONMENT" >&2
      return 1
    }
  fi

  if isTronNetwork "$NETWORK"; then
    local TRON_ENV
    TRON_ENV=$(getTronEnv "$NETWORK")
    bun troncast send "$TARGET" "" --calldata "$CALLDATA" --env "$TRON_ENV" --private-key "$PRIVATE_KEY" --confirm
    return $?
  fi

  # EVM: cast send with raw calldata
  local RPC_URL
  RPC_URL=$(getRPCUrl "$NETWORK") || {
    echo "Error: universalSendRaw failed to get RPC URL for $NETWORK" >&2
    return 1
  }
  # Use GAS_ESTIMATE_MULTIPLIER (default 100 from .env) so gas price stays above base fee on L2s
  local MULTIPLIER="${GAS_ESTIMATE_MULTIPLIER:-100}"
  local GAS_PRICE
  GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
  local GAS_PRICE_BUF=$(( GAS_PRICE * MULTIPLIER / 100 ))
  [[ "$GAS_PRICE_BUF" -lt 1 ]] && GAS_PRICE_BUF=1
  cast send "$TARGET" "$CALLDATA" \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --legacy \
    --gas-price "$GAS_PRICE_BUF" \
    --confirmations 1
  return $?
}

# universalSendValue: Send native token (ETH/TRX) to an address. For EVM value is in wei; for Tron
# value is converted from wei to sun (1e18 wei = 1 ether, 1e6 sun = 1 TRX; conversion: sun = wei/1e12).
#
# Usage: universalSendValue NETWORK ENVIRONMENT TARGET VALUE_WEI [PRIVATE_KEY_OVERRIDE]
#   NETWORK     - Network name (e.g., "arbitrum", "tron")
#   ENVIRONMENT - "production" or "staging"
#   TARGET      - Recipient address (hex for EVM, base58 for Tron)
#   VALUE_WEI   - Amount in wei (EVM); for Tron converted to sun internally
#   PRIVATE_KEY_OVERRIDE - Optional: hex key; when set, use instead of getPrivateKey(network, environment)
#
# Returns: Exit code of troncast send / cast send
function universalSendValue() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local TARGET="$3"
  local VALUE_WEI="$4"
  local PRIVATE_KEY_OVERRIDE="${5:-}"

  if [[ -z "$NETWORK" || -z "$ENVIRONMENT" || -z "$TARGET" || -z "$VALUE_WEI" ]]; then
    echo "Error: universalSendValue requires network, environment, target, and value_wei" >&2
    return 1
  fi

  if [[ -n "$PRIVATE_KEY_OVERRIDE" ]]; then
    PRIVATE_KEY="$PRIVATE_KEY_OVERRIDE"
  else
    PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") || {
      echo "Error: universalSendValue failed to get private key for $NETWORK and $ENVIRONMENT" >&2
      return 1
    }
  fi

  if isTronNetwork "$NETWORK"; then
    local TRON_ENV
    TRON_ENV=$(getTronEnv "$NETWORK")
    # Convert wei to sun: 1e18 wei = 1 ether, 1e6 sun = 1 TRX; sun = wei / 1e12
    local VALUE_SUN
    VALUE_SUN=$(echo "$VALUE_WEI / 1000000000000" | bc 2>/dev/null || echo "0")
    if [[ -z "$VALUE_SUN" || "$VALUE_SUN" -le 0 ]]; then
      echo "Error: universalSendValue invalid or zero value_wei for Tron: $VALUE_WEI" >&2
      return 1
    fi
    bun troncast send "$TARGET" "" --value "${VALUE_SUN}sun" --env "$TRON_ENV" --private-key "$PRIVATE_KEY" --confirm
    return $?
  fi

  # EVM: cast send with --value (wei)
  local RPC_URL
  RPC_URL=$(getRPCUrl "$NETWORK") || {
    echo "Error: universalSendValue failed to get RPC URL for $NETWORK" >&2
    return 1
  }
  # Use GAS_ESTIMATE_MULTIPLIER (default 100 from .env) so gas price stays above base fee on L2s
  local MULTIPLIER="${GAS_ESTIMATE_MULTIPLIER:-100}"
  local GAS_PRICE
  GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
  local GAS_PRICE_BUF=$(( GAS_PRICE * MULTIPLIER / 100 ))
  [[ "$GAS_PRICE_BUF" -lt 1 ]] && GAS_PRICE_BUF=1
  cast send "$TARGET" --value "$VALUE_WEI" \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --legacy \
    --gas-price "$GAS_PRICE_BUF"
  return $?
}

# universalCode: Get bytecode at address for both Tron and EVM networks.
#
# Usage: universalCode NETWORK ADDRESS
#   NETWORK  - Network name (e.g., "arbitrum", "tron", "tronshasta")
#   ADDRESS  - Contract address (base58 for Tron, hex for EVM)
#
# Routing:
#   - Tron: troncast code with --env (address as-is)
#   - EVM: cast code with --rpc-url (checksum address)
#
# Returns: Bytecode on stdout, exit code preserved. Callers may use "|| echo \"0x\"" for default.
# Example: CODE=$(universalCode "$NETWORK" "$ADDRESS" 2>/dev/null || echo "0x")
function universalCode() {
  local NETWORK="${1:-}"
  local ADDRESS="${2:-}"

  if [[ -z "$NETWORK" || -z "$ADDRESS" ]]; then
    echo "Error: universalCode requires network and address" >&2
    return 1
  fi

  if isTronNetwork "$NETWORK"; then
    local TRON_ENV
    TRON_ENV=$(getTronEnv "$NETWORK")
    bun troncast code "$ADDRESS" --env "$TRON_ENV" 2>&1
  else
    local RPC_URL
    RPC_URL=$(getRPCUrl "$NETWORK") || {
      echo "Error: Failed to get RPC URL for $NETWORK" >&2
      return 1
    }
    local CHECKSUMMED
    CHECKSUMMED=$(cast to-check-sum-address "$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')" 2>/dev/null)
    if [[ -z "$CHECKSUMMED" ]]; then
      echo "Error: Invalid EVM address for universalCode: $ADDRESS" >&2
      return 1
    fi
    cast code "$CHECKSUMMED" --rpc-url "$RPC_URL" 2>&1
  fi
  return $?
}

# universalCast: Dispatcher for cast-like operations (call, send, sendRaw, sendValue, code). Routes to
# universalCall, universalSend, universalSendRaw, universalSendValue, or universalCode so network handling stays in one place.
#
# Usage: universalCast ACTION NETWORK [rest...]
#   ACTION   - "call" | "send" | "sendRaw" | "sendValue" | "code"
#   NETWORK  - Network name
#   rest     - Action-specific args (see universalCall, universalSend, universalSendRaw, universalSendValue, universalCode)
#
# Examples:
#   universalCast "call" NETWORK TARGET SIGNATURE [ARGS...]
#   universalCast "send" NETWORK ENVIRONMENT TARGET SIGNATURE [ARGS] [TIMELOCK] [PRIVATE_KEY_OVERRIDE]
#   universalCast "sendRaw" NETWORK ENVIRONMENT TARGET CALLDATA [PRIVATE_KEY_OVERRIDE]
#   universalCast "sendValue" NETWORK ENVIRONMENT TARGET VALUE_WEI [PRIVATE_KEY_OVERRIDE]
#   universalCast "code" NETWORK ADDRESS
#
# Returns: Exit code of the underlying helper.
# Dispatches to universal<Action> (e.g. universalCall, universalSend). Add new actions by
# defining a function universal<Action>; no need to touch universalCast.
function universalCast() {
  local ACTION="${1-}"
  shift || true

  if [[ -z "$ACTION" ]]; then
    echo "Error: universalCast requires ACTION" >&2
    return 1
  fi

  # Safety: allow only simple identifiers (no spaces, no $(), no ``, etc.)
  if [[ ! "$ACTION" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    echo "Error: invalid action name: $ACTION" >&2
    return 1
  fi

  # Build target function name: universal<Action> (portable first-char uppercase)
  local FIRST="${ACTION:0:1}"
  local REST="${ACTION:1}"
  local TARGET_FUNC="universal$(echo "$FIRST" | tr '[:lower:]' '[:upper:]')$REST"

  if ! declare -F "$TARGET_FUNC" >/dev/null; then
    echo "Error: unknown action: $ACTION (no function $TARGET_FUNC)" >&2
    return 1
  fi

  "$TARGET_FUNC" "$@"
}

# universalCastWithRetries: Same as universalCast but for "call" retries on retryable RPC errors (429, rate limit, max retries).
# Use for read-only calls where transient RPC failures should be retried.
#
# Usage: universalCastWithRetries ACTION NETWORK [rest...]  (same as universalCast)
#   For ACTION "call": retries up to RPC_CALL_MAX_RETRIES (default 3) with RPC_CALL_RETRY_DELAY_SEC (default 5) between attempts.
#   Other actions: forwards to universalCast once (no retry).
#
# Returns: Same as universalCall on success (value on stdout, 0); on failure after retries: nothing on stdout, error on stderr, 1.
function universalCastWithRetries() {
  local ACTION="${1-}"
  if [[ -z "$ACTION" ]]; then
    echo "Error: universalCastWithRetries requires ACTION" >&2
    return 1
  fi

  if [[ "$ACTION" != "call" ]]; then
    universalCast "$@"
    return $?
  fi

  shift || true
  local NETWORK="${1-}"
  local TARGET="${2-}"
  local SIGNATURE="${3-}"
  shift 3 || true
  local ARGS=("$@")

  if [[ -z "$NETWORK" || -z "$TARGET" || -z "$SIGNATURE" ]]; then
    echo "Error: universalCastWithRetries call requires NETWORK, TARGET, SIGNATURE" >&2
    return 1
  fi

  local MAX_RETRIES="${RPC_CALL_MAX_RETRIES:-0}"
  local RETRY_DELAY="${RPC_CALL_RETRY_DELAY_SEC:-0}"
  local ERR_FILE
  ERR_FILE=$(mktemp)

  local ATTEMPT=1
  local OUT
  local EXIT
  local ERR_MSG

  while [[ $ATTEMPT -le $MAX_RETRIES ]]; do
    [[ "${DEBUG:-}" == "true" ]] && echo "[universalCastWithRetries] attempt $ATTEMPT/$MAX_RETRIES" >&2
    OUT=$(universalCall "$NETWORK" "$TARGET" "$SIGNATURE" "${ARGS[@]}" 2> "$ERR_FILE")
    EXIT=$?
    if [[ $EXIT -eq 0 ]]; then
      rm -f "$ERR_FILE"
      printf '%s' "$OUT"
      return 0
    fi
    ERR_MSG=$(cat "$ERR_FILE" 2>/dev/null)
    if [[ "$ERR_MSG" != *"429"* && "$ERR_MSG" != *"rate limit"* && "$ERR_MSG" != *"Max retries"* && "$ERR_MSG" != *"retries exceeded"* ]]; then
      echo "$ERR_MSG" >&2
      rm -f "$ERR_FILE"
      return 1
    fi
    if [[ $ATTEMPT -eq $MAX_RETRIES ]]; then
      echo "$ERR_MSG" >&2
      rm -f "$ERR_FILE"
      return 1
    fi
    sleep "$RETRY_DELAY"
    ATTEMPT=$((ATTEMPT + 1))
  done

  rm -f "$ERR_FILE"
  return 1
}