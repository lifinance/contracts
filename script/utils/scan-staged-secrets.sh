#!/bin/bash
# scan-staged-secrets: Scans the lines a commit adds for values from the repo's .env file and
# for anything shaped like an Ethereum private key. Only added lines are scanned: content
# already in history cannot leak anything new, so a merge or a large commit costs one diff and
# one grep, not one grep per file per .env value.
#
# A line is skipped when it, or the line above it, contains the marker
# "pre-commit-checker: not a secret".
#
# Usage: scan-staged-secrets.sh
#   Run inside the repository; reads the staged diff and <repo root>/.env
#
# Returns: 0 when nothing is found or only potential private keys are found (printed as
#   warnings), 1 when a .env value is found, 2 when the staged diff cannot be read
# Example: bash script/utils/scan-staged-secrets.sh

set -euo pipefail

DISABLE_WITH_COMMENT="pre-commit-checker: not a secret"
ETH_PRIVATE_KEY_PATTERN='(^|[^0-9a-fA-F])[0-9a-fA-F]{64}([^0-9a-fA-F]|$)'
KNOWN_FALSE_POSITIVES=(
  "true"
  "false"
  "none"
  ""
  "verifyContract"
  "foundry.toml"
  "50000000000"
  # Well-known Anvil/Foundry development defaults documented in .env.example.
  # pre-commit-checker: not a secret
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  "test test test test test test test test test test test junk"
  # pre-commit-checker: not a secret
  "0xc726deb4bf42c6ef5d0b4e3080ace43aed9b270938861f7cacf900eba890fa66"
)
EXCLUDED_PATHS=(
  "deployments/_deployments_log_file.json"
  "config/networks.json"
  "lib/"
  "safe/cancun/out/"
  "safe/london/out/"
  "bun.lock"
  ".bun/"
  ".agents/commands/"
)
# Field separator for the added-lines records; a control character that source files do not
# contain, so the content field keeps its tabs and leading whitespace.
SEP=$'\037'

ENV_SECRET_KEYS=()
ENV_SECRET_VALUES=()

GIT_ROOT=$(git rev-parse --show-toplevel)
cd "$GIT_ROOT"

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# loadEnvSecrets: Fills ENV_SECRET_KEYS / ENV_SECRET_VALUES from .env, skipping values that are
# not credentials (known false positives, path and allowlist keys, short non-secret values).
#
# Usage: loadEnvSecrets ENV_FILE
#   ENV_FILE - Path to the .env file; a missing file leaves both arrays empty
#
# Returns: 0, or exits 2 when the file exists but cannot be read
function loadEnvSecrets() {
  local ENV_FILE="$1"

  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi
  # Fail closed: an unreadable .env would otherwise load no values and pass every commit
  if [ ! -r "$ENV_FILE" ]; then
    echo "scan-staged-secrets: cannot read $ENV_FILE; fix its permissions and commit again" >&2
    exit 2
  fi

  # Parameter expansions instead of sed/tr: one fork per .env line adds seconds to every commit.
  # nocasematch makes the key patterns below case-insensitive.
  shopt -s nocasematch
  local SECRET_LINE KEY VALUE FALSE_POSITIVE IS_FALSE_POSITIVE
  while IFS= read -r SECRET_LINE || [ -n "$SECRET_LINE" ]; do
    KEY=${SECRET_LINE%%=*}
    VALUE=${SECRET_LINE#*=}

    KEY=${KEY%"${KEY##*[![:space:]]}"}
    VALUE=${VALUE#"${VALUE%%[!\"\']*}"}
    VALUE=${VALUE%"${VALUE##*[!\"\']}"}
    VALUE=${VALUE%"${VALUE##*[![:space:]]}"}

    IS_FALSE_POSITIVE=false
    for FALSE_POSITIVE in "${KNOWN_FALSE_POSITIVES[@]}"; do
      if [ "$VALUE" = "$FALSE_POSITIVE" ]; then
        IS_FALSE_POSITIVE=true
        break
      fi
    done

    if [ -z "$VALUE" ] || [ "$IS_FALSE_POSITIVE" = true ]; then
      continue
    fi

    # Keys that hold filesystem paths or directories legitimately appear in
    # source/workflows; their values are not credentials.
    case "$KEY" in
      *_PATH | *_DIRECTORY | *_DIR)
        continue
        ;;
    esac

    # Comma-separated network/contract-name allowlists are public config, not
    # credentials, and their values legitimately overlap with strings in
    # foundry.toml/networks.json (e.g. DO_NOT_VERIFY_IN_THESE_NETWORKS=...,localanvil,...).
    case "$KEY" in
      DO_NOT_VERIFY_IN_THESE_NETWORKS | EXCLUDE_NETWORKS | \
        EXCLUDE_PERIPHERY_CONTRACTS | EXCLUDE_FACET_CONTRACTS)
        continue
        ;;
    esac

    # Skip short values only for clearly non-secret keys to avoid blind spots
    if [ ${#VALUE} -lt 8 ]; then
      case "$KEY" in
        *SECRET* | *TOKEN* | *PASSWORD* | *PRIVATE* | *API_KEY* | *ACCESS_KEY*) ;;
        *)
          continue
          ;;
      esac
    fi

    ENV_SECRET_KEYS+=("$KEY")
    ENV_SECRET_VALUES+=("$VALUE")
  done < <(grep -v '^#' "$ENV_FILE" | sed 's/#.*//' | grep -v '^[[:space:]]*$' |
    sed 's/[[:space:]]*$//' || true)
  shopt -u nocasematch
}

