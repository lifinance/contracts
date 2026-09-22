import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'

import {
  assertSafePathSegment,
  interpretResponse,
  resolveFlattenedPath,
  resolveSourcePath,
} from './tronscanVerify'

describe('assertSafePathSegment', () => {
  it('accepts bare network keys and contract names', () => {
    expect(() => assertSafePathSegment('tron', 'network')).not.toThrow()
    expect(() =>
      assertSafePathSegment('GenericSwapFacetV3', 'contract name')
    ).not.toThrow()
    expect(() => assertSafePathSegment('tronshasta', 'network')).not.toThrow()
  })

  it('rejects path traversal and separators', () => {
    for (const bad of ['..', '../etc', 'a/b', '/abs', 'a.sol', '', 'a b']) {
      expect(() => assertSafePathSegment(bad, 'network')).toThrow()
    }
  })
})

describe('interpretResponse', () => {
  it('treats status 2001 "validated" as success', () => {
    const body = JSON.stringify({
      code: 200,
      data: { status: 2001, message: 'The contract has been validated. ' },
    })
    const { ok, message } = interpretResponse(true, body)
    expect(ok).toBe(true)
    expect(message).toBe('The contract has been validated.')
  })

  it('treats the "Verification success." message as success', () => {
    const body = JSON.stringify({ data: { message: 'Verification success.' } })
    expect(interpretResponse(true, body).ok).toBe(true)
  })

  it('treats "already verified" as success', () => {
    const body = JSON.stringify({ data: { message: 'Already verified' } })
    expect(interpretResponse(true, body).ok).toBe(true)
  })

  it('treats "has already been verified" as success', () => {
    const body = JSON.stringify({
      data: { message: 'The contract has already been verified.' },
    })
    expect(interpretResponse(true, body).ok).toBe(true)
  })

  it('treats a queued contract as failure, not an "already" success', () => {
    const body = JSON.stringify({
      data: {
        message: 'The contract is already in the verification queue, wait',
      },
    })
    expect(interpretResponse(true, body).ok).toBe(false)
  })

  it('treats a negated success message as failure', () => {
    const body = JSON.stringify({
      data: { message: 'The contract is not already verified.' },
    })
    expect(interpretResponse(true, body).ok).toBe(false)
  })

  it('treats an unrecognised message as failure and prints it', () => {
    const body = JSON.stringify({
      data: { message: 'Validated the request, verification pending' },
    })
    const { ok, message } = interpretResponse(true, body)
    expect(ok).toBe(false)
    expect(message).toBe('Validated the request, verification pending')
  })

  it('treats a bytecode mismatch (2007) as failure', () => {
    const body = JSON.stringify({
      data: { status: 2007, message: 'Txxx verification failed. Please retry' },
    })
    const { ok, message } = interpretResponse(true, body)
    expect(ok).toBe(false)
    expect(message).toContain('verification failed')
  })

  it('fails on HTTP error even with a success-looking body', () => {
    const body = JSON.stringify({ data: { message: 'Verification success.' } })
    expect(interpretResponse(false, body).ok).toBe(false)
  })

  it('falls back to raw text for a non-JSON body, and does not call it success', () => {
    const prose = interpretResponse(true, 'contract validated ok')
    expect(prose.ok).toBe(false)
    expect(prose.message).toBe('contract validated ok')
    const fail = interpretResponse(true, 'gateway timeout')
    expect(fail.ok).toBe(false)
    expect(fail.message).toBe('gateway timeout')
  })

  // The typed shape says `message` is a string, but the server is not bound by
  // our types. A truthy non-string trips `.trim()` inside the parse block, so
  // the catch keeps the raw body and the run reports a failure to the operator
  // rather than throwing out of the verification loop.
  it('reports a failure, not a throw, when the server sends a non-string message', () => {
    for (const message of [2001, { code: 2001 }, ['ok'], true]) {
      const body = JSON.stringify({ data: { message } })
      const result = interpretResponse(true, body)
      expect(result.ok).toBe(false)
      expect(result.message).toBe(body)
    }
  })
})

describe('resolveFlattenedPath', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'flattened-'))
    mkdirSync(join(root, 'Facets'), { recursive: true })
    writeFileSync(join(root, 'Facets', 'Foo.sol'), '// fixture')
    writeFileSync(join(root, 'Bar.sol'), '// fixture')
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('finds a source in a mirrored subdirectory', () => {
    expect(resolveFlattenedPath(root, 'Foo')).toBe(join(root, 'Facets/Foo.sol'))
  })

  it('finds a source at the flattened root', () => {
    expect(resolveFlattenedPath(root, 'Bar')).toBe(join(root, 'Bar.sol'))
  })

  it('returns undefined when no source exists', () => {
    expect(resolveFlattenedPath(root, 'DoesNotExist')).toBeUndefined()
  })
})

describe('resolveSourcePath', () => {
  let repoRoot: string

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'repo-'))
    mkdirSync(join(repoRoot, 'src', 'Periphery'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'Periphery', 'Executor.sol'), '// x')
  })

  afterAll(() => rmSync(repoRoot, { recursive: true, force: true }))

  it('finds a contract under src/<subdir>', () => {
    expect(resolveSourcePath(repoRoot, 'Executor')).toBe(
      join(repoRoot, 'src/Periphery/Executor.sol')
    )
  })

  it('returns undefined for a missing contract', () => {
    expect(resolveSourcePath(repoRoot, 'Nope')).toBeUndefined()
  })
})
