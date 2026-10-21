import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolvePackage, runEngine } from './runtime.mjs'

const require = createRequire(import.meta.url)
const { parse } = require('@vue/compiler-sfc')
const { parse: parseScript } = createRequire(require.resolve('@vue/compiler-sfc'))('@babel/parser')
const supportedStyles = new Set(['css', 'scss', 'sass', 'less'])

function descriptor(source, file) {
  const result = parse(source, { filename: file })
  if (result.errors.length) {
    throw new Error(`${file}: ${result.errors.map(error => error.message || error).join('; ')}`)
  }
  return result.descriptor
}

function oxfmtOptions(data, file, configDirectory) {
  const { overrides = [], $schema, ignorePatterns, associations, ...options } = data
  const candidates = [file, path.relative(configDirectory, file), path.basename(file)]
  const matches = patterns =>
    (patterns || []).some(pattern =>
      candidates.some(candidate => path.matchesGlob(candidate, pattern)),
    )
  for (const override of overrides) {
    if (matches(override.files) && !matches(override.excludeFiles)) {
      Object.assign(options, override.options)
    }
  }
  return options
}

export function preserveGenericArrowCommas(source, file) {
  const component = descriptor(source, file)
  const insertions = []
  for (const block of [component.script, component.scriptSetup]) {
    if (!block || !['ts', 'typescript'].includes(block.lang)) continue
    const ast = parseScript(block.content, {
      sourceType: 'module',
      plugins: ['typescript'],
      tokens: true,
    })
    function visit(node) {
      if (!node || typeof node !== 'object') return
      if (node.type === 'ArrowFunctionExpression' && node.typeParameters?.params.length === 1) {
        const parameter = node.typeParameters.params[0]
        const hasComma = ast.tokens.some(
          token =>
            token.start >= parameter.end &&
            token.end < node.typeParameters.end &&
            token.type.label === ',',
        )
        if (!parameter.constraint && !parameter.default && !hasComma) {
          insertions.push(block.loc.start.offset + parameter.end)
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'extra', 'tokens', 'comments'].includes(key)) continue
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') visit(value)
      }
    }
    visit(ast.program)
  }
  for (const offset of [...new Set(insertions)].sort((a, b) => b - a)) {
    source = `${source.slice(0, offset)},${source.slice(offset)}`
  }
  return source
}

export async function formatVue(runtime, engine, source, file, preset) {
  const original = descriptor(source, file)
  let formatted
  if (engine === 'oxfmt') {
    const api = await import(
      pathToFileURL(path.join(resolvePackage(runtime, 'oxfmt'), 'dist/index.js'))
    )
    const result = await api.format(file, source, oxfmtOptions(preset.data, file, runtime.config))
    if (result.errors.length) {
      throw new Error(`${file}: ${result.errors.map(error => error.message).join('; ')}`)
    }
    formatted = result.code
  } else {
    const args =
      engine === 'dprint'
        ? ['fmt', '--config', preset.file, '--config-discovery=false', '--stdin', file]
        : ['format', `--config-path=${preset.file}`, '--stdin-file-path', file]
    const result = runEngine(runtime, engine, args, { input: source })
    if (result.status !== 0) throw new Error(`${file}: ${result.stderr || result.stdout}`)
    formatted = result.stdout
  }
  const next = descriptor(formatted, file)
  assert.equal(next.styles.length, original.styles.length, `${file}: style block count changed`)
  for (let index = original.styles.length - 1; index >= 0; index--) {
    const before = original.styles[index]
    const after = next.styles[index]
    assert.deepEqual(after.attrs, before.attrs, `${file}: style attributes changed`)
    if (!supportedStyles.has((before.lang || 'css').toLowerCase())) {
      formatted =
        formatted.slice(0, after.loc.start.offset) +
        before.content +
        formatted.slice(after.loc.end.offset)
    }
  }
  return preserveGenericArrowCommas(formatted, file)
}

export async function formatVueFiles(runtime, engine, files, preset, check) {
  const results = []
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    results.push({
      file,
      source,
      formatted: await formatVue(runtime, engine, source, file, preset),
    })
  }
  const changed = results.filter(result => result.source !== result.formatted)
  if (check) {
    for (const result of changed) console.log(result.file)
    console.log(`Checked ${files.length} Vue file(s); ${changed.length} need formatting.`)
    return changed.length ? 1 : 0
  }
  for (const result of results) {
    assert.equal(
      fs.readFileSync(result.file, 'utf8'),
      result.source,
      `${result.file}: changed during formatting`,
    )
  }
  for (const result of changed) fs.writeFileSync(result.file, result.formatted)
  console.log(`Formatted ${changed.length} Vue file(s); styles and generic-arrow commas preserved.`)
  return 0
}
