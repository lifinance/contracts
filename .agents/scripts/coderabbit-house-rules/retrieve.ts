#!/usr/bin/env bun
// @ts-nocheck — strictNullChecks + noUncheckedIndexedAccess noise across the
// hand-rolled YAML parser and diff parser; this is an internal Bun script,
// never imported as a module. Runtime guards are in place where they matter.
//
// Retrieval engine for the coderabbit-house-rules skill.
//
// Loads rules/catalogue.yaml, gets git diff (changed files + hunks) vs a base ref,
// matches rules by path-glob then narrows by trigger regexes against hunk text,
// emits the matched rules as markdown for the calling LLM to use in a review pass.
//
// Usage:
//   bun .agents/scripts/coderabbit-house-rules/retrieve.ts
//   bun .agents/scripts/coderabbit-house-rules/retrieve.ts --base origin/main
//   bun .agents/scripts/coderabbit-house-rules/retrieve.ts --files src/Facets/X.sol
//
// Output (stdout): markdown listing matched rules per file. Stderr: stats.

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

type Trigger = { regex: string; scope: string }
type Rule = {
  id: string
  title: string
  category: string
  severity: string
  applies_to: { paths: string[]; triggers?: Trigger[] }
  bad_example?: string
  good_example?: string
  rationale?: string
  source_refs?: Array<{ pr?: number | string }>
  usage_count?: number | null
  confidence?: string
}

