import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

export const currentDir = path.resolve(fileURLToPath(import.meta.url), '..');

// Path to the managed ZK key files (proving key, verification key, circuit info)
export const zkConfigPath = path.resolve(currentDir, '..', 'managed', 'counter');

export const privateStateStoreName = 'zk-bench-private-state';

export interface Config {
  readonly logDir: string;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
}

/**
 * Midnight testnet-02 (public remote endpoints).
 * Proof server still runs locally on :6300.
 */
export class TestnetRemoteConfig implements Config {
  logDir = path.resolve(currentDir, '..', 'logs', `${new Date().toISOString()}.log`);
  indexer = 'https://indexer.testnet-02.midnight.network/api/v1/graphql';
  indexerWS = 'wss://indexer.testnet-02.midnight.network/api/v1/graphql/ws';
  node = 'https://rpc.testnet-02.midnight.network';
  proofServer = 'http://127.0.0.1:6300';
  constructor() {
    setNetworkId(NetworkId.TestNet);
  }
}

/**
 * Fully local standalone mode — all services via Docker on localhost.
 */
export class StandaloneConfig implements Config {
  logDir = path.resolve(currentDir, '..', 'logs', `${new Date().toISOString()}.log`);
  indexer = 'http://127.0.0.1:8088/api/v1/graphql';
  indexerWS = 'ws://127.0.0.1:8088/api/v1/graphql/ws';
  node = 'http://127.0.0.1:9944';
  proofServer = 'http://127.0.0.1:6300';
  constructor() {
    setNetworkId(NetworkId.Undeployed);
  }
}

/** Pick config based on BENCH_ENV env var (default: testnet-remote) */
export function resolveConfig(): Config {
  const env = process.env.BENCH_ENV ?? 'testnet-remote';
  if (env === 'standalone') return new StandaloneConfig();
  return new TestnetRemoteConfig();
}
