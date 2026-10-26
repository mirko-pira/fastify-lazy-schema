/**
 * Compiles each route's request validators and response serializers at the
 * route's first request instead of at boot.
 *
 * Fastify compiles every route's schemas before the server is ready: ajv for
 * the request parts, fast-json-stringify for the responses. An application
 * with several hundred routes, most of which a given deployment rarely calls,
 * can spend close to half of its boot there on a small CPU. The plugin keeps
 * Fastify's own compilers and moves only the moment they run: a route's
 * validator or serializer is built the first time it is called, with the
 * shared schemas and server options Fastify would have used at boot, and kept.
 *
 * How it reaches every route: the two compiler factories live in one object
 * that every encapsulation context shares unless it sets a compiler of its
 * own, and Fastify calls them only when it compiles the routes, just before
 * ready. The plugin replaces both factories on that object, so the routes
 * registered before it, like the generated CRUD routes of @platformatic/db,
 * are covered too. That object is internal to Fastify 5: the plugin declares
 * that major, and stops the boot when it cannot find the factories.
 *
 * What changes for a request: a route's first request pays its compilation,
 * and a schema that cannot compile no longer stops the boot but answers that
 * route's requests with a 500 naming the route, the same error every time.
 */

import { errorCodes, type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

/** A built ajv validator, as Fastify calls it. */
type Validate = ((data: unknown, dataContext?: unknown) => unknown) & {
  errors?: unknown
  schemaEnv?: unknown
}
type Serialize = (data: unknown) => string

/** What Fastify hands a compiler for one schema of one route. */
interface RouteSchema {
  method: string
  url: string
  [key: string]: unknown
}

type ValidatorCompiler = (route: RouteSchema) => Validate
type SerializerCompiler = (route: RouteSchema) => Serialize

interface CompilersFactory {
  buildValidator: (externalSchemas: unknown, options: unknown) => ValidatorCompiler
  buildSerializer: (externalSchemas: unknown, options: unknown) => SerializerCompiler
}

// Fastify keys its schema controller with `Symbol('fastify.schemaController')`.
const SCHEMA_CONTROLLER = 'fastify.schemaController'

export interface LazySchemaCompilationOptions {
  /**
   * On by default. `false`, `'false'` or the empty string leave Fastify's
   * compilers as they are, so the value can come straight from an environment
   * variable, an unset one substituted as `''` included.
   */
  enabled?: boolean | string
}

/** Runs `build` at the first call only; a failure is kept and thrown again on every later call. */
function once<T>(build: () => T): () => T {
  let built: T | undefined
  let failure: { error: unknown } | undefined
  return () => {
    if (built !== undefined) return built
    if (failure !== undefined) throw failure.error
    try {
      built = build()
      return built
    } catch (error) {
      failure = { error }
      throw error
    }
  }
}

/**
 * A validator that builds the real one at its first use. Fastify reads
 * `schemaEnv` before it calls a validator, to hand ajv the value's parent so a
 * coerced root value lands on the request, and reads `errors` after the call:
 * both come from the built validator, so the first request behaves like every
 * later one.
 */
function lazyValidator(build: () => Validate): Validate {
  const built = once(build)
  const validate = ((data: unknown, dataContext?: unknown) =>
    dataContext === undefined ? built()(data) : built()(data, dataContext)) as Validate
  Object.defineProperties(validate, {
    schemaEnv: { get: () => built().schemaEnv },
    errors: { get: () => built().errors },
  })
  return validate
}

function lazySerializer(build: () => Serialize): Serialize {
  const built = once(build)
  return (data: unknown) => built()(data)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The compiler factories of the context `app` registers into, found on it or on a context it inherits from. */
function compilersFactoryOf(app: FastifyInstance): CompilersFactory {
  for (let scope: object | null = app; scope !== null; scope = Object.getPrototypeOf(scope)) {
    const key = Object.getOwnPropertySymbols(scope).find(
      (symbol) => symbol.description === SCHEMA_CONTROLLER
    )
    if (key === undefined) continue
    const controller = (scope as Record<symbol, { compilersFactory?: Partial<CompilersFactory> }>)[
      key
    ]
    const factory = controller?.compilersFactory
    if (
      typeof factory?.buildValidator === 'function' &&
      typeof factory.buildSerializer === 'function'
    ) {
      return factory as CompilersFactory
    }
    break
  }
  throw new Error(
    'Lazy schema compilation found no compiler factories on this Fastify instance: it reads the schema controller of Fastify 5, and this Fastify keeps them elsewhere'
  )
}

/**
 * Replaces the compiler factories `app` shares with its contexts by ones whose
 * validators and serializers build at their first call. Call it before `ready`.
 */
function deferSchemaCompilation(app: FastifyInstance): void {
  const factory = compilersFactoryOf(app)
  const buildValidator = factory.buildValidator
  const buildSerializer = factory.buildSerializer

  factory.buildValidator = (externalSchemas, options) => {
    const compile = buildValidator(externalSchemas, options)
    return (route) =>
      lazyValidator(() => {
        try {
          return compile(route)
        } catch (error) {
          throw new errorCodes.FST_ERR_SCH_VALIDATION_BUILD(
            route.method,
            route.url,
            messageOf(error)
          )
        }
      })
  }

  factory.buildSerializer = (externalSchemas, options) => {
    const compile = buildSerializer(externalSchemas, options)
    return (route) =>
      lazySerializer(() => {
        try {
          return compile(route)
        } catch (error) {
          throw new errorCodes.FST_ERR_SCH_SERIALIZATION_BUILD(
            route.method,
            route.url,
            messageOf(error)
          )
        }
      })
  }
}

async function lazySchemaCompilation(
  app: FastifyInstance,
  options: LazySchemaCompilationOptions
): Promise<void> {
  if (options.enabled === false || options.enabled === 'false' || options.enabled === '') return
  deferSchemaCompilation(app)
  app.log.info("route schemas compile at each route's first request")
}

export const lazySchemaCompilationPlugin = fp(lazySchemaCompilation, {
  name: 'fastify-lazy-schema',
  fastify: '5.x',
})
