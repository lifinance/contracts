import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  READ_ONLY_RUN,
  isSealedReadOnly,
  proveSealRefusesWrites,
  RehearsalWriteRefusedError,
  runRehearsalPreflight,
  sealCollectionReadOnly,
} from './rehearsal-write-guard'

describe('sealCollectionReadOnly', () => {
  it('refuses insertOne without reaching the underlying collection', () => {
    const reached: string[] = []
    const underlying = {
      insertOne: () => {
        reached.push('insertOne')
        return Promise.resolve({})
      },
    }

    const sealed = sealCollectionReadOnly(underlying)

    const probe = sealed as unknown as Record<
      string,
      (() => unknown) | undefined
    >
    expect(() => probe.insertOne?.()).toThrow(/refused/i)
    expect(reached).toEqual([])
  })
})

describe('proveSealRefusesWrites', () => {
  it('reports every canary write method as refused', () => {
    const evidence = proveSealRefusesWrites()

    expect(evidence.length).toBeGreaterThan(0)
    expect(evidence.every((probe) => probe.refused)).toBe(true)
    expect(evidence.map((probe) => probe.method)).toContain('insertOne')
    expect(evidence.map((probe) => probe.method)).toContain('createIndex')
  })
})

describe('isSealedReadOnly', () => {
  it('tells a sealed handle apart from the collection it wraps', () => {
    const underlying = { findOne: () => Promise.resolve(null) }

    expect(isSealedReadOnly(underlying)).toBe(false)
    expect(isSealedReadOnly(sealCollectionReadOnly(underlying))).toBe(true)
  })
})

/** [CONV:TEST-ASSERT-REJECTS] — awaiting Bun's `.rejects` trips await-thenable. */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp
): Promise<void> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(
      match
    )
    return
  }
  throw new Error(`expected a rejection matching ${String(match)}`)
}

describe('runRehearsalPreflight', () => {
  it('aborts a write-configured run before the store is ever opened', async () => {
    const opened: string[] = []

    await expectRejects(
      runRehearsalPreflight({
        config: { ...READ_ONLY_RUN, sign: true },
        openStore: () => {
          opened.push('open')
          return Promise.resolve({})
        },
      }),
      /sign/
    )

    expect(opened).toEqual([])
  })

  it('names every enabled write capability, not only the first', async () => {
    await expectRejects(
      runRehearsalPreflight({
        config: { ...READ_ONLY_RUN, sign: true, reconcileBackfill: true },
        openStore: () => Promise.resolve({}),
      }),
      /sign.*reconcileBackfill|reconcileBackfill.*sign/
    )
  })

  it('hands back a sealed store that refuses writes on a read-only run', async () => {
    const reached: string[] = []
    const underlying = {
      findOne: () => Promise.resolve(null),
      updateOne: () => {
        reached.push('updateOne')
        return Promise.resolve({})
      },
    }

    const preflight = await runRehearsalPreflight({
      config: READ_ONLY_RUN,
      openStore: () => Promise.resolve(underlying),
    })

    expect(isSealedReadOnly(preflight.store)).toBe(true)
    expect(preflight.evidence.every((probe) => probe.refused)).toBe(true)
    const probe = preflight.store as unknown as Record<
      string,
      (() => unknown) | undefined
    >
    expect(() => probe.updateOne?.()).toThrow(RehearsalWriteRefusedError)
    expect(reached).toEqual([])
  })
})

describe('proveSealRefusesWrites, against a seal that does not seal', () => {
  it('refuses, naming the methods that ran and reached the target', () => {
    const identitySeal = <T extends object>(collection: T): T => collection

    let thrown: Error | undefined
    try {
      proveSealRefusesWrites(identitySeal)
    } catch (error: unknown) {
      thrown = error as Error
    }

    expect(thrown?.message).toMatch(/not in force/)
    expect(thrown?.message).toMatch(/insertOne/)
    expect(thrown?.message).toMatch(/createIndex/)
  })

  it('records reachedTarget for a method that ran', () => {
    const halfSeal = <T extends object>(collection: T): T =>
      new Proxy(collection, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (property === 'insertOne') return value
          return () => {
            throw new RehearsalWriteRefusedError(String(property))
          }
        },
      })

    let thrown: Error | undefined
    try {
      proveSealRefusesWrites(halfSeal)
    } catch (error: unknown) {
      thrown = error as Error
    }

    expect(thrown?.message).toMatch(/insertOne/)
    expect(thrown?.message).not.toMatch(/createIndex/)
  })
})
