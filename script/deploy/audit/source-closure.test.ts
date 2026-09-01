/**
 * Unit tests for the source-closure primitive the audit gate compares on.
 * Everything runs against an in-memory reader — the closure must be computable
 * at a historical commit, so nothing may touch the working tree directly.
 */

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  collectSourceClosure,
  computeSourceClosureHash,
  parseImports,
  parseRemappings,
  resolveImport,
  type ISourceReader,
} from './source-closure'

const REMAPPINGS_TXT = [
  '@openzeppelin/=lib/openzeppelin-contracts/',
  'solady/=lib/solady/src/',
  'lifi/=src/',
  '',
].join('\n')

const remappings = parseRemappings(REMAPPINGS_TXT)

/** In-memory reader; `subs` maps a lib dir to its gitlink SHA at this tree-ish. */
const makeReader = (
  files: Record<string, string>,
  subs: Record<string, string> = {}
): ISourceReader => ({
  readFile: (path) => files[path],
  readSubmodulePointer: (path) => subs[path],
})

describe('parseImports', () => {
  it('reads a single-line named import', () => {
    expect(
      parseImports('import { ILiFi } from "../Interfaces/ILiFi.sol";')
    ).toEqual(['../Interfaces/ILiFi.sol'])
  })

  it('reads a bare import', () => {
    expect(parseImports('import "./Foo.sol";')).toEqual(['./Foo.sol'])
  })

  it('reads a namespace import', () => {
    expect(parseImports('import * as Foo from "./Foo.sol";')).toEqual([
      './Foo.sol',
    ])
  })

  it('reads a multi-line named import', () => {
    const source = [
      'import {',
      '  InformationMismatch,',
      '  InvalidConfig',
      '} from "../Errors/GenericErrors.sol";',
    ].join('\n')
    expect(parseImports(source)).toEqual(['../Errors/GenericErrors.sol'])
  })

  it('reads every import in a realistic header, in order', () => {
    const source = [
      '// SPDX-License-Identifier: LGPL-3.0-only',
      'pragma solidity ^0.8.17;',
      '',
      'import { ILiFi } from "../Interfaces/ILiFi.sol";',
      'import { LibAsset } from "../Libraries/LibAsset.sol";',
      'import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";',
      '',
      'contract Foo {}',
    ].join('\n')
    expect(parseImports(source)).toEqual([
      '../Interfaces/ILiFi.sol',
      '../Libraries/LibAsset.sol',
      '@openzeppelin/contracts/token/ERC20/IERC20.sol',
    ])
  })

  it('ignores an import inside a line comment', () => {
    expect(parseImports('// import { X } from "./Ghost.sol";')).toEqual([])
  })

  it('ignores an import inside a block comment', () => {
    const source = ['/*', ' import { X } from "./Ghost.sol";', '*/'].join('\n')
    expect(parseImports(source)).toEqual([])
  })

  it('does not treat a .sol string literal in code as an import', () => {
    expect(parseImports('string memory p = "./NotAnImport.sol";')).toEqual([])
  })

  it('handles single-quoted specifiers', () => {
    expect(parseImports("import { A } from '../A.sol';")).toEqual(['../A.sol'])
  })
})

describe('parseRemappings', () => {
  it('parses prefix=target pairs and ignores blank lines', () => {
    expect(parseRemappings(REMAPPINGS_TXT)).toEqual([
      { prefix: '@openzeppelin/', target: 'lib/openzeppelin-contracts/' },
      { prefix: 'solady/', target: 'lib/solady/src/' },
      { prefix: 'lifi/', target: 'src/' },
    ])
  })

  it('prefers the longest matching prefix, not the first', () => {
    const parsed = parseRemappings('a/=one/\na/b/=two/\n')
    expect(resolveImport('src/X.sol', 'a/b/C.sol', parsed)?.path).toBe(
      'two/C.sol'
    )
  })
})

describe('resolveImport', () => {
  it('resolves a relative parent import against the importer directory', () => {
    expect(
      resolveImport('src/Facets/Foo.sol', '../Interfaces/ILiFi.sol', remappings)
    ).toEqual({ path: 'src/Interfaces/ILiFi.sol', external: false })
  })

  it('resolves a same-directory import', () => {
    expect(
      resolveImport('src/Facets/Foo.sol', './Bar.sol', remappings)
    ).toEqual({ path: 'src/Facets/Bar.sol', external: false })
  })

  it('normalises a doubled-back path', () => {
    expect(
      resolveImport('src/a/b/Foo.sol', '../../c/Bar.sol', remappings)?.path
    ).toBe('src/c/Bar.sol')
  })

  it('resolves a remapping that points back into src as repo-owned', () => {
    expect(
      resolveImport('src/Foo.sol', 'lifi/Libraries/LibAsset.sol', remappings)
    ).toEqual({ path: 'src/Libraries/LibAsset.sol', external: false })
  })

  it('marks a remapping into lib/ as external and names the submodule dir', () => {
    expect(
      resolveImport(
        'src/Foo.sol',
        '@openzeppelin/contracts/token/ERC20/IERC20.sol',
        remappings
      )
    ).toEqual({
      path: 'lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol',
      external: true,
      submoduleDir: 'lib/openzeppelin-contracts',
    })
  })

  it('returns undefined for an unresolvable specifier', () => {
    expect(
      resolveImport('src/Foo.sol', 'unknown-pkg/Thing.sol', remappings)
    ).toBeUndefined()
  })
})

