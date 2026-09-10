#!/usr/bin/env bun

/**
 * Backup Deployment Logs
 *
 * Writes a point-in-time snapshot of a deployment-log collection to a local JSON file
 * before any bulk repair, so a bad write can be reversed. Refuses to overwrite an
 * existing snapshot, and prints a SHA-256 of the file so the restore can prove it is
 * reading back what was written.
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient } from 'mongodb'

import { getEnvVar } from '../utils/utils'

const DATABASE_NAME = 'contract-deployments'

const backup = defineCommand({
  meta: {
    name: 'backup',
    description: 'Snapshot a deployment-log collection to a local JSON file',
  },
  args: {
    collection: {
      type: 'string',
      description: 'Collection to snapshot',
      default: 'production',
    },
    out: {
      type: 'string',
      description:
        'Output path (default: backups/<collection>-<ISO timestamp>.json)',
    },
  },
  async run({ args }) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const out = resolve(args.out ?? `backups/${args.collection}-${stamp}.json`)
    if (existsSync(out))
      throw new Error(`refusing to overwrite existing snapshot: ${out}`)

    const client = new MongoClient(getEnvVar('MONGODB_URI'))
    await client.connect()
    let docs: unknown[]
    try {
      docs = await client
        .db(DATABASE_NAME)
        .collection(args.collection)
        .find({})
        .toArray()
    } finally {
      await client.close()
    }

    mkdirSync(dirname(out), { recursive: true })
    const body = JSON.stringify(
      {
        database: DATABASE_NAME,
        collection: args.collection,
        takenAt: new Date().toISOString(),
        count: docs.length,
        documents: docs,
      },
      null,
      2
    )
    writeFileSync(out, body + '\n')

    const sha = createHash('sha256')
      .update(readFileSync(out, 'utf8'))
      .digest('hex')
    consola.success(`snapshot: ${docs.length} documents -> ${out}`)
    consola.info(`sha256: ${sha}`)
  },
})

const inspect = defineCommand({
  meta: {
    name: 'inspect',
    description: 'Describe a snapshot and verify it reads back (never writes)',
  },
  args: {
    file: { type: 'positional', description: 'Snapshot file', required: true },
  },
  async run({ args }) {
    const snap = JSON.parse(readFileSync(resolve(args.file), 'utf8'))
    const sha = createHash('sha256')
      .update(readFileSync(resolve(args.file), 'utf8'))
      .digest('hex')
    consola.info(`collection: ${snap.database}.${snap.collection}`)
    consola.info(`taken at:   ${snap.takenAt}`)
    consola.info(`documents:  ${snap.count}`)
    consola.info(`sha256:     ${sha}`)
    // Restoring is deliberately not automated: a blind replace would also revert whatever
    // legitimate deploys landed after the snapshot was taken. Reconcile by hand.
    consola.warn(
      'restoring is manual on purpose — replaying a whole snapshot would also undo deploys that landed after it was taken'
    )
  },
})

runMain(
  defineCommand({
    meta: { name: 'backup-deployment-logs' },
    subCommands: { backup, inspect },
  })
)
