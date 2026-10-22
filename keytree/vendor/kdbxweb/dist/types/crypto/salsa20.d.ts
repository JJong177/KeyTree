export declare class Salsa20 {
    private readonly _rounds;
    private readonly _sigmaWords;
    private readonly _keyWords;
    private readonly _nonceWords;
    private readonly _counterWords;
    private readonly _block;
    private _blockUsed;
    constructor(key: Uint8Array, nonce: Uint8Array);
    private setKey;
    private setNonce;
    getBytes(numberOfBytes: number): Uint8Array;
    getHexString(numberOfBytes: number): string;
    private reset;
    private incrementCounter;
    private generateBlock;
}
