/**
 * Local oxlint JS plugin for the repo conventions oxlint has no built-in rule
 * for. Loaded by `.oxlintrc.json` through `jsPlugins`; its rules are addressed
 * as `lifi/<name>`.
 */

const LEGACY_RULE = '@typescript-eslint/naming-convention'

/**
 * typescript-eslint's PascalCase check, which the ESLint rule this replaces
 * applied after stripping a prefix or suffix: an upper-case first character
 * and no underscore. An empty remainder passes, as it did there.
 */
const isPascalCase = (name) =>
  name.length === 0 ||
  (name[0] === name[0].toUpperCase() && !name.includes('_'))

const CONVENTIONS = {
  TSInterfaceDeclaration: {
    matches: (name) => name.startsWith('I') && isPascalCase(name.slice(1)),
    expected: 'PascalCase with an `I` prefix (e.g. `INetwork`)',
    kind: 'Interface',
  },
  TSTypeAliasDeclaration: {
    matches: (name) => isPascalCase(name),
    expected: 'PascalCase (e.g. `SupportedChain`)',
    kind: 'Type alias',
  },
  TSEnumDeclaration: {
    matches: (name) =>
      name.endsWith('Enum') && isPascalCase(name.slice(0, -'Enum'.length)),
    expected: 'PascalCase with an `Enum` suffix (e.g. `EnvironmentEnum`)',
    kind: 'Enum',
  },
}

const LINE_DIRECTIVE =
  /^\s*eslint-disable-(next-line|line)\s+([^]*?)\s*(?:--[^]*)?$/

/**
 * Lines on which an `eslint-disable-next-line` / `eslint-disable-line`
 * directive names the ESLint rule this replaces. oxlint maps
 * `@typescript-eslint/<rule>` in a directive to its own `typescript/<rule>`,
 * which never names this plugin, so the directives the repo already carries
 * are honoured here instead of being rewritten.
 */
const legacySuppressedLines = (sourceCode) => {
  const lines = new Set()
  for (const comment of sourceCode.getAllComments()) {
    const match = LINE_DIRECTIVE.exec(comment.value)
    if (!match) continue
    const rules = match[2].split(',').map((rule) => rule.trim())
    if (!rules.includes(LEGACY_RULE)) continue
    lines.add(
      match[1] === 'next-line'
        ? comment.loc.end.line + 1
        : comment.loc.start.line
    )
  }
  return lines
}

const namingConvention = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Interfaces take an `I` prefix, enums an `Enum` suffix, and type aliases are PascalCase',
    },
  },
  create(context) {
    const suppressedLines = legacySuppressedLines(context.sourceCode)
    const visitors = {}
    for (const [nodeType, convention] of Object.entries(CONVENTIONS)) {
      visitors[nodeType] = (node) => {
        const name = node.id.name
        if (convention.matches(name)) return
        if (suppressedLines.has(node.id.loc.start.line)) return
        context.report({
          node: node.id,
          message: `${convention.kind} name \`${name}\` must be ${convention.expected}.`,
        })
      }
    }
    return visitors
  },
}

// oxlint loads a JS plugin from its default export
// eslint-disable-next-line import/no-default-export
export default {
  meta: { name: 'lifi' },
  rules: { 'naming-convention': namingConvention },
}
