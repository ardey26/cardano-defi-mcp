/**
 * The wallet's base address and its keyed CIP-30 wallet, end to end on Lucid's offline Emulator:
 * no network, no real funds.
 */
import { CML, Emulator, Lucid } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { addressOf, legacyAddressOf } from '../wallet/keys.js';
import { makeKeyedApi } from '../wallet/keyed-wallet.js';
import { isOwnAddress } from '../wallet/guard.js';
import { precheckLovelace } from '../wallet/cardano.js';

const key = CML.PrivateKey.generate_ed25519().to_bech32();
const keyHash = CML.PrivateKey.from_bech32(key).to_public().hash().to_hex();

describe('wallet addresses', () => {
  it('signs for a base address whose payment and stake credential are both its own key', () => {
    const base = CML.Address.from_bech32(addressOf(key, 'Mainnet'));
    expect(addressOf(key, 'Mainnet')).toMatch(/^addr1q/);
    expect(base.payment_cred()?.as_pub_key()?.to_hex()).toBe(keyHash);
    expect(base.staking_cred()?.as_pub_key()?.to_hex()).toBe(keyHash);
  });

  it('keeps the old enterprise address as the legacy address', () => {
    expect(legacyAddressOf(key, 'Mainnet')).toMatch(/^addr1v/);
    expect(CML.Address.from_bech32(legacyAddressOf(key, 'Mainnet')).payment_cred()?.as_pub_key()?.to_hex()).toBe(keyHash);
  });

  it('counts both forms as the wallet, and a foreign stake key as a stranger', () => {
    const wallet = addressOf(key, 'Mainnet');
    expect(isOwnAddress(CML.Address.from_bech32(legacyAddressOf(key, 'Mainnet')), wallet)).toBe(true);
    const foreign = CML.BaseAddress.new(
      1,
      CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(keyHash)),
      CML.Credential.new_pub_key(CML.PrivateKey.generate_ed25519().to_public().hash()),
    ).to_address();
    expect(isOwnAddress(foreign, wallet)).toBe(false);
  });
});

describe('keyed CIP-30 wallet on the Emulator', () => {
  it('spends from both addresses, sends change to the base address, and submits', async () => {
    const base = addressOf(key, 'Custom');
    const legacy = legacyAddressOf(key, 'Custom');
    const recipient = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.PrivateKey.generate_ed25519().to_public().hash()))
      .to_address().to_bech32(undefined);
    const emulator = new Emulator([
      { address: base, assets: { lovelace: 3_000_000n }, seedPhrase: '', privateKey: '' },
      { address: legacy, assets: { lovelace: 4_000_000n }, seedPhrase: '', privateKey: '' },
    ]);
    const lucid = await Lucid(emulator, 'Custom');
    lucid.selectWallet.fromAPI(makeKeyedApi(key, 'Custom', emulator));

    expect(await lucid.wallet().address()).toBe(base);
    const built = await lucid.newTx().pay.ToAddress(recipient, { lovelace: 5_000_000n }).complete();
    const signed = await built.sign.withWallet().complete();
    const hash = await signed.submit();
    emulator.awaitBlock(1);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await emulator.getUtxos(recipient)).reduce((s, u) => s + u.assets.lovelace, 0n)).toBe(5_000_000n);
    expect(await emulator.getUtxos(legacy)).toEqual([]);
    expect((await emulator.getUtxos(base)).length).toBe(1);
  });
});

describe('own-address boundary (review fixes)', () => {
  const wallet = addressOf(key, 'Mainnet');

  it('treats a pointer address with the wallet key as a stranger, since the wallet never queries it', () => {
    // header 0x41 = pointer address, key payment, mainnet; then the key hash and pointer (slot 1, tx 2, cert 3)
    const pointer = CML.Address.from_hex(`41${keyHash}010203`);
    expect(isOwnAddress(pointer, wallet)).toBe(false);
  });

  it('treats the wallet key on the other network as a stranger', () => {
    expect(isOwnAddress(CML.Address.from_bech32(legacyAddressOf(key, 'Preprod')), wallet)).toBe(false);
    expect(isOwnAddress(CML.Address.from_bech32(addressOf(key, 'Preprod')), wallet)).toBe(false);
  });

  it('prechecks a self-transfer at zero, so legacy funds can be moved to the base address under the cap', () => {
    expect(precheckLovelace(legacyAddressOf(key, 'Mainnet'), 500_000_000n, wallet)).toBe(0n);
    expect(precheckLovelace(wallet, 500_000_000n, wallet)).toBe(0n);
    expect(precheckLovelace(legacyAddressOf(CML.PrivateKey.generate_ed25519().to_bech32(), 'Mainnet'), 7n, wallet)).toBe(7n);
  });
});
