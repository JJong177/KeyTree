import { Salsa20 } from './salsa20';
import { ChaCha20 } from './chacha20';
/**
 * Protect information used for decrypt and encrypt protected data fields
 * @constructor
 */
export declare class ProtectSaltGenerator {
    private _algo;
    constructor(algo: Salsa20 | ChaCha20);
    getSalt(len: number): ArrayBuffer;
    static create(key: ArrayBuffer | Uint8Array, crsAlgorithm: number): Promise<ProtectSaltGenerator>;
}
