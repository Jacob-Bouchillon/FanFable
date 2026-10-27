/* FanFable dev visualizer.
 *
 * A read-only view over the local bank: Graph, Index, Timeline, Reader and
 * Ask. Every row shown here came from the bank (or, for Ask, from the
 * existing cited-answer path). Nothing on this page writes to the bank, the
 * ratings files or the network. The page is gated on the server by
 * FANFABLE_DEV=1 or --dev and is never linked from the ship UI.
 *
 * Layout is deterministic: seeded hash positions, no force simulation and no
 * Math.random in the drawing path. The same seed and the same bank produce
 * the same picture.
 */

(() => {
  'use strict';

  /* --------------------------------------------------------------- state */

  const params = new URLSearchParams(location.search);
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  const state = {
    project: (params.get('project') ?? '').trim(),
    seed: params.has('seed') ? Math.trunc(num(params.get('seed'), 42)) : 42,
    smooth: params.has('smooth') ? clamp(Math.trunc(num(params.get('smooth'), 3)), 1, 15) : 3,
    reveal: params.has('reveal') ? Math.trunc(num(params.get('reveal'), 0)) : null,
    blind: params.get('blind') === '1',
    view: 'graph',
    summary: null,
    session: null,
    sessionId: makeSessionId(),
    nodeById: new Map(),
    adj: new Map(),
    graphTransform: { x: 0, y: 0, k: 1 },
    graphPositions: new Map(),
    graphEdgeEls: new Map(),
    graphSearch: '',
    graphKind: 'all',
    graphStatus: 'all',
    indexQuery: '',
    indexKind: 'all',
    indexStatus: 'all',
    timelineQuery: '',
    timelineNet: false,
    reader: null,
    readerLoading: false,
    ask: null,
    nameRe: null,
    selectedNode: null,
  };

  const VIEWS = ['graph', 'index', 'timeline', 'reader', 'ask'];
  const KIND_ORDER = ['character', 'location', 'faction', 'item', 'creature', 'rule'];
  const KIND_LABEL = {
    character: 'character',
    location: 'location',
    faction: 'faction',
    item: 'item',
    creature: 'creature',
    rule: 'rule',
  };

  /* --------------------------------------------------------------- utils */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function fmt(n) {
    return Number(n ?? 0).toLocaleString();
  }

  function makeSessionId() {
    if (globalThis.crypto?.randomUUID) return `viz-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    return `viz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: options.body ? { 'content-type': 'application/json' } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) throw new Error(data?.error || `request failed (${res.status})`);
    return data;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isKeeper(status) {
    return status === 'accepted' || status === 'user_confirmed';
  }

  function statusLabel(status) {
    if (status === 'accepted') return 'accepted (strict checker)';
    if (status === 'user_confirmed') return 'keeper (user-confirmed)';
    if (status === 'needs_review') return 'parked (needs review)';
    if (status === 'rejected') return 'rejected';
    return status || 'unknown';
  }

  function statusBadge(status) {
    const cls = status === 'user_confirmed' || status === 'accepted'
      ? 'dv-badge-ok'
      : status === 'needs_review'
        ? 'dv-badge-warn'
        : 'dv-badge-muted';
    return `<span class="dv-badge ${cls}">${esc(statusLabel(status))}</span>`;
  }

  function edgeStatusLabel(edge) {
    if (edge.coverage) return 'coverage (appears_with)';
    if (isKeeper(edge.reviewStatus)) {
      return edge.reviewStatus === 'user_confirmed' ? 'keeper (user-confirmed)' : 'keeper (accepted)';
    }
    if (edge.reviewStatus === 'needs_review') return 'parked (needs review)';
    return statusLabel(edge.reviewStatus);
  }

  function edgeNote(edge) {
    if (edge.coverage) return 'mention only — coverage, never a relationship';
    if (edge.reviewStatus === 'needs_review') return 'held back — invisible to answers';
    return 'stated in answers';
  }

  /**
   * The one reveal fence.
   *
   * Graph, Index and Timeline all call this helper; there is no second
   * scope rule. `revealedUpTo` is a banked passage seq. A row with no banked
   * position cannot be proven to be before the fence, so it stays hidden
   * while the fence is on.
   */
  function canReveal(row, revealedUpTo) {
    if (revealedUpTo === null || revealedUpTo === undefined || revealedUpTo === '') return true;
    const limit = Number(revealedUpTo);
    if (!Number.isFinite(limit)) return true;
    const pos = row?.chunkSeq ?? row?.firstSeq ?? null;
    if (pos === null || pos === undefined) return false;
    return Number(pos) <= limit;
  }

  function hash32(value, seed) {
    let h = (Number(value) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  function kindHash(kind, seed) {
    let h = seed | 0;
    for (const ch of String(kind)) h = Math.imul(h ^ ch.charCodeAt(0), 0x45d9f3b) >>> 0;
    return h >>> 0;
  }

  function pageOf(locator) {
    const m = String(locator ?? '').match(/p\.\s*(\d+)/i);
    return m ? Number(m[1]) : null;
  }

  function shortText(text, limit = 280) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
  }

  function nodeMatches(node, query) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return node.name.toLowerCase().includes(q)
      || node.aliases.some((a) => a.toLowerCase().includes(q))
      || String(node.summary ?? '').toLowerCase().includes(q);
  }

  /* ------------------------------------------------------------ boot */

  async function boot() {
    document.body.classList.toggle('dv-blind', state.blind);
    $('#dv-blind').checked = state.blind;
    wireChrome();

    const hash = location.hash.replace(/^#\/?/, '');
    if (VIEWS.includes(hash)) state.view = hash;

    try {
      const summaryPath = '/api/dev/graph-summary'
        + (state.project ? `?project=${encodeURIComponent(state.project)}` : '');
      const [summary, session] = await Promise.all([
        api(summaryPath),
        api('/api/session').catch(() => null),
      ]);
      state.summary = summary;
      state.session = session;
      buildIndexes();
      initRevealControl();
      renderTabs();
      renderBanner();
      renderFooter();
      renderView();
    } catch (err) {
      renderFatal(err);
    }
  }

  function buildIndexes() {
    state.nodeById = new Map(state.summary.nodes.map((n) => [n.id, n]));
    state.adj = new Map();
    for (const e of state.summary.edges) {
      for (const id of [e.fromId, e.toId]) {
        const list = state.adj.get(id) ?? [];
        list.push(e.id);
        state.adj.set(id, list);
      }
    }
    state.nameRe = null;
  }

  function wireChrome() {
    for (const tab of $$('.dv-tab')) {
      tab.addEventListener('click', () => setView(tab.dataset.view));
    }

    const reveal = $('#dv-reveal');
    reveal.addEventListener('input', () => {
      const max = Number(reveal.max) || 0;
      const value = Number(reveal.value);
      state.reveal = value >= max ? null : value;
      updateRevealLabel();
      renderBanner();
      updateUrl();
      scheduleViewRender();
    });
    reveal.addEventListener('change', updateUrl);

    const blind = $('#dv-blind');
    blind.addEventListener('change', () => {
      state.blind = blind.checked;
      document.body.classList.toggle('dv-blind', state.blind);
      renderBanner();
      updateUrl();
      renderView();
    });

    $('#dv-drawer').addEventListener('click', (ev) => {
      if (ev.target.closest('[data-drawer-close]')) closeDrawer();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeDrawer();
    });
    window.addEventListener('hashchange', () => {
      const next = location.hash.replace(/^#\/?/, '');
      if (VIEWS.includes(next) && next !== state.view) {
        state.view = next;
        renderTabs();
        renderView();
      }
    });
    window.addEventListener('resize', () => {
      const tip = $('#dv-tooltip');
      if (tip) tip.hidden = true;
    });
  }

  function initRevealControl() {
    const input = $('#dv-reveal');
    const max = Math.max(0, state.summary.maxChunkSeq);
    input.min = '0';
    input.max = String(max || 1);
    input.value = String(state.reveal === null ? max || 1 : clamp(state.reveal, 0, max || 1));
    if (state.reveal !== null && max === 0) state.reveal = null;
    updateRevealLabel();
  }

  function updateRevealLabel() {
    const label = $('#dv-reveal-label');
    if (!label) return;
    label.textContent = state.reveal === null ? 'all' : `≤ passage ${fmt(state.reveal)}`;
  }

  let renderQueued = false;
  function scheduleViewRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderView();
    });
  }

  function setView(view) {
    if (!VIEWS.includes(view)) return;
    state.view = view;
    closeDrawer();
    history.replaceState(null, '', `${location.pathname}${location.search}#${view}`);
    renderTabs();
    renderView();
  }

  function renderTabs() {
    for (const tab of $$('.dv-tab')) {
      const active = tab.dataset.view === state.view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }

  function updateUrl() {
    const next = new URLSearchParams(location.search);
    if (state.project) next.set('project', state.project); else next.delete('project');
    if (state.seed !== 42) next.set('seed', String(state.seed)); else next.delete('seed');
    if (state.smooth !== 3) next.set('smooth', String(state.smooth)); else next.delete('smooth');
    if (state.reveal === null) next.delete('reveal'); else next.set('reveal', String(state.reveal));
    if (state.blind) next.set('blind', '1'); else next.delete('blind');
    const query = next.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}#${state.view}`);
  }

  /* ------------------------------------------------------------ chrome */

  function renderView() {
    if (!state.summary) return;
    const view = $('#dv-view');
    if (!view) return;
    switch (state.view) {
      case 'index': renderIndex(); break;
      case 'timeline': renderTimeline(); break;
      case 'reader': renderReader(); break;
      case 'ask': renderAsk(); break;
      default: renderGraph(); break;
    }
    renderFooter();
  }

  function renderBanner() {
    const box = $('#dv-banner');
    if (!box || !state.summary) return;
    const messages = [];
    const active = state.session?.currentProjectId;
    if (active !== null && active !== undefined && active !== state.summary.project.id) {
      const activeName = (state.session.projects ?? []).find((p) => p.id === active)?.name ?? `#${active}`;
      messages.push(
        `Reader and Ask use the server's active project (${activeName}). `
        + `Start the server on ${state.summary.project.name}'s database to align them.`,
      );
    }
    if (state.reveal !== null) {
      messages.push(`Reveal fence on: rows first banked after passage ${fmt(state.reveal)} are hidden.`);
    }
    if (state.blind) {
      messages.push('Blind mode on: model identifiers, the citation map and the bank answer line are omitted from the DOM.');
    }
    if (!messages.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = messages.map((m) => `<span>${esc(m)}</span>`).join('');
  }

  function renderFooter() {
    const footer = $('#dv-footer');
    if (!footer || !state.summary) return;
    const s = state.summary;
    const c = s.counts;
    footer.innerHTML = `
      <span class="dv-prov" data-project="${esc(s.project.name)}"><b>${esc(s.project.name)}</b></span>
      <span>db <code data-db="${esc(s.db)}">${esc(s.db)}</code></span>
      <span>commit <code data-commit="${esc(s.commit)}">${esc(s.commit)}</code></span>
      <span>seed <code data-seed="${state.seed}">${state.seed}</code></span>
      <span>view session <code>${esc(state.sessionId)}</code></span>
      <span data-count-entities>entities <b>${fmt(c.entities)}</b></span>
      <span data-count-relations>ties <b>${fmt(c.relations)}</b></span>
      <span data-count-keepers>keepers <b>${fmt(c.keepers)}</b> <span class="dv-muted">(${fmt(c.userConfirmed)} user-confirmed + ${fmt(c.accepted)} accepted)</span></span>
      <span data-count-parked>parked <b>${fmt(c.parked)}</b> <span class="dv-muted">(${fmt(c.coverage)} coverage)</span></span>
      <span data-count-pending>pending notes <b>${fmt(c.pendingNotes)}</b></span>
      <span data-count-timeline>timeline <b>${fmt(c.timeline)}</b></span>
      <span class="dv-readonly">read-only · the viz wrote nothing</span>
    `;
  }

  function renderFatal(err) {
    const view = $('#dv-view');
    const message = err instanceof Error ? err.message : String(err);
    const hint = /not found/i.test(message)
      ? 'Start the server with FANFABLE_DEV=1 (or --dev) and open /dev-viz again.'
      : 'The local server must be running against a database with a project.';
    view.innerHTML = `
      <div class="empty">
        <h3>The dev visualizer could not read the bank</h3>
        <p>${esc(message)}</p>
        <p class="muted small">${esc(hint)}</p>
      </div>`;
    $('#dv-footer').innerHTML = '<span class="dv-muted">no bank loaded</span>';
  }

  /* ------------------------------------------------------------- graph */

  function renderGraph() {
    const view = $('#dv-view');
    view.innerHTML = `
      <div class="dv-toolbar">
        <div class="dv-toolbar-title">
          <span class="dv-kicker">Graph</span>
          <span class="dv-muted small">seeded positions · hover an edge for its bank quote</span>
        </div>
        <label class="dv-field">
          <span class="dv-field-label">Find</span>
          <input class="input dv-input" id="dv-graph-search" placeholder="name or alias" value="${esc(state.graphSearch)}" />
        </label>
        <label class="dv-field">
          <span class="dv-field-label">Kind</span>
          <select class="input dv-input" id="dv-graph-kind">
            <option value="all">all kinds</option>
            ${KIND_ORDER.map((k) => `<option value="${k}" ${state.graphKind === k ? 'selected' : ''}>${esc(KIND_LABEL[k])}</option>`).join('')}
          </select>
        </label>
        <label class="dv-field">
          <span class="dv-field-label">Show</span>
          <select class="input dv-input" id="dv-graph-status">
            <option value="all" ${state.graphStatus === 'all' ? 'selected' : ''}>everything</option>
            <option value="keepers" ${state.graphStatus === 'keepers' ? 'selected' : ''}>keeper ties</option>
            <option value="parked" ${state.graphStatus === 'parked' ? 'selected' : ''}>parked ties</option>
            <option value="coverage" ${state.graphStatus === 'coverage' ? 'selected' : ''}>coverage only</option>
            <option value="thin" ${state.graphStatus === 'thin' ? 'selected' : ''}>thin names</option>
          </select>
        </label>
        <button class="btn btn-sm" id="dv-graph-reset">Reset view</button>
      </div>
      <div class="dv-graph-wrap">
        <svg id="dv-graph" viewBox="0 0 1400 1100" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Bank graph">
          <g id="dv-graph-viewport">
            <g id="dv-graph-edges"></g>
            <g id="dv-graph-nodes"></g>
          </g>
        </svg>
        <div class="dv-graph-hint">drag to pan · wheel to zoom · click a name for its bank card</div>
      </div>
      <div class="dv-legend" id="dv-graph-legend"></div>
    `;

    $('#dv-graph-search').addEventListener('input', (ev) => {
      state.graphSearch = ev.target.value;
      drawGraph();
    });
    $('#dv-graph-kind').addEventListener('change', (ev) => {
      state.graphKind = ev.target.value;
      drawGraph();
    });
    $('#dv-graph-status').addEventListener('change', (ev) => {
      state.graphStatus = ev.target.value;
      drawGraph();
    });
    $('#dv-graph-reset').addEventListener('click', () => {
      state.graphTransform = { x: 0, y: 0, k: 1 };
      applyGraphTransform();
    });

    wireGraphPanZoom($('#dv-graph'));
    applyGraphTransform();
    drawGraph();
  }

  function graphNodeVisible(node) {
    if (!canReveal(node, state.reveal)) return false;
    if (state.graphKind !== 'all' && node.kind !== state.graphKind) return false;
    if (state.graphStatus === 'keepers' && node.keeperTies === 0) return false;
    if (state.graphStatus === 'parked' && node.parkedTies === 0) return false;
    if (state.graphStatus === 'coverage' && node.coverageTies === 0) return false;
    if (state.graphStatus === 'thin' && !node.thin) return false;
    return true;
  }

  function graphEdgeVisible(edge) {
    if (!canReveal(edge, state.reveal)) return false;
    if (state.graphStatus === 'keepers') return isKeeper(edge.reviewStatus);
    if (state.graphStatus === 'parked') return edge.reviewStatus === 'needs_review' && !edge.coverage;
    if (state.graphStatus === 'coverage') return edge.coverage;
    if (state.graphStatus === 'thin') return false;
    return true;
  }

  function drawGraph() {
    const edgesGroup = $('#dv-graph-edges');
    const nodesGroup = $('#dv-graph-nodes');
    const legend = $('#dv-graph-legend');
    if (!edgesGroup || !nodesGroup) return;

    const visibleNodes = state.summary.nodes.filter(graphNodeVisible);
    const ids = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = state.summary.edges.filter(
      (e) => graphEdgeVisible(e) && ids.has(e.fromId) && ids.has(e.toId),
    );
    const layout = buildLayout(visibleNodes, state.seed);
    state.graphPositions = layout.positions;
    state.graphEdgeEls = new Map();

    edgesGroup.replaceChildren();
    nodesGroup.replaceChildren();

    for (const edge of visibleEdges) {
      const a = layout.positions.get(edge.fromId);
      const b = layout.positions.get(edge.toId);
      if (!a || !b) continue;
      const line = svgEl('line', {
        x1: a.x.toFixed(2),
        y1: a.y.toFixed(2),
        x2: b.x.toFixed(2),
        y2: b.y.toFixed(2),
        class: `dv-edge ${edgeClass(edge)}`,
        'data-edge-id': String(edge.id),
      });
      line.addEventListener('pointerenter', (ev) => showTooltip(ev, edgeTooltipHtml(edge)));
      line.addEventListener('pointermove', moveTooltip);
      line.addEventListener('pointerleave', hideTooltip);
      edgesGroup.appendChild(line);
      state.graphEdgeEls.set(edge.id, line);
    }

    const query = state.graphSearch.trim().toLowerCase();
    const matches = query
      ? new Set(visibleNodes.filter((n) => nodeMatches(n, query)).map((n) => n.id))
      : new Set();

    for (const node of visibleNodes) {
      const p = layout.positions.get(node.id);
      if (!p) continue;
      const r = nodeRadius(node);
      const group = svgEl('g', {
        class: 'dv-node',
        'data-node-id': String(node.id),
        'data-kind': node.kind,
        transform: `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`,
        role: 'button',
        'aria-label': node.name,
      });
      if (node.thin) group.classList.add('is-thin');
      if (node.keeperTies === 0 && node.parkedTies > 0) group.classList.add('is-parked');
      if (matches.has(node.id)) group.classList.add('is-match', 'show-label');
      if (state.selectedNode === node.id) group.classList.add('is-selected');

      const circle = svgEl('circle', { r: r.toFixed(2) });
      const label = svgEl('text', {
        class: 'dv-node-label',
        x: (r + 4).toFixed(2),
        y: '3',
      });
      label.textContent = node.name;
      group.append(circle, label);

      group.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openNode(node.id);
      });
      group.addEventListener('pointerenter', () => {
        for (const edgeId of state.adj.get(node.id) ?? []) {
          state.graphEdgeEls.get(edgeId)?.classList.add('is-hover');
        }
      });
      group.addEventListener('pointerleave', () => {
        for (const edgeId of state.adj.get(node.id) ?? []) {
          state.graphEdgeEls.get(edgeId)?.classList.remove('is-hover');
        }
      });

      nodesGroup.appendChild(group);
    }

    if (!visibleNodes.length) {
      legend.innerHTML = '<span class="dv-muted">No rows match this filter and reveal fence.</span>';
    } else {
      legend.innerHTML = graphLegend(visibleNodes, visibleEdges);
    }
  }

  function edgeClass(edge) {
    if (edge.coverage) return 'coverage';
    if (isKeeper(edge.reviewStatus)) return 'keeper';
    return 'parked';
  }

  function nodeRadius(node) {
    const mentions = Math.max(0, Number(node.mentions) || 0);
    return clamp(3 + Math.log2(mentions + 1) * 0.9, 3, 9);
  }

  function graphLegend(nodes, edges) {
    const byKind = {};
    for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    const keeper = edges.filter((e) => isKeeper(e.reviewStatus)).length;
    const parked = edges.filter((e) => e.reviewStatus === 'needs_review' && !e.coverage).length;
    const coverage = edges.filter((e) => e.coverage).length;
    const thin = nodes.filter((n) => n.thin).length;
    return `
      <span class="dv-legend-title">visible</span>
      ${KIND_ORDER.filter((k) => byKind[k]).map((k) => `<span class="dv-key"><i class="dv-dot dv-dot-${k}"></i>${esc(KIND_LABEL[k])} ${fmt(byKind[k])}</span>`).join('')}
      <span class="dv-key"><i class="dv-line dv-line-keeper"></i>keeper tie ${fmt(keeper)}</span>
      <span class="dv-key"><i class="dv-line dv-line-parked"></i>parked ${fmt(parked)}</span>
      <span class="dv-key"><i class="dv-line dv-line-coverage"></i>appears_with coverage ${fmt(coverage)} <span class="dv-muted">(never a relationship)</span></span>
      <span class="dv-key"><i class="dv-ring"></i>thin name ${fmt(thin)}</span>
    `;
  }

  function buildLayout(nodes, seed) {
    const byKind = new Map();
    for (const node of nodes) {
      const list = byKind.get(node.kind) ?? [];
      list.push(node);
      byKind.set(node.kind, list);
    }

    const positions = new Map();
    const cx = 700;
    const cy = 550;
    let radius = 92;
    let ringIndex = 0;
    const extraKinds = [...byKind.keys()].filter((k) => !KIND_ORDER.includes(k)).sort();
    for (const kind of [...KIND_ORDER, ...extraKinds]) {
      const list = (byKind.get(kind) ?? []).slice().sort(
        (a, b) => (b.mentions || 0) - (a.mentions || 0) || a.id - b.id,
      );
      let index = 0;
      while (index < list.length) {
        const capacity = Math.max(6, Math.floor((2 * Math.PI * radius) / 22));
        const slice = list.slice(index, index + capacity);
        const offset = (kindHash(kind, seed) + ringIndex * 41) % 360 * Math.PI / 180;
        for (let i = 0; i < slice.length; i++) {
          const node = slice[i];
          const angle = offset + (i / slice.length) * Math.PI * 2;
          const jitter = ((hash32(node.id + ringIndex * 31, seed) % 100) / 100 - 0.5) * 5;
          positions.set(node.id, {
            x: cx + Math.cos(angle) * (radius + jitter),
            y: cy + Math.sin(angle) * (radius + jitter),
          });
        }
        index += capacity;
        radius += 38;
        ringIndex++;
      }
    }
    return { positions, maxRadius: radius };
  }

  function circularLayout(ids, cx, cy, radius, seed) {
    const positions = new Map();
    if (!ids.length) return positions;
    const offset = (hash32(ids.length, seed) % 360) * Math.PI / 180;
    ids.forEach((id, i) => {
      const angle = offset + (i / ids.length) * Math.PI * 2;
      positions.set(id, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    });
    return positions;
  }

  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  }

  function applyGraphTransform() {
    const viewport = $('#dv-graph-viewport');
    if (!viewport) return;
    const t = state.graphTransform;
    viewport.setAttribute('transform', `translate(${t.x} ${t.y}) scale(${t.k})`);
  }

  function wireGraphPanZoom(svg) {
    if (!svg) return;
    let pan = null;

    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const t = state.graphTransform;
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX;
      pt.y = ev.clientY;
      const local = pt.matrixTransform(svg.getScreenCTM().inverse());
      const graphX = (local.x - t.x) / t.k;
      const graphY = (local.y - t.y) / t.k;
      const factor = ev.deltaY < 0 ? 1.16 : 1 / 1.16;
      const nextK = clamp(t.k * factor, 0.35, 4);
      t.x = local.x - graphX * nextK;
      t.y = local.y - graphY * nextK;
      t.k = nextK;
      applyGraphTransform();
    }, { passive: false });

    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest('.dv-node')) return;
      const ctm = svg.getScreenCTM();
      const scale = ctm ? ctm.a : 1;
      pan = {
        startX: ev.clientX,
        startY: ev.clientY,
        x: state.graphTransform.x,
        y: state.graphTransform.y,
        scale: scale || 1,
      };
      svg.classList.add('is-panning');
      svg.setPointerCapture?.(ev.pointerId);
    });

    svg.addEventListener('pointermove', (ev) => {
      if (!pan) return;
      state.graphTransform.x = pan.x + (ev.clientX - pan.startX) / pan.scale;
      state.graphTransform.y = pan.y + (ev.clientY - pan.startY) / pan.scale;
      applyGraphTransform();
    });

    const endPan = () => {
      pan = null;
      svg.classList.remove('is-panning');
    };
    svg.addEventListener('pointerup', endPan);
    svg.addEventListener('pointercancel', endPan);
    svg.addEventListener('pointerleave', endPan);
  }

  /* ---------------------------------------------------------- tooltip */

  function edgeTooltipHtml(edge) {
    return `
      <div class="dv-tt-title">${esc(edge.fromName)} → ${esc(edge.toName)}: ${esc(edge.kind)}</div>
      <div class="dv-tt-status">${esc(edgeStatusLabel(edge))} · ${esc(edgeNote(edge))}</div>
      <blockquote>${esc(edge.evidence || '(no quote banked)')}</blockquote>
      <div class="dv-tt-locator">${esc(edge.locator || 'unplaced')}</div>
    `;
  }

  function showTooltip(ev, html) {
    const tip = $('#dv-tooltip');
    if (!tip) return;
    tip.innerHTML = html;
    tip.hidden = false;
    moveTooltip(ev);
  }

  function moveTooltip(ev) {
    const tip = $('#dv-tooltip');
    if (!tip || tip.hidden) return;
    const pad = 14;
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + width > window.innerWidth - 8) x = ev.clientX - width - pad;
    if (y + height > window.innerHeight - 8) y = ev.clientY - height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function hideTooltip() {
    const tip = $('#dv-tooltip');
    if (tip) tip.hidden = true;
  }

  /* ------------------------------------------------------------- index */

  function renderIndex() {
    const view = $('#dv-view');
    view.innerHTML = `
      <div class="dv-toolbar">
        <div class="dv-toolbar-title">
          <span class="dv-kicker">Index</span>
          <span class="dv-muted small">every card is one banked entity row</span>
        </div>
        <label class="dv-field">
          <span class="dv-field-label">Search</span>
          <input class="input dv-input" id="dv-index-search" placeholder="name, alias or summary" value="${esc(state.indexQuery)}" />
        </label>
        <label class="dv-field">
          <span class="dv-field-label">Kind</span>
          <select class="input dv-input" id="dv-index-kind">
            <option value="all">all kinds</option>
            ${KIND_ORDER.map((k) => `<option value="${k}" ${state.indexKind === k ? 'selected' : ''}>${esc(KIND_LABEL[k])}</option>`).join('')}
          </select>
        </label>
        <label class="dv-field">
          <span class="dv-field-label">Ties</span>
          <select class="input dv-input" id="dv-index-status">
            <option value="all" ${state.indexStatus === 'all' ? 'selected' : ''}>all</option>
            <option value="keepers" ${state.indexStatus === 'keepers' ? 'selected' : ''}>has keeper ties</option>
            <option value="parked" ${state.indexStatus === 'parked' ? 'selected' : ''}>has parked ties</option>
            <option value="coverage" ${state.indexStatus === 'coverage' ? 'selected' : ''}>has coverage</option>
            <option value="thin" ${state.indexStatus === 'thin' ? 'selected' : ''}>thin names</option>
          </select>
        </label>
      </div>
      <div class="dv-stat-row" id="dv-index-stats"></div>
      <div class="dv-card-grid" id="dv-index-grid"></div>
    `;

    $('#dv-index-search').addEventListener('input', (ev) => {
      state.indexQuery = ev.target.value;
      updateIndex();
    });
    $('#dv-index-kind').addEventListener('change', (ev) => {
      state.indexKind = ev.target.value;
      updateIndex();
    });
    $('#dv-index-status').addEventListener('change', (ev) => {
      state.indexStatus = ev.target.value;
      updateIndex();
    });
    $('#dv-index-grid').addEventListener('click', (ev) => {
      const card = ev.target.closest('[data-node-id]');
      if (card) openNode(Number(card.dataset.nodeId));
    });
    updateIndex();
  }

  function indexNodeVisible(node) {
    if (!canReveal(node, state.reveal)) return false;
    if (!nodeMatches(node, state.indexQuery)) return false;
    if (state.indexKind !== 'all' && node.kind !== state.indexKind) return false;
    if (state.indexStatus === 'keepers' && node.keeperTies === 0) return false;
    if (state.indexStatus === 'parked' && node.parkedTies === 0) return false;
    if (state.indexStatus === 'coverage' && node.coverageTies === 0) return false;
    if (state.indexStatus === 'thin' && !node.thin) return false;
    return true;
  }

  function updateIndex() {
    const nodes = state.summary.nodes.filter(indexNodeVisible)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    const stats = $('#dv-index-stats');
    const grid = $('#dv-index-grid');
    if (!stats || !grid) return;

    const byKind = {};
    for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    const keeper = nodes.filter((n) => n.keeperTies > 0).length;
    const parked = nodes.filter((n) => n.parkedTies > 0).length;
    const coverage = nodes.filter((n) => n.coverageTies > 0).length;
    const thin = nodes.filter((n) => n.thin).length;
    stats.innerHTML = `
      <div class="dv-stat"><b>${fmt(nodes.length)}</b><span>entities shown</span></div>
      ${KIND_ORDER.filter((k) => byKind[k]).map((k) => `<div class="dv-stat"><b>${fmt(byKind[k])}</b><span>${esc(KIND_LABEL[k])}</span></div>`).join('')}
      <div class="dv-stat"><b>${fmt(keeper)}</b><span>with keeper ties</span></div>
      <div class="dv-stat"><b>${fmt(parked)}</b><span>with parked ties</span></div>
      <div class="dv-stat"><b>${fmt(coverage)}</b><span>with coverage</span></div>
      <div class="dv-stat"><b>${fmt(thin)}</b><span>thin names</span></div>
    `;

    if (!nodes.length) {
      grid.innerHTML = '<div class="empty"><h3>No entity matches</h3><p>Try another name, kind or tie filter.</p></div>';
      return;
    }

    grid.innerHTML = nodes.map((n) => `
      <button class="dv-card" data-node-id="${n.id}">
        <div class="dv-card-head">
          <span class="dv-kind dv-kind-${esc(n.kind)}">${esc(KIND_LABEL[n.kind] ?? n.kind)}</span>
          ${statusBadge(n.reviewStatus)}
        </div>
        <div class="dv-card-name">${esc(n.name)}</div>
        ${n.aliases.length ? `<div class="dv-card-alias">${esc(n.aliases.slice(0, 4).join(' · '))}</div>` : ''}
        <p class="dv-card-summary">${esc(shortText(n.summary || '—', 150))}</p>
        <div class="dv-card-meta">
          <span>${fmt(n.mentions)} mentions</span>
          <span>keepers <b>${fmt(n.keeperTies)}</b></span>
          <span>parked <b>${fmt(n.parkedTies)}</b></span>
          ${n.coverageTies ? `<span>coverage <b>${fmt(n.coverageTies)}</b></span>` : ''}
        </div>
        ${n.thin ? '<span class="dv-thin">thin name — no keeper-grade tie</span>' : ''}
      </button>
    `).join('');
  }

  /* ---------------------------------------------------------- timeline */

  function renderTimeline() {
    const view = $('#dv-view');
    view.innerHTML = `
      <div class="dv-toolbar">
        <div class="dv-toolbar-title">
          <span class="dv-kicker">Timeline</span>
          <span class="dv-muted small">story order from the bank · frequency from banked participants</span>
        </div>
        <label class="dv-field">
          <span class="dv-field-label">Filter</span>
          <input class="input dv-input" id="dv-timeline-search" placeholder="title, participant, place" value="${esc(state.timelineQuery)}" />
        </label>
        <label class="dv-field dv-field-small">
          <span class="dv-field-label">Smooth</span>
          <input class="input dv-input" type="number" min="1" max="15" step="1" id="dv-smooth" value="${state.smooth}" />
        </label>
        <label class="dv-check">
          <input type="checkbox" id="dv-net-toggle" ${state.timelineNet ? 'checked' : ''} />
          <span>Co-occurrence net</span>
        </label>
      </div>
      <div class="dv-chart-card">
        <div class="dv-chart-head">
          <div>
            <div class="dv-subhead">Participant mentions over story order</div>
            <div class="dv-muted small">bars: raw counts · line: window-smoothed · dashed: page markers from bank locators</div>
          </div>
          <div class="dv-muted small" id="dv-chart-note"></div>
        </div>
        <div id="dv-chart"></div>
      </div>
      <div class="dv-net-card" id="dv-net-card" ${state.timelineNet ? '' : 'hidden'}>
        <div class="dv-chart-head">
          <div>
            <div class="dv-subhead">Co-occurrence net</div>
            <div class="dv-muted small">appears_with counts only · coverage, never a relationship</div>
          </div>
          <div class="dv-muted small" id="dv-net-note"></div>
        </div>
        <div id="dv-net"></div>
      </div>
      <div class="dv-tl-list" id="dv-tl-list"></div>
    `;

    $('#dv-timeline-search').addEventListener('input', (ev) => {
      state.timelineQuery = ev.target.value;
      updateTimelineList();
    });
    $('#dv-smooth').addEventListener('change', (ev) => {
      state.smooth = clamp(Math.trunc(Number(ev.target.value) || 3), 1, 15);
      ev.target.value = String(state.smooth);
      updateUrl();
      updateTimelineChart();
    });
    $('#dv-net-toggle').addEventListener('change', (ev) => {
      state.timelineNet = ev.target.checked;
      $('#dv-net-card').hidden = !state.timelineNet;
      if (state.timelineNet) updateNet();
    });

    updateTimelineChart();
    updateTimelineList();
    if (state.timelineNet) updateNet();
  }

  function timelineEntryVisible(entry) {
    return canReveal(entry, state.reveal);
  }

  function timelineTextMatches(entry) {
    const q = state.timelineQuery.trim().toLowerCase();
    if (!q) return true;
    return [
      entry.title,
      entry.summary,
      entry.location,
      entry.when,
      ...(entry.participants ?? []),
    ].some((value) => String(value ?? '').toLowerCase().includes(q));
  }

  function updateTimelineChart() {
    const box = $('#dv-chart');
    if (!box) return;
    const entries = state.summary.timeline.filter(timelineEntryVisible);
    box.innerHTML = frequencyChart(entries);
    const note = $('#dv-chart-note');
    if (note) {
      const markers = pageMarkers(entries).length;
      note.textContent = `${fmt(entries.length)} entries · ${fmt(markers)} page markers · smooth ${state.smooth}`;
    }
  }

  function frequencyChart(entries) {
    if (!entries.length) {
      return '<div class="empty"><h3>No timeline rows</h3><p>The reveal fence or the bank left this empty.</p></div>';
    }
    const width = 1100;
    const height = 250;
    const pad = { left: 44, right: 18, top: 16, bottom: 30 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxSeq = Math.max(1, state.reveal ?? state.summary.maxChunkSeq, ...entries.map((e) => e.chunkSeq ?? 0));
    const bucketCount = 60;
    const raw = new Array(bucketCount).fill(0);
    for (const entry of entries) {
      if (entry.chunkSeq === null || entry.chunkSeq === undefined) continue;
      const bucket = Math.min(bucketCount - 1, Math.max(0, Math.floor((entry.chunkSeq / maxSeq) * bucketCount)));
      raw[bucket] += (entry.participants ?? []).length;
    }
    const smooth = state.smooth;
    const half = Math.floor(smooth / 2);
    const smoothed = raw.map((_, i) => {
      let total = 0;
      let count = 0;
      for (let j = i - half; j <= i + half; j++) {
        if (j < 0 || j >= raw.length) continue;
        total += raw[j];
        count++;
      }
      return count ? total / count : 0;
    });
    const maxY = Math.max(1, ...raw, ...smoothed);
    const xOf = (i) => pad.left + (i + 0.5) * (plotW / bucketCount);
    const yOf = (v) => pad.top + plotH - (v / maxY) * plotH;
    const barW = Math.max(2, plotW / bucketCount - 2);

    const bars = raw.map((value, i) => {
      const x = pad.left + i * (plotW / bucketCount) + 1;
      const y = yOf(value);
      return `<rect class="dv-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, pad.top + plotH - y).toFixed(1)}"><title>${value} participant mentions in this window</title></rect>`;
    }).join('');

    const points = smoothed.map((value, i) => `${xOf(i).toFixed(1)},${yOf(value).toFixed(1)}`).join(' ');
    const markers = pageMarkers(entries);
    const markerLines = markers.map((m) => {
      const x = pad.left + (m.chunkSeq / maxSeq) * plotW;
      return `
        <line class="dv-chart-marker" x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${pad.top + plotH}" />
        <text class="dv-chart-marker-label" x="${(x + 3).toFixed(1)}" y="${(pad.top + 10).toFixed(1)}">p. ${m.page}</text>
      `;
    }).join('');

    return `
      <svg class="dv-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Participant mentions over story order">
        <line class="dv-axis" x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" />
        <text class="dv-axis-label" x="${pad.left}" y="${pad.top - 2}">${fmt(maxY)}</text>
        <text class="dv-axis-label" x="${pad.left}" y="${pad.top + plotH + 18}">passage 0</text>
        <text class="dv-axis-label" x="${pad.left + plotW}" y="${pad.top + plotH + 18}" text-anchor="end">passage ${fmt(maxSeq)}</text>
        ${bars}
        ${markerLines}
        <polyline class="dv-chart-line" points="${points}" />
      </svg>
    `;
  }

  function pageMarkers(entries) {
    const pages = entries
      .map((entry) => ({ page: pageOf(entry.locator), chunkSeq: entry.chunkSeq }))
      .filter((m) => m.page !== null && m.chunkSeq !== null && m.chunkSeq !== undefined)
      .sort((a, b) => a.chunkSeq - b.chunkSeq);
    if (!pages.length) return [];
    const maxPage = Math.max(...pages.map((p) => p.page));
    const step = Math.max(10, Math.ceil(maxPage / 12));
    const out = [];
    let next = step;
    let lastSeq = -1;
    for (const marker of pages) {
      if (marker.page < next || marker.chunkSeq === lastSeq) continue;
      out.push(marker);
      lastSeq = marker.chunkSeq;
      next = marker.page + step;
    }
    return out;
  }

  function updateTimelineList() {
    const box = $('#dv-tl-list');
    if (!box) return;
    const entries = state.summary.timeline
      .filter(timelineEntryVisible)
      .filter(timelineTextMatches);
    if (!entries.length) {
      box.innerHTML = '<div class="empty"><h3>No timeline entries</h3><p>Try a wider filter or turn the reveal fence off.</p></div>';
      return;
    }
    box.innerHTML = entries.map((entry) => `
      <article class="dv-tl-item" data-timeline-id="${entry.id}" data-chunk-seq="${entry.chunkSeq ?? ''}">
        <div class="dv-tl-seq">#${fmt(entry.seq)}</div>
        <div class="dv-tl-body">
          <div class="dv-tl-title">${esc(entry.title)}</div>
          <div class="dv-tl-meta">
            ${entry.when ? `<span>${esc(entry.when)}</span>` : ''}
            ${entry.locator ? `<span>${esc(entry.locator)}</span>` : ''}
            ${entry.location ? `<span>${esc(entry.location)}</span>` : ''}
          </div>
          ${(entry.participants ?? []).length ? `<div class="dv-chips">${entry.participants.map((p) => `<span class="dv-chip">${esc(p)}</span>`).join('')}</div>` : ''}
          ${entry.summary ? `<p class="dv-tl-summary">${esc(entry.summary)}</p>` : ''}
          ${entry.evidence ? `<blockquote class="dv-tl-quote">${esc(entry.evidence)}</blockquote>` : ''}
        </div>
      </article>
    `).join('');
  }

  function updateNet() {
    const box = $('#dv-net');
    if (!box) return;
    const pairs = new Map();
    for (const edge of state.summary.edges) {
      if (!edge.coverage || !canReveal(edge, state.reveal)) continue;
      const a = Math.min(edge.fromId, edge.toId);
      const b = Math.max(edge.fromId, edge.toId);
      const key = `${a}:${b}`;
      const found = pairs.get(key) ?? {
        a,
        b,
        count: 0,
        fromName: edge.fromId === a ? edge.fromName : edge.toName,
        toName: edge.fromId === a ? edge.toName : edge.fromName,
      };
      found.count++;
      pairs.set(key, found);
    }
    const list = [...pairs.values()].sort((x, y) => y.count - x.count || x.a - y.a);
    const note = $('#dv-net-note');
    if (note) note.textContent = `${fmt(list.length)} pairs · ${fmt(list.reduce((n, p) => n + p.count, 0))} appears_with rows`;
    if (!list.length) {
      box.innerHTML = '<div class="empty"><h3>No coverage rows</h3><p>The bank holds no appears_with rows inside this reveal fence.</p></div>';
      return;
    }

    const ids = [...new Set(list.flatMap((p) => [p.a, p.b]))].sort((a, b) => a - b);
    const positions = circularLayout(ids, 500, 300, 220, state.seed);
    const width = 1000;
    const height = 600;
    const edgeSvg = list.map((pair) => {
      const a = positions.get(pair.a);
      const b = positions.get(pair.b);
      if (!a || !b) return '';
      const stroke = 1 + Math.min(7, pair.count * 1.4);
      return `<line class="dv-net-edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke-width="${stroke.toFixed(1)}" data-net-pair="${pair.a}:${pair.b}" data-net-count="${pair.count}" data-net-from="${esc(pair.fromName)}" data-net-to="${esc(pair.toName)}" />`;
    }).join('');
    const nodeSvg = ids.map((id) => {
      const p = positions.get(id);
      const node = state.nodeById.get(id);
      const name = node?.name ?? `#${id}`;
      return `<g class="dv-net-node" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})" data-net-node="${id}"><circle r="5" /><text class="dv-net-label" x="8" y="4">${esc(name)}</text></g>`;
    }).join('');

    box.innerHTML = `
      <svg class="dv-net" viewBox="0 0 ${width} ${height}" role="img" aria-label="Co-occurrence net">
        ${edgeSvg}
        ${nodeSvg}
      </svg>
      <div class="dv-muted small">Hover an edge for its pair and count. Coverage only: appears_with never states a relationship.</div>
    `;

    for (const line of $$('.dv-net-edge', box)) {
      line.addEventListener('pointerenter', (ev) => {
        const from = line.dataset.netFrom;
        const to = line.dataset.netTo;
        const count = line.dataset.netCount;
        showTooltip(ev, `
          <div class="dv-tt-title">${esc(from)} — ${esc(to)}</div>
          <div class="dv-tt-status">coverage only — appears_with, never a relationship</div>
          <div class="dv-tt-locator">${esc(count)} banked appears_with row(s)</div>
        `);
      });
      line.addEventListener('pointermove', moveTooltip);
      line.addEventListener('pointerleave', hideTooltip);
    }
  }

  /* ------------------------------------------------------------ reader */

  function renderReader() {
    const view = $('#dv-view');
    view.innerHTML = `
      <div class="dv-toolbar">
        <div class="dv-toolbar-title">
          <span class="dv-kicker">Reader</span>
          <span class="dv-muted small">passages from the bank's own search · names highlighted only from bank rows</span>
        </div>
        <form class="dv-search-form" id="dv-reader-form">
          <input class="input dv-input" id="dv-reader-q" placeholder="search the source passages" />
          <button class="btn btn-primary btn-sm" type="submit">Search</button>
        </form>
      </div>
      <div id="dv-reader-results">
        ${state.reader ? readerResultsHtml(state.reader) : '<div class="empty"><h3>Search the source</h3><p>Passages come from the bank; highlights come from entity names and aliases already banked.</p></div>'}
      </div>
    `;
    $('#dv-reader-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      doReaderSearch();
    });
  }

  async function doReaderSearch() {
    const input = $('#dv-reader-q');
    const box = $('#dv-reader-results');
    if (!input || !box) return;
    const q = input.value.trim();
    if (!q) {
      box.innerHTML = '<div class="empty"><h3>Search the source</h3><p>Type a name or phrase first.</p></div>';
      return;
    }
    box.innerHTML = '<div class="spinner"></div><p class="muted small" style="text-align:center">searching banked passages…</p>';
    try {
      const data = await api(`/api/lore?q=${encodeURIComponent(q)}`);
      state.reader = { query: q, passages: data.passages ?? [] };
      box.innerHTML = readerResultsHtml(state.reader);
    } catch (err) {
      box.innerHTML = `<div class="empty"><h3>Search failed</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function readerResultsHtml(result) {
    const passages = result.passages ?? [];
    if (!passages.length) {
      return `<div class="empty"><h3>No passages</h3><p>No banked passage matched “${esc(result.query)}”.</p></div>`;
    }
    return `
      <div class="dv-reader-head">
        <span class="dv-kicker">${fmt(passages.length)} passages</span>
        <span class="dv-muted small">query: ${esc(result.query)} · highlights: banked names only</span>
      </div>
      ${passages.map((p) => `
        <article class="dv-reader-passage" data-chunk="${p.chunkId}">
          <div class="dv-reader-meta">
            <span class="dv-badge dv-badge-muted">${esc(p.locator)}</span>
            <span class="dv-muted small">${esc(p.sourceTitle)}</span>
          </div>
          <div class="dv-reader-text">${highlightText(p.text)}</div>
        </article>
      `).join('')}
    `;
  }

  function nameRegex() {
    if (state.nameRe) return state.nameRe;
    const names = new Set();
    for (const node of state.summary.nodes) {
      if (node.name && node.name.length > 1) names.add(node.name);
      for (const alias of node.aliases) {
        if (alias && alias.length > 1) names.add(alias);
      }
    }
    const list = [...names].sort((a, b) => b.length - a.length);
    state.nameRe = list.length
      ? new RegExp(`(${list.map(escapeRegExp).join('|')})`, 'gi')
      : null;
    return state.nameRe;
  }

  function highlightText(text) {
    const source = String(text ?? '');
    const re = nameRegex();
    if (!re) return esc(source);
    re.lastIndex = 0;
    let out = '';
    let last = 0;
    for (const match of source.matchAll(re)) {
      const index = match.index ?? 0;
      out += esc(source.slice(last, index));
      out += `<mark class="dv-mark">${esc(match[0])}</mark>`;
      last = index + match[0].length;
    }
    out += esc(source.slice(last));
    return out;
  }

  /* --------------------------------------------------------------- ask */

  function renderAsk() {
    const view = $('#dv-view');
    view.innerHTML = `
      <div class="dv-toolbar">
        <div class="dv-toolbar-title">
          <span class="dv-kicker">Ask</span>
          <span class="dv-muted small">the existing cited-answer path, answer guard included · the viz never writes ratings</span>
        </div>
        <form class="dv-search-form" id="dv-ask-form">
          <input class="input dv-input" id="dv-ask-q" placeholder="ask a lore question" />
          <button class="btn btn-primary btn-sm" type="submit">Ask</button>
        </form>
      </div>
      <div class="dv-ask-note">
        <span class="dv-badge dv-badge-warn">read-only</span>
        <span class="dv-muted small">The answer comes from the model through <code>/api/lore/ask</code>; citations and locators come from the bank. A blind answer hides the model line, the citation map and the bank answer line in this DOM.</span>
      </div>
      <div id="dv-ask-result">${state.ask ? askResultHtml(state.ask) : ''}</div>
    `;
    $('#dv-ask-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      doAsk();
    });
    if (state.ask) wireAskResult();
  }

  async function doAsk() {
    const input = $('#dv-ask-q');
    if (!input) return;
    const question = input.value.trim();
    if (!question) return;
    state.ask = { question, status: 'running', message: 'searching the bank' };
    renderAskResult();
    // The bank line is independent of the model: fetch it alongside the ask
    // job and keep it even if the model path fails.
    const bankPromise = api(`/api/dev/bank-answer?q=${encodeURIComponent(question)}`).catch(() => null);
    try {
      const { jobId } = await api('/api/lore/ask', { method: 'POST', body: { question } });
      for (;;) {
        const job = await api(`/api/jobs/${jobId}`);
        if (job.status === 'running') {
          state.ask.message = job.message || 'working';
          renderAskResult();
          await sleep(700);
          continue;
        }
        if (job.status === 'error') throw new Error(job.error || 'the ask job failed');
        state.ask = { question, status: 'done', result: job.result, bank: await bankPromise };
        break;
      }
    } catch (err) {
      state.ask = { question, status: 'error', error: err.message, bank: await bankPromise };
    }
    renderAskResult();
  }

  function renderAskResult() {
    const box = $('#dv-ask-result');
    if (!box) return;
    box.innerHTML = askResultHtml(state.ask);
    wireAskResult();
  }

  function askResultHtml(ask) {
    if (!ask) return '';
    if (ask.status === 'running') {
      return `<div class="dv-ask-card"><div class="spinner"></div><p class="muted small" style="text-align:center">${esc(ask.message || 'working')}</p></div>`;
    }
    if (ask.status === 'error') {
      return `
        <div class="dv-ask-card">
          <div class="dv-kicker">Ask failed</div>
          <p class="muted">${esc(ask.error)}</p>
          <p class="muted small">Ask uses the local model configured for this project. It is not a bank write.</p>
        </div>`;
    }
    const result = ask.result ?? {};
    const passages = result.passages ?? [];
    const model = modelLabel();
    const blind = state.blind;
    const bankHtml = !blind ? bankAnswerHtml(ask.bank) : '';
    return `
      <div class="dv-ask-card" data-ask-status="done" data-blind="${blind ? '1' : '0'}">
        <div class="dv-ask-q"><span class="dv-kicker">Question</span><p>${esc(ask.question)}</p>${bankHtml}</div>
        ${!blind && model ? `<div class="dv-ident" data-model="${esc(model)}">Model: <code>${esc(model)}</code></div>` : ''}
        <div class="dv-answer" data-answer>${esc(result.answer ?? '')}</div>
        ${!blind ? citationMapHtml(passages) : ''}
        <div class="dv-citations">
          <div class="dv-subhead">Passages returned (${fmt(passages.length)})</div>
          ${passages.length
            ? passages.map((p, i) => `
              <article class="dv-cite" data-passage="${i + 1}">
                <div class="dv-cite-head">
                  <span class="dv-badge dv-badge-muted">${esc(p.locator)}</span>
                  <span class="dv-muted small">${esc(p.sourceTitle)}</span>
                </div>
                <blockquote>${esc(p.text)}</blockquote>
              </article>
            `).join('')
            : '<p class="muted small">The ask path returned no passages.</p>'}
        </div>
        <div class="dv-ask-foot">
          <span class="dv-muted small">Answer guard ran on this path: an unproven CONFIRMED tie is downgraded to an abstain.</span>
        </div>
      </div>
    `;
  }

  function bankAnswerHtml(bank) {
    if (!bank) return '';
    if (bank.status === 'keeper' && bank.line) {
      return `
        <div class="dv-bank-answer" data-bank-answer data-bank-status="keeper" title="bank keeper">
          <div class="dv-bank-line">${esc(bank.line)}</div>
        </div>
      `;
    }
    const reason = bank.reason || 'No single banked keeper answers this question.';
    return `
      <div class="dv-bank-answer is-abstain" data-bank-answer data-bank-status="${esc(bank.status || 'none')}">
        <div class="dv-bank-line">${esc(reason)}</div>
      </div>
    `;
  }

  function citationMapHtml(passages) {
    if (!passages.length) return '';
    return `
      <div class="dv-variant-map" data-variant-map>
        <div class="dv-subhead">Citation map</div>
        <ul>
          ${passages.map((p, i) => `<li><code>[S${i + 1}]</code> ${esc(p.locator)} <span class="dv-muted">· ${esc(p.sourceTitle)}</span></li>`).join('')}
        </ul>
      </div>
    `;
  }

  function wireAskResult() {
    // Nothing interactive in the result yet; kept as one place to wire later
    // without touching the answer text or the bank.
  }

  function modelLabel() {
    const model = state.session?.model ?? {};
    const parts = [model.provider, model.model].filter((v) => typeof v === 'string' && v.trim());
    return parts.join(' / ');
  }

  /* ------------------------------------------------------------ drawer */

  function openNode(id) {
    const node = state.nodeById.get(id);
    if (!node) return;
    state.selectedNode = id;
    for (const group of $$('.dv-node')) {
      group.classList.toggle('is-selected', Number(group.dataset.nodeId) === id);
    }
    const ties = state.summary.edges
      .filter((edge) => edge.fromId === id || edge.toId === id)
      .sort((a, b) => tieRank(a) - tieRank(b) || a.id - b.id);
    const drawer = $('#dv-drawer');
    drawer.innerHTML = `
      <div class="dv-drawer-head">
        <div>
          <div class="dv-kicker">${esc(KIND_LABEL[node.kind] ?? node.kind)}</div>
          <h2>${esc(node.name)}</h2>
        </div>
        <button class="icon-btn" data-drawer-close aria-label="Close">✕</button>
      </div>
      <div class="dv-drawer-body">
        <div class="dv-badges">
          ${statusBadge(node.reviewStatus)}
          ${node.thin ? '<span class="dv-badge dv-badge-warn">thin name</span>' : ''}
          ${node.keeperTies ? `<span class="dv-badge dv-badge-ok">keepers ${fmt(node.keeperTies)}</span>` : ''}
          ${node.parkedTies ? `<span class="dv-badge dv-badge-warn">parked ${fmt(node.parkedTies)}</span>` : ''}
          ${node.coverageTies ? `<span class="dv-badge dv-badge-muted">coverage ${fmt(node.coverageTies)}</span>` : ''}
        </div>
        ${node.aliases.length ? `<div class="dv-drawer-line"><span>aliases</span> ${esc(node.aliases.join(' · '))}</div>` : ''}
        ${node.role ? `<div class="dv-drawer-line"><span>role</span> ${esc(node.role)}</div>` : ''}
        ${node.status ? `<div class="dv-drawer-line"><span>status</span> ${esc(node.status)}</div>` : ''}
        <div class="dv-drawer-line"><span>mentions</span> ${fmt(node.mentions)}</div>
        <div class="dv-drawer-line"><span>first banked passage</span> ${esc(node.locator || 'unplaced')}${node.firstSeq === null ? '' : ` <span class="dv-muted">(passage ${fmt(node.firstSeq)})</span>`}</div>
        <p class="dv-drawer-summary">${esc(node.summary || '—')}</p>
        <div class="dv-drawer-actions">
          <button class="btn btn-sm" id="dv-drawer-graph">Show in graph</button>
          <button class="btn btn-sm" id="dv-drawer-index">Find in index</button>
        </div>
        <div class="dv-subhead">Banked ties (${fmt(ties.length)})</div>
        ${ties.length ? ties.map((edge) => tieHtml(edge, node)).join('') : '<p class="muted small">No tie rows are banked for this name. That is a thin name, not a claim.</p>'}
      </div>
    `;
    drawer.hidden = false;
    $('#dv-drawer-graph')?.addEventListener('click', () => {
      state.graphSearch = node.name;
      closeDrawer();
      setView('graph');
    });
    $('#dv-drawer-index')?.addEventListener('click', () => {
      state.indexQuery = node.name;
      closeDrawer();
      setView('index');
    });
  }

  function closeDrawer() {
    const drawer = $('#dv-drawer');
    if (drawer) drawer.hidden = true;
  }

  function tieRank(edge) {
    if (edge.coverage) return 2;
    if (isKeeper(edge.reviewStatus)) return 0;
    return 1;
  }

  function tieHtml(edge, node) {
    const other = edge.fromId === node.id ? edge.toName : edge.fromName;
    return `
      <div class="dv-tie ${edge.coverage ? 'is-coverage' : isKeeper(edge.reviewStatus) ? 'is-keeper' : 'is-parked'}">
        <div class="dv-tie-head">
          <b>${esc(other)}</b>
          <span class="dv-tie-kind">${esc(edge.kind)}</span>
          <span class="dv-badge ${isKeeper(edge.reviewStatus) ? 'dv-badge-ok' : 'dv-badge-warn'}">${esc(edgeStatusLabel(edge))}</span>
        </div>
        <blockquote>${esc(edge.evidence || '(no quote banked)')}</blockquote>
        <div class="dv-tie-meta">${esc(edge.locator || 'unplaced')} · ${esc(edgeNote(edge))}</div>
      </div>
    `;
  }

  /* --------------------------------------------------------------- go */

  boot();
})();
