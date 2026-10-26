/**
 * Lazy schema compilation against a real Fastify: nothing compiles before a
 * route's first request, each schema compiles once, the compiled validators
 * and serializers answer exactly as the ones Fastify builds at boot, and a
 * schema that cannot compile breaks its own route instead of the boot.
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { lazySchemaCompilationPlugin } from '../lazy-schema.js'

type AjvServerOptions = NonNullable<FastifyServerOptions['ajv']>

interface BootOptions {
  enabled?: boolean | string
  /** Routes registered in their own context before the plugin, as @platformatic/db registers its CRUD routes. */
  before?: (app: FastifyInstance) => void
  routes?: (app: FastifyInstance) => void
  ajv?: AjvServerOptions
}

const booted: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(booted.splice(0).map((app) => app.close()))
})

async function boot(options: BootOptions): Promise<FastifyInstance> {
  const app = Fastify(options.ajv === undefined ? {} : { ajv: options.ajv })
  booted.push(app)
  const { before, routes } = options
  if (before !== undefined) {
    await app.register(async (child) => {
      before(child)
    })
  }
  await app.register(lazySchemaCompilationPlugin, { enabled: options.enabled })
  routes?.(app)
  await app.ready()
  return app
}

/** A body schema ajv refuses and a response schema whose `$ref` fast-json-stringify cannot resolve. */
function brokenRoutes(app: FastifyInstance): void {
  app.post('/broken-body', { schema: { body: { type: 'notatype' } } }, async () => ({ ok: true }))
  app.get(
    '/broken-response',
    {
      schema: {
        response: { 200: { type: 'object', properties: { a: { $ref: 'missing#/a' } } } },
      },
    },
    async () => ({ a: 1 })
  )
  app.get('/fine', async () => ({ ok: true }))
}

/** Server ajv options whose keyword counts every compilation of a schema that carries it. */
function countingAjv(): { counter: { compiles: number }; ajv: AjvServerOptions } {
  const counter = { compiles: 0 }
  return {
    counter,
    ajv: {
      onCreate: (ajv) => {
        ajv.addKeyword({
          keyword: 'x-counted',
          compile: () => {
            counter.compiles++
            return () => true
          },
        })
      },
    },
  }
}

function countedRoute(app: FastifyInstance): void {
  app.post('/counted', { schema: { body: { type: 'object', 'x-counted': true } } }, async () => ({
    ok: true,
  }))
}

/** Routes whose answers depend on validation, coercion and serialization. */
function contractRoutes(app: FastifyInstance): void {
  app.addSchema({ $id: 'item', type: 'object', properties: { id: { type: 'integer' } } })
  app.post(
    '/items',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request) => request.body
  )
  app.get(
    '/items',
    { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer' } } } } },
    async (request) => {
      const { limit } = request.query as { limit: unknown }
      return { limit, type: typeof limit }
    }
  )
  // A coerced root value reaches the request only when ajv is handed its
  // parent, which Fastify does for a validator that exposes `schemaEnv`.
  app.post('/scalar', { schema: { body: { type: 'integer' } } }, async (request) => ({
    type: typeof request.body,
  }))
  app.get('/item', { schema: { response: { 200: { $ref: 'item#' } } } }, async () => ({
    id: 1,
    secret: 'hidden',
  }))
  app.get(
    '/whoami',
    {
      schema: {
        headers: { type: 'object', required: ['x-id'], properties: { 'x-id': { type: 'integer' } } },
      },
    },
    async (request) => ({ id: request.headers['x-id'] })
  )
}

const JSON_HEADERS = { 'content-type': 'application/json' }

/** A Fastify instance whose warn-level log lines are collected. */
function withWarnings(options: FastifyServerOptions = {}): { app: FastifyInstance; lines: string[] } {
  const lines: string[] = []
  const app = Fastify({
    ...options,
    logger: { level: 'warn', stream: { write: (line: string) => void lines.push(line) } },
  })
  booted.push(app)
  return { app, lines }
}

