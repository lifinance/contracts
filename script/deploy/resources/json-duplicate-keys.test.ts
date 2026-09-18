/**
 * Unit tests for the duplicate-key scanner.
 *
 * The suite holds documents that must be flagged and documents that must not, so
 * a scanner that flagged everything — or nothing — fails rather than passing
 * half of it.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { findDuplicateKeys, formatDuplicateKey } from './json-duplicate-keys'

describe('findDuplicateKeys', () => {
  it('reports nothing for a document whose keys are all distinct', () => {
    expect(
      findDuplicateKeys('{"a": 1, "b": {"a": 2}, "c": [{"a": 3}]}')
    ).toEqual([])
  })

  it('flags a repeated key at the document root', () => {
    const duplicates = findDuplicateKeys('{\n  "a": 1,\n  "b": 2,\n  "a": 3\n}')

    expect(duplicates).toEqual([{ path: '$', key: 'a', line: 4 }])
  })

  it('names the object that holds the repeat, not the root', () => {
    const duplicates = findDuplicateKeys(
      '{\n  "outer": {\n    "inner": {\n      "x": 1,\n      "x": 2\n    }\n  }\n}'
    )

    expect(duplicates).toEqual([{ path: '$.outer.inner', key: 'x', line: 5 }])
  })

  it('indexes the array element a repeat sits in', () => {
    const duplicates = findDuplicateKeys(
      '{"items": [{"a": 1}, {"a": 1, "a": 2}]}'
    )

    expect(duplicates).toEqual([{ path: '$.items[1]', key: 'a', line: 1 }])
  })

  it('does not flag the same key in two sibling objects', () => {
    expect(
      findDuplicateKeys('{"first": {"shared": 1}, "second": {"shared": 2}}')
    ).toEqual([])
  })

  it('does not read a key out of a string value', () => {
    // The value is a JSON document in its own right, duplicate key included. A
    // scanner that ignored string boundaries would flag the outer object.
    expect(
      findDuplicateKeys('{"a": "{\\"b\\": 1, \\"b\\": 2}", "c": 3}')
    ).toEqual([])
  })

  it('does not treat a colon inside a string as a key separator', () => {
    expect(findDuplicateKeys('{"a": "x: 1", "b": "x: 2"}')).toEqual([])
  })

  it('treats an escaped key as the key it decodes to', () => {
    const duplicates = findDuplicateKeys('{"a": 1, "\\u0061": 2}')

    expect(duplicates).toEqual([{ path: '$', key: 'a', line: 1 }])
  })

  it('reports every repeat when a key appears three times', () => {
    const duplicates = findDuplicateKeys('{\n"a": 1,\n"a": 2,\n"a": 3\n}')

    expect(duplicates).toEqual([
      { path: '$', key: 'a', line: 3 },
      { path: '$', key: 'a', line: 4 },
    ])
  })

  it('counts lines past a multi-line document, so later repeats point at the right line', () => {
    const duplicates = findDuplicateKeys(
      ['{', '  "a": {', '    "b": 1', '  },', '  "a": 2', '}'].join('\n')
    )

    expect(duplicates).toEqual([{ path: '$', key: 'a', line: 5 }])
  })

  it('flags a top-level array element that repeats a key', () => {
    expect(findDuplicateKeys('[{"a": 1, "a": 2}]')).toEqual([
      { path: '$[0]', key: 'a', line: 1 },
    ])
  })

  /**
   * A contract keyed twice in a deploy-requirements file, where the losing copy
   * is the only place a requirement is declared. `JSON.parse` sees one key, so
   * the assertions below pin both what a gate reading the file gets and what the
   * scanner reports.
   */
  it('flags the contract-declared-twice shape, which JSON.parse reports as one key', () => {
    const file = [
      '{',
      '  "EcoFacet": {',
      '    "configData": {',
      '      "_portal": { "configFileName": "eco.json" },',
      '      "_backendSigner": { "configFileName": "global.json" }',
      '    }',
      '  },',
      '  "LidoWrapper": {',
      '    "configData": {}',
      '  },',
      '  "EcoFacet": {',
      '    "configData": {',
      '      "_portal": { "configFileName": "eco.json" }',
      '    }',
      '  }',
      '}',
    ].join('\n')

    expect(Object.keys(JSON.parse(file) as Record<string, unknown>)).toEqual([
      'EcoFacet',
      'LidoWrapper',
    ])
    const parsed = JSON.parse(file) as { EcoFacet: { configData: object } }
    expect(parsed.EcoFacet.configData).not.toHaveProperty('_backendSigner')

    expect(findDuplicateKeys(file)).toEqual([
      { path: '$', key: 'EcoFacet', line: 11 },
    ])
  })
})

describe('formatDuplicateKey', () => {
  it('names the file, the line of the repeat, and the object holding it', () => {
    const message = formatDuplicateKey('script/deploy/resources/x.json', {
      path: '$.EcoFacet.configData',
      key: '_portal',
      line: 42,
    })

    expect(message).toContain('script/deploy/resources/x.json:42')
    expect(message).toContain("'_portal'")
    expect(message).toContain('$.EcoFacet.configData')
  })
})
