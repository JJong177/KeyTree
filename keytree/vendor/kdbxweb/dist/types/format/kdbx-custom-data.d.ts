import { KdbxContext } from './kdbx-context';
export declare type KdbxCustomDataItem = {
    value: string | undefined;
    lastModified?: Date | undefined;
};
export declare type KdbxCustomDataMap = Map<string, KdbxCustomDataItem>;
export declare class KdbxCustomData {
    static read(node: Node): KdbxCustomDataMap;
    static write(parentNode: Node, ctx: KdbxContext, customData: KdbxCustomDataMap | undefined): void;
    private static readItem;
}
