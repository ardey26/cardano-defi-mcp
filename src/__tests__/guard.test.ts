import { CML } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { allowlistFrom, assertGuarded, contractsTouched, thirdPartyPayments, type ResolveInputs } from '../wallet/guard.js';
import type { Venue } from '../taxonomy/schema.js';
import { loadVenues } from '../taxonomy/index.js';
import { cardanoOutflowLovelace } from '../wallet/cardano.js';

const ORDER = 'a1'.repeat(28);
const POLICY = 'b2'.repeat(28);
const STAKER = 'c3'.repeat(28);
const UNLISTED = 'd4'.repeat(28);
const TX0 = '00'.repeat(32);
const TX1 = '11'.repeat(32);

const keyHash = () => CML.PrivateKey.generate_ed25519().to_public().hash();
const keyAddress = (hash = keyHash()) => CML.EnterpriseAddress.new(1, CML.Credential.new_pub_key(hash)).to_address();
const scriptAddress = (hex: string) =>
  CML.EnterpriseAddress.new(1, CML.Credential.new_script(CML.ScriptHash.from_hex(hex))).to_address();

const wallet = keyAddress();
const WALLET = wallet.to_bech32(undefined);

const venues = [
  {
    id: 'dex', name: 'Dex', category: 'dex', url: 'https://dex.example', description: 'd', assets: ['ADA'], capabilities: ['trade.swap'],
    scripts: [
      { hash: ORDER, role: 'spend', label: 'order', source: 'https://x.example' },
      { hash: POLICY, role: 'mint', label: 'lp', source: 'https://x.example' },
      { hash: STAKER, role: 'stake', label: 'withdraw-zero', source: 'https://x.example' },
    ],
  },
] as Venue[];
const allowlist = allowlistFrom(venues);

interface Shape {
  outputs?: Array<{ to: CML.Address; lovelace?: bigint; token?: boolean }>;
  inputs?: string[];
  refInputs?: string[];
  mint?: string;
  withdrawFrom?: string;
  delegateScript?: string;
  registerKey?: boolean;
  vote?: boolean;
  donation?: bigint;
  invalid?: boolean;
  collateral?: { inputs: string[]; total?: bigint; returnTo?: CML.Address };
  signedBy?: CML.PrivateKey;
}

function ref(r: string) {
  const [hash, index] = r.split('#');
  return CML.TransactionInput.new(CML.TransactionHash.from_hex(hash), BigInt(index));
}

function tx(shape: Shape): string {
  const inputs = CML.TransactionInputList.new();
  for (const r of shape.inputs ?? [`${TX0}#0`]) inputs.add(ref(r));
  const outs = CML.TransactionOutputList.new();
  for (const o of shape.outputs ?? [{ to: wallet }]) {
    const assets = CML.MultiAsset.new();
    if (o.token) {
      const names = CML.MapAssetNameToCoin.new();
      names.insert(CML.AssetName.from_hex('4d494c4b'), 5n);
      assets.insert_assets(CML.ScriptHash.from_hex(POLICY), names);
    }
    outs.add(CML.TransactionOutput.new(o.to, CML.Value.new(o.lovelace ?? 2_000_000n, assets), undefined, undefined));
  }
  const body = CML.TransactionBody.new(inputs, outs, 200_000n);
  if (shape.refInputs) {
    const refs = CML.TransactionInputList.new();
    for (const r of shape.refInputs) refs.add(ref(r));
    body.set_reference_inputs(refs);
  }
  if (shape.mint) {
    const mint = CML.Mint.new();
    const names = CML.MapAssetNameToNonZeroInt64.new();
    names.insert(CML.AssetName.from_hex('4344'), 1n);
    mint.insert_assets(CML.ScriptHash.from_hex(shape.mint), names);
    body.set_mint(mint);
  }
  if (shape.withdrawFrom) {
    const w = CML.MapRewardAccountToCoin.new();
    w.insert(CML.RewardAddress.new(1, CML.Credential.new_script(CML.ScriptHash.from_hex(shape.withdrawFrom))), 0n);
    body.set_withdrawals(w);
  }
  if (shape.delegateScript) {
    const certs = CML.CertificateList.new();
    certs.add(CML.Certificate.new_stake_delegation(
      CML.Credential.new_script(CML.ScriptHash.from_hex(shape.delegateScript)), CML.Ed25519KeyHash.from_hex('11'.repeat(28)),
    ));
    body.set_certs(certs);
  }
  if (shape.registerKey) {
    const certs = CML.CertificateList.new();
    certs.add(CML.Certificate.new_stake_registration(CML.Credential.new_pub_key(keyHash())));
    body.set_certs(certs);
  }
  if (shape.donation) body.set_donation(shape.donation);
  if (shape.collateral) {
    const col = CML.TransactionInputList.new();
    for (const r of shape.collateral.inputs) col.add(ref(r));
    body.set_collateral_inputs(col);
    if (shape.collateral.total !== undefined) body.set_total_collateral(shape.collateral.total);
    if (shape.collateral.returnTo) {
      body.set_collateral_return(
        CML.TransactionOutput.new(shape.collateral.returnTo, CML.Value.new(10_000_000n, CML.MultiAsset.new()), undefined, undefined),
      );
    }
  }
  if (shape.vote) {
    const vp = CML.VotingProcedures.new();
    vp.insert(CML.Voter.new_d_rep_key_hash(keyHash()), CML.MapGovActionIdToVotingProcedure.new());
    body.set_voting_procedures(vp);
  }
  const witnesses = CML.TransactionWitnessSet.new();
  if (shape.signedBy) {
    const vkeys = CML.VkeywitnessList.new();
    vkeys.add(CML.make_vkey_witness(CML.hash_transaction(body), shape.signedBy));
    witnesses.set_vkeywitnesses(vkeys);
  }
  return CML.Transaction.new(body, witnesses, !shape.invalid, undefined).to_cbor_hex();
}

