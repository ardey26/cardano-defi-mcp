import { z } from 'zod';

export const CategorySchema = z.enum([
  'dex',
  'lending',
  'cdp',
  'stablecoin',
  'derivatives',
]);

export const CapabilitySchema = z.enum([
  'swap',
  'liquidity_provision',
  'supply',
  'borrow',
  'cdp_mint',
  'stability_pool',
  'staking',
  'perps',
  'stablecoin_mint',
]);

export const IntegrationSchema = z.enum([
  'indexed',
  'adapter_live',
  'read_only',
]);

export const VenueSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: CategorySchema,
  url: z.string().url(),
  description: z.string().min(1),
  assets: z.array(z.string().min(1)),
  capabilities: z.array(CapabilitySchema).min(1),
  integration: IntegrationSchema,
  notes: z.string().optional(),
});

export type Category = z.infer<typeof CategorySchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
export type Venue = z.infer<typeof VenueSchema>;
