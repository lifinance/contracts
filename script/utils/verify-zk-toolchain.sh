#!/usr/bin/env bash
# Verify that the zkEVM toolchain about to compile matches the pins committed in
# foundry.toml [external.zksync]: the foundry-zksync binary release and the zksolc
# version it drives. Exits 0 on a full match, 1 otherwise.
#
# Usage: verify-zk-toolchain.sh [--quiet] [--dir INSTALL_DIR]
#   --quiet          suppress the success line
#   --dir            foundry-zksync install directory (default: ./foundry-zksync)
#
# zksolc cannot be pinned through a foundry profile, so the only thing that pins it is the
# FOUNDRY_ZKSYNC env var script/helperFunctions.sh exports. An unset var therefore means
# zksolc falls back to whatever the binary defaults to, which is why that case fails here.
#
# What the two legs prove is not the same thing. The foundry-zksync leg is an observation:
# it runs the installed binary and reads its version. The zksolc leg is not — it checks the
# request, because FOUNDRY_ZKSYNC is built from this same foundry.toml line by
# helperFunctions.sh, so on the deploy path it compares the pin against itself. It catches a
# hand-set or unset value in a shell a human drives (docs/DiamondCutRecomputation.md tells
# the reader to run ./foundry-zksync/forge directly), and it cannot catch foundry-zksync
# resolving the pinned zksolc to something else. Reading the compiler out of zkout/ metadata
# after the build is what would make that leg an observation too.
set -euo pipefail

GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$GIT_ROOT"

QUIET="false"
INSTALL_DIR="./foundry-zksync"
while [ $# -gt 0 ]; do
  case "$1" in
  --quiet)
    QUIET="true"
    shift
    ;;
  --dir)
    if [ $# -lt 2 ]; then
      printf '\033[31m✗ --dir needs a value\033[0m\n' >&2
      exit 1
    fi
    INSTALL_DIR="$2"
    shift 2
    ;;
  *)
    printf '\033[31m✗ unknown argument: %s\033[0m\n' "$1" >&2
    exit 1
    ;;
  esac
done

PIN_READER="$GIT_ROOT/script/utils/zkToolchainPins.sh"
if [ ! -f "$PIN_READER" ]; then
  printf '\033[31m✗ %s not found\033[0m\n' "$PIN_READER" >&2
  exit 1
fi
# shellcheck source=script/utils/zkToolchainPins.sh
source "$PIN_READER"

ZKSOLC_PIN="$(getZkToolchainPin zksolc || true)"
ZK_FOUNDRY_PIN="$(getZkToolchainPin foundry_zksync || true)"

if [ -z "$ZKSOLC_PIN" ] || [ -z "$ZK_FOUNDRY_PIN" ]; then
  printf '\033[31m✗ zk toolchain pins missing from foundry.toml [external.zksync]\033[0m\n' >&2
  printf '   zksolc:          %s\n' "${ZKSOLC_PIN:-<empty>}" >&2
  printf '   foundry_zksync:  %s\n' "${ZK_FOUNDRY_PIN:-<empty>}" >&2
  exit 1
fi

# The override exists so a new release can be tried out; on a build whose bytecode has to
# reproduce later, taking it would silently detach the artifact from the committed pin.
if [ -n "${FOUNDRY_ZKSYNC_VERSION:-}" ] && [ "${FOUNDRY_ZKSYNC_VERSION}" != "$ZK_FOUNDRY_PIN" ]; then
  printf '\033[31m✗ FOUNDRY_ZKSYNC_VERSION overrides the committed foundry-zksync pin\033[0m\n' >&2
  printf '   pinned:   %s\n' "$ZK_FOUNDRY_PIN" >&2
  printf '   override: %s\n' "${FOUNDRY_ZKSYNC_VERSION}" >&2
  printf '   fix:      unset FOUNDRY_ZKSYNC_VERSION, or change the pin in foundry.toml\n' >&2
  exit 1
fi

