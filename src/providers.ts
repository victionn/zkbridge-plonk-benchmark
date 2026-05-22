import { type CoinInfo, Transaction, type TransactionId } from '@midnight-ntwrk/ledger';
import {
  type BalancedTransaction,
  createBalancedTx,
  type MidnightProvider,
  type UnbalancedTransaction,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { getLedgerNetworkId, getZswapNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { Transaction as ZswapTransaction } from '@midnight-ntwrk/zswap';
import { type Wallet } from '@midnight-ntwrk/wallet-api';
import * as Rx from 'rxjs';
import { type Logger } from 'pino';

// Shared mutable slot — api.ts writes into these before each callTx,
// and the provider callbacks fill in the timing field when done.
export type ProofSlot = {
  circuitProofMs: number;
  walletProofMs: number;
};

export const pendingSlot: ProofSlot = {
  circuitProofMs: 0,
  walletProofMs: 0,
};

// ---------------------------------------------------------------------------
// Timed proof provider
// Wraps the httpClientProofProvider using a Proxy so we don't need to know
// the exact method signature of ProofProvider<T>.
//
// Every async method call on the inner provider is intercepted:
//   start = performance.now()
//   await inner.someMethod(...)
//   pendingSlot.circuitProofMs = performance.now() - start
//
// In practice the proof provider only has one relevant method (proofData),
// but the Proxy catches it generically without depending on the name.
// ---------------------------------------------------------------------------
export function createTimedProofProvider<T extends object>(inner: T, logger: Logger): T {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      return async function (...args: unknown[]) {
        logger.info(`[BENCH] proof-server call starting (method=${String(prop)})`);
        const start = performance.now();

        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);

        const ms = performance.now() - start;
        pendingSlot.circuitProofMs = ms;
        logger.info(`[BENCH] proof-server call done: ${ms.toFixed(1)} ms`);

        return result;
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Timed wallet + midnight provider
// Intercepts wallet.proveTransaction() to record Zswap proof time.
// ---------------------------------------------------------------------------
export const createTimedWalletAndMidnightProvider = async (
  wallet: Wallet,
  logger: Logger,
): Promise<WalletProvider & MidnightProvider> => {
  const state = await Rx.firstValueFrom(wallet.state());

  return {
    coinPublicKey: state.coinPublicKey,
    encryptionPublicKey: state.encryptionPublicKey,

    balanceTx(tx: UnbalancedTransaction, newCoins: CoinInfo[]): Promise<BalancedTransaction> {
      return wallet
        .balanceTransaction(
          ZswapTransaction.deserialize(tx.serialize(getLedgerNetworkId()), getZswapNetworkId()),
          newCoins,
        )
        .then(async (balanced) => {
          const start = performance.now();
          const proved = await wallet.proveTransaction(balanced);
          const ms = performance.now() - start;

          pendingSlot.walletProofMs = ms;
          logger.info(`[BENCH] wallet.proveTransaction done: ${ms.toFixed(1)} ms`);

          return proved;
        })
        .then((zswapTx) =>
          Transaction.deserialize(zswapTx.serialize(getZswapNetworkId()), getLedgerNetworkId()),
        )
        .then(createBalancedTx);
    },

    submitTx(tx: BalancedTransaction): Promise<TransactionId> {
      return wallet.submitTransaction(tx);
    },
  };
};
