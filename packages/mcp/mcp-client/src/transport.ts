/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/** Signals a transport reports back to its connection supervisor. */
export interface TransportHooks {
  /**
   * The server answered a request carrying a session id with HTTP 404, so the
   * MCP session it named is gone (a restarted server keeps no session table).
   * An HTTP transport learns nothing else: it holds no stream whose close would
   * reveal the loss, and the SDK does not re-initialize on its own.
   */
  onSessionLost?: () => void
}

/** Whether this request named the MCP session a 404 would declare lost. */
function isSessionBoundPost(init: RequestInit | undefined): boolean {
  return init?.method === 'POST' && new Headers(init.headers).has('mcp-session-id')
}

/**
 * Report a session-voided 404 and return the response untouched, so the
 * in-flight request still fails with the server's own error and the supervisor
 * owns the re-initialization.
 *
 * @param onSessionLost - Supervisor callback run for each session-bound 404.
 * @returns A fetch that reports session loss before the caller sees the 404.
 */
function sessionLossReportingFetch(onSessionLost: () => void): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    if (response.status === 404 && isSessionBoundPost(init)) onSessionLost()
    return response
  }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param hooks - Supervisor signals the transport reports; omission leaves the
 *   SDK transport untouched.
 * @returns an unstarted MCP transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config, hooks: TransportHooks = {}): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      const onSessionLost = hooks.onSessionLost
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: { headers: config.headers },
          ...onSessionLost === undefined ? {} : { fetch: sessionLossReportingFetch(onSessionLost) },
        },
      )
    }
  }
}
