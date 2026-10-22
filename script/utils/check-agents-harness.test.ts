import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  MAX_DESCRIPTION_CHARS,
  checkBunScripts,
  checkFrontmatter,
  checkHarness,
  checkLink,
  checkOrphanLinks,
  extractFrontmatter,
  realSkillFiles,
  reportHarness,
} from './check-agents-harness'

const skill = (frontmatter: string) => `---\n${frontmatter}\n---\n\n# Body\n`

describe('extractFrontmatter', () => {
  it('returns the YAML between the fences', () => {
    expect(extractFrontmatter('---\nname: a\n---\nbody')).toBe('name: a')
  })

  it('accepts a closing fence at end of file', () => {
    expect(extractFrontmatter('---\nname: a\n---')).toBe('name: a')
  })

  it('returns undefined when the fence is not on line 1', () => {
    expect(extractFrontmatter('\n---\nname: a\n---\n')).toBeUndefined()
  })
})

describe('checkFrontmatter', () => {
  const file = '.agents/commands/demo.md'

  it('accepts a valid skill', () => {
    expect(
      checkFrontmatter(
        file,
        skill('name: demo\ndescription: Does it.'),
        'command'
      )
    ).toEqual([])
  })

  it('reports a file without frontmatter', () => {
    expect(checkFrontmatter(file, '# Title\n', 'command')).toEqual([
      { file, message: 'no frontmatter starting on line 1' },
    ])
  })

  it('reports an unquoted ": " once, as invalid YAML', () => {
    const problems = checkFrontmatter(
      file,
      skill('name: demo\ndescription: Does it: twice: here'),
      'command'
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]?.message).toContain('not valid YAML')
    expect(problems[0]?.message).not.toMatch(/:\)/)
  })

  it('reports a description cut short by " #"', () => {
    const problems = checkFrontmatter(
      file,
      skill('name: demo\ndescription: Posts to the #channel thread'),
      'command'
    )
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining('unquoted " #"'),
    ])
  })

  it('accepts " #" inside a quoted description', () => {
    expect(
      checkFrontmatter(
        file,
        skill('name: demo\ndescription: "Posts to the #channel thread"'),
        'command'
      )
    ).toEqual([])
  })

  it('reports a description over the limit', () => {
    const long = 'a'.repeat(MAX_DESCRIPTION_CHARS + 1)
    expect(
      checkFrontmatter(
        file,
        skill(`name: demo\ndescription: ${long}`),
        'command'
      )
    ).toEqual([
      {
        file,
        message: `description is ${
          MAX_DESCRIPTION_CHARS + 1
        } characters; the limit is ${MAX_DESCRIPTION_CHARS}`,
      },
    ])
  })

  it('accepts a description at the limit', () => {
    const exact = 'a'.repeat(MAX_DESCRIPTION_CHARS)
    expect(
      checkFrontmatter(
        file,
        skill(`name: demo\ndescription: ${exact}`),
        'command'
      )
    ).toEqual([])
  })

  it.each([
    ['missing', 'name: demo'],
    ['empty', 'name: demo\ndescription: ""'],
    ['blank', 'name: demo\ndescription: "  "'],
    ['not a string', 'name: demo\ndescription: 42'],
    ['a list', 'name: demo\ndescription:\n  - a'],
  ])('reports a %s description', (_, frontmatter) => {
    expect(checkFrontmatter(file, skill(frontmatter), 'command')).toEqual([
      { file, message: 'description is missing or empty' },
    ])
  })

  it('reports a name that does not match the file', () => {
    expect(
      checkFrontmatter(file, skill('name: other\ndescription: x'), 'command')
    ).toEqual([{ file, message: 'name must be "demo", found "other"' }])
  })

  it('takes the expected name of a SKILL.md from its directory', () => {
    expect(
      checkFrontmatter(
        '.claude/skills/demo/SKILL.md',
        skill('name: demo\ndescription: x'),
        'command'
      )
    ).toEqual([])
  })

  it('only requires a rule to parse', () => {
    expect(
      checkFrontmatter(
        '.agents/rules/100-x.md',
        skill('globs: ["*.sol"]'),
        'rule'
      )
    ).toEqual([])
    expect(
      checkFrontmatter('.agents/rules/100-x.md', skill('a: b: c'), 'rule')
    ).toHaveLength(1)
  })

  it('ignores a skill whose frontmatter is not a mapping', () => {
    expect(checkFrontmatter(file, skill('- a'), 'command')).toEqual([])
  })
})

