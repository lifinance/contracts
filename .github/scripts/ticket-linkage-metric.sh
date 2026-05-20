#!/usr/bin/env bash
# Computes ticket-linkage % for merged PRs in the previous calendar month.
# A PR "has a ticket" if a Linear-style ID (e.g. EXSC-123) appears in the title,
# branch name, or body, OR if the PR carries the `trivial` label (documented carve-out).
# Emits a multi-line `text` GitHub Actions output for the Slack step to consume.
set -euo pipefail

# Previous calendar month [SINCE, UNTIL] inclusive, in UTC.
# Works on GNU date (Linux runners). Do not use BSD date syntax here.
SINCE=$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m-%d)
UNTIL=$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m-%d)

PRS=$(gh pr list \
  --state merged \
  --search "merged:${SINCE}..${UNTIL}" \
  --limit 500 \
  --json number,title,headRefName,body,labels,author,mergedAt)

TOTAL=$(jq 'length' <<<"$PRS")

# Matches any Linear-style ticket ID: <UPPERCASE_PREFIX>-<digits>
TICKET_RE='[A-Z]+-[0-9]+'

WITH_TICKET=$(jq --arg re "$TICKET_RE" '[.[] |
  select(
    (.title       | test($re)) or
    (.headRefName | test($re)) or
    ((.body // "") | test($re)) or
    ([.labels[].name] | any(. == "trivial"))
  )] | length' <<<"$PRS")

if [ "$TOTAL" -eq 0 ]; then
  PCT=100
else
  PCT=$(( (WITH_TICKET * 100) / TOTAL ))
fi
MISSING=$(( TOTAL - WITH_TICKET ))

if   [ "$PCT" -ge 90 ]; then EMOJI=":white_check_mark:"
elif [ "$PCT" -ge 80 ]; then EMOJI=":large_yellow_circle:"
else                         EMOJI=":red_circle:"
fi

REPO="${GITHUB_REPOSITORY:-lifinance/contracts}"

OFFENDERS=$(jq -r --arg re "$TICKET_RE" --arg repo "$REPO" '[.[] |
  select(
    ((.title       | test($re)) or
     (.headRefName | test($re)) or
     ((.body // "") | test($re)) or
     ([.labels[].name] | any(. == "trivial"))) | not
  )] | .[0:10]
     | map("• <https://github.com/\($repo)/pull/\(.number)|#\(.number)> \(.title) — _\(.author.login)_")
     | join("\n")' <<<"$PRS")

{
  echo "${EMOJI} *Ticket linkage — ${SINCE} → ${UNTIL}*"
  echo "${WITH_TICKET}/${TOTAL} merged PRs linked to a Linear ticket (*${PCT}%*) — target: 80%+"
  if [ "$MISSING" -gt 0 ] && [ -n "$OFFENDERS" ]; then
    echo ""
    echo "Unlinked (top 10):"
    echo "${OFFENDERS}"
  fi
} > /tmp/slack-text.txt

# Emit as multi-line output using a random delimiter (per GitHub Actions docs).
DELIM="EOF_$(openssl rand -hex 8)"
{
  echo "text<<${DELIM}"
  cat /tmp/slack-text.txt
  echo "${DELIM}"
} >> "$GITHUB_OUTPUT"

# Also log to the Actions console for debugging
echo "--- Slack message preview ---"
cat /tmp/slack-text.txt
echo "--- end preview ---"
