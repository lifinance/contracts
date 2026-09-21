#!/bin/bash

# The caller's proposal intent, captured into names `.env` does not define.
#
# `.env.example` ships blank SAFE_PROPOSAL_TICKET / SAFE_PROPOSAL_REASON lines, so on any
# checkout derived from it a `source .env` overwrites what an operator or agent exported.
# Every entry point that can reach a Safe proposal sources this file *before* its first
# `source .env`; `assertProposalTicketForRun` then reads these mirrors as the supplied
# value. They are also what carries the intent into workers, which re-source the framework.
#
# Idempotent: each assignment keeps an already-captured value, so sourcing this again
# (a nested script, a worker) never downgrades what an earlier capture found.
RESOLVED_SAFE_PROPOSAL_TICKET="${RESOLVED_SAFE_PROPOSAL_TICKET:-${SAFE_PROPOSAL_TICKET:-}}"
RESOLVED_SAFE_PROPOSAL_REASON="${RESOLVED_SAFE_PROPOSAL_REASON:-${SAFE_PROPOSAL_REASON:-}}"
export RESOLVED_SAFE_PROPOSAL_TICKET RESOLVED_SAFE_PROPOSAL_REASON
