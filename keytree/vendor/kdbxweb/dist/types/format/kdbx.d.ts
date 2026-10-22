import { KdbxBinaries, KdbxBinary, KdbxBinaryWithHash } from './kdbx-binaries';
import { KdbxDeletedObject } from './kdbx-deleted-object';
import { KdbxGroup } from './kdbx-group';
import { KdbxMeta, KdbxMetaEditState } from './kdbx-meta';
import { KdbxCredentials } from './kdbx-credentials';
import { KdbxHeader } from './kdbx-header';
import { KdbxEntry, KdbxEntryEditState } from './kdbx-entry';
import { KdbxUuid } from './kdbx-uuid';
import { KdbxContext } from './kdbx-context';
export interface KdbxEditState {
    entries?: {
        [name: string]: KdbxEntryEditState;
    };
    meta?: KdbxMetaEditState;
}
export interface MergeObjectMap {
    entries: Map<string, KdbxEntry>;
    groups: Map<string, KdbxGroup>;
    remoteEntries: Map<string, KdbxEntry>;
    remoteGroups: Map<string, KdbxGroup>;
    deleted: Map<string, Date>;
}
export declare class Kdbx {
    header: KdbxHeader;
    credentials: KdbxCredentials;
    meta: KdbxMeta;
    xml: Document | undefined;
    binaries: KdbxBinaries;
    groups: KdbxGroup[];
    deletedObjects: KdbxDeletedObject[];
    get versionMajor(): number;
    get versionMinor(): number;
    /**
     * Creates a new database
     */
    static create(credentials: KdbxCredentials, name: string): Kdbx;
    /**
     * Load a kdbx file
     * If there was an error loading file, throws an exception
     */
    static load(data: ArrayBuffer, credentials: KdbxCredentials, options?: {
        preserveXml?: boolean;
    }): Promise<Kdbx>;
    /**
     * Import database from an xml file
     * If there was an error loading file, throws an exception
     */
    static loadXml(data: string, credentials: KdbxCredentials): Promise<Kdbx>;
    /**
     * Save the db to ArrayBuffer
     */
    save(): Promise<ArrayBuffer>;
    /**
     * Save the db as XML string
     */
    saveXml(prettyPrint?: boolean): Promise<string>;
    /**
     * Creates a default group, if it's not yet created
     */
    createDefaultGroup(): void;
    /**
     * Creates a recycle bin group, if it's not yet created
     */
    createRecycleBin(): void;
    /**
     * Adds a new group to an existing group
     */
    createGroup(group: KdbxGroup, name: string): KdbxGroup;
    /**
     * Adds a new entry to a group
     */
    createEntry(group: KdbxGroup): KdbxEntry;
    /**
     * Gets the default group
     */
    getDefaultGroup(): KdbxGroup;
    /**
     * Get a group by uuid, returns undefined if it's not found
     */
    getGroup(uuid: KdbxUuid | string, parentGroup?: KdbxGroup): KdbxGroup | undefined;
    /**
     * Move an object from one group to another
     * @param object - object to be moved
     * @param toGroup - target parent group
     * @param atIndex - index in target group (by default, insert to the end of the group)
     */
    move<T extends KdbxEntry | KdbxGroup>(object: T, toGroup: KdbxGroup | undefined | null, atIndex?: number): void;
    /**
     * Adds a so-called deleted object, this is used to keep track of objects during merging
     * @param uuid - object uuid
     * @param dt - deletion date
     */
    addDeletedObject(uuid: KdbxUuid, dt: Date): void;
    /**
     * Delete an entry or a group
     * Depending on settings, removes either to trash, or completely
     */
    remove<T extends KdbxEntry | KdbxGroup>(object: T): void;
    /**
     * Creates a binary in the db and returns an object that can be put to entry.binaries
     */
    createBinary(value: KdbxBinary): Promise<KdbxBinaryWithHash>;
    /**
     * Import an entry from another file
     * It's up to caller to decide what should happen to the original entry in the source file
     * Returns the new entry
     * @param entry - entry to be imported
     * @param group - target parent group
     * @param file - the source file containing the group
     */
    importEntry(entry: KdbxEntry, group: KdbxGroup, file: Kdbx): KdbxEntry;
    /**
     * Perform database cleanup
     * @param settings.historyRules - remove extra history, it it doesn't match defined rules, e.g. records number
     * @param settings.customIcons - remove unused custom icons
     * @param settings.binaries - remove unused binaries
     */
    cleanup(settings?: {
        historyRules?: boolean;
        customIcons?: boolean;
        binaries?: boolean;
    }): void;
    /**
     * Merge the db with another db
     * Some parts of the remote DB are copied by reference, so it should NOT be modified after merge
     * Suggested use case:
     * - open the local db
     * - get a remote db somehow and open in
     * - merge the remote db into the local db: local.merge(remote)
     * - close the remote db
     * @param remote - database to merge in
     */
    merge(remote: Kdbx): void;
    /**
     * Gets editing state tombstones (for successful merge)
     * The replica must save this state with the db, assign in on opening the db,
     * and call removeLocalEditState on successful upstream push.
     * This state is JSON serializable.
     */
    getLocalEditState(): KdbxEditState;
    /**
     * Sets editing state tombstones returned previously by getLocalEditState
     * The replica must call this method on opening the db to the state returned previously on getLocalEditState.
     * @param editingState - result of getLocalEditState invoked before on saving the db
     */
    setLocalEditState(editingState: KdbxEditState): void;
    /**
     * Removes editing state tombstones
     * Immediately after successful upstream push the replica must:
     * - call this method
     * - discard any previous state obtained by getLocalEditState call before
     */
    removeLocalEditState(): void;
    /**
     * Upgrade the file to latest version
     */
    upgrade(): void;
    /**
     * Set the file version to a specified number
     */
    setVersion(version: 3 | 4): void;
    /**
     * Set file key derivation function
     * @param kdf - KDF id, from KdfId
     */
    setKdf(kdf: string): void;
    private getObjectMap;
    loadFromXml(ctx: KdbxContext): Promise<Kdbx>;
    private parseMeta;
    private parseRoot;
    private readDeletedObjects;
    private readGroup;
    buildXml(ctx: KdbxContext): void;
    versionIsAtLeast(major: number, minor: number): boolean;
}
