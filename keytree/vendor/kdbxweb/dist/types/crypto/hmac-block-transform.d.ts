import { Int64 } from '../utils/int64';
export declare function getHmacKey(key: ArrayBuffer, blockIndex: Int64): Promise<ArrayBuffer>;
export declare function decrypt(data: ArrayBuffer, key: ArrayBuffer): Promise<ArrayBuffer>;
export declare function encrypt(data: ArrayBuffer, key: ArrayBuffer): Promise<ArrayBuffer>;
