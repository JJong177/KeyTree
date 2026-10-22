import { KdbxUuid } from '../format/kdbx-uuid';
import { ProtectedValue } from '../crypto/protected-value';
import { ProtectSaltGenerator } from '../crypto/protect-salt-generator';
import { KdbxBinaryOrRef } from '../format/kdbx-binaries';
declare global {
    interface Node {
        protectedValue: ProtectedValue | undefined;
        lineNumber: number | undefined;
    }
}
export declare function parse(xml: string): Document;
export declare function serialize(doc: Document, prettyPrint?: boolean): string;
export declare function create(rootNode: string): Document;
export declare function getChildNode(node: Node | null, tagName: string): Node | null;
export declare function getChildNode(node: Node | null, tagName: string, errorMsgIfAbsent: string): Node;
export declare function addChildNode(node: Node, tagName: string): Element;
export declare function getText(node: Node | null): string | undefined;
export declare function setText(node: Node, text: string | undefined): void;
export declare function getTags(node: Node): string[];
export declare function setTags(node: Node, tags: string[]): void;
export declare function getBytes(node: Node): ArrayBuffer | undefined;
export declare function setBytes(node: Node, bytes: ArrayBuffer | Uint8Array | string | undefined): void;
export declare function getDate(node: Node): Date | undefined;
export declare function setDate(node: Node, date: Date | undefined, binary?: boolean): void;
export declare function getNumber(node: Node): number | undefined;
export declare function setNumber(node: Node, number: number | undefined): void;
export declare function getBoolean(node: Node): boolean | null | undefined;
export declare function setBoolean(node: Node, boolean: boolean | null | undefined): void;
export declare function strToBoolean(str: string | null | undefined): boolean | null | undefined;
export declare function getUuid(node: Node): KdbxUuid | undefined;
export declare function setUuid(node: Node, uuid: KdbxUuid | ArrayBuffer | Uint8Array | string | undefined): void;
export declare function getProtectedText(node: Node): ProtectedValue | string | undefined;
export declare function setProtectedText(node: Node, text: ProtectedValue | string): void;
export declare function getProtectedBinary(node: Node): KdbxBinaryOrRef | undefined;
export declare function setProtectedBinary(node: Node, binary: KdbxBinaryOrRef): void;
export declare function traverse(node: Node, callback: (node: Element) => void): void;
export declare function setProtectedValues(node: Node, protectSaltGenerator: ProtectSaltGenerator): void;
export declare function updateProtectedValuesSalt(node: Node, protectSaltGenerator: ProtectSaltGenerator): void;
export declare function unprotectValues(node: Node): void;
export declare function protectUnprotectedValues(node: Node): void;
export declare function protectPlainValues(node: Node): void;