describe('lazySchemaCompilationPlugin', () => {
  it('boots with schemas that cannot compile and answers their routes with a 500 naming the route, every time', async () => {
    const app = await boot({ enabled: 'true', routes: brokenRoutes })

    const bodies = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = await app.inject({
        method: 'POST',
        url: '/broken-body',
        payload: {},
        headers: JSON_HEADERS,
      })
      const response = await app.inject({ method: 'GET', url: '/broken-response' })
      expect([body.statusCode, response.statusCode]).toEqual([500, 500])
      bodies.push(body.json<{ code: string; message: string }>())
      expect(response.json<{ code: string; message: string }>()).toMatchObject({
        code: 'FST_ERR_SCH_SERIALIZATION_BUILD',
        message: expect.stringContaining('GET: /broken-response') as unknown,
      })
    }
    expect(bodies[0]).toMatchObject({
      code: 'FST_ERR_SCH_VALIDATION_BUILD',
      message: expect.stringContaining('POST: /broken-body') as unknown,
    })
    expect(bodies[1]).toEqual(bodies[0])
    expect((await app.inject({ method: 'GET', url: '/fine' })).statusCode).toBe(200)
  })

  it('defers compilation when registered without options', async () => {
    const app = await boot({ routes: brokenRoutes })

    const response = await app.inject({ method: 'GET', url: '/broken-response' })

    expect(response.statusCode).toBe(500)
  })

  it.each([false, 'false', '', '0', ' OFF ', 'No'])(
    'leaves Fastify compiling at boot when enabled is %j',
    async (enabled) => {
      await expect(
        boot({
          enabled,
          routes: (app) =>
            app.post('/broken-body', { schema: { body: { type: 'notatype' } } }, async () => ({})),
        })
      ).rejects.toMatchObject({ code: 'FST_ERR_SCH_VALIDATION_BUILD' })
    }
  )

  it('defers the routes registered before it in another context too', async () => {
    const app = await boot({ enabled: true, before: brokenRoutes })

    const response = await app.inject({ method: 'GET', url: '/broken-response' })

    expect(response.statusCode).toBe(500)
  })

  it('wraps the compiler factories once when registered twice', async () => {
    const app = Fastify()
    booted.push(app)
    await app.register(lazySchemaCompilationPlugin)
    await app.register(lazySchemaCompilationPlugin)
    brokenRoutes(app)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/broken-body',
      payload: {},
      headers: JSON_HEADERS,
    })

    expect(response.statusCode).toBe(500)
    expect(
      response.json<{ message: string }>().message.match(/Failed building the validation schema/g)
    ).toHaveLength(1)
  })

  it('warns, and keeps compiling at boot, in a context that sets its own validator compiler', async () => {
    const lines: string[] = []
    const app = Fastify({
      logger: { level: 'warn', stream: { write: (line: string) => void lines.push(line) } },
    })
    booted.push(app)
    let customCompiles = 0
    app.setValidatorCompiler(() => {
      customCompiles++
      return () => true
    })
    await app.register(lazySchemaCompilationPlugin)
    app.post('/custom', { schema: { body: { type: 'object' } } }, async () => ({ ok: true }))
    await app.ready()

    expect(customCompiles).toBe(1)
    expect(lines.some((line) => line.includes('sets its own validator compiler'))).toBe(true)
  })

  it('names the methods of a multi-method route in its build error', async () => {
    const app = await boot({
      routes: (instance) =>
        instance.route({
          method: ['GET', 'POST'],
          url: '/multi',
          schema: { querystring: { type: 'notatype' } },
          handler: async () => ({}),
        }),
    })

    const response = await app.inject({ method: 'GET', url: '/multi' })

    expect(response.statusCode).toBe(500)
    expect(response.json<{ message: string }>().message).toMatch(/GET.*POST.*\/multi/)
  })

  it("compiles a route's validator at its first request, once, with the server's ajv options", async () => {
    const eager = countingAjv()
    await boot({ enabled: false, ajv: eager.ajv, routes: countedRoute })
    const lazy = countingAjv()
    const app = await boot({ enabled: true, ajv: lazy.ajv, routes: countedRoute })

    const atReady = lazy.counter.compiles
    const first = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: 'POST', url: '/counted', payload: {}, headers: JSON_HEADERS })
      )
    )
    await app.inject({ method: 'POST', url: '/counted', payload: {}, headers: JSON_HEADERS })

    // Eager: compiled once before ready. Lazy: nothing before the first
    // request, once for the six requests after it.
    expect(eager.counter.compiles).toBe(1)
    expect(atReady).toBe(0)
    expect(lazy.counter.compiles).toBe(1)
    expect(first.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200])
  })

  it('validates, coerces and serializes exactly as the compilers Fastify builds at boot', async () => {
    const requests = [
      {
        method: 'POST' as const,
        url: '/items',
        payload: { name: 'a', extra: 1 },
        headers: JSON_HEADERS,
      },
      { method: 'POST' as const, url: '/items', payload: {}, headers: JSON_HEADERS },
      { method: 'GET' as const, url: '/items?limit=5' },
      { method: 'POST' as const, url: '/scalar', payload: '"5"', headers: JSON_HEADERS },
      { method: 'GET' as const, url: '/item' },
      { method: 'GET' as const, url: '/whoami' },
      { method: 'GET' as const, url: '/whoami', headers: { 'x-id': '7' } },
    ]
    const answers = async (enabled: boolean): Promise<[number, string][]> => {
      const app = await boot({ enabled, routes: contractRoutes })
      const result: [number, string][] = []
      for (const request of requests) {
        const response = await app.inject(request)
        result.push([response.statusCode, response.body])
      }
      return result
    }

    const eager = await answers(false)
    const lazy = await answers(true)

    expect(lazy).toEqual(eager)
    // Whether a coerced root scalar reaches the request depends on the Fastify
    // version (5.0.0 leaves it a string, later versions hand ajv its parent), so
    // that answer is held only to equality with eager compilation above.
    expect(eager.filter((_, index) => requests[index]?.url !== '/scalar')).toEqual([
      [200, '{"name":"a"}'],
      [
        400,
        '{"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request","message":"body must have required property \'name\'"}',
      ],
      [200, '{"limit":5,"type":"number"}'],
      [200, '{"id":1}'],
      [
        400,
        '{"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request","message":"headers must have required property \'x-id\'"}',
      ],
      [200, '{"id":7}'],
    ])
  })

  it('leaves a root validator compiler set before it alone, and still defers the serializers of child contexts', async () => {
    const { app, lines } = withWarnings()
    let customCompiles = 0
    app.setValidatorCompiler(() => {
      customCompiles++
      return () => true
    })
    app.addSchema({ $id: 'shared', type: 'object' })
    await app.register(lazySchemaCompilationPlugin)
    await app.register(async (child) => {
      child.post('/custom', { schema: { body: { $ref: 'shared#' } } }, async () => ({ ok: true }))
      brokenRoutes(child)
    })
    await app.ready()

    expect(customCompiles).toBeGreaterThan(0)
    expect(lines.some((line) => line.includes('sets its own validator compiler'))).toBe(true)
    expect((await app.inject({ method: 'GET', url: '/broken-response' })).statusCode).toBe(500)
    expect(
      (await app.inject({ method: 'POST', url: '/custom', payload: {}, headers: JSON_HEADERS }))
        .statusCode
    ).toBe(200)
  })

  it('keeps an application-supplied serializer factory compiling at boot, and defers the validators', async () => {
    let serializerBuilds = 0
    const buildSerializer = () => () => {
      serializerBuilds++
      return JSON.stringify
    }
    const counting = countingAjv()
    const { app, lines } = withWarnings({
      ajv: counting.ajv,
      schemaController: { compilersFactory: { buildSerializer: buildSerializer as never } },
    })
    await app.register(lazySchemaCompilationPlugin)
    app.post(
      '/both',
      { schema: { body: { type: 'object', 'x-counted': true }, response: { 200: { type: 'object' } } } },
      async () => ({ serializerBuilds })
    )
    await app.ready()

    expect([serializerBuilds, counting.counter.compiles]).toEqual([1, 0])
    expect(lines.some((line) => line.includes('own serializer compiler factory'))).toBe(true)
    expect(lines.some((line) => line.includes('own validator compiler factory'))).toBe(false)
  })

  it('leaves every compiler eager, with a warning, after a setSchemaController made before it', async () => {
    let builds = 0
    const { app, lines } = withWarnings()
    app.setSchemaController({
      compilersFactory: {
        buildValidator: (() => () => {
          builds++
          return () => true
        }) as never,
        buildSerializer: (() => () => {
          builds++
          return JSON.stringify
        }) as never,
      },
    })
    await app.register(lazySchemaCompilationPlugin)
    app.post(
      '/',
      { schema: { body: { type: 'object' }, response: { 200: { type: 'object' } } } },
      async () => ({ builds })
    )
    await app.ready()

    expect(builds).toBe(2)
    expect(lines.some((line) => line.includes('setSchemaController was called before'))).toBe(true)
    expect(
      (await app.inject({ method: 'POST', url: '/', payload: {}, headers: JSON_HEADERS })).json()
    ).toEqual({ builds: 2 })
  })

  it('boots with a partial setSchemaController made before it', async () => {
    const { app } = withWarnings()
    app.setSchemaController({
      compilersFactory: { buildValidator: (() => () => () => true) as never },
    })
    await app.register(lazySchemaCompilationPlugin)
    app.post('/', { schema: { body: { type: 'object' } } }, async () => ({ ok: true }))
    await app.ready()

    expect(
      (await app.inject({ method: 'POST', url: '/', payload: {}, headers: JSON_HEADERS }))
        .statusCode
    ).toBe(200)
  })

  it('defers the default serializer of a root that set its validator compiler before it', async () => {
    const app = Fastify()
    booted.push(app)
    app.setValidatorCompiler(() => () => true)
    await app.register(lazySchemaCompilationPlugin)
    app.get('/', { schema: { response: { 200: { $ref: 'missing#' } } } }, async () => ({}))
    await app.ready()

    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(500)
  })

  it('defers the default validator of a root that set its serializer compiler before it', async () => {
    const counting = countingAjv()
    const app = Fastify({ ajv: counting.ajv })
    booted.push(app)
    app.setSerializerCompiler(() => JSON.stringify)
    await app.register(lazySchemaCompilationPlugin)
    countedRoute(app)
    await app.ready()

    expect(counting.counter.compiles).toBe(0)
    await app.inject({ method: 'POST', url: '/counted', payload: {}, headers: JSON_HEADERS })
    expect(counting.counter.compiles).toBe(1)
  })

  it('still stops the boot on an invalid shared schema, which Fastify checks when it builds the compiler', async () => {
    const app = Fastify()
    booted.push(app)
    await app.register(lazySchemaCompilationPlugin)
    app.addSchema({ $id: 'broken', type: 'notatype' })
    app.post('/', { schema: { body: { $ref: 'broken#' } } }, async () => ({}))

    await expect(app.ready()).rejects.toThrow(/schema is invalid/)
  })

  it('keeps an application-supplied validator factory compiling at boot', async () => {
    let customBuilds = 0
    const buildValidator = () => () => {
      customBuilds++
      return () => true
    }
    const { app, lines } = withWarnings({
      schemaController: { compilersFactory: { buildValidator: buildValidator as never } },
    })
    await app.register(lazySchemaCompilationPlugin)
    app.post('/custom', { schema: { body: { type: 'object' } } }, async () => ({ ok: true }))
    await app.ready()

    expect(customBuilds).toBe(1)
    expect(lines.some((line) => line.includes('own validator compiler factory'))).toBe(true)
  })

  it('answers a broken schema with a 500 behind an async preValidation hook, with no unhandled rejection', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => void rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      const app = await boot({
        routes: (instance) => {
          instance.addHook('preValidation', async () => undefined)
          brokenRoutes(instance)
        },
      })

      const response = await app.inject({
        method: 'POST',
        url: '/broken-body',
        payload: {},
        headers: JSON_HEADERS,
      })
      await new Promise((resolve) => setImmediate(resolve))

      expect(response.statusCode).toBe(500)
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('hands the build error to a route with attachValidation instead of answering 500', async () => {
    const app = await boot({
      routes: (instance) =>
        instance.post(
          '/attached',
          { attachValidation: true, schema: { body: { type: 'notatype' } } },
          async (request) => ({
            code: (request.validationError as { code?: string } | undefined)?.code,
          })
        ),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/attached',
      payload: {},
      headers: JSON_HEADERS,
    })

    expect(response.json()).toEqual({ code: 'FST_ERR_SCH_VALIDATION_BUILD' })
  })

  it('compiles schemas at once after ready, as Fastify does without the plugin', async () => {
    const app = await boot({
      routes: (instance) =>
        instance.get('/runtime', async (request) => {
          const valid = request.compileValidationSchema({ type: 'object' }) as { schema?: unknown }
          let invalidThrew = false
          try {
            request.compileValidationSchema({ type: 'notatype' })
          } catch {
            invalidThrew = true
          }
          return { hasSchema: typeof valid.schema === 'object', invalidThrew }
        }),
    })

    const response = await app.inject({ method: 'GET', url: '/runtime' })

    expect(response.json()).toEqual({ hasSchema: true, invalidThrew: true })
  })

  it("lets code reset a deferred validator's errors", async () => {
    const app = await boot({
      routes: (instance) =>
        instance.post('/reset', { schema: { body: { type: 'object' } } }, async (request) => {
          const validate = request.getValidationFunction('body') as { errors?: unknown }
          validate.errors = null
          return { errors: validate.errors ?? null }
        }),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/reset',
      payload: {},
      headers: JSON_HEADERS,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ errors: null })
  })

  it('stops the boot when Fastify keeps no compiler factories where Fastify 5 does', async () => {
    const app = { log: { info: () => undefined } } as unknown as FastifyInstance

    await expect(lazySchemaCompilationPlugin(app, { enabled: true })).rejects.toThrow(
      /found no compiler factories/
    )
  })
})
