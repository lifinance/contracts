#!/usr/bin/env bun

/**
 * Repair Deployment Records
 *
 * Two one-off repairs surfaced by the fleet reproducibility sweep:
 *
 *   attest  — records with no build provenance at all get a `reproducibility` subdocument
 *             naming a commit and profile that rebuild to the deployed bytecode.
 *   profile — records whose stored `solcVersion` contradicts the compiler the deployed
 *             bytecode itself declares get the stored value corrected.
 *
 * Both default to a dry run and both require a snapshot taken by
 * `backup-deployment-logs.ts`, which they check actually contains every record they are
 * about to touch — a repair you cannot roll back is not a repair.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient, type Collection, type WithId } from 'mongodb'

import { getEnvVar } from '../utils/utils'

import { type IDeploymentRecord } from './shared/mongo-log-utils'

const DATABASE_NAME = 'contract-deployments'

/**
 * Stamped on every attested record so a consumer can tell where the provenance came from,
 * and so a future method can be distinguished from this one. The prose describing what the
 * method does and what it does NOT prove lives in the payload file, once.
 */
const ATTESTATION_METHOD = 'wp-7.1-fleet-reproducibility-sweep'

interface IAttestation {
  network: string
  address: string
  contractName: string
  version: string
  commit: string
  solcVersion: string
  evmVersion: string
  optimizerRuns: string
}

interface IProfileFix {
  network: string
  address: string
  contractName: string
  version: string
  /** Field values the record must currently hold, or it is skipped as already-changed. */
  expect: Partial<
    Pick<IDeploymentRecord, 'solcVersion' | 'evmVersion' | 'gitCommitHash'>
  >
  set: Partial<
    Pick<IDeploymentRecord, 'solcVersion' | 'evmVersion' | 'gitCommitHash'>
  >
  evidence: string
}

/** Identity of one deployment record. Address casing varies by source, so compare folded. */
function key(r: {
  network: string
  address: string
  contractName: string
  version: string
}): string {
  return [r.network, r.address.toLowerCase(), r.contractName, r.version].join(
    '|'
  )
}

function loadSnapshotKeys(file: string, collection: string): Set<string> {
  const snap = JSON.parse(readFileSync(resolve(file), 'utf8'))
  // A snapshot of a different collection cannot roll this repair back, and the mismatch
  // that matters is against the collection being written — not against 'production'.
  if (snap.collection !== collection)
    throw new Error(
      `snapshot is of collection '${snap.collection}' but the repair targets '${collection}'`
    )
  return new Set(
    (snap.documents as IDeploymentRecord[]).map((d) =>
      key({
        network: d.network,
        address: String(d.address ?? ''),
        contractName: d.contractName,
        version: d.version,
      })
    )
  )
}

/**
 * The same contract+version can appear more than once on a network (a redeploy to a new
 * address), so the address is part of the identity — but its casing varies by source and
 * Mongo compares strings exactly. Index the whole collection once, folded, rather than
 * issuing a query per row.
 */
async function buildIndex(
  col: Collection<IDeploymentRecord>
): Promise<Map<string, WithId<IDeploymentRecord>[]>> {
  const index = new Map<string, WithId<IDeploymentRecord>[]>()
  for (const d of await col.find({}).toArray()) {
    const k = key({
      network: d.network,
      address: String(d.address ?? ''),
      contractName: d.contractName,
      version: d.version,
    })
    const bucket = index.get(k) ?? []
    bucket.push(d)
    index.set(k, bucket)
  }
  return index
}

function lookup(
  index: Map<string, WithId<IDeploymentRecord>[]>,
  t: { network: string; contractName: string; version: string; address: string }
): WithId<IDeploymentRecord> | 'none' | 'ambiguous' {
  const hits = index.get(key(t)) ?? []
  const [first] = hits
  if (!first) return 'none'
  if (hits.length > 1) return 'ambiguous'
  return first
}

