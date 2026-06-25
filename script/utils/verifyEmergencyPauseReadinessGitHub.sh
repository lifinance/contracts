#!/bin/bash

# this script is designed to be called by a Github action ("Verify Emergency Pause Readiness")
# it is the READ-ONLY companion to the break-glass pause script
# (script/emergency/emergencyPauseBreakGlass.sh): it verifies that the emergency pause CAN fire
# on every production diamond, WITHOUT firing it.
#
# Checks:
#   Secret check (offline, fail-fast): the address derived from PRIVATE_KEY_PAUSER_WALLET matches
#                      the configured pauser in config/global.json (EVM hex + Tron base58).
#   Pauser check (on-chain, per production LiFiDiamond): the registered pauserWallet() equals
#                      that derived address, read via the real `universalCast "call"`.
#   Governance check (on-chain, per Safe/timelock-governed diamond — the UNPAUSE path): the
#                      LiFiTimelockController's diamond() points at the production diamond,
#                      and the Safe holds TIMELOCK_ADMIN_ROLE. Skipped on testnets (EOA-owned).
#
# It performs NO transactions (no pause / unpause / send). A non-zero exit means the
# emergency pause/unpause would not work as configured and must be investigated.


# load helper functions (also sources script/universalCast.sh)
source ./script/helperFunctions.sh

# ---------------------------------------------------------------------------------------
# INTENTIONAL DUPLICATION — mirrors the frozen break-glass pause script
# ---------------------------------------------------------------------------------------
# rpcCallWithRetry + the RPC pacing constants below, and the per-network read+compare in
# verifyPauserOnNetwork(), are duplicated near-verbatim from the break-glass pause script
# (script/emergency/emergencyPauseBreakGlass.sh).
#
# Why duplicated and not shared: the break-glass script is incident-critical and deliberately
# FROZEN/ISOLATED — it must not source the shared library, so there is intentionally no shared
# helper to consolidate into. This read-only companion keeps
# its own copy on purpose; a divergence here is not catastrophic (it only mis-reports readiness),
# whereas coupling the pause path to shared code is exactly the EXSC-367 risk we removed. When
# the break-glass read/compare logic changes, mirror it here too.
# ---------------------------------------------------------------------------------------

# RPC pacing for read calls. RPCs can throttle reads under load (paid tiers included),
# so we pace and retry transient failures before failing hard.
RPC_MAX_ATTEMPTS=5
RPC_RETRY_SLEEP_SECONDS=3
RPC_CALL_DELAY_SECONDS=1

# The role gating LiFiTimelockController.unpauseDiamond(). Derived at runtime via
# keccak256("TIMELOCK_ADMIN_ROLE") so it reads as a role hash rather than a magic 32-byte
# literal (which also trips secret scanners as a false-positive "private key").
TIMELOCK_ADMIN_ROLE="$(cast keccak "TIMELOCK_ADMIN_ROLE")"

# rpcCallWithRetry: Run an RPC-touching command up to $RPC_MAX_ATTEMPTS times with
# $RPC_RETRY_SLEEP_SECONDS between failures. Captures stdout cleanly so callers
# get clean values back (no stderr mixed in), while stderr is preserved in a
# temp file and surfaced in retry logs / the final failure message. Returns 0
# on first success, 1 if exhausted.
# Usage: VAR=$(rpcCallWithRetry "label" cast balance "$ADDR" --rpc-url "$RPC")
function rpcCallWithRetry() {
  local LABEL="$1"
  shift
  local ATTEMPT=1
  local OUT=""
  local ERR_FILE
  ERR_FILE=$(mktemp)
  while [ "$ATTEMPT" -le "$RPC_MAX_ATTEMPTS" ]; do
    if OUT=$("$@" 2>"$ERR_FILE"); then
      rm -f "$ERR_FILE"
      printf "%s" "$OUT"
      return 0
    fi
    if [ "$ATTEMPT" -lt "$RPC_MAX_ATTEMPTS" ]; then
      echo "[retry] $LABEL attempt $ATTEMPT failed ($(< "$ERR_FILE")), sleeping ${RPC_RETRY_SLEEP_SECONDS}s..." >&2
      sleep "$RPC_RETRY_SLEEP_SECONDS"
    fi
    ATTEMPT=$((ATTEMPT + 1))
  done
  # On exhaustion, surface diagnostic context to the caller. Prefer stderr
  # (cleaner), but fall back to stdout when stderr was empty - some wrapped
  # helpers (e.g. universalCall) merge cast's stderr into stdout via 2>&1
  # internally, so the revert reason / RPC error ends up in OUT, not ERR_FILE.
  local LAST_ERR
  LAST_ERR=$(< "$ERR_FILE")
  rm -f "$ERR_FILE"
  printf "%s" "${LAST_ERR:-$OUT}"
  return 1
}

