/**
 * The spending leash for the agent-wallet server.
 *
 * Pure: no I/O, no clock, no env reads except the one explicit `loadPolicy(env)`
 * entry point. Everything else takes `now` and the ledger as arguments so the
 * window math is testable without waiting a day.
 *
 * Two caps per chain family:
 *   - per transaction  — the most one signature may move
 *   - rolling 24 hours — the most every successful submit may move, summed
 *
 * The rolling window is a true sliding window over recorded spends, not a
 * calendar day: an entry stops counting exactly 24 h after it was recorded, so
 * a denial can say when headroom comes back.
 *
 * EVM amounts are summed in wei across every allowlisted chain. That is only
 * coherent because the default allowlist (1 / 42161 / 8453) is ETH-native on
 * every entry — add a chain with a different native token and the daily EVM cap
 * starts adding apples to oranges.
 */

export type ChainFamily = 'evm' | 'cardano';

export interface Policy {
  maxTxLovelace: bigint;
  maxDailyLovelace: bigint;
  maxTxWei: bigint;
  maxDailyWei: bigint;
  /** EVM chain ids the wallet may sign for at all. */
  evmChains: number[];
}

/** One successful submit. Written only after the network accepted the transaction. */
export interface SpendEntry {
  /** epoch ms at which the submit succeeded */
  at: number;
  family: ChainFamily;
  /** base units (lovelace | wei) as a decimal string — JSON has no bigint */
  amount: string;
  chainId?: number;
  txHash?: string;
}

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MAX_TX_LOVELACE = 25_000_000n;
export const DEFAULT_MAX_DAILY_LOVELACE = 100_000_000n;
/** 0.01 ether */
export const DEFAULT_MAX_TX_WEI = 10_000_000_000_000_000n;
/** 0.03 ether */
export const DEFAULT_MAX_DAILY_WEI = 30_000_000_000_000_000n;
export const DEFAULT_EVM_CHAINS = '1,42161,8453';

interface Unit {
  decimals: number;
  symbol: string;
  base: string;
  txEnv: string;
  dailyEnv: string;
}

const UNITS: Record<ChainFamily, Unit> = {
  cardano: {
    decimals: 6,
    symbol: 'ADA',
    base: 'lovelace',
    txEnv: 'WALLET_MAX_TX_LOVELACE',
    dailyEnv: 'WALLET_MAX_DAILY_LOVELACE',
  },
  evm: {
    decimals: 18,
    symbol: 'ETH',
    base: 'wei',
    txEnv: 'WALLET_MAX_TX_WEI',
    dailyEnv: 'WALLET_MAX_DAILY_WEI',
  },
};

/** "12345678" -> "12.345678 ADA (12345678 lovelace)" — no dependency on viem. */
export function formatAmount(family: ChainFamily, value: bigint): string {
  const { decimals, symbol, base } = UNITS[family];
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${symbol} (${value} ${base})`;
}

export function baseUnit(family: ChainFamily): string {
  return UNITS[family].base;
}

function bigintEnv(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${key} must be a whole number of base units, got '${raw}'`);
  }
  return BigInt(raw.trim());
}

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  const chainsRaw = (env.WALLET_EVM_CHAINS ?? DEFAULT_EVM_CHAINS).trim() || DEFAULT_EVM_CHAINS;
  const evmChains = chainsRaw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (!/^\d+$/.test(part)) throw new Error(`WALLET_EVM_CHAINS must be a comma-separated list of chain ids, got '${part}'`);
      return Number(part);
    });

  return {
    maxTxLovelace: bigintEnv(env, 'WALLET_MAX_TX_LOVELACE', DEFAULT_MAX_TX_LOVELACE),
    maxDailyLovelace: bigintEnv(env, 'WALLET_MAX_DAILY_LOVELACE', DEFAULT_MAX_DAILY_LOVELACE),
    maxTxWei: bigintEnv(env, 'WALLET_MAX_TX_WEI', DEFAULT_MAX_TX_WEI),
    maxDailyWei: bigintEnv(env, 'WALLET_MAX_DAILY_WEI', DEFAULT_MAX_DAILY_WEI),
    evmChains,
  };
}

export function capsFor(policy: Policy, family: ChainFamily): { perTx: bigint; daily: bigint } {
  return family === 'cardano'
    ? { perTx: policy.maxTxLovelace, daily: policy.maxDailyLovelace }
    : { perTx: policy.maxTxWei, daily: policy.maxDailyWei };
}

/** Drop everything that fell out of the 24 h window. Order is preserved. */
export function pruneEntries(entries: SpendEntry[], now: number): SpendEntry[] {
  const floor = now - WINDOW_MS;
  return entries.filter((entry) => entry.at > floor);
}

export function spentInWindow(entries: SpendEntry[], family: ChainFamily, now: number): bigint {
  return pruneEntries(entries, now)
    .filter((entry) => entry.family === family)
    .reduce((total, entry) => total + BigInt(entry.amount), 0n);
}

export interface PolicyDetail {
  family: ChainFamily;
  unit: string;
  attempted: string;
  perTxCap: string;
  dailyCap: string;
  spentLast24h: string;
  /** daily cap minus what is already spent — BEFORE this attempt */
  remainingDaily: string;
  /** set only on a daily-cap denial, and only when waiting can actually help */
  headroomReturnsAt?: string;
}

/**
 * What an `isError` policy denial carries. The cap fields are optional because
 * the chain-allowlist denial happens before the ledger is even read — reporting
 * a made-up "0 spent" there would be worse than reporting nothing.
 */
export type PolicyDeniedDetail = { error: 'policy_denied'; message: string } & Partial<PolicyDetail> & {
    allowedChains?: number[];
  };

