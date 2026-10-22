import { Int64 } from './int64';
import { BinaryStream } from './binary-stream';
export declare enum ValueType {
    UInt32 = 4,
    UInt64 = 5,
    Bool = 8,
    Int32 = 12,
    Int64 = 13,
    String = 24,
    Bytes = 66
}
export declare type VarDictionaryAnyValue = number | Int64 | boolean | string | ArrayBuffer | undefined;
export declare class VarDictionary {
    private _items;
    private readonly _map;
    static readonly ValueType: typeof ValueType;
    keys(): string[];
    get length(): number;
    get(key: string): VarDictionaryAnyValue;
    set(key: string, type: ValueType, value: VarDictionaryAnyValue): void;
    remove(key: string): void;
    static read(stm: BinaryStream): VarDictionary;
    private readVersion;
    private readItem;
    write(stm: BinaryStream): void;
    private writeVersion;
    private writeItem;
}
