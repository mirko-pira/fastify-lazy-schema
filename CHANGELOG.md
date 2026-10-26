# Changelog

This project follows [semantic versioning](https://semver.org/). While the version is `0.x`, a minor release may change behaviour; every change is listed here.

## 0.1.0 (unreleased)

- First release: route validators (ajv) and response serializers (fast-json-stringify) compile at each route's first request instead of at boot, with Fastify's own compilers and options.
- A schema that cannot compile answers its route with Fastify's `FST_ERR_SCH_VALIDATION_BUILD` / `FST_ERR_SCH_SERIALIZATION_BUILD` instead of stopping the boot.
- `enabled` option, on by default; `false` or `''`, `'false'`, `'0'`, `'off'`, `'no'` (trimmed, any case) turn it off.
- Only Fastify's default compilers are deferred: an application-supplied compiler factory, a context's own compiler and a route's own compiler keep compiling at boot, with a warning for the application's factory and the registration context.
- After `ready`, run-time compilations (`request.compileValidationSchema`, `reply.compileSerializationSchema`, …) are immediate, as without the plugin.
- A second registration does nothing.
- Fastify 5.6.2 to 5.x; Node.js 20.19+, 22.12+, 24, 26.
