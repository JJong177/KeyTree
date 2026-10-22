export declare class ChaCha20 {
    private readonly _sigmaWords;
    private readonly _block;
    private _blockUsed;
    private readonly _x;
    private readonly _input;
    constructor(key: Uint8Array, nonce: Uint8Array);
    getBytes(numberOfBytes: number): Uint8Array;
    private generateBlock;
    encrypt(data: Uint8Array): Uint8Array;
}
