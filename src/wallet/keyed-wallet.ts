/**
 * A CIP-30 wallet over one raw ed25519 key, for `lucid.selectWallet.fromAPI`.
 *
 * Lucid's own private-key wallet is hard-wired to an enterprise address, which
 * aggregators refuse. This one presents the key's base address (payment and
 * stake credential both this key), selects UTxOs from the base address and the
 * legacy enterprise address alike, and sends change to the base address. One
 * vkey witness covers both, since they share the key.
 */

import { CML, utxoToCore, type Provider, type WalletApi } from '@lucid-evolution/lucid';

import { addressOf, legacyAddressOf, type Net } from './keys.js';

export function makeKeyedApi(
  privateKey: string,
  net: Net | 'Custom',
  provider: Pick<Provider, 'getUtxos' | 'submitTx'>,
): WalletApi {
  const priv = CML.PrivateKey.from_bech32(privateKey);
  const networkId = net === 'Mainnet' ? 1 : 0;
  const base = addressOf(privateKey, net);
  const legacy = legacyAddressOf(privateKey, net);
  const hexOf = (bech32: string) => CML.Address.from_bech32(bech32).to_hex();
  const rewardHex = CML.RewardAddress.new(networkId, CML.Credential.new_pub_key(priv.to_public().hash())).to_address().to_hex();
  const utxos = async () => (await Promise.all([provider.getUtxos(base), provider.getUtxos(legacy)])).flat();

  return {
    getNetworkId: async () => networkId,
    getUtxos: async () => (await utxos()).map((u) => utxoToCore(u).to_cbor_hex()),
    getCollateral: async () => [],
    getBalance: async () => {
      const lovelace = (await utxos()).reduce((sum, u) => sum + u.assets.lovelace, 0n);
      return CML.Value.from_coin(lovelace).to_cbor_hex();
    },
    getUsedAddresses: async () => [hexOf(base)],
    getUnusedAddresses: async () => [],
    getChangeAddress: async () => hexOf(base),
    getRewardAddresses: async () => [rewardHex],
    signTx: async (tx: string) => {
      const body = CML.Transaction.from_cbor_hex(tx).body();
      const witnesses = CML.TransactionWitnessSetBuilder.new();
      witnesses.add_vkey(CML.make_vkey_witness(CML.hash_transaction(body), priv));
      return witnesses.build().to_cbor_hex();
    },
    signData: async () => {
      throw new Error('signData is not supported by this wallet');
    },
    submitTx: async (tx: string) => provider.submitTx(tx),
    experimental: { getCollateral: async () => [], on: () => {}, off: () => {} },
  } as unknown as WalletApi;
}