if [ -z "${FOUNDRY_ZKSYNC:-}" ]; then
  printf '\033[31m✗ FOUNDRY_ZKSYNC is not set, so zksolc is unpinned\033[0m\n' >&2
  printf '   expected it to carry zksolc %s\n' "$ZKSOLC_PIN" >&2
  printf '   fix:      source script/helperFunctions.sh before building\n' >&2
  exit 1
fi

# Parsed, not searched. A substring test passed pin 1.5.15 against a 1.5.155 toolchain, and
# anchoring on the value's quotes still accepted the pin appearing anywhere in the string —
# `{ zksolc = "9.9.9", other = "1.5.15" }` read as pinned. This leg exists to catch a value a
# human set by hand (docs/DiamondCutRecomputation.md tells the reader to drive the zk forge
# directly), which is exactly where a decorated value comes from.
ZKSOLC_KEYS="$(printf '%s' "${FOUNDRY_ZKSYNC}" | grep -o 'zksolc[[:space:]]*=' | wc -l | tr -d ' ')"
if [ "$ZKSOLC_KEYS" != "1" ]; then
  printf '\033[31m✗ FOUNDRY_ZKSYNC does not carry exactly one zksolc key\033[0m\n' >&2
  printf '   found:    %s\n' "$ZKSOLC_KEYS" >&2
  printf '   actual:   %s\n' "${FOUNDRY_ZKSYNC}" >&2
  printf '   fix:      unset FOUNDRY_ZKSYNC and source script/helperFunctions.sh\n' >&2
  exit 1
fi

ZKSOLC_ACTUAL="$(printf '%s' "${FOUNDRY_ZKSYNC}" | sed -n 's/.*zksolc[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p')"
if [ "$ZKSOLC_ACTUAL" != "$ZKSOLC_PIN" ]; then
  printf '\033[31m✗ FOUNDRY_ZKSYNC does not name the pinned zksolc\033[0m\n' >&2
  printf '   pinned:   %s\n' "$ZKSOLC_PIN" >&2
  printf '   actual:   %s\n' "${ZKSOLC_ACTUAL:-<unparseable>}" >&2
  printf '   from:     %s\n' "${FOUNDRY_ZKSYNC}" >&2
  exit 1
fi

if [ ! -x "${INSTALL_DIR}/forge" ]; then
  printf '\033[31m✗ no executable foundry-zksync forge at %s/forge\033[0m\n' "$INSTALL_DIR" >&2
  printf '   fix:      install_foundry_zksync (script/helperFunctions.sh)\n' >&2
  exit 1
fi

# Same shape install_foundry_zksync compares against, covering both the vX.Y.Z and the
# nightly-<sha> release tags.
ZK_FOUNDRY_ACTUAL="$("${INSTALL_DIR}/forge" --version 2>/dev/null | grep -oE 'foundry-zksync-[^[:space:]]+' | sed 's/^foundry-zksync-//' | head -1 || true)"

if [ -z "$ZK_FOUNDRY_ACTUAL" ]; then
  # shellcheck disable=SC2016 # the backticks quote a command name for the reader, not a substitution
  printf '\033[31m✗ could not parse the foundry-zksync version from `%s/forge --version`\033[0m\n' "$INSTALL_DIR" >&2
  exit 1
fi

if [ "$ZK_FOUNDRY_ACTUAL" != "$ZK_FOUNDRY_PIN" ]; then
  printf '\033[31m✗ foundry-zksync version mismatch\033[0m\n' >&2
  printf '   expected: %s\n' "$ZK_FOUNDRY_PIN" >&2
  printf '   actual:   %s\n' "$ZK_FOUNDRY_ACTUAL" >&2
  printf '   fix:      install_foundry_zksync (script/helperFunctions.sh)\n' >&2
  exit 1
fi

if [ "$QUIET" != "true" ]; then
  # foundry-zksync is what the binary reported; zksolc is what was requested of it. The
  # labels are the difference between the two legs, so the line cannot be read as having
  # observed a compiler nothing here runs.
  printf '\033[32m✓ foundry-zksync %s observed, zksolc %s requested\033[0m\n' "$ZK_FOUNDRY_ACTUAL" "$ZKSOLC_ACTUAL"
fi
