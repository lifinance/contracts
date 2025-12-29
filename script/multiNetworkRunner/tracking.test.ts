import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { hashActionParams, loadTrackingStore } from './tracking'

const createTempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracking-test-'))
  return {
    dir,
    filePath: join(dir, 'tracking.json'),
  }
}

describe('tracking', () => {
  it('hashes action params deterministically', () => {
    const hashA = hashActionParams({ a: 1, b: 2 })
    const hashB = hashActionParams({ b: 2, a: 1 })
    expect(hashA).toBe(hashB)

    const arrayHash = hashActionParams({ list: [1, 2, 3] })
    expect(arrayHash.length).toBeGreaterThan(0)
  })

  it('initializes tracking store and updates entries', async () => {
    const { dir, filePath } = createTempFile()

    const store = loadTrackingStore({
      path: filePath,
      environment: 'production',
      actions: [{ id: 'action', label: 'Action', paramsHash: 'hash' }],
      networks: ['alpha'],
    })

    const actionKey = store.getActionKey('action', 'hash')
    expect(store.getTrackedNetworks()).toEqual(['alpha'])
    expect(store.getActionKeys()).toEqual([actionKey])
    store.startAction('alpha', actionKey)
    store.finishAction('alpha', actionKey, 'success')
    await store.save()

    const snapshot = store.getSnapshot()
    const alphaNetwork = snapshot.networks.alpha
    if (!alphaNetwork) throw new Error('Alpha network not found')
    expect(alphaNetwork.actions[actionKey]?.status).toBe('success')

    const stored = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(stored.environment).toBe('production')

    rmSync(dir, { recursive: true, force: true })
  })

  it('resets invalid tracking file', () => {
    const { dir, filePath } = createTempFile()
    writeFileSync(filePath, '{not-json', 'utf8')

    const store = loadTrackingStore({
      path: filePath,
      environment: 'staging',
      actions: [{ id: 'action', label: 'Action', paramsHash: 'hash' }],
      networks: ['alpha'],
    })

    const snapshot = store.getSnapshot()
    expect(snapshot.environment).toBe('staging')

    rmSync(dir, { recursive: true, force: true })
  })

  it('resets when environment mismatches', () => {
    const { dir, filePath } = createTempFile()
    const existing = {
      runId: 'run-1',
      environment: 'production',
      createdAt: new Date().toISOString(),
      actions: [],
      networks: {},
    }
    writeFileSync(filePath, JSON.stringify(existing), 'utf8')

    const store = loadTrackingStore({
      path: filePath,
      environment: 'staging',
      actions: [{ id: 'action', label: 'Action', paramsHash: 'hash' }],
      networks: ['alpha'],
    })

    expect(store.getSnapshot().environment).toBe('staging')

    rmSync(dir, { recursive: true, force: true })
  })

  it('skips completed actions', () => {
    const { dir, filePath } = createTempFile()

    const store = loadTrackingStore({
      path: filePath,
      environment: 'production',
      actions: [{ id: 'action', label: 'Action', paramsHash: 'hash' }],
      networks: ['alpha'],
    })

    const actionKey = store.getActionKey('action', 'hash')
    store.startAction('alpha', actionKey)
    store.finishAction('alpha', actionKey, 'success')

    expect(store.shouldSkip('alpha', actionKey)).toBeTrue()

    rmSync(dir, { recursive: true, force: true })
  })
})
