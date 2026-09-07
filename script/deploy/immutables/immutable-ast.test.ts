/**
 * Tests for the AST-backed immutable enumerator.
 *
 * The artifacts are written by hand rather than produced by `forge build`, so the suite stays
 * Foundry-free and each fixture can pin one shape the reader has to get right. The shapes
 * themselves are copied from a real `forge build src --ast` run.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { afterEach, describe, expect, it } from 'bun:test'

import {
  findSourcesWithoutAst,
  readImmutableDeclarations,
} from './immutable-ast'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

/** A `VariableDeclaration` node as solc emits it. */
const variable = (
  name: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  nodeType: 'VariableDeclaration',
  mutability: 'immutable',
  name,
  visibility: 'public',
  src: '100:40:0',
  typeDescriptions: { typeString: 'address' },
  ...overrides,
})

/** Writes one artifact carrying `ast`, and returns the out directory. */
const artifactDirWith = (
  artifacts: { path: string; ast: unknown }[]
): string => {
  const outDir = mkdtempSync(join(tmpdir(), 'immutable-ast-'))
  temporaryDirectories.push(outDir)
  for (const { path, ast } of artifacts) {
    const full = join(outDir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, JSON.stringify({ ast }))
  }
  return outDir
}

const contractAst = (
  absolutePath: string,
  members: Record<string, unknown>[]
) => ({
  absolutePath,
  nodes: [{ nodeType: 'ContractDefinition', name: 'Sample', nodes: members }],
})