describe('collectSourceClosure', () => {
  it('walks the full transitive closure, not just direct imports', () => {
    const reader = makeReader({
      'src/Facets/Foo.sol': 'import { A } from "../Libraries/A.sol";',
      'src/Libraries/A.sol': 'import { B } from "./B.sol";',
      'src/Libraries/B.sol': 'contract B {}',
    })
    const closure = collectSourceClosure(
      'src/Facets/Foo.sol',
      reader,
      remappings
    )

    expect(closure.files).toEqual([
      'src/Facets/Foo.sol',
      'src/Libraries/A.sol',
      'src/Libraries/B.sol',
    ])
    expect(closure.missing).toEqual([])
  })

  it('is order-independent — files come back sorted', () => {
    const reader = makeReader({
      'src/Z.sol': 'import { A } from "./A.sol"; import { M } from "./M.sol";',
      'src/A.sol': 'contract A {}',
      'src/M.sol': 'contract M {}',
    })
    expect(collectSourceClosure('src/Z.sol', reader, remappings).files).toEqual(
      ['src/A.sol', 'src/M.sol', 'src/Z.sol']
    )
  })

  it('terminates on a circular import', () => {
    const reader = makeReader({
      'src/A.sol': 'import { B } from "./B.sol";',
      'src/B.sol': 'import { A } from "./A.sol";',
    })
    expect(collectSourceClosure('src/A.sol', reader, remappings).files).toEqual(
      ['src/A.sol', 'src/B.sol']
    )
  })

  it('records an external dependency by its submodule pointer, not its contents', () => {
    const reader = makeReader(
      {
        'src/Foo.sol':
          'import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";',
      },
      {
        'lib/openzeppelin-contracts':
          'e50c24f5839db17f46991478384bfda14acfb830',
      }
    )
    const closure = collectSourceClosure('src/Foo.sol', reader, remappings)

    // The external file is NOT walked: submodule contents are absent from the
    // parent repo tree at a historical commit.
    expect(closure.files).toEqual(['src/Foo.sol'])
    expect(closure.dependencies).toEqual({
      'lib/openzeppelin-contracts': 'e50c24f5839db17f46991478384bfda14acfb830',
    })
    expect(closure.missing).toEqual([])
  })

  it('reports a dependency absent at this commit as missing rather than throwing', () => {
    const reader = makeReader({
      'src/Foo.sol': 'import { LibSort } from "solady/utils/LibSort.sol";',
    })
    const closure = collectSourceClosure('src/Foo.sol', reader, remappings)

    expect(closure.dependencies).toEqual({})
    expect(closure.missing).toContain('lib/solady')
  })

  it('reports an unreadable repo file as missing', () => {
    const reader = makeReader({
      'src/Foo.sol': 'import { Gone } from "./Gone.sol";',
    })
    expect(
      collectSourceClosure('src/Foo.sol', reader, remappings).missing
    ).toContain('src/Gone.sol')
  })

  it('reports the entry point itself as missing when absent', () => {
    expect(
      collectSourceClosure('src/Nope.sol', makeReader({}), remappings).missing
    ).toEqual(['src/Nope.sol'])
  })
})

