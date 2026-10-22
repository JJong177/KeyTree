import { ProtectedValue } from '../crypto/protected-value';
export declare type KdbxBinaryRef = {
    ref: string;
};
export declare type KdbxBinaryRefWithValue = {
    ref: string;
    value: KdbxBinary;
};
export declare type KdbxBinaryWithHash = {
    hash: string;
    value: KdbxBinary;
};
export declare type KdbxBinary = ProtectedValue | ArrayBuffer;
export declare type KdbxBinaryOrRef = KdbxBinary | KdbxBinaryRef;
export declare type KdbxBinaryIn = KdbxBinary | Uint8Array;
export declare class KdbxBinaries {
    private readonly _mapById;
    private readonly _mapByHash;
    private readonly _idToHash;
    computeHashes(): Promise<void>;
    private static getBinaryHash;
    add(value: KdbxBinaryIn): Promise<KdbxBinaryWithHash>;
    addWithNextId(value: KdbxBinaryIn): void;
    addWithId(id: string, value: KdbxBinaryIn): void;
    addWithHash(binary: KdbxBinaryWithHash): void;
    deleteWithHash(hash: string): void;
    getByRef(binaryRef: KdbxBinaryRef): KdbxBinaryWithHash | undefined;
    getRefByHash(hash: string): KdbxBinaryRef | undefined;
    getAll(): KdbxBinaryRefWithValue[];
    getAllWithHashes(): KdbxBinaryWithHash[];
    getValueByHash(hash: string): KdbxBinary | undefined;
    static isKdbxBinaryRef(binary: KdbxBinaryOrRef | undefined): binary is KdbxBinaryRef;
    static isKdbxBinaryWithHash(binary: KdbxBinaryOrRef | KdbxBinaryWithHash | undefined): binary is KdbxBinaryWithHash;
}
