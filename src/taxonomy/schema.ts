import { z } from 'zod';

export const CategorySchema = z.enum([
  'dex',
  'lending',
  'cdp',
  'stablecoin',
  'derivatives',
]);

// Two-level dot path into taxonomy/capabilities.json, e.g. "lend.borrow".
export const CapabilityIdSchema = z
  .string()
  .regex(/^[a-z][a-z_]*\.[a-z][a-z_]*$/, 'must look like "group.action" in lowercase');

export const CapabilityNodeSchema = z.strictObject({
  id: CapabilityIdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
});

export const VenueSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  category: CategorySchema,
  url: z.string().url(),
  description: z.string().min(1),
  assets: z.array(z.string().min(1)),
  capabilities: z.array(CapabilityIdSchema).min(1),
  notes: z.string().min(1).optional(),
});

// What calling the tool can do to funds: read nothing, hand back an unsigned
// transaction, or sign and submit with keys the server holds.
export const EffectSchema = z.enum(['read', 'unsigned_tx', 'signs']);

export const AuthSchema = z.enum(['none', 'api_key', 'oauth']);

// Ready-to-paste client config for one transport.
export const ConnectSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()),
  }),
  z.strictObject({
    transport: z.literal('http'),
    url: z.string().url(),
  }),
]);

export const McpToolSchema = z.strictObject({
  name: z.string().min(1),
  capability: CapabilityIdSchema,
  // Omitted for a venue-agnostic tool (a wallet or an aggregator that does not name venues).
  venues: z.array(z.string().min(1)).min(1).optional(),
  effect: EffectSchema,
  notes: z.string().min(1).optional(),
});

export const McpSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  publisher: z.string().min(1),
  // True only when the publisher operates the venue(s) the tools act on.
  official: z.boolean(),
  repo: z.string().url(),
  connect: z.array(ConnectSchema).min(1),
  auth: AuthSchema,
  tools: z.array(McpToolSchema).min(1),
  notes: z.string().min(1).optional(),
});

export type Category = z.infer<typeof CategorySchema>;
export type Venue = z.infer<typeof VenueSchema>;
export type CapabilityNode = z.infer<typeof CapabilityNodeSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type McpTool = z.infer<typeof McpToolSchema>;
export type Mcp = z.infer<typeof McpSchema>;
