/**
 * Tests for DeploymentCache refresh semantics (forced vs TTL-driven).
 * MongoDB is mocked, so no network connection is opened.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let mongoDocs: Record<string, unknown>[] = []
let mongoShouldFail = false
let connectCount = 0

// Snapshot: the module namespace is live and mock.module patches it in place
const realMongo = { ...(await import('mongodb')) }

mock.module('mongodb', () => ({
  ...realMongo,
  MongoClient: class {
    public async connect(): Promise<void> {
      connectCount++
      if (mongoShouldFail) throw new Error('mongo down')
    }
    public db() {
      return {
        collection: () => ({
          find: () => ({ toArray: async () => mongoDocs }),
        }),
      }
    }
    public async close(): Promise<void> {}
  },
}))

const { DeploymentCache } = await import('./deployment-cache')

const makeRecord = (contractName: string): Record<string, unknown> => ({
  contractName,
  network: 'mainnet',
  version: '1.0.0',
  address: '0x0000000000000000000000000000000000000001',
  timestamp: new Date(0).toISOString(),
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
})

afterAll(() => {
  mock.module('mongodb', () => realMongo)
})

describe('DeploymentCache refresh', () => {
  let cacheDir: string
  let cache: InstanceType<typeof DeploymentCache>

  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(tmpdir(), 'deployment-cache-test-'))
    cache = new DeploymentCache({
      cacheDir,
      ttl: 5 * 60 * 1000,
      mongoConfig: {
        mongoUri: 'mongodb://unused',
        databaseName: 'db',
        batchSize: 100,
      },
    })
    connectCount = 0
    mongoShouldFail = false
    mongoDocs = [makeRecord('OldFacet'), makeRecord('NewFacet')]

    // Fresh cache (metadata younger than TTL) that misses NewFacet
    writeFileSync(
      path.join(cacheDir, 'deployments_production.json'),
      JSON.stringify([makeRecord('OldFacet')])
    )
    writeFileSync(
      path.join(cacheDir, 'deployments_production.metadata.json'),
      JSON.stringify({
        lastRefresh: new Date().toISOString(),
        environment: 'production',
        recordCount: 1,
        version: '1.0.0',
      })
    )
  })

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('force refresh fetches inside the TTL and returns a newer record', async () => {
    const records = await cache.refresh('production', { force: true })
    expect(connectCount).toBe(1)
    expect(records.map((r) => r.contractName)).toContain('NewFacet')
  })

  it('refresh without force returns cached records inside the TTL', async () => {
    const records = await cache.refresh('production')
    expect(connectCount).toBe(0)
    expect(records.map((r) => r.contractName)).toEqual(['OldFacet'])
  })

  it('get with forceRefresh fetches inside the TTL', async () => {
    const records = await cache.get('production', { forceRefresh: true })
    expect(connectCount).toBe(1)
    expect(records.map((r) => r.contractName)).toContain('NewFacet')
  })

  it('forced refresh falls back to the stale cache on a MongoDB error', async () => {
    mongoShouldFail = true
    const records = await cache.refresh('production', { force: true })
    expect(connectCount).toBe(1)
    expect(records.map((r) => r.contractName)).toEqual(['OldFacet'])
  })
})
