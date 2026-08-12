import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SkillMarketplaceService,
  type SkillCommandRunner,
} from '#core/skills/skill-marketplace'

const COMMIT = '1234567890abcdef1234567890abcdef12345678'

function createProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-skill-marketplace-'))
  fs.mkdirSync(path.join(projectDir, '.capybara'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'config.json'), `${JSON.stringify({
    main_template: 'main.j2',
    max_messages: 20,
    max_tool_rounds: 8,
    tool_timeout_ms: 15_000,
    llm: { model: 'test-model', base_url: 'https://example.test/v1', protocol: 'responses' },
    context: { max_input_tokens: 16_000, reserved_output_tokens: 2_000 },
    tools: [],
    skills: [],
    harnesses: [],
    harness_policy: { experience_top_k: 3, experience_threshold: 0.35, experience_auto_attach: true },
    tool_permissions: [],
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(projectDir, 'main.j2'), 'test')
  return projectDir
}

function fakeRunner(): SkillCommandRunner {
  return async (argumentsValue) => {
    if (argumentsValue[0] !== 'skill') throw new Error('unexpected gh command')
    if (argumentsValue[1] === 'search') {
      return {
        stdout: JSON.stringify([{
          description: 'A controlled test Skill',
          namespace: '',
          path: 'skills/test-skill/SKILL.md',
          repo: 'example/skills',
          skillName: 'test-skill',
          stars: 42,
        }]),
        stderr: '',
      }
    }
    if (argumentsValue[1] !== 'install') throw new Error('unexpected gh skill command')
    const directoryIndex = argumentsValue.indexOf('--dir')
    assert.notEqual(directoryIndex, -1)
    const destination = argumentsValue[directoryIndex + 1]
    assert.ok(destination)
    // Remote repositories do not always name the containing directory after
    // the Skill frontmatter name. Installation must normalize the local path.
    const root = path.join(destination, 'typescript')
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'SKILL.md'), [
      '---',
      'name: test-skill',
      'description: A controlled test Skill',
      'allowed-tools: read_file',
      'metadata:',
      '  github-ref: refs/heads/main',
      '---',
      '# Test Skill',
      '',
      'Use the controlled test workflow.',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(root, 'scripts', 'run.js'), 'console.log("test")\n')
    return {
      stdout: 'Installed test-skill\n',
      stderr: `Review with: gh skill preview example/skills test-skill@${COMMIT}\n`,
    }
  }
}

test('Skill marketplace search and preview are structured and do not modify the project', async () => {
  const projectDir = createProject()
  try {
    const service = new SkillMarketplaceService(projectDir, fakeRunner())
    const search = await service.search({ query: 'test', page: 1, limit: 15 })
    assert.deepEqual(search, {
      page: 1,
      items: [{
        description: 'A controlled test Skill',
        namespace: '',
        path: 'skills/test-skill/SKILL.md',
        repo: 'example/skills',
        skillName: 'test-skill',
        stars: 42,
        installed: false,
      }],
    })

    const preview = await service.preview({ repo: 'example/skills', path: 'skills/test-skill/SKILL.md' })
    assert.equal(preview.commit, COMMIT)
    assert.equal(preview.skillName, 'test-skill')
    assert.equal(preview.allowedTools, 'read_file')
    assert.deepEqual(preview.files.map((file) => [file.path, file.kind]), [
      ['scripts/run.js', 'script'],
      ['SKILL.md', 'entry'],
    ])
    assert.match(preview.warnings.join('\n'), /executable scripts/i)
    assert.match(preview.warnings.join('\n'), /typescript will be installed as test-skill/i)
    assert.equal(fs.existsSync(path.join(projectDir, 'skills', 'test-skill')), false)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Skill marketplace installs a pinned Skill and supports recoverable removal', async () => {
  const projectDir = createProject()
  try {
    const service = new SkillMarketplaceService(projectDir, fakeRunner())
    const installed = await service.install({
      repo: 'example/skills',
      path: 'skills/test-skill/SKILL.md',
      commit: COMMIT,
    })
    assert.equal(installed.skill?.id, 'test-skill')
    assert.equal(installed.skill?.managed, true)
    assert.equal(installed.skill?.hasLocalChanges, false)
    assert.equal(installed.catalog.items.some((item) => item.kind === 'skill' && item.name === 'test-skill'), true)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(projectDir, '.capybara', 'config.json'), 'utf8')).skills,
      ['skills/test-skill'],
    )

    fs.appendFileSync(path.join(projectDir, 'skills', 'test-skill', 'SKILL.md'), '\nLocal change.\n')
    assert.equal(service.installed()[0]?.hasLocalChanges, true)

    const removed = await service.uninstall('test-skill')
    assert.equal(removed.hadLocalChanges, true)
    assert.equal(fs.existsSync(path.join(projectDir, 'skills', 'test-skill')), false)
    assert.equal(fs.existsSync(path.join(projectDir, removed.trashPath)), true)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(projectDir, '.capybara', 'config.json'), 'utf8')).skills,
      [],
    )

    const restored = await service.restore(removed.id)
    assert.equal(restored.restored, true)
    assert.equal(restored.skillId, 'test-skill')
    assert.equal(fs.existsSync(path.join(projectDir, 'skills', 'test-skill', 'SKILL.md')), true)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(projectDir, '.capybara', 'config.json'), 'utf8')).skills,
      ['skills/test-skill'],
    )
    assert.match(fs.readFileSync(path.join(projectDir, 'skills', 'test-skill', 'SKILL.md'), 'utf8'), /Local change/)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Skill marketplace rejects unsafe repository, path, and unpinned install inputs', async () => {
  const projectDir = createProject()
  try {
    const service = new SkillMarketplaceService(projectDir, fakeRunner())
    await assert.rejects(() => service.preview({ repo: 'example/skills;whoami', path: 'test-skill' }), /OWNER\/REPO/)
    await assert.rejects(() => service.preview({ repo: 'example/skills', path: '../test-skill' }), /invalid/)
    await assert.rejects(() => service.install({ repo: 'example/skills', path: 'test-skill', commit: 'main' }), /full commit SHA/)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
