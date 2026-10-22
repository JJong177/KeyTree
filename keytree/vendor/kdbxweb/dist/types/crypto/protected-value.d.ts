export declare class ProtectedValue {
    readonly value: Uint8Array;
    readonly salt: Uint8Array;
    constructor(value: ArrayBuffer, salt: ArrayBuffer);
    toString(): string;
    static fromString(str: string): ProtectedValue;
    toBase64(): string;
    static fromBase64(base64: string): ProtectedValue;
    /**
     * Keep in mind that you're passing the ownership of this array, the contents will be destroyed
     */
    static fromBinary(binary: ArrayBuffer): ProtectedValue;
    includes(str: string): boolean;
    getHash(): Promise<ArrayBuffer>;
    getText(): string;
    getBinary(): Uint8Array;
    setSalt(newSalt: ArrayBuffer): void;
    clone(): ProtectedValue;
    get byteLength(): number;
}
