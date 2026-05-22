import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger, Maybe } from '../managed/counter/contract/index.cjs';

export type CounterPrivateState = {
  operatorSecretKey?: Uint8Array;
  assetOwnerSecretKey?: Uint8Array;
};

export const witnesses = {
  operatorSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, CounterPrivateState>): [CounterPrivateState, Maybe<Uint8Array>] => [
    privateState,
    {
      is_some: true,
      value: privateState.operatorSecretKey ?? new Uint8Array(),
    },
  ],

  assetOwnerSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, CounterPrivateState>): [CounterPrivateState, Maybe<Uint8Array>] => [
    privateState,
    {
      is_some: true,
      value: privateState.assetOwnerSecretKey ?? new Uint8Array(),
    },
  ],
};