// ---- minimal YAML loader for our catalogue shape (avoid bringing in deps)
function parseYaml(text: string): { rules: Rule[] } {
  const lines = text.split('\n')
  const rules: Rule[] = []
  let cur: Partial<Rule> | null = null
  let curPaths: string[] | null = null
  let curTriggers: Trigger[] | null = null
  let curTrig: Partial<Trigger> | null = null
  let curBlock: { key: keyof Rule; lines: string[]; indent: number } | null =
    null
  let inSourceRefs = false
  let curRef: any = null

  function commitBlock() {
    if (!cur || !curBlock) return
    const joined = curBlock.lines.join('\n')
    ;(cur as any)[curBlock.key] = joined
    curBlock = null
  }
  function commitRule() {
    if (!cur) return
    if (curPaths) (cur.applies_to ||= { paths: [] }).paths = curPaths
    if (curTriggers) (cur.applies_to ||= { paths: [] }).triggers = curTriggers
    rules.push(cur as Rule)
    cur = null
    curPaths = null
    curTriggers = null
    inSourceRefs = false
  }
  for (const raw of lines) {
    if (curBlock) {
      if (raw.length === 0 || raw.startsWith(' '.repeat(curBlock.indent))) {
        curBlock.lines.push(raw.slice(curBlock.indent))
        continue
      } else {
        commitBlock()
      }
    }
    if (/^\s*#/.test(raw) || raw.trim() === '' || raw.trim() === 'rules:')
      continue

    const m2 = raw.match(/^\s{2}-\s+id:\s+(.+)$/)
    if (m2) {
      commitRule()
      cur = { id: m2[1].trim() }
      curPaths = []
      curTriggers = null
      inSourceRefs = false
      continue
    }
    if (!cur) continue

    let m: RegExpMatchArray | null
    if ((m = raw.match(/^\s{4}title:\s*(.*)$/))) {
      const v = m[1].trim()
      if (v === '|') {
        curBlock = { key: 'title', lines: [], indent: 6 }
      } else {
        cur.title = unquote(v)
      }
      continue
    }
    if ((m = raw.match(/^\s{4}category:\s*(.+)$/))) {
      cur.category = m[1].trim()
      continue
    }
    if ((m = raw.match(/^\s{4}severity:\s*(.+)$/))) {
      cur.severity = m[1].trim()
      continue
    }
    if ((m = raw.match(/^\s{4}usage_count:\s*(.+)$/))) {
      const v = m[1].trim()
      cur.usage_count = v === 'null' ? null : parseInt(v, 10)
      continue
    }
    if ((m = raw.match(/^\s{4}confidence:\s*(.+)$/))) {
      cur.confidence = m[1].trim()
      continue
    }
    if ((m = raw.match(/^\s{4}applies_to:\s*$/))) {
      cur.applies_to = { paths: [] }
      continue
    }
    if (raw.match(/^\s{6}paths:\s*$/)) {
      curPaths = []
      curTriggers = null
      continue
    }
    if (raw.match(/^\s{6}triggers:\s*$/)) {
      curTriggers = []
      continue
    }
    if ((m = raw.match(/^\s{8}-\s+(.+)$/)) && curPaths && !curTriggers) {
      curPaths.push(unquote(m[1].trim()))
      continue
    }
    if ((m = raw.match(/^\s{8}-\s+regex:\s*(.+)$/)) && curTriggers) {
      curTrig = { regex: unquote(m[1].trim()), scope: 'hunk_or_neighborhood' }
      curTriggers.push(curTrig as Trigger)
      continue
    }
    if ((m = raw.match(/^\s{10}scope:\s*(.+)$/)) && curTrig) {
      curTrig.scope = m[1].trim()
      continue
    }
    if ((m = raw.match(/^\s{4}rationale:\s*(.*)$/))) {
      const v = m[1].trim()
      if (v === '|') {
        curBlock = { key: 'rationale', lines: [], indent: 6 }
      } else {
        cur.rationale = unquote(v)
      }
      continue
    }
    if ((m = raw.match(/^\s{4}bad_example:\s*(.*)$/))) {
      const v = m[1].trim()
      if (v === '|') curBlock = { key: 'bad_example', lines: [], indent: 6 }
      else cur.bad_example = unquote(v)
      continue
    }
    if ((m = raw.match(/^\s{4}good_example:\s*(.*)$/))) {
      const v = m[1].trim()
      if (v === '|') curBlock = { key: 'good_example', lines: [], indent: 6 }
      else cur.good_example = unquote(v)
      continue
    }
    if (raw.match(/^\s{4}source_refs:\s*$/)) {
      inSourceRefs = true
      cur.source_refs = []
      continue
    }
    if (inSourceRefs && (m = raw.match(/^\s{6}-\s+repo:\s*(.+)$/))) {
      curRef = { repo: m[1].trim() }
      cur.source_refs!.push(curRef)
      continue
    }
    if (inSourceRefs && (m = raw.match(/^\s{8}pr:\s*(.+)$/)) && curRef) {
      curRef.pr = m[1].trim().replace(/^"|"$/g, '')
      continue
    }
    if (inSourceRefs && (m = raw.match(/^\s{8}kind:\s*(.+)$/)) && curRef) {
      curRef.kind = m[1].trim()
      continue
    }
  }
  commitBlock()
  commitRule()
  return { rules }
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  return s
}

// ---- glob matcher (covers ** and *, no [abc] or {a,b})
function globMatch(glob: string, path: string): boolean {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('/.+^$()|[]{}\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  re += '$'
  return new RegExp(re).test(path)
}

// ---- git diff parsing
type Hunk = { startLine: number; text: string }
type FileDiff = { path: string; hunks: Hunk[] }

function getDiff(base: string, filesFilter: string[] | null): FileDiff[] {
  const pathArgs =
    filesFilter && filesFilter.length
      ? ` -- ${filesFilter.map((p) => `'${p}'`).join(' ')}`
      : ''
  const out = execSync(`git diff -U3 ${base}...HEAD${pathArgs}`, {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  const files: FileDiff[] = []
  let cur: FileDiff | null = null
  let curHunk: Hunk | null = null
  for (const line of out.split('\n')) {
    const mFile = line.match(/^\+\+\+ b\/(.+)$/)
    if (mFile) {
      if (cur) files.push(cur)
      if (curHunk && cur) cur.hunks.push(curHunk)
      cur = { path: mFile[1], hunks: [] }
      curHunk = null
      continue
    }
    const mHunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (mHunk && cur) {
      if (curHunk) cur.hunks.push(curHunk)
      curHunk = { startLine: parseInt(mHunk[1], 10), text: '' }
      continue
    }
    if (curHunk && (line.startsWith('+') || line.startsWith(' '))) {
      // Strip leading +/space; treat as the post-image source the rule would see
      curHunk.text += line.slice(1) + '\n'
    }
  }
  if (curHunk && cur) cur.hunks.push(curHunk)
  if (cur) files.push(cur)
  return files.filter((f) => f.path && !f.path.startsWith('/dev/null'))
}

// ---- main
function main() {
  const argv = process.argv.slice(2)
  let base = 'origin/main'
  let filesFilter: string[] | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') {
      const v = argv[++i]
      if (v) base = v
    } else if (argv[i] === '--files') {
      filesFilter = []
      while (argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
        const v = argv[++i]
        if (v) filesFilter.push(v)
      }
    }
  }

  // Locate catalogue. Prefer repo-relative; fall back to env override.
  const repoRoot = execSync('git rev-parse --show-toplevel', {
    encoding: 'utf8',
  }).trim()
  const cataloguePath =
    process.env.CR_HOUSE_RULES_CATALOGUE ||
    `${repoRoot}/.agents/rules/coderabbit-learnings/catalogue.yaml`
  if (!existsSync(cataloguePath)) {
    console.error(`ERR catalogue not found at ${cataloguePath}`)
    process.exit(2)
  }

  const { rules } = parseYaml(readFileSync(cataloguePath, 'utf8'))
  const diffFiles = getDiff(base, filesFilter)

  type Match = { rule: Rule; file: string; hunk: Hunk | null }
  const matches: Match[] = []

  for (const f of diffFiles) {
    for (const r of rules) {
      if (!r.applies_to?.paths?.some((g) => globMatch(g, f.path))) continue
      if (!r.applies_to.triggers || r.applies_to.triggers.length === 0) {
        matches.push({ rule: r, file: f.path, hunk: null })
        continue
      }
      for (const h of f.hunks) {
        let hit = false
        for (const t of r.applies_to.triggers) {
          try {
            if (new RegExp(t.regex, 'm').test(h.text)) {
              hit = true
              break
            }
          } catch {
            /* bad regex, skip */
          }
        }
        if (hit) matches.push({ rule: r, file: f.path, hunk: h })
      }
    }
  }

  // Group matches by rule.id (collect all files each rule fires on)
  const byRule = new Map<string, { rule: Rule; files: Set<string> }>()
  for (const m of matches) {
    const entry = byRule.get(m.rule.id) || {
      rule: m.rule,
      files: new Set<string>(),
    }
    entry.files.add(m.file)
    byRule.set(m.rule.id, entry)
  }
  // Cap unique rules at 40 by severity desc + usage desc
  const sevRank: Record<string, number> = { high: 3, medium: 2, low: 1 }
  const ruleList = Array.from(byRule.values()).sort(
    (a, b) =>
      (sevRank[b.rule.severity] || 0) - (sevRank[a.rule.severity] || 0) ||
      (b.rule.usage_count ?? 0) - (a.rule.usage_count ?? 0)
  )
  const cappedRules = ruleList.slice(0, 40)
  const cappedNote =
    ruleList.length > 40
      ? `\n> Note: ${ruleList.length - 40} additional rules dropped (cap=40).\n`
      : ''
  // Flatten back to per-file matches for the existing output shape
  const dedup: Match[] = []
  const capped: Match[] = []
  for (const m of matches) dedup.push(m)
  const keptIds = new Set(cappedRules.map((r) => r.rule.id))
  const seenPair = new Set<string>()
  for (const m of matches) {
    if (!keptIds.has(m.rule.id)) continue
    const k = `${m.rule.id}::${m.file}`
    if (seenPair.has(k)) continue
    seenPair.add(k)
    capped.push(m)
  }

  // Emit markdown
  const byFile = new Map<string, Match[]>()
  for (const m of capped) {
    const arr = byFile.get(m.file) || []
    arr.push(m)
    byFile.set(m.file, arr)
  }
  const out: string[] = []
  out.push(`# CodeRabbit house-rules matches`)
  out.push(``)
  out.push(
    `Base: \`${base}\` · Files changed: ${diffFiles.length} · Unique rules matched (after cap): ${cappedRules.length} / ${ruleList.length} · Per-file findings: ${capped.length} · Catalogue rules: ${rules.length}`
  )
  out.push(cappedNote)
  for (const [file, ms] of byFile) {
    out.push(`## ${file}`)
    for (const m of ms) {
      out.push(``)
      out.push(`### ${m.rule.id} · ${m.rule.severity} · ${m.rule.category}`)
      out.push(`**${m.rule.title}**`)
      if (m.rule.rationale) {
        out.push(``)
        out.push(`> ${m.rule.rationale.split('\n').join('\n> ')}`)
      }
      if (m.rule.usage_count)
        out.push(
          `\nUsage: ${m.rule.usage_count} · Confidence: ${
            m.rule.confidence || '?'
          }`
        )
      if (m.rule.source_refs?.length) {
        const refs = m.rule.source_refs
          .slice(0, 3)
          .map(
            (r: any) => `[#${r.pr}](https://github.com/${r.repo}/pull/${r.pr})`
          )
          .join(', ')
        out.push(`\nSource: ${refs}`)
      }
    }
    out.push('')
  }
  process.stdout.write(out.join('\n') + '\n')
  console.error(
    JSON.stringify({
      files_changed: diffFiles.length,
      rules_total: rules.length,
      unique_rules_matched: cappedRules.length,
      unique_rules_pre_cap: ruleList.length,
      per_file_findings: capped.length,
      raw_matches: matches.length,
    })
  )
}

main()