# evmToTronBase58: encode a 20-byte EVM hex address as a Tron base58check (T...) address.
# Tron payload = 0x41 || 20-byte address; checksum = first 4 bytes of sha256(sha256(payload)).
# Uses only coreutils / openssl / bc (no npm/TS dependency). A 0x41-prefixed payload has no
# leading zero bytes, so no leading-'1' padding is needed. Used by the offline secret check
# to compare the derived key against config tronWallets.pauserWallet.
#
# Usage: TRON_ADDR=$(evmToTronBase58 "0xd387...")
function evmToTronBase58() {
  local ADDR_HEX="${1#0x}"
  ADDR_HEX="$(echo "$ADDR_HEX" | tr 'A-F' 'a-f')"
  local PAYLOAD_HEX="41${ADDR_HEX}"
  local CHECKSUM_HEX
  CHECKSUM_HEX="$(printf '%s' "$PAYLOAD_HEX" | xxd -r -p \
    | openssl dgst -sha256 -binary | openssl dgst -sha256 -binary \
    | xxd -p | tr -d '\n' | cut -c1-8)"
  local ALPHABET="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  local DEC
  DEC="$(echo "ibase=16; $(echo "${PAYLOAD_HEX}${CHECKSUM_HEX}" | tr 'a-f' 'A-F')" | bc)"
  local OUT=""
  local REM
  while [[ "$DEC" != "0" ]]; do
    REM="$(echo "$DEC % 58" | bc)"
    OUT="${ALPHABET:$REM:1}${OUT}"
    DEC="$(echo "$DEC / 58" | bc)"
  done
  printf "%s" "$OUT"
}

# addressesMatch: compare two addresses that are already in the SAME network's native form.
# Tron base58 is case-SENSITIVE, so compare it verbatim; EVM 0x-hex casing is cosmetic (EIP-55),
# so compare it case-insensitively. Both arguments must be the same representation (both base58
# on Tron, both hex on EVM) — this does no cross-encoding.
#
# Usage: addressesMatch NETWORK ADDR_A ADDR_B
# Returns: 0 if equal, 1 otherwise.
function addressesMatch() {
  local NETWORK="$1"
  local ADDR_A="$2"
  local ADDR_B="$3"
  if isTronNetwork "$NETWORK"; then
    [[ "$ADDR_A" == "$ADDR_B" ]]
  else
    [[ "$(echo "$ADDR_A" | tr '[:upper:]' '[:lower:]')" == "$(echo "$ADDR_B" | tr '[:upper:]' '[:lower:]')" ]]
  fi
}

# verifyPauserOnNetwork: pauser check — read the on-chain pauserWallet() of a network's
# production LiFiDiamond and assert it equals the derived pauser address. Read-only.
# Mirrors the break-glass script's comparison exactly (lowercase string compare),
# which also handles Tron's address form the same proven way the live pause does.
#
# Usage: verifyPauserOnNetwork NETWORK EXPECTED_PAUSER_ADDRESS
# Returns: 0 on match; 1 on missing diamond / missing EmergencyPauseFacet (call reverts) /
#          RPC exhausted / address mismatch.
function verifyPauserOnNetwork() {
  local NETWORK="$1"
  local EXPECTED_PAUSER="$2"

  # A network with no production LiFiDiamond is simply not in scope ("verify every
  # production diamond" — there isn't one here), so skip with a visible notice rather
  # than failing. networks.json lists more networks (e.g. tronshasta) than have a prod
  # deployment; treating "not deployed" as a failure would be a permanent false alarm.
  local DIAMOND_ADDRESS
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond")
  if [[ $? -ne 0 || -z "$DIAMOND_ADDRESS" ]]; then
    echo "skipping $NETWORK (no production LiFiDiamond in deploy log)"
    return 0
  fi

  # read on-chain registered pauser (retry transient RPC throttling, then fail hard).
  # A missing EmergencyPauseFacet makes pauserWallet() revert, which exhausts retries
  # and is reported as a failure - per design, every prod diamond must have the facet.
  sleep "$RPC_CALL_DELAY_SECONDS"
  local DIAMOND_PAUSER_WALLET
  if ! DIAMOND_PAUSER_WALLET=$(rpcCallWithRetry "[$NETWORK] pauserWallet()" universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "pauserWallet() returns (address)"); then
    error "[network: $NETWORK] failed to read pauserWallet() after $RPC_MAX_ATTEMPTS attempts (missing EmergencyPauseFacet or RPC error): $DIAMOND_PAUSER_WALLET"
    return 1
  fi

  # Compare on-chain pauser to the expected (derived) address. The two networks return
  # different address forms, so normalize before comparing:
  #   - Tron: `troncast call ... returns(address)` yields a base58 (T...) address, while
  #     EXPECTED_PAUSER is EVM hex. Encode the expected address to base58 and compare
  #     case-SENSITIVELY (base58 distinguishes case).
  #   - EVM: both are 0x hex; compare case-insensitively (EIP-55 casing is cosmetic).
  if isTronNetwork "$NETWORK"; then
    local EXPECTED_TRON
    EXPECTED_TRON=$(evmToTronBase58 "$EXPECTED_PAUSER")
    if [[ "$DIAMOND_PAUSER_WALLET" != "$EXPECTED_TRON" ]]; then
      error "[network: $NETWORK] on-chain pauserWallet ($DIAMOND_PAUSER_WALLET) does not match the configured pauser key ($EXPECTED_TRON)"
      return 1
    fi
  else
    if [[ "$(echo "$DIAMOND_PAUSER_WALLET" | tr '[:upper:]' '[:lower:]')" != "$(echo "$EXPECTED_PAUSER" | tr '[:upper:]' '[:lower:]')" ]]; then
      error "[network: $NETWORK] on-chain pauserWallet ($DIAMOND_PAUSER_WALLET) does not match the configured pauser key ($EXPECTED_PAUSER)"
      return 1
    fi
  fi
  success "[network: $NETWORK] on-chain pauserWallet matches the configured key"
  return 0
}

