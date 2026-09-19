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
})

/**
 * A guard nobody calls is not a guard. The openers are spread across five files
 * and the next one will be a sixth, so the invariant is pinned against the
 * directory rather than against today's list.
 */
describe('every SC_MONGODB_URI opener', () => {
  it('runs the transport check before constructing its client', () => {
    const directory = new URL('.', import.meta.url).pathname
    const unguarded = readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => {
        const source = readFileSync(join(directory, name), 'utf8')
        return (
          source.includes('SC_MONGODB_URI') &&
          source.includes('new MongoClient(') &&
          !source.includes('assertStoreCredentialsAreEncrypted(')
        )
      })

    expect(unguarded).toEqual([])
  })
})
