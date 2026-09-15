/**
 * The guard's only failure mode is answering `false` for a run that really is direct: the CLI
 * then exits 0 having done nothing, which reads as a real empty result. The symlink cases below
 * are that bug — they are why the plain argv[1]/import.meta.url compare is not enough.
 */

import {
  mkdtempSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { isEntrypoint } from './is-entrypoint'

let realDir: string
let modulePath: string
let moduleUrl: string
let linkedFile: string
let linkedDirModule: string
let siblingPath: string

const originalArgv1 = process.argv[1]

beforeAll(() => {
  // realpathSync: on macOS the tmp root is itself a symlink, which would otherwise make every
  // case here look like the symlink case and hide a regression in the plain-path one.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'is-entrypoint-')))

  realDir = join(root, 'real')
  mkdirSync(realDir)

  modulePath = join(realDir, 'cli.ts')
  writeFileSync(modulePath, '')
  moduleUrl = pathToFileURL(modulePath).href

  siblingPath = join(realDir, 'other.ts')
  writeFileSync(siblingPath, '')

  linkedFile = join(root, 'cli-link.ts')
  symlinkSync(modulePath, linkedFile)

  symlinkSync(realDir, join(root, 'linkdir'))
  linkedDirModule = join(root, 'linkdir', 'cli.ts')
})

afterEach(() => {
  if (originalArgv1 === undefined) delete process.argv[1]
  else process.argv[1] = originalArgv1
})

describe('isEntrypoint', () => {
  it('is true when the module is executed by its real path', () => {
    process.argv[1] = modulePath
    expect(isEntrypoint(moduleUrl)).toBe(true)
  })

  it('is true when the module is reached through a symlinked file', () => {
    process.argv[1] = linkedFile
    expect(isEntrypoint(moduleUrl)).toBe(true)
  })

  it('is true when a directory component of the path is a symlink', () => {
    process.argv[1] = linkedDirModule
    expect(isEntrypoint(moduleUrl)).toBe(true)
  })

  it('is true when invoked by a relative path', () => {
    process.argv[1] = relative(process.cwd(), modulePath)
    expect(isEntrypoint(moduleUrl)).toBe(true)
  })

  it('is false when another module is the entrypoint, so importing does not launch the CLI', () => {
    process.argv[1] = siblingPath
    expect(isEntrypoint(moduleUrl)).toBe(false)
  })

  it('is false when there is no entry file at all', () => {
    delete process.argv[1]
    expect(isEntrypoint(moduleUrl)).toBe(false)
  })

  it('is false, not throwing, when the entry path does not exist', () => {
    process.argv[1] = join(realDir, 'missing.ts')
    expect(isEntrypoint(moduleUrl)).toBe(false)
  })
})
