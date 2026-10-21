import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkedRun, packageDir, runEngine } from './runtime.mjs'

export function verifyEngines(runtime, engines) {
  for (const engine of engines) {
    const version = runEngine(runtime, engine, ['--version'])
    if (version.status !== 0) throw new Error(version.stderr || version.stdout)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'human-format-smoke-'))
    try {
      const style = '\n.sample\n  color red\n  &:hover\n    color blue\n'
      const template =
        '<template><div class="sample" :title="message">{{ message }}</div></template>'
      const vue = path.join(directory, 'smoke test.vue')
      fs.writeFileSync(
        vue,
        `${template}\n<script setup lang="ts">\n` +
          'const clone = <T,>(value: T): T => value\nconst message = clone("hello")\n' +
          `</script>\n<style lang="stylus">${style}</style>\n`,
      )
      const ts = path.join(directory, 'smoke.ts')
      const css = path.join(directory, 'smoke.css')
      fs.writeFileSync(ts, 'export const sample={first:"hello",second:[1,2,3]};\n')
      fs.writeFileSync(css, '.sample{color:red;padding:0 4px;}\n')
      const files = [vue, ts, css]
      const command = [path.join(packageDir, 'bin/human-format.mjs'), '-e', engine]
      const options = {
        cwd: directory,
        env: { HUMAN_FORMAT_HOME: runtime.home, HUMAN_FORMAT_CONFIG_DIR: runtime.config },
      }
      checkedRun(process.execPath, [...command, ...files], options)
      const result = fs.readFileSync(vue, 'utf8')
      assert.equal(
        result.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)?.[1],
        style,
        `${engine}: Stylus contents changed`,
      )
      assert.match(result, /<\s*T\s*,\s*>/, `${engine}: generic arrow comma missing`)
      if (engine === 'biome') {
        assert.equal(result.split('</template>')[0], template.split('</template>')[0])
      }
      const before = files.map(file => fs.readFileSync(file, 'utf8'))
      checkedRun(process.execPath, [...command, '--check', ...files], options)
      assert.deepEqual(
        files.map(file => fs.readFileSync(file, 'utf8')),
        before,
      )
      console.log(`  ${engine}: ${version.stdout.trim()}; TypeScript/CSS/Vue checks passed.`)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}
