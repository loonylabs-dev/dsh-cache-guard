/**
 * Compose a real preset file through a real cordis Loader and print what it
 * contains: the include chain, the compaction group's children, and the config the
 * engine row carries. Every row is mounted as a stub, so no service is needed.
 *
 *   node verify-preset.mjs <preset-file>
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const preset = process.argv[2]
const ctx = new Context()
ctx.baseUrl = pathToFileURL(preset).href.replace(/[^/]+$/, '')
await ctx.plugin(Loader)
ctx.loader.builtins.include = Include
ctx.loader.builtins.group = Group
const imported = []
ctx.loader.internal = {
  version: 'v2',
  async import(specifier) {
    imported.push(specifier)
    return () => {}
  },
}
await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(preset).href } })
await ctx.loader.await()

const entries = []
const visit = content => {
  for (const entry of content.entries()) {
    entries.push(entry)
    if (entry.subtree?.entries !== undefined) visit(entry.subtree)
  }
}
visit(ctx.loader)

console.log(`preset: ${preset}`)
console.log(`rows: ${entries.length}`)
for (const entry of entries) {
  const options = entry.options
  const config = Array.isArray(options.config) ? `<${options.config.length} children>` : JSON.stringify(options.config ?? null)
  const isolate = options.isolate === undefined ? '' : ` isolate=${JSON.stringify(options.isolate)}`
  console.log(`  ${options.id ?? '(no id)'} -> ${options.name}${isolate} config=${config}`)
}
const group = entries.find(entry => entry.options.id === 'compaction')
if (group !== undefined && Array.isArray(group.options.config)) {
  console.log('compaction group children:')
  for (const child of group.options.config) {
    console.log(`  ${child.id} -> ${child.name} config=${JSON.stringify(child.config ?? null)}`)
  }
}
const engine = entries.find(entry => entry.options.id === 'compaction-basic')
console.log(`engine row (compaction-basic) config: ${JSON.stringify(engine?.options.config ?? null)}`)
const guard = entries.find(entry => entry.options.id === 'cache-guard')
console.log(`guard row: ${guard === undefined ? 'ABSENT' : guard.options.name}`)
console.log(`specifiers the loader was asked for: ${imported.length}`)
for (const specifier of imported) console.log(`  ${specifier}`)
await ctx.fiber.dispose()
