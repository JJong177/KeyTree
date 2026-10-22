import { KdbxUuid } from './kdbx-uuid';
import { KdbxCustomDataMap } from './kdbx-custom-data';
import { KdbxContext } from './kdbx-context';
import { MergeObjectMap } from './kdbx';
export interface KdbxMetaEditState {
    mntncHistoryDaysChanged?: Date;
    colorChanged?: Date;
    keyChangeRecChanged?: Date;
    keyChangeForceChanged?: Date;
    historyMaxItemsChanged?: Date;
    historyMaxSizeChanged?: Date;
    lastSelectedGroupChanged?: Date;
    lastTopVisibleGroupChanged?: Date;
    memoryProtectionChanged?: Date;
}
export interface KdbxMemoryProtection {
    title?: boolean;
    userName?: boolean;
    password?: boolean;
    url?: boolean;
    notes?: boolean;
}
export interface KdbxCustomIcon {
    data: ArrayBuffer;
    name?: string;
    lastModified?: Date;
}
export declare class KdbxMeta {
    generator: string | undefined;
    headerHash: ArrayBuffer | undefined;
    settingsChanged: Date | undefined;
    _name: string | undefined;
    nameChanged: Date | undefined;
    _desc: string | undefined;
    descChanged: Date | undefined;
    _defaultUser: string | undefined;
    defaultUserChanged: Date | undefined;
    _mntncHistoryDays: number | undefined;
    _color: string | undefined;
    keyChanged: Date | undefined;
    _keyChangeRec: number | undefined;
    _keyChangeForce: number | undefined;
    _recycleBinEnabled: boolean | undefined;
    _recycleBinUuid: KdbxUuid | undefined;
    recycleBinChanged: Date | undefined;
    _entryTemplatesGroup: KdbxUuid | undefined;
    entryTemplatesGroupChanged: Date | undefined;
    _historyMaxItems: number | undefined;
    _historyMaxSize: number | undefined;
    _lastSelectedGroup: KdbxUuid | undefined;
    _lastTopVisibleGroup: KdbxUuid | undefined;
    _memoryProtection: KdbxMemoryProtection;
    customData: KdbxCustomDataMap;
    customIcons: Map<string, KdbxCustomIcon>;
    _editState: KdbxMetaEditState | undefined;
    get editState(): KdbxMetaEditState | undefined;
    set editState(value: KdbxMetaEditState | undefined);
    private getOrCreateEditState;
    get name(): string | undefined;
    set name(value: string | undefined);
    get desc(): string | undefined;
    set desc(value: string | undefined);
    get defaultUser(): string | undefined;
    set defaultUser(value: string | undefined);
    get mntncHistoryDays(): number | undefined;
    set mntncHistoryDays(value: number | undefined);
    get color(): string | undefined;
    set color(value: string | undefined);
    get keyChangeRec(): number | undefined;
    set keyChangeRec(value: number | undefined);
    get keyChangeForce(): number | undefined;
    set keyChangeForce(value: number | undefined);
    get recycleBinEnabled(): boolean | undefined;
    set recycleBinEnabled(value: boolean | undefined);
    get recycleBinUuid(): KdbxUuid | undefined;
    set recycleBinUuid(value: KdbxUuid | undefined);
    get entryTemplatesGroup(): KdbxUuid | undefined;
    set entryTemplatesGroup(value: KdbxUuid | undefined);
    get historyMaxItems(): number | undefined;
    set historyMaxItems(value: number | undefined);
    get historyMaxSize(): number | undefined;
    set historyMaxSize(value: number | undefined);
    get lastSelectedGroup(): KdbxUuid | undefined;
    set lastSelectedGroup(value: KdbxUuid | undefined);
    get lastTopVisibleGroup(): KdbxUuid | undefined;
    set lastTopVisibleGroup(value: KdbxUuid | undefined);
    get memoryProtection(): KdbxMemoryProtection;
    set memoryProtection(value: KdbxMemoryProtection);
    private readNode;
    private readMemoryProtection;
    private writeMemoryProtection;
    private readCustomIcons;
    private readCustomIcon;
    private writeCustomIcons;
    private readBinaries;
    private readBinary;
    private writeBinaries;
    private readCustomData;
    private writeCustomData;
    write(parentNode: Node, ctx: KdbxContext): void;
    merge(remote: KdbxMeta, objectMap: MergeObjectMap): void;
    private mergeMapWithDates;
    needUpdate(remoteDate: Date | undefined, localDate: Date | undefined): boolean;
    /**
     * Creates new meta
     * @returns {KdbxMeta}
     */
    static create(): KdbxMeta;
    static read(xmlNode: Node, ctx: KdbxContext): KdbxMeta;
}
