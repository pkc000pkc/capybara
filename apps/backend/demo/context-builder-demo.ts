import 'dotenv/config'
import path from 'node:path'
import nunjucks from 'nunjucks'
import { ContextBuilder } from '#core/context-builder'
import { ProjectResources } from '#core/project-resources'

const projectDir = path.resolve(process.env.CAPYBARA_PROJECT_DIR ?? 'test-project')
const resources = new ProjectResources(projectDir)
const prompts = Object.fromEntries(
  resources.readSystemVariables().variables.map((variable) => [variable.key, variable.value]),
)
const environment = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(projectDir, { noCache: true }),
  { autoescape: false },
)
const harness = (file: string) => ({
  id: `j2:${file}`,
  name: path.basename(file, '.j2'),
  content: environment.render(file, { sub_props: '子属性: 1, 2, 3' }),
})

const contextBuilder = new ContextBuilder({
  projectDir,
  properties: {
    builtin: {
      workspace_path: projectDir,
      prompts,
    },
    agent: { name: 'Capybara' },
    task: { title: '检查运行时状态' },
    user_message: '验证上下文初始化',
    tools: [],
    harnesses: [harness('roles/developer.j2')],
    optionalNote: null,
  },
})

contextBuilder.onRender(({ reason, status, missingVariables, includedFiles, output }) => {
  console.log(`\n[${reason}] status=${status}`)
  if (missingVariables.length > 0) {
    console.log(`Missing variables: ${missingVariables.join(', ')}`)
  }
  console.log(`Included files: ${includedFiles.join(', ') || '(none)'}`)
  console.log(output.trim())
})

contextBuilder.build()
contextBuilder.setProperty('harnesses', [harness('roles/reviewer.j2')])
contextBuilder.setProperty('task', { title: '审查 Loop 的生命周期' })
contextBuilder.close()
resources.close()
