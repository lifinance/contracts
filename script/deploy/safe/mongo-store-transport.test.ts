import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { assertStoreCredentialsAreEncrypted } from './mongo-store-transport'

// Not a real credential anywhere: the guard reads only whether userinfo is
// present, so the fixtures say so in words.
const USER = 'a-user:a-password'

describe('assertStoreCredentialsAreEncrypted', () => {
  it('refuses credentials to a remote host over an unencrypted connection', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.internal.example:27017/?tls=false`
      )
    ).toThrow(/carries credentials to mongo.internal.example:27017/)
  })

  it('refuses a remote host that merely omits tls, rather than disabling it', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(`mongodb://${USER}@10.0.0.5:27017/`)
    ).toThrow(/unencrypted connection/)
  })

  it('refuses when only one host of a seed list is exposed, and names that one', () => {
    let message = ''
    try {
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@localhost:27017,mongo.example:27017/?tls=false`
      )
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('mongo.example:27017')
    expect(message).not.toContain('localhost:27017')
  })

  it('never puts the URI it refused into the message', () => {
    let message = ''
    try {
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/?tls=false`
      )
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('a-password')
    expect(message).not.toContain(USER)
  })

  it('accepts the credentialed loopback tunnel documented in Setup.md', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@localhost:27017/?directConnection=true&tls=false`
      )
    ).not.toThrow()
  })

  it('accepts a remote host once tls is on, however it was turned on', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/?tls=true`
      )
    ).not.toThrow()
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/?ssl=TRUE`
      )
    ).not.toThrow()
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb+srv://${USER}@cluster.example/`
      )
    ).not.toThrow()
  })

  it('refuses a +srv URI that turns tls back off against a remote host', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb+srv://${USER}@cluster.example/?tls=false`
      )
    ).toThrow(/unencrypted connection/)
  })

  // The classifier is the credential, not the host: an uncredentialed store has
  // nothing on the wire to protect, whatever its host or scheme.
  it('lets an uncredentialed URI through, remote or not', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted('mongodb://localhost:27017/')
    ).not.toThrow()
    expect(() =>
      assertStoreCredentialsAreEncrypted('mongodb://mongo.example:27017/')
    ).not.toThrow()
  })

  it('treats a password with no username as a credential', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        'mongodb://:a-password@mongo.example:27017/'
      )
    ).toThrow(/unencrypted connection/)
  })

  it('refuses a host that merely ends in .sock', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(`mongodb://${USER}@evil.sock:27017/`)
    ).toThrow(/unencrypted connection/)
  })

  it('accepts a percent-encoded unix socket', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@%2Ftmp%2Fmongo.sock/`
      )
    ).not.toThrow()
  })

  it('refuses a 127-prefixed host whose octets are not an address', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@127.999.999.999:27017/`
      )
    ).toThrow(/unencrypted connection/)
  })

  it('accepts the loopback spellings a resolver treats as the same interface', () => {
    for (const host of [
      'localhost.',
      '127.0.0.1',
      '127.1.2.3',
      '[::ffff:127.0.0.1]',
    ])
      expect(() =>
        assertStoreCredentialsAreEncrypted(`mongodb://${USER}@${host}:27017/`)
      ).not.toThrow()
  })

  it('reads a URI that arrived with surrounding whitespace', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `  mongodb://${USER}@localhost:27017/?tls=false\n`
      )
    ).not.toThrow()
  })

  it('refuses a URI it cannot parse rather than passing it through unchecked', () => {
    expect(() => assertStoreCredentialsAreEncrypted('not-a-uri')).toThrow(
      /not a MongoDB connection string/
    )
  })

  it('names the variable it was given, so a second store reports its own name', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/`,
        'MONGODB_URI'
      )
    ).toThrow(/^MONGODB_URI carries credentials/)
  })

  it('accepts IPv6 loopback in either spelling', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(`mongodb://${USER}@[::1]:27017/`)
    ).not.toThrow()
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@[0:0:0:0:0:0:0:1]:27017/`
      )
    ).not.toThrow()
  })

  // TLS that does not verify the peer protects the credentials from everyone
  // except whoever is worth defending against.
  it.each([
    'tlsInsecure',
    'tlsAllowInvalidCertificates',
    'tlsAllowInvalidHostnames',
  ])('refuses a remote host whose tls is relaxed by %s', (option) => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/?tls=true&${option}=true`
      )
    ).toThrow(/does not verify the peer/)
  })

  it('names the relaxing option, so the refusal says what to drop', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/?tls=true&tlsInsecure=true`
      )
    ).toThrow(/tlsInsecure/)
  })

  it('matches a relaxing option however it was spelled', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/?tls=true&TLSINSECURE=TRUE`
      )
    ).toThrow(/does not verify the peer/)
  })

  it('accepts a relaxing option that is turned off, or turned back off', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/?tls=true&tlsInsecure=false`
      )
    ).not.toThrow()
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/?tls=true&tlsInsecure=true&tlsInsecure=false`
      )
    ).not.toThrow()
  })

  // The wire still cannot leave the machine, so there is no peer to impersonate.
  it('leaves a relaxed loopback tunnel alone', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@localhost:27017/?tls=true&tlsInsecure=true`
      )
    ).not.toThrow()
  })

  // A relaxing option on an uncredentialed URI has no credential to strand.
  it('leaves a relaxed uncredentialed URI alone', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        'mongodb://mongo.example:27017/?tls=true&tlsInsecure=true'
      )
    ).not.toThrow()
  })

  // Mongo requires a literal `@` in userinfo to be percent-encoded, so this URI
  // is malformed. It must fail on the shape, before a host built out of the
  // second half of a password can reach the refusal message.
  it('refuses a second authority delimiter without echoing the password', () => {
    let message = ''
    try {
      assertStoreCredentialsAreEncrypted(
        'mongodb://a-user:pa@ss@mongo.example:27017/?tls=false'
      )
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/not a MongoDB connection string/)
    expect(message).not.toContain('ss@mongo.example')
    expect(message).not.toContain('mongo.example')
  })

  it('refuses a URI carrying a fragment rather than reading past it', () => {
    expect(() =>
      assertStoreCredentialsAreEncrypted(
        `mongodb://${USER}@mongo.example:27017/?tls=true#tls=false`
      )
    ).toThrow(/not a MongoDB connection string/)
  })
})

