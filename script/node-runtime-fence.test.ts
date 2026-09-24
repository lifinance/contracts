/**
 * Whether the Node-runtime fence (`.eslintrc.node-runtime.cjs`) refuses each
 * Bun-only API in a shipped module, lets the Node equivalents through, and
 * leaves `*.test.ts` alone.
 *
 * Each case feeds a candidate to the real ESLint CLI on stdin under a virtual
 * path, so nothing is written into the tree: a probe file left behind by a
 * crashed run would itself fail the fence in CI.
 */

import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')
const FENCE_CONFIG = './.eslintrc.node-runtime.cjs'
const SHIPPED_PATH = 'script/tasks/someCli.ts'

/** Fragment every refusal message of the fence starts with. */
const REFUSAL = 'Shipped modules run on Node via `bunx tsx`'

/** 90 seconds: an ESLint run plus a cold bun start, well short of a hang. */
const TIMEOUT_MS = 90_000

/**
 * Lints `source` as if it were the file at `virtualPath`, with the flags the
 * `lint:node-runtime` script passes.
 *
 * @param source - the candidate module text
 * @param virtualPath - repo-relative path it is judged as
 * @returns ESLint's exit code and combined output
 */
const lint = async (
  source: string,
  virtualPath: string
): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn(
    [
      'bunx',
      'eslint',
      '--no-eslintrc',
      '-c',
      FENCE_CONFIG,
      '--no-inline-config',
      '--stdin',
      '--stdin-filename',
      virtualPath,
    ],
    {
      cwd: REPO_ROOT,
      env: process.env as Record<string, string>,
      stdin: Buffer.from(source),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: TIMEOUT_MS,
    }
  )

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (proc.signalCode !== null && proc.signalCode !== undefined)
    throw new Error(
      `eslint was killed by ${proc.signalCode}, so its verdict proves nothing`
    )

  return { exitCode: proc.exitCode ?? -1, output: `${stdout}${stderr}` }
}

const REFUSED: Array<[string, string]> = [
  ['import.meta.main', 'export const m = import.meta.main\n'],
  ['import.meta.dir', 'export const d = import.meta.dir\n'],
  ['computed import.meta access', "export const u = import.meta['url']\n"],
  ['destructured import.meta', 'export const { url } = import.meta\n'],
  ['import.meta passed around', 'export const s = String(import.meta)\n'],
  ['the Bun global', "export const f = Bun.file('x')\n"],
  ['globalThis.Bun', 'export const b = globalThis.Bun\n'],
  ['a static bun import', "import { file } from 'bun'\nexport { file }\n"],
  [
    'a bun: import',
    "import { Database } from 'bun:sqlite'\nexport { Database }\n",
  ],
  ['a dynamic bun import', "export const load = () => import('bun')\n"],
  ['a require of bun', "export const load = () => require('bun:ffi')\n"],
  [
    'a file that disables the rule on itself',
    '/* eslint-disable no-restricted-syntax */\nexport const m = import.meta.main\n',
  ],
]

const ALLOWED: Array<[string, string]> = [
  ['import.meta.url', 'export const u = import.meta.url\n'],
  ['import.meta.dirname', 'export const d = import.meta.dirname\n'],
  ['import.meta.filename', 'export const f = import.meta.filename\n'],
  ['import.meta.resolve', "export const r = import.meta.resolve('./x')\n"],
  [
    'a node: import',
    "import { readFile } from 'node:fs/promises'\nexport { readFile }\n",
  ],
  ['a package named like bun', "export const load = () => import('bunyan')\n"],
]

describe('the Node-runtime fence', () => {
  it.each(REFUSED)(
    'refuses %s in a shipped module',
    async (_name, source) => {
      const result = await lint(source, SHIPPED_PATH)

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it.each(ALLOWED)(
    'allows %s in a shipped module',
    async (_name, source) => {
      const result = await lint(source, SHIPPED_PATH)

      expect(result.output).toBe('')
      expect(result.exitCode).toBe(0)
    },
    TIMEOUT_MS
  )

  it(
    'leaves a *.test.ts alone, since bun test provides every Bun API',
    async () => {
      const result = await lint(
        "import { file } from 'bun'\nexport const f = [file, Bun, import.meta.dir]\n",
        'script/tasks/someCli.test.ts'
      )

      expect(result.output).toBe('')
      expect(result.exitCode).toBe(0)
    },
    TIMEOUT_MS
  )
})
