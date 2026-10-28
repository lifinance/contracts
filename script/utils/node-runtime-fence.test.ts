/**
 * Whether the Node-runtime fence (`node-runtime-fence.ts`) refuses each
 * Bun-only API in a shipped module, lets the Node equivalents through, and
 * leaves `*.test.ts` alone.
 *
 * Each case judges a candidate in memory under a virtual path, so nothing is
 * written into the tree.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, relative } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { withholdCredentials } from '../deploy/safe/spawn-env'

import { findViolations } from './fence-runner'
import { NODE_RUNTIME_FENCE } from './node-runtime-fence'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const FENCE_SCRIPT = 'script/utils/node-runtime-fence.ts'
const SHIPPED_PATH = 'script/tasks/someCli.ts'

/** 90 seconds: a tsx run plus a cold bun start, well short of a hang. */
const TIMEOUT_MS = 90_000

const spawnEnv = (): Record<string, string> => {
  const env = { ...process.env } as Record<string, string>
  withholdCredentials(env)
  return env
}

/** Fragment every refusal message of the fence starts with. */
const REFUSAL = 'Shipped modules run on Node via `bunx tsx`'

const lint = (source: string, virtualPath: string): string =>
  findViolations(NODE_RUNTIME_FENCE, source, virtualPath).join('\n')

