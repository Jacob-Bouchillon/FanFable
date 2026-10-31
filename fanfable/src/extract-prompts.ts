/**
 * Shim: extraction prompts live at extract/extract-prompts.ts now.
 * This file keeps every existing importer working — new code imports
 * from './extract/extract-prompts.ts' directly.
 */
export * from './extract/extract-prompts.ts';
