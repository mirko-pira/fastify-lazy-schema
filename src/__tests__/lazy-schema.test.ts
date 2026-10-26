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
}

const JSON_HEADERS = { 'content-type': 'application/json' }

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

  it.each([false, 'false', ''])(
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
    expect(eager).toEqual([
      [200, '{"name":"a"}'],
      [
        400,
        '{"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request","message":"body must have required property \'name\'"}',
      ],
      [200, '{"limit":5,"type":"number"}'],
      [200, '{"type":"number"}'],
      [200, '{"id":1}'],
    ])
  })

  it('stops the boot when Fastify keeps no compiler factories where Fastify 5 does', async () => {
    const app = { log: { info: () => undefined } } as unknown as FastifyInstance

    await expect(lazySchemaCompilationPlugin(app, { enabled: true })).rejects.toThrow(
      /found no compiler factories/
    )
  })
})