const REFUSED: Array<[string, string]> = [
  ['import.meta.main', 'export const m = import.meta.main\n'],
  ['import.meta.dir', 'export const d = import.meta.dir\n'],
  ['computed import.meta access', "export const u = import.meta['url']\n"],
  ['destructured import.meta', 'export const { url } = import.meta\n'],
  ['import.meta passed around', 'export const s = String(import.meta)\n'],
  ['the Bun global', "export const f = Bun.file('x')\n"],
  ['the Bun global in shorthand', 'export const o = { Bun }\n'],
  [
    'Bun read off an alias of globalThis',
    'const g = globalThis\nexport const b = g.Bun\n',
  ],
  [
    'Bun looked up by Reflect.get',
    "export const b = Reflect.get(globalThis, 'Bun')\n",
  ],
  [
    'a template lookup padded with an empty substitution',
    // eslint-disable-next-line no-template-curly-in-string -- fixture source
    'export const b = globalThis[`Bun${""}`]\n',
  ],
  [
    'a member named Bun, which the rule cannot tell from the global',
    'export const o = { Bun: 1 }\nexport const b = o.Bun\n',
  ],
  ['globalThis.Bun', 'export const b = globalThis.Bun\n'],
  ["globalThis['Bun']", "export const b = globalThis['Bun']\n"],
  ['global.Bun', 'export const b = global.Bun\n'],
  ['Bun destructured off globalThis', 'export const { Bun } = globalThis\n'],
  ['a parenthesized require of bun', "export const b = require(('bun'))\n"],
  ['a parenthesized require callee', "export const b = (require)('bun')\n"],
  [
    'a parenthesized dynamic bun: import',
    "export const load = () => import(('bun:sqlite'))\n",
  ],
  ['a static bun import', "import { file } from 'bun'\nexport { file }\n"],
  [
    'a bun: import',
    "import { Database } from 'bun:sqlite'\nexport { Database }\n",
  ],
  ['a re-export from bun', "export { file } from 'bun'\n"],
  ['a dynamic bun import', "export const load = () => import('bun')\n"],
  ['a require of bun', "export const load = () => require('bun:ffi')\n"],
  [
    'a dynamic bun import by template literal',
    'export const load = () => import(`bun:sqlite`)\n',
  ],
  [
    'a require of bun by template literal',
    'export const load = () => require(`bun`)\n',
  ],
  [
    'a dynamic bun import by template with a substitution',
    // eslint-disable-next-line no-template-curly-in-string -- fixture source
    'export const load = (m: string) => import(`bun:${m}`)\n',
  ],
  [
    'a file that disables the rule on itself',
    '/* eslint-disable no-restricted-syntax */\nexport const m = import.meta.main\n',
  ],
  [
    'a file that disables oxlint on itself',
    '/* oxlint-disable */\nexport const m = import.meta.main\n',
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
  [
    'a template-literal package named like bun',
    'export const load = () => import(`bunyan`)\n',
  ],
  [
    'a string that only contains the word Bun',
    "export const s = 'Bun APIs are refused'\n",
  ],
  ['a mention in a comment', '// Bun.file and import.meta.main are refused\n'],
]

describe('the Node-runtime fence', () => {
  it.each(REFUSED)('refuses %s in a shipped module', (_name, source) => {
    expect(lint(source, SHIPPED_PATH)).toContain(REFUSAL)
  })

  it.each(ALLOWED)('allows %s in a shipped module', (_name, source) => {
    expect(lint(source, SHIPPED_PATH)).toBe('')
  })

  it('leaves a *.test.ts alone, since bun test provides every Bun API', () => {
    expect(
      lint(
        "import { file } from 'bun'\nexport const f = [file, Bun, import.meta.dir]\n",
        'script/tasks/someCli.test.ts'
      )
    ).toBe('')
  })

  it('lets the fence itself name Bun to build its rule, and nothing else', () => {
    expect(
      lint(readFileSync(join(REPO_ROOT, FENCE_SCRIPT), 'utf8'), FENCE_SCRIPT)
    ).toBe('')
    expect(
      lint("export const b = 'Bun'\n", 'script/utils/other-fence.ts')
    ).toContain(REFUSAL)
    // An `import.meta.main` entry guard here would leave the CLI checking nothing.
    expect(lint('export const m = import.meta.main\n', FENCE_SCRIPT)).toContain(
      REFUSAL
    )
    expect(lint("import { file } from 'bun'\n", FENCE_SCRIPT)).toContain(
      REFUSAL
    )
  })

  it('leaves files outside script/ and tasks/ alone', () => {
    expect(lint('export const m = import.meta.main\n', 'plopfile.mjs')).toBe('')
  })

  it('judges tasks/ the same as script/', () => {
    expect(
      lint('export const m = import.meta.main\n', 'tasks/someTask.ts')
    ).toContain(REFUSAL)
  })
})

describe('the Node-runtime fence runs where it has to run', () => {
  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
  ) as {
    scripts: Record<string, string>
    'lint-staged': Record<string, string[]>
  }

  const staged = (packageJson['lint-staged']['*.{ts,js}'] ?? []).find(
    (command) => command.includes(FENCE_SCRIPT)
  )

  it('sweeps script/ and tasks/ with the command lint-staged runs per file', () => {
    expect(staged).toBeDefined()
    expect(packageJson.scripts['lint:node-runtime']).toBe(
      `${staged} script tasks`
    )
  })

  it('runs on Node through the tsx loader, which opens no IPC socket', () => {
    // `bunx tsx` binds a pipe before running, and sandboxes deny that bind.
    expect(staged).toBe(`node --import tsx ${FENCE_SCRIPT}`)
  })

  it(
    'exits non-zero through that command on a refused module',
    () => {
      if (!staged)
        throw new Error('package.json lint-staged has no node-runtime entry')

      // Inside script/, since the fence judges nothing outside it; a dot-directory
      // keeps a crashed run's leftover easy to spot.
      const dir = mkdtempSync(join(REPO_ROOT, 'script', '.node-runtime-fence-'))
      try {
        const file = join(dir, 'someCli.ts')
        writeFileSync(file, 'export const m = import.meta.main\n')

        const result = Bun.spawnSync(
          [...staged.split(' '), relative(REPO_ROOT, file)],
          {
            cwd: REPO_ROOT,
            env: spawnEnv(),
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: TIMEOUT_MS,
          }
        )

        expect(result.exitCode).not.toBe(0)
        expect(
          `${result.stdout.toString()}${result.stderr.toString()}`
        ).toContain(REFUSAL)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT_MS
  )
})
