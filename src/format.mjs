import fs from 'node:fs'
import path from 'node:path'
import { checkedRun, createPreset, runEngine } from './runtime.mjs'
import { formatVueFiles } from './vue.mjs'

const suffixes = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.vue',
  '.html',
  '.css',
  '.scss',
  '.less',
])

function regularFile(file) {
  try {
    return fs.lstatSync(file).isFile()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function changedFiles(cwd = process.cwd()) {
  let root
  try {
    root = checkedRun('git', ['rev-parse', '--show-toplevel'], { cwd, trim: false }).replace(
      /\r?\n$/,
      '',
    )
  } catch {
    throw new Error('Run inside a Git repository or provide explicit file paths.')
  }
  const files = new Set()
  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACMRT', '-z'],
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    const result = checkedRun('git', args, { cwd: root, trim: false })
    for (const item of result.split('\0')) {
      const file = path.join(root, item)
      if (item && suffixes.has(path.extname(item).toLowerCase()) && regularFile(file)) {
        files.add(file)
      }
    }
  }
  return [...files].sort()
}

export function selectFiles(explicit, cwd = process.cwd()) {
  if (!explicit.length) return changedFiles(cwd)
  return [
    ...new Set(
      explicit.map(item => {
        const file = path.resolve(cwd, item)
        if (!regularFile(file))
          throw new Error(`Expected a regular file, not a directory, symlink, or glob: ${item}`)
        return file
      }),
    ),
  ].sort()
}

export function engineArgs(engine, config, files, check, ignoreFile) {
  if (engine === 'oxfmt')
    return [
      '--config',
      config,
      '--disable-nested-config',
      '--ignore-path',
      ignoreFile,
      check ? '--check' : '--write',
      '--',
      ...files,
    ]
  if (engine === 'dprint')
    return [
      check ? 'check' : 'fmt',
      '--config',
      config,
      '--config-discovery=false',
      '--no-gitignore',
      ...(check ? ['--list-different'] : ['--incremental=false']),
      '--',
      ...files,
    ]
  return [
    'format',
    `--config-path=${config}`,
    '--reporter=summary',
    '--use-editorconfig=false',
    '--vcs-enabled=false',
    ...(check ? [] : ['--write']),
    '--',
    ...files,
  ]
}

export async function formatFiles(runtime, engine, files, check) {
  if (!files.length) {
    console.log('No changed source files to format.')
    return 0
  }
  if (engine === 'biome') {
    const unsupported = files.filter(file =>
      ['.html', '.htm', '.scss', '.sass', '.less', '.styl', '.stylus'].includes(
        path.extname(file).toLowerCase(),
      ),
    )
    if (unsupported.length)
      throw new Error(`Use Oxfmt or dprint for these files: ${unsupported.join(', ')}`)
  }
  console.log(`human-format: ${engine}, ${files.length} file(s), ${check ? 'check' : 'write'}`)
  const preset = createPreset(runtime, engine)
  try {
    const vue = files.filter(file => path.extname(file).toLowerCase() === '.vue')
    const other = files.filter(file => path.extname(file).toLowerCase() !== '.vue')
    let code = 0
    if (vue.length) {
      if (engine === 'biome')
        console.log('Biome: Vue script blocks only; templates and styles are preserved.')
      code = await formatVueFiles(runtime, engine, vue, preset, check)
    }
    if (other.length) {
      const result = runEngine(
        runtime,
        engine,
        engineArgs(engine, preset.file, other, check, preset.ignoreFile),
      )
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      const nativeCode = engine === 'dprint' && check && result.status === 20 ? 1 : result.status
      if (nativeCode) code = nativeCode
    }
    return code
  } finally {
    preset.cleanup()
  }
}
