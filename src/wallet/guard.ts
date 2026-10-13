/**
 * The signer guard: what an unsigned Cardano transaction touches, checked
 * against the taxonomy before the wallet signs it.
 *
 * Pure apart from the injected input resolver, so the rules are testable
 * without a network. Every failure is a refusal: the guard never signs blind.
 *
 * What it checks is WHICH contracts a transaction touches, not the terms it
 * asks of them — a swap order whose datum pays someone else still touches only
 * the DEX's order contract. Pinned, reviewed MCP versions and the spending caps
 * cover that gap; see specs/taxonomy-gateway.md "Threat model".
 */

import { CML } from '@lucid-evolution/lucid';

import type { ScriptRole, Venue } from '../taxonomy/schema.js';
import { formatAmount } from './policy.js';

/** The most a script transaction may put at risk as collateral; Lucid declares 5 ADA. */
export const MAX_COLLATERAL_LOVELACE = 5_000_000n;

/** Maps each "<txhash>#<index>" it can find to the address that UTxO sits at. */
export type ResolveInputs = (refs: string[]) => Promise<Map<string, string>>;

export interface Touched {
  hash: string;
  role: ScriptRole;
  where: string;
}

export type Allowlist = Map<string, { venue: string; label: string }>;

export interface GuardOptions {
  walletAddress: string;
  resolve: ResolveInputs;
  allowlist: Allowlist;
  maxThirdPartyLovelace: bigint;
  /** false for send_cardano, whose recipient is the point of the transaction */
  checkPayments: boolean;
}

export interface GuardReport {
  contracts: Array<{ hash: string; role: ScriptRole; venue: string; label: string }>;
  thirdPartyLovelace: string;
}