# verifyGovernanceOnNetwork: governance checks — verify the UNPAUSE path's wiring with two
# INDEPENDENT on-chain assertions:
#   (1) LiFiTimelockController.diamond() points at the deploy-log production LiFiDiamond
#       (the timelock controls the right diamond), and
#   (2) the Safe holds TIMELOCK_ADMIN_ROLE on the timelock (so it can execute unpauseDiamond()).
# Read-only. Applies to any non-testnet network (EVM or Tron) with a deployed timelock AND a
# configured Safe; everything else is skipped with a notice. The exit code BIT-ENCODES which
# assertion failed so the caller can report the two separately:
#   bit 0 (1) = timelock.diamond() mismatch / unreadable,  bit 1 (2) = Safe missing the role / unreadable.
# Returns 0 on all-pass or skip. If the production diamond is missing from the deploy log neither
# assertion can run, so both bits are set (3).
#
# Usage: verifyGovernanceOnNetwork NETWORK
function verifyGovernanceOnNetwork() {
  local NETWORK="$1"

  # Testnets are EOA-owned (no Safe/timelock). Tron runs the same Safe+timelock governance and
  # IS checked: addressesMatch handles base58 comparison and troncast accepts the base58 Safe.
  if isTestnetNetwork "$NETWORK"; then
    echo "skipping $NETWORK governance checks (testnet - EOA-owned, no Safe/timelock)"
    return 0
  fi

  local TIMELOCK_ADDRESS
  TIMELOCK_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiTimelockController")
  if [[ $? -ne 0 || -z "$TIMELOCK_ADDRESS" ]]; then
    echo "skipping $NETWORK governance checks (no LiFiTimelockController in deploy log)"
    return 0
  fi

  local SAFE_ADDRESS
  SAFE_ADDRESS=$(jq -r --arg n "$NETWORK" '.[$n].safeAddress // empty' config/networks.json)
  if [[ -z "$SAFE_ADDRESS" ]]; then
    echo "skipping $NETWORK governance checks (no safeAddress in networks.json)"
    return 0
  fi

  local DIAMOND_ADDRESS
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond")
  if [[ $? -ne 0 || -z "$DIAMOND_ADDRESS" ]]; then
    error "[network: $NETWORK] governance: production LiFiDiamond not found in deploy log; cannot verify either assertion."
    return 3
  fi

  local RC=0

  # (1) timelock.diamond() must point at the production diamond  (bit 0)
  sleep "$RPC_CALL_DELAY_SECONDS"
  local TIMELOCK_DIAMOND
  if ! TIMELOCK_DIAMOND=$(rpcCallWithRetry "[$NETWORK] timelock.diamond()" universalCast "call" "$NETWORK" "$TIMELOCK_ADDRESS" "diamond() returns (address)"); then
    error "[network: $NETWORK] governance: failed to read LiFiTimelockController.diamond() after $RPC_MAX_ATTEMPTS attempts: $TIMELOCK_DIAMOND"
    RC=$((RC | 1))
  elif ! addressesMatch "$NETWORK" "$TIMELOCK_DIAMOND" "$DIAMOND_ADDRESS"; then
    error "[network: $NETWORK] governance: timelock.diamond() ($TIMELOCK_DIAMOND) does not match deploy-log LiFiDiamond ($DIAMOND_ADDRESS)"
    RC=$((RC | 1))
  else
    success "[network: $NETWORK] governance: timelock.diamond() matches the production diamond"
  fi

  # (2) Safe must hold TIMELOCK_ADMIN_ROLE (so it can drive unpauseDiamond())  (bit 1)
  sleep "$RPC_CALL_DELAY_SECONDS"
  local HAS_ROLE
  if ! HAS_ROLE=$(rpcCallWithRetry "[$NETWORK] timelock.hasRole(admin,safe)" universalCast "call" "$NETWORK" "$TIMELOCK_ADDRESS" "hasRole(bytes32,address) returns (bool)" "$TIMELOCK_ADMIN_ROLE" "$SAFE_ADDRESS"); then
    error "[network: $NETWORK] governance: failed to read hasRole(TIMELOCK_ADMIN_ROLE, safe) after $RPC_MAX_ATTEMPTS attempts: $HAS_ROLE"
    RC=$((RC | 2))
  elif [[ "$HAS_ROLE" != "true" ]]; then
    error "[network: $NETWORK] governance: Safe ($SAFE_ADDRESS) does NOT hold TIMELOCK_ADMIN_ROLE on the timelock (hasRole=$HAS_ROLE)"
    RC=$((RC | 2))
  else
    success "[network: $NETWORK] governance: Safe holds TIMELOCK_ADMIN_ROLE"
  fi

  return $RC
}

