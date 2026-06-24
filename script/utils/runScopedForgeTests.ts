#!/usr/bin/env bun
/**
 * Run a scoped forge test invocation for faster agent/human iteration.
 *
 * Usage:
 *   bun test:scoped -- test/solidity/Facets/AccessManagerFacet.t.sol
 *   bun test:scoped -- --match-contract AccessManagerFacetTest
 *   bun test:scoped -- test/solidity/Libraries/
 *
 * All arguments after `--` are forwarded to `forge test`.
 * When no args are given, prints usage and exits 1.
 */
import { spawnSync } from 'node:child_process'

const sepIndex = process.argv.indexOf('--')
const forgeArgs =
  sepIndex === -1 ? process.argv.slice(2) : process.argv.slice(sepIndex + 1)

if (forgeArgs.length === 0) {
  console.error(`Usage: bun test:scoped -- <forge test args>

Examples:
  bun test:scoped -- test/solidity/Facets/AccessManagerFacet.t.sol
  bun test:scoped -- --match-contract AccessManagerFacetTest
  bun test:scoped -- test/solidity/Libraries/LibAllowList.t.sol -vvv`)
  process.exit(1)
}

const result = spawnSync(
  'forge',
  ['test', '--evm-version', 'cancun', ...forgeArgs],
  { stdio: 'inherit', env: process.env }
)

if (result.error) {
  console.error(`Error: Failed to spawn forge: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
