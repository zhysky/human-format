import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArguments } from '../src/cli.mjs'
import { changedFiles } from '../src/format.mjs'
import { checkedRun, packageDir, run } from '../src/runtime.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-format test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = path.join(root, 'project with spaces')
  fs.mkdirSync(project)
  const emptyGitConfig = path.join(root, 'empty.gitconfig')
  fs.writeFileSync(emptyGitConfig, '')
  const env = {
    HUMAN_FORMAT_HOME: path.join(root, 'tool data'),
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const git = args => checkedRun('git', args, { cwd: project, env, trim: false })
  const cli = args =>
    run(process.execPath, [path.join(packageDir, 'bin/human-format.mjs'), ...args], {
      cwd: project,
      env,
    })
  return { root, project, git, cli }
}

test('arguments preserve defaults and reject invalid management options', () => {
  assert.equal(parseArguments([]).engine, undefined)
  assert.equal(parseArguments(['-e', 'Biome', '--check']).engine, 'biome')
  assert.equal(parseArguments(['--engine=dprint']).engine, 'dprint')
  assert.deepEqual(parseArguments(['--', '-source.ts']).files, ['-source.ts'])
  assert.throws(() => parseArguments(['--engine']), /Choose an engine/)
  assert.throws(() => parseArguments(['update', 'source.ts']), /accepts only/)
  assert.throws(() => parseArguments(['rollback', '--version']), /accepts only/)
  assert.throws(() => parseArguments(['--unknown']), /Unknown option/)
})

test('file selection combines staged, unstaged and untracked files, including leading spaces', t => {
  const f = fixture(t)
  f.git(['init', '-b', 'main'])
  f.git(['config', 'user.name', 'Test User'])
  f.git(['config', 'user.email', 'test@example.invalid'])
  f.git(['config', 'core.autocrlf', 'false'])
  for (const name of ['staged.ts', 'unstaged.ts', 'unchanged.ts', 'deleted.ts']) {
    fs.writeFileSync(path.join(f.project, name), 'export const value = 1\n')
  }
  fs.writeFileSync(path.join(f.project, '.gitignore'), 'ignored.ts\n')
  f.git(['add', '.'])
  f.git(['commit', '-m', 'Fixture'])
  fs.writeFileSync(path.join(f.project, 'staged.ts'), 'export const value={a:1};\n')
  f.git(['add', 'staged.ts'])
  for (const name of ['unstaged.ts', 'new.ts', ' leading space.ts', '中文文件.ts', 'ignored.ts']) {
    fs.writeFileSync(path.join(f.project, name), 'export const value={a:1};\n')
  }
  fs.writeFileSync(path.join(f.project, 'README.md'), 'Leave documentation unchanged.\n')
  fs.rmSync(path.join(f.project, 'deleted.ts'))
  const selected = changedFiles(f.project)
    .map(file => path.basename(file))
    .sort()
  assert.deepEqual(
    selected,
    [' leading space.ts', 'new.ts', 'staged.ts', 'unstaged.ts', '中文文件.ts'].sort(),
  )
  const index = f.git(['ls-files', '--stage', '-z'])
  const result = f.cli([])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.git(['ls-files', '--stage', '-z']), index)
  assert.equal(
    fs.readFileSync(path.join(f.project, 'unchanged.ts'), 'utf8'),
    'export const value = 1\n',
  )
  assert.equal(
    fs.readFileSync(path.join(f.project, 'ignored.ts'), 'utf8'),
    'export const value={a:1};\n',
  )
  assert.equal(f.cli(['--check']).status, 0)
})

test('an empty Git selection does not format the repository', t => {
  const f = fixture(t)
  f.git(['init', '-b', 'main'])
  fs.writeFileSync(path.join(f.project, 'README.md'), '# Keep this document\n')
  const result = f.cli([])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /No changed source files/)
})

test('explicit directories and files outside Git are handled deliberately', t => {
  const f = fixture(t)
  assert.equal(f.cli([f.project]).status, 2)
  assert.equal(f.cli([]).status, 2)
  fs.writeFileSync(path.join(f.project, 'example.ts'), 'export const x={a:1};\n')
  assert.equal(f.cli(['example.ts']).status, 0)
})

test(
  'symlinks are rejected as explicit formatting targets',
  {
    skip: process.platform === 'win32' ? 'Symlink creation can require Windows privileges.' : false,
  },
  t => {
    const f = fixture(t)
    const file = path.join(f.project, 'source.ts')
    fs.writeFileSync(file, 'export const x={a:1};\n')
    fs.symlinkSync(file, path.join(f.project, 'linked.ts'))
    assert.equal(f.cli(['linked.ts']).status, 2)
    assert.equal(fs.readFileSync(file, 'utf8'), 'export const x={a:1};\n')
  },
)

for (const engine of ['oxfmt', 'dprint', 'biome']) {
  test(`${engine}: formatting is idempotent; check preserves files; Vue compatibility stays intact`, t => {
    const f = fixture(t)
    const style = '\n.sample\n  color red\n  &:hover\n    color blue\n'
    const template = '<template><div class="sample" :title="message">{{ message }}</div></template>'
    const files = ['example.ts', 'style.css', 'component with spaces.vue']
    const originals = [
      'export const x={a:"hello",b:[1,2,3]};\n',
      '.sample{color:red;padding:0 4px;}\n',
      `${template}\n<script setup lang="ts">\n` +
        'const clone = <T,>(value: T): T => value\nconst message = clone("hello")\n' +
        `</script>\n<style lang="stylus">${style}</style>\n`,
    ]
    files.forEach((file, index) => fs.writeFileSync(path.join(f.project, file), originals[index]))
    const check = f.cli(['-e', engine, '--check', ...files])
    assert.equal(check.status, 1, check.stderr)
    assert.deepEqual(
      files.map(file => fs.readFileSync(path.join(f.project, file), 'utf8')),
      originals,
    )
    const formatted = f.cli(['-e', engine, ...files])
    assert.equal(formatted.status, 0, formatted.stderr)
    const result = fs.readFileSync(path.join(f.project, files[2]), 'utf8')
    assert.equal(result.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)[1], style)
    assert.match(result, /<T,>/)
    if (engine === 'biome')
      assert.equal(result.split('</template>')[0], template.split('</template>')[0])
    const after = files.map(file => fs.readFileSync(path.join(f.project, file), 'utf8'))
    assert.equal(f.cli(['-e', engine, '--check', ...files]).status, 0)
    assert.deepEqual(
      files.map(file => fs.readFileSync(path.join(f.project, file), 'utf8')),
      after,
    )
  })
}

test('Biome rejects unsupported standalone files before changing any input', t => {
  const f = fixture(t)
  const content = '.sample { & > div { color: red; } }\n'
  fs.writeFileSync(path.join(f.project, 'example.scss'), content)
  const result = f.cli(['-e', 'biome', 'example.scss'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Use Oxfmt or dprint/)
  assert.equal(fs.readFileSync(path.join(f.project, 'example.scss'), 'utf8'), content)
})