export class PolicyDenied extends Error {
  constructor(
    message: string,
    readonly detail: PolicyDeniedDetail,
  ) {
    super(message);
    this.name = 'PolicyDenied';
  }
}

function detailOf(
  family: ChainFamily,
  amount: bigint,
  perTx: bigint,
  daily: bigint,
  spent: bigint,
): PolicyDetail {
  const remaining = daily > spent ? daily - spent : 0n;
  return {
    family,
    unit: baseUnit(family),
    attempted: formatAmount(family, amount),
    perTxCap: formatAmount(family, perTx),
    dailyCap: formatAmount(family, daily),
    spentLast24h: formatAmount(family, spent),
    remainingDaily: formatAmount(family, remaining),
  };
}

/**
 * The moment enough entries age out for `amount` to fit, or undefined when no
 * amount of waiting helps (the attempt is bigger than the daily cap itself).
 */
function headroomReturnsAt(
  entries: SpendEntry[],
  family: ChainFamily,
  now: number,
  amount: bigint,
  daily: bigint,
): number | undefined {
  if (amount > daily) return undefined;
  const need = spentInWindow(entries, family, now) - (daily - amount);
  const live = pruneEntries(entries, now)
    .filter((entry) => entry.family === family)
    .sort((a, b) => a.at - b.at);
  let dropped = 0n;
  for (const entry of live) {
    dropped += BigInt(entry.amount);
    if (dropped >= need) return entry.at + WINDOW_MS;
  }
  return undefined;
}

export interface PolicyOk {
  allowed: true;
  detail: PolicyDetail;
}

/**
 * Decide whether `amount` base units may leave the wallet right now.
 * Throws `PolicyDenied` — the caller turns it into an MCP `isError` result that
 * carries the cap, the attempt and the headroom, so the agent can re-plan.
 */
export function assertSpendAllowed(
  policy: Policy,
  entries: SpendEntry[],
  family: ChainFamily,
  amount: bigint,
  now: number,
): PolicyOk {
  if (amount < 0n) throw new Error(`amount must not be negative, got ${amount}`);
  const { perTx, daily } = capsFor(policy, family);
  const spent = spentInWindow(entries, family, now);
  const detail = detailOf(family, amount, perTx, daily, spent);
  const unit = UNITS[family];

  if (amount > perTx) {
    const message =
      `policy denied: ${formatAmount(family, amount)} exceeds the per-transaction cap of ` +
      `${formatAmount(family, perTx)}. Split the spend into transactions of at most that size, ` +
      `or raise ${unit.txEnv}. Rolling-24h headroom right now: ${detail.remainingDaily} of ${detail.dailyCap}.`;
    throw new PolicyDenied(message, { error: 'policy_denied', message, ...detail });
  }

  if (spent + amount > daily) {
    const returnsAt = headroomReturnsAt(entries, family, now, amount, daily);
    const full: PolicyDetail = {
      ...detail,
      ...(returnsAt === undefined ? {} : { headroomReturnsAt: new Date(returnsAt).toISOString() }),
    };
    const message =
      `policy denied: ${formatAmount(family, amount)} would take the rolling 24h ${family} spend past the ` +
      `cap of ${formatAmount(family, daily)}. Already spent ${detail.spentLast24h} in the last 24h, so the ` +
      `headroom left is ${detail.remainingDaily}. ` +
      (returnsAt === undefined
        ? `No amount of waiting helps — this single transfer is larger than the whole daily cap. Raise ${unit.dailyEnv}.`
        : `Spend at most that, wait until ${new Date(returnsAt).toISOString()} for older spends to leave the ` +
          `window, or raise ${unit.dailyEnv}.`);
    throw new PolicyDenied(message, { error: 'policy_denied', message, ...full });
  }

  return { allowed: true, detail };
}

export function assertEvmChainAllowed(policy: Policy, chainId: number): void {
  if (policy.evmChains.includes(chainId)) return;
  const message =
    `policy denied: chain ${chainId} is not in the allowlist [${policy.evmChains.join(', ')}]. ` +
    `Add it to WALLET_EVM_CHAINS to sign for it.`;
  throw new PolicyDenied(message, {
    error: 'policy_denied',
    message,
    family: 'evm',
    attempted: `chain ${chainId}`,
    allowedChains: policy.evmChains,
  });
}

/** The caps + live headroom block that `wallet_status` reports. */
export function policySummary(policy: Policy, entries: SpendEntry[], now: number) {
  return {
    window: '24h rolling, per chain family',
    evm: {
      allowedChains: policy.evmChains,
      perTxCap: formatAmount('evm', policy.maxTxWei),
      dailyCap: formatAmount('evm', policy.maxDailyWei),
      spentLast24h: formatAmount('evm', spentInWindow(entries, 'evm', now)),
      remainingDaily: formatAmount(
        'evm',
        policy.maxDailyWei > spentInWindow(entries, 'evm', now)
          ? policy.maxDailyWei - spentInWindow(entries, 'evm', now)
          : 0n,
      ),
    },
    cardano: {
      perTxCap: formatAmount('cardano', policy.maxTxLovelace),
      dailyCap: formatAmount('cardano', policy.maxDailyLovelace),
      spentLast24h: formatAmount('cardano', spentInWindow(entries, 'cardano', now)),
      remainingDaily: formatAmount(
        'cardano',
        policy.maxDailyLovelace > spentInWindow(entries, 'cardano', now)
          ? policy.maxDailyLovelace - spentInWindow(entries, 'cardano', now)
          : 0n,
      ),
    },
  };
}
