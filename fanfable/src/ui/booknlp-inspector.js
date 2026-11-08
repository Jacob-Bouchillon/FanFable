/* BookNLP inspector: the bank and the raw BookNLP clusters in one view.
 *
 * The left list is the union: every non-quarantined bank entity, plus clusters
 * BookNLP found that the bank does not have. Selecting anything filters the
 * text to the passages that contain it, so there is no scroll offset to get
 * wrong. The right pane shows the bank record and the BookNLP stats together.
 */
(() => {
  const state = {
    data: null,
    bank: [],
    entries: [],
    selected: null,
    focusQuote: null,
    query: '',
    showUnbanked: true,
    showEmpty: false,
    castOnly: true,
    wholeBook: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const esc = (value) => String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const norm = (value) => String(value).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  async function boot() {
    const [bnRes, bankRes] = await Promise.all([
      fetch('/api/booknlp', { cache: 'no-store' }),
      fetch('/api/booknlp/entities', { cache: 'no-store' }),
    ]);
    if (!bnRes.ok) {
      $('#book').innerHTML = '<div class="empty">No BookNLP output. Run the pipeline first.</div>';
      return;
    }
    state.data = await bnRes.json();
    state.bank = bankRes.ok ? await bankRes.json() : [];
    $('#stats').textContent = `${state.bank.length} bank entities · ${state.data.stats.clusters} clusters · ${state.data.stats.mentions} mentions · ${state.data.stats.quotes} quotes`;
    buildEntries();
    renderList();
    const first = state.entries.find((entry) => entry.bankId != null && entry.name === 'Harry Potter')
      ?? state.entries.find((entry) => entry.bankId != null)
      ?? state.entries[0];
    if (first) select(first.key);
  }

  /** Union of bank entities and unclaimed BookNLP clusters. */
  function buildEntries() {
    const byForm = new Map();
    for (const entity of state.bank) {
      for (const form of [entity.name, ...entity.aliases]) {
        const key = norm(form);
        if (key && !byForm.has(key)) byForm.set(key, entity);
      }
    }
    const claimed = new Set();
    const entries = [];
    for (const entity of state.bank) {
      const forms = [entity.name, ...entity.aliases].map(norm).filter(Boolean);
      let cluster = state.data.clusters.find((c) => forms.includes(norm(c.name)) && !claimed.has(c.id));
      if (!cluster) {
        cluster = state.data.clusters.find((c) => {
          if (claimed.has(c.id)) return false;
          const name = norm(c.name);
          return forms.some((form) => form === name || form.startsWith(name + ' ') || name.startsWith(form + ' '));
        });
      }
      if (cluster) claimed.add(cluster.id);
      entries.push({
        key: `e${entity.id}`,
        name: entity.name,
        kind: entity.kind,
        status: entity.status,
        aliases: entity.aliases,
        bankId: entity.id,
        hasSummary: entity.hasSummary === true,
        ties: Number(entity.ties ?? 0),
        facts: Number(entity.facts ?? 0),
        mentions: Number(entity.mentions ?? 0),
        clusterId: cluster?.id ?? null,
        mentions: cluster?.mentions ?? null,
      });
    }
    const claimedNames = new Set(
      state.data.clusters.filter((c) => claimed.has(c.id)).map((c) => norm(c.name)),
    );
    for (const cluster of state.data.clusters) {
      if (claimed.has(cluster.id) || cluster.mentions < 2 || cluster.proper === 0) continue;
      // A second cluster under the same name is the same person split in two.
      if (claimedNames.has(norm(cluster.name))) continue;
      entries.push({
        key: `c${cluster.id}`,
        name: cluster.name,
        kind: 'booknlp',
        status: '',
        aliases: [],
        bankId: null,
        clusterId: cluster.id,
        mentions: cluster.mentions,
      });
    }
    const order = { character: 0, creature: 1, species: 2, faction: 3, location: 4, item: 5, rule: 6, booknlp: 7 };
    state.entries = entries.sort((left, right) =>
      (order[left.kind] ?? 8) - (order[right.kind] ?? 8) || left.name.localeCompare(right.name));
  }

  function visibleEntries() {
    const query = state.query.toLowerCase();
    return state.entries.filter((entry) => {
      if (!state.showUnbanked && entry.kind === 'booknlp') return false;
      if (!state.showEmpty && entry.bankId != null && entry.ties === 0 && entry.facts === 0 && !entry.hasSummary) return false;
      // The cast is the people with relationships; the rest are minor names.
      if (state.castOnly && entry.kind === 'character' && entry.ties === 0 && entry.mentions < 5) return false;
      if (!query) return true;
      return entry.name.toLowerCase().includes(query)
        || entry.aliases.some((alias) => alias.toLowerCase().includes(query));
    }).slice(0, 900);
  }

  function renderList() {
    const entries = visibleEntries();
    if (!entries.length) {
      $('#clusters').innerHTML = '<div class="empty">Nothing matches.</div>';
      return;
    }
    const counts = new Map();
    for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    const order = ['character', 'creature', 'species', 'faction', 'location', 'item', 'rule', 'booknlp'];
    const label = (kind) => kind === 'booknlp' ? 'BookNLP only' : kind[0].toUpperCase() + kind.slice(1) + 's';
    let html = '';
    let current = '';
    for (const kind of order) {
      if (!counts.has(kind)) continue;
      if (kind !== current) {
        html += `<div class="group">${esc(label(kind))} <span>${counts.get(kind)}</span></div>`;
        current = kind;
      }
      for (const entry of entries.filter((item) => item.kind === kind)) {
        html += `
        <div class="cluster" data-key="${entry.key}" role="button" aria-selected="${entry.key === state.selected?.key}">
          <span class="dot"></span>
          <span class="name">${esc(entry.name)}</span>
          <span class="count">${entry.kind === 'booknlp' ? entry.mentions : ''}</span>
        </div>`;
      }
    }
    $('#clusters').innerHTML = html;
  }

  function clusterSpans(id) {
    const spans = [];
    for (const mention of state.data.mentions) if (mention.c === id) spans.push({ s: mention.s, e: mention.e, quote: false });
    for (const quote of state.data.quotes) if (quote.c === id) spans.push({ s: quote.s, e: quote.e, quote: true });
    return spans;
  }

  /** Name/alias occurrences for a bank entity BookNLP did not cluster. */
  function nameSpans(entry) {
    const text = state.data.text;
    const spans = [];
    for (const form of [entry.name, ...(entry.aliases ?? [])]) {
      if (form.length < 3) continue;
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi');
      let match;
      while ((match = pattern.exec(text)) && spans.length < 400) {
        spans.push({ s: match.index, e: match.index + form.length, quote: false });
      }
    }
    return spans;
  }

  function selectionSpans(entry) {
    if (entry.clusterId != null) return clusterSpans(entry.clusterId);
    return nameSpans(entry);
  }

  function renderBook(spans) {
    const text = state.data.text;
    if (state.wholeBook || !spans.length) {
      $('#book').innerHTML = text.split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
      return;
    }
    const ordered = spans
      .sort((left, right) => left.s - right.s || right.e - left.e || Number(right.quote) - Number(left.quote));
    const kept = [];
    let lastEnd = -1;
    for (const span of ordered) {
      if (span.s < lastEnd) continue;
      kept.push(span);
      lastEnd = span.e;
    }
    const starts = new Set(kept.map((span) => span.s));
    const paragraphs = text.split(/\n{2,}/);
    let offset = 0;
    const hits = [];
    for (const paragraph of paragraphs) {
      const from = offset;
      const to = offset + paragraph.length;
      offset = to + 2;
      const inside = kept.filter((span) => span.s >= from && span.e <= to);
      if (!inside.length) continue;
      let html = '';
      let cursor = from;
      for (const span of inside) {
        html += esc(text.slice(cursor, span.s));
        html += `<mark class="mk${span.quote ? ' qt' : ''} sel">${esc(text.slice(span.s, span.e))}</mark>`;
        cursor = span.e;
      }
      html += esc(text.slice(cursor, to));
      hits.push(html);
    }
    $('#book').innerHTML = `<div class="filter-note">${hits.length} passage${hits.length === 1 ? '' : 's'}</div>`
      + (hits.length ? hits.map((html) => `<p>${html}</p>`).join('') : '<div class="empty">No passage contains this.</div>');
    void starts;
  }

  async function select(key) {
    const entry = state.entries.find((item) => item.key === key);
    if (!entry) return;
    state.selected = entry;
    state.focusQuote = null;
    state.wholeBook = false;
    for (const row of document.querySelectorAll('#clusters .cluster')) {
      row.setAttribute('aria-selected', String(row.dataset.key === key));
    }
    renderBook(selectionSpans(entry));
    await renderDetail(entry);
  }

  function clusterOf(entry) {
    return entry.clusterId == null ? null : state.data.clusters.find((c) => c.id === entry.clusterId);
  }

  async function renderDetail(entry) {
    const cluster = clusterOf(entry);
    const parts = [];
    parts.push(`<h2>${esc(entry.name)}</h2>`);
    if (entry.bankId != null) {
      parts.push(`<div class="muted">bank entity ${entry.bankId} · ${esc(entry.kind)}${entry.status ? ' · ' + esc(entry.status) : ''}</div>`);
    } else {
      parts.push('<div class="muted">BookNLP only — not in the bank</div>');
    }

    if (entry.bankId != null) {
      try {
        const res = await fetch(`/api/web/person?id=${entry.bankId}`, { cache: 'no-store' });
        if (res.ok) {
          const person = await res.json();
          const extra = person.extra ?? {};
          const span = extra.firstChapter
            ? (extra.lastChapter && extra.lastChapter !== extra.firstChapter
              ? `chapters ${extra.firstChapter}–${extra.lastChapter}`
              : `chapter ${extra.firstChapter}`)
            : 'no chapter';
          parts.push(`<div class="row"><span>ties</span><span>${person.counts.total} (${person.counts.accepted} accepted)</span></div>`);
          parts.push(`<div class="row"><span>scenes</span><span>${extra.events?.length ?? 0}</span></div>`);
          parts.push(`<div class="row"><span>${span}</span><span>${esc(extra.status ?? '')}</span></div>`);
          const attrs = extra.attributes ?? {};
          if (Object.keys(attrs).length) {
            parts.push(`<div class="row"><span>facts</span><span>${Object.entries(attrs).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(', ')}</span></div>`);
          }
          const facts = extra.facts ?? [];
          if (facts.length) {
            parts.push(`<h3>Facts (${facts.length})</h3>`);
            for (const fact of facts) {
              parts.push(`<div class="quote">${esc(fact.statement)}</div>`);
            }
          }
          const ties = (person.groups ?? []).flatMap((group) => group.ties).slice(0, 20);
          if (ties.length) {
            parts.push('<h3>Bank ties</h3>');
            for (const tie of ties) {
              const arrow = tie.direction === 'out' ? '→' : '←';
              parts.push(`<div class="quote"><strong>${esc(tie.kind)} ${arrow} ${esc(tie.counterpart?.name ?? '')}</strong><br>${esc(String(tie.quote ?? '').slice(0, 180))}</div>`);
            }
          }
        }
      } catch {
        parts.push('<div class="muted">bank detail unavailable</div>');
      }
    }

    if (cluster) {
      parts.push(`<h3>BookNLP cluster</h3>`);
      parts.push(`<div class="row"><span>mentions</span><span>${cluster.mentions}</span></div>`);
      parts.push(`<div class="row"><span>proper</span><span>${cluster.proper}</span></div>`);
      parts.push(`<div class="row"><span>nominal</span><span>${cluster.nominal}</span></div>`);
      parts.push(`<div class="row"><span>pronoun</span><span>${cluster.pronoun}</span></div>`);
      const forms = cluster.forms.slice(0, 30).map(([form, count]) =>
        `<div class="form"><span>${esc(form)}</span><span class="muted">${count}</span></div>`).join('');
      parts.push(`<h3>Surface forms</h3>${forms || '<div class="muted">none</div>'}`);
      const quotes = cluster.quotes.slice(0, 30).map((quote, index) =>
        `<div class="quote" data-i="${index}">${esc(quote.text)}</div>`).join('');
      if (quotes) parts.push(`<h3>Attributed quotes (${cluster.quotes.length})</h3>${quotes}`);
    }

    $('#detail').innerHTML = parts.join('');
    for (const element of document.querySelectorAll('#detail .quote[data-i]')) {
      element.addEventListener('click', () => {
        const quote = cluster?.quotes[Number(element.dataset.i)];
        if (!quote) return;
        state.focusQuote = quote.start;
        renderBook([{ s: quote.start, e: quote.end, quote: true }]);
      });
    }
  }

  $('#clusters').addEventListener('click', (event) => {
    const row = event.target.closest('.cluster');
    if (row) select(row.dataset.key);
  });
  $('#search').addEventListener('input', (event) => {
    state.query = event.target.value.trim();
    renderList();
  });
  $('#unbanked').addEventListener('change', (event) => {
    state.showUnbanked = event.target.checked;
    renderList();
  });
  $('#cast').addEventListener('change', (event) => {
    state.castOnly = event.target.checked;
    renderList();
  });
  $('#empty').addEventListener('change', (event) => {
    state.showEmpty = event.target.checked;
    renderList();
  });
  $('#whole').addEventListener('change', (event) => {
    state.wholeBook = event.target.checked;
    renderBook(state.selected ? selectionSpans(state.selected) : []);
  });

  boot();
})();
