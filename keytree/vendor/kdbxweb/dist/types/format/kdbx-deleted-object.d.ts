import { KdbxUuid } from './kdbx-uuid';
import { KdbxContext } from './kdbx-context';
export declare class KdbxDeletedObject {
    uuid: KdbxUuid | undefined;
    deletionTime: Date | undefined;
    private readNode;
    write(parentNode: Node, ctx: KdbxContext): void;
    static read(xmlNode: Node): KdbxDeletedObject;
}
