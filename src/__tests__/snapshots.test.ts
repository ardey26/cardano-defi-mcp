import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { gatewayMcps, packageSpecs } from '../gateway/eligibility.js';
import { loadSnapshot } from '../taxonomy/index.js';

describe('published snapshots', () => {
  for (const { mcp, connect, tools } of gatewayMcps()) {
    it(`${mcp.id}: one entry per exposed tool, at the pinned packages, with schemas zod can load`, () => {
      const snapshot = loadSnapshot(mcp.id);
      expect(snapshot.packages).toEqual(packageSpecs(connect.args));
      expect(snapshot.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
      for (const tool of snapshot.tools) {
        expect(JSON.stringify(tool.inputSchema)).not.toContain('$ref');
        expect(() => z.fromJSONSchema(tool.inputSchema as never)).not.toThrow();
      }
    });
  }
});