# writeAddedLines: Writes every line the staged diff adds, minus lines carrying (or following a
# line carrying) the not-a-secret marker, as "path<SEP>line number<SEP>content" records.
# Binary files are diffed as text so they stay covered.
#
# Usage: writeAddedLines OUTPUT_FILE
#   OUTPUT_FILE - File to write the records to
#
# Returns: 0, or exits 2 when git cannot produce the staged diff
function writeAddedLines() {
  local OUTPUT_FILE="$1"
  local PATHSPECS=(.)
  local EXCLUDED

  for EXCLUDED in "${EXCLUDED_PATHS[@]}"; do
    PATHSPECS+=(":(exclude)$EXCLUDED")
  done

  # -U1 keeps the line above each change, so the marker on an unchanged line above still counts.
  # suppressBlankEmpty would drop the " " of blank context lines and desync the hunk counts below.
  if ! git -c core.quotePath=false -c diff.suppressBlankEmpty=false diff --cached --no-color \
    --no-ext-diff --no-textconv --text --src-prefix=a/ --dst-prefix=b/ -U1 --diff-filter=ACMR \
    -- "${PATHSPECS[@]}" \
    > "$TEMP_DIR/staged.diff"; then
    echo "scan-staged-secrets: could not read the staged diff (git diff --cached failed)" >&2
    exit 2
  fi

  # NUL bytes from binary files would truncate lines in awk and bash
  tr -d '\000' < "$TEMP_DIR/staged.diff" | awk -v SEP="$SEP" -v MARKER="$DISABLE_WITH_COMMENT" '
    function hunkCount(RANGE, PARTS) {
      return split(RANGE, PARTS, ",") > 1 ? PARTS[2] + 0 : 1
    }
    OLD_LEFT <= 0 && NEW_LEFT <= 0 {
      if (substr($0, 1, 4) == "+++ ") {
        FILE = substr($0, 5)
        sub(/\t$/, "", FILE)
        if (substr(FILE, 1, 1) == "\"") FILE = substr(FILE, 2, length(FILE) - 2)
        sub(/^b\//, "", FILE)
      } else if (substr($0, 1, 3) == "@@ ") {
        split($0, FIELDS, " ")
        OLD_LEFT = hunkCount(substr(FIELDS[2], 2))
        NEW_LEFT = hunkCount(substr(FIELDS[3], 2))
        split(substr(FIELDS[3], 2), START, ",")
        LINE_NUMBER = START[1] + 0
        PREVIOUS = ""
      }
      next
    }
    {
      TAG = substr($0, 1, 1)
      CONTENT = substr($0, 2)
      if (TAG == "-") { OLD_LEFT--; next }
      if (TAG == "\\") next
      if (TAG == " ") OLD_LEFT--
      NEW_LEFT--
      if (TAG == "+" && index(CONTENT, MARKER) == 0 && index(PREVIOUS, MARKER) == 0) {
        printf "%s%s%d%s%s\n", FILE, SEP, LINE_NUMBER, SEP, CONTENT
      }
      PREVIOUS = CONTENT
      LINE_NUMBER++
    }
  ' > "$OUTPUT_FILE"
}

# grepRecords: Runs a grep command over the added-lines records, treating "no match" as success.
#
# Usage: grepRecords COMMAND ARGS...
#
# Returns: the command's output; exits 2 when the command itself fails
function grepRecords() {
  local STATUS=0
  "$@" || STATUS=$?
  if [ "$STATUS" -gt 1 ]; then
    echo "scan-staged-secrets: '$1' failed with status $STATUS" >&2
    exit 2
  fi
}

loadEnvSecrets "$GIT_ROOT/.env"

ADDED_LINES="$TEMP_DIR/added"
writeAddedLines "$ADDED_LINES"

SECRET_RESULTS=""
PRIVATE_KEY_RESULTS=""

if [ ${#ENV_SECRET_VALUES[@]} -gt 0 ]; then
  printf '%s\n' "${ENV_SECRET_VALUES[@]}" > "$TEMP_DIR/patterns"
  # git grep instead of grep: BSD grep is slow with hundreds of -F patterns (~10s on 100k lines)
  # git grep --no-index only reads paths under its working directory
  # grep.lineNumber / grep.column in a user's config would prefix every record
  grepRecords git -C "$TEMP_DIR" grep --no-index --no-color --no-line-number --no-column -h -a \
    -F -f patterns -- "${ADDED_LINES##*/}" > "$TEMP_DIR/secret_hits"

  # The prefilter also matches path and line-number fields; the content check below decides.
  while IFS="$SEP" read -r FILE LINE_NUMBER CONTENT; do
    INDEX=0
    while [ $INDEX -lt ${#ENV_SECRET_VALUES[@]} ]; do
      if [[ "$CONTENT" == *"${ENV_SECRET_VALUES[$INDEX]}"* ]]; then
        KEY=${ENV_SECRET_KEYS[$INDEX]}
        SECRET_RESULTS+="[$FILE:$LINE_NUMBER] Secret from .env file found (key: $KEY)"$'\n'
      fi
      INDEX=$((INDEX + 1))
    done
  done < "$TEMP_DIR/secret_hits"
fi

grepRecords grep -a -E -- "$ETH_PRIVATE_KEY_PATTERN" "$ADDED_LINES" > "$TEMP_DIR/private_key_hits"
while IFS="$SEP" read -r FILE LINE_NUMBER CONTENT; do
  if [[ "$CONTENT" =~ $ETH_PRIVATE_KEY_PATTERN ]]; then
    PRIVATE_KEY_RESULTS+="Potential private key found:"$'\n'"$FILE:$LINE_NUMBER:$CONTENT"$'\n\n'
  fi
done < "$TEMP_DIR/private_key_hits"

if [ -z "$SECRET_RESULTS" ] && [ -z "$PRIVATE_KEY_RESULTS" ]; then
  printf '\033[32m✓\033[0m %s\n' "Secret check passed"
  exit 0
fi

echo ""
RULE="---------------------------------------------"
printf '%s%s%s\n' "${RULE%???????}" " RESULTS: " "${RULE}––"
printf '%s' "$SECRET_RESULTS"
if [ -n "$SECRET_RESULTS" ] && [ -n "$PRIVATE_KEY_RESULTS" ]; then
  echo ""
fi
printf '%s' "$PRIVATE_KEY_RESULTS"
printf '%s%s%s\n' "$RULE" "$RULE" "---––"

if [ -n "$SECRET_RESULTS" ]; then
  printf '\033[31m✗ %s\033[0m\n' "Secret value(s) from .env found. This code cannot be committed."
  printf '\033[31m✗ %s\033[0m\n' "Remove the secrets and try to commit again"
  echo ""
  exit 1
fi

printf '\033[33m⚠ %s\033[0m\n' "Potential Ethereum private keys found"
echo ""
printf '\033[33m⚠ %s\033[0m\n' "NEXT STEPS"
printf '\033[33m⚠ %s%s\033[0m\n' "Check each match carefully and make sure that " \
  "no sensitive information is being committed"
printf '\033[33m⚠ %s%s\033[0m\n' "If it did happen, undo the commit with " \
  "'git reset --soft HEAD~1', remove the secret(s) and commit again."
BANGS="!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
printf '\033[31m✗ %s%s%s\033[0m\n' "$BANGS" " BEFORE PUSHING TO GITHUB " "$BANGS"
echo ""
printf '\033[32m✓\033[0m %s\n' "Secret check completed (warnings only)"
exit 0
