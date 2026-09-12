/**
 * Proves a verify rehearsal cannot write, rather than intending not to.
 *
 * The risk a rehearsal carries is not signing — that is a deliberate act nobody
 * performs by accident. It is an incidental write: an index ensured on connect,
 * an acknowledgement recorded, a reconcile back-fill promoting a row. So the
 * guard refuses by default and the preflight *demonstrates* the refusal by
 * reaching for the refused members, instead of asserting that a flag was not
 * passed.
 */

/** Raised when a rehearsal reaches a member that could lead to a write. */
export class RehearsalWriteRefusedError extends Error {
  public constructor(public readonly method: string) {
    super(
      `Rehearsal refused '${method}': the verify rehearsal is read-only, and this method could mutate the Safe proposal store.`
    )
    this.name = 'RehearsalWriteRefusedError'
  }
}

/**
 * The collection methods a rehearsal is allowed to reach.
 *
 * An allow-list of reads rather than a deny-list of writes: a deny-list is
 * silently outgrown by the next driver release, and the method it fails to name
 * is then the one that writes. Anything absent here refuses, so a method nobody
 * has classified is refused rather than permitted.
 */
const PERMITTED_READ_METHODS: ReadonlySet<string> = new Set([
  'find',
  'findOne',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'indexes',
  'listIndexes',
])

/**
 * Wraps a collection so nothing that could reach a write runs.
 *
 * The allow-list governs every property, not just the callable ones. A driver
 * `Collection` carries its `MongoClient` on `.client` and its `Db` under `.s`,
 * and either one re-derives an unsealed collection — so handing back an object
 * property because it is not itself a function hands back the whole write
 * surface. Object-valued properties are therefore refused outright.
 *
 * Primitives pass through: `collectionName` and `dbName` identify the handle and
 * reach nothing. An absent property stays `undefined` rather than becoming a
 * throwing stub, because the language probes for members that do not exist —
 * `await` reads `then`, and a handle that threw on it could not be awaited.
 *
 * @param collection - the live collection to seal
 * @returns a proxy with the same shape that refuses anything that could write
 */
/**
 * Members the language itself reaches for when rendering a value.
 *
 * Answered with a harmless label rather than a throwing stub. Without this, any
 * log line, template literal or `JSON.stringify` that touches a sealed handle
 * crashes the run with a refusal about `toString` — the guard taking down the
 * run it was protecting, reported as a write attempt that never happened.
 */
const RENDERING_MEMBERS: ReadonlySet<string> = new Set([
  'toString',
  'valueOf',
  'toJSON',
])

export const sealCollectionReadOnly = <T extends object>(collection: T): T => {
  const label = '[read-only sealed collection]'
  const sealed = new Proxy(collection, {
    get(target, property) {
      if (typeof property === 'string' && RENDERING_MEMBERS.has(property))
        return () => label
      // The receiver is the target, never the proxy: a driver getter such as
      // `collectionName` reads its own internals to answer, and with the proxy
      // as receiver that read comes back through this trap and is refused —
      // the seal would reject the very properties it means to allow.
      const value = Reflect.get(target, property, target)
      if (value === undefined || value === null) return value

      if (typeof value === 'function') {
        if (
          typeof property === 'string' &&
          PERMITTED_READ_METHODS.has(property)
        )
          return value.bind(target)

        return () => {
          throw new RehearsalWriteRefusedError(String(property))
        }
      }

      if (typeof value === 'object')
        throw new RehearsalWriteRefusedError(String(property))

      return value
    },
  })
  SEALED_HANDLES.add(sealed)
  return sealed
}

/**
 * The handles this module sealed.
 *
 * Identity is tracked rather than inferred, because a proxy is indistinguishable
 * from its target by inspection — anything a caller could test for, a plain
 * collection would answer the same way.
 */
const SEALED_HANDLES = new WeakSet<object>()

/**
 * Whether `handle` was produced by {@link sealCollectionReadOnly}.
 *
 * @param handle - the collection handle a rehearsal is about to read through
 * @returns true only for a handle this module sealed
 */
export const isSealedReadOnly = (handle: object): boolean =>
  SEALED_HANDLES.has(handle)

/**
 * The methods the proof calls, drawn from what this repo actually writes with.
 *
 * `createIndex` is on the list because it is the write nobody asks for:
 * `getSafeMongoCollection` ensures two unique indexes on connect, so merely
 * opening the store the normal way mutates it. A rehearsal must therefore reach
 * the collection by another route, and this entry is what keeps that true.
 */
const CANARY_WRITE_METHODS: readonly string[] = [
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'bulkWrite',
  'createIndex',
  'createIndexes',
  'dropIndex',
  'drop',
  'rename',
]

/**
 * The non-function properties a driver `Collection` carries that lead back to a
 * write handle.
 *
 * Probed alongside the methods because the seal's first version refused only
 * callables and handed `client` back untouched — a live `MongoClient`, from
 * which an unsealed collection is one call away. A proof that covers only the
 * methods would have passed that version.
 */
const CANARY_ESCAPE_PROPERTIES: readonly string[] = ['client', 's']

/** One canary member, and whether the seal refused it. */
export interface IWriteRefusalProbe {
  readonly method: string
  readonly refused: boolean
  /** Set when the method ran instead of refusing — the failure this proof exists to catch. */
  readonly reachedTarget: boolean
}