describe('checkBunScripts', () => {
  const scripts = new Set(['lint:md', 'troncast'])

  it('accepts package scripts and bun subcommands in code', () => {
    const text = [
      'Run `bun lint:md` then `bun run troncast address`.',
      '```bash',
      'bun install && bun test script/',
      'bunx tsx script/x.ts',
      '```',
    ].join('\n')
    expect(checkBunScripts('f.md', text, scripts)).toEqual([])
  })

  it('reports an unknown script in inline code and in a fence', () => {
    const text = ['`bun lint:gone`', '```', '(bun run missing)', '```'].join(
      '\n'
    )
    expect(checkBunScripts('f.md', text, scripts)).toEqual([
      { file: 'f.md', message: '`bun missing` names no package.json script' },
      { file: 'f.md', message: '`bun lint:gone` names no package.json script' },
    ])
  })

  it('ignores bun mentioned in prose', () => {
    expect(checkBunScripts('f.md', 'Requires bun and gh.', scripts)).toEqual([])
  })
})

describe('filesystem checks', () => {
  let root: string

  const write = (path: string, text = '') => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const link = (target: string, path: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    symlinkSync(target, join(root, path))
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agents-harness-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('checkLink', () => {
    it('accepts a symlink to the source', () => {
      write('.agents/commands/a.md')
      link('../../.agents/commands/a.md', '.cursor/commands/a.md')
      expect(
        checkLink(
          join(root, '.cursor/commands/a.md'),
          join(root, '.agents/commands/a.md')
        )
      ).toEqual([])
    })

    it('reports a missing link', () => {
      write('.agents/commands/a.md')
      const source = join(root, '.agents/commands/a.md')
      const missing = join(root, '.cursor/commands/a.md')
      expect(checkLink(missing, source)).toEqual([
        { file: source, message: `missing symlink ${missing}` },
      ])
    })

    it('reports a real file in place of the link', () => {
      write('.agents/commands/a.md')
      write('.cursor/commands/a.md')
      expect(
        checkLink(
          join(root, '.cursor/commands/a.md'),
          join(root, '.agents/commands/a.md')
        )[0]?.message
      ).toContain('is a real file')
    })

    it('reports a dangling link', () => {
      write('.agents/commands/a.md')
      link('../../.agents/commands/gone.md', '.cursor/commands/a.md')
      expect(
        checkLink(
          join(root, '.cursor/commands/a.md'),
          join(root, '.agents/commands/a.md')
        )[0]?.message
      ).toBe('dangling symlink')
    })

    it('reports a link to the wrong file', () => {
      write('.agents/commands/a.md')
      write('.agents/commands/b.md')
      link('../../.agents/commands/b.md', '.cursor/commands/a.md')
      expect(
        checkLink(
          join(root, '.cursor/commands/a.md'),
          join(root, '.agents/commands/a.md')
        )[0]?.message
      ).toContain('resolves elsewhere')
    })
  })

  describe('checkOrphanLinks', () => {
    it('reports dangling links and links outside .agents/', () => {
      write('.agents/rules/a.md')
      write('outside.md')
      write('.cursor/rules/plain.mdc')
      link('../../.agents/rules/a.md', '.cursor/rules/a.mdc')
      link('../../.agents/rules/gone.md', '.cursor/rules/gone.mdc')
      link('../../outside.md', '.cursor/rules/outside.mdc')
      expect(
        checkOrphanLinks(join(root, '.cursor/rules'), join(root, '.agents'))
      ).toEqual([
        {
          file: join(root, '.cursor/rules/gone.mdc'),
          message: 'dangling symlink',
        },
        {
          file: join(root, '.cursor/rules/outside.mdc'),
          message: 'does not point into .agents/',
        },
      ])
    })
  })

  describe('realSkillFiles', () => {
    it('returns only SKILL.md files that are not symlinks', () => {
      write('.agents/commands/a.md')
      link('../../../.agents/commands/a.md', '.claude/skills/a/SKILL.md')
      write('.claude/skills/b/SKILL.md')
      mkdirSync(join(root, '.claude/skills/empty'), { recursive: true })
      expect(realSkillFiles(root)).toEqual([
        join(root, '.claude/skills/b/SKILL.md'),
      ])
    })
  })

  describe('checkHarness', () => {
    const seedCleanRepo = () => {
      write('package.json', JSON.stringify({ scripts: { 'lint:md': 'x' } }))
      write('CLAUDE.md', 'Run `bun lint:md`.')
      write('.agents/commands/demo.md', skill('name: demo\ndescription: x'))
      write('.agents/rules/100-demo.md', skill('globs: ["*.sol"]'))
      link('../../../.agents/commands/demo.md', '.claude/skills/demo/SKILL.md')
      link('../../.agents/commands/demo.md', '.cursor/commands/demo.md')
      link('../../.agents/rules/100-demo.md', '.claude/rules/100-demo.md')
      link('../../.agents/rules/100-demo.md', '.cursor/rules/100-demo.mdc')
    }

    it('passes a clean checkout without context.md', () => {
      seedCleanRepo()
      expect(checkHarness(root)).toEqual([])
    })

    it('reports problems with repo-relative paths', () => {
      seedCleanRepo()
      write('.agents/context.md', '`bun lint:gone`')
      write('.claude/skills/real/SKILL.md', skill('name: real'))
      write('.agents/rules/200-bad.md', skill('a: b: c'))
      expect(checkHarness(root)).toEqual([
        {
          file: '.claude/skills/real/SKILL.md',
          message: 'description is missing or empty',
        },
        {
          file: '.agents/rules/200-bad.md',
          message: expect.stringContaining('not valid YAML'),
        },
        {
          file: '.agents/rules/200-bad.md',
          message: `missing symlink ${join(root, '.claude/rules/200-bad.md')}`,
        },
        {
          file: '.agents/rules/200-bad.md',
          message: `missing symlink ${join(root, '.cursor/rules/200-bad.mdc')}`,
        },
        {
          file: '.agents/context.md',
          message: '`bun lint:gone` names no package.json script',
        },
      ])
    })

    it('treats a package.json without scripts as having none', () => {
      seedCleanRepo()
      write('package.json', '{}')
      expect(checkHarness(root)).toEqual([
        {
          file: 'CLAUDE.md',
          message: '`bun lint:md` names no package.json script',
        },
      ])
    })
  })

  describe('reportHarness', () => {
    it('returns 0 for a clean checkout', () => {
      write('package.json', '{"scripts":{}}')
      write('.agents/commands/demo.md', skill('name: demo\ndescription: x'))
      mkdirSync(join(root, '.agents/rules'), { recursive: true })
      link('../../../.agents/commands/demo.md', '.claude/skills/demo/SKILL.md')
      link('../../.agents/commands/demo.md', '.cursor/commands/demo.md')
      mkdirSync(join(root, '.claude/rules'), { recursive: true })
      mkdirSync(join(root, '.cursor/rules'), { recursive: true })
      expect(reportHarness(root)).toBe(0)
    })

    it('returns 1 when a problem is found', () => {
      write('package.json', '{"scripts":{}}')
      write('.agents/commands/demo.md', skill('name: demo'))
      mkdirSync(join(root, '.agents/rules'), { recursive: true })
      mkdirSync(join(root, '.claude/skills'), { recursive: true })
      mkdirSync(join(root, '.claude/rules'), { recursive: true })
      mkdirSync(join(root, '.cursor/rules'), { recursive: true })
      mkdirSync(join(root, '.cursor/commands'), { recursive: true })
      expect(reportHarness(root)).toBe(1)
    })
  })
})

describe('the repository harness', () => {
  it('is clean', () => {
    expect(checkHarness(join(import.meta.dir, '../..'))).toEqual([])
  })
})
