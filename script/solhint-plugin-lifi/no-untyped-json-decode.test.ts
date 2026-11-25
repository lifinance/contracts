/**
 * Tests the solhint rule `lifi/no-untyped-json-decode` by linting in-memory
 * Solidity with the repo's own `.solhint.json`, so a plugin solhint cannot load
 * or a rule the config no longer enables fails here instead of passing silently.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

interface ISolhintReport {
  line: number
  severity: number
  message: string
  ruleId: string
}

interface ISolhint {
  processStr: (source: string, config: object) => { reports: ISolhintReport[] }
}

const RULE_ID = 'lifi/no-untyped-json-decode'
const SOLHINT_ERROR_SEVERITY = 2
const STATEMENT_LINE = 4

const solhint = createRequire(import.meta.url)('solhint') as ISolhint
const repoConfig = JSON.parse(
  readFileSync(join(import.meta.dir, '../../.solhint.json'), 'utf8')
) as object

function lintStatement(statement: string): ISolhintReport[] {
  const source = [
    'pragma solidity ^0.8.17;',
    'contract Sample {',
    '    function read(string memory json, string memory key) public {',
    `        ${statement}`,
    '    }',
    '}',
  ].join('\n')

  return solhint
    .processStr(source, repoConfig)
    .reports.filter((report) => report.ruleId === RULE_ID)
}

describe('lifi/no-untyped-json-decode', () => {
  it.each([
    ['a parseRaw member call on the JSON string', 'json.parseRaw(".x");'],
    ['a parseRaw library call', 'stdJson.parseRaw(json, key);'],
    ['vm.parseJson over the whole document', 'vm.parseJson(json);'],
    ['vm.parseJson with a key', 'vm.parseJson(json, key);'],
    ['a parseToml member call', 'vm.parseToml(json, key);'],
    ['a bare parseJson call', 'parseJson(json);'],
    [
      'a banned call nested in abi.decode',
      'abi.decode(json.parseRaw(key), (uint256[]));',
    ],
  ])('reports %s as an error on its line', (_name, statement) => {
    const reports = lintStatement(statement)

    expect(reports).toHaveLength(1)
    expect(reports[0]?.line).toBe(STATEMENT_LINE)
    expect(reports[0]?.severity).toBe(SOLHINT_ERROR_SEVERITY)
    expect(reports[0]?.message).toContain('vm.parseJsonType')
    expect(reports[0]?.message).toContain('typed stdJson reader')
    expect(reports[0]?.message).toContain('forge script')
  })

  it.each([
    ['vm.parseJsonType', 'vm.parseJsonType(json, key, "Row(uint256 a)");'],
    [
      'vm.parseJsonTypeArray',
      'vm.parseJsonTypeArray(json, key, "Row(uint256 a)");',
    ],
    ['vm.parseJsonUint', 'vm.parseJsonUint(json, key);'],
    ['a typed stdJson reader', 'json.readUint(key);'],
    ['a comment naming a banned reader', '// json.parseRaw(".x") is banned'],
    ['a variable named after a banned reader', 'uint256 parseRaw = 1;'],
  ])('allows %s', (_name, statement) => {
    expect(lintStatement(statement)).toHaveLength(0)
  })
})
