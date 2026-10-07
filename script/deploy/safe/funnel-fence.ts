/**
 * Safe-proposal funnel fence.
 *
 * `script/deploy/safe/propose-safe-tx.ts` is the blessed way to create a Safe
 * proposal. Every check the signing process sites "in the funnel" only covers
 * the paths that reach it, so this refuses any other file that names the
 * storage function the funnel ends in.
 *
 * Keyed on syntax nodes rather than on the import declaration: an import
 * restriction sees only `import`/`export … from`, so a namespace member access
 * (`utils.storeTransactionInMongoDB`), a dynamic import or a computed lookup
 * would reach the funnel unflagged. Every reference to the name is a node.
 *
 * Run by lint-staged on staged files and by `bun lint:funnel` (and
 * `.github/workflows/enforceProposalFunnel.yml`) over the whole tree. It reads
 * no comments, so no inline disable can switch it off.
 */

import ts from 'typescript'

import { isEntrypoint } from '../../utils/is-entrypoint'
import { type IFence, runFence } from '../../utils/fence-runner'

const FUNNEL = 'storeTransactionInMongoDB'

/**
 * The only files allowed to name the funnel. Do NOT add a file here to make a
 * new propose route pass the fence.
 */
export const FUNNEL_ALLOWLIST = [
  // names it to build the rule
  'script/deploy/safe/funnel-fence.ts',
  // declares it
  'script/deploy/safe/safe-utils.ts',
  // the blessed wrapper: the only caller
  'script/deploy/safe/propose-safe-tx.ts',
  // its unit tests
  'script/deploy/safe/safe-utils.test.ts',
  // Tron hand-rolls its own signature instead of going through a `SafeClient`,
  // which is what the wrapper signs with, so it cannot pass through it as
  // written. Tracked for migration by EXSC-984.
  'script/deploy/tron/propose-to-safe-tron.ts',
]

const MESSAGE =
  `Safe proposals are created through proposeSafeTx() in ` +
  `script/deploy/safe/propose-safe-tx.ts, which is where the funnel's checks ` +
  `are sited. Naming ${FUNNEL} here would create a proposal route that ` +
  `inherits none of them. If this file genuinely has to own its own storage ` +
  `call, add it to FUNNEL_ALLOWLIST in script/deploy/safe/funnel-fence.ts with ` +
  `a reason and a ticket.`

/**
 * An identifier, a string (a computed lookup carries the name as one) or a
 * template part naming the funnel.
 *
 * Not covered, deliberately: a name assembled by concatenation, which no static
 * check can see, and an alias re-exported from an allowlisted file, which
 * carries the funnel to a consumer under a name this rule never reads. Neither
 * is a rewrite anyone reaches for by accident; the allowlisted files export no
 * such alias today.
 */
const namesFunnel = (node: ts.Node): boolean =>
  (ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)) &&
  node.text === FUNNEL

export const FUNNEL_FENCE: IFence = {
  name: 'funnel fence',
  appliesTo: (path) => !FUNNEL_ALLOWLIST.includes(path),
  rules: [{ matches: namesFunnel, message: MESSAGE }],
}

if (isEntrypoint(import.meta.url))
  process.exit(runFence(FUNNEL_FENCE, process.argv.slice(2)))
