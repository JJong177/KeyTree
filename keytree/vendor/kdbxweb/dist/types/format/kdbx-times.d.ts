import { KdbxContext } from './kdbx-context';
export declare class KdbxTimes {
    creationTime: Date | undefined;
    lastModTime: Date | undefined;
    lastAccessTime: Date | undefined;
    expiryTime: Date | undefined;
    expires: boolean | null | undefined;
    usageCount: number | undefined;
    locationChanged: Date | undefined;
    private readNode;
    clone(): KdbxTimes;
    update(): void;
    write(parentNode: Element, ctx: KdbxContext): void;
    static create(): KdbxTimes;
    static read(xmlNode: Node): KdbxTimes;
}
