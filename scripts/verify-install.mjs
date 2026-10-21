import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkedRun, npmCli, packageDir, packageInfo } from '../src/runtime.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-format-install-test-'))
try {
  const info = JSON.parse(
    checkedRun(process.execPath, [npmCli(), 'pack', '--json', '--pack-destination', root], {
      cwd: packageDir,
    }),
  )[0]
  const tarball = path.join(root, info.filename)
  const prefix = path.join(root, 'install with spaces')
  console.log(`Installing packed human-format ${packageInfo.version} into a temporary prefix...`)
  checkedRun(
    process.execPath,
    [
      npmCli(),
      'install',
      '--global',
      '--prefix',
      prefix,
      '--registry=https://registry.npmjs.org',
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    { cwd: root, timeout: 300_000 },
  )
  const installed = path.join(
    prefix,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    'human-format',
  )
  const entry = path.join(installed, 'bin/human-format.mjs')
  assert.equal(checkedRun(process.execPath, [entry, '--tool-version']), packageInfo.version)
  const { createRuntime } = await import(pathToFileURL(path.join(installed, 'src/runtime.mjs')))
  const { verifyEngines } = await import(pathToFileURL(path.join(installed, 'src/verify.mjs')))
  const runtime = createRuntime({ home: path.join(root, 'isolated data') })
  verifyEngines(runtime, ['oxfmt', 'dprint', 'biome'])
  for (const action of ['update', 'rollback']) {
    checkedRun(process.execPath, [entry, action, '--help'])
  }
  if (process.platform !== 'win32') {
    console.log('Checking the shell installer with a local package and a temporary prefix...')
    checkedRun('bash', [path.join(packageDir, 'install.sh')], {
      cwd: root,
      timeout: 300_000,
      env: {
        HUMAN_FORMAT_PACKAGE: tarball,
        HUMAN_FORMAT_INSTALL_PREFIX: prefix,
        MISE_SKIP_RESHIM: '1',
      },
    })
    assert.equal(checkedRun(process.execPath, [entry, '--tool-version']), packageInfo.version)
  }
  console.log('Packed installation and all three engines passed. Temporary installation removed.')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