describe('readImmutableDeclarations', () => {
  it('reads an immutable with its type and visibility', () => {
    const outDir = artifactDirWith([
      {
        path: 'Sample.sol/Sample.json',
        ast: contractAst('src/Facets/Sample.sol', [
          variable('SPOKEPOOL', {
            typeDescriptions: { typeString: 'contract ISpokePool' },
          }),
        ]),
      },
    ])

    const { declarations } = readImmutableDeclarations(outDir)

    expect(declarations).toHaveLength(1)
    expect(declarations[0]).toMatchObject({
      file: 'src/Facets/Sample.sol',
      contract: 'Sample',
      name: 'SPOKEPOOL',
      type: 'contract ISpokePool',
      visibility: 'public',
    })
  })

  it('attributes each declaration to its own contract, not to the file', () => {
    // Registry entries are keyed by contract, so two contracts in one file must
    // not collapse onto the file's basename.
    const outDir = artifactDirWith([
      {
        path: 'Sample.sol/Sample.json',
        ast: {
          absolutePath: 'src/Facets/Sample.sol',
          nodes: [
            {
              nodeType: 'ContractDefinition',
              name: 'Sample',
              nodes: [variable('OWNER')],
            },
            {
              nodeType: 'ContractDefinition',
              name: 'SampleHelper',
              nodes: [variable('HELPER_OWNER', { src: '200:40:0' })],
            },
          ],
        },
      },
    ])

    const { declarations } = readImmutableDeclarations(outDir)

    expect(
      declarations.map(({ contract, name }) => [contract, name]).sort()
    ).toEqual([
      ['Sample', 'OWNER'],
      ['SampleHelper', 'HELPER_OWNER'],
    ])
  })

  it('reports the declaring source file for every artifact it read', () => {
    const outDir = artifactDirWith([
      {
        path: 'Sample.sol/Sample.json',
        ast: contractAst('src/Facets/Sample.sol', [variable('A')]),
      },
      {
        path: 'Other.sol/Other.json',
        ast: contractAst('src/Periphery/Other.sol', []),
      },
    ])

    const { sourceFiles } = readImmutableDeclarations(outDir)

    expect([...sourceFiles].sort()).toEqual([
      'src/Facets/Sample.sol',
      'src/Periphery/Other.sol',
    ])
  })

  it('ignores constants and plain state variables', () => {
    const outDir = artifactDirWith([
      {
        path: 'Sample.sol/Sample.json',
        ast: contractAst('src/Facets/Sample.sol', [
          variable('KEPT'),
          variable('A_CONSTANT', { mutability: 'constant' }),
          variable('MUTABLE_STATE', { mutability: 'mutable' }),
        ]),
      },
    ])

    const { declarations } = readImmutableDeclarations(outDir)

    expect(declarations.map((d) => d.name)).toEqual(['KEPT'])
  })

  it('counts one declaration when two artifacts share a source unit', () => {
    // A file with two contracts is emitted twice, each artifact carrying the same source-unit AST.
    const ast = contractAst('src/Facets/Sample.sol', [variable('SHARED')])
    const outDir = artifactDirWith([
      { path: 'Sample.sol/Sample.json', ast },
      { path: 'Sample.sol/Helper.json', ast },
    ])

    const { declarations } = readImmutableDeclarations(outDir)

    expect(declarations).toHaveLength(1)
  })

  it('resolves the line from a BYTE offset, not a character index', () => {
    // The AST reports byte positions, while reading a file as a string gives character indices,
    // and these sources carry non-ASCII characters in comments. Each em-dash below is three bytes
    // and one character; the banner is wide enough, and the lines under the declaration short
    // enough, that the accumulated drift carries a character-indexed reader clear past the right
    // line rather than merely to its edge — without that, both readings answer the same.
    const relativePath = 'src/Facets/Sample.sol'
    const banner = `// ${'— '.repeat(20)}`
    const lines = [
      banner,
      banner,
      banner,
      banner,
      'address public immutable X;',
      ...Array.from({ length: 10 }, (_, index) => `uint256 a${index};`),
    ]
    const preamble = lines.slice(0, 4).join('\n') + '\n'
    const byteOffset = Buffer.byteLength(preamble, 'utf8')
    // The drift has to exceed the lines below, or both readings would answer the same.
    expect(byteOffset - preamble.length).toBeGreaterThan(lines[4]?.length ?? 0)

    const root = mkdtempSync(join(tmpdir(), 'immutable-src-'))
    temporaryDirectories.push(root)
    mkdirSync(join(root, 'src/Facets'), { recursive: true })
    writeFileSync(join(root, relativePath), lines.join('\n'))

    const outDir = artifactDirWith([
      {
        path: 'Sample.sol/Sample.json',
        ast: contractAst(relativePath, [
          variable('X', { src: `${byteOffset}:26:0` }),
        ]),
      },
    ])

    // The reader resolves the source path relative to cwd, as it does in CI from the repo root.
    const originalCwd = process.cwd()
    let declarations
    try {
      process.chdir(root)
      ;({ declarations } = readImmutableDeclarations(outDir))
    } finally {
      process.chdir(originalCwd)
    }

    expect(declarations?.[0]?.line).toBe(5)
  })

  it('skips artifacts that are not JSON rather than aborting the walk', () => {
    const outDir = artifactDirWith([
      {
        path: 'Sample.sol/Sample.json',
        ast: contractAst('src/Facets/Sample.sol', [variable('KEPT')]),
      },
    ])
    writeFileSync(join(outDir, 'broken.json'), 'not json')

    expect(readImmutableDeclarations(outDir).declarations).toHaveLength(1)
  })

  it('returns nothing for a directory that does not exist', () => {
    expect(
      readImmutableDeclarations(join(tmpdir(), 'no-such-out-dir')).declarations
    ).toEqual([])
  })
})

describe('findSourcesWithoutAst', () => {
  it('names a tracked source the enumeration never saw', () => {
    expect(
      findSourcesWithoutAst(
        ['src/Facets/Seen.sol', 'src/Facets/Missed.sol'],
        new Set(['src/Facets/Seen.sol'])
      )
    ).toEqual(['src/Facets/Missed.sol'])
  })

  it('reports nothing when every source was enumerated', () => {
    expect(
      findSourcesWithoutAst(
        ['src/Facets/Seen.sol'],
        new Set(['src/Facets/Seen.sol'])
      )
    ).toEqual([])
  })
})