/** Every input resolves to the wallet unless listed in `at`. */
const resolver = (at: Record<string, CML.Address> = {}, missing: string[] = []): ResolveInputs => async (refs) =>
  new Map(refs.filter((r) => !missing.includes(r)).map((r) => [r, (at[r] ?? wallet).to_bech32(undefined)]));

const guard = (cbor: string, resolve = resolver(), checkPayments = true, max = 5_000_000n) =>
  assertGuarded(cbor, { walletAddress: WALLET, resolve, allowlist, maxThirdPartyLovelace: max, checkPayments });

describe('contractsTouched', () => {
  it('collects output, input, mint and withdrawal scripts with their roles', async () => {
    const cbor = tx({
      inputs: [`${TX0}#0`, `${TX1}#3`],
      outputs: [{ to: scriptAddress(ORDER) }, { to: wallet }],
      mint: POLICY, withdrawFrom: STAKER,
    });
    const touched = await contractsTouched(cbor, resolver({ [`${TX1}#3`]: scriptAddress(ORDER) }));
    expect(touched.map((t) => `${t.hash.slice(0, 4)}:${t.role}`).sort()).toEqual(['a1a1:spend', 'b2b2:mint', 'c3c3:stake']);
  });

  it('ignores reference inputs', async () => {
    const cbor = tx({ refInputs: [`${TX1}#0`] });
    expect(await contractsTouched(cbor, resolver({ [`${TX1}#0`]: scriptAddress(UNLISTED) }))).toEqual([]);
  });

  it('refuses when an input cannot be resolved', async () => {
    const cbor = tx({ inputs: [`${TX0}#0`, `${TX1}#1`] });
    await expect(contractsTouched(cbor, resolver({}, [`${TX1}#1`]))).rejects.toThrow(
      new RegExp(`refused: could not resolve 1 input\\(s\\) \\(${TX1}#1\\)`),
    );
  });

  it('refuses governance votes and proposals', async () => {
    await expect(contractsTouched(tx({ vote: true }), resolver())).rejects.toThrow(/refused: .*governance/);
  });

  it('refuses CBOR that is not a transaction', async () => {
    await expect(contractsTouched('deadbeef', resolver())).rejects.toThrow(/not a parseable Cardano transaction/);
  });
});

describe('assertGuarded', () => {
  it('passes a transaction that only touches listed contracts, and reports them by venue', async () => {
    const report = await guard(tx({ outputs: [{ to: scriptAddress(ORDER) }, { to: wallet }], mint: POLICY }));
    expect(report.contracts).toEqual([
      { hash: ORDER, role: 'spend', venue: 'dex', label: 'order' },
      { hash: POLICY, role: 'mint', venue: 'dex', label: 'lp' },
    ]);
  });

  it('refuses an unlisted contract and names its hash and role', async () => {
    await expect(guard(tx({ outputs: [{ to: scriptAddress(UNLISTED) }] }))).rejects.toThrow(
      `refused: this transaction touches contracts not in the taxonomy: ${UNLISTED} (spend). ` +
        "Add the venue's scripts to the taxonomy by PR, or use a route through a listed venue.",
    );
  });

  it('refuses a listed hash used under a role it is not listed for', async () => {
    await expect(guard(tx({ withdrawFrom: ORDER }))).rejects.toThrow(new RegExp(`${ORDER} \\(stake\\)`));
  });

  it('refuses native tokens paid to a stranger', async () => {
    const stranger = keyAddress();
    await expect(guard(tx({ outputs: [{ to: stranger, token: true }] }))).rejects.toThrow(
      /refused: this transaction pays native tokens to an address that is not this wallet/,
    );
  });

  it('allows a small ADA fee to a stranger and refuses one over the limit', async () => {
    const stranger = keyAddress();
    const report = await guard(tx({ outputs: [{ to: stranger, lovelace: 1_000_000n }, { to: wallet }] }));
    expect(report.thirdPartyLovelace).toBe('1 ADA (1000000 lovelace)');
    await expect(guard(tx({ outputs: [{ to: stranger, lovelace: 6_000_000n }] }))).rejects.toThrow(
      /refused: this transaction pays 6 ADA \(6000000 lovelace\) to addresses that are not this wallet or a listed contract; the limit is 5 ADA/,
    );
  });

  it('skips the payment checks when told to (send_cardano pays its recipient on purpose)', async () => {
    const report = await guard(tx({ outputs: [{ to: keyAddress(), lovelace: 50_000_000n }] }), resolver(), false);
    expect(report.contracts).toEqual([]);
  });
});

