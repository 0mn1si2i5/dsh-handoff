import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs';
export declare const HANDOFF_PATH: "docs/handoffs/current.md";
export declare function resolveHandoffTarget(fs: FileSystem, root: string, signal: AbortSignal): Promise<FsTarget>;
export declare function readHandoffText(fs: FileSystem, root: string, maxBytes: number, signal: AbortSignal): Promise<{
    text: string;
    version: FsVersion;
}>;
export declare function writeHandoffText(fs: FileSystem, root: string, text: string, signal: AbortSignal): Promise<void>;
