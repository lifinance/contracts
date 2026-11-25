/**
 * solhint rule `lifi/no-untyped-json-decode`: reports every call to an untyped
 * forge JSON/TOML reader. Enabled in `.solhint.json`; not meant to be imported.
 */

const RULE_ID = 'no-untyped-json-decode'

const BANNED_READERS = new Set(['parseRaw', 'parseJson', 'parseToml'])

const MESSAGE =
  'Untyped JSON decode: forge orders the fields of a decoded object by the struct under ' +
  '"forge test" but alphabetically by key under "forge script", so abi.decode can swap ' +
  'fields on deploy. Use vm.parseJsonType / vm.parseJsonTypeArray with a type name that ' +
  'no struct declares, or a typed stdJson reader such as readUint or readAddressArray.'

class NoUntypedJsonDecode {
  constructor(reporter) {
    this.reporter = reporter
    this.ruleId = RULE_ID
  }

  FunctionCall(node) {
    const callee = node.expression
    const name =
      callee.type === 'MemberAccess'
        ? callee.memberName
        : callee.type === 'Identifier'
          ? callee.name
          : null

    if (BANNED_READERS.has(name)) {
      this.reporter.error(node, this.ruleId, MESSAGE)
    }
  }
}

module.exports = NoUntypedJsonDecode
