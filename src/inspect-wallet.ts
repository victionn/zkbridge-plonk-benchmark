import { WalletBuilder } from '@midnight-ntwrk/wallet';
import { getZswapNetworkId, NetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as Rx from 'rxjs';
 
setNetworkId(NetworkId.Undeployed);
 
const wallet = await WalletBuilder.buildFromSeed(
  'http://127.0.0.1:8088/api/v1/graphql',
  'ws://127.0.0.1:8088/api/v1/graphql/ws',
  'http://127.0.0.1:6300',
  'http://127.0.0.1:9944',
  '0000000000000000000000000000000000000000000000000000000000000001',
  getZswapNetworkId(),
  'info',
);
wallet.start();
 
// Wait briefly for init
await new Promise(r => setTimeout(r, 2000));
 
// Print all methods on the wallet instance
const proto = Object.getPrototypeOf(wallet);
console.log('Wallet instance methods:');
console.log(Object.getOwnPropertyNames(proto));
 
// Also print top-level keys
console.log('\nWallet instance keys:');
console.log(Object.keys(wallet));
 
wallet.close();
process.exit(0);
 