declare class Int64 {
    readonly lo: number;
    readonly hi: number;
    constructor(lo?: number, hi?: number);
    get value(): number;
    valueOf(): number;
    static from(value: number): Int64;
}
export { Int64 };
