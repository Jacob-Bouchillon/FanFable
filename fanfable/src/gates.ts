/**
 * Shim: the gates module lives at gates/gates.ts now.
 * This file keeps every existing importer working — new code imports
 * from './gates/gates.ts' directly.
 */
export * from './gates/gates.ts';