describe('thirdPartyPayments', () => {
  it('counts key outputs that are not the wallet, and ignores script outputs and change', () => {
    const stranger = keyAddress();
    const cbor = tx({ outputs: [{ to: stranger, lovelace: 3n }, { to: scriptAddress(ORDER), lovelace: 9n }, { to: wallet, lovelace: 7n }] });
    expect(thirdPartyPayments(cbor, WALLET)).toEqual({ lovelace: 3n, tokenRecipients: [] });
  });

  it('treats a Byron output as a stranger without crashing', () => {
    const byron = CML.ByronAddress.from_base58(
      'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi',
    ).to_address();
    const cbor = tx({ outputs: [{ to: byron, lovelace: 4n }] });
    expect(thirdPartyPayments(cbor, WALLET).lovelace).toBe(4n);
  });
});

describe('the published taxonomy', () => {
  const published = allowlistFrom(loadVenues());
  const realGuard = (cbor: string) =>
    assertGuarded(cbor, { walletAddress: WALLET, resolve: resolver(), allowlist: published, maxThirdPartyLovelace: 5_000_000n, checkPayments: true });

  it.each([
    ['minswap', 'c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c'],
    ['wingriders', 'c134d839a64a5dfb9b155869ef3f34280751a622f69958baa8ffd29c'],
    ['sundaeswap', 'fa6a58bbe2d0ff05534431c8e2f0ef2cbdc1602a8456e4b13c8f3077'],
    ['splash', '464eeee89f05aff787d40045af2a40a83fd96c513197d32fbc54ff02'],
  ])('lets a swap order to %s through, with Fetch\'s 1 ADA fee', async (venue, order) => {
    const cbor = tx({ outputs: [{ to: scriptAddress(order) }, { to: keyAddress(), lovelace: 1_000_000n }, { to: wallet }] });
    expect((await realGuard(cbor)).contracts).toEqual([expect.objectContaining({ hash: order, role: 'spend', venue })]);
  });

  it('lets an Indigo CDP open through', async () => {
    const cbor = tx({
      outputs: [{ to: scriptAddress('ff0b10bff20e4b68b491492e5ba6c8048a704763b0a45ce2995da0be') }, { to: wallet }],
      mint: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880',
      withdrawFrom: '4949403eece2eea554df601a883c50d0ef005fa66e7a7300bad5ebc2',
    });
    expect((await realGuard(cbor)).contracts.every((c) => c.venue === 'indigo')).toBe(true);
  });

  it('refuses a DEX that is not in the taxonomy', async () => {
    await expect(realGuard(tx({ outputs: [{ to: scriptAddress(UNLISTED) }] }))).rejects.toThrow(/not in the taxonomy/);
  });
});

describe('transaction shape (review fixes)', () => {
  it.each([
    ['a stake-key registration, whose deposit leaves the wallet unseen', { registerKey: true }, /refused: .*certificates/],
    ['a certificate for a listed script', { delegateScript: STAKER }, /refused: .*certificates/],
    ['a treasury donation', { donation: 1_000_000_000n }, /refused: .*treasury donation/],
    ['a transaction marked invalid, which forfeits collateral', { invalid: true }, /refused: .*marked invalid/],
  ] as const)('refuses %s', async (_label, shape, message) => {
    await expect(guard(tx(shape))).rejects.toThrow(message);
  });

  it('refuses a transaction that already carries signatures', async () => {
    await expect(guard(tx({ signedBy: CML.PrivateKey.generate_ed25519() }))).rejects.toThrow(/refused: .*already signed/);
  });

  it('refuses collateral that returns to a stranger, is undeclared, or exceeds 5 ADA', async () => {
    const inputs = [`${TX1}#7`];
    await expect(guard(tx({ collateral: { inputs, total: 5_000_000n, returnTo: keyAddress() } }))).rejects.toThrow(
      /refused: .*collateral return/,
    );
    await expect(guard(tx({ collateral: { inputs, returnTo: wallet } }))).rejects.toThrow(/refused: .*total collateral/);
    await expect(guard(tx({ collateral: { inputs, total: 6_000_000n, returnTo: wallet } }))).rejects.toThrow(
      /refused: .*total collateral of 6 ADA/,
    );
    await expect(guard(tx({ collateral: { inputs, total: 5_000_000n, returnTo: wallet } }))).resolves.toBeDefined();
  });

  it("counts an output to the wallet's payment key with a foreign stake key as a stranger", () => {
    const foreignStake = CML.BaseAddress.new(
      1, wallet.payment_cred()!, CML.Credential.new_pub_key(keyHash()),
    ).to_address();
    const cbor = tx({ outputs: [{ to: foreignStake, lovelace: 500_000_000n }] });
    expect(thirdPartyPayments(cbor, WALLET).lovelace).toBe(500_000_000n);
    expect(cardanoOutflowLovelace(cbor, WALLET).lovelace).toBe(500_000_000n + 200_000n);
  });
});
