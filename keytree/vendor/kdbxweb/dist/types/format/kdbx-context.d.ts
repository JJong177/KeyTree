import { Kdbx } from './kdbx';
export declare class KdbxContext {
    readonly kdbx: Kdbx;
    exportXml: boolean;
    constructor(opts: {
        kdbx: Kdbx;
        exportXml?: boolean;
    });
    setXmlDate(node: Node, dt: Date | undefined): void;
}
