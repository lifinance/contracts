/**
 * Decision table for the content-equality audit check. Pure: the caller supplies
 * the head closure hash and, per audit entry, whatever could be resolved at that
 * entry's commit — so every branch is testable without git.
 */

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import type { Hex } from 'viem'

import type { IClosureDetail } from './source-closure'
import {
  classifyAuditEntry,
  verifyAuditContent,
  type IAuditEntryInput,
} from './verify-audit-content'

const HEAD = `0x${'a'.repeat(64)}` as Hex
const OTHER = `0x${'b'.repeat(64)}` as Hex
const SHA = 'c'.repeat(40)

/**
 * A closure detail carrying only a combined hash. With no per-file hashes and no
 * contract path, the caller cannot split the verdict, so these cases exercise
 * the combined comparison exactly as before.
 */
const combined = (hash: Hex): IClosureDetail => ({
  combined: hash,
  files: {},
  dependencies: {},
})

const withCommit = (
  over: Partial<IAuditEntryInput> = {}
): IAuditEntryInput => ({
  auditId: 'audit1',
  auditCommitHash: SHA,
  ...over,
})

describe('classifyAuditEntry', () => {
  it('recorded — the entry carries a sourceClosureHash', () => {
    expect(
      classifyAuditEntry(withCommit({ sourceClosureHash: OTHER })).kind
    ).toBe('recorded')
  })

  it('commit — a 40-hex auditCommitHash and no recorded hash', () => {
    expect(classifyAuditEntry(withCommit()).kind).toBe('commit')
  })

  it.each([
    ['n/a (This is a forked contract that was audited for Sushiswap)'],
    ['n/a (one deployed contract instance was audited)'],
    [''],
    ['not-a-hash'],
    ['c'.repeat(39)],
  ])('unverifiable — auditCommitHash %p is not a commit', (value) => {
    expect(
      classifyAuditEntry(withCommit({ auditCommitHash: value })).kind
    ).toBe('unverifiable')
  })

  it('prefers the recorded hash even when a commit is also present', () => {
    // The recorded hash is the cheaper and more direct comparison.
    expect(
      classifyAuditEntry(withCommit({ sourceClosureHash: HEAD })).kind
    ).toBe('recorded')
  })
})

describe('verifyAuditContent — passes', () => {
  it('recorded hash equals head', () => {
    const result = verifyAuditContent({
      contract: 'FooFacet',
      version: '1.0.0',
      headClosureHash: HEAD,
      entries: [withCommit({ sourceClosureHash: HEAD })],
    })

    expect(result.verdict).toBe('pass')
    expect(result.matchedAuditId).toBe('audit1')
  })

  it('closure recomputed at the audit commit equals head', () => {
    expect(
      verifyAuditContent({
        contract: 'FooFacet',
        version: '1.0.0',
        headClosureHash: HEAD,
        entries: [withCommit({ closureAtAuditCommit: combined(HEAD) })],
      }).verdict
    ).toBe('pass')
  })

  it('passes when ANY of several audits matches', () => {
    const result = verifyAuditContent({
      contract: 'FooFacet',
      version: '1.0.0',
      headClosureHash: HEAD,
      entries: [
        withCommit({ auditId: 'a1', closureAtAuditCommit: combined(OTHER) }),
        withCommit({ auditId: 'a2', closureAtAuditCommit: combined(HEAD) }),
      ],
    })

    expect(result.verdict).toBe('pass')
    expect(result.matchedAuditId).toBe('a2')
  })

  it('a pinned baseline equal to head passes', () => {
    expect(
      verifyAuditContent({
        contract: 'LiFiDEXAggregator',
        version: '1.0.0',
        headClosureHash: HEAD,
        entries: [
          withCommit({
            auditCommitHash: 'n/a (forked)',
            pinnedClosureHash: HEAD,
          }),
        ],
      }).verdict
    ).toBe('pass')
  })

  it('a clean revert passes with no title exemption — content is what matters', () => {
    // The revert restores byte-identical audited source, so the closure at the
    // audit commit equals head again.
    expect(
      verifyAuditContent({
        contract: 'FooFacet',
        version: '1.0.0',
        headClosureHash: HEAD,
        entries: [withCommit({ closureAtAuditCommit: combined(HEAD) })],
        prTitle: 'Revert "feat: something"',
      }).verdict
    ).toBe('pass')
  })
})