/**
 * A guard nobody calls is not a guard. The openers are spread across five files
 * and the next one will be a sixth, so the invariant is pinned against the tree
 * rather than against today's list.
 *
 * The scan is deliberately wider than the five: it walks all of `script/`, it
 * recognises the driver's static factory and a namespaced constructor as well
 * as `new MongoClient(`, and it compares positions so that a guard called after
 * the client is built still counts as unguarded. It cannot recognise an opener
 * that reaches the variable through a helper, which is the residual gap.
 */
describe('every SC_MONGODB_URI opener', () => {
  const CONSTRUCTIONS = [
    /\bnew MongoClient\(/,
    /\bnew [A-Za-z_$][\w$]*\.MongoClient\(/,
    /\bMongoClient\.connect\(/,
  ]

  const scriptFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) return scriptFiles(full)
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [full]
        : []
    })

  it('runs the transport check before constructing its client', () => {
    const scriptRoot = join(new URL('.', import.meta.url).pathname, '../..')

    const unguarded = scriptFiles(scriptRoot).filter((file) => {
      const source = readFileSync(file, 'utf8')
      if (!source.includes('SC_MONGODB_URI')) return false

      const builtAt = CONSTRUCTIONS.map((pattern) =>
        source.search(pattern)
      ).filter((index) => index >= 0)
      if (builtAt.length === 0) return false

      const guardedAt = source.indexOf('assertStoreCredentialsAreEncrypted(')
      return guardedAt < 0 || guardedAt > Math.min(...builtAt)
    })

    expect(unguarded).toEqual([])
  })
})