describe('computeSourceClosureHash', () => {
  const base = {
    'src/Foo.sol': 'import { A } from "./A.sol";',
    'src/A.sol': 'contract A { uint256 x; }',
  }

  const hashOf = (
    files: Record<string, string>,
    subs: Record<string, string> = {}
  ): string => {
    const reader = makeReader(files, subs)
    return computeSourceClosureHash(
      collectSourceClosure('src/Foo.sol', reader, remappings),
      reader
    )
  }

  it('is a 32-byte hex hash', () => {
    expect(hashOf(base)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('is stable across repeated computation', () => {
    expect(hashOf(base)).toBe(hashOf(base))
  })

  it('changes when a TRANSITIVELY imported file changes', () => {
    expect(hashOf(base)).not.toBe(
      hashOf({ ...base, 'src/A.sol': 'contract A { uint256 y; }' })
    )
  })

  it('changes when the entry file changes', () => {
    expect(hashOf(base)).not.toBe(
      hashOf({ ...base, 'src/Foo.sol': 'import { A } from "./A.sol"; // edit' })
    )
  })

  it('changes when an external dependency version changes', () => {
    const files = {
      'src/Foo.sol':
        'import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";',
    }
    expect(hashOf(files, { 'lib/openzeppelin-contracts': 'aaaa' })).not.toBe(
      hashOf(files, { 'lib/openzeppelin-contracts': 'bbbb' })
    )
  })

  it('is unaffected by a repo file OUTSIDE the closure', () => {
    expect(hashOf(base)).toBe(
      hashOf({ ...base, 'src/Unrelated.sol': 'contract Unrelated {}' })
    )
  })

  it("binds content to path — exchanging two leaves' contents changes the hash", () => {
    // Same path set and the same multiset of contents in both versions, with the
    // two leaves' bodies exchanged. A hash over concatenated contents alone
    // would be identical here, so this fails unless path is part of the preimage.
    const entry = 'import { A } from "./A.sol";\nimport { B } from "./B.sol";'
    const before = {
      'src/Foo.sol': entry,
      'src/A.sol': 'contract A { uint256 x; }',
      'src/B.sol': 'contract B { uint256 y; }',
    }
    const exchanged = {
      'src/Foo.sol': entry,
      'src/A.sol': 'contract B { uint256 y; }',
      'src/B.sol': 'contract A { uint256 x; }',
    }

    // Asserted, not just claimed: if these multisets ever diverge the test would
    // pass for the wrong reason, which is what it replaced.
    expect(Object.values(before).sort()).toEqual(
      Object.values(exchanged).sort()
    )
    expect(hashOf(before)).not.toBe(hashOf(exchanged))
  })
})

/**
 * Foundry resolves a non-relative, non-remapped specifier against `libs`
 * (`foundry.toml`: `libs = ["node_modules", "lib"]`), so a direct path into a
 * submodule is a legitimate import form. `src/Facets/EcoFacet.sol` uses one.
 */
describe('resolveImport — direct paths rooted at a libs entry', () => {
  const remappings = parseRemappings(
    '@openzeppelin/=lib/openzeppelin-contracts/\nforge-std/=lib/forge-std/src/\n'
  )

  it('resolves a direct lib/ path as an external submodule dependency', () => {
    const resolved = resolveImport(
      'src/Facets/EcoFacet.sol',
      'lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol',
      remappings
    )

    expect(resolved).toEqual({
      path: 'lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol',
      external: true,
      submoduleDir: 'lib/openzeppelin-contracts',
    })
  })

  it('resolves a direct node_modules/ path as external', () => {
    const resolved = resolveImport(
      'src/Facets/FooFacet.sol',
      'node_modules/@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol',
      remappings
    )

    expect(resolved?.external).toBe(true)
  })

  it('still returns undefined for a specifier matching no rule and no libs root', () => {
    expect(
      resolveImport('src/Facets/FooFacet.sol', 'nowhere/Thing.sol', remappings)
    ).toBeUndefined()
  })

  it('does not treat a src/-rooted specifier as external', () => {
    const resolved = resolveImport(
      'src/Facets/FooFacet.sol',
      'src/Libraries/LibAsset.sol',
      remappings
    )

    expect(resolved).toEqual({
      path: 'src/Libraries/LibAsset.sol',
      external: false,
    })
  })
})

/**
 * Comment stripping must understand string literals. A regex that does not can
 * span from a `/*` inside one string to a `*\/` inside a later one, dropping every
 * real import between them and adding nothing to `missing` — the hash is then
 * taken over an incomplete closure and drift in the dropped file is invisible.
 */
describe('parseImports — comment stripping is string-aware', () => {
  it('does not let a string-literal /* and a later */ swallow the imports between them', () => {
    const source = [
      'contract E {',
      '  string memory a = "/*";',
      '}',
      'import { A } from "./A.sol";',
      'contract F {',
      '  string memory b = "*/";',
      '}',
    ].join('\n')

    expect(parseImports(source)).toEqual(['./A.sol'])
  })

  it('does not treat the word import inside a string as an import', () => {
    const source = [
      'contract E {',
      '  string memory a = "please import { X } from somewhere";',
      '}',
      'import { B } from "./B.sol";',
    ].join('\n')

    expect(parseImports(source)).toEqual(['./B.sol'])
  })

  it('does not let a line-comment marker inside a string hide an import', () => {
    const source = [
      'contract E {',
      '  string memory url = "https://example.com";',
      '}',
      'import { C } from "./C.sol";',
    ].join('\n')

    expect(parseImports(source)).toEqual(['./C.sol'])
  })

  it('still ignores a genuinely commented-out import', () => {
    const source = [
      '// import { Dead } from "./Dead.sol";',
      '/* import { AlsoDead } from "./AlsoDead.sol"; */',
      'import { Live } from "./Live.sol";',
    ].join('\n')

    expect(parseImports(source)).toEqual(['./Live.sol'])
  })

  it('handles an escaped quote inside a string without losing track', () => {
    const source = [
      'contract E {',
      '  string memory a = "he said \\"/*\\" and left";',
      '}',
      'import { D } from "./D.sol";',
    ].join('\n')

    expect(parseImports(source)).toContain('./D.sol')
  })

  it('handles single-quoted strings', () => {
    const source = [
      'contract E {',
      "  string memory a = '/*';",
      '}',
      'import { E2 } from "./E2.sol";',
    ].join('\n')

    expect(parseImports(source)).toEqual(['./E2.sol'])
  })
})
