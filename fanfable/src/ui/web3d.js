/* Evidence web · 3D (read-only). No external scripts. */
(() => {
  'use strict';

  const canvas = document.getElementById('w3d-canvas');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('w3d-status');
  const countsEl = document.getElementById('w3d-counts');
  const feedEl = document.getElementById('w3d-feed');
  const panel = document.getElementById('w3d-panel');
  const detailEl = document.getElementById('w3d-detail');
  const evidenceEl = document.getElementById('w3d-evidence-list');
  const tooltipEl = document.getElementById('w3d-tooltip');
  const filter = {
    people: document.getElementById('f-people'),
    pairs: document.getElementById('f-pairs'),
    births: document.getElementById('f-births'),
    meetings: document.getElementById('f-meetings'),
    open: document.getElementById('f-open'),
    all: document.getElementById('f-all'),
  };

  const state = {
    graph: null,
    nodes: [],
    links: [],
    byId: new Map(),
    personByName: new Map(),
    lastRev: '',
    selected: null,
    selectedView: null,
    yaw: 0.6,
    pitch: -0.25,
    zoom: 1,
    autoRotate: true,
    dragging: false,
    lastX: 0,
    lastY: 0,
    fetching: false,
    openCounts: new Map(),
    previousCounts: null,
  };

  const COLORS = {
    person: '#5aa9a1',
    pair: '#8a7bc8',
    born: '#d09a4a',
    membership: 'rgba(120,130,140,.35)',
    meeting: 'rgba(90,169,161,.75)',
    birth: 'rgba(208,154,74,.8)',
    text: '#e6e8ea',
    dim: 'rgba(230,232,234,.55)',
  };

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  function hashUnit(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) / 4294967296);
  }

  function layout(graph) {
    const nodes = graph.nodes.map((node) => ({ ...node, x: 0, y: 0, z: 0, appear: 0 }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const personByName = new Map();
    for (const node of nodes) {
      if (node.kind === 'person') personByName.set(node.label.toLowerCase(), node);
    }
    const people = nodes.filter((node) => node.kind === 'person');
    const golden = Math.PI * (3 - Math.sqrt(5));
    const maxSeq = Math.max(1, ...nodes.map((node) => node.periodFromSeq || 0));
    people.forEach((node, index) => {
      const y = 1 - (index / Math.max(1, people.length - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * index;
      let radius = 1;
      if (node.temporal === 'historical') radius = 0.72;
      else if (node.temporal === 'uncertain') radius = 0.8;
      else if (node.temporal === 'unknown') radius = 0.88;
      if (node.periodFromSeq) radius *= 1 - 0.25 * Math.min(1, node.periodFromSeq / maxSeq);
      node.x = Math.cos(theta) * r * radius;
      node.y = y * radius;
      node.z = Math.sin(theta) * r * radius;
      node.radius = radius;
    });

    const membership = graph.links.filter((link) => link.kind === 'membership');
    for (const node of nodes) {
      if (node.kind !== 'pair') continue;
      const link = membership.find((entry) => entry.source === node.id);
      const member = link ? byId.get(link.target) : null;
      const other = personByName.get((node.bName || '').toLowerCase());
      const points = [member, other].filter(Boolean);
      if (points.length) {
        const mx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const my = points.reduce((sum, p) => sum + p.y, 0) / points.length;
        const mz = points.reduce((sum, p) => sum + p.z, 0) / points.length;
        node.x = mx * 0.94;
        node.y = my * 0.94;
        node.z = mz * 0.94;
      } else {
        const angle = hashUnit(node.id) * Math.PI * 2;
        node.x = Math.cos(angle) * 0.6;
        node.y = 0;
        node.z = Math.sin(angle) * 0.6;
      }
    }

    const birthLinks = graph.links.filter((link) => link.kind === 'birth');
    for (const node of nodes) {
      if (node.kind !== 'born') continue;
      const parents = birthLinks
        .filter((link) => link.target === node.id)
        .map((link) => byId.get(link.source))
        .filter(Boolean);
      if (parents.length) {
        const mx = parents.reduce((sum, p) => sum + p.x, 0) / parents.length;
        const my = parents.reduce((sum, p) => sum + p.y, 0) / parents.length;
        const mz = parents.reduce((sum, p) => sum + p.z, 0) / parents.length;
        node.x = mx * 1.1 + 0.18;
        node.y = my * 1.1 + 0.14;
        node.z = mz * 1.1 + 0.18;
      } else {
        const angle = hashUnit(node.id) * Math.PI * 2;
        node.x = Math.cos(angle) * 0.9;
        node.y = 0.2;
        node.z = Math.sin(angle) * 0.9;
      }
    }

    const byIdFinal = new Map(nodes.map((node) => [node.id, node]));
    const links = graph.links.filter((link) => byIdFinal.has(link.source) && byIdFinal.has(link.target));
    return { nodes, links, byId: byIdFinal, personByName };
  }

  function rotatePoint(node) {
    const cy = Math.cos(state.yaw);
    const sy = Math.sin(state.yaw);
    const cp = Math.cos(state.pitch);
    const sp = Math.sin(state.pitch);
    const x1 = node.x * cy - node.z * sy;
    const z1 = node.x * sy + node.z * cy;
    const y1 = node.y * cp - z1 * sp;
    const z2 = node.y * sp + z1 * cp;
    return { x: x1, y: y1, z: z2 };
  }

  function projectPoint(point) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const perspective = 3.2;
    const depth = perspective / (perspective + point.z);
    const scale = Math.min(width, height) * 0.42 * state.zoom * depth;
    return {
      x: width / 2 + point.x * scale,
      y: height / 2 + point.y * scale,
      scale: depth,
      depth: point.z,
    };
  }

  function visibleNode(node) {
    if (node.kind === 'person' && !filter.people.checked) return false;
    if (node.kind === 'pair' && !filter.pairs.checked) return false;
    if (node.kind === 'born' && !filter.births.checked) return false;
    if (state.nodes.length > 800 && node.kind === 'pair' && !filter.all.checked && state.zoom < 1.8) return false;
    return true;
  }

  function draw(now) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.clearRect(0, 0, width, height);
    const projected = new Map();
    for (const node of state.nodes) {
      if (!visibleNode(node)) continue;
      projected.set(node.id, projectPoint(rotatePoint(node)));
    }

    for (const link of state.links) {
      if (link.kind === 'meeting' && !filter.meetings.checked) continue;
      const a = projected.get(link.source);
      const b = projected.get(link.target);
      if (!a || !b) continue;
      ctx.strokeStyle = link.kind === 'meeting'
        ? COLORS.meeting
        : link.kind === 'birth' ? COLORS.birth : COLORS.membership;
      ctx.lineWidth = Math.max(0.5, Math.min(3, 0.6 + Math.log2((link.weight || 1) + 1)));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const ordered = [...state.nodes]
      .filter((node) => visibleNode(node))
      .map((node) => ({ node, point: projected.get(node.id) }))
      .filter((entry) => entry.point)
      .sort((a, b) => b.point.depth - a.point.depth);

    for (const { node, point } of ordered) {
      const base = node.kind === 'person' ? 6 : node.kind === 'born' ? 5 : 4;
      const radius = Math.max(1.6, base * point.scale * (1 + Math.min(1, node.degree / 8)));
      const appear = node.appear ? Math.min(1, (now - node.appear) / 600) : 1;
      ctx.globalAlpha = appear;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = node.kind === 'person' ? COLORS.person : node.kind === 'born' ? COLORS.born : COLORS.pair;
      ctx.fill();
      if (state.selected === node.id) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const open = state.openCounts.get(node.threadId) || 0;
      if (open && filter.open.checked) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(208,154,74,.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (state.zoom > 1.15 || node.kind === 'person' && state.nodes.length < 120 || state.selected === node.id) {
        ctx.fillStyle = COLORS.text;
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(node.label, point.x + radius + 4, point.y + 3);
      }
      ctx.globalAlpha = 1;
    }
    state.projected = projected;
  }

  function frame(now) {
    if (state.autoRotate && !state.dragging) state.yaw += 0.0022;
    draw(now);
    requestAnimationFrame(frame);
  }

  function countText(counts) {
    return [
      ['people', counts.personThreads],
      ['pairs', counts.pairThreads],
      ['notes', counts.notes],
      ['meetings', counts.meetings],
      ['births', counts.births],
      ['open ends', counts.openEnds],
    ].map(([label, value]) => `<span><strong>${value}</strong> ${label}</span>`).join('');
  }

  function pushFeed(deltas) {
    if (!deltas.length) return;
    const line = document.createElement('div');
    line.textContent = deltas.map(([label, value]) => `+${value} ${label}`).join(' · ');
    feedEl.prepend(line);
    while (feedEl.children.length > 6) feedEl.lastChild.remove();
    setTimeout(() => line.remove(), 9000);
  }

  function diffCounts(previous, next) {
    if (!previous) return [];
    return [
      ['person threads', next.personThreads - previous.personThreads],
      ['pair threads', next.pairThreads - previous.pairThreads],
      ['notes', next.notes - previous.notes],
      ['meetings', next.meetings - previous.meetings],
      ['births', next.births - previous.births],
      ['open ends', next.openEnds - previous.openEnds],
    ].filter(([, value]) => value > 0);
  }

  async function loadGraph(refetch) {
    if (state.fetching) return;
    state.fetching = true;
    try {
      const params = new URLSearchParams({ limit: '1500', notes: '1' });
      if (filter.all.checked) params.set('all', '1');
      if (!refetch && state.lastRev) params.set('rev', state.lastRev);
      const res = await fetch(`/api/web/graph?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`graph ${res.status}`);
      const data = await res.json();
      if (data.unchanged) {
        statusEl.textContent = 'live';
        return;
      }
      const previousCounts = state.previousCounts;
      state.lastRev = data.revision;
      state.openCounts = new Map((data.openEnds || []).map((row) => [row.threadId, row.questionCount]));
      const previousIds = new Set(state.nodes.map((node) => node.id));
      const laid = layout(data);
      const now = performance.now();
      for (const node of laid.nodes) {
        if (!previousIds.has(node.id)) node.appear = now;
      }
      state.graph = data;
      state.nodes = laid.nodes;
      state.links = laid.links;
      state.byId = laid.byId;
      state.personByName = laid.personByName;
      state.previousCounts = data.counts;
      countsEl.innerHTML = countText(data.counts);
      renderEvidenceList(data);
      pushFeed(diffCounts(previousCounts, data.counts));
      statusEl.textContent = 'live';
      if (state.selected && state.byId.has(state.selected)) {
        const node = state.byId.get(state.selected);
        if (state.selectedView === 'person' && node.entityId != null) showPerson(node.entityId);
        else showDetail(node.threadId);
      }
    } catch (error) {
      statusEl.textContent = 'offline';
    } finally {
      state.fetching = false;
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function truncate(text, max = 140) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function renderEvidenceList(graph) {
    const rows = (graph.nodes || [])
      .filter((node) => node.notes > 0)
      .sort((a, b) => b.notes - a.notes || a.threadId - b.threadId)
      .slice(0, 30);
    if (!rows.length) {
      evidenceEl.replaceChildren(el('p', 'w3d-muted', 'no evidence notes yet'));
      return;
    }
    evidenceEl.replaceChildren(...rows.map((node) => {
      const button = el('button', 'w3d-evidence-row');
      button.type = 'button';
      const head = el('div', 'w3d-evidence-head');
      head.append(el('strong', '', node.label));
      head.append(el('span', 'w3d-muted', `${node.notes} note${node.notes === 1 ? '' : 's'}`));
      button.append(head);
      if (node.firstNote) {
        button.append(el('q', 'w3d-evidence-quote', truncate(node.firstNote.quote)));
        if (node.firstNote.locator) button.append(el('span', 'w3d-muted', node.firstNote.locator));
      }
      button.addEventListener('click', () => showDetail(node.threadId));
      return button;
    }));
  }

  async function showDetail(threadId) {
    state.selected = `t:${threadId}`;
    state.selectedView = 'thread';
    panel.hidden = false;
    detailEl.replaceChildren(el('p', 'w3d-muted', 'loading…'));
    try {
      const res = await fetch(`/api/web/thread?id=${encodeURIComponent(threadId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const nodes = [];
      const thread = data.thread;
      nodes.push(el('h2', '', thread.label));
      nodes.push(el('div', 'w3d-muted', `${thread.kind} · ${thread.status} · ${thread.temporal}${thread.period ? ` · ${thread.period}` : ''}`));
      if (thread.aName || thread.bName) nodes.push(el('div', 'w3d-muted', [thread.aName, thread.bName].filter(Boolean).join(' / ')));
      nodes.push(el('h3', '', `Notes (${data.notes.length})`));
      if (!data.notes.length) nodes.push(el('p', 'w3d-muted', 'no notes yet — investigation open'));
      for (const note of data.notes) {
        const card = el('div', 'w3d-note');
        card.append(el('q', '', note.quote));
        const meta = [note.locator, note.claimKind, note.strength ? note.strength.toFixed(2) : '', note.strengthSource, note.isContext ? 'context' : ''].filter(Boolean).join(' · ');
        if (meta) card.append(el('div', 'w3d-muted', meta));
        if (note.missing) card.append(el('div', 'w3d-warn', note.missing));
        nodes.push(card);
      }
      if (data.openEnds.length) {
        nodes.push(el('h3', '', `Open ends (${data.openEnds.length})`));
        for (const open of data.openEnds) {
          const card = el('div', 'w3d-note');
          card.append(el('div', '', open.question));
          card.append(el('div', 'w3d-muted', `${open.status}${open.wouldResolve ? ` · resolves: ${open.wouldResolve}` : ''}`));
          nodes.push(card);
        }
      }
      if (data.meetings.length) {
        nodes.push(el('h3', '', `Meetings (${data.meetings.length})`));
        for (const meeting of data.meetings) {
          nodes.push(el('div', 'w3d-muted', `with thread ${meeting.otherThreadId} · ${meeting.notesExchanged} notes · ${meeting.status}`));
        }
      }
      detailEl.replaceChildren(...nodes);
    } catch (error) {
      detailEl.replaceChildren(el('p', 'w3d-muted', 'Could not load thread.'));
    }
  }

  async function showPerson(entityId) {
    state.selectedView = 'person';
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
      detailEl.replaceChildren(...nodes);
    } catch (error) {
      detailEl.replaceChildren(el('p', 'w3d-muted', 'Could not load person.'));
    }
  }

  function hitTest(clientX, clientY, radius = 22) {
    if (!state.projected) return null;
    let best = null;
    let bestDistance = radius;
    for (const [id, point] of state.projected) {
      const distance = Math.hypot(point.x - clientX, point.y - clientY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = id;
      }
    }
    return best;
  }

  canvas.addEventListener('pointerdown', (event) => {
    state.dragging = true;
    state.autoRotate = false;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!state.dragging) return;
    state.yaw += (event.clientX - state.lastX) * 0.006;
    state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch + (event.clientY - state.lastY) * 0.004));
    state.lastX = event.clientX;
    state.lastY = event.clientY;
  });
  let lastSelectAt = 0;
  let dragDistance = 0;
  function selectAt(clientX, clientY) {
    if (Date.now() - lastSelectAt < 250) return;
    const rect = canvas.getBoundingClientRect();
    const id = hitTest(clientX - rect.left, clientY - rect.top, 22);
    if (!id || !state.byId.has(id)) return;
    lastSelectAt = Date.now();
    const node = state.byId.get(id);
    if (node.kind === 'person' && node.entityId != null) {
      state.selected = id;
      showPerson(node.entityId);
    } else {
      showDetail(node.threadId);
    }
  }
  canvas.addEventListener('pointerdown', () => { dragDistance = 0; });
  canvas.addEventListener('pointermove', (event) => {
    dragDistance += Math.abs(event.movementX || 0) + Math.abs(event.movementY || 0);
    if (state.dragging) {
      tooltipEl.hidden = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const id = hitTest(event.clientX - rect.left, event.clientY - rect.top, 22);
    if (!id || !state.byId.has(id)) {
      tooltipEl.hidden = true;
      return;
    }
    const node = state.byId.get(id);
    tooltipEl.replaceChildren();
    tooltipEl.append(el('strong', '', node.label));
    tooltipEl.append(el('div', 'w3d-muted', `${node.notes} note${node.notes === 1 ? '' : 's'} · ${node.kind}`));
    if (node.firstNote) tooltipEl.append(el('q', 'w3d-tooltip-quote', truncate(node.firstNote.quote, 120)));
    tooltipEl.hidden = false;
    const width = tooltipEl.offsetWidth || 220;
    const height = tooltipEl.offsetHeight || 80;
    tooltipEl.style.left = `${Math.min(rect.width - width - 10, Math.max(10, event.clientX - rect.left + 14))}px`;
    tooltipEl.style.top = `${Math.min(rect.height - height - 10, Math.max(10, event.clientY - rect.top + 14))}px`;
  });
  canvas.addEventListener('pointerleave', () => { tooltipEl.hidden = true; });
  canvas.addEventListener('pointerup', (event) => {
    if (state.dragging && dragDistance < 4) selectAt(event.clientX, event.clientY);
    state.dragging = false;
  });
  canvas.addEventListener('click', (event) => selectAt(event.clientX, event.clientY));
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    state.autoRotate = false;
    state.zoom = Math.max(0.35, Math.min(3.2, state.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
  }, { passive: false });

  document.getElementById('w3d-reset').addEventListener('click', () => {
    state.yaw = 0.6;
    state.pitch = -0.25;
    state.zoom = 1;
    state.selected = null;
    state.selectedView = null;
    panel.hidden = true;
  });
  document.getElementById('w3d-close').addEventListener('click', () => {
    panel.hidden = true;
    state.selected = null;
    state.selectedView = null;
  });
  for (const key of ['people', 'pairs', 'births', 'meetings', 'open']) {
    filter[key].addEventListener('change', () => { /* redraw reads the filters */ });
  }
  filter.all.addEventListener('change', () => loadGraph(true));

  resize();
  requestAnimationFrame(frame);
  loadGraph(true);
  setInterval(() => {
    if (!document.hidden) loadGraph(false);
  }, 1500);
})();
