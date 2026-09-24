/**
 * Node-runtime fence.
 *
 * Shipped modules under `script/` and `tasks/` run on Node via `bunx tsx`;
 * only `*.test.ts` runs under Bun. This refuses the Bun-only APIs a shipped
 * module could reach for:
 *
 * - `import.meta` members Node does not provide. The one the type checker cannot
 *   catch is `import.meta.main`: `@types/node` declares it, but `tsx` leaves it
 *   `undefined` for a `.ts` entry on every Node version, so a CLI guarded by it
 *   exits 0 without doing anything. The rule allowlists the members Node 22
 *   implements rather than denylisting Bun's, so `dir`, `file`, `path`, `env`
 *   and a destructured or passed-around `import.meta` are refused as well.
 * - the `Bun` global and `bun` / `bun:*` imports. `tsconfig.node.json` already
 *   rejects these for the files `typecheck-files.sh` is given; this repeats the
 *   check over the whole tree, so it holds even for a caller that type-checks
 *   against the wrong config.
 *
 * Run on its own by `bun lint:node-runtime` (lint-staged and
 * `.github/workflows/validateScripts.yml`) rather than extended by
 * `.eslintrc.cjs`: both this and `.eslintrc.funnel-fence.cjs` configure
 * `no-restricted-syntax`, and a later `extends` entry replaces a rule's options
 * instead of merging them, so extending both would silently drop one fence.
 */

const NODE_IMPORT_META_MEMBERS = ['url', 'dirname', 'filename', 'resolve']

const IMPORT_META_MESSAGE =
  `Shipped modules run on Node via \`bunx tsx\`, which provides only ` +
  `import.meta.{${NODE_IMPORT_META_MEMBERS.join(',')}}. For a CLI entry ` +
  `guard use isEntrypoint(import.meta.url) from script/utils/is-entrypoint.ts; ` +
  `for the module's directory use dirname(fileURLToPath(import.meta.url)).`

const BUN_MESSAGE =
  `Shipped modules run on Node via \`bunx tsx\`, where Bun APIs do not exist. ` +
  `Use the node: equivalent (e.g. readFile/writeFile from node:fs/promises).`

const ALLOWED_MEMBER = `MemberExpression[computed=false][property.name=/^(${NODE_IMPORT_META_MEMBERS.join(
  '|'
)})$/]`

module.exports = {
  // Enough to parse TypeScript; no `project`, so the run needs no type
  // information and stays a few seconds.
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  // Loaded so the repo's inline `eslint-disable` comments still name defined
  // rules when this config runs on its own; none of their rules is enabled here.
  plugins: ['@typescript-eslint', 'import'],
  overrides: [
    {
      files: ['script/**/*', 'tasks/**/*'],
      // `bun test` provides every Bun API.
      excludedFiles: ['**/*.test.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: `MetaProperty[meta.name='import']:not(${ALLOWED_MEMBER} > MetaProperty.object)`,
            message: IMPORT_META_MESSAGE,
          },
        ],
        'no-restricted-globals': [
          'error',
          { name: 'Bun', message: BUN_MESSAGE },
        ],
        'no-restricted-properties': [
          'error',
          { object: 'globalThis', property: 'Bun', message: BUN_MESSAGE },
        ],
        'no-restricted-imports': [
          'error',
          {
            paths: [{ name: 'bun', message: BUN_MESSAGE }],
            patterns: [{ group: ['bun:*'], message: BUN_MESSAGE }],
          },
        ],
      },
    },
  ],
}
