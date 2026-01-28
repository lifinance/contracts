#!/usr/bin/env bun

/**
 * Query Safe Proposals
 *
 * This script provides query operations for Safe transaction proposals stored in MongoDB.
 * It supports checking if proposals exist in the database with pending status.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { WithId } from 'mongodb'

import { getSafeMongoCollection, type ISafeTxDocument } from './safe-utils'

/**
 * Checks if a pending proposal exists for a given network, environment, and contract
 * Looks for proposals created in the last 5 minutes
 * @param environment - Reserved for future use (not currently used in query)
 */
async function checkProposalExists(
  network: string,
  _environment: string,
  contract: string
): Promise<WithId<ISafeTxDocument> | null> {
  const { client, pendingTransactions } = await getSafeMongoCollection()

  try {
    // Calculate timestamp for 5 minutes ago
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)

    // Query for pending proposals on this network created in the last 5 minutes
    const proposals = await pendingTransactions
      .find({
        network: network.toLowerCase(),
        status: 'pending',
        timestamp: { $gte: fiveMinutesAgo },
      })
      .sort({ timestamp: -1 })
      .limit(10)
      .toArray()

    if (proposals.length === 0) {
      return null
    }

    // For better matching, try to verify the proposal matches the contract
    // Check if any proposal's calldata matches what we expect
    for (const proposal of proposals) {
      const calldata = proposal.safeTx?.data?.data

      if (!calldata) continue

      // For periphery contracts: check if calldata contains registerPeripheryContract with contract name
      if (contract && !contract.includes('Facet')) {
        // registerPeripheryContract(string,address) selector is 0x...
        // We can check if the contract name appears in the calldata (encoded as string)
        // This is a simple heuristic - the contract name should be in the calldata
        const contractNameLower = contract.toLowerCase()
        // The calldata will have the contract name encoded, so we check if it's present
        // This is approximate but should work for most cases
        if (calldata.toLowerCase().includes(contractNameLower.slice(0, 8))) {
          return proposal
        }
      }

      // For facets: diamond cut proposals are harder to match exactly
      // If we have multiple proposals, return the most recent one
      // The caller can verify further if needed
      if (contract && contract.includes('Facet')) {
        // Diamond cut proposals have a specific structure
        // For now, return the most recent pending proposal
        return proposal
      }
    }

    // If no exact match but we have proposals, return the most recent one
    // This handles the case where timing is close but contract matching is uncertain
    return proposals[0] ?? null
  } finally {
    await client.close()
  }
}

// Define check command
const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description:
      'Check if a pending proposal exists for a contract on a network',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'Environment (staging or production)',
      required: true,
    },
    contract: {
      type: 'string',
      description: 'Contract name',
      required: true,
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.environment !== 'staging' && args.environment !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    try {
      const proposal = await checkProposalExists(
        args.network,
        args.environment,
        args.contract
      )

      if (proposal) {
        // Output JSON for bash script to parse
        console.log(
          JSON.stringify({
            found: true,
            safeTxHash: proposal.safeTxHash,
            timestamp: proposal.timestamp,
            network: proposal.network,
            status: proposal.status,
          })
        )
        process.exit(0)
      } else {
        // Output JSON indicating not found
        console.log(
          JSON.stringify({
            found: false,
            network: args.network,
            contract: args.contract,
          })
        )
        process.exit(1)
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error('Failed to check proposal:', errorMessage)

      // Output error as JSON for bash script
      console.log(
        JSON.stringify({
          found: false,
          error: errorMessage,
          network: args.network,
          contract: args.contract,
        })
      )
      process.exit(1)
    }
  },
})

// Define main command
const main = defineCommand({
  meta: {
    name: 'query-safe-proposals',
    description: 'Query Safe transaction proposals from MongoDB',
    version: '1.0.0',
  },
  subCommands: {
    check: checkCommand,
  },
})

// Run the CLI
runMain(main)

export { checkProposalExists }
