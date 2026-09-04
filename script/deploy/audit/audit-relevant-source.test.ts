import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { normaliseAuditRelevantSource } from './audit-relevant-source'

const lines = (source: string): string[] =>
  normaliseAuditRelevantSource(source).split('\n').filter(Boolean)

describe('normaliseAuditRelevantSource', () => {
  it('drops the licence line, which is what invalidated every prior audit', () => {
    // `c37da94a2` normalised SPDX headers repo-wide. Hashing raw bytes made
    // every contract differ from its audit for a change to one comment.
    const before = '// SPDX-License-Identifier: LGPL-3.0-only\ncontract A {}'
    const after =
      '// SPDX-License-Identifier: LGPL-3.0-only OR MIT\ncontract A {}'

    expect(normaliseAuditRelevantSource(before)).toBe(
      normaliseAuditRelevantSource(after)
    )
    expect(lines(before)).toEqual(['contract A {}'])
  })

  it.each([
    ['a line comment', '// a note'],
    ['an indented line comment', '    // a note'],
    ['a tab-indented line comment', '\t// a note'],
    ['a block-comment opener', '/** @notice something */'],
    ['an indented block opener', '  /* something'],
    ['a pragma', 'pragma solidity ^0.8.17;'],
    ['an indented pragma', '  pragma abicoder v2;'],
    ['a blank line', ''],
    ['a whitespace-only line', '   \t '],
  ])('drops %s', (_label, line) => {
    expect(lines(`contract A {\n${line}\n}`)).toEqual(['contract A {', '}'])
  })

  it.each([
    ['a trailing comment on a code line', 'uint256 x = 1; // why'],
    ['a block-comment body line', ' * @param a the thing'],
    ['a string containing slashes', 'string memory s = "//not a comment";'],
    ['an identifier beginning with pragma', 'uint256 pragmatic = 1;'],
  ])(
    'keeps %s, mirroring the workflow rather than improving on it',
    (_label, line) => {
      // The workflow's filter is line-based. A stricter normaliser here would
      // make the content check and the version-bump check disagree about what an
      // audit covers, which is worse than inheriting a known gap.
      expect(lines(`contract A {\n${line}\n}`)).toEqual([
        'contract A {',
        line,
        '}',
      ])
    }
  )

  it('still sees a real code change', () => {
    // The property that keeps F24 closed: normalisation must not swallow code.
    const before = 'contract A {\n  uint256 x = 1;\n}'
    const after = 'contract A {\n  uint256 x = 2;\n}'

    expect(normaliseAuditRelevantSource(before)).not.toBe(
      normaliseAuditRelevantSource(after)
    )
  })

  it('is unchanged by reformatting that only moves comments around', () => {
    const spread = [
      '// SPDX-License-Identifier: MIT',
      '',
      'pragma solidity ^0.8.17;',
      '',
      '/// @custom:version 1.0.0',
      'contract A {',
      '  uint256 x = 1;',
      '}',
    ].join('\n')
    const dense = [
      '// SPDX-License-Identifier: LGPL-3.0-only',
      'pragma solidity ^0.8.29;',
      '/// @custom:version 9.9.9',
      'contract A {',
      '  uint256 x = 1;',
      '}',
    ].join('\n')

    // Note what this implies and is meant to: the version tag is a comment, so
    // the closure hash does not see it. Version is the version-control check's
    // job, and duplicating it here would make a version bump alone look like a
    // code change.
    expect(normaliseAuditRelevantSource(spread)).toBe(
      normaliseAuditRelevantSource(dense)
    )
  })

  it('leaves source with nothing to strip byte-identical', () => {
    const source = 'contract A {\n  uint256 x = 1;\n}'

    expect(normaliseAuditRelevantSource(source)).toBe(source)
  })
})
