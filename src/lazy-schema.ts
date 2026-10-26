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
 * How it reaches every route: Fastify's schema controllers share one options
 * object, and its compiler factories are the ones every encapsulation context
 * uses unless it sets a compiler of its own. Fastify calls them when it
 * compiles the routes, in avvio's preReady. The plugin wraps both factories on
 * that shared object, so the routes registered before it, like the routes a
 * framework generates before user plugins run, are covered too. A factory the
 * application supplied itself, and a compiler a context or a route sets, are
 * left alone. That object is internal to Fastify 5: the plugin declares that
 * major, and stops the boot when it cannot find the factories.
 *
 * What changes for a request: a route's first request pays its compilation,
 * and a schema that cannot compile no longer stops the boot but answers that
 * route's requests with a 500 naming the route, every time. Once the server is
 * ready, schemas compiled at run time (`request.compileValidationSchema`,
 * `reply.compileSerializationSchema`) compile at once, as without the plugin.
 */

import { errorCodes, type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

/** A built ajv validator, as Fastify calls it. */
type Validate = ((data: unknown, dataContext?: unknown) => unknown) & {
  errors?: unknown
  schemaEnv?: unknown
}
type Serialize = (data: unknown) => string

/** What Fastify hands a compiler for one schema of one route; a multi-method route has several methods. */
interface RouteSchema {
  method: string | string[]
  url: string
  [key: string]: unknown
}

type ValidatorCompiler = (route: RouteSchema) => Validate
type SerializerCompiler = (route: RouteSchema) => Serialize

interface CompilersFactory {
  buildValidator: (externalSchemas: unknown, options: unknown) => ValidatorCompiler
  buildSerializer: (externalSchemas: unknown, options: unknown) => SerializerCompiler
}

/** The part of Fastify's schema controller the plugin reads and changes. */
interface SchemaController {
  opts?: {
    compilersFactory?: Partial<CompilersFactory>
    isCustomValidatorCompiler?: boolean
    isCustomSerializerCompiler?: boolean
  }
  compilersFactory?: Partial<CompilersFactory>
  isCustomValidatorCompiler?: boolean
  isCustomSerializerCompiler?: boolean
  parent?: SchemaController
}

// Fastify keys its schema controller with `Symbol('fastify.schemaController')`.
const SCHEMA_CONTROLLER = 'fastify.schemaController'

/** The string values, compared trimmed and lower-cased, that turn the plugin off. */
const OFF = new Set(['', 'false', '0', 'off', 'no'])

/** The builders the plugin produced, so it never wraps one twice (a second registration included). */
const wrappers = new WeakSet<object>()

export interface LazySchemaCompilationOptions {
  /**
   * On by default. `false`, or a string that reads `''`, `'false'`, `'0'`,
   * `'off'` or `'no'` once trimmed and lower-cased, leaves Fastify's compilers
   * as they are, so the value can come straight from an environment variable,
   * an unset one substituted as `''` included. `undefined` keeps the default.
   */
  enabled?: boolean | string | undefined
}

function isOff(enabled: LazySchemaCompilationOptions['enabled']): boolean {
  if (enabled === false) return true
  return typeof enabled === 'string' && OFF.has(enabled.trim().toLowerCase())
}

type Outcome<T> = { built: T } | { failure: unknown }

function attempt<T>(run: () => T): Outcome<T> {
  try {
    return { built: run() }
  } catch (failure) {
    return { failure }
  }
}

/**
 * Runs `build` at the first call only and keeps its result; a failure is kept
 * and thrown again on every later call. `build` is released once it has run,
 * so nothing it closes over outlives the compilation.
 */
function once<T>(build: () => T): () => T {
  let run: (() => T) | undefined = build
  let outcome: Outcome<T> = { failure: new Error('not built') }
  return () => {
    if (run !== undefined) {
      outcome = attempt(run)
      run = undefined
    }
    if ('built' in outcome) return outcome.built
    throw outcome.failure
  }
}

/**
 * A validator that builds the real one at its first use. Fastify reads
 * `schemaEnv` before it calls a validator, to hand ajv the value's parent so a
 * coerced root value lands on the request, and reads `errors` after the call:
 * both come from the built validator, so the first request behaves like every
 * later one. `get` returns the built validator or throws.
 */
function lazyValidator(get: () => Validate): Validate {
  const validate = ((data: unknown, dataContext?: unknown) =>
    dataContext === undefined ? get()(data) : get()(data, dataContext)) as Validate
  Object.defineProperties(validate, {
    schemaEnv: { get: () => get().schemaEnv },
    errors: {
      get: () => get().errors,
      set: (value: unknown) => {
        get().errors = value
      },
    },
  })
  return validate
}

function lazySerializer(get: () => Serialize): Serialize {
  return (data: unknown) => get()(data)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The schema controller of the context `app` registers into, found on it or on a context it inherits from. */
function schemaControllerOf(app: FastifyInstance): SchemaController | undefined {
  for (let scope: object | null = app; scope !== null; scope = Object.getPrototypeOf(scope)) {
    const key = Object.getOwnPropertySymbols(scope).find(
      (symbol) => symbol.description === SCHEMA_CONTROLLER
    )
    if (key !== undefined) return (scope as Record<symbol, SchemaController | undefined>)[key]
  }
  return undefined
}

const NOT_FOUND =
  'Lazy schema compilation found no compiler factories on this Fastify instance: it reads the schema controller of Fastify 5, and this Fastify keeps them elsewhere'

/**
 * Whether every controller from `controller` up to the root shares one options
 * object, as Fastify's own encapsulation does. `setSchemaController` builds a
 * controller with options of its own, whose compiler flags describe the
 * controller it replaced rather than the factories it was given.
 */
function sharesOptionsToTheRoot(controller: SchemaController): boolean {
  for (let current = controller; current.parent !== undefined; current = current.parent) {
    if (current.opts !== current.parent.opts) return false
  }
  return true
}

function isComplete(factory: Partial<CompilersFactory> | undefined): factory is CompilersFactory {
  return (
    typeof factory?.buildValidator === 'function' &&
    typeof factory.buildSerializer === 'function'
  )
}

/** Whether the server is ready, after which run-time compilations compile at once. */
interface Readiness {
  ready: boolean
}

function deferValidators(
  buildValidator: CompilersFactory['buildValidator'],
  readiness: Readiness
): CompilersFactory['buildValidator'] {
  return (externalSchemas, options) => {
    const compile = buildValidator(externalSchemas, options)
    return (route) => {
      if (readiness.ready) return compile(route)
      const built = once(() => compile(route))
      return lazyValidator(() => {
        try {
          return built()
        } catch (error) {
          throw new errorCodes.FST_ERR_SCH_VALIDATION_BUILD(
            route.method,
            route.url,
            messageOf(error)
          )
        }
      })
    }
  }
}

function deferSerializers(
  buildSerializer: CompilersFactory['buildSerializer'],
  readiness: Readiness
): CompilersFactory['buildSerializer'] {
  return (externalSchemas, options) => {
    const compile = buildSerializer(externalSchemas, options)
    return (route) => {
      if (readiness.ready) return compile(route)
      const built = once(() => compile(route))
      return lazySerializer(() => {
        try {
          return built()
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
}

/**
 * Wraps Fastify's default compiler factories, so the validators and
 * serializers built from them build at their first call until the server is
 * ready. Call it before `ready`.
 *
 * Two objects can hold a default factory the routes of the registering context
 * use: the factories every context shares (`opts.compilersFactory`), and the
 * copy a context made when it set one compiler of its own before the plugin
 * (`setValidatorCompiler` / `setSerializerCompiler` clone the shared object
 * with one half replaced). Both default halves are wrapped. A factory the
 * application supplied itself (`schemaController.compilersFactory`), a
 * compiler a context or a route sets, and every compiler after a
 * `setSchemaController` made before the plugin, are left alone: those routes
 * keep compiling at boot, with a warning where the plugin can see them.
 */
function deferSchemaCompilation(app: FastifyInstance): void {
  const controller = schemaControllerOf(app)
  if (controller === undefined) throw new Error(NOT_FOUND)
  if (!sharesOptionsToTheRoot(controller)) {
    app.log.warn(
      'setSchemaController was called before lazy schema compilation was registered: route schemas keep compiling at boot'
    )
    return
  }
  const shared = controller.opts?.compilersFactory
  if (!isComplete(shared)) throw new Error(NOT_FOUND)
  if (wrappers.has(shared.buildValidator) || wrappers.has(shared.buildSerializer)) {
    app.log.debug('lazy schema compilation is already registered on this instance')
    return
  }

  const readiness: Readiness = { ready: false }
  app.addHook('onReady', async () => {
    readiness.ready = true
  })
  const deferValidatorsOf = (factory: Partial<CompilersFactory>): void => {
    if (typeof factory.buildValidator !== 'function' || wrappers.has(factory.buildValidator)) return
    factory.buildValidator = deferValidators(factory.buildValidator, readiness)
    wrappers.add(factory.buildValidator)
  }
  const deferSerializersOf = (factory: Partial<CompilersFactory>): void => {
    if (typeof factory.buildSerializer !== 'function' || wrappers.has(factory.buildSerializer)) return
    factory.buildSerializer = deferSerializers(factory.buildSerializer, readiness)
    wrappers.add(factory.buildSerializer)
  }

  const suppliedValidators = controller.opts?.isCustomValidatorCompiler === true
  const suppliedSerializers = controller.opts?.isCustomSerializerCompiler === true
  const ownValidators = controller.isCustomValidatorCompiler === true && !suppliedValidators
  const ownSerializers = controller.isCustomSerializerCompiler === true && !suppliedSerializers
  const live = controller.compilersFactory

  if (suppliedValidators) {
    app.log.warn('the application supplies its own validator compiler factory: validators keep compiling at boot')
  } else {
    deferValidatorsOf(shared)
    if (ownValidators) {
      app.log.warn('this context sets its own validator compiler: its routes keep compiling their validators at boot')
    } else if (live !== undefined && live !== shared) {
      deferValidatorsOf(live)
    }
  }
  if (suppliedSerializers) {
    app.log.warn('the application supplies its own serializer compiler factory: serializers keep compiling at boot')
  } else {
    deferSerializersOf(shared)
    if (ownSerializers) {
      app.log.warn('this context sets its own serializer compiler: its routes keep compiling their serializers at boot')
    } else if (live !== undefined && live !== shared) {
      deferSerializersOf(live)
    }
  }
  if (!suppliedValidators || !suppliedSerializers) {
    app.log.info("route schemas compile at each route's first request")
  }
}

async function lazySchemaCompilation(
  app: FastifyInstance,
  options: LazySchemaCompilationOptions
): Promise<void> {
  if (isOff(options.enabled)) return
  deferSchemaCompilation(app)
}

export const lazySchemaCompilationPlugin = fp(lazySchemaCompilation, {
  name: 'fastify-lazy-schema',
  fastify: '>=5.9.0 <6.0.0',
})