/**
 * Demonstrates that the seal refuses every canary write, and refuses to proceed
 * when it does not.
 *
 * Probes a canary object rather than the live collection. Calling `insertOne`
 * on a live handle to find out whether it is sealed would insert a row on
 * exactly the run where the guard was missing — the proof would cause the
 * accident it exists to prevent. So this proves the *mechanism*, and
 * {@link isSealedReadOnly} ties the live handle to it.
 *
 * @param seal - the sealer under test; the real one unless a caller is proving
 * that this proof can fail, which is the only way its refusal branch is ever
 * reached — a proof that cannot fail measures nothing
 * @returns one entry per canary method, all refused
 * @throws When any canary method ran instead of refusing
 */
export const proveSealRefusesWrites = (
  seal: <T extends object>(collection: T) => T = sealCollectionReadOnly
): readonly IWriteRefusalProbe[] => {
  const reached: string[] = []
  const canary: Record<string, unknown> = Object.fromEntries(
    CANARY_WRITE_METHODS.map((method) => [
      method,
      () => {
        reached.push(method)
      },
    ])
  )
  // Stand-ins for the driver's own handles: any object reached here is a route
  // back to an unsealed collection, so the probe only has to reach one.
  for (const property of CANARY_ESCAPE_PROPERTIES)
    canary[property] = { db: () => undefined }

  const sealed = seal(canary) as unknown as Record<string, () => unknown>

  const evidence = [
    ...CANARY_WRITE_METHODS.map((method) => {
      try {
        sealed[method]?.()
        return {
          method,
          refused: false,
          reachedTarget: reached.includes(method),
        }
      } catch (error: unknown) {
        if (!(error instanceof RehearsalWriteRefusedError)) throw error
        return { method, refused: true, reachedTarget: false }
      }
    }),
    ...CANARY_ESCAPE_PROPERTIES.map((property) => {
      try {
        const escaped = sealed[property]
        return {
          method: property,
          refused: false,
          reachedTarget: escaped !== undefined,
        }
      } catch (error: unknown) {
        if (!(error instanceof RehearsalWriteRefusedError)) throw error
        return { method: property, refused: true, reachedTarget: false }
      }
    }),
  ]

  const unrefused = evidence.filter((probe) => !probe.refused)
  if (unrefused.length)
    throw new Error(
      `Rehearsal write guard is not in force: ${unrefused
        .map((probe) => probe.method)
        .join(
          ', '
        )} was reachable instead of refusing. Nothing may read the proposal store on this run.`
    )

  return evidence
}

/**
 * The write surfaces a verify rehearsal must leave switched off.
 *
 * Named one per surface rather than as a single `readOnly` boolean so the
 * refusal can say which one was on. The last two are the incidental writes the
 * guard exists for: neither is anything an operator would think of as "writing",
 * and both mutate the proposal store.
 */
export interface IRehearsalRunConfig {
  readonly sign: boolean
  readonly execute: boolean
  readonly propose: boolean
  /** Persisting the acknowledgement ledger back onto the rows it graded. */
  readonly persistAcknowledgements: boolean
  /** Reconcile promoting `submitted` rows it observed on chain. */
  readonly reconcileBackfill: boolean
}

/** Every write surface off — what a rehearsal must run with. */
export const READ_ONLY_RUN: IRehearsalRunConfig = {
  sign: false,
  execute: false,
  propose: false,
  persistAcknowledgements: false,
  reconcileBackfill: false,
}

/** What the preflight established, and the sealed handle it established it for. */
export interface IRehearsalPreflightResult<T> {
  readonly store: T
  readonly evidence: readonly IWriteRefusalProbe[]
}

/**
 * Refuses a run configured to write, before it can open anything.
 *
 * Every enabled capability is named, not just the first: an operator who
 * switches two off one at a time learns about the second only after another
 * refused run.
 *
 * @param config - the resolved run configuration
 * @throws When any write surface is enabled
 */
export const assertRehearsalCannotWrite = (
  config: IRehearsalRunConfig
): void => {
  const enabled = Object.entries(config)
    .filter(([, value]) => value)
    .map(([capability]) => capability)

  if (enabled.length)
    throw new Error(
      `Rehearsal refused: this is a read-only verify rehearsal, but the run enables ${enabled.join(
        ', '
      )}. Nothing has been opened and nothing has been written.`
    )
}

/**
 * The rehearsal's preflight: prove the run cannot write, then open the store.
 *
 * The order is the whole point. The configuration is refused before
 * `openStore` is called, so a write-configured run aborts having touched
 * nothing — not even the index-ensuring connect that
 * `getSafeMongoCollection` performs.
 *
 * @param input.config - the resolved run configuration
 * @param input.openStore - opens the proposal store; must not itself write
 * @returns the sealed store and the refusal evidence
 * @throws When the run is write-configured, or the seal is not in force
 */
export const runRehearsalPreflight = async <T extends object>(input: {
  config: IRehearsalRunConfig
  openStore: () => Promise<T>
}): Promise<IRehearsalPreflightResult<T>> => {
  assertRehearsalCannotWrite(input.config)
  const evidence = proveSealRefusesWrites()

  const store = sealCollectionReadOnly(await input.openStore())
  if (!isSealedReadOnly(store))
    throw new Error(
      'Rehearsal refused: the proposal store handed to the run is not sealed read-only.'
    )

  return { store, evidence }
}
