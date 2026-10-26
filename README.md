# fastify-lazy-schema

[![CI](https://github.com/mirko-pira/fastify-lazy-schema/actions/workflows/ci.yml/badge.svg)](https://github.com/mirko-pira/fastify-lazy-schema/actions/workflows/ci.yml)

Compile each Fastify route's request validators and response serializers at the route's **first request** instead of at boot. Same compilers, same options: only the moment changes.

Fastify compiles the schemas of every route before the server is ready: [ajv](https://ajv.js.org/) for the request parts, [fast-json-stringify](https://github.com/fastify/fast-json-stringify) for the responses. An application with hundreds of routes, many of which a given deployment rarely calls, can spend a large share of its boot there, and more so on a small CPU. This plugin keeps Fastify's own compilers and builds each route's validator or serializer the first time it is needed, then keeps it.

## Install

```sh
npm install fastify-lazy-schema
```

| Requirement | Supported                                                                           |
| ----------- | ----------------------------------------------------------------------------------- |
| Fastify     | 5.6.2 to 5.x (CI runs the tests against 5.6.2 and the latest 5.x)                   |
| Node.js     | 20.19+, 22.12+, 24, 26                                                              |
| Module      | ES module; CommonJS through Node's `require()` of ES modules (20.19+, 22.12+)       |

## Usage

```js
import Fastify from 'fastify'
import lazySchema from 'fastify-lazy-schema'

const app = Fastify()
await app.register(lazySchema)

app.post(
  '/items',
  { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
  async (request) => request.body
)

await app.ready()
await app.listen({ port: 3000 })
```

Register it once, at the root, before `ready`. It also covers routes registered before it in other encapsulation contexts (for example routes a framework generates before your plugins run), except the ones listed under [Limitations](#limitations).

CommonJS:

```js
const Fastify = require('fastify')
const lazySchema = require('fastify-lazy-schema')

const app = Fastify()
app.register(lazySchema)
```

TypeScript: the package ships its types. Both the default export and the named export `lazySchemaCompilationPlugin` are the plugin; `LazySchemaCompilationOptions` is the options type.

```ts
import lazySchema, { type LazySchemaCompilationOptions } from 'fastify-lazy-schema'

const options: LazySchemaCompilationOptions = { enabled: process.env.LAZY_SCHEMA }
await app.register(lazySchema, options)
```

### Options

| Option    | Type                               | Default | Meaning                                                                                                                                                                        |
| --------- | ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled` | `boolean \| string \| undefined`   | on      | `false`, or a string that reads `''`, `'false'`, `'0'`, `'off'` or `'no'` (trimmed, any case), leaves Fastify compiling every schema at boot. Anything else, `undefined` included, keeps it on. |

So `enabled: process.env.LAZY_SCHEMA` is on when the variable is unset and off when it is set to `false`.

## What changes, and the trade-off

- **The first request of each route pays its compilation.** Every later request uses the compiled function, exactly as with eager compilation; concurrent first requests compile once. In the application below, the extra time of a route's first response was 0 ms at the median and under half a second for nine routes in ten, up to about 2 s for the largest list responses.
- **A schema that cannot compile no longer stops the boot.** With eager compilation Fastify refuses to start. With this plugin, that route answers every request with a `500` carrying Fastify's own error (`FST_ERR_SCH_VALIDATION_BUILD` or `FST_ERR_SCH_SERIALIZATION_BUILD`) naming the route; the failure is kept, so the same error comes back every time, and the other routes keep working.
- Validation, coercion and serialization results are the same as with eager compilation; the test suite compares them answer by answer.

### Keep the boot-time guarantee in CI

Boot the application once **with the plugin off** in CI or in a pre-deploy smoke test, so a broken schema still fails before it reaches users:

```js
// smoke.test.js
import { buildApp } from './app.js'

const app = await buildApp({ lazySchema: { enabled: false } })
await app.ready() // throws FST_ERR_SCH_*_BUILD if any route schema does not compile
await app.close()
```

## Limitations

- **Only Fastify's default compilers are deferred.** A compiler factory the application supplies (`schemaController.compilersFactory`), a context that calls `setValidatorCompiler` / `setSerializerCompiler`, and a route with its own `validatorCompiler` / `serializerCompiler` keep their compiler and compile at boot. That includes type providers that install their own compiler (for example a Zod or TypeBox compiler). The plugin logs a warning when the application's factory, or the context it is registered in, has its own compiler; a child context that sets one is not detected.
- **`attachValidation: true`.** A route that attaches validation errors receives a schema build failure the same way: the handler runs with `request.validationError` set to the `FST_ERR_SCH_VALIDATION_BUILD` error (status 500) and with unvalidated input. Check `validationError` before using the input, as you would for any validation error.
- **Error responses.** A broken response schema for an error status (`default`, `5xx`) surfaces as Fastify's `FST_ERR_FAILED_ERROR_SERIALIZATION`. The `500` of a broken schema carries the compiler's message, which describes the schema; set an error handler if clients must not see it.
- **Do not combine it with standalone (precompiled) compilers** (`@fastify/ajv-compiler` and `@fastify/fast-json-stringify-compiler` in standalone mode): their store step would run only for routes that got a request. Generate standalone code with the plugin off.
- **Compilation order follows the first requests**, not route registration. That matters only to compilers whose result depends on what was compiled before them, which Fastify's default ajv setup (`addUsedSchema: false`) does not.
- **Validators are stand-ins until they are built.** Fastify reads only `schemaEnv` and `errors` from a validator; the stand-in forwards both, and assignments to `errors`. Other properties ajv puts on its functions (`schema`, `source`, …) are not forwarded, which matters only to code that inspects `request.getValidationFunction(...)` for a route schema.
- **After `ready`, run-time compilations are immediate**: `request.compileValidationSchema`, `reply.compileSerializationSchema` and their `get…`/`validateInput`/`serializeInput` siblings compile and throw at once, as without the plugin.
- **It applies to the whole instance**, wherever it is registered: register it once, at the root. A second registration does nothing.
- **It relies on Fastify 5 internals**: the compiler factories shared by every schema controller, reached through the `fastify.schemaController` symbol. If a Fastify release moves them, the plugin stops the boot with a clear error instead of silently doing nothing. Fastify before 5.6.2 does not catch an error thrown while a request is validated, which a deferred build can throw, hence the minimum version.

## Measured effect

One application, not a benchmark: a Platformatic application with several hundred routes, its production image, AWS Fargate ARM64 at 0.5 vCPU / 2 GB, Fastify 5.12, Node.js 24, five cold boots per variant (median, min–max):

|                            | eager               | lazy                               |
| -------------------------- | ------------------- | ---------------------------------- |
| container start → ready    | 123 s (118–127)     | 40.5 s (38.9–44.5)                 |
| memory at idle             | 1052 MiB            | 781 MiB                            |
| `/health` p99 / throughput | 3.9 ms / 2205 req/s | 3.7 ms / 2188 req/s (within noise) |

Memory at idle is measured before most routes are called; it grows as routes compile. Your numbers depend on how many routes and schemas you have, and on the CPU.

## How it works

Fastify's schema controller holds two compiler factories, `buildValidator` and `buildSerializer`, in one object that every encapsulation context shares unless it sets a compiler of its own. Fastify calls them when it compiles the routes, just before `ready`. The plugin wraps both: each returns a stand-in that builds the real validator or serializer on its first call, with the external schemas and server options Fastify would have used at boot.

## Alternatives

- Precompile your schemas at build time ([ajv standalone](https://ajv.js.org/standalone.html), [`@fastify/ajv-compiler` standalone mode](https://github.com/fastify/ajv-compiler#ajv-standalone)): no compilation at boot nor at the first request, at the cost of a build step.
- See the discussion in [fastify/fastify#6977](https://github.com/fastify/fastify/pull/6977), where this started as a proposed core option.

## Versioning and security

Semantic versioning; while the version is `0.x`, a minor release may change behaviour, and the [changelog](./CHANGELOG.md) lists every change. Report a vulnerability privately, as described in [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
