/**
 * Safe-proposal funnel fence.
 *
 * `script/deploy/safe/propose-safe-tx.ts` is the blessed way to create a Safe
 * proposal. Every check the signing process sites "in the funnel" only covers
 * the paths that reach it, so this refuses any other file that names the
 * storage function the funnel ends in.
 *
 * Keyed on the AST identifier rather than on the import declaration: an import
 * restriction sees only `import`/`export … from`, so a namespace member access
 * (`utils.storeTransactionInMongoDB`), a dynamic import or a computed lookup
 * would reach the funnel unflagged. Every reference to the name is a node.
 *
 * Extended by `.eslintrc.cjs` so a commit is checked by lint-staged, and run on
 * its own by `bun lint:funnel` (and `.github/workflows/enforceProposalFunnel.yml`)
 * so the fence does not depend on repo-wide lint being green. That standalone run
 * passes `--no-inline-config`, without which a file-level `eslint-disable` would
 * turn the rule off, and sweeps every module extension the repo can hold — the
 * repo-wide globs stop at `.ts`/`.js`/`.tsx`, so a `.mjs` or `.cts` route would
 * otherwise be linted by nothing at all.
 */

const FUNNEL = 'storeTransactionInMongoDB'

const MESSAGE =
  `Safe proposals are created through proposeSafeTx() in ` +
  `script/deploy/safe/propose-safe-tx.ts, which is where the funnel's checks ` +
  `are sited. Naming ${FUNNEL} here would create a proposal route that ` +
  `inherits none of them. If this file genuinely has to own its own storage ` +
  `call, add it to the allowlist in .eslintrc.funnel-fence.cjs with a reason ` +
  `and a ticket.`

const FENCE = [
  { selector: `Identifier[name='${FUNNEL}']`, message: MESSAGE },
  // A computed lookup carries the name as a string rather than an identifier,
  // and as a template literal it is neither.
  { selector: `Literal[value='${FUNNEL}']`, message: MESSAGE },
  { selector: `TemplateElement[value.cooked='${FUNNEL}']`, message: MESSAGE },
  // Not covered, deliberately: a name assembled by concatenation, which no
  // static selector can see, and an alias re-exported from an allowlisted file,
  // which carries the funnel to a consumer under a name this rule never reads.
  // Neither is a rewrite anyone reaches for by accident; the allowlisted files
  // export no such alias today.
]

module.exports = {
  // Enough to parse TypeScript; deliberately no `project`, so the standalone run
  // needs no type information and stays a few seconds.
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  // Loaded so the repo's inline `eslint-disable` comments still name defined
  // rules when this config runs on its own; none of their rules is enabled here.
  plugins: ['@typescript-eslint', 'import'],
  rules: {
    'no-restricted-syntax': ['error', ...FENCE],
  },
  overrides: [
    {
      files: [
        // names it to build the rule
        '.eslintrc.funnel-fence.cjs',
        // declares it
        'script/deploy/safe/safe-utils.ts',
        // the blessed wrapper: the only caller
        'script/deploy/safe/propose-safe-tx.ts',
        // its unit tests
        'script/deploy/safe/safe-utils.test.ts',
        // Do NOT add a file here to make a new propose route lint-clean.
        //
        // Tron hand-rolls its own signature instead of going through a
        // `SafeClient`, which is what the wrapper signs with, so it cannot pass
        // through it as written. Tracked for migration by EXSC-984.
        'script/deploy/tron/propose-to-safe-tron.ts',
      ],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
  ],
}