/** Reads a field the typed record does not declare (e.g. the attestation subdocument). */
function field(doc: WithId<IDeploymentRecord>, name: string): unknown {
  return (doc as unknown as Record<string, unknown>)[name]
}

async function withCollection<T>(
  collectionName: string,
  fn: (c: Collection<IDeploymentRecord>) => Promise<T>
): Promise<T> {
  const client = new MongoClient(getEnvVar('MONGODB_URI'))
  await client.connect()
  try {
    return await fn(
      client.db(DATABASE_NAME).collection<IDeploymentRecord>(collectionName)
    )
  } finally {
    await client.close()
  }
}

const sharedArgs = {
  collection: {
    type: 'string' as const,
    description: 'Collection',
    default: 'production',
  },
  backup: {
    type: 'string' as const,
    description:
      'Snapshot from backup-deployment-logs.ts covering every targeted record',
    required: true,
  },
  apply: {
    type: 'boolean' as const,
    description: 'Write. Without it the command only reports what it would do',
    default: false,
  },
}

const attest = defineCommand({
  meta: {
    name: 'attest',
    description:
      'Attach reproducibility attestations to records that have no commit recorded',
  },
  args: {
    ...sharedArgs,
    file: {
      type: 'string',
      description: 'Attestation payload',
      default: 'script/deploy/resources/reproducibilityAttestations.json',
    },
    refresh: {
      type: 'boolean',
      description:
        'Replace an existing attestation when the payload names a different commit. Without it, already-attested records are left alone',
      default: false,
    },
  },
  async run({ args }) {
    const payload = JSON.parse(readFileSync(resolve(args.file), 'utf8'))
    const rows: IAttestation[] = payload.attestations
    const snapshot = loadSnapshotKeys(args.backup, args.collection)
    consola.info(
      `${rows.length} attestations | snapshot holds ${snapshot.size} records`
    )

    await withCollection(args.collection, async (col) => {
      const index = await buildIndex(col)
      let wouldWrite = 0
      let wouldRefresh = 0
      let missing = 0
      let ambiguous = 0
      let alreadyHasCommit = 0
      let alreadyAttested = 0
      let notInBackup = 0

      for (const a of rows) {
        const doc = lookup(index, a)
        if (doc === 'none') {
          missing++
          consola.warn(
            `no record: ${a.network}/${a.contractName}@${a.version} ${a.address}`
          )
          continue
        }
        if (doc === 'ambiguous') {
          ambiguous++
          consola.warn(
            `ambiguous: ${a.network}/${a.contractName}@${a.version} ${a.address}`
          )
          continue
        }
        // An attestation is inferred evidence; a commit the pipeline actually recorded is
        // primary. Never let the weaker source overwrite the stronger one.
        if (doc.gitCommitHash && doc.gitCommitHash !== 'UNKNOWN') {
          alreadyHasCommit++
          continue
        }
        const existing = field(doc, 'reproducibility') as
          | { attestedCommit?: string }
          | undefined
        let refreshing = false
        if (existing) {
          // A re-selected payload can name a better commit than an earlier run did — the
          // earliest reproducing commit rather than an arbitrary descendant of it. That is
          // an improvement worth writing, but only on request, and only when it differs.
          if (!args.refresh || existing.attestedCommit === a.commit) {
            alreadyAttested++
            continue
          }
          refreshing = true
        }
        if (!snapshot.has(key(a))) {
          notInBackup++
          continue
        }
        if (refreshing) wouldRefresh++
        else wouldWrite++
        if (args.apply)
          await col.updateOne(
            { _id: doc._id },
            {
              $set: {
                reproducibility: {
                  attestedCommit: a.commit,
                  attestedProfile: {
                    solcVersion: a.solcVersion,
                    evmVersion: a.evmVersion,
                    optimizerRuns: a.optimizerRuns,
                  },
                  attestedAt: payload.generatedAt,
                  // An identifier, not prose. The method and its caveat are the same for
                  // every row, so they live once in the payload file rather than being
                  // copied into several hundred documents.
                  method: ATTESTATION_METHOD,
                },
                updatedAt: new Date(),
              },
            }
          )
      }

      consola.box(
        [
          `${
            args.apply ? 'WROTE (new)' : 'would write (new)'
          }:     ${wouldWrite}`,
          `${args.apply ? 'WROTE (refreshed)' : 'would refresh'}:${
            args.apply ? '  ' : '        '
          }${wouldRefresh}`,
          `skipped — no matching record:        ${missing}`,
          `skipped — ambiguous match:           ${ambiguous}`,
          `skipped — already has a real commit: ${alreadyHasCommit}`,
          `skipped — already attested:          ${alreadyAttested}`,
          `skipped — not covered by snapshot:   ${notInBackup}`,
        ].join('\n')
      )
      if (notInBackup)
        consola.error(
          'some targets are absent from the snapshot — take a fresh backup first'
        )
      if (!args.apply) consola.info('dry run; pass --apply to write')
    })
  },
})