# verifyNetwork: run every on-chain per-network check for one network (the pauser check + the two
# governance assertions). Runs them all even if one fails, so a network reports all problems. The
# exit code BIT-ENCODES which check failed so main() can aggregate each separately (for the per-check
# status report) from each background job's `wait` status:
#   bit 0 (1) = pauser check failed,
#   bit 1 (2) = governance: timelock.diamond() check failed,
#   bit 2 (4) = governance: Safe TIMELOCK_ADMIN_ROLE check failed.
# (verifyGovernanceOnNetwork returns its own two-bit code; we shift it left past the pauser bit.)
#
# Usage: verifyNetwork NETWORK EXPECTED_PAUSER_ADDRESS
# Returns: 0..7 — the OR of the bits above.
function verifyNetwork() {
  local NETWORK="$1"
  local EXPECTED_PAUSER="$2"
  local RC=0
  verifyPauserOnNetwork "$NETWORK" "$EXPECTED_PAUSER" || RC=$((RC | 1))
  local GOV_RC=0
  verifyGovernanceOnNetwork "$NETWORK" || GOV_RC=$?
  RC=$((RC | (GOV_RC << 1)))
  return $RC
}

# verifyHexagatePatReadiness: verify the lifi-hexagate-pauser PAT can dispatch
# diamondEmergencyPause.yml. Six checks against the GitHub API — no workflow is triggered:
#   (1) Secret configured  — HEXAGATE_PAUSER_PAT secret is set in this repo (fail-fast if not)
#   (2) Format valid       — PAT matches ghp_* classic PAT prefix format (fine-grained PATs not supported)
#   (3) SSO authorization  — PAT is authorized for the lifinance SAML SSO org (x-github-sso header)
#   (4) Validity           — PAT is not expired or revoked (HTTP status)
#   (5) Dispatch access    — PAT has push access AND workflow/repo scope (both required for workflow_dispatch)
#   (6) DiamondPauser      — token owner is an active member of lifinance/diamondpauser team
#       (the gate the workflow checks as github.actor after Hexagate fires the dispatch)
#
# Each sub-check result is emitted individually to GITHUB_OUTPUT (hexagatePatSecret /
# hexagatePatFormat / hexagatePatSso / hexagatePatValidity / hexagatePatDispatch /
# hexagatePatTeam) so the workflow can render them as child bullets in the Slack status message.
#
# Reads HEXAGATE_PAUSER_PAT from env (set from GitHub secret).
# Returns: 0 on all checks pass, 1 on any failure (including secret not configured).
function verifyHexagatePatReadiness() {
  # Sub-check statuses — written to GITHUB_OUTPUT at the end.
  local SECRET_STATUS="skipped" FORMAT_STATUS="skipped" SSO_STATUS="skipped" VALIDITY_STATUS="skipped" DISPATCH_STATUS="skipped" TEAM_STATUS="skipped"
  local RC=0

  # (1) Secret configured
  if [[ -z "${HEXAGATE_PAUSER_PAT:-}" ]]; then
    error "Hexagate PAT (1/6): HEXAGATE_PAUSER_PAT secret is not configured in this repo"
    SECRET_STATUS="fail"
    RC=1
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      {
        echo "hexagatePatSecret=$SECRET_STATUS"
        echo "hexagatePatFormat=skipped"
        echo "hexagatePatSso=skipped"
        echo "hexagatePatValidity=skipped"
        echo "hexagatePatDispatch=skipped"
        echo "hexagatePatTeam=skipped"
      } >>"$GITHUB_OUTPUT"
    fi
    return $RC
  fi
  success "Hexagate PAT (1/6): HEXAGATE_PAUSER_PAT secret is configured"
  SECRET_STATUS="pass"

  # (2) Format validation — must be a classic PAT: ghp_ + 36 alphanumeric chars
  if [[ "$HEXAGATE_PAUSER_PAT" =~ ^ghp_[A-Za-z0-9]{36}$ ]]; then
    success "Hexagate PAT (2/6): PAT format is valid (ghp_* classic PAT)"
    FORMAT_STATUS="pass"
  else
    error "Hexagate PAT (2/6): PAT format is invalid — expected a classic PAT (ghp_<36 chars>)"
    FORMAT_STATUS="fail"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      {
        echo "hexagatePatSecret=$SECRET_STATUS"
        echo "hexagatePatFormat=$FORMAT_STATUS"
        echo "hexagatePatSso=skipped"
        echo "hexagatePatValidity=skipped"
        echo "hexagatePatDispatch=skipped"
        echo "hexagatePatTeam=skipped"
      } >>"$GITHUB_OUTPUT"
    fi
    return 1
  fi

  local GH_HEADERS=(-H "Authorization: Bearer $HEXAGATE_PAUSER_PAT" \
                    -H "X-GitHub-Api-Version: 2022-11-28" \
                    -H "Accept: application/vnd.github+json")

  # ── Checks 3–5: single GET /repos/lifinance/contracts ──────────────────────
  local REPO_BODY_FILE REPO_HEADERS_FILE HTTP_STATUS
  REPO_BODY_FILE=$(mktemp)
  REPO_HEADERS_FILE=$(mktemp)
  if ! HTTP_STATUS=$(curl -s \
    -o "$REPO_BODY_FILE" \
    -D "$REPO_HEADERS_FILE" \
    -w "%{http_code}" \
    "${GH_HEADERS[@]}" \
    "https://api.github.com/repos/lifinance/contracts"); then
    error "Hexagate PAT: curl failed to reach GitHub API (network error or curl not available)"
    rm -f "$REPO_BODY_FILE" "$REPO_HEADERS_FILE"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      {
        echo "hexagatePatSecret=$SECRET_STATUS"
        echo "hexagatePatFormat=$FORMAT_STATUS"
        echo "hexagatePatSso=skipped"
        echo "hexagatePatValidity=skipped"
        echo "hexagatePatDispatch=skipped"
        echo "hexagatePatTeam=skipped"
      } >>"$GITHUB_OUTPUT"
    fi
    return 1
  fi

  local SSO_HEADER OAUTH_SCOPES CAN_PUSH
  SSO_HEADER=$(grep -i "x-github-sso:" "$REPO_HEADERS_FILE" || true)
  OAUTH_SCOPES=$(grep -i "^x-oauth-scopes:" "$REPO_HEADERS_FILE" \
    | sed 's/^[Xx]-[Oo][Aa][Uu][Tt][Hh]-[Ss][Cc][Oo][Pp][Ee][Ss]:[[:space:]]*//' \
    | tr -d '\r' || true)
  CAN_PUSH=$(jq -r '.permissions.push // false' "$REPO_BODY_FILE" 2>/dev/null || echo "false")
  rm -f "$REPO_BODY_FILE" "$REPO_HEADERS_FILE"

  # (3) SSO authorization
  # IMPORTANT: GitHub only sends x-github-sso: required when the token is valid but not
  # SSO-authorized (typically HTTP 403). With an invalid token (HTTP 401) there is no SSO
  # header at all — gating "pass" on HTTP 200 prevents any bogus token from falsely passing.
  if [[ "$HTTP_STATUS" == "200" ]]; then
    if echo "$SSO_HEADER" | grep -qi "required"; then
      error "Hexagate PAT (3/6): SSO authorization lapsed — re-authorize at github.com/settings/tokens (li-hexagate-bot account)"
      SSO_STATUS="fail"
      RC=1
    else
      success "Hexagate PAT (3/6): No SSO block on lifinance org access"
      SSO_STATUS="pass"
    fi
  elif [[ "$HTTP_STATUS" == "403" ]] && echo "$SSO_HEADER" | grep -qi "required"; then
    error "Hexagate PAT (3/6): SSO authorization lapsed — re-authorize at github.com/settings/tokens (li-sc-bot account)"
    SSO_STATUS="fail"
    RC=1
  else
    echo "Hexagate PAT (3/6): SSO check skipped — token validity failed first (HTTP $HTTP_STATUS)"
    SSO_STATUS="skipped"
  fi

  # (4) PAT validity
  if [[ "$HTTP_STATUS" == "200" ]]; then
    success "Hexagate PAT (4/6): PAT is active (not expired/revoked)"
    VALIDITY_STATUS="pass"
  elif [[ "$HTTP_STATUS" == "403" ]] && echo "$SSO_HEADER" | grep -qi "required"; then
    # SSO is blocking access — the PAT itself is valid (not expired/revoked)
    success "Hexagate PAT (4/6): PAT is active (not expired/revoked) — blocked by SSO, not validity"
    VALIDITY_STATUS="pass"
  elif [[ "$HTTP_STATUS" == "401" ]]; then
    error "Hexagate PAT (4/6): PAT is expired or revoked (HTTP 401)"
    VALIDITY_STATUS="fail"
    RC=1
  elif [[ "$HTTP_STATUS" == "403" ]]; then
    error "Hexagate PAT (4/6): PAT returned HTTP 403 — may be suspended or lack repo access"
    VALIDITY_STATUS="fail"
    RC=1
  else
    error "Hexagate PAT (4/6): unexpected HTTP $HTTP_STATUS"
    VALIDITY_STATUS="fail"
    RC=1
  fi

  # (5) Dispatch access: push permission + workflow/repo scope (both required for workflow_dispatch)
  if [[ "$HTTP_STATUS" == "200" ]]; then
    local SCOPE_OK=true
    if [[ -n "$OAUTH_SCOPES" ]]; then
      # classic PAT — must have workflow or repo scope
      if ! echo "$OAUTH_SCOPES" | grep -qE '(^|,)[[:space:]]*(workflow|repo)[[:space:]]*(,|$)'; then
        error "Hexagate PAT (5/6): classic PAT is missing 'workflow' or 'repo' scope (scopes: ${OAUTH_SCOPES:-none})"
        SCOPE_OK=false
        RC=1
      fi
    fi
    # fine-grained PATs: scope not returned — dispatch gated by push permission only
    if [[ "$CAN_PUSH" == "true" && "$SCOPE_OK" == "true" ]]; then
      success "Hexagate PAT (5/6): has push access and required scope — workflow_dispatch will be accepted"
      DISPATCH_STATUS="pass"
    elif [[ "$CAN_PUSH" != "true" ]]; then
      error "Hexagate PAT (5/6): PAT lacks push access — workflow_dispatch will be rejected"
      DISPATCH_STATUS="fail"
      RC=1
    else
      DISPATCH_STATUS="fail"
    fi
  else
    echo "Hexagate PAT (5/6): skipped (HTTP $HTTP_STATUS from repo endpoint)"
  fi

  # ── Check 6: DiamondPauser team membership ──────────────────────────────────
  # Step A: resolve token owner via GET /user
  local USER_BODY_FILE TOKEN_OWNER USER_HTTP_STATUS
  USER_BODY_FILE=$(mktemp)
  USER_HTTP_STATUS=$(curl -s \
    -o "$USER_BODY_FILE" \
    -w "%{http_code}" \
    "${GH_HEADERS[@]}" \
    "https://api.github.com/user")
  TOKEN_OWNER=$(jq -r '.login // empty' "$USER_BODY_FILE" 2>/dev/null || true)
  rm -f "$USER_BODY_FILE"

  if [[ -z "$TOKEN_OWNER" ]]; then
    echo "Hexagate PAT (6/6): could not resolve token owner (GET /user → HTTP $USER_HTTP_STATUS) — skipping team check"
    TEAM_STATUS="skipped"
  else
    # Step B: check membership in the diamondpauser gate team
    local MEMBERSHIP_FILE MEMBERSHIP_HTTP_STATUS MEMBERSHIP_STATE
    MEMBERSHIP_FILE=$(mktemp)
    MEMBERSHIP_HTTP_STATUS=$(curl -s \
      -o "$MEMBERSHIP_FILE" \
      -w "%{http_code}" \
      "${GH_HEADERS[@]}" \
      "https://api.github.com/orgs/lifinance/teams/diamondpauser/memberships/$TOKEN_OWNER")
    MEMBERSHIP_STATE=$(jq -r '.state // empty' "$MEMBERSHIP_FILE" 2>/dev/null || true)
    rm -f "$MEMBERSHIP_FILE"

    if [[ "$MEMBERSHIP_HTTP_STATUS" == "200" && "$MEMBERSHIP_STATE" == "active" ]]; then
      success "Hexagate PAT (6/6): @$TOKEN_OWNER is an active member of lifinance/diamondpauser"
      TEAM_STATUS="pass"
    elif [[ "$MEMBERSHIP_HTTP_STATUS" == "404" ]]; then
      error "Hexagate PAT (6/6): @$TOKEN_OWNER is NOT in lifinance/diamondpauser — workflow gate will reject Hexagate's dispatch"
      error "  Add them at: https://github.com/orgs/lifinance/teams/diamondpauser/members"
      TEAM_STATUS="fail"
      RC=1
    elif [[ "$MEMBERSHIP_HTTP_STATUS" == "403" ]]; then
      # PAT lacks read:org scope — surface the username for manual verification; don't fail the run
      echo "Hexagate PAT (6/6): PAT lacks read:org scope — verify @$TOKEN_OWNER is in diamondpauser manually"
      echo "  https://github.com/orgs/lifinance/teams/diamondpauser/members"
      TEAM_STATUS="skipped"
    elif [[ "$MEMBERSHIP_STATE" == "pending" ]]; then
      error "Hexagate PAT (6/6): @$TOKEN_OWNER has a pending invite to diamondpauser — must accept before the gate passes"
      TEAM_STATUS="fail"
      RC=1
    else
      echo "Hexagate PAT (6/6): unexpected HTTP $MEMBERSHIP_HTTP_STATUS checking @$TOKEN_OWNER in diamondpauser"
      TEAM_STATUS="skipped"
    fi
  fi

  # Emit each sub-check as an individual step output for child-bullet rendering in Slack
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      echo "hexagatePatSecret=$SECRET_STATUS"
      echo "hexagatePatFormat=$FORMAT_STATUS"
      echo "hexagatePatSso=$SSO_STATUS"
      echo "hexagatePatValidity=$VALIDITY_STATUS"
      echo "hexagatePatDispatch=$DISPATCH_STATUS"
      echo "hexagatePatTeam=$TEAM_STATUS"
    } >>"$GITHUB_OUTPUT"
  fi

  return $RC
}

