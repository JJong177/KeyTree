import { KdbxTimes } from './kdbx-times';
import { ProtectedValue } from '../crypto/protected-value';
import { KdbxCustomDataMap } from './kdbx-custom-data';
import { KdbxUuid } from './kdbx-uuid';
import { KdbxContext } from './kdbx-context';
import { KdbxBinary, KdbxBinaryWithHash } from './kdbx-binaries';
import { KdbxMeta } from './kdbx-meta';
import { KdbxGroup } from './kdbx-group';
import { MergeObjectMap } from './kdbx';
export declare type KdbxEntryField = string | ProtectedValue;
export interface KdbxAutoTypeItem {
    window: string;
    keystrokeSequence: string;
}
export interface KdbxEntryAutoType {
    enabled: boolean;
    obfuscation: number;
    defaultSequence?: string;
    items: KdbxAutoTypeItem[];
}
export interface KdbxEntryEditState {
    added: number[];
    deleted: number[];
}
export declare class KdbxEntry {
    uuid: KdbxUuid;
    icon: number | undefined;
    customIcon: KdbxUuid | undefined;
    fgColor: string | undefined;
    bgColor: string | undefined;
    overrideUrl: string | undefined;
    tags: string[];
    times: KdbxTimes;
    fields: Map<string, KdbxEntryField>;
    binaries: Map<string, KdbxBinary | KdbxBinaryWithHash>;
    autoType: KdbxEntryAutoType;
    history: KdbxEntry[];
    parentGroup: KdbxGroup | undefined;
    previousParentGroup: KdbxUuid | undefined;
    customData: KdbxCustomDataMap | undefined;
    qualityCheck: boolean | undefined;
    _editState: KdbxEntryEditState | undefined;
    get lastModTime(): number;
    get locationChanged(): number;
    private readNode;
    private readField;
    private writeFields;
    private readBinary;
    private writeBinaries;
    private readAutoType;
    private readAutoTypeItem;
    private writeAutoType;
    private readHistory;
    private writeHistory;
    private readCustomData;
    private writeCustomData;
    private setField;
    private addHistoryTombstone;
    write(parentNode: Element, ctx: KdbxContext): void;
    pushHistory(): void;
    removeHistory(index: number, count?: number): void;
    copyFrom(entry: KdbxEntry): void;
    merge(objectMap: MergeObjectMap): void;
    /**
     * Merge entry history with remote entry history
     * Tombstones are stored locally and must be immediately discarded by replica after successful upstream push.
     * It's client responsibility, to save and load tombstones for local replica, and to clear them after successful upstream push.
     *
     * Implements remove-win OR-set CRDT with local tombstones stored in _editState.
     *
     * Format doesn't allow saving tombstones for history entries, so they are stored locally.
     * Any unmodified state from past or modifications of current state synced with central upstream will be successfully merged.
     * Assumes there's only one central upstream, may produce inconsistencies while merging outdated replica outside main upstream.
     * Phantom entries and phantom deletions will appear if remote replica checked out an old state and has just added a new state.
     * If a client is using central upstream for sync, the remote replica must first sync it state and
     * only after it update the upstream, so this should never happen.
     *
     * References:
     *
     * An Optimized Conflict-free Replicated Set arXiv:1210.3368 [cs.DC]
     * http://arxiv.org/abs/1210.3368
     *
     * Gene T. J. Wuu and Arthur J. Bernstein. Efficient solutions to the replicated log and dictionary
     * problems. In Symp. on Principles of Dist. Comp. (PODC), pages 233–242, Vancouver, BC, Canada, August 1984.
     * https://pages.lip6.fr/Marc.Shapiro/papers/RR-7687.pdf
     */
    private mergeHistory;
    static create(meta: KdbxMeta, parentGroup: KdbxGroup): KdbxEntry;
    static read(xmlNode: Node, ctx: KdbxContext, parentGroup?: KdbxGroup): KdbxEntry;
}
