import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Run an adapter call and shape it into an MCP tool result.
 * Errors come back as `isError` with the message only — never a stack trace.
 */
export async function toolResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await run();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}