# emitCheckStatus: when running inside GitHub Actions, publish each check's result as a step output
# (secret / pauser / timelockDiamond / safeAdminRole / hexagatePat, each one of pass | fail | skipped)
# so the workflow can render an accurate per-check Slack status. No-op locally (GITHUB_OUTPUT unset).
# OUTPUT ONLY — never affects which checks run or the exit code.
#
# Usage: emitCheckStatus SECRET_STATUS PAUSER_STATUS TIMELOCK_DIAMOND_STATUS SAFE_ADMIN_ROLE_STATUS HEXAGATE_PAT_STATUS
function emitCheckStatus() {
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  {
    echo "secret=$1"
    echo "pauser=$2"
    echo "timelockDiamond=$3"
    echo "safeAdminRole=$4"
    echo "hexagatePat=$5"
  } >>"$GITHUB_OUTPUT"
}

function main {
  # Per-check results for the workflow's per-check Slack status. The secret check fail-fasts (we do
  # not hit chains with a wrong key), so on a secret-check failure the on-chain checks stay
  # "skipped". emitCheckStatus publishes these as step outputs in CI; it is output-only and never
  # changes the exit code below.
  local SECRET_STATUS="fail" PAUSER_STATUS="skipped" TIMELOCK_DIAMOND_STATUS="skipped" SAFE_ROLE_STATUS="skipped" HEXAGATE_PAT_STATUS="skipped"

  # Normalize + validate the pauser key (accept it with or without a 0x prefix, fail loud on
  # empty/malformed) via the shared helper, so this readiness check reports a clean mismatch
  # rather than tripping over a prefix-induced format fault — the same normalization the pause
  # script applies (EXSC-507).
  if ! PRIVATE_KEY_PAUSER_WALLET=$(normalizePrivateKey "$PRIVATE_KEY_PAUSER_WALLET" "PRIVATE_KEY_PAUSER_WALLET"); then
    emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$TIMELOCK_DIAMOND_STATUS" "$SAFE_ROLE_STATUS" "$HEXAGATE_PAT_STATUS"
    return 1
  fi

  # derive the pauser address from the (normalized) secret (mirrors the break-glass script;
  # the key is passed as an argument because cast has no env/stdin path for a raw key, is
  # never echoed, and GitHub masks the secret in logs)
  local PRIV_KEY_ADDRESS
  PRIV_KEY_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  echo "Address derived from PRIVATE_KEY_PAUSER_WALLET: $PRIV_KEY_ADDRESS"

  ##### Secret check: offline secret <-> config (fail fast - no point hitting chains if the key is wrong)
  local EXPECTED_EVM EXPECTED_TRON
  EXPECTED_EVM=$(jq -r '.pauserWallet // empty' config/global.json)
  EXPECTED_TRON=$(jq -r '.tronWallets.pauserWallet // empty' config/global.json)
  if [[ -z "$EXPECTED_EVM" || -z "$EXPECTED_TRON" ]]; then
    error "pauserWallet / tronWallets.pauserWallet missing or null in config/global.json."
    emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$TIMELOCK_DIAMOND_STATUS" "$SAFE_ROLE_STATUS" "$HEXAGATE_PAT_STATUS"
    return 1
  fi
  if [[ "$(echo "$PRIV_KEY_ADDRESS" | tr '[:upper:]' '[:lower:]')" != "$(echo "$EXPECTED_EVM" | tr '[:upper:]' '[:lower:]')" ]]; then
    error "secret-derived address ($PRIV_KEY_ADDRESS) does not match config pauserWallet ($EXPECTED_EVM)."
    emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$TIMELOCK_DIAMOND_STATUS" "$SAFE_ROLE_STATUS" "$HEXAGATE_PAT_STATUS"
    return 1
  fi
  local DERIVED_TRON
  DERIVED_TRON=$(evmToTronBase58 "$PRIV_KEY_ADDRESS")
  if [[ "$DERIVED_TRON" != "$EXPECTED_TRON" ]]; then
    error "secret-derived Tron address ($DERIVED_TRON) does not match config tronWallets.pauserWallet ($EXPECTED_TRON)."
    emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$TIMELOCK_DIAMOND_STATUS" "$SAFE_ROLE_STATUS" "$HEXAGATE_PAT_STATUS"
    return 1
  fi
  SECRET_STATUS="pass"
  success "Secret check OK: the GitHub secret matches the configured pauser (EVM + Tron)."

  ##### On-chain checks: pauserWallet() + governance, per production diamond
  local NETWORKS=()
  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
  while IFS= read -r NETWORK; do
    NETWORKS+=("$NETWORK")
  done < <(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH")

  echo "Verifying on-chain pauserWallet + governance across ${#NETWORKS[@]} networks (throttled parallel; log may appear interleaved)..."

  # Throttled parallel sweep ([CONV:PARALLEL-WORK]): cap concurrency at MAX_CONCURRENT_JOBS so we
  # don't fan ~60 simultaneous RPC calls at providers (which invites throttling/429s and more
  # retries). A backgrounded subshell can't write back to parent variables, so each worker writes
  # verifyNetwork's bit-encoded exit code to a per-network file; we aggregate after `wait`. A
  # failure on one diamond does NOT abort the others.
  #
  # NOTE: this intentionally DIVERGES from the break-glass script's unbounded fan-out — that
  # live script fires every network at once because an incident can't wait; this read-only weekly
  # check has no such urgency and is gentler on RPCs when throttled.
  local MAX_JOBS=${MAX_CONCURRENT_JOBS:-10}
  [[ "$MAX_JOBS" =~ ^[1-9][0-9]*$ ]] || MAX_JOBS=10
  local RESULT_DIR
  RESULT_DIR=$(mktemp -d)
  trap 'rm -rf "$RESULT_DIR"' RETURN
  local IDX=0
  for NETWORK in "${NETWORKS[@]}"; do
    IDX=$((IDX + 1))
    # throttle: block until a slot frees up before launching the next worker
    while (($(jobs -rp | wc -l) >= MAX_JOBS)); do wait -n; done
    (
      verifyNetwork "$NETWORK" "$PRIV_KEY_ADDRESS"
      echo "$?" >"$RESULT_DIR/result_$IDX"
    ) &
  done
  wait

  # Aggregate each worker's bit-encoded exit code from its result file (bit layout: see verifyNetwork).
  # A missing / non-numeric result means a worker died before recording — fail loud rather than
  # silently pass.
  local PAUSER_FAILED=0 TIMELOCK_DIAMOND_FAILED=0 SAFE_ROLE_FAILED=0 INCOMPLETE=0 RC
  for ((I = 1; I <= IDX; I++)); do
    RC=$(cat "$RESULT_DIR/result_$I" 2>/dev/null)
    if ! [[ "$RC" =~ ^[0-9]+$ ]]; then
      error "[network #$I] no result captured from the parallel sweep — failing the run"
      INCOMPLETE=1
      continue
    fi
    ((RC & 1)) && PAUSER_FAILED=1
    ((RC & 2)) && TIMELOCK_DIAMOND_FAILED=1
    ((RC & 4)) && SAFE_ROLE_FAILED=1
  done
  [[ "$PAUSER_FAILED" -eq 0 ]] && PAUSER_STATUS="pass" || PAUSER_STATUS="fail"
  [[ "$TIMELOCK_DIAMOND_FAILED" -eq 0 ]] && TIMELOCK_DIAMOND_STATUS="pass" || TIMELOCK_DIAMOND_STATUS="fail"
  [[ "$SAFE_ROLE_FAILED" -eq 0 ]] && SAFE_ROLE_STATUS="pass" || SAFE_ROLE_STATUS="fail"

  ##### Hexagate PAT check: verify the PAT Hexagate uses to dispatch this workflow is still valid
  echo "-------------------------------------------------------------------------------------"
  local HEXAGATE_PAT_FAILED=0
  if verifyHexagatePatReadiness; then
    HEXAGATE_PAT_STATUS="pass"
  else
    HEXAGATE_PAT_STATUS="fail"
    HEXAGATE_PAT_FAILED=1
  fi

  local RETURN=0
  [[ "$PAUSER_FAILED" -eq 1 || "$TIMELOCK_DIAMOND_FAILED" -eq 1 || "$SAFE_ROLE_FAILED" -eq 1 || "$INCOMPLETE" -eq 1 || "$HEXAGATE_PAT_FAILED" -eq 1 ]] && RETURN=1

  emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$TIMELOCK_DIAMOND_STATUS" "$SAFE_ROLE_STATUS" "$HEXAGATE_PAT_STATUS"

  echo "-------------------------------------------------------------------------------------"
  if [[ "$RETURN" -ne 0 ]]; then
    error "Emergency pause readiness check FAILED for one or more networks (see logs above)."
  else
    success "Emergency pause readiness check passed: secret valid and every production diamond agrees."
  fi
  return "$RETURN"
}

# call main function with all parameters the script was called with
main "$@"
