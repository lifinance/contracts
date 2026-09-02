/**
 * Fixtures are the view the validator sees: `configData` as
 * `deployRequirements.json` writes it (keyed by free-form label) joined with the
 * `immutables` entries from `immutableRegistry.json` (keyed by the immutable's
 * own name). The CLI merges the two files; the validator only ever sees this.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IImmutableDeclaration } from './immutable-declarations'
import { validateImmutableRegistry } from './registry-schema'

const declared = (
  name: string,
  file = 'src/Facets/AcrossFacet.sol'
): IImmutableDeclaration => ({ file, line: 20, type: 'address', name })

const CONFIG_DATA = { _spokePool: {}, _wrappedNativeAddress: {} }

describe('validateImmutableRegistry', () => {
  it('accepts a config-sourced immutable linked to an existing label', () => {
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: {
          spokePool: { source: 'config', configData: '_spokePool' },
        },
      },
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('errors when the link points at a label that does not exist', () => {
    // The link is the whole point of the section — the three spellings of one
    // binding do not match, so a broken link is a broken registry, not an
    // authoring gap. It blocks even in warn-only mode.
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: {
          spokePool: { source: 'config', configData: '_notARealLabel' },
        },
      },
    })

    expect(result.warnings).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('_notARealLabel')
    expect(result.errors[0]).toContain('AcrossFacet')
  })

  it('warns, and does not error, for an immutable with no entry', () => {
    // The authoring gap. Warn-only until part (ii) lands, per the ordering
    // constraint that the hard fail comes after the pass.
    const result = validateImmutableRegistry(
      [declared('spokePool'), declared('wrappedNative')],
      {
        AcrossFacet: {
          configData: CONFIG_DATA,
          immutables: {
            spokePool: { source: 'config', configData: '_spokePool' },
          },
        },
      }
    )

    expect(result.errors).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('wrappedNative')
    expect(result.warnings[0]).toContain('src/Facets/AcrossFacet.sol:20')
  })

  it('errors on an entry for an immutable that no longer exists', () => {
    // A rename leaves an expectation nothing checks. That is not an authoring
    // gap either — the registry is asserting something false.
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: {
          spokePool: { source: 'config', configData: '_spokePool' },
          removedThing: { source: 'config', configData: '_spokePool' },
        },
      },
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/removedThing/)
    expect(result.errors[0]).toMatch(/no longer declared|does not declare/)
  })

  it.each([
    ['derived', { source: 'derived', rule: 'the ERC20Proxy on this network' }],
    [
      'unchecked',
      { source: 'unchecked', reason: 'a test-only helper address' },
    ],
    [
      'unverifiable',
      { source: 'unverifiable', reason: 'written to a mapping' },
    ],
  ])('accepts a %s immutable without a config link', (_label, entry) => {
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: { spokePool: entry },
      },
    })

    expect(result.errors).toEqual([])
  })

  it.each([
    ['unchecked', 'unchecked'],
    ['unverifiable', 'unverifiable'],
  ])('errors when a %s entry gives no reason', (_label, source) => {
    // Whoever reads the drift report has to know why something is exempt. An
    // exemption with no reason is the hole F6 exists to close.
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: { spokePool: { source } },
      },
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/reason/i)
  })

  it('errors when a derived entry gives no rule', () => {
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: { spokePool: { source: 'derived' } },
      },
    })

    expect(result.errors[0]).toMatch(/rule/i)
  })

  it('errors on a source it does not recognise, rather than ignoring it', () => {
    // A typo in `source` would otherwise make an immutable silently exempt.
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: {
          spokePool: { source: 'confg', configData: '_spokePool' },
        },
      },
    })

    expect(result.errors[0]).toMatch(/confg/)
  })

  it('carries the authority-bearing marker without requiring it', () => {
    // D20: the marker exists so the drift report can flag these; it does not
    // gate on a new approver tier.
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: {
          spokePool: {
            source: 'config',
            configData: '_spokePool',
            authorityBearing: true,
          },
        },
      },
    })

    expect(result.errors).toEqual([])
    expect(result.authorityBearing).toEqual(['AcrossFacet.spokePool'])
  })

  it('treats a contract with no immutables section as entirely unauthored', () => {
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: { configData: CONFIG_DATA },
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })

  it('warns for a contract absent from the requirements file entirely', () => {
    const result = validateImmutableRegistry(
      [declared('POOL_MANAGER', 'src/Facets/BrandNewFacet.sol')],
      {}
    )

    expect(result.errors).toEqual([])
    expect(result.warnings[0]).toContain('BrandNewFacet')
  })
})

describe('values that look right in JSON but are not', () => {
  it('errors on a quoted authority marker instead of reading it as unflagged', () => {
    // JSON has no way to warn you: `"true"` is a string, and the previous check
    // (`=== true`) silently dropped it — leaving an authority-bearing immutable
    // unflagged in the drift report, which is the one place it must appear.
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: {
          spokePool: {
            source: 'config',
            configData: '_spokePool',
            authorityBearing: 'true',
          },
        },
      },
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/not a boolean/)
    expect(result.authorityBearing).toEqual([])
  })

  it('still accepts an honestly false marker', () => {
    const result = validateImmutableRegistry([declared('spokePool')], {
      AcrossFacet: {
        configData: CONFIG_DATA,
        immutables: {
          spokePool: {
            source: 'config',
            configData: '_spokePool',
            authorityBearing: false,
          },
        },
      },
    })

    expect(result.errors).toEqual([])
    expect(result.authorityBearing).toEqual([])
  })

  it.each(['toString', 'constructor', 'hasOwnProperty'])(
    'errors when the config link is the inherited property %p',
    (inherited) => {
      // `in` walks the prototype chain, so these passed against any object at
      // all and the registry accepted a link to a config key that does not
      // exist. Same bug this repo hit in the CBOR decoder the same day.
      const result = validateImmutableRegistry([declared('spokePool')], {
        AcrossFacet: {
          configData: CONFIG_DATA,
          immutables: {
            spokePool: { source: 'config', configData: inherited },
          },
        },
      })

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain(inherited)
    }
  )
})
