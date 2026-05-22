import { describe, it, beforeAll } from 'vitest';
import { WalletBuilder } from '@midnight-ntwrk/wallet';
import { getZswapNetworkId, NetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { nativeToken } from '@midnight-ntwrk/ledger';

// @ts-ignore
globalThis.WebSocket = WebSocket;
setNetworkId(NetworkId.Undeployed);

const INDEXER    = 'http://127.0.0.1:8088/api/v1/graphql';
const INDEXER_WS = 'ws://127.0.0.1:8088/api/v1/graphql/ws';
const PROOF      = 'http://127.0.0.1:6300';
const NODE       = 'http://127.0.0.1:9944';
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const BENCH_SEED   = 'e6f47bd55f54f437cdbcad6286324554d0605f1e97a3a7a44bb55c3bcca17bbd';

describe('Fund wallet', () => {
  it('transfers funds from genesis to bench wallet', async () => {
    console.log('Building genesis wallet...');
    const genesisWallet = await WalletBuilder.buildFromSeed(
      INDEXER, INDEXER_WS, PROOF, NODE,
      GENESIS_SEED, getZswapNetworkId(), 'info',
    );
    genesisWallet.start();

console.log('Waiting for genesis wallet to sync...');
await Rx.firstValueFrom(
  genesisWallet.state().pipe(
    Rx.throttleTime(5000),
    Rx.tap(s => console.log(`  synced=${s.syncProgress?.synced} txs=${s.transactionHistory.length}`)),
    Rx.filter(s => s.syncProgress !== undefined),
  )
);
console.log('Genesis wallet synced.');
    console.log('Genesis wallet synced.');

    const benchWallet = await WalletBuilder.buildFromSeed(
      INDEXER, INDEXER_WS, PROOF, NODE,
      BENCH_SEED, getZswapNetworkId(), 'info',
    );
    benchWallet.start();

    const benchState = await Rx.firstValueFrom(benchWallet.state());
    console.log('Bench address:', benchState.address);


// and the transfer call:
console.log('Transferring funds...');
const txToProve = await genesisWallet.transferTransaction([{
  amount: 10000000n,
  type: nativeToken(),
  receiverAddress: benchState.address,
}]);
console.log('Transfer created, proving...');
const provedTx = await genesisWallet.proveTransaction(txToProve);
console.log('Proved, submitting...');
const txId = await genesisWallet.submitTransaction(provedTx);
console.log('Transfer submitted:', txId);

    await new Promise(r => setTimeout(r, 15000));

    const updated = await Rx.firstValueFrom(benchWallet.state());
    console.log('Bench balance:', JSON.stringify(updated.balances));

    genesisWallet.close();
    benchWallet.close();
  }, 300000);
});