import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { PluginMutationService } from '#core/plugins/plugin-mutation-service'
import { PluginRegistry } from '#core/plugins/plugin-registry'
import { HookRegistry } from '#core/hooks/hook-registry'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { ProjectResourceRegistry } from '#core/resources/resource-registry'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { resolveSystemPromptVariables } from '#core/system-prompt-templates'
import type { ClientCommand } from '#protocol/runtime-protocol'
import { buildApp } from '#app'

function writeJson(projectDir: string, relative: string, value: unknown): void {
  const file = path.join(projectDir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeTool(
  projectDir: string,
  relativeDir: string,
  packageName: string,
  packageVersion = '1.0.0',
): string {
  writeJson(projectDir, `${relativeDir}/manifest.json`, {
    version: 1,
    package: packageName,
    packageVersion,
    runner: { type: 'stdio', entry: 'runner.mjs' },
    tools: [{
      name: `${packageName.replace(/-/g, '_')}_probe`,
      description: `Probe ${packageName}`,
      permissions: ['probe:read'],
      sideEffects: 'none',
      replay: 'safe',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
    }],
  })
  fs.writeFileSync(
    path.join(projectDir, relativeDir, 'runner.mjs'),
    'process.stdin.resume()\n',
    'utf8',
  )
  return `${relativeDir}/manifest.json`
}

function writePlugin(
  projectDir: string,
  relativeDir: string,
  id: string,
  dependencies: Array<{ package: string; version?: string; bundled?: string }>,
  resources?: {
    variables?: string
    harnesses?: string[]
    hooks?: string[]
    trainingHooks?: string[]
  },
): void {
  writeJson(projectDir, `${relativeDir}/capybara.plugin.json`, {
    schemaVersion: 1,
    id,
    name: id,
    description: `${id} test plugin`,
    version: '1.0.0',
    ...(resources ? { resources } : {}),
    toolDependencies: dependencies,
  })
}

function hookSource(name: string, checkpoint: 'after_loop' | 'after_evaluation'): string {
  return `import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "${name}",
  description: "Plugin lifecycle fixture.",
  enabled: true,
  checkpoint: "${checkpoint}",
  trigger() { return true; },
  schedule: { priority: 0, timeoutMs: 2000, onError: "continue" },
  permissions: { artifacts: "write" },
  run() { return { artifacts: [{ title: "plugin-hook-ran", value: { ok: true } }] }; },
});
`
}

async function runOnce(loop: RuntimeLoop, suffix = 'initial'): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('plugin runtime timed out')), 5_000)
    const unsubscribe = loop.onEvent((event) => {
      if (event.type !== 'run.state.changed') return
      if (event.payload.status === 'completed') {
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      }
      if (event.payload.status === 'failed') {
        clearTimeout(timeout)
        unsubscribe()
        reject(new Error(event.payload.failure?.message ?? 'plugin runtime failed'))
      }
    })
  })
  const command: ClientCommand = {
    version: 1,
    kind: 'command',
    id: `plugin-runtime-command-${suffix}`,
    type: 'chat.message.send',
    sessionId: 'plugin-runtime-session',
    timestamp: new Date().toISOString(),
    payload: {
      clientMessageId: `plugin-runtime-message-${suffix}`,
      content: [{ type: 'text', text: 'use plugin guidance' }],
      autoStart: true,
    },
  }
  loop.validate(command)
  loop.execute(command, 1)
  await completed
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function project(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-plugin-system-'))
  initializeProjectDirectory(projectDir)
  return projectDir
}

