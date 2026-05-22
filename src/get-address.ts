import { WalletBuilder } from '@midnight-ntwrk/wallet';
import { getZswapNetworkId, NetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as Rx from 'rxjs';

setNetworkId(NetworkId.TestNet);

const YOUR_SEED = 'e6f47bd55f54f437cdbcad6286324554d0605f1e97a3a7a44bb55c3bcca17bbd';

const wallet = await WalletBuilder.buildFromSeed(
  'https://indexer.testnet-02.midnight.network/api/v1/graphql',
  'wss://indexer.testnet-02.midnight.network/api/v1/graphql/ws',
  'http://127.0.0.1:6300',
  'https://rpc.testnet-02.midnight.network',
  YOUR_SEED,
  getZswapNetworkId(),
  'info',
);
wallet.start();

const state = await Rx.firstValueFrom(wallet.state());
console.log('Your Midnight address:', state.address);
wallet.close();
process.exit(0);