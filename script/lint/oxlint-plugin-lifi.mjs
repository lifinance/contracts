/**
 * Local oxlint JS plugin for the repo conventions oxlint has no built-in rule for.
 * Loaded by `.oxlintrc.json` through `jsPlugins`; rules are addressed as `lifi/<name>`.
 */

const PASCAL_CASE = /^[A-Z][^_]*$/

/** Declaration kind → the shape its name must take and how to say so. */
const CONVENTIONS = {
  TSInterfaceDeclaration: {
    matches: (name) => name.startsWith('I') && PASCAL_CASE.test(name.slice(1)),
    expected: 'PascalCase with an `I` prefix (e.g. `INetwork`)',
    kind: 'Interface',
  },
  TSTypeAliasDeclaration: {
    matches: (name) => PASCAL_CASE.test(name),
    expected: 'PascalCase (e.g. `SupportedChain`)',
    kind: 'Type alias',
  },
  TSEnumDeclaration: {
    matches: (name) =>
      name.endsWith('Enum') && PASCAL_CASE.test(name.slice(0, -'Enum'.length)),
    expected: 'PascalCase with an `Enum` suffix (e.g. `EnvironmentEnum`)',
    kind: 'Enum',
  },
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
    const visitors = {}
    for (const [nodeType, convention] of Object.entries(CONVENTIONS)) {
      visitors[nodeType] = (node) => {
        const name = node.id.name
        if (convention.matches(name)) return
        context.report({
          node: node.id,
          message: `${convention.kind} name \`${name}\` must be ${convention.expected}.`,
        })
      }
    }
    return visitors
  },
}

// eslint-disable-next-line import/no-default-export -- oxlint loads a JS plugin from its default export
export default {
  meta: { name: 'lifi' },
  rules: { 'naming-convention': namingConvention },
}
