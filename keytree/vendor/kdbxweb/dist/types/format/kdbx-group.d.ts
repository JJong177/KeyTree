import { KdbxTimes } from './kdbx-times';
import { KdbxUuid } from './kdbx-uuid';
import { KdbxEntry } from './kdbx-entry';
import { KdbxCustomDataMap } from './kdbx-custom-data';
import { KdbxContext } from './kdbx-context';
import { MergeObjectMap } from './kdbx';
export declare class KdbxGroup {
    uuid: KdbxUuid;
    name: string | undefined;
    notes: string | undefined;
    icon: number | undefined;
    customIcon: KdbxUuid | undefined;
    tags: string[];
    times: KdbxTimes;
    expanded: boolean | undefined;
    defaultAutoTypeSeq: string | undefined;
    enableAutoType: boolean | null | undefined;
    enableSearching: boolean | null | undefined;
    lastTopVisibleEntry: KdbxUuid | undefined;
    groups: KdbxGroup[];
    entries: KdbxEntry[];
    parentGroup: KdbxGroup | undefined;
    previousParentGroup: KdbxUuid | undefined;
    customData: KdbxCustomDataMap | undefined;
    get lastModTime(): number;
    get locationChanged(): number;
    private readNode;
    write(parentNode: Node, ctx: KdbxContext): void;
    allGroups(): IterableIterator<KdbxGroup>;
    allEntries(): IterableIterator<KdbxEntry>;
    allGroupsAndEntries(): IterableIterator<KdbxGroup | KdbxEntry>;
    merge(objectMap: MergeObjectMap): void;
    /**
     * Merge object collection with remote collection
     * Implements 2P-set CRDT with tombstones stored in objectMap.deleted
     * Assumes tombstones are already merged
     */
    private mergeCollection;
    /**
     * Finds a best place to insert new item into collection
     */
    private static findInsertIx;
    copyFrom(group: KdbxGroup): void;
    static create(name: string, parentGroup?: KdbxGroup): KdbxGroup;
    static read(xmlNode: Node, ctx: KdbxContext, parentGroup?: KdbxGroup): KdbxGroup;
}