test('plugin graph exposes dependencies in both directions and disabled plugins remain dependents', () => {
  const projectDir = project()
  try {
    const sharedManifest = writeTool(projectDir, 'tools/shared-tool', 'shared-tool')
    writePlugin(projectDir, 'plugins/alpha', 'alpha', [{ package: 'shared-tool', version: '^1.0.0' }])
    writePlugin(projectDir, 'plugins/beta', 'beta', [{ package: 'shared-tool', version: '>=1.0.0' }])
    const resources = new ProjectResources(projectDir)
    resources.saveSettings({
      ...resources.readSettings(),
      tools: [...resources.readSettings().tools, sharedManifest],
      plugins: [
        { id: 'alpha', path: 'plugins/alpha', enabled: true },
        { id: 'beta', path: 'plugins/beta', enabled: false },
      ],
    })

    const catalog = new ProjectResourceRegistry(projectDir).list()
    const shared = catalog.toolPackages.find((tool) => tool.package === 'shared-tool')
    const alpha = catalog.plugins.find((plugin) => plugin.id === 'alpha')
    assert.deepEqual(alpha?.toolDependencies, [{
      package: 'shared-tool',
      version: '^1.0.0',
      installedVersion: '1.0.0',
      manifestPath: 'tools/shared-tool/manifest.json',
      status: 'installed',
    }])
    assert.deepEqual(shared?.requiredBy.map((plugin) => [plugin.pluginId, plugin.enabled]), [
      ['alpha', true],
      ['beta', false],
    ])
    assert.equal(shared?.orphaned, false)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin catalog only exposes system variables referenced by each plugin', () => {
  const projectDir = project()
  try {
    const catalog = new ProjectResourceRegistry(projectDir).list()
    const system = catalog.plugins.find((plugin) => plugin.id === 'capybara-system')
    const projectPlugin = catalog.plugins.find((plugin) => plugin.id === 'project')
    assert.deepEqual(system?.variables, [])
    assert.deepEqual(
      system?.variableDependencies.map((dependency) => dependency.variable.key),
      ['dynamic_context'],
    )
    assert.equal(
      system?.variableDependencies[0]?.references.some(
        (reference) => reference.path.endsWith('variable-authoring/manifest.json'),
      ),
      true,
    )
    assert.equal(projectPlugin?.variables.some((variable) => variable.key === 'agent_identity'), true)
    assert.equal(projectPlugin?.variables.some((variable) => variable.key === 'resource_loading'), false)
    assert.equal(
      projectPlugin?.variableDependencies.some(
        (dependency) => dependency.variable.key === 'resource_loading'
          && dependency.references.some((reference) => reference.path === 'main.j2'),
      ),
      true,
    )
    assert.equal(
      projectPlugin?.variableDependencies.some(
        (dependency) => dependency.variable.key === 'dynamic_context',
      ),
      false,
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin creation needs only a plugin name and prepares an editable local skeleton', async () => {
  const projectDir = project()
  try {
    const service = new PluginMutationService(projectDir)
    const created = await service.create('document-analysis')
    assert.equal(created.plugin.id, 'document-analysis')
    assert.equal(created.plugin.enabled, true)
    assert.deepEqual(created.plugin.resources, {
      variables: 'plugins/document-analysis/variables.json',
      harnesses: [],
      hooks: ['plugins/document-analysis/hooks'],
      trainingHooks: ['plugins/document-analysis/training-hooks'],
    })
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins/document-analysis/capybara.plugin.json')), true)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins/document-analysis/variables.json')), true)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins/document-analysis/harnesses')), true)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins/document-analysis/hooks')), true)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins/document-analysis/training-hooks')), true)
    assert.deepEqual(
      new ProjectResources(projectDir).readSettings().plugins,
      [{ id: 'document-analysis', path: 'plugins/document-analysis', enabled: true }],
    )
    await assert.rejects(() => service.create('Document analysis'), /plugin name must use lowercase/)
    await assert.rejects(() => service.create('document-analysis'), /plugin already exists/)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('editable plugins create, update, validate, and remove Harnesses and Hooks', async () => {
  const projectDir = project()
  try {
    writePlugin(projectDir, 'plugins/authoring', 'authoring', [])
    const resources = new ProjectResources(projectDir)
    resources.saveSettings({
      ...resources.readSettings(),
      plugins: [{ id: 'authoring', path: 'plugins/authoring', enabled: true }],
    })
    const service = new PluginMutationService(projectDir)
    let catalog = new ProjectResourceRegistry(projectDir).list()

    const createdHarness = await service.createHarness('authoring', {
      catalogRevision: catalog.revision,
      name: 'writing-guide',
      description: 'Writing guidance for editor tasks.',
      type: 'experience',
      activation: { keywords: ['write'] },
      inputs: ['user_message'],
      requiredTools: [],
      content: 'Use the requested writing style.\n',
    })
    catalog = createdHarness.catalog
    const harness = catalog.items.flatMap((item) => item.kind === 'harness' ? item.harnesses : [])
      .find((item) => item.id === 'authoring:writing-guide')
    assert.equal(harness?.content, 'Use the requested writing style.\n')
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins/authoring/harnesses/manifest.json')), true)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins/authoring/harnesses/writing-guide.j2')), true)

    const savedHarness = await service.saveHarness('authoring', harness?.id ?? '', {
      catalogRevision: catalog.revision,
      entryRevision: harness?.entryRevision,
      content: 'Prefer concise prose.\n',
    })
    catalog = savedHarness.catalog
    const updatedHarness = catalog.items.flatMap((item) => item.kind === 'harness' ? item.harnesses : [])
      .find((item) => item.id === 'authoring:writing-guide')
    assert.equal(updatedHarness?.content, 'Prefer concise prose.\n')
    await assert.rejects(
      () => service.saveHarness('authoring', updatedHarness?.id ?? '', {
        catalogRevision: catalog.revision,
        entryRevision: harness?.entryRevision,
        content: 'stale update',
      }),
      /HARNESS_REVISION_CONFLICT/,
    )

    const createdRuntime = await service.createHook('authoring', {
      catalogRevision: catalog.revision,
      name: 'capture-context',
      mode: 'runtime',
      content: hookSource('capture-context', 'after_loop'),
    })
    catalog = createdRuntime.catalog
    const runtime = catalog.items.flatMap((item) => item.kind === 'hook' ? item.hooks : [])
      .find((item) => item.id === 'authoring:capture-context' && item.mode === 'runtime')
    assert.equal(runtime?.checkpoint, 'after_loop')

    await assert.rejects(
      () => service.saveHook('authoring', runtime?.id ?? '', {
        catalogRevision: catalog.revision,
        entryRevision: runtime?.entryRevision,
        content: hookSource('capture-context', 'after_evaluation'),
      }),
      /runtime plugin Hooks must use checkpoint after_loop/,
    )

    const createdTraining = await service.createHook('authoring', {
      catalogRevision: catalog.revision,
      name: 'learn-context',
      mode: 'training',
      content: hookSource('learn-context', 'after_evaluation'),
    })
    catalog = createdTraining.catalog
    const training = catalog.items.flatMap((item) => item.kind === 'hook' ? item.hooks : [])
      .find((item) => item.id === 'authoring:learn-context' && item.mode === 'training')
    assert.equal(training?.checkpoint, 'after_evaluation')

    const removedRuntime = await service.deleteHook('authoring', runtime?.id ?? '', {
      catalogRevision: catalog.revision,
      entryRevision: runtime?.entryRevision,
    })
    catalog = removedRuntime.catalog
    assert.equal(catalog.items.flatMap((item) => item.kind === 'hook' ? item.hooks : [])
      .some((item) => item.id === 'authoring:capture-context'), false)

    const removedHarness = await service.deleteHarness('authoring', updatedHarness?.id ?? '', {
      catalogRevision: catalog.revision,
      entryRevision: updatedHarness?.entryRevision,
    })
    catalog = removedHarness.catalog
    assert.equal(catalog.items.flatMap((item) => item.kind === 'harness' ? item.harnesses : [])
      .some((item) => item.id === 'authoring:writing-guide'), false)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins/authoring/harnesses/manifest.json')), false)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins/authoring/harnesses/writing-guide.j2')), false)

    const removedTraining = await service.deleteHook('authoring', training?.id ?? '', {
      catalogRevision: catalog.revision,
      entryRevision: training?.entryRevision,
    })
    assert.equal(removedTraining.catalog.items.flatMap((item) => item.kind === 'hook' ? item.hooks : [])
      .some((item) => item.id === 'authoring:learn-context'), false)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('the project plugin can author its own Harness and runtime Hook', async () => {
  const projectDir = project()
  try {
    const service = new PluginMutationService(projectDir)
    let catalog = new ProjectResourceRegistry(projectDir).list()
    const harnessResult = await service.createHarness('project', {
      catalogRevision: catalog.revision,
      name: 'project-guidance',
      description: 'Project-owned authoring guidance.',
      type: 'experience',
      activation: { keywords: ['project'] },
      inputs: ['user_message'],
      requiredTools: [],
      content: 'Project context: {{ user_message }}\n',
    })
    catalog = harnessResult.catalog
    assert.equal(catalog.items.flatMap((item) => item.kind === 'harness' ? item.harnesses : [])
      .some((item) => item.id === 'project:project-guidance'), true)
    const hookResult = await service.createHook('project', {
      catalogRevision: catalog.revision,
      name: 'project-checkpoint',
      mode: 'runtime',
      content: hookSource('project-checkpoint', 'after_loop'),
    })
    assert.equal(hookResult.catalog.items.flatMap((item) => item.kind === 'hook' ? item.hooks : [])
      .some((item) => item.id === 'project-checkpoint' && item.mode === 'runtime'), true)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin authoring accepts a persistent Harness without activation conditions', async () => {
  const projectDir = project()
  try {
    writePlugin(projectDir, 'plugins/persistent', 'persistent', [])
    const resources = new ProjectResources(projectDir)
    resources.saveSettings({
      ...resources.readSettings(),
      plugins: [{ id: 'persistent', path: 'plugins/persistent', enabled: true }],
    })
    const service = new PluginMutationService(projectDir)
    const before = new ProjectResourceRegistry(projectDir).list()
    const result = await service.createHarness('persistent', {
      catalogRevision: before.revision,
      name: 'always-loaded',
      description: 'Always include this guidance.',
      type: 'persistent',
      activation: {},
      inputs: ['user_message'],
      requiredTools: [],
      content: 'Always loaded guidance.\n',
    })
    const harness = result.catalog.items
      .flatMap((item) => item.kind === 'harness' ? item.harnesses : [])
      .find((item) => item.id === 'persistent:always-loaded')
    assert.equal(harness?.type, 'persistent')
    assert.deepEqual(harness?.activation, {})
    const tested = new ProjectResourceRegistry(projectDir).testHarness(
      'persistent:always-loaded',
      { request: 'unrelated request' },
    )
    assert.equal(tested.matched, true)
    assert.equal(tested.rendered, 'Always loaded guidance.')
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin variables can be added, edited, removed, and reject stale catalog revisions', async () => {
  const projectDir = project()
  try {
    writePlugin(projectDir, 'plugins/editor', 'editor', [], {})
    const resources = new ProjectResources(projectDir)
    resources.saveSettings({
      ...resources.readSettings(),
      plugins: [{ id: 'editor', path: 'plugins/editor', enabled: true }],
    })
    const service = new PluginMutationService(projectDir)
    const before = new ProjectResourceRegistry(projectDir).list()
    const added = await service.saveVariables('editor', {
      catalogRevision: before.revision,
      variables: [{
        key: 'editor_context',
        type: 'text',
        label: 'Editor context',
        description: 'Plugin-owned context.',
        value: 'first value',
        required: false,
        readonly: false,
        show_in_status: true,
        scope: 'session',
        source: 'plugin',
      }],
    })
    assert.deepEqual(added.plugin.variables.map((variable) => variable.key), ['editor_context'])
    assert.equal(added.plugin.resources.variables, 'plugins/editor/variables.json')
    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'plugins/editor/capybara.plugin.json'), 'utf8'),
    ) as { resources?: { variables?: string } }
    assert.equal(manifest.resources?.variables, 'variables.json')
    assert.equal(
      new PluginRegistry(projectDir).effectiveSystemVariablesState().resource.variables
        .find((variable) => variable.key === 'editor_context')?.value,
      'first value',
    )

    await assert.rejects(
      () => service.saveVariables('editor', {
        catalogRevision: before.revision,
        variables: [],
      }),
      /changed on disk/,
    )

    const edited = await service.saveVariables('editor', {
      catalogRevision: added.catalog.revision,
      variables: [{
        ...added.plugin.variables[0],
        value: 'edited value',
      }],
    })
    assert.equal(edited.plugin.variables[0]?.value, 'edited value')
    const removed = await service.saveVariables('editor', {
      catalogRevision: edited.catalog.revision,
      variables: [],
    })
    assert.deepEqual(removed.plugin.variables, [])
    assert.equal(
      new PluginRegistry(projectDir).effectiveSystemVariablesState().resource.variables
        .some((variable) => variable.key === 'editor_context'),
      false,
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin prompt_template variables use external Jinja2 files as the runtime source of truth', async () => {
  const projectDir = project()
  try {
    writeJson(projectDir, 'plugins/novel-editor/variables.json', {
      version: 1,
      variables: [
        {
          key: 'character_name',
          type: 'text',
          label: 'Character name',
          description: '',
          value: 'Ada',
          required: false,
          readonly: false,
          show_in_status: false,
        },
        {
          key: 'character_memory',
          type: 'prompt_template',
          label: 'Character memory',
          description: '',
          value: '',
          template: 'templates/variables/character-memory.j2',
          required: false,
          readonly: false,
          show_in_status: true,
        },
      ],
    })
    fs.mkdirSync(path.join(projectDir, 'plugins/novel-editor/templates/variables'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'plugins/novel-editor/templates/variables/character-memory.j2'),
      'Memory for {{ builtin.variables.character_name }} / {{ builtin.variables.resource_loading }}',
      'utf8',
    )
    writePlugin(projectDir, 'plugins/novel-editor', 'novel-editor', [], { variables: 'variables.json' })
    const resources = new ProjectResources(projectDir)
    resources.saveSettings({
      ...resources.readSettings(),
      plugins: [{ id: 'novel-editor', path: 'plugins/novel-editor', enabled: true }],
    })

    const catalog = new ProjectResourceRegistry(projectDir).list()
    const plugin = catalog.plugins.find((item) => item.id === 'novel-editor')
    assert.equal(plugin?.diagnostics.length, 0)
    const external = plugin?.variables.find((variable) => variable.key === 'character_memory')
    assert.equal(external?.template, 'templates/variables/character-memory.j2')
    assert.equal(external?.value, 'Memory for {{ builtin.variables.character_name }} / {{ builtin.variables.resource_loading }}')
    assert.equal(plugin?.variableDependencies.some((dependency) => dependency.variable.key === 'resource_loading'), true)
    const resolved = resolveSystemPromptVariables(
      new PluginRegistry(projectDir).effectiveSystemVariablesState().resource.variables,
    )
    assert.match(resolved.prompts.character_memory ?? '', /Memory for Ada \/ Project tools/)

    const service = new PluginMutationService(projectDir)
    const edited = await service.saveVariables('novel-editor', {
      catalogRevision: catalog.revision,
      variables: plugin?.variables ?? [],
    })
    const editedVariables = edited.plugin.variables.map((variable) => (
      variable.key === 'character_memory'
        ? { ...variable, value: 'Updated {{ builtin.variables.character_name }} / {{ builtin.variables.resource_loading }}' }
        : variable
    ))
    const updated = await service.saveVariables('novel-editor', {
      catalogRevision: edited.catalog.revision,
      variables: editedVariables,
    })
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'plugins/novel-editor/templates/variables/character-memory.j2'), 'utf8'),
      'Updated {{ builtin.variables.character_name }} / {{ builtin.variables.resource_loading }}',
    )
    const persisted = JSON.parse(fs.readFileSync(path.join(projectDir, 'plugins/novel-editor/variables.json'), 'utf8')) as {
      variables: Array<{ key: string; value: string; template?: string }>
    }
    const persistedTemplate = persisted.variables.find((variable) => variable.key === 'character_memory')
    assert.equal(persistedTemplate?.template, 'templates/variables/character-memory.j2')
    assert.equal(persistedTemplate?.value, '')
    assert.equal(updated.plugin.variables.find((variable) => variable.key === 'character_memory')?.value, 'Updated {{ builtin.variables.character_name }} / {{ builtin.variables.resource_loading }}')
    assert.match(
      resolveSystemPromptVariables(new PluginRegistry(projectDir).effectiveSystemVariablesState().resource.variables)
        .prompts.character_memory ?? '',
      /Updated Ada \/ Project tools/,
    )

    await assert.rejects(
      () => service.saveVariables('novel-editor', {
        catalogRevision: updated.catalog.revision,
        variables: updated.plugin.variables.map((variable) => (
          variable.key === 'character_memory' ? { ...variable, template: '../escape.j2' } : variable
        )),
      }),
      /relative \.j2 path|leaves the plugin directory/,
    )
    fs.rmSync(path.join(projectDir, 'plugins/novel-editor/templates/variables/character-memory.j2'))
    const missing = new ProjectResourceRegistry(projectDir).list().plugins.find((item) => item.id === 'novel-editor')
    assert.match(
      missing?.diagnostics.map((diagnostic) => diagnostic.message).join('; ') ?? '',
      /template|PLUGIN_VARIABLES_INVALID/i,
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('installed plugin variables preserve a project scope when edited', async () => {
  const projectDir = project()
  try {
    writePlugin(
      projectDir,
      '.capybara/imports/scoped-plugin',
      'scoped-plugin',
      [],
      { variables: 'variables.json' },
    )
    writeJson(projectDir, '.capybara/imports/scoped-plugin/variables.json', {
      version: 1,
      variables: [{
        key: 'shared_context',
        type: 'text',
        label: 'Shared context',
        description: 'Installed plugin context.',
        value: 'initial',
        required: false,
        readonly: false,
        show_in_status: true,
        scope: 'session',
      }],
    })

    const service = new PluginMutationService(projectDir)
    const installed = await service.install('.capybara/imports/scoped-plugin')
    const variable = installed.plugin.variables[0]
    assert.equal(variable?.scope, 'session')

    const edited = await service.saveVariables('scoped-plugin', {
      catalogRevision: installed.catalog.revision,
      variables: [{ ...variable!, scope: 'project' }],
    })
    assert.equal(edited.plugin.variables[0]?.scope, 'project')
    assert.equal(
      new ProjectResourceRegistry(projectDir).list().plugins
        .find((plugin) => plugin.id === 'scoped-plugin')?.variables[0]?.scope,
      'project',
    )
    assert.equal(
      new PluginRegistry(projectDir).effectiveSystemVariablesState().resource.variables
        .find((item) => item.key === 'shared_context')?.scope,
      'project',
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('removing a system variable dependency edits the consumer but preserves the global definition', async () => {
  const projectDir = project()
  try {
    const service = new PluginMutationService(projectDir)
    const before = new ProjectResourceRegistry(projectDir).list()
    const projectPlugin = before.plugins.find((plugin) => plugin.id === 'project')
    assert.equal(
      projectPlugin?.variableDependencies.some(
        (dependency) => dependency.variable.key === 'resource_loading',
      ),
      true,
    )
    const result = await service.removeVariableDependency('project', 'resource_loading', {
      catalogRevision: before.revision,
    })
    assert.equal(
      result.plugin.variableDependencies.some(
        (dependency) => dependency.variable.key === 'resource_loading',
      ),
      false,
    )
    assert.doesNotMatch(fs.readFileSync(path.join(projectDir, 'main.j2'), 'utf8'), /resource_loading/)
    assert.equal(
      new ProjectResources(projectDir).readSystemVariables().variables
        .some((variable) => variable.key === 'resource_loading'),
      true,
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('enabled plugin resources enter runtime and disabling removes them without releasing tool dependencies', async () => {
  const projectDir = project()
  const sharedManifest = writeTool(projectDir, 'tools/shared-tool', 'shared-tool')
  writeJson(projectDir, 'plugins/alpha/variables.json', {
    version: 1,
    variables: [{
      key: 'plugin_guidance',
      type: 'text',
      label: 'Plugin guidance',
      description: 'Context registered by alpha.',
      value: 'alpha context is active',
      required: true,
      readonly: false,
      show_in_status: true,
    }],
  })
  writeJson(projectDir, 'plugins/alpha/harnesses/manifest.json', {
    version: 1,
    package: 'alpha',
    harnesses: [{
      name: 'plugin-guidance',
      description: 'Adds alpha guidance.',
      type: 'experience',
      entry: 'guidance.j2',
      activation: { keywords: ['plugin'] },
      inputs: ['user_message'],
      requiredTools: [],
    }],
  })
  fs.writeFileSync(path.join(projectDir, 'plugins/alpha/harnesses/always-guidance.j2'), 'persistent alpha guidance', 'utf8')
  const harnessManifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'plugins/alpha/harnesses/manifest.json'), 'utf8')) as {
    harnesses: Array<Record<string, unknown>>
  }
  harnessManifest.harnesses.push({
    name: 'always-guidance',
    description: 'Always present alpha guidance.',
    type: 'persistent',
    entry: 'always-guidance.j2',
    activation: {},
    inputs: ['user_message'],
    requiredTools: [],
  })
  fs.writeFileSync(
    path.join(projectDir, 'plugins/alpha/harnesses/manifest.json'),
    `${JSON.stringify(harnessManifest, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(projectDir, 'plugins/alpha/harnesses/guidance.j2'), 'alpha harness', 'utf8')
  fs.mkdirSync(path.join(projectDir, 'plugins/alpha/hooks'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'plugins/alpha/training-hooks'), { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, 'plugins/alpha/hooks/plugin-loop.ts'),
    hookSource('plugin-loop', 'after_loop'),
    'utf8',
  )
  fs.writeFileSync(
    path.join(projectDir, 'plugins/alpha/training-hooks/plugin-training.ts'),
    hookSource('plugin-training', 'after_evaluation'),
    'utf8',
  )
  writePlugin(
    projectDir,
    'plugins/alpha',
    'alpha',
    [{ package: 'shared-tool', version: '^1.0.0' }],
    {
      variables: 'variables.json',
      harnesses: ['harnesses/manifest.json'],
      hooks: ['hooks'],
      trainingHooks: ['training-hooks'],
    },
  )
  const resources = new ProjectResources(projectDir)
  const settings = resources.readSettings()
  resources.saveSettings({
    ...settings,
    tools: [...settings.tools, sharedManifest],
    plugins: [{ id: 'alpha', path: 'plugins/alpha', enabled: true }],
  })
  const llm: RuntimeLlm = {
    chat: async () => ({
      provider: 'custom',
      model: 'plugin-test',
      text: JSON.stringify({ status: 'completed', content: 'done' }),
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      raw: {},
    }),
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'plugin-test',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1_000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  const service = new PluginMutationService(projectDir)
  try {
    const snapshot = loop.getSnapshot(0)
    const runtimePlugin = snapshot.plugins.items.find((plugin) => plugin.id === 'alpha')
    assert.equal(runtimePlugin?.status, 'active')
    assert.deepEqual(runtimePlugin?.variableKeys, ['plugin_guidance'])
    assert.deepEqual(runtimePlugin?.toolDependencies, [{
      package: 'shared-tool',
      requestedVersion: '^1.0.0',
      installedVersion: '1.0.0',
      status: 'installed',
    }])
    assert.deepEqual(runtimePlugin?.harnessIds, ['alpha:plugin-guidance', 'alpha:always-guidance'])
    assert.deepEqual(runtimePlugin?.hookIds, ['alpha:plugin-loop'])
    assert.deepEqual(runtimePlugin?.trainingHookIds, ['alpha:plugin-training'])
    assert.equal(snapshot.variables.value.builtin.prompts.plugin_guidance, 'alpha context is active')
    assert.ok(snapshot.harnesses.catalog.some((harness) => harness.id === 'alpha:plugin-guidance'))
    const persistent = snapshot.harnesses.items.find((harness) => harness.id === 'alpha:always-guidance')
    assert.equal(persistent?.type, 'persistent')
    assert.equal(persistent?.content, 'persistent alpha guidance')
    assert.equal(persistent?.bindings[0]?.source, 'persistent')
    assert.deepEqual(
      new HookRegistry(projectDir).list().filter((hook) => hook.ownerId === 'alpha').map((hook) => hook.id),
      ['alpha:plugin-loop'],
    )
    assert.deepEqual(
      new HookRegistry(projectDir).listTraining().filter((hook) => hook.ownerId === 'alpha').map((hook) => hook.id),
      ['alpha:plugin-training'],
    )
    await runOnce(loop)
    assert.ok(loop.getSnapshot(0).artifacts.items.some((artifact) => artifact.label === 'plugin-hook-ran'))
    const plugin = new ProjectResourceRegistry(projectDir).list().plugins.find((item) => item.id === 'alpha')
    assert.deepEqual(plugin?.variables.map((variable) => [variable.key, variable.owner]), [
      ['plugin_guidance', 'alpha'],
    ])
    assert.ok(plugin?.resourceModuleIds.some((id) => id === 'hook-module:runtime:alpha:plugin-loop'))
    assert.ok(plugin?.resourceModuleIds.some((id) => id === 'hook-module:training:alpha:plugin-training'))

    const artifactCount = loop.getSnapshot(0).artifacts.items
      .filter((artifact) => artifact.label === 'plugin-hook-ran').length
    assert.equal(artifactCount, 1)
    const disabled = await service.setEnabled('alpha', false)
    await waitFor(() => (
      loop.getSnapshot(0).plugins.items.find((item) => item.id === 'alpha')?.status === 'disabled'
      && loop.getSnapshot(0).variables.value.builtin.prompts.plugin_guidance === undefined
      && !loop.getSnapshot(0).harnesses.catalog.some((item) => item.id === 'alpha:plugin-guidance')
    ))
    await runOnce(loop, 'disabled')
    assert.equal(
      loop.getSnapshot(0).artifacts.items.filter((artifact) => artifact.label === 'plugin-hook-ran').length,
      0,
    )
    assert.equal(disabled.plugin.enabled, false)
    assert.ok(disabled.plugin.resourceModuleIds.includes('harness-module:plugins/alpha/harnesses/manifest.json'))
    assert.ok(disabled.plugin.resourceModuleIds.includes('hook-module:runtime:alpha:plugin-loop'))
    assert.ok(disabled.plugin.resourceModuleIds.includes('hook-module:training:alpha:plugin-training'))
    assert.deepEqual(
      disabled.catalog.toolPackages.find((tool) => tool.package === 'shared-tool')?.requiredBy,
      [{ pluginId: 'alpha', pluginName: 'alpha', requestedVersion: '^1.0.0', enabled: false }],
    )
    await assert.rejects(
      () => service.uninstallTool('shared-tool'),
      /required by installed plugins: alpha/,
    )
  } finally {
    loop.close()
  }

  const disabledLoop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const snapshot = disabledLoop.getSnapshot(0)
    const runtimePlugin = snapshot.plugins.items.find((plugin) => plugin.id === 'alpha')
    assert.equal(runtimePlugin?.status, 'disabled')
    assert.deepEqual(runtimePlugin?.toolDependencies, [{
      package: 'shared-tool',
      requestedVersion: '^1.0.0',
      installedVersion: '1.0.0',
      status: 'installed',
    }])
    assert.deepEqual(runtimePlugin?.harnessIds, ['alpha:plugin-guidance', 'alpha:always-guidance'])
    assert.deepEqual(runtimePlugin?.hookIds, ['alpha:plugin-loop'])
    assert.deepEqual(runtimePlugin?.trainingHookIds, ['alpha:plugin-training'])
    assert.equal(snapshot.variables.value.builtin.prompts.plugin_guidance, undefined)
    assert.equal(snapshot.harnesses.catalog.some((item) => item.id === 'alpha:plugin-guidance'), false)
    assert.equal(new HookRegistry(projectDir).list().some((hook) => hook.ownerId === 'alpha'), false)
    assert.equal(new HookRegistry(projectDir).listTraining().some((hook) => hook.ownerId === 'alpha'), false)
  } finally {
    disabledLoop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin uninstall reports only newly orphaned tools and required tools cannot be removed', async () => {
  const projectDir = project()
  try {
    const sharedManifest = writeTool(projectDir, 'tools/shared-tool', 'shared-tool')
    writePlugin(projectDir, 'plugins/alpha', 'alpha', [{ package: 'shared-tool' }])
    writePlugin(projectDir, 'plugins/beta', 'beta', [{ package: 'shared-tool' }])
    const resources = new ProjectResources(projectDir)
    const settings = resources.readSettings()
    resources.saveSettings({
      ...settings,
      tools: [...settings.tools, sharedManifest],
      plugins: [
        { id: 'alpha', path: 'plugins/alpha', enabled: true },
        { id: 'beta', path: 'plugins/beta', enabled: true },
      ],
    })
    const service = new PluginMutationService(projectDir)
    await assert.rejects(() => service.uninstallTool('shared-tool'), /required by installed plugins: alpha, beta/)

    const first = await service.uninstall('alpha')
    assert.deepEqual(first.orphanedTools, [])
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins', 'alpha')), false)

    const second = await service.uninstall('beta')
    assert.deepEqual(second.orphanedTools.map((tool) => tool.package), ['shared-tool'])
    assert.deepEqual(second.orphanedTools[0]?.requiredBy, [])
    assert.equal(fs.existsSync(path.join(projectDir, 'tools', 'shared-tool')), true)

    const removed = await service.uninstallTool('shared-tool')
    assert.equal(removed.removedTool.package, 'shared-tool')
    assert.equal(fs.existsSync(path.join(projectDir, 'tools', 'shared-tool')), false)
    assert.equal(fs.existsSync(path.join(projectDir, removed.removedTool.trashPath)), true)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin install reuses compatible tools and installs missing bundled tools before the plugin', async () => {
  const projectDir = project()
  try {
    writePlugin(projectDir, '.capybara/imports/reporting', 'reporting', [
      { package: 'project-files', version: '^1.0.0' },
      { package: 'report-export', version: '^2.0.0', bundled: 'tool-packages/report-export' },
    ])
    writeTool(projectDir, '.capybara/imports/reporting/tool-packages/report-export', 'report-export', '2.1.0')
    const service = new PluginMutationService(projectDir)
    const preview = service.preview('.capybara/imports/reporting')
    assert.equal(preview.valid, true)
    assert.deepEqual(preview.tools.map((tool) => [tool.package, tool.action]), [
      ['project-files', 'reuse'],
      ['report-export', 'install'],
    ])

    const result = await service.install('.capybara/imports/reporting')
    assert.equal(result.plugin.id, 'reporting')
    assert.deepEqual(result.reusedTools.map((tool) => tool.package), ['project-files'])
    assert.deepEqual(result.installedTools.map((tool) => tool.package), ['report-export'])
    assert.equal(fs.existsSync(path.join(projectDir, 'tools', 'report-export', 'manifest.json')), true)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins', 'reporting', 'capybara.plugin.json')), true)
    const config = new ProjectResources(projectDir).readSettings()
    assert.equal(config.tools.includes('tools/report-export/manifest.json'), true)
    assert.equal(config.plugins.some((plugin) => plugin.id === 'reporting' && plugin.enabled), true)
    assert.equal(config.tool_permissions.includes('probe:read'), true)
    assert.equal(fs.existsSync(path.join(projectDir, '.capybara', 'resource-lock.json')), true)
    const stagingRoot = path.join(projectDir, '.capybara', 'staging')
    assert.equal(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).length : 0, 0)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin install rejects missing and conflicting tools and rolls back invalid resources', async () => {
  const projectDir = project()
  try {
    writePlugin(projectDir, '.capybara/imports/missing', 'missing', [{ package: 'not-bundled' }])
    const missingService = new PluginMutationService(projectDir)
    assert.equal(missingService.preview('.capybara/imports/missing').valid, false)
    await assert.rejects(
      () => missingService.install('.capybara/imports/missing'),
      /missing tool package without a bundled source/,
    )

    writePlugin(projectDir, '.capybara/imports/conflict', 'conflict', [{ package: 'project-files', version: '^2.0.0' }])
    assert.equal(missingService.preview('.capybara/imports/conflict').tools[0]?.action, 'conflict')
    await assert.rejects(
      () => missingService.install('.capybara/imports/conflict'),
      /dependency conflict/,
    )

    writePlugin(
      projectDir,
      '.capybara/imports/invalid-resource',
      'invalid-resource',
      [],
      { harnesses: ['harnesses/missing/manifest.json'] },
    )
    const before = new ProjectResources(projectDir).readSettings()
    await assert.rejects(
      () => missingService.install('.capybara/imports/invalid-resource'),
      /ENOENT|no such file|realpath/,
    )
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins', 'invalid-resource')), false)
    assert.deepEqual(new ProjectResources(projectDir).readSettings(), before)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin install and enable reject invalid declared Hooks and Harnesses without leaving partial state', async () => {
  const projectDir = project()
  try {
    fs.mkdirSync(path.join(projectDir, '.capybara/imports/invalid-hook/hooks'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, '.capybara/imports/invalid-hook/hooks/not-runtime.ts'),
      hookSource('not-runtime', 'after_evaluation'),
      'utf8',
    )
    writePlugin(
      projectDir,
      '.capybara/imports/invalid-hook',
      'invalid-hook',
      [],
      { hooks: ['hooks'] },
    )
    const service = new PluginMutationService(projectDir)
    const before = new ProjectResources(projectDir).readSettings()
    await assert.rejects(
      () => service.install('.capybara/imports/invalid-hook'),
      /runtime plugin Hooks must use checkpoint after_loop/,
    )
    assert.deepEqual(new ProjectResources(projectDir).readSettings(), before)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins', 'invalid-hook')), false)

    writeJson(projectDir, '.capybara/imports/invalid-harness/harnesses/manifest.json', {
      version: 1,
      package: 'invalid-harness',
      harnesses: [{
        name: 'broken',
        description: 'Invalid activation fixture.',
        type: 'experience',
        entry: 'broken.j2',
        activation: {},
        inputs: ['user_message'],
        requiredTools: [],
      }],
    })
    fs.writeFileSync(
      path.join(projectDir, '.capybara/imports/invalid-harness/harnesses/broken.j2'),
      'broken',
      'utf8',
    )
    writePlugin(
      projectDir,
      '.capybara/imports/invalid-harness',
      'invalid-harness',
      [],
      { harnesses: ['harnesses/manifest.json'] },
    )
    await assert.rejects(
      () => service.install('.capybara/imports/invalid-harness'),
      /requires activation\.keywords/,
    )
    assert.deepEqual(new ProjectResources(projectDir).readSettings(), before)
    assert.equal(fs.existsSync(path.join(projectDir, 'plugins', 'invalid-harness')), false)

    fs.mkdirSync(path.join(projectDir, 'plugins/disabled-invalid/hooks'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'plugins/disabled-invalid/hooks/not-runtime.ts'),
      hookSource('not-runtime', 'after_evaluation'),
      'utf8',
    )
    writePlugin(
      projectDir,
      'plugins/disabled-invalid',
      'disabled-invalid',
      [],
      { hooks: ['hooks'] },
    )
    const resources = new ProjectResources(projectDir)
    resources.saveSettings({
      ...resources.readSettings(),
      plugins: [{ id: 'disabled-invalid', path: 'plugins/disabled-invalid', enabled: false }],
    })
    const disabled = new ProjectResourceRegistry(projectDir).list().plugins
      .find((plugin) => plugin.id === 'disabled-invalid')
    assert.equal(disabled?.enabled, false)
    assert.match(disabled?.diagnostics.map((diagnostic) => diagnostic.message).join('; ') ?? '', /after_loop/)
    await assert.rejects(
      () => service.setEnabled('disabled-invalid', true),
      /runtime plugin Hooks must use checkpoint after_loop/,
    )
    assert.equal(
      new ProjectResources(projectDir).readSettings().plugins.find((plugin) => plugin.id === 'disabled-invalid')?.enabled,
      false,
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin resources cannot escape the project through symbolic links', async (context) => {
  const projectDir = project()
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-plugin-outside-'))
  try {
    writeJson(outsideDir, 'variables.json', {
      version: 1,
      variables: [{
        key: 'escaped',
        type: 'text',
        label: 'Escaped',
        description: 'Must not load.',
        value: 'outside',
        required: false,
        readonly: false,
      }],
    })
    fs.mkdirSync(path.join(projectDir, 'plugins/escape'), { recursive: true })
    try {
      fs.symlinkSync(
        path.join(outsideDir, 'variables.json'),
        path.join(projectDir, 'plugins/escape/variables.json'),
        'file',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip('symbolic links are not available in this Windows environment')
        return
      }
      throw error
    }
    writePlugin(projectDir, 'plugins/escape', 'escape', [], { variables: 'variables.json' })
    const resources = new ProjectResources(projectDir)
    resources.saveSettings({
      ...resources.readSettings(),
      plugins: [{ id: 'escape', path: 'plugins/escape', enabled: false }],
    })
    const plugin = new ProjectResourceRegistry(projectDir).list().plugins.find((item) => item.id === 'escape')
    assert.match(plugin?.diagnostics.map((diagnostic) => diagnostic.message).join('; ') ?? '', /symlink leaves/)
    await assert.rejects(
      () => new PluginMutationService(projectDir).setEnabled('escape', true),
      /symlink leaves/,
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('legacy projects keep the v1 catalog without first-class plugin metadata', () => {
  const projectDir = project()
  try {
    fs.rmSync(path.join(projectDir, 'capybara.plugin.json'))
    const resources = new ProjectResources(projectDir)
    resources.saveSettings({ ...resources.readSettings(), resource_format: 1, plugins: [] })
    const catalog = new ProjectResourceRegistry(projectDir).list()
    assert.deepEqual(catalog.plugins, [])
    assert.deepEqual(catalog.toolPackages, [])
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('plugin HTTP API creates local plugins, exposes install preview, and protects dependent tool removal', async () => {
  const projectDir = project()
  const app = await buildApp({ runtimeLoop: { projectDir } })
  try {
    const query = `?projectPath=${encodeURIComponent(projectDir)}`
    const created = await app.inject({
      method: 'POST',
      url: `/api/resources/plugins${query}`,
      payload: { name: 'http-created' },
    })
    assert.equal(created.statusCode, 201)
    assert.equal(created.json().plugin.id, 'http-created')

    writePlugin(projectDir, '.capybara/imports/http-addon', 'http-addon', [
      { package: 'project-files', version: '^1.0.0' },
    ])
    const preview = await app.inject({
      method: 'POST',
      url: `/api/resources/plugins/install/preview${query}`,
      payload: { source: '.capybara/imports/http-addon' },
    })
    assert.equal(preview.statusCode, 200)
    assert.deepEqual(preview.json().tools.map((tool: any) => tool.action), ['reuse'])

    const installed = await app.inject({
      method: 'POST',
      url: `/api/resources/plugins/install${query}`,
      payload: { source: '.capybara/imports/http-addon' },
    })
    assert.equal(installed.statusCode, 201)
    assert.equal(installed.json().plugin.id, 'http-addon')

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/resources/plugins/http-addon${query}`,
      payload: { enabled: false },
    })
    assert.equal(disabled.statusCode, 200)
    assert.equal(disabled.json().plugin.enabled, false)

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/resources/tools/packages/project-files${query}`,
    })
    assert.equal(blocked.statusCode, 400)
    assert.match(blocked.body, /required by installed plugins: project, http-addon/)

    const enabled = await app.inject({
      method: 'PATCH',
      url: `/api/resources/plugins/http-addon${query}`,
      payload: { enabled: true },
    })
    assert.equal(enabled.statusCode, 200)
    assert.equal(enabled.json().plugin.enabled, true)

    const uninstalled = await app.inject({
      method: 'DELETE',
      url: `/api/resources/plugins/http-addon${query}`,
    })
    assert.equal(uninstalled.statusCode, 200)
    assert.deepEqual(uninstalled.json().orphanedTools, [])
  } finally {
    await app.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
