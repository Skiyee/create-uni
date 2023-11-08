#!/usr/bin/env node

import { basename, join, resolve } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import process from 'node:process'
import ejs from 'ejs'
import minimist from 'minimist'
import prompts from 'prompts'
import { bold, red } from 'kolorist'
import figures from 'prompts/lib/util/figures.js'
import {
  canSkipEmptying,
  dowloadTemplate,
  preOrderDirectoryTraverse,
  printBanner,
  printFinish,
  renderTemplate,
  replaceProjectName,
} from './utils'
import { question } from './question'
import type { BaseTemplateList } from './question/template/type'
import { postOrderDirectoryTraverse } from './utils/directoryTraverse'
import filePrompt from './question/file'
import { templateList } from './question/template/templateDate'

async function init() {
  printBanner()

  const argv = minimist(process.argv.slice(2), {
    alias: {
      templateType: ['t'],
    },
    string: ['_'],
  })
  const projectName = argv._[0]
  const templateType = templateList.find(item => item.value.type === argv?.t)?.value

  let result: {
    projectName?: string
    shouldOverwrite?: boolean
    templateType?: BaseTemplateList['value']
    needsTypeScript?: boolean
    needsJsx?: boolean
    needsPinia?: boolean
    // needsVitest?: boolean
    needsEslint?: boolean
    needsUnocss?: boolean
  } = {}

  if (!projectName) {
    try {
      result = await question()
    }
    catch (cancelled) {
    // eslint-disable-next-line no-console
      console.log((<{ message: string }>cancelled).message)
      process.exit(1)
    }
  }
  else {
    if (!templateType) {
      // eslint-disable-next-line no-console
      console.log(`${red(figures.cross)} ${bold('未获取到指定模板')}`)
      process.exit(1)
    }
    result = {
      projectName,
      shouldOverwrite: canSkipEmptying(projectName)
        ? true
        : (await prompts(filePrompt(projectName))).shouldOverwrite,
      templateType,
    }
  }

  const cwd = process.cwd()
  const root = join(cwd, result.projectName!)
  const userAgent = process.env.npm_config_user_agent ?? ''
  const packageManager = /pnpm/.test(userAgent) ? 'pnpm' : /yarn/.test(userAgent) ? 'yarn' : 'npm'

  function emptyDir(dir: string) {
    if (!existsSync(dir))
      return

    postOrderDirectoryTraverse(
      dir,
      dir => rmdirSync(dir),
      file => unlinkSync(file),
    )
  }

  if (existsSync(root) && result.shouldOverwrite)
    emptyDir(root)

  else if (!existsSync(root))
    mkdirSync(root)

  if (result.templateType!.type !== 'custom') {
    const { templateType, projectName } = result
    await dowloadTemplate(templateType!, projectName!, root)
    printFinish(root, cwd, packageManager, 'repo')
    return
  }

  const templateRoot = resolve(__dirname, 'template')

  type Callback = (dataStore: Record<string, any>) => void
  const callbacks: Callback[] = []
  function render(templateName: string) {
    const templateDir = resolve(templateRoot, templateName)
    renderTemplate(templateDir, root, callbacks)
  }

  // Render templates
  render('base')

  const entry = {
    pinia: result.needsPinia && !result.needsUnocss,
    unocss: result.needsUnocss && !result.needsPinia,
    piniaAndUnocss: result.needsPinia && result.needsUnocss,
    default: !result.needsPinia && !result.needsUnocss,
  }
  for (const [key, needs] of Object.entries(entry)) {
    if (needs)
      render(`entry/${key}`)
  }

  const code = {
    unocss: result.needsUnocss,
    default: !result.needsUnocss,
  }
  for (const [key, needs] of Object.entries(code)) {
    if (needs)
      render(`code/${key}`)
  }

  const config = {
    jsx: result.needsJsx,
    pinia: result.needsPinia,
    typescript: result.needsTypeScript,
    js: !result.needsTypeScript,
    unocss: result.needsUnocss,
    lint: result.needsEslint,
  }
  for (const [key, needs] of Object.entries(config)) {
    if (needs)
      render(`config/${key}`)
  }

  const manager = {
    pnpm: packageManager === 'pnpm',
  }
  for (const [key, needs] of Object.entries(manager)) {
    if (needs)
      render(`manager/${key}`)
  }

  const dataStore: Record<string, any> = {}
  // Process callbacks
  for (const cb of callbacks)
    await cb(dataStore)

  preOrderDirectoryTraverse(
    root,
    () => {},
    (filepath) => {
      if (filepath.endsWith('.ejs')) {
        const template = readFileSync(filepath, 'utf-8')
        const dest = filepath.replace(/\.ejs$/, '')
        const content = ejs.render(template, dataStore[dest])

        writeFileSync(dest, content)
        unlinkSync(filepath)
      }
    },
  )

  if (result.needsTypeScript) {
    // Rename `.js` to `.ts`
    preOrderDirectoryTraverse(
      root,
      () => {},
      (filepath) => {
        if (filepath.endsWith('.js') && !filepath.endsWith('eslint.config.js')) {
          const tsFilePath = filepath.replace(/\.js$/, '.ts')
          if (existsSync(tsFilePath))
            unlinkSync(filepath)

          else
            renameSync(filepath, tsFilePath)
        }
      },
    )

    // Rename entry in `index.html`
    const indexHtmlPath = resolve(root, 'index.html')
    const indexHtmlContent = readFileSync(indexHtmlPath, 'utf8')
    writeFileSync(indexHtmlPath, indexHtmlContent.replace('src/main.js', 'src/main.ts'))

    // Rename <script setup> To <script setup lang="ts">
    preOrderDirectoryTraverse(
      resolve(root, 'src'),
      () => {},
      (filepath) => {
        if (filepath.endsWith('.vue')) {
          const vueContent = readFileSync(filepath, 'utf8')
          const vueContentWithTs = vueContent.replace('<script setup>', '<script setup lang="ts">')
          writeFileSync(filepath, vueContentWithTs)
        }
      },
    )
  }
  else {
    // Remove all the remaining `.ts` files
    preOrderDirectoryTraverse(
      root,
      () => {},
      (filepath) => {
        if (basename(filepath) === 'uno.config.ts') {
          // 移除文件里的类型声明
          const unoConfigContent = readFileSync(filepath, 'utf8')
          const unoConfigContentWithoutType
          = unoConfigContent.replace(
`import type { Preset, SourceCodeTransformer } from 'unocss'

`,
'',
          ).replace(': Preset[]', '').replace(': SourceCodeTransformer[]', '')
          const newFilepath = filepath.replace(/\.ts$/, '.js')
          unlinkSync(filepath)
          writeFileSync(newFilepath, unoConfigContentWithoutType)
        }
      },
    )
  }
  replaceProjectName(root, result.projectName!)

  printFinish(root, cwd, packageManager)
}

init().catch((e) => {
  console.error(e)
})
