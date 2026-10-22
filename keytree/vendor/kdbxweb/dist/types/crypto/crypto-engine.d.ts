export declare function sha256(data: ArrayBuffer): Promise<ArrayBuffer>;
export declare function sha512(data: ArrayBuffer): Promise<ArrayBuffer>;
export declare function hmacSha256(key: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer>;
export declare abstract class AesCbc {
    abstract importKey(key: ArrayBuffer): Promise<void>;
    abstract encrypt(data: ArrayBuffer, iv: ArrayBuffer): Promise<ArrayBuffer>;
    abstract decrypt(data: ArrayBuffer, iv: ArrayBuffer): Promise<ArrayBuffer>;
}
export declare function createAesCbc(): AesCbc;
export declare function random(len: number): Uint8Array;
export declare function chacha20(data: ArrayBuffer, key: ArrayBuffer, iv: ArrayBuffer): Promise<ArrayBuffer>;
export declare const Argon2TypeArgon2d = 0;
export declare const Argon2TypeArgon2id = 2;
export declare type Argon2Type = typeof Argon2TypeArgon2d | typeof Argon2TypeArgon2id;
export declare type Argon2Version = 0x10 | 0x13;
export declare type Argon2Fn = (password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: Argon2Type, version: Argon2Version) => Promise<ArrayBuffer>;
export declare function argon2(password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: Argon2Type, version: Argon2Version): Promise<ArrayBuffer>;
export declare function setArgon2Impl(impl: Argon2Fn): void;