function parseTx(unsignedTxCbor: string): CML.Transaction {
  try {
    return CML.Transaction.from_cbor_hex(unsignedTxCbor);
  } catch (err) {
    throw new Error(
      `unsignedTxCbor is not a parseable Cardano transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function scriptHashOf(cred: CML.Credential | undefined): string | undefined {
  return cred && cred.kind() === CML.CredentialKind.Script ? cred.as_script()?.to_hex() : undefined;
}

/** Byron addresses are base58 and can never be script-locked, so an unparseable address holds no script. */
function scriptHashAt(address: string): string | undefined {
  try {
    return scriptHashOf(CML.Address.from_bech32(address).payment_cred());
  } catch {
    return undefined;
  }
}

function refsOf(list: CML.TransactionInputList | undefined): string[] {
  const refs: string[] = [];
  for (let i = 0; i < (list?.len() ?? 0); i++) {
    const input = list!.get(i);
    refs.push(`${input.transaction_id().to_hex()}#${input.index()}`);
  }
  return refs;
}

/**
 * The wallet's own address exactly: its payment key AND its stake part. Change
 * sent to the wallet's payment key under someone else's stake key would leave
 * the wallet's view and hand that key the staking rewards.
 */
export function isOwnAddress(address: CML.Address, walletAddress: string): boolean {
  const wallet = CML.Address.from_bech32(walletAddress);
  const payment = address.payment_cred();
  if (payment?.kind() !== CML.CredentialKind.PubKey) return false;
  if (payment.to_cbor_hex() !== wallet.payment_cred()?.to_cbor_hex()) return false;
  return address.staking_cred()?.to_cbor_hex() === wallet.staking_cred()?.to_cbor_hex();
}

/**
 * Body fields that move value outside outputs, or that the guard cannot vouch
 * for, are refused outright: listing threats one by one fails open on the
 * field nobody listed.
 */
function assertSupportedFields(tx: CML.Transaction): void {
  const body = tx.body();
  if (!tx.is_valid()) {
    throw new Error('refused: this transaction is marked invalid, which forfeits its collateral instead of executing.');
  }
  if ((tx.witness_set().vkeywitnesses()?.len() ?? 0) > 0 || (tx.witness_set().bootstrap_witnesses()?.len() ?? 0) > 0) {
    throw new Error(
      'refused: this transaction is already signed by another key. Rebuild it unsigned so every part of it can be checked.',
    );
  }
  if ((body.certs()?.len() ?? 0) > 0) {
    throw new Error(
      'refused: this transaction carries certificates. Their deposits leave the wallet outside every value check, ' +
        'and this wallet never needs one.',
    );
  }
  const donation = body.donation() ?? 0n;
  if (donation > 0n) {
    throw new Error(`refused: this transaction makes a treasury donation of ${formatAmount('cardano', donation)}.`);
  }
  if (body.voting_procedures() || body.proposal_procedures()) {
    throw new Error('refused: this transaction carries governance votes or proposals, which the signer guard does not support.');
  }
}

function assertCollateralBounded(body: CML.TransactionBody, walletAddress: string): void {
  const collateralReturn = body.collateral_return();
  if (collateralReturn && !isOwnAddress(collateralReturn.address(), walletAddress)) {
    throw new Error("refused: this transaction's collateral return pays an address that is not this wallet.");
  }
  if ((body.collateral_inputs()?.len() ?? 0) === 0) return;
  const total = body.total_collateral();
  if (total === undefined) {
    throw new Error('refused: this transaction declares no total collateral, so the collateral it could forfeit is unbounded.');
  }
  if (total > MAX_COLLATERAL_LOVELACE) {
    throw new Error(
      `refused: this transaction risks a total collateral of ${formatAmount('cardano', total)}; the limit is ` +
        `${formatAmount('cardano', MAX_COLLATERAL_LOVELACE)}.`,
    );
  }
}

export async function contractsTouched(unsignedTxCbor: string, resolve: ResolveInputs): Promise<Touched[]> {
  const tx = parseTx(unsignedTxCbor);
  assertSupportedFields(tx);
  const body = tx.body();

  const touched: Touched[] = [];
  const outputs = body.outputs();
  for (let i = 0; i < outputs.len(); i++) {
    const hash = scriptHashOf(outputs.get(i).address().payment_cred());
    if (hash) touched.push({ hash, role: 'spend', where: `output ${i}` });
  }

  // Collateral is spent only if a script fails, but it is still the wallet's money at stake.
  const refs = [...refsOf(body.inputs()), ...refsOf(body.collateral_inputs())];
  const resolved = refs.length > 0 ? await resolve(refs) : new Map<string, string>();
  const missing = refs.filter((r) => !resolved.has(r));
  if (missing.length > 0) {
    throw new Error(
      `refused: could not resolve ${missing.length} input(s) (${missing.join(', ')}), so the contracts ` +
        'they are locked by are unknown. Rebuild the transaction and try again.',
    );
  }
  for (const r of refs) {
    const hash = scriptHashAt(resolved.get(r)!);
    if (hash) touched.push({ hash, role: 'spend', where: `input ${r}` });
  }

  const mint = body.mint();
  const policies = mint?.keys();
  for (let i = 0; i < (policies?.len() ?? 0); i++) {
    touched.push({ hash: policies!.get(i).to_hex(), role: 'mint', where: 'mint' });
  }

  const withdrawals = body.withdrawals()?.keys();
  for (let i = 0; i < (withdrawals?.len() ?? 0); i++) {
    const hash = scriptHashOf(withdrawals!.get(i).payment());
    if (hash) touched.push({ hash, role: 'stake', where: 'withdrawal' });
  }

  const seen = new Set<string>();
  return touched.filter((t) => {
    const key = `${t.hash}:${t.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function allowlistFrom(venues: Venue[]): Allowlist {
  const allowlist: Allowlist = new Map();
  for (const venue of venues) {
    for (const s of venue.scripts ?? []) allowlist.set(`${s.hash}:${s.role}`, { venue: venue.id, label: s.label });
  }
  return allowlist;
}

/** Key-address outputs that are not this wallet. Script outputs are the contract check's job. */
export function thirdPartyPayments(
  unsignedTxCbor: string,
  walletAddress: string,
): { lovelace: bigint; tokenRecipients: string[] } {
  const outputs = parseTx(unsignedTxCbor).body().outputs();
  let lovelace = 0n;
  const tokenRecipients: string[] = [];
  for (let i = 0; i < outputs.len(); i++) {
    const output = outputs.get(i);
    if (output.address().payment_cred()?.kind() === CML.CredentialKind.Script) continue;
    if (isOwnAddress(output.address(), walletAddress)) continue;
    lovelace += output.amount().coin();
    if (output.amount().multi_asset().policy_count() > 0) {
      tokenRecipients.push(output.address().to_bech32(undefined) ?? `output ${i}`);
    }
  }
  return { lovelace, tokenRecipients };
}

export async function assertGuarded(unsignedTxCbor: string, options: GuardOptions): Promise<GuardReport> {
  const touched = await contractsTouched(unsignedTxCbor, options.resolve);
  assertCollateralBounded(parseTx(unsignedTxCbor).body(), options.walletAddress);
  const unlisted = touched.filter((t) => !options.allowlist.has(`${t.hash}:${t.role}`));
  if (unlisted.length > 0) {
    throw new Error(
      'refused: this transaction touches contracts not in the taxonomy: ' +
        `${unlisted.map((t) => `${t.hash} (${t.role})`).join(', ')}. ` +
        "Add the venue's scripts to the taxonomy by PR, or use a route through a listed venue.",
    );
  }

  let thirdParty = 0n;
  if (options.checkPayments) {
    const payments = thirdPartyPayments(unsignedTxCbor, options.walletAddress);
    if (payments.tokenRecipients.length > 0) {
      throw new Error(
        'refused: this transaction pays native tokens to an address that is not this wallet ' +
          `(${payments.tokenRecipients.join(', ')}). DeFi transactions pay tokens to contracts or back to you.`,
      );
    }
    if (payments.lovelace > options.maxThirdPartyLovelace) {
      throw new Error(
        `refused: this transaction pays ${formatAmount('cardano', payments.lovelace)} to addresses that are not ` +
          `this wallet or a listed contract; the limit is ${formatAmount('cardano', options.maxThirdPartyLovelace)} ` +
          'per transaction (WALLET_MAX_THIRD_PARTY_LOVELACE).',
      );
    }
    thirdParty = payments.lovelace;
  }

  return {
    contracts: touched.map((t) => ({ hash: t.hash, role: t.role, ...options.allowlist.get(`${t.hash}:${t.role}`)! })),
    thirdPartyLovelace: formatAmount('cardano', thirdParty),
  };
}
