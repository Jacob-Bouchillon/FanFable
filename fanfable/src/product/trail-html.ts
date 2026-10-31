/**
 * Answer-trails HTML renderer.
 *
 * Self-contained inline-SVG page plus the same trails as a text list. No
 * network, no dependencies; used by the CLI and tests.
 */
import type { PassageTrail } from '../support/graph.ts';

export function escapeHtml(text: string): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One trail as text: `A --sibling of--> B --mentions_in--> passage`. Empty steps mean found by words. */
export function trailText(trail: PassageTrail): string {
  if (!trail.steps.length) return '(found by words)';
  return trail.steps.map((s, i) => (i === 0 ? s.node : `--${s.via ?? '?'}--> ${s.node}`)).join(' ');
}

function trailKindGroup(kind: string): 'entity' | 'event' | 'passage' | 'other' {
  if (kind === 'canon-entity' || kind === 'character') return 'entity';
  if (kind === 'canon-event' || kind === 'au-event' || kind === 'canon-timeline') return 'event';
  if (kind === 'canon-passage') return 'passage';
  return 'other';
}

const TRAIL_COLORS: Record<'entity' | 'event' | 'passage' | 'other', { fill: string; stroke: string; ink: string }> = {
  entity: { fill: '#dbeafe', stroke: '#1e40af', ink: '#1e3a8a' },
  event: { fill: '#dcfce7', stroke: '#166534', ink: '#14532d' },
  passage: { fill: '#fef3c7', stroke: '#92400e', ink: '#78350f' },
  other: { fill: '#f3f4f6', stroke: '#4b5563', ink: '#374151' },
};

function shortLabel(text: string, max = 22): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One self-contained picture page for answer trails: an inline-SVG diagram
 * (one row per passage, columns left-to-right by trail depth) plus the same
 * trails as a text list for screen readers. No network, no dependencies.
 */
export function buildTrailsHtml(query: string, trails: PassageTrail[]): string {
  const rowH = 132;
  const topPad = 76;
  const nodeW = 184;
  const nodeH = 62;
  const colW = 218;
  const leftPad = 28;
  const maxDepth = Math.max(1, ...trails.map((t) => t.steps.length));
  const width = leftPad + maxDepth * colW + nodeW + 60;
  const height = topPad + trails.length * rowH + 34;

  let svg = '';
  svg += `<text x="${leftPad}" y="30" font-size="17" font-weight="bold" fill="#111">Answer trails for &quot;${escapeHtml(query)}&quot;</text>`;
  const legend: ['entity' | 'event' | 'passage' | 'other', string][] = [
    ['entity', 'entity'],
    ['event', 'event'],
    ['passage', 'passage'],
    ['other', 'other'],
  ];
  legend.forEach(([group, label], i) => {
    const x = leftPad + i * 130;
    svg += `<circle cx="${x}" cy="52" r="6" fill="${TRAIL_COLORS[group].fill}" stroke="${TRAIL_COLORS[group].stroke}" stroke-width="2"/>`;
    svg += `<text x="${x + 11}" y="56" font-size="12" fill="#374151">${label}</text>`;
  });

  trails.forEach((trail, row) => {
    const y = topPad + row * rowH;
    svg += `<text x="${leftPad}" y="${y - 8}" font-size="12" fill="#6b7280">passage ${row + 1}</text>`;
    if (!trail.steps.length) {
      svg += `<text x="${leftPad}" y="${y + 30}" font-size="13" fill="#6b7280">found by words — no graph path</text>`;
    }
    trail.steps.forEach((step, depth) => {
      const group = trailKindGroup(step.kind);
      const colors = TRAIL_COLORS[group];
      const x = leftPad + depth * colW;
      const seed = depth === 0 ? '★ ' : '';
      svg += `<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="9" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1.5"/>`;
      svg += `<text x="${x + 12}" y="${y + 25}" font-size="13" font-weight="bold" fill="${colors.ink}">${escapeHtml(seed + shortLabel(step.node))}</text>`;
      svg += `<text x="${x + 12}" y="${y + 45}" font-size="11" fill="${colors.ink}">${escapeHtml(step.kind)}</text>`;
      if (depth > 0) {
        const prevX = leftPad + (depth - 1) * colW + nodeW;
        const midY = y + nodeH / 2;
        svg += `<line x1="${prevX}" y1="${midY}" x2="${x}" y2="${midY}" stroke="#6b7280" stroke-width="1.5"/>`;
        const label = shortLabel(step.via ?? '?', 20);
        const midX = (prevX + x) / 2;
        svg += `<text x="${midX}" y="${midY - 7}" font-size="11" text-anchor="middle" fill="#374151">${escapeHtml(label)}</text>`;
      }
      if (depth === trail.steps.length - 1 && group === 'passage') {
        svg += `<text x="${x + 12}" y="${y + nodeH + 18}" font-size="11" fill="#6b7280">${escapeHtml(shortLabel(trail.locator, 30))} · score ${trail.score.toFixed(3)}</text>`;
      }
    });
  });

  const list = trails
    .map(
      (trail, i) =>
        `<li><strong>${escapeHtml(trail.locator)}</strong> (score ${trail.score.toFixed(3)}): ${escapeHtml(trailText(trail)) || '(found by words)'}</li>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Answer trails — ${escapeHtml(query)}</title>
</head>
<body style="font-family: sans-serif; color: #111; background: #fff; margin: 24px;">
<svg width="${width}" height="${height}" role="img" aria-label="Diagram of answer trails for ${escapeHtml(query)}">${svg}</svg>
<h2>Trails as text</h2>
<ol>
${list || '<li>No passages matched.</li>'}
</ol>
</body>
</html>
`;
}

