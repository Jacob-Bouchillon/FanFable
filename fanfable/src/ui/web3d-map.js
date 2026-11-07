/* Relationship map (read-only). No external scripts. */
(() => {
  'use strict';

  const canvas = document.getElementById('w3d-canvas');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('w3d-status');
  const countsEl = document.getElementById('w3d-counts');
  const panel = document.getElementById('w3d-panel');
  const detailEl = document.getElementById('w3d-detail');
  const tooltipEl = document.getElementById('w3d-tooltip');
  const isolatedToggle = document.getElementById('f-isolated');

  const FAMILY_COLORS = {
    kin: '#c98b6b',
    friend: '#5aa9a1',
    hostile: '#c25b5b',
    teach: '#7d8fc9',
    trust: '#8fae5a',
    ally: '#b08a4a',
    colleague: '#8a7bc8',
    other: '#7b8085',
  };

  const FAMILY_PRECEDENCE = ['kin', 'hostile', 'teach', 'ally', 'trust', 'friend', 'colleague', 'other'];

  const state = {
    nodes: [],
    lines: [],
    nodeById: new Map(),
    lineHits: [],
    projected: new Map(),
    topLabels: new Set(),
    centerX: 0,
    centerY: 0,
    fit: 1,
    zoom: 1,
    panX: 0,
    panY: 0,
    selected: null,
    hover: null,
    dragging: false,
    dragDistance: 0,
    lastX: 0,
    lastY: 0,
    fetching: false,
  };

  function hashUnit(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  function nodeRadius(node) {
    return Math.min(18, 6 + Math.min(node.degree, 8) * 1.5);
  }

  function groupEdges(edges, byId) {
    const groups = new Map();
    for (const edge of edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
      const a = Math.min(edge.from, edge.to);
      const b = Math.max(edge.from, edge.to);
      const key = `${a}:${b}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, from: a, to: b, relations: [] };
        groups.set(key, group);
      }
      group.relations.push(edge);
    }
    return [...groups.values()].map((group) => {
      group.relations.sort((a, b) => a.id - b.id);
      const family = FAMILY_PRECEDENCE.find((candidate) =>
        group.relations.some((relation) => relation.family === candidate)) || 'other';
      const accepted = group.relations.some((relation) => relation.status === 'accepted');
      return {
        key: group.key,
        from: group.from,
        to: group.to,
        family,
        accepted,
        relations: group.relations,
      };
    }).sort((a, b) => a.from - b.from || a.to - b.to);
  }

  function layout(data) {
    const nodes = (data.nodes || []).map((node) => {
      const angle = hashUnit(`angle:${node.id}`) * Math.PI * 2;
      const radius = 0.05 + 0.7 * hashUnit(`radius:${node.id}`);
      return {
        ...node,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        radius: nodeRadius(node),
      };
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const lines = groupEdges(data.edges || [], byId);
    forceLayout(nodes, lines, byId);
    placeIsolated(nodes);
    return { nodes, lines, byId };
  }

  function forceLayout(nodes, lines, byId) {
    const moving = nodes.filter((node) => node.degree > 0);
    for (const node of nodes) node.radius = nodeRadius(node);
    if (!moving.length) return;

    const n = nodes.length;
    const k = Math.sqrt((canvas.clientWidth * canvas.clientHeight) / Math.max(1, n)) * 1.7;
    const restLength = 1.3 * k;
    const iterations = 500;
    // Work in units of k. The fit-to-view removes the absolute unit, while
    // the relative spacing stays exactly the requested k / 1.3k structure.
    const inverseK = 1 / k;

    for (let iter = 0; iter < iterations; iter++) {
      const cooling = 0.9 + (0.05 - 0.9) * (iter / (iterations - 1));
      for (const node of moving) {
        node.vx = 0;
        node.vy = 0;
      }

      for (let i = 0; i < moving.length; i++) {
        const a = moving[i];
        for (let j = i + 1; j < moving.length; j++) {
          const b = moving[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1e-6) {
            const angle = hashUnit(`split:${a.id}:${b.id}`) * Math.PI * 2;
            dx = Math.cos(angle) * 0.001;
            dy = Math.sin(angle) * 0.001;
            d2 = dx * dx + dy * dy;
          }
          const dist = Math.sqrt(d2);
          // Positions are already in k-units: (k*k / (dist*k)) / k = 1/dist.
          const f = 1 / dist;
          const ux = dx / dist;
          const uy = dy / dist;
          a.vx -= ux * f;
          a.vy -= uy * f;
          b.vx += ux * f;
          b.vy += uy * f;
        }
      }

      for (const line of lines) {
        const a = byId.get(line.from);
        const b = byId.get(line.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-6;
        const f = 0.08 * ((dist * k) - restLength) * inverseK;
        const ux = dx / dist;
        const uy = dy / dist;
        a.vx += ux * f;
        a.vy += uy * f;
        b.vx -= ux * f;
        b.vy -= uy * f;
      }

      for (const node of moving) {
        const dist = Math.hypot(node.x, node.y) || 1e-6;
        const f = (0.01 * dist * k) * inverseK;
        node.vx -= (node.x / dist) * f;
        node.vy -= (node.y / dist) * f;

        node.x += node.vx * 0.0005 * cooling;
        node.y += node.vy * 0.0005 * cooling;
      }
    }
  }

  function placeIsolated(nodes) {
    const isolated = nodes.filter((node) => node.degree === 0);
    if (!isolated.length) return;
    const connected = nodes.filter((node) => node.degree > 0);
    if (!connected.length) {
      isolated.forEach((node, index) => {
        const angle = (index / Math.max(1, isolated.length)) * Math.PI * 2;
        node.x = Math.cos(angle);
        node.y = Math.sin(angle);
      });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of connected) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const spread = Math.max(maxX - minX, maxY - minY, 1);
    const radius = spread * 0.75 + 0.4;
    isolated.forEach((node, index) => {
      const angle = (index / Math.max(1, isolated.length)) * Math.PI * 2;
      node.x = cx + Math.cos(angle) * radius;
      node.y = cy + Math.sin(angle) * radius;
    });
  }

  function boundsOf(nodes) {
    if (!nodes.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }
    return { minX, minY, maxX, maxY };
  }

  function fitView() {
    const bounds = boundsOf(state.nodes);
    if (!bounds) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const spanX = Math.max(0.001, bounds.maxX - bounds.minX);
    const spanY = Math.max(0.001, bounds.maxY - bounds.minY);
    const padX = Math.max(0.001, spanX * 0.12);
    const padY = Math.max(0.001, spanY * 0.12);
    const left = bounds.minX - padX;
    const right = bounds.maxX + padX;
    const top = bounds.minY - padY;
    const bottom = bounds.maxY + padY;
    state.centerX = (left + right) / 2;
    state.centerY = (top + bottom) / 2;
    const raw = Math.min(width / (right - left), height / (bottom - top));
    state.fit = Number.isFinite(raw) && raw > 0 ? Math.min(300, raw) : 1;
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
  }

  function project(node) {
    const scale = state.fit * state.zoom;
    return {
      x: canvas.clientWidth / 2 + (node.x - state.centerX) * scale + state.panX,
      y: canvas.clientHeight / 2 + (node.y - state.centerY) * scale + state.panY,
      scale,
    };
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state.nodes.length) fitView();
    draw();
  }
  window.addEventListener('resize', resize);

  function edgeEndpoints(a, b, radiusA, radiusB) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    return {
      ux,
      uy,
      start: { x: a.x + ux * (radiusA + 2), y: a.y + uy * (radiusA + 2) },
      end: { x: b.x - ux * (radiusB + 3), y: b.y - uy * (radiusB + 3) },
    };
  }

  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.clearRect(0, 0, width, height);

    const projected = new Map();
    for (const node of state.nodes) projected.set(node.id, project(node));
    state.projected = projected;
    state.lineHits = [];

    for (const line of state.lines) {
      const single = line.relations.length === 1;
      const sourceId = single ? line.relations[0].from : line.from;
      const targetId = single ? line.relations[0].to : line.to;
      const a = projected.get(sourceId);
      const b = projected.get(targetId);
      const fromNode = state.nodeById.get(sourceId);
      const toNode = state.nodeById.get(targetId);
      if (!a || !b || !fromNode || !toNode) continue;
      const ends = edgeEndpoints(a, b, fromNode.radius, toNode.radius);
      const color = FAMILY_COLORS[line.family] || FAMILY_COLORS.other;
      const review = !line.accepted;
      const selected = state.selected && state.selected.type === 'line' && state.selected.id === line.key;

      ctx.save();
      ctx.globalAlpha = review ? 0.38 : 0.9;
      ctx.strokeStyle = selected ? '#ffffff' : color;
      ctx.lineWidth = selected ? 3.2 : review ? 1.1 : 1.6;
      if (review) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(ends.start.x, ends.start.y);
      ctx.lineTo(ends.end.x, ends.end.y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (single) {
        const arrow = 7;
        const bx = ends.end.x - ends.ux * arrow;
        const by = ends.end.y - ends.uy * arrow;
        const px = -ends.uy;
        const py = ends.ux;
        ctx.beginPath();
        ctx.moveTo(ends.end.x, ends.end.y);
        ctx.lineTo(bx + px * 3.2, by + py * 3.2);
        ctx.lineTo(bx - px * 3.2, by - py * 3.2);
        ctx.closePath();
        ctx.fillStyle = selected ? '#ffffff' : color;
        ctx.fill();
      }
      ctx.restore();

      state.lineHits.push({
        line,
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
      });
    }

    const ordered = [...state.nodes].sort((a, b) => (projected.get(a.id)?.y ?? 0) - (projected.get(b.id)?.y ?? 0));
    const hovered = state.hover && state.hover.type === 'node' ? state.hover.id : null;
    for (const node of ordered) {
      const point = projected.get(node.id);
      if (!point) continue;
      const selected = state.selected && state.selected.type === 'node' && state.selected.id === node.id;
      const character = node.kind === 'character';
      ctx.beginPath();
      ctx.arc(point.x, point.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = character ? '#5aa9a1' : node.degree === 0 ? '#6b7075' : '#8a7bc8';
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (node.degree === 0) {
        ctx.strokeStyle = 'rgba(230,232,234,.45)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (state.topLabels.has(node.id) || node.id === hovered) {
        const label = node.name.length > 18 ? `${node.name.slice(0, 17)}…` : node.name;
        ctx.fillStyle = character ? '#e6e8ea' : 'rgba(230,232,234,.75)';
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.shadowColor = 'rgba(0,0,0,.7)';
        ctx.shadowBlur = 3;
        ctx.fillText(label, point.x + node.radius + 4, point.y + 3);
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
      }
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function showPerson(entityId) {
    panel.hidden = false;
    detailEl.replaceChildren(el('p', 'w3d-muted', 'loading…'));
    try {
      const res = await fetch(`/api/web/person?id=${encodeURIComponent(entityId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const nodes = [];
      const person = data.person;
      nodes.push(el('h2', '', person.name));
      if (person.aliases && person.aliases.length) {
        nodes.push(el('div', 'w3d-muted', person.aliases.join(' · ')));
      }
      nodes.push(el('div', 'w3d-muted', person.kind));
      nodes.push(el('div', 'w3d-muted',
        `${data.counts.total} ties · ${data.counts.accepted} accepted · ${data.counts.needsReview} needs review`));
      if (data.duplicates && data.duplicates.length) {
        const warning = el('div', 'w3d-warn w3d-duplicates');
        for (const duplicate of data.duplicates) {
          warning.append(el('div', '', `Also in the bank: ${duplicate.name} (${duplicate.reason}) — not merged.`));
        }
        nodes.push(warning);
      }
      for (const group of data.groups) {
        nodes.push(el('h3', 'w3d-family', group.family));
        for (const tie of group.ties) {
          const card = el('div', 'w3d-note w3d-tie');
          const head = el('div', 'w3d-evidence-head');
          head.append(el('span', 'w3d-tie-direction',
            tie.direction === 'out' ? `→ ${tie.counterpart.name}` : `${tie.counterpart.name} ←`));
          head.append(el('span', 'w3d-muted', tie.kind));
          const badgeClass = tie.status === 'accepted'
            ? 'w3d-status-accepted'
            : tie.status === 'needs_review' ? 'w3d-status-review' : 'w3d-status-other';
          head.append(el('span', `w3d-status ${badgeClass}`, tie.status));
          card.append(head);
          card.append(el('q', 'w3d-tie-quote', tie.quote));
          if (tie.locator) card.append(el('div', 'w3d-muted', tie.locator));
          if (tie.description) card.append(el('div', 'w3d-muted w3d-model-note', `model note: ${tie.description}`));
          nodes.push(card);
        }
      }
      if (!data.groups.length) nodes.push(el('p', 'w3d-muted', 'no banked relationships yet'));
      const extra = data.extra;
      if (extra) {
        const span = extra.firstChapter
          ? (extra.lastChapter && extra.lastChapter !== extra.firstChapter
            ? `chapters ${extra.firstChapter}\u2013${extra.lastChapter}`
            : `chapter ${extra.firstChapter}`)
          : 'no chapter';
        nodes.push(el('div', 'w3d-muted', `${extra.status} \u00b7 ${span} \u00b7 ${extra.events.length} scenes`));
        if (extra.attributes && (extra.attributes.sentient != null || extra.attributes.speaks != null)) {
          const flags = [];
          if (extra.attributes.sentient != null) flags.push(`sentient: ${extra.attributes.sentient}`);
          if (extra.attributes.speaks != null) flags.push(`speaks: ${extra.attributes.speaks}`);
          nodes.push(el('div', 'w3d-muted', flags.join(' \u00b7 ')));
        }
        if (extra.events.length) {
          nodes.push(el('h3', 'w3d-family', 'Scenes'));
          for (const event of extra.events) {
            const card = el('div', 'w3d-note w3d-tie');
            card.append(el('div', 'w3d-evidence-head', event.title));
            if (event.locator) card.append(el('div', 'w3d-muted', event.locator));
            if (event.summary) card.append(el('div', 'w3d-muted', event.summary));
            if (event.quote) card.append(el('q', 'w3d-tie-quote', event.quote));
            nodes.push(card);
          }
        }
      }
      detailEl.replaceChildren(...nodes);
    } catch (error) {
      detailEl.replaceChildren(el('p', 'w3d-muted', 'Could not load person.'));
    }
  }

  function showLine(line) {
    panel.hidden = false;
    const from = state.nodeById.get(line.from);
    const to = state.nodeById.get(line.to);
    const nodes = [];
    nodes.push(el('h2', '', `${from ? from.name : `#${line.from}`} ↔ ${to ? to.name : `#${line.to}`}`));
    nodes.push(el('div', 'w3d-muted',
      `${line.family} · ${line.relations.length} relation${line.relations.length === 1 ? '' : 's'}`));
    for (const relation of line.relations) {
      const source = state.nodeById.get(relation.from);
      const target = state.nodeById.get(relation.to);
      const card = el('div', 'w3d-note w3d-tie');
      const head = el('div', 'w3d-evidence-head');
      head.append(el('span', 'w3d-tie-direction',
        `${source ? source.name : `#${relation.from}`} → ${target ? target.name : `#${relation.to}`}`));
      head.append(el('span', 'w3d-muted', relation.kind));
      const badgeClass = relation.status === 'accepted'
        ? 'w3d-status-accepted'
        : relation.status === 'needs_review' ? 'w3d-status-review' : 'w3d-status-other';
      head.append(el('span', `w3d-status ${badgeClass}`, relation.status));
      card.append(head);
      card.append(el('q', 'w3d-tie-quote', relation.quote || '(no quote)'));
      if (relation.locator) card.append(el('div', 'w3d-muted', relation.locator));
      nodes.push(card);
    }
    detailEl.replaceChildren(...nodes);
  }

  function distanceToSegment(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  function hitTest(x, y) {
    for (const node of state.nodes) {
      const point = state.projected.get(node.id);
      if (!point) continue;
      if (Math.hypot(point.x - x, point.y - y) <= node.radius + 6) {
        return { type: 'node', id: node.id, node };
      }
    }
    let best = null;
    let bestDistance = 7;
    for (const hit of state.lineHits) {
      const distance = distanceToSegment(x, y, hit.a, hit.b);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { type: 'line', id: hit.line.key, line: hit.line };
      }
    }
    return best;
  }

  function showTooltip(hit, clientX, clientY) {
    if (!hit) {
      tooltipEl.hidden = true;
      return;
    }
    tooltipEl.replaceChildren();
    if (hit.type === 'node') {
      tooltipEl.append(el('strong', '', hit.node.name));
      tooltipEl.append(el('div', 'w3d-muted', `${hit.node.degree} relation${hit.node.degree === 1 ? '' : 's'} · ${hit.node.kind}`));
    } else {
      const from = state.nodeById.get(hit.line.from);
      const to = state.nodeById.get(hit.line.to);
      tooltipEl.append(el('strong', '', `${from ? from.name : hit.line.from} ↔ ${to ? to.name : hit.line.to}`));
      tooltipEl.append(el('div', 'w3d-muted',
        `${hit.line.relations.length} relation${hit.line.relations.length === 1 ? '' : 's'} · ${hit.line.family} · ${hit.line.accepted ? 'accepted' : 'needs review'}`));
    }
    const rect = canvas.getBoundingClientRect();
    tooltipEl.hidden = false;
    const width = tooltipEl.offsetWidth || 220;
    const height = tooltipEl.offsetHeight || 60;
    tooltipEl.style.left = `${Math.min(rect.width - width - 10, Math.max(10, clientX - rect.left + 14))}px`;
    tooltipEl.style.top = `${Math.min(rect.height - height - 10, Math.max(10, clientY - rect.top + 14))}px`;
  }

  async function loadMap() {
    if (state.fetching) return;
    state.fetching = true;
    statusEl.textContent = 'loading…';
    try {
      const query = isolatedToggle.checked ? '?isolated=1' : '';
      const res = await fetch(`/api/web/map${query}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const laid = layout(data);
      state.nodes = laid.nodes;
      state.lines = laid.lines;
      state.nodeById = laid.byId;
      state.topLabels = new Set([...state.nodes]
        .sort((a, b) => b.degree - a.degree || a.id - b.id)
        .slice(0, 8)
        .map((node) => node.id));
      state.selected = null;
      state.hover = null;
      panel.hidden = true;
      tooltipEl.hidden = true;
      fitView();
      const relationCount = state.lines.reduce((sum, line) => sum + line.relations.length, 0);
      const accepted = state.lines.reduce(
        (sum, line) => sum + line.relations.filter((relation) => relation.status === 'accepted').length,
        0,
      );
      const review = relationCount - accepted;
      const isolated = state.nodes.filter((node) => node.degree === 0).length;
      countsEl.innerHTML = [
        `<span><strong>${state.nodes.length}</strong> entities</span>`,
        `<span><strong>${state.lines.length}</strong> pair lines</span>`,
        `<span><strong>${relationCount}</strong> relations</span>`,
        `<span><strong>${accepted}</strong> accepted</span>`,
        `<span><strong>${review}</strong> needs review</span>`,
        isolated ? `<span><strong>${isolated}</strong> isolated</span>` : '',
      ].join('');
      statusEl.textContent = 'live';
      draw();
    } catch (error) {
      statusEl.textContent = 'offline';
    } finally {
      state.fetching = false;
    }
  }

  canvas.addEventListener('pointerdown', (event) => {
    state.dragging = true;
    state.dragDistance = 0;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (state.dragging) {
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      state.panX += dx;
      state.panY += dy;
      state.dragDistance += Math.abs(dx) + Math.abs(dy);
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      tooltipEl.hidden = true;
      state.hover = null;
      draw();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(event.clientX - rect.left, event.clientY - rect.top);
    const previous = state.hover;
    const next = hit ? { type: hit.type, id: hit.id } : null;
    const changed = (!previous && next) || (previous && !next)
      || (previous && next && (previous.type !== next.type || previous.id !== next.id));
    state.hover = next;
    if (changed) draw();
    showTooltip(hit, event.clientX, event.clientY);
  });

  canvas.addEventListener('pointerleave', () => {
    tooltipEl.hidden = true;
    if (state.hover) {
      state.hover = null;
      draw();
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    if (state.dragging && state.dragDistance < 4) {
      const rect = canvas.getBoundingClientRect();
      const hit = hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (hit) {
        state.selected = { type: hit.type, id: hit.id };
        if (hit.type === 'node') showPerson(hit.node.id);
        else showLine(hit.line);
        draw();
      }
    }
    state.dragging = false;
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const oldZoom = state.zoom;
    const nextZoom = Math.max(0.35, Math.min(4, oldZoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    const wx = state.centerX + (mx - width / 2 - state.panX) / (state.fit * oldZoom);
    const wy = state.centerY + (my - height / 2 - state.panY) / (state.fit * oldZoom);
    state.zoom = nextZoom;
    state.panX = mx - width / 2 - (wx - state.centerX) * state.fit * nextZoom;
    state.panY = my - height / 2 - (wy - state.centerY) * state.fit * nextZoom;
    draw();
  }, { passive: false });

  document.getElementById('w3d-reset').addEventListener('click', () => {
    fitView();
    draw();
  });

  document.getElementById('w3d-close').addEventListener('click', () => {
    panel.hidden = true;
    state.selected = null;
    draw();
  });

  isolatedToggle.addEventListener('change', () => {
    loadMap();
  });

  resize();
  loadMap();
})();
