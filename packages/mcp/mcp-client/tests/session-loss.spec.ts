/**
 * Session-loss recovery for the Streamable HTTP transport, exercised against a
 * real in-process server: a server that keeps a session table (as Unreal
 * Engine's MCP server does) turns every request carrying a forgotten session id
 * into an empty 404, and holds no stream whose close could reveal the loss.
 * Isolated file so the SDK mock in the reconnect suite cannot hide transport
 * behavior.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

/** A session-keeping MCP endpoint that can forget every session, like a restarted server. */
interface SessionMcpFixture {
  url: string
  initializations: number
  forgetSessions: () => void
  close: () => Promise<void>
}

interface JsonRpcBody {
  id?: number
  method?: string
  params?: { protocolVersion?: string }
}

/** Answer one JSON-RPC POST the way a POST-only server holding a session table does. */
function reply(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Set<string>,
  onInitialize: () => string,
): void {
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST, DELETE, OPTIONS' }).end()
    return
  }
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  request.on('end', () => {
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcBody
    if (message.method === 'initialize') {
      const sessionId = onInitialize()
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sessionId })
        .end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'session-fixture', version: '1.0.0' },
          },
        }))
      return
    }
    const sessionId = request.headers['mcp-session-id']
    // An unknown session answers 404 with no body: the shape the transport
    // reports as `Error POSTing to endpoint: `.
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      response.writeHead(404).end()
      return
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202).end()
      return
    }
    const result = message.method === 'tools/list'
      ? { tools: [{ name: 'ping', description: 'Replies pong.', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'pong' }] }
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
}

async function startSessionMcpFixture(): Promise<SessionMcpFixture> {
  const sessions = new Set<string>()
  const fixture = {
    url: '',
    initializations: 0,
    forgetSessions: (): void => { sessions.clear() },
    close: async (): Promise<void> => {},
  }
  const server = createServer((request, response) => {
    reply(request, response, sessions, () => {
      fixture.initializations += 1
      const sessionId = `session-${String(fixture.initializations)}`
      sessions.add(sessionId)
      return sessionId
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  fixture.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`
  fixture.close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  return fixture
}

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

let callSeq = 0

describe('streamable-http session loss', () => {
  it('re-initializes after the server forgets the session and serves calls again', async () => {
    const fixture = await startSessionMcpFixture()
    const ctx = await mountRegistry()
    const warns: string[] = []
    ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
    const signal = new AbortController().signal
    const call = () => executeToolFixture(ctx, {
      name: 'mcp__srv__ping', arguments: {}, callId: ToolCallId(`session-loss-${++callSeq}`), signal,
    })
    const config: Config = {
      transport: 'streamable-http',
      serverName: 'srv',
      url: fixture.url,
      headers: {},
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
      closeTimeoutMs: 5_000,
      expandTemplates: false,
      reconnect: { initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 },
    }
    try {
      await apply(ctx, config)
      await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__ping')).toBeDefined() })
      expect((await call()).isError).toBe(false)

      fixture.forgetSessions()
      const lost = await call()
      expect(lost.isError).toBe(true)

      // The supervisor must treat the 404 as a disconnect and re-initialize
      // instead of leaving the registered tools bound to the dead session.
      await vi.waitFor(() => { expect(fixture.initializations).toBe(2) })
      await vi.waitFor(async () => { expect((await call()).isError).toBe(false) })
      expect(warns.some(line => line.includes('server no longer holds the MCP session (HTTP 404); reconnecting'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await fixture.close()
    }
  })
})
