declare class KdbxError extends Error {
    readonly code: string;
    constructor(code: string, message?: string);
}
export { KdbxError };
