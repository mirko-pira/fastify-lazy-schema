# fastify-lazy-schema

Compile each Fastify route's request validators and response serializers at the route's **first request** instead of at boot. Same compilers, same options: only the moment changes.

Fastify compiles the schemas of every route before the server is ready: [ajv](https://ajv.js.org/) for the request parts, [fast-json-stringify](https://github.com/fastify/fast-json-stringify) for the responses. An application with hundreds of routes, many of which a given deployment rarely calls, can spend a large share of its boot there, and more so on a small CPU. This plugin keeps Fastify's own compilers and builds each route's validator or serializer the first time it is needed, then keeps it.

## Install

```sh
npm install fastify-lazy-schema
```

Requires Fastify 5 and Node.js 20 or later.

## Usage

```js
import Fastify from 'fastify'
import lazySchema from 'fastify-lazy-schema'

const app = Fastify()
await app.register(lazySchema)

app.post('/items', { schema: { body: { type: 'object', properties: { name: { type: 'string' } } } } }, async (request) => request.body)

await app.listen({ port: 3000 })
```

Register it before `ready`. It covers every route of the instance, including the routes registered before it in other encapsulation contexts (for example routes a framework generates before your plugins run).

### Options

| Option    | Default | Meaning                                                                                                                               |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled` | `true`  | `false`, `'false'` or the empty string leave Fastify compiling every schema at boot, so the switch can come straight from an environment variable (an unset one substituted as `''` included). |

```js
await app.register(lazySchema, { enabled: process.env.LAZY_SCHEMA })
```

## What changes, and the trade-off

- **The first request of each route pays its compilation.** Every later request uses the compiled function, exactly as with eager compilation. Concurrent first requests compile once.
- **A schema that cannot compile no longer stops the boot.** With eager compilation, Fastify refuses to start. With this plugin, that route answers every request with a `500` carrying Fastify's own error (`FST_ERR_SCH_VALIDATION_BUILD` or `FST_ERR_SCH_SERIALIZATION_BUILD`) naming the route, and the other routes keep working.

  Keep that guarantee somewhere else: boot the application **once without the plugin** in CI or in a pre-deploy smoke test (`enabled: false`), so a broken schema still fails before it reaches users.

- Validation, coercion and serialization results are the same as with eager compilation; the test suite checks this answer by answer.

## Measured effect

On a Platformatic application with several hundred routes, production image, AWS Fargate ARM64 at 0.5 vCPU / 2 GB, five cold boots per variant (median, min–max):

|                            | eager               | lazy                               |
| -------------------------- | ------------------- | ---------------------------------- |
| container start → ready    | 123 s (118–127)     | 40.5 s (38.9–44.5)                 |
| memory at idle             | 1052 MiB            | 781 MiB                            |
| `/health` p99 / throughput | 3.9 ms / 2205 req/s | 3.7 ms / 2188 req/s (within noise) |

Your numbers depend on how many routes and schemas you have, and on the CPU.

## How it works

Fastify's schema controller holds two compiler factories, `buildValidator` and `buildSerializer`, in one object that every encapsulation context shares unless it sets a compiler of its own. Fastify calls them when it compiles the routes, just before `ready`. The plugin wraps both: each returns a stand-in that builds the real validator or serializer on its first call, with the external schemas and server options Fastify would have used at boot.

That object is internal to Fastify 5 (it is reached through the `fastify.schemaController` symbol), so the plugin declares Fastify `5.x` and stops the boot with a clear error if it cannot find the factories, rather than silently doing nothing.

## Alternatives

- Precompile your schemas at build time ([ajv standalone](https://ajv.js.org/standalone.html), [`@fastify/ajv-compiler` standalone mode](https://github.com/fastify/ajv-compiler#ajv-standalone)): no compilation at boot nor at the first request, at the cost of a build step.
- See the discussion in [fastify/fastify#6977](https://github.com/fastify/fastify/pull/6977), where this started as a core option.

## License

[MIT](./LICENSE)
