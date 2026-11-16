#!/bin/bash

# The caller's proposal intent, captured into names `.env` does not define.
#
# `.env.example` ships blank SAFE_PROPOSAL_TICKET / SAFE_PROPOSAL_REASON lines, so on any
# checkout derived from it a `source .env` overwrites what an operator or agent exported.
# Every entry point that can reach a Safe proposal sources this file *before* its first
# `source .env`; `assertProposalTicketForRun` then reads these mirrors as the supplied
# value. They are also what carries the intent into workers, which re-source the framework.
#
# A non-empty export wins over the mirror: a shell that ran an earlier rollout still holds
# that rollout's mirrors, and keeping them would label this run's proposals with the old
# ticket and reason. An empty one leaves the mirror alone, so a re-source after `.env` has
# blanked the export (a nested script, a worker) never loses what an earlier capture found.
if [[ -n "${SAFE_PROPOSAL_TICKET:-}" ]]; then
  RESOLVED_SAFE_PROPOSAL_TICKET="$SAFE_PROPOSAL_TICKET"
fi
# A reason that differs from the mirror was stated for this run, so the earlier run's
# ticket stamp no longer describes it.
if [[ -n "${SAFE_PROPOSAL_REASON:-}" &&
  "$SAFE_PROPOSAL_REASON" != "${RESOLVED_SAFE_PROPOSAL_REASON:-}" ]]; then
  RESOLVED_SAFE_PROPOSAL_REASON="$SAFE_PROPOSAL_REASON"
  unset RESOLVED_SAFE_PROPOSAL_REASON_TICKET
fi
RESOLVED_SAFE_PROPOSAL_TICKET="${RESOLVED_SAFE_PROPOSAL_TICKET:-}"
RESOLVED_SAFE_PROPOSAL_REASON="${RESOLVED_SAFE_PROPOSAL_REASON:-}"
export RESOLVED_SAFE_PROPOSAL_TICKET RESOLVED_SAFE_PROPOSAL_REASON
