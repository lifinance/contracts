/**
 * Agent-harness check.
 *
 * Fails on drift in `.agents/` that no other check sees: frontmatter that does not
 * parse (Claude Code then loads the skill or rule with no metadata, so it never
 * auto-triggers), a description cut short by an unquoted ` #` (YAML reads the rest
 * as a comment) or longer than the Agent Skills limit, a missing or dangling
 * `.claude/` / `.cursor/` symlink, and a `bun <script>` reference to a package.json
 * script that does not exist.
 *
 * Run by `bun lint:agents` and `.github/workflows/markdownlint.yml`.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { basename, join } from 'node:path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { isMap, isScalar, parseDocument } from 'yaml'

import { isEntrypoint } from './is-entrypoint'

/** The Agent Skills spec limit; Claude Code's own listing cap is higher. */
export const MAX_DESCRIPTION_CHARS = 1024

const BUN_SUBCOMMANDS = new Set([
  'add',
  'audit',
  'build',
  'create',
  'exec',
  'init',
  'install',
  'link',
  'outdated',
  'pm',
  'publish',
  'remove',
  'run',
  'test',
  'update',
  'upgrade',
  'x',
])

export type HarnessKind = 'command' | 'rule'

export interface IHarnessProblem {
  file: string
  message: string
}

/**
 * Returns the YAML between the opening and closing `---` lines, or undefined when the
 * file has no frontmatter starting on line 1.
 * @param text - The full Markdown file
 * @returns The frontmatter source, or undefined
 */
export function extractFrontmatter(text: string): string | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/)
  return match?.[1]
}

/**
 * Checks one skill or rule file's frontmatter.
 * @param file - Repo-relative path, used for the message and the expected skill name
 * @param text - The file's contents
 * @param kind - `command` requires `name` and `description`; `rule` only has to parse
 * @returns The problems found, empty when clean
 */
export function checkFrontmatter(
  file: string,
  text: string,
  kind: HarnessKind
): IHarnessProblem[] {
  const source = extractFrontmatter(text)
  if (source === undefined)
    return [{ file, message: 'no frontmatter starting on line 1' }]

  const doc = parseDocument(source)
  const [firstError] = doc.errors
  if (firstError)
    return [
      {
        file,
        message: `frontmatter is not valid YAML (${firstError.message
          .split('\n')[0]
          ?.replace(/:$/, '')}) — quote the value`,
      },
    ]
  if (kind === 'rule' || !isMap(doc.contents)) return []

  return [
    ...checkName(file, doc.contents.get('name')),
    ...checkDescription(file, doc.contents.get('description', true)),
  ]
}

function checkName(file: string, name: unknown): IHarnessProblem[] {
  const expected = skillNameFromPath(file)
  return name === expected
    ? []
    : [{ file, message: `name must be "${expected}", found "${String(name)}"` }]
}

function checkDescription(file: string, node: unknown): IHarnessProblem[] {
  if (!isScalar(node) || typeof node.value !== 'string' || !node.value.trim())
    return [{ file, message: 'description is missing or empty' }]

  const problems: IHarnessProblem[] = []
  if (node.comment !== undefined)
    problems.push({
      file,
      message:
        'description contains an unquoted " #", which YAML reads as the start of a comment — quote the value',
    })
  if (node.value.length > MAX_DESCRIPTION_CHARS)
    problems.push({
      file,
      message: `description is ${node.value.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}`,
    })
  return problems
}

function skillNameFromPath(file: string): string {
  const name = basename(file, '.md')
  return name === 'SKILL' ? basename(join(file, '..')) : name
}

/**
 * Finds `bun <script>` / `bun run <script>` references in inline code and fenced
 * blocks that name no package.json script and no bun subcommand.
 * @param file - Repo-relative path, used for the message
 * @param text - The Markdown file
 * @param scripts - The package.json script names
 * @returns The problems found, empty when clean
 */
export function checkBunScripts(
  file: string,
  text: string,
  scripts: ReadonlySet<string>
): IHarnessProblem[] {
  const problems: IHarnessProblem[] = []
  for (const code of codeSpans(text))
    for (const match of code.matchAll(
      /(?:^|[\s;&|(])bun (?:run )?([a-z][\w:.-]*)/g
    )) {
      const name = match[1] ?? ''
      if (!BUN_SUBCOMMANDS.has(name) && !scripts.has(name))
        problems.push({
          file,
          message: `\`bun ${name}\` names no package.json script`,
        })
    }
  return problems
}

function codeSpans(text: string): string[] {
  const fenced = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map(
    (match) => match[1] ?? ''
  )
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '')
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map(
    (match) => match[1] ?? ''
  )
  return [...fenced, ...inline]
}

/**
 * Checks that a link exists, is a symlink and resolves to the expected source file.
 * @param link - Path of the expected symlink
 * @param source - Path of the `.agents/` file it must resolve to
 * @returns The problems found, empty when clean
 */
