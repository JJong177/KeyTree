export declare class KdbxUuid {
    readonly id: string;
    readonly empty: boolean;
    constructor(ab?: ArrayBuffer | string);
    equals(other: KdbxUuid | string | null | undefined): boolean;
    get bytes(): ArrayBuffer;
    static random(): KdbxUuid;
    toString(): string;
    valueOf(): string;
    toBytes(): ArrayBuffer;
}
