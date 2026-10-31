/**
 * Continuity checker settings.
 *
 * The checker is useful, but it is not the author's job to read a wall of
 * warnings. These settings decide how much it does and what it says.
 */
import type { Project } from '../plan/controller.ts';

export interface ContinuitySettings {
  /** Run the checker at all. */
  enabled: boolean;
  /** Also run the model-assisted checks (they cost a model call per chapter). */
  modelChecks: boolean;
  /** Issues below this severity are not reported. */
  minSeverity: 'error' | 'warning' | 'note';
  /** Report an issue every time a chapter is written, not just on approval. */
  onDraft: boolean;
}

export const DEFAULT_CONTINUITY_SETTINGS: ContinuitySettings = {
  enabled: true,
  modelChecks: true,
  minSeverity: 'warning',
  onDraft: true,
};

const SEVERITY_ORDER: Record<ContinuitySettings['minSeverity'], number> = {
  error: 0,
  warning: 1,
  note: 2,
};

export function continuitySettings(project: Project): ContinuitySettings {
  const raw = (project.settings?.continuity ?? {}) as Partial<ContinuitySettings>;
  return {
    enabled: raw.enabled ?? DEFAULT_CONTINUITY_SETTINGS.enabled,
    modelChecks: raw.modelChecks ?? DEFAULT_CONTINUITY_SETTINGS.modelChecks,
    minSeverity: raw.minSeverity ?? DEFAULT_CONTINUITY_SETTINGS.minSeverity,
    onDraft: raw.onDraft ?? DEFAULT_CONTINUITY_SETTINGS.onDraft,
  };
}

/** Keep only issues at or above the configured severity. */
export function filterBySeverity<T extends { severity: string }>(
  issues: T[],
  settings: ContinuitySettings,
): T[] {
  const floor = SEVERITY_ORDER[settings.minSeverity] ?? 1;
  return issues.filter((i) => (SEVERITY_ORDER[(i.severity as ContinuitySettings['minSeverity'])] ?? 2) <= floor);
}
