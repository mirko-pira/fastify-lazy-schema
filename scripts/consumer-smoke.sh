#!/usr/bin/env bash
# Packs the package, checks the tarball carries the build, installs it into an
# empty project next to Fastify 5 and loads it the two ways users do: an ES
# module import and a CommonJS require (Node's require of an ES module).
set -euo pipefail

root=$(pwd)
tgz=$(npm pack --silent | tail -1)
for file in package/dist/index.js package/dist/index.d.ts package/LICENSE package/README.md; do
  tar -tzf "$tgz" | grep -qx "$file" || { echo "tarball misses $file" >&2; exit 1; }
done

dir=$(mktemp -d)
trap 'rm -rf "$dir" "$root/$tgz"' EXIT
cp "$tgz" "$dir/"
cd "$dir"
npm init -y >/dev/null
npm install --no-audit --no-fund "./$tgz" 'fastify@^5' >/dev/null

cat > esm.mjs <<'EOF'
import Fastify from 'fastify'
import lazySchema, { lazySchemaCompilationPlugin } from 'fastify-lazy-schema'

if (lazySchema !== lazySchemaCompilationPlugin) throw new Error('default and named exports differ')
const app = Fastify()
await app.register(lazySchema)
app.post('/x', { schema: { body: { type: 'object', required: ['a'] } } }, async () => ({ ok: true }))
await app.ready()
const response = await app.inject({ method: 'POST', url: '/x', payload: {} })
if (response.statusCode !== 400) throw new Error(`esm: expected 400, got ${response.statusCode}`)
console.log('esm import: ok')
EOF

cat > cjs.cjs <<'EOF'
const Fastify = require('fastify')
const lazySchema = require('fastify-lazy-schema')

;(async () => {
  const app = Fastify()
  await app.register(lazySchema)
  app.post('/x', { schema: { body: { type: 'object', required: ['a'] } } }, async () => ({ ok: true }))
  await app.ready()
  const response = await app.inject({ method: 'POST', url: '/x', payload: {} })
  if (response.statusCode !== 400) throw new Error(`cjs: expected 400, got ${response.statusCode}`)
  console.log('cjs require: ok')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
EOF

node esm.mjs
node cjs.cjs
