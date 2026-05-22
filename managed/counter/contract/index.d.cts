import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Maybe<a> = { is_some: boolean; value: a };

export type Witnesses<T> = {
  operatorSecretKey(context: __compactRuntime.WitnessContext<Ledger, T>): [T, Maybe<Uint8Array>];
  assetOwnerSecretKey(context: __compactRuntime.WitnessContext<Ledger, T>): [T, Maybe<Uint8Array>];
}

export type ImpureCircuits<T> = {
  proveOwnership(context: __compactRuntime.CircuitContext<T>): __compactRuntime.CircuitResults<T, boolean>;
  burnAsset(context: __compactRuntime.CircuitContext<T>): __compactRuntime.CircuitResults<T, []>;
  transferAsset(context: __compactRuntime.CircuitContext<T>,
                newOwner_0: Uint8Array): __compactRuntime.CircuitResults<T, []>;
}

export type PureCircuits = {
}

export type Circuits<T> = {
  proveOwnership(context: __compactRuntime.CircuitContext<T>): __compactRuntime.CircuitResults<T, boolean>;
  burnAsset(context: __compactRuntime.CircuitContext<T>): __compactRuntime.CircuitResults<T, []>;
  transferAsset(context: __compactRuntime.CircuitContext<T>,
                newOwner_0: Uint8Array): __compactRuntime.CircuitResults<T, []>;
}

export type Ledger = {
  readonly policyID: Uint8Array;
  readonly assetID: Uint8Array;
  readonly assetName: string;
  readonly assetAmount: bigint;
  readonly assetExpired: boolean;
  metadata: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  readonly operator: Uint8Array;
  readonly assetOwner: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<T, W extends Witnesses<T> = Witnesses<T>> {
  witnesses: W;
  circuits: Circuits<T>;
  impureCircuits: ImpureCircuits<T>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<T>,
               policy_0: Uint8Array,
               asset_0: Uint8Array,
               name_0: string,
               amount_0: bigint,
               owner_0: Uint8Array): __compactRuntime.ConstructorResult<T>;
}

export declare function ledger(state: __compactRuntime.StateValue): Ledger;
export declare const pureCircuits: PureCircuits;