describe('verifyAuditContent — fails', () => {
  it('blocks when the recorded hash differs', () => {
    const result = verifyAuditContent({
      contract: 'FooFacet',
      version: '1.0.0',
      headClosureHash: HEAD,
      entries: [withCommit({ sourceClosureHash: OTHER })],
    })

    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('does not match')
  })

  it('blocks when the closure at the audit commit differs — the F24 case', () => {
    // Audited at commit X, then edited in commit Y inside the same PR.
    expect(
      verifyAuditContent({
        contract: 'FooFacet',
        version: '1.0.0',
        headClosureHash: HEAD,
        entries: [withCommit({ closureAtAuditCommit: combined(OTHER) })],
      }).verdict
    ).toBe('fail')
  })

  it('blocks a Revert-titled PR whose content does not match', () => {
    expect(
      verifyAuditContent({
        contract: 'FooFacet',
        version: '1.0.0',
        headClosureHash: HEAD,
        entries: [withCommit({ closureAtAuditCommit: combined(OTHER) })],
        prTitle: 'Revert "feat: unrelated code rides along"',
      }).verdict
    ).toBe('fail')
  })

  it('blocks when there is no audit entry at all', () => {
    const result = verifyAuditContent({
      contract: 'FooFacet',
      version: '9.9.9',
      headClosureHash: HEAD,
      entries: [],
    })

    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('no audit')
  })

  it('blocks a pinned baseline that no longer matches', () => {
    expect(
      verifyAuditContent({
        contract: 'LiFiDEXAggregator',
        version: '1.0.0',
        headClosureHash: HEAD,
        entries: [
          withCommit({
            auditCommitHash: 'n/a (forked)',
            pinnedClosureHash: OTHER,
          }),
        ],
      }).verdict
    ).toBe('fail')
  })
})

describe('verifyAuditContent — errors (T3: blocks like fail, no ack path)', () => {
  it('errors when the audit commit could not be fetched', () => {
    const result = verifyAuditContent({
      contract: 'FooFacet',
      version: '1.0.0',
      headClosureHash: HEAD,
      entries: [withCommit({ closureAtAuditCommit: 'unfetchable' })],
    })

    expect(result.verdict).toBe('error')
    expect(result.reason).toContain('could not be fetched')
  })

  it('errors when the contract is absent at the audit commit', () => {
    expect(
      verifyAuditContent({
        contract: 'FooFacet',
        version: '1.0.0',
        headClosureHash: HEAD,
        entries: [withCommit({ closureAtAuditCommit: 'contract-absent' })],
      }).verdict
    ).toBe('error')
  })

  it('errors on an unverifiable entry that has no pinned baseline', () => {
    const result = verifyAuditContent({
      contract: 'LiFiDEXAggregator',
      version: '1.0.0',
      headClosureHash: HEAD,
      entries: [withCommit({ auditCommitHash: 'n/a (forked)' })],
    })

    expect(result.verdict).toBe('error')
    expect(result.reason).toContain('pinned')
  })

  it('a PASS on another entry beats an ERROR on this one', () => {
    // An unreachable commit must not block when a different audit already
    // proves the content by hash.
    expect(
      verifyAuditContent({
        contract: 'FooFacet',
        version: '1.0.0',
        headClosureHash: HEAD,
        entries: [
          withCommit({ auditId: 'a1', closureAtAuditCommit: 'unfetchable' }),
          withCommit({ auditId: 'a2', sourceClosureHash: HEAD }),
        ],
      }).verdict
    ).toBe('pass')
  })

  it('an ERROR outranks a FAIL — infrastructure doubt is not a verdict', () => {
    expect(
      verifyAuditContent({
        contract: 'FooFacet',
        version: '1.0.0',
        headClosureHash: HEAD,
        entries: [
          withCommit({ auditId: 'a1', closureAtAuditCommit: combined(OTHER) }),
          withCommit({ auditId: 'a2', closureAtAuditCommit: 'unfetchable' }),
        ],
      }).verdict
    ).toBe('error')
  })
})

describe('closure-incomplete', () => {
  it('ERROR-blocks rather than comparing a partial closure', () => {
    const result = verifyAuditContent({
      contract: 'FooFacet',
      version: '1.0.0',
      headClosureHash: HEAD,
      entries: [withCommit({ closureAtAuditCommit: 'closure-incomplete' })],
    })

    expect(result.verdict).toBe('error')
    expect(result.reason).toContain('could not be fully read')
  })

  it('does not veto a different audit that does prove the content', () => {
    const result = verifyAuditContent({
      contract: 'FooFacet',
      version: '1.0.0',
      headClosureHash: HEAD,
      entries: [
        withCommit({ closureAtAuditCommit: 'closure-incomplete' }),
        withCommit({ auditId: 'audit2', closureAtAuditCommit: combined(HEAD) }),
      ],
    })

    expect(result.verdict).toBe('pass')
    expect(result.matchedAuditId).toBe('audit2')
  })
})

