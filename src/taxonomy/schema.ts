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

export type Category = z.infer<typeof CategorySchema>;
export type Venue = z.infer<typeof VenueSchema>;
export type CapabilityNode = z.infer<typeof CapabilityNodeSchema>;
