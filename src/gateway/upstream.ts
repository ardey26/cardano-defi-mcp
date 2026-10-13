/**
 * One third-party MCP server run as a child process for the gateway: spawned on
 * the first call, reused, stopped when idle, killed and respawned after a
 * timeout or crash. It sees PATH, a throwaway HOME and npm settings — never
 * this server's environment (the SDK adds its own non-secret defaults such as
 * USER and SHELL).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface UpstreamOptions {
  connectTimeoutMs: number;
  callTimeoutMs: number;
  idleMs: number;
  cacheDir: string;
}

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const DEFAULT_UPSTREAM_OPTIONS: UpstreamOptions = {
  connectTimeoutMs: 120_000,
  callTimeoutMs: 60_000,
  idleMs: 10 * 60_000,
  cacheDir: process.env.GATEWAY_CACHE_DIR || join(PACKAGE_ROOT, '.gateway-cache'),
};

export function childEnv(cacheDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: mkdtempSync(join(tmpdir(), 'gateway-home-')),
    npm_config_cache: cacheDir,
    npm_config_ignore_scripts: 'true',
    npm_config_yes: 'true',
    npm_config_update_notifier: 'false',
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class Upstream {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly name: string,
    private readonly connect: { command: string; args: string[] },
    private readonly options: UpstreamOptions,
  ) {}

  get running(): boolean {
    return this.client !== undefined;
  }

  private async start(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const transport = new StdioClientTransport({
        command: this.connect.command,
        args: this.connect.args,
        env: childEnv(this.options.cacheDir),
        stderr: 'ignore',
      });
      const client = new Client({ name: 'cardano-defi-mcp-gateway', version: '0.1.0' });
      transport.onclose = () => {
        if (this.client === client) this.client = undefined;
      };
      try {
        await withTimeout(client.connect(transport), this.options.connectTimeoutMs, `starting ${this.name}`);
      } catch (err) {
        await client.close().catch(() => {});
        throw err;
      }
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), this.options.idleMs);
    this.idleTimer.unref();
  }

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.start();
    this.touch();
    try {
      return (await withTimeout(
        client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.options.callTimeoutMs }),
        this.options.callTimeoutMs + 1_000,
        `${this.name} ${tool}`,
      )) as CallToolResult;
    } catch (err) {
      // A hung or dead upstream is replaced on the next call rather than reused.
      await this.close();
      throw err;
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }
}
