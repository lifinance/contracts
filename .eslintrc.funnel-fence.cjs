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
 * so the fence does not depend on repo-wide lint being green.
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
  // A computed lookup carries the name as a string, not as an identifier.
  { selector: `Literal[value='${FUNNEL}']`, message: MESSAGE },
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
        // declares it
        'script/deploy/safe/safe-utils.ts',
        // the blessed wrapper: the only caller
        'script/deploy/safe/propose-safe-tx.ts',
        // its unit tests
        'script/deploy/safe/safe-utils.test.ts',
        // Grandfathered when the fence was introduced (EXSC-957). Do NOT add a
        // file here to make a new propose route lint-clean.
        //
        // Tron is a parallel non-EVM flow that hand-rolls its own signature and
        // is excluded from reconcile too; the owner-change script sequences
        // nonces across a loop of prebuilt transactions. Both are tracked for
        // migration by EXSC-958.
        'script/deploy/tron/propose-to-safe-tron.ts',
        'script/deploy/safe/add-safe-owners-and-threshold.ts',
      ],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
  ],
}
