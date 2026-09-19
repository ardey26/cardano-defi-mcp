/**
 * Liqwid v2 GraphQL adapter — read-only.
 *
 * Endpoint: LIQWID_GRAPHQL_URL (default https://v2.api.liqwid.finance/graphql).
 *
 * Schema pinned by introspection against the live endpoint:
 *   Query.liqwid: LiqwidQueries -> .data: LiqwidData
 *   LiqwidData.markets(input: MarketsInput): MarketPagination { results: [Market!]! }
 *   LiqwidData.loans(input: LoansInput):   LoanPagination   { results: [Loan!]!   }
 *   MarketsInput { ids, page, perPage, sorts, filters, search }
 *   LoansInput   { page, perPage, paymentKeys, sorts, filters, marketIds, search }
 * Pagination is ZERO-indexed: `page: 1` with 32 markets returns an empty list.
 */

import { paymentCredentialOf } from '@lucid-evolution/lucid';

export interface LiqwidMarket {
  id: string;
  asset: string;
  supplyAPY: number;
  borrowAPR: number;
  utilization: number;
}

export interface LiqwidLoan {
  id: string;
  marketId: string;
  asset: string;
  ownerPaymentKeyHash: string;
  debt: number;
  collateralValue: number;
  healthFactor: number;
  ltv: number;
  apy: number;
}

const DEFAULT_URL = 'https://v2.api.liqwid.finance/graphql';
const PER_PAGE = 100;

const MARKETS_QUERY = `query Markets($input: MarketsInput) {
  liqwid {
    data {
      markets(input: $input) {
        totalCount
        results {
          id
          displayName
          supplyAPY
          borrowAPR
          utilization
        }
      }
    }
  }
}`;

const LOANS_QUERY = `query Loans($input: LoansInput) {
  liqwid {
    data {
      loans(input: $input) {
        totalCount
        results {
          id
          marketId
          ownerPaymentKeyHash
          debt
          collateralValue
          healthFactor
          LTV
          APY
          asset { displayName }
        }
      }
    }
  }
}`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function query<T>(gql: string, variables: Record<string, unknown>): Promise<T> {
  const url = process.env.LIQWID_GRAPHQL_URL ?? DEFAULT_URL;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: gql, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Liqwid GraphQL ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }

  const payload = (await res.json()) as GraphQLResponse<T>;
  if (payload.errors?.length) {
    throw new Error(`Liqwid GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  if (!payload.data) {
    throw new Error('Liqwid GraphQL returned no data');
  }
  return payload.data;
}

interface MarketsData {
  liqwid: {
    data: {
      markets: {
        totalCount: number;
        results: {
          id: string;
          displayName: string;
          supplyAPY: number;
          borrowAPR: number;
          utilization: number;
        }[];
      };
    };
  };
}

export async function getMarkets(): Promise<LiqwidMarket[]> {
  const data = await query<MarketsData>(MARKETS_QUERY, { input: { page: 0, perPage: PER_PAGE } });

  return data.liqwid.data.markets.results.map((m) => ({
    id: m.id,
    asset: m.displayName,
    supplyAPY: m.supplyAPY,
    borrowAPR: m.borrowAPR,
    utilization: m.utilization,
  }));
}

interface LoansData {
  liqwid: {
    data: {
      loans: {
        totalCount: number;
        results: {
          id: string;
          marketId: string;
          ownerPaymentKeyHash: string;
          debt: number;
          collateralValue: number;
          healthFactor: number;
          LTV: number;
          APY: number;
          asset: { displayName: string };
        }[];
      };
    };
  };
}

/** Loans owned by the payment key hash behind `address` (a bech32 Cardano address). */
export async function getPositions(address: string): Promise<LiqwidLoan[]> {
  const paymentKeyHash = paymentCredentialOf(address).hash;

  const data = await query<LoansData>(LOANS_QUERY, {
    input: { page: 0, perPage: PER_PAGE, paymentKeys: [paymentKeyHash] },
  });

  return data.liqwid.data.loans.results.map((l) => ({
    id: l.id,
    marketId: l.marketId,
    asset: l.asset.displayName,
    ownerPaymentKeyHash: l.ownerPaymentKeyHash,
    debt: l.debt,
    collateralValue: l.collateralValue,
    healthFactor: l.healthFactor,
    ltv: l.LTV,
    apy: l.APY,
  }));
}