export function checkLink(link: string, source: string): IHarnessProblem[] {
  if (!existsSync(link) && !isSymlink(link))
    return [{ file: source, message: `missing symlink ${link}` }]
  if (!isSymlink(link))
    return [
      { file: link, message: `is a real file, not a symlink to ${source}` },
    ]
  if (!existsSync(link)) return [{ file: link, message: 'dangling symlink' }]
  return realpathSync(link) === realpathSync(source)
    ? []
    : [{ file: link, message: `resolves elsewhere, expected ${source}` }]
}

/**
 * Finds symlinks in a directory that dangle or point outside `.agents/`.
 * @param dir - Directory to scan (non-recursive)
 * @param agentsRoot - The `.agents/` directory links must resolve into
 * @returns The problems found, empty when clean
 */
export function checkOrphanLinks(
  dir: string,
  agentsRoot: string
): IHarnessProblem[] {
  const problems: IHarnessProblem[] = []
  const root = realpathSync(agentsRoot)
  for (const entry of readdirSync(dir).sort()) {
    const link = join(dir, entry)
    if (!isSymlink(link)) continue
    if (!existsSync(link))
      problems.push({ file: link, message: 'dangling symlink' })
    else if (!realpathSync(link).startsWith(`${root}/`))
      problems.push({ file: link, message: 'does not point into .agents/' })
  }
  return problems
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.md'))
    .sort()
    .map((entry) => join(dir, entry))
}

/**
 * Skills under `.claude/skills/` that are real files rather than links into
 * `.agents/commands/`. They still ship to Claude Code, so their frontmatter is checked.
 * @param root - Repo root
 * @returns Paths of the real SKILL.md files
 */
export function realSkillFiles(root: string): string[] {
  const skillsDir = join(root, '.claude/skills')
  return readdirSync(skillsDir)
    .map((entry) => join(skillsDir, entry, 'SKILL.md'))
    .filter((file) => existsSync(file) && !isSymlink(file))
}

/**
 * Runs every check over a repo checkout.
 * @param root - Repo root
 * @returns All problems found, empty when the harness is clean
 */
export function checkHarness(root: string): IHarnessProblem[] {
  const at = (path: string) => join(root, path)
  const commands = markdownFiles(at('.agents/commands'))
  const rules = markdownFiles(at('.agents/rules'))
  const skills = [...commands, ...realSkillFiles(root)]
  const scripts = new Set(
    Object.keys(
      JSON.parse(readFileSync(at('package.json'), 'utf8')).scripts ?? {}
    )
  )
  const prose = [...skills, ...rules, at('CLAUDE.md'), at('.agents/context.md')]

  return [
    ...skills.flatMap((file) =>
      checkFrontmatter(file, readFileSync(file, 'utf8'), 'command')
    ),
    ...rules.flatMap((file) =>
      checkFrontmatter(file, readFileSync(file, 'utf8'), 'rule')
    ),
    ...commands.flatMap((file) => {
      const name = basename(file, '.md')
      return [
        ...checkLink(at(`.claude/skills/${name}/SKILL.md`), file),
        ...checkLink(at(`.cursor/commands/${name}.md`), file),
      ]
    }),
    ...rules.flatMap((file) => {
      const name = basename(file, '.md')
      return [
        ...checkLink(at(`.claude/rules/${name}.md`), file),
        ...checkLink(at(`.cursor/rules/${name}.mdc`), file),
      ]
    }),
    ...['.claude/rules', '.cursor/rules', '.cursor/commands'].flatMap((dir) =>
      checkOrphanLinks(at(dir), at('.agents'))
    ),
    ...prose
      .filter((file) => existsSync(file))
      .flatMap((file) =>
        checkBunScripts(file, readFileSync(file, 'utf8'), scripts)
      ),
  ].map((problem) => ({
    ...problem,
    file: problem.file.startsWith(`${root}/`)
      ? problem.file.slice(root.length + 1)
      : problem.file,
  }))
}

const main = defineCommand({
  meta: {
    name: 'check-agents-harness',
    description:
      'Check .agents/ frontmatter, symlinks and bun script references',
  },
  run() {
    process.exit(reportHarness(process.cwd()))
  },
})

/**
 * Runs the checks and logs each problem.
 * @param root - Repo root
 * @returns The process exit code: 0 when clean, 1 otherwise
 */
export function reportHarness(root: string): number {
  const problems = checkHarness(root)
  for (const { file, message } of problems) consola.error(`${file}: ${message}`)
  if (problems.length > 0) {
    consola.error(`${problems.length} agent-harness problem(s)`)
    return 1
  }
  consola.success('agent harness clean')
  return 0
}

if (isEntrypoint(import.meta.url)) runMain(main)
