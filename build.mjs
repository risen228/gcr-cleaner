import { readFile, writeFile } from 'fs/promises'

await Bun.build({
  entrypoints: ['main.ts'],
  outdir: 'dist',
  target: 'node',
  format: 'esm',
})

let contents = await readFile('dist/main.js', 'utf8')
contents = contents.replace(
  `var VERSION = import_vendor.fs.readJsonSync(new URL("../package.json", import_meta_url)).version;`,
  `var VERSION = "_patched_";`,
)
await writeFile('dist/main.js', contents)