const profile = defineCommand({
  meta: {
    name: 'profile',
    description:
      'Correct stored build profiles that contradict the deployed bytecode',
  },
  args: {
    ...sharedArgs,
    file: {
      type: 'string',
      description: 'Profile corrections',
      default: 'script/deploy/resources/deploymentProfileCorrections.json',
    },
  },
  async run({ args }) {
    const payload = JSON.parse(readFileSync(resolve(args.file), 'utf8'))
    const rows: IProfileFix[] = payload.corrections
    const snapshot = loadSnapshotKeys(args.backup, args.collection)
    consola.info(
      `${rows.length} corrections | snapshot holds ${snapshot.size} records`
    )

    await withCollection(args.collection, async (col) => {
      const index = await buildIndex(col)
      let wouldWrite = 0
      let missing = 0
      let drifted = 0
      let notInBackup = 0

      for (const f of rows) {
        const doc = lookup(index, f)
        if (doc === 'none' || doc === 'ambiguous') {
          missing++
          consola.warn(
            `${doc}: ${f.network}/${f.contractName}@${f.version} ${f.address}`
          )
          continue
        }
        // The correction was derived against a specific stored value. If the record has
        // moved since, the derivation no longer applies and a blind write would clobber
        // whoever moved it.
        const mismatched = Object.entries(f.expect).filter(
          ([k, v]) => field(doc, k) !== v
        )
        if (mismatched.length) {
          drifted++
          consola.warn(
            `drifted, skipping: ${f.network}/${f.contractName}@${
              f.version
            } — expected ${JSON.stringify(f.expect)}, found ${JSON.stringify(
              Object.fromEntries(mismatched.map(([k]) => [k, field(doc, k)]))
            )}`
          )
          continue
        }
        if (!snapshot.has(key(f))) {
          notInBackup++
          continue
        }
        wouldWrite++
        consola.info(
          `${args.apply ? 'fixing' : 'would fix'} ${f.network}/${
            f.contractName
          }@${f.version}: ${JSON.stringify(f.set)} — ${f.evidence}`
        )
        if (args.apply)
          await col.updateOne(
            { _id: doc._id },
            { $set: { ...f.set, updatedAt: new Date() } }
          )
      }

      consola.box(
        [
          `${args.apply ? 'WROTE' : 'would write'}: ${wouldWrite}`,
          `skipped — no matching record:      ${missing}`,
          `skipped — record drifted:          ${drifted}`,
          `skipped — not covered by snapshot: ${notInBackup}`,
        ].join('\n')
      )
      if (!args.apply) consola.info('dry run; pass --apply to write')
    })
  },
})

runMain(
  defineCommand({
    meta: { name: 'repair-deployment-records' },
    subCommands: { attest, profile },
  })
)
