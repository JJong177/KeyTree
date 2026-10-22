import { ProtectedValue } from '../crypto/protected-value';
export declare type KdbxChallengeResponseFn = (challenge: ArrayBuffer) => Promise<ArrayBuffer | Uint8Array>;
export declare class KdbxCredentials {
    readonly ready: Promise<KdbxCredentials>;
    passwordHash: ProtectedValue | undefined;
    keyFileHash: ProtectedValue | undefined;
    private _challengeResponse;
    constructor(password: ProtectedValue | null, keyFile?: ArrayBuffer | Uint8Array | null, challengeResponse?: KdbxChallengeResponseFn);
    setPassword(password: ProtectedValue | null): Promise<void>;
    setKeyFile(keyFile: ArrayBuffer | Uint8Array | null | undefined): Promise<void>;
    private setChallengeResponse;
    getHash(challenge?: ArrayBuffer): Promise<ArrayBuffer>;
    getChallengeResponse(challenge?: ArrayBuffer): Promise<ArrayBuffer | Uint8Array | null>;
    static createRandomKeyFile(version?: number): Promise<Uint8Array>;
    static createKeyFileWithHash(keyBytes: ArrayBuffer, version?: number): Promise<Uint8Array>;
}
