import { inspect } from 'node:util'

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

describe('sealCollectionReadOnly, on the object properties a real driver carries', () => {
  it('refuses a property that leads back to an unsealed write handle', () => {
    const underlying = {
      findOne: () => Promise.resolve(null),
      // A real mongodb Collection exposes `.client` (the MongoClient) and `.s`
      // (internal state holding the Db). Either one re-derives an unsealed
      // collection, so reaching them is reaching a write surface.
      client: {
        db: () => ({ collection: () => ({ deleteMany: () => 'wrote' }) }),
      },
    }

    const sealed = sealCollectionReadOnly(underlying) as unknown as Record<
      string,
      unknown
    >

    expect(() => sealed.client).toThrow(RehearsalWriteRefusedError)
  })

  it('still hands back the harmless primitives a caller needs', () => {
    const sealed = sealCollectionReadOnly({
      collectionName: 'pendingTransactions',
      dbName: 'sc_private',
    }) as unknown as Record<string, unknown>

    expect(sealed.collectionName).toBe('pendingTransactions')
    expect(sealed.dbName).toBe('sc_private')
  })

  it('leaves an absent property undefined so the sealed handle can be awaited', async () => {
    const sealed = sealCollectionReadOnly({
      findOne: () => Promise.resolve(null),
    })

    expect((sealed as unknown as Record<string, unknown>).then).toBeUndefined()
    expect(await Promise.resolve(sealed)).toBe(sealed)
  })

  it('does not permit aggregate, which can write via $out and $merge', () => {
    const sealed = sealCollectionReadOnly({
      aggregate: () => 'ran',
    }) as unknown as Record<string, () => unknown>

    expect(() => sealed.aggregate?.()).toThrow(RehearsalWriteRefusedError)
  })
})

describe('proveSealRefusesWrites, over the escape properties', () => {
  it('probes the object properties that re-derive an unsealed handle', () => {
    const evidence = proveSealRefusesWrites()

    expect(evidence.map((probe) => probe.method)).toContain('client')
    expect(evidence.map((probe) => probe.method)).toContain('s')
    expect(evidence.every((probe) => probe.refused)).toBe(true)
  })

  it('fails when a seal lets an escape property through', () => {
    const methodsOnlySeal = <T extends object>(collection: T): T =>
      new Proxy(collection, {
        get(target, property) {
          const value = Reflect.get(target, property, target)
          if (typeof value !== 'function') return value
          return () => {
            throw new RehearsalWriteRefusedError(String(property))
          }
        },
      })

    let thrown: Error | undefined
    try {
      proveSealRefusesWrites(methodsOnlySeal)
    } catch (error: unknown) {
      thrown = error as Error
    }

    expect(thrown?.message).toMatch(/client/)
  })
})

describe('a sealed handle in a log line', () => {
  it('renders instead of crashing the run it was guarding', () => {
    const sealed = sealCollectionReadOnly({
      collectionName: 'pendingTransactions',
      s: { db: {} },
      findOne: () => Promise.resolve(null),
    })

    expect(() => `${String(sealed)}`).not.toThrow()
    expect(() => JSON.stringify(sealed)).not.toThrow()
  })
})

describe('sealCollectionReadOnly, on what a permitted read hands back', () => {
  const cursorShapedCollection = () => {
    const cursor: Record<string, unknown> = {
      client: { db: () => 'unsealed' },
      parent: { deleteMany: () => 'wrote' },
      toArray: () => Promise.resolve([{ _id: 1 }, { _id: 2 }]),
    }
    cursor.sort = () => cursor
    cursor.collation = () => cursor
    return { find: () => cursor }
  }

  it('refuses the client the cursor re-exports', () => {
    const sealed = sealCollectionReadOnly(
      cursorShapedCollection()
    ) as unknown as {
      find: () => Record<string, unknown>
    }

    expect(() => sealed.find().client).toThrow(RehearsalWriteRefusedError)
    expect(() => sealed.find().parent).toThrow(RehearsalWriteRefusedError)
  })

  it('keeps refusing after the cursor is chained', () => {
    interface ISealedCursor {
      sort: () => ISealedCursor
      collation: () => ISealedCursor
      client: unknown
      parent: unknown
    }
    const sealed = sealCollectionReadOnly(
      cursorShapedCollection()
    ) as unknown as { find: () => ISealedCursor }

    expect(() => sealed.find().sort().client).toThrow(
      RehearsalWriteRefusedError
    )
    expect(() => sealed.find().collation().sort().parent).toThrow(
      RehearsalWriteRefusedError
    )
  })

  it('still returns the documents the read was for', async () => {
    const sealed = sealCollectionReadOnly(
      cursorShapedCollection()
    ) as unknown as {
      find: () => { toArray: () => Promise<unknown[]> }
    }

    expect(await sealed.find().toArray()).toHaveLength(2)
  })
})

describe('sealCollectionReadOnly, against a descriptor read', () => {
  it('hands back a descriptor that does not carry the handle', () => {
    const sealed = sealCollectionReadOnly({
      client: { db: () => 'unsealed' },
      findOne: () => Promise.resolve(null),
    })

    const descriptor = Object.getOwnPropertyDescriptor(sealed, 'client')

    // Redacted rather than refused outright: throwing here would take down
    // `Object.keys` and `for…in`, which read descriptors but never values.
    expect(descriptor?.value).not.toEqual({ db: expect.any(Function) })
    expect(() => (descriptor?.value as () => unknown)()).toThrow(
      RehearsalWriteRefusedError
    )
  })
})

describe('sealCollectionReadOnly, when something enumerates or renders it', () => {
  const withObjectProps = () =>
    sealCollectionReadOnly({
      s: { db: { client: 'SECRET' } },
      client: { id: 'CLIENT' },
      collectionName: 'pendingTransactions',
      findOne: () => Promise.resolve(null),
    })

  it('lets the key-only enumerations work', () => {
    const sealed = withObjectProps()

    expect(Object.keys(sealed)).toContain('client')
    expect(() => {
      for (const _key in sealed) void _key
    }).not.toThrow()
  })

  it('still refuses an enumeration that reads the values', () => {
    // Spread and `Object.entries` go through `get`, so they are asking for the
    // handle itself. Refusing is the point; only the key-only paths above are
    // expected to work.
    expect(() => ({ ...withObjectProps() })).toThrow(RehearsalWriteRefusedError)
    expect(() => Object.entries(withObjectProps())).toThrow(
      RehearsalWriteRefusedError
    )
  })

  it('does not print the wrapped target when inspected', () => {
    const rendered = inspect(withObjectProps())

    expect(rendered).not.toContain('SECRET')
    expect(rendered).not.toContain('CLIENT')
  })
})

describe('sealCollectionReadOnly, on a cursor a permitted read returns', () => {
  it('refuses a cursor internal that resolves to a live server handle', () => {
    const sealed = sealCollectionReadOnly({
      find: () => ({
        toArray: () => Promise.resolve([{ _id: 1 }]),
        _initialize: () =>
          Promise.resolve({ server: { command: () => 'wrote' } }),
      }),
    }) as unknown as { find: () => Record<string, () => unknown> }

    expect(() => sealed.find()._initialize?.()).toThrow(
      RehearsalWriteRefusedError
    )
  })

  it('still allows the cursor methods a read needs', async () => {
    const sealed = sealCollectionReadOnly({
      find: () => ({
        toArray: () => Promise.resolve([{ _id: 1 }, { _id: 2 }]),
      }),
    }) as unknown as { find: () => { toArray: () => Promise<unknown[]> } }

    expect(await sealed.find().toArray()).toHaveLength(2)
  })
})