describe('verifyAuditContent closure-drift split', () => {
  const PATH = 'src/Periphery/ERC20Proxy.sol'
  const LIB = 'src/Libraries/LibBytes.sol'
  const OWN_A = `0x${'1'.repeat(64)}` as Hex
  const OWN_B = `0x${'2'.repeat(64)}` as Hex
  const LIB_A = `0x${'3'.repeat(64)}` as Hex
  const LIB_B = `0x${'4'.repeat(64)}` as Hex

  const detail = (
    combinedHash: Hex,
    own: Hex,
    lib: Hex,
    dependencies: Record<string, string> = {}
  ): IClosureDetail => ({
    combined: combinedHash,
    files: { [PATH]: own, [LIB]: lib },
    dependencies,
  })

  const run = (head: IClosureDetail, audited: IClosureDetail) =>
    verifyAuditContent({
      contract: 'ERC20Proxy',
      version: '1.2.0',
      headClosureHash: head.combined,
      headClosureDetail: head,
      contractPath: PATH,
      entries: [withCommit({ closureAtAuditCommit: audited })],
    })

  it('does not block when only an imported file moved', () => {
    const result = run(detail(HEAD, OWN_A, LIB_B), detail(OTHER, OWN_A, LIB_A))

    expect(result.verdict).toBe('closure-drift')
    expect(result.driftingDependencies).toEqual([LIB])
  })

  it('blocks when the contract own source moved, even if imports did not', () => {
    const result = run(detail(HEAD, OWN_B, LIB_A), detail(OTHER, OWN_A, LIB_A))

    expect(result.verdict).toBe('fail')
  })

  it('blocks when the own source moved alongside its imports', () => {
    const result = run(detail(HEAD, OWN_B, LIB_B), detail(OTHER, OWN_A, LIB_A))

    expect(result.verdict).toBe('fail')
  })

  it('counts a moved submodule as drift, which per-file hashes cannot see', () => {
    const result = run(
      detail(HEAD, OWN_A, LIB_A, { 'lib/solmate': 'aaa' }),
      detail(OTHER, OWN_A, LIB_A, { 'lib/solmate': 'bbb' })
    )

    expect(result.verdict).toBe('closure-drift')
    expect(result.driftingDependencies).toEqual(['lib/solmate'])
  })

  it('counts an import that appeared since the audit as drift', () => {
    const head: IClosureDetail = {
      combined: HEAD,
      files: { [PATH]: OWN_A, [LIB]: LIB_A },
      dependencies: {},
    }
    const audited: IClosureDetail = {
      combined: OTHER,
      files: { [PATH]: OWN_A },
      dependencies: {},
    }

    expect(run(head, audited).verdict).toBe('closure-drift')
  })

  it('falls back to blocking when no per-file detail is available', () => {
    // A caller that cannot supply detail must not get the softer verdict by
    // default — absence of evidence is not evidence the contract is unchanged.
    const result = verifyAuditContent({
      contract: 'ERC20Proxy',
      version: '1.2.0',
      headClosureHash: HEAD,
      contractPath: PATH,
      entries: [withCommit({ closureAtAuditCommit: combined(OTHER) })],
    })

    expect(result.verdict).toBe('fail')
  })

  it('blocks when the contract own file is absent from the audited closure', () => {
    const head = detail(HEAD, OWN_A, LIB_A)
    const audited: IClosureDetail = {
      combined: OTHER,
      files: { [LIB]: LIB_A },
      dependencies: {},
    }

    expect(run(head, audited).verdict).toBe('fail')
  })

  it('does not soften a real mismatch reported by another audit', () => {
    const result = verifyAuditContent({
      contract: 'ERC20Proxy',
      version: '1.2.0',
      headClosureHash: HEAD,
      headClosureDetail: detail(HEAD, OWN_A, LIB_B),
      contractPath: PATH,
      entries: [
        withCommit({
          auditId: 'drifted',
          closureAtAuditCommit: detail(OTHER, OWN_A, LIB_A),
        }),
        withCommit({
          auditId: 'changed',
          closureAtAuditCommit: detail(OTHER, OWN_B, LIB_A),
        }),
      ],
    })

    expect(result.verdict).toBe('fail')
  })
})
