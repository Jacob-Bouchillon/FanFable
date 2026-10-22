/* fanforge UI — application logic.
   Plain ES modules-free JS, no build step. Views are functions that render
   into #content; state lives in one object at the top. */

const state = {
  session: null,
  view: 'dashboard',
  projectId: null,
  data: {},
  selectedChapter: null,
};

/* ------------------------------------------------------------------ util */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `request failed (${res.status})`);
  return data;
}

function toast(title, body = '', kind = '') {
  const node = el(`
    <div class="toast ${kind}">
      <div class="toast-title">${esc(title)}</div>
      ${body ? `<div class="toast-body">${esc(body)}</div>` : ''}
    </div>`);
  $('#toasts').appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 320);
  }, 4600);
}

function setPage(title, sub, actions = '') {
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub;
  $('#topbar-actions').innerHTML = actions;
}

function emptyState(title, body, actionHtml = '') {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(body)}</p>${actionHtml}</div>`;
}

function statCard(value, label, view) {
  const attr = view ? `data-goto="${esc(view)}"` : '';
  return `<div class="stat ${view ? 'clickable' : ''}" ${attr}>
    <div class="stat-value">${esc(value)}</div>
    <div class="stat-label">${esc(label)}</div>
  </div>`;
}

/* ------------------------------------------------------------------ jobs */

const modal = {
  backdrop: null,
  open(title) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = '<div class="spinner"></div><p class="muted" id="modal-message">starting</p>';
    $('#modal-foot').hidden = true;
    $('#modal-backdrop').hidden = false;
  },
  message(text) {
    const m = $('#modal-message');
    if (m) m.textContent = text;
  },
  result(html, title) {
    if (title) $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('#modal-foot').hidden = false;
  },
  close() {
    $('#modal-backdrop').hidden = true;
  },
};

/** Run a server job, showing progress in the modal until it finishes. */
async function runJob(path, body, title, onDone) {
  modal.open(title);
  try {
    const { jobId } = await api(path, { method: 'POST', body: body ?? {} });
    for (;;) {
      const job = await api(`/api/jobs/${jobId}`);
      if (job.status === 'running') {
        modal.message(job.message || 'working');
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      if (job.status === 'error') throw new Error(job.error || 'job failed');
      if (onDone) onDone(job.result);
      return job.result;
    }
  } catch (err) {
    modal.result(`<p class="muted">${esc(err.message)}</p>`);
    throw err;
  }
}

/* ---------------------------------------------------------------- router */

const VIEWS = {
  dashboard: { title: 'Dashboard', sub: 'Where the story stands right now', render: viewDashboard },
  sources: { title: 'Sources', sub: 'The original material this story is built on', render: viewSources },
  lore: { title: 'Lore research', sub: 'Search and question the canon', render: viewLore },
  canon: { title: 'Canon events', sub: 'The index of scenes the AU can adapt', render: viewCanon },
  booklore: { title: 'Book lore', sub: 'What the source material establishes, extracted and cited', render: viewBookLore },
  gaps: { title: 'Lore gaps', sub: 'What the index is probably missing', render: viewLoreGaps },
  conflicts: { title: 'Conflicts', sub: 'Chapters that disagree with the established story', render: viewConflicts },
  graph: { title: 'Graph', sub: 'What connects to what', render: viewGraph },
  plan: { title: 'Plan', sub: 'Premise, divergence point and chapter outlines', render: viewPlan },
  write: { title: 'Write', sub: 'Draft, revise and approve chapters', render: viewWrite },
  state: { title: 'Story state', sub: 'Characters, timeline, threads and what is established', render: viewState },
  issues: { title: 'Continuity', sub: 'Problems found in the story so far', render: viewIssues },
  settings: { title: 'Settings', sub: 'Model and engine configuration', render: viewSettings },
};

async function navigate(view) {
  if (!VIEWS[view]) view = 'dashboard';
  state.view = view;
  location.hash = `#/${view}`;
  modal.close();
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  setPage(VIEWS[view].title, VIEWS[view].sub);
  $('#content').innerHTML = '<div class="skeleton-list"><div class="skeleton"></div><div class="skeleton"></div></div>';
  try {
    if (state.session && !state.session.currentProjectId && !state.session.projects.length) {
      renderFirstRun();
      return;
    }
    await VIEWS[view].render();
  } catch (err) {
    $('#content').innerHTML = emptyState('Something went wrong', err.message);
  }
}

/** The database is empty: the first thing to do is create a project. */
function renderFirstRun() {
  setPage('Welcome', 'Nothing here yet — create your first project');
  $('#content').innerHTML = `
    <div class="section">
      <div class="empty">
        <h3>Start a story</h3>
        <p>A project holds one story: the source material you import, the plan, the chapters,
           and everything the engine remembers about them.</p>
        <div class="row" style="justify-content:center;margin-top:var(--s4)">
          <input class="input" id="first-project" placeholder="project name" style="max-width:280px" />
          <button class="btn btn-primary" id="first-create">Create project</button>
        </div>
      </div>
    </div>`;
  const create = async () => {
    const name = $('#first-project').value.trim();
    if (!name) return;
    const res = await api('/api/session/project', { method: 'POST', body: { name } });
    state.projectId = res.currentProjectId;
    await loadSession();
    toast('Project created', res.name, 'ok');
    refresh();
  };
  $('#first-create').addEventListener('click', create);
  $('#first-project').addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
}

function refresh() {
  return navigate(state.view);
}

/* ------------------------------------------------------------- dashboard */

async function viewDashboard() {
  const d = await api('/api/dashboard');
  const c = d.counts;
  const chapters = d.chapters;

  const progress = chapters.length
    ? Math.round((chapters.filter((x) => x.status === 'approved').length / chapters.length) * 100)
    : 0;

  $('#content').innerHTML = `
    <div class="section">
      <div class="grid grid-4">
        ${statCard(chapters.filter((x) => x.status === 'approved').length + '/' + chapters.length, 'Chapters approved', 'write')}
        ${statCard(c.sources, 'Sources', 'sources')}
        ${statCard(c.characters, 'Characters', 'state')}
        ${statCard(c.openIssues, 'Open issues', 'issues')}
      </div>
    </div>

    <div class="section">
      <div class="section-head"><div class="section-title">The story</div>
        ${d.outline ? `<button class="btn btn-sm" data-goto="plan">Open the plan</button>` : ''}
      </div>
      ${d.outline ? `
        <div class="card">
          <div class="card-head">
            <div class="card-title">${esc(d.project.name)}</div>
            <div class="row">
              <span class="tag ${d.outline.status === 'approved' ? 'tag-ok' : 'tag-warning'}">outline v${d.outline.version} · ${esc(d.outline.status)}</span>
            </div>
          </div>
          <p>${esc(d.outline.premise || 'No premise yet.')}</p>
          <div class="card-tight" style="background:var(--bg-sunken);border-radius:var(--radius-sm);border:1px solid var(--border)">
            <div class="field-label">Divergence point</div>
            <div>${esc(d.outline.divergence || 'Not decided yet.')}</div>
          </div>
        </div>` :
        emptyState('No plan yet', 'Draft a premise and a divergence point, then approve the outline before writing.',
          '<button class="btn btn-primary" data-goto="plan">Go to the plan</button>')}
    </div>

    <div class="section">
      <div class="section-head"><div class="section-title">Chapters</div>
        <div class="row"><span class="muted small">${progress}% approved</span>
        <button class="btn btn-sm btn-primary" data-goto="write">Write next chapter</button></div>
      </div>
      ${chapters.length ? `
        <div class="table-scroll">
        <table class="table">
          <thead><tr><th>#</th><th>Title</th><th>Status</th><th>Words</th></tr></thead>
          <tbody>
            ${chapters.map((ch) => `
              <tr data-goto="write" data-chapter="${ch.number}">
                <td class="mono">${ch.number}</td>
                <td>${esc(ch.title || 'Untitled')}</td>
                <td><span class="tag ${ch.status === 'approved' ? 'tag-ok' : 'tag-warning'}">${esc(ch.status)}</span></td>
                <td class="mono">${ch.words}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>` :
        '<div class="card muted">No chapters yet. The first one starts after the outline is approved.</div>'}
    </div>

    <div class="section">
      <div class="section-head"><div class="section-title">Recent context requests</div>
        <button class="btn btn-sm btn-ghost" data-goto="state">All requests</button></div>
      <div class="card">
        ${d.recentRequests.length ? d.recentRequests.map((r) => `
          <div class="row-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
            <div class="row">
              <span class="tag tag-accent">${esc(r.kind)}</span>
              <span class="small">${esc(r.query)}</span>
            </div>
            <span class="faint small">${r.result_count} results</span>
          </div>`).join('') :
          '<div class="muted small">The writer has not asked for anything yet.</div>'}
      </div>
    </div>`;

  setPage('Dashboard', d.project.name, `<button class="btn" data-goto="lore">Ask the canon</button>
    <button class="btn btn-primary" data-goto="write">Write</button>`);
}

/* --------------------------------------------------------------- sources */

async function viewSources() {
  const d = await api('/api/sources');

  $('#content').innerHTML = `
    <div class="section">
      <div class="section-head"><div class="section-title">Imported material</div></div>
      ${d.sources.length ? d.sources.map((s) => `
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${esc(s.title)}</div>
              <div class="card-sub mono">${esc(s.path)}</div>
            </div>
            <div class="row">
              <span class="tag">${esc(s.format)}</span>
              ${s.pageCount ? `<span class="tag">${s.pageCount} pages</span>` : ''}
              <span class="tag">${s.chunks} passages</span>
            </div>
          </div>
          <div class="row small faint">
            <span>${(s.byteSize / 1024).toFixed(1)} KB</span>
            <span>imported ${new Date(s.importedAt).toLocaleString()}</span>
          </div>
        </div>`).join('') :
        emptyState('No sources yet', 'Import the books or reference material this story should be built on.')}
    </div>

    <div class="section">
      <div class="section-head"><div class="section-title">Add a source</div></div>
      <div class="card">
        <div class="field">
          <label class="field-label" for="file-input">Files (.pdf, .epub, .docx, .txt, .md)</label>
          <input class="input" id="file-input" type="file" multiple />
          <div class="field-hint">PDFs, EPUBs and Word files are read on this machine, page by page, so
            passages can cite a page. Nothing is sent anywhere.</div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <button class="btn btn-primary" id="import-btn" disabled>Import</button>
          <span class="muted small" id="import-status"></span>
        </div>
      </div>
    </div>`;

  const input = $('#file-input');
  const btn = $('#import-btn');
  input.addEventListener('change', () => {
    btn.disabled = input.files.length === 0;
    $('#import-status').textContent = input.files.length ? `${input.files.length} file(s) selected` : '';
  });
  btn.addEventListener('click', async () => {
    const files = [...input.files];
    if (!files.length) return;
    const payload = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      payload.push({ name: f.name, contentBase64: btoa(binary) });
    }
    try {
      const res = await runJob('/api/sources/import', { files: payload }, 'Importing sources');
      modal.close();
      const pages = res.imported.reduce((n, s) => n + (s.pages || 0), 0);
      toast(
        'Imported',
        `${res.imported.length} source(s) added to the canon${pages ? `, ${pages} pages` : ''}.`,
        'ok',
      );
      refresh();
    } catch { /* modal shows the error */ }
  });
}

/* ------------------------------------------------------------------ lore */

async function viewLore() {
  $('#content').innerHTML = `
    <div class="section">
      <div class="section-head"><div class="section-title">Search the canon</div></div>
      <div class="card">
        <div class="row" style="flex-wrap:nowrap">
          <input class="input" id="lore-q" placeholder="e.g. the third lantern, what Ilsa promised" />
          <button class="btn" id="lore-search">Search</button>
        </div>
        <div id="lore-results" style="margin-top:var(--s3)"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><div class="section-title">Ask a question</div></div>
      <div class="card">
        <div class="field">
          <label class="field-label" for="lore-question">Question about the source material</label>
          <textarea class="input" id="lore-question" placeholder="Who is Kade, and what does he know about the wardens?"></textarea>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <button class="btn btn-primary" id="lore-ask">Ask</button>
          <span class="muted small">Answers cite the passages they come from, and say when the source does not settle something.</span>
        </div>
        <div id="lore-answer" style="margin-top:var(--s3)"></div>
      </div>
    </div>`;

  const runSearch = async () => {
    const q = $('#lore-q').value.trim();
    if (!q) return;
    const d = await api('/api/lore?q=' + encodeURIComponent(q));
    $('#lore-results').innerHTML = d.passages.length
      ? d.passages.map((p, i) => `
        <div class="passage">
          <div class="passage-head">
            <span class="tag tag-accent">S${i + 1}</span>
            <strong>${esc(p.sourceTitle)}</strong>
            <span class="faint small mono">${esc(p.locator)}</span>
          </div>
          <div class="passage-body">${esc(p.text)}</div>
        </div>`).join('')
      : '<div class="muted small">No passages matched. Try different words, or import more material.</div>';
  };

  $('#lore-search').addEventListener('click', runSearch);
  $('#lore-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

  $('#lore-ask').addEventListener('click', async () => {
    const question = $('#lore-question').value.trim();
    if (!question) return;
    const res = await runJob('/api/lore/ask', { question }, 'Searching the canon');
    const body = `
      <div class="card">
        <div class="prose" style="max-height:none">${esc(res.answer)}</div>
      </div>
      <div class="section-title" style="margin:var(--s4) 0 var(--s2)">Sources used</div>
      ${res.passages.map((p, i) => `<div class="small muted">[S${i + 1}] ${esc(p.sourceTitle)} · ${esc(p.locator)}</div>`).join('')}`;
    modal.result(body, 'Answer');
  });
}

/* ----------------------------------------------------------------- canon */

async function viewCanon() {
  const d = await api('/api/canon-events');
  $('#content').innerHTML = `
    <div class="section">
      <div class="section-head">
        <div class="section-title">Canon event index</div>
        <button class="btn btn-sm" id="extract-btn">Rebuild the index</button>
      </div>
      <div class="card muted small" style="margin-bottom:var(--s3)">
        These are the scenes found in the original material. The story can link its own events to them, so an
        adapted scene stays distinguishable from the original.
      </div>
      ${d.events.length ? d.events.map((e) => `
        <div class="card">
          <div class="card-head">
            <div class="card-title">${esc(e.title)}</div>
            <div class="row">
              <span class="tag">${esc(e.kind)}</span>
              <span class="tag">#${e.id}</span>
            </div>
          </div>
          ${e.summary ? `<p class="small">${esc(e.summary)}</p>` : ''}
          <div class="row small faint">
            ${e.sourceTitle ? `<span class="mono">${esc(e.sourceTitle)} · ${esc(e.locator)}</span>` : ''}
            ${e.participants.length ? `<span>who: ${esc(e.participants.join(', '))}</span>` : ''}
            ${e.location ? `<span>where: ${esc(e.location)}</span>` : ''}
            ${e.timeLabel ? `<span>when: ${esc(e.timeLabel)}</span>` : ''}
          </div>
        </div>`).join('') :
        emptyState('No canon events yet', 'Index the source material so the story can point at the scenes it adapts.',
          '<button class="btn btn-primary" id="extract-btn-2">Build the index</button>')}
    </div>`;

  const extract = async () => {
    const res = await runJob('/api/canon-events/extract', {}, 'Indexing canon events');
    modal.close();
    toast('Canon indexed', `${res.count} events found.`, 'ok');
    refresh();
  };
  const b1 = $('#extract-btn');
  const b2 = $('#extract-btn-2');
  if (b1) b1.addEventListener('click', extract);
  if (b2) b2.addEventListener('click', extract);
}

/* ------------------------------------------------------------------ plan */
async function viewPlan() {
  const d = await api('/api/plan');
  const o = d.outline;

  const outlineSection = o ? `
    <div class="section">
      <div class="section-head">
        <div class="section-title">Outline</div>
        <div class="row">
          <span class="tag ${o.status === 'approved' ? 'tag-ok' : 'tag-warning'}">v${o.version} · ${esc(o.status)}</span>
          ${o.status !== 'approved' ? '<button class="btn btn-sm btn-primary" id="approve-btn">Approve the outline</button>' : ''}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">Premise</div></div>
        <p>${esc(o.premise || '—')}</p>
        <div class="divider"></div>
        <div class="card-head"><div class="card-title">AU divergence point</div>
          ${o.divergenceRef ? `<span class="tag">${esc(o.divergenceRef)}</span>` : ''}</div>
        <p>${esc(o.divergence || 'Not decided.')}</p>
        ${o.structure.length ? `<div class="divider"></div><div class="card-title" style="margin-bottom:var(--s2)">Structure</div>
          <ol class="muted" style="margin:0;padding-left:var(--s5)">${o.structure.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">Chapter outlines</div><span class="muted small">${o.chapters.length} chapters</span></div>
        ${o.chapters.map((ch) => `
          <div style="padding:var(--s3) 0;border-bottom:1px solid var(--border)">
            <div class="row">
              <span class="tag tag-accent">Ch ${ch.number}</span>
              <strong>${esc(ch.title)}</strong>
              <span class="faint small">${ch.targetWords} words</span>
            </div>
            ${ch.goal ? `<div class="small muted" style="margin-top:4px">Goal: ${esc(ch.goal)}</div>` : ''}
            ${ch.synopsis ? `<p class="small" style="margin:6px 0 0">${esc(ch.synopsis)}</p>` : ''}
            ${(ch.canon ?? []).length ? `<div class="small" style="margin-top:6px"><span class="tag">canon</span> ${ch.canon.map((c) => esc(c)).join(' · ')}</div>` : ''}
            ${(ch.au ?? []).length ? `<div class="small" style="margin-top:4px"><span class="tag tag-accent">au</span> ${ch.au.map((c) => esc(c)).join(' · ')}</div>` : ''}
            ${(ch.openQuestions ?? []).length ? `<div class="small" style="margin-top:4px;color:var(--warning)"><span class="tag tag-warning">open</span> ${ch.openQuestions.map((q) => esc(q)).join(' · ')}</div>` : ''}
            ${ch.scenes.length ? `<div class="small muted" style="margin-top:6px">Scenes: ${ch.scenes.map((s) => esc(s.title || s.summary)).join(' · ')}</div>` : ''}
            ${ch.characters.length ? `<div class="small muted">Characters: ${esc(ch.characters.join(', '))}</div>` : ''}
            ${ch.notes ? `<div class="small" style="color:var(--warning);margin-top:4px">Note: ${esc(ch.notes)}</div>` : ''}
          </div>`).join('')}
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">Revise the plan</div></div>
        <div class="field">
          <label class="field-label" for="revise-instruction">What should change?</label>
          <textarea class="input" id="revise-instruction" placeholder="Make chapter two colder and shorter"></textarea>
          <div class="field-hint">Leave the chapter number empty to revise the whole plan. Chapters you do not target are left untouched.</div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <input class="input" id="revise-chapter" type="number" min="1" placeholder="chapter #" style="width:120px" />
          <button class="btn" id="revise-btn">Revise</button>
        </div>
      </div>
    </div>` : '';

  const chatSection = `
    <div class="section">
      <div class="section-head"><div class="section-title">Talk to the planner</div></div>
      <div class="card">
        <div class="chat" id="chat">
          ${d.messages.map((m) => `
            <div class="msg ${m.role === 'user' ? 'user' : ''}">
              <div class="msg-role">${m.role === 'user' ? 'you' : 'planner'}</div>
              <div class="msg-body">${esc(m.content)}</div>
            </div>`).join('') || '<div class="muted small">No conversation yet. Ask about the premise, the divergence point or a chapter.</div>'}
        </div>
        <div class="row" style="margin-top:var(--s3);flex-wrap:nowrap">
          <input class="input" id="chat-input" placeholder="Ask about the story…" />
          <button class="btn" id="chat-send">Send</button>
        </div>
      </div>
    </div>`;

  const draftSection = `
    <div class="section">
      <div class="section-head"><div class="section-title">${o ? 'Draft a new outline' : 'Start the story'}</div></div>
      ${o ? '' : '<div class="card muted small" style="margin-bottom:var(--s3)">Write a premise and the point where your story leaves the original, or talk it through with the planner first. Either way, the result is a proposal — nothing is established until you approve it.</div>'}
      <div class="card">
        <div class="grid grid-2">
          <div class="field" style="grid-column:1/-1">
            <label class="field-label" for="premise">Premise</label>
            <textarea class="input" id="premise" placeholder="Who does what, and what changes because of it."></textarea>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="field-label" for="divergence">Divergence point</label>
            <textarea class="input" id="divergence" placeholder="The exact moment this story leaves the original."></textarea>
          </div>
          <div class="field">
            <label class="field-label" for="chapter-count">Chapters</label>
            <input class="input" id="chapter-count" type="number" min="1" max="40" value="6" />
          </div>
          <div class="field">
            <label class="field-label" for="tone">Tone</label>
            <input class="input" id="tone" placeholder="cold, rain-soaked, restrained" />
          </div>
          <div class="field">
            <label class="field-label" for="pov">Point of view</label>
            <input class="input" id="pov" placeholder="third person limited" />
          </div>
          <div class="field">
            <label class="field-label" for="notes">Extra notes</label>
            <input class="input" id="notes" placeholder="anything the planner should know" />
          </div>
        </div>
        <div class="row" style="margin-top:var(--s4)">
          <button class="btn btn-primary" id="draft-btn">Draft the outline</button>
          <span class="muted small">The result is a proposal. Nothing is established until you approve it.</span>
        </div>
      </div>
    </div>`;

  // With no outline yet the draft form comes first: that is the next step.
  $('#content').innerHTML = o ? `${outlineSection}${chatSection}${draftSection}` : `${draftSection}${chatSection}`;

  const approve = $('#approve-btn');
  if (approve) approve.addEventListener('click', async () => {
    await runJob('/api/plan/approve', {}, 'Approving the outline');
    modal.close();
    toast('Outline approved', 'It is now the established plan.', 'ok');
    refresh();
  });

  const revise = $('#revise-btn');
  if (revise) revise.addEventListener('click', async () => {
    const instruction = $('#revise-instruction').value.trim();
    if (!instruction) return;
    const chapter = $('#revise-chapter').value;
    const res = await runJob('/api/plan/revise', { instruction, chapter: chapter ? Number(chapter) : undefined }, 'Revising the outline');
    modal.close();
    toast('Plan revised', 'Review it, then approve it to make the change official.', 'ok');
    refresh();
  });

  const send = async () => {
    const input = $('#chat-input');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    const res = await runJob('/api/plan/discuss', { message }, 'Thinking with the planner');
    modal.close();
    const chat = $('#chat');
    chat.insertAdjacentHTML('beforeend', `
      <div class="msg user"><div class="msg-role">you</div><div class="msg-body">${esc(message)}</div></div>
      <div class="msg"><div class="msg-role">planner</div><div class="msg-body">${esc(res.reply)}</div></div>`);
    chat.scrollTop = chat.scrollHeight;
  };
  $('#chat-send').addEventListener('click', send);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  $('#draft-btn').addEventListener('click', async () => {
    const premise = $('#premise').value.trim();
    if (!premise) { toast('A premise is needed', 'Tell the planner what the story is about.', 'error'); return; }
    const res = await runJob('/api/plan/draft', {
      premise,
      divergence: $('#divergence').value.trim(),
      chapters: Number($('#chapter-count').value) || 6,
      tone: $('#tone').value.trim(),
      pov: $('#pov').value.trim(),
      notes: $('#notes').value.trim(),
    }, 'Drafting the outline');
    modal.close();
    if (res.warnings?.length) {
      toast('Some canon references were dropped', res.warnings.join('; '), 'error');
    } else {
      toast('Draft outline ready', 'Review it, then approve it.', 'ok');
    }
    refresh();
  });
}
async function viewWrite() {
  const d = await api('/api/chapters');
  const chapters = d.chapters;
  if (!state.selectedChapter || !chapters.some((c) => c.number === state.selectedChapter)) {
    state.selectedChapter = chapters.length ? chapters[chapters.length - 1].number : null;
  }

  const render = () => {
    const selected = chapters.find((c) => c.number === state.selectedChapter);
    $('#content').innerHTML = `
      <div class="section">
        <div class="section-head">
          <div class="section-title">Chapters</div>
          <div class="row">
            <span class="muted small">${chapters.filter((c) => c.status === 'approved').length}/${chapters.length} approved</span>
            <button class="btn btn-sm btn-primary" id="write-next">Write the next chapter</button>
          </div>
        </div>
        ${chapters.length ? `
        <div class="chapter-list">
          ${chapters.map((c) => `
            <div class="chapter-item ${c.number === state.selectedChapter ? 'selected' : ''} ${c.status === 'approved' ? 'approved' : ''}" data-ch="${c.number}">
              <div class="chapter-num">${c.number}</div>
              <div class="chapter-meta" style="flex:1">
                <div class="chapter-name">${esc(c.title || 'Untitled')}</div>
                <div class="chapter-summary">${esc(c.summary || 'No summary yet')}</div>
              </div>
              <span class="tag ${c.status === 'approved' ? 'tag-ok' : 'tag-warning'}">${esc(c.status)}</span>
              <span class="faint small mono">${c.words}w</span>
            </div>`).join('')}
        </div>` :
        emptyState('Nothing written yet', 'Approve the outline first, then the next chapter can be written.',
          '<button class="btn" data-goto="plan">Go to the plan</button>')}
      </div>

      <div class="section" id="chapter-panel"></div>`;

    $$('.chapter-item').forEach((item) => item.addEventListener('click', () => {
      state.selectedChapter = Number(item.dataset.ch);
      render();
      loadChapter();
    }));

    $('#write-next').addEventListener('click', () => writeChapter(null));
    if (selected) loadChapter();
  };

  const loadChapter = async () => {
    const n = state.selectedChapter;
    if (!n) return;
    const ch = await api('/api/chapter?n=' + n);
    const panel = $('#chapter-panel');
    if (!panel) return;
    panel.innerHTML = `
      <div class="section-head">
        <div class="section-title">Chapter ${ch.number} — ${esc(ch.title || 'Untitled')}</div>
        <div class="row">
          <span class="tag ${ch.status === 'approved' ? 'tag-ok' : 'tag-warning'}">${esc(ch.status)}</span>
          <span class="faint small">${ch.wordCount} words</span>
        </div>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:var(--s3)">
          ${ch.status !== 'approved' ? '<button class="btn btn-sm btn-primary" id="approve-ch">Approve &amp; remember</button>' : ''}
          <button class="btn btn-sm" id="edit-ch">Edit text</button>
          <button class="btn btn-sm" id="regen-ch">Regenerate</button>
          <button class="btn btn-sm" id="check-ch">Check continuity</button>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="delete-ch">Delete</button>
        </div>
        <div class="prose" id="chapter-body">${esc(ch.body) || '<span class="faint">This chapter is empty.</span>'}</div>
      </div>`;

    $('#approve-ch')?.addEventListener('click', async () => {
      const res = await runJob('/api/chapter/approve', { number: n }, 'Approving the chapter');
      modal.close();
      toast('Chapter approved', 'Story memory and continuity state updated.', 'ok');
      await refresh();
      modal.open(`Chapter ${res.chapter.number} approved`);
      modal.result(`
        <p class="muted small">${res.chapter.wordCount} words. The chapter is now part of the story's memory:
        summary, character states, knowledge, relationships, threads and the timeline were updated.</p>
        ${res.issues?.length ? `<div class="section-title" style="margin:var(--s4) 0 var(--s2)">Continuity notes</div>${issueList(res.issues)}` : '<p class="muted small">No continuity problems found.</p>'}`,
        'Approved');
    });

    $('#edit-ch')?.addEventListener('click', () => {
      const body = $('#chapter-body').textContent;
      openEditor(n, body);
    });
    $('#regen-ch')?.addEventListener('click', () => writeChapter(n));
    $('#check-ch')?.addEventListener('click', async () => {
      const res = await runJob('/api/chapter/check', { number: n }, 'Checking continuity');
      modal.result(issueList(res.issues) || '<p class="muted">No problems found.</p>', 'Continuity report');
    });
    $('#delete-ch')?.addEventListener('click', async () => {
      if (!confirm(`Delete chapter ${n}? The text and its memory records are removed.`)) return;
      await api('/api/chapter/delete', { method: 'POST', body: { number: n } });
      state.selectedChapter = null;
      toast('Chapter deleted');
      refresh();
    });
  };

  const openEditor = (n, body) => {
    modal.open(`Edit chapter ${n}`);
    modal.result(`
      <div class="field">
        <label class="field-label" for="editor">Chapter text</label>
        <textarea class="input code" id="editor">${esc(body)}</textarea>
        <div class="field-hint">Saving keeps the previous version as a revision. The chapter returns to draft, so memory is not updated until you approve it again.</div>
      </div>
      <div class="row" style="margin-top:var(--s3)">
        <button class="btn btn-primary" id="save-edit">Save</button>
        <button class="btn" id="cancel-edit">Cancel</button>
      </div>`);
    $('#cancel-edit').addEventListener('click', modal.close);
    $('#save-edit').addEventListener('click', async () => {
      const text = $('#editor').value;
      const res = await api('/api/chapter/edit', { method: 'POST', body: { number: n, body: text } });
      modal.close();
      toast('Saved', res.impacted?.length
        ? `Chapters ${res.impacted.join(', ')} mention this material and may need a look.`
        : 'The chapter is a draft until you approve it.', 'ok');
      refresh();
    });
  };

  const writeChapter = async (n) => {
    const res = await runJob('/api/chapter/write', { number: n ?? undefined }, 'Writing the chapter');
    modal.close();
    const trace = res.trace?.length
      ? `<div class="section-title" style="margin-bottom:var(--s2)">What the writer asked for</div>
         ${res.trace.map((t) => `<div class="small muted" style="padding:4px 0"><span class="tag tag-accent">${esc(t.request.kind)}</span> ${esc(t.request.query)}</div>`).join('')}`
      : '';
    state.selectedChapter = res.chapter.number;
    await refresh();            // re-render first: refreshing closes the modal
    modal.open(`Chapter ${res.chapter.number} written`);
    modal.result(`
      <p class="muted small">${res.chapter.wordCount} words. It is a draft until you approve it.</p>
      ${trace}
      ${res.issues?.length ? `<div class="section-title" style="margin:var(--s4) 0 var(--s2)">Continuity notes</div>${issueList(res.issues)}` : ''}`,
      'Chapter written');
  };

  render();
}
/* -------------------------------------------------------------- book lore */

const LORE_KINDS = [
  { key: '', label: 'everything' },
  { key: 'character', label: 'people' },
  { key: 'location', label: 'places' },
  { key: 'item', label: 'things' },
  { key: 'rule', label: 'rules' },
  { key: 'faction', label: 'factions' },
];

async function viewBookLore() {
  const kind = state.loreKind ?? '';
  const d = await api('/api/book-lore' + (kind ? `?kind=${kind}` : ''));
  const s = d.stats ?? {};

  $('#content').innerHTML = `
    <div class="section">
      <div class="grid grid-4">
        ${statCard(s.entities ?? 0, 'Entities', 'booklore')}
        ${statCard(s.relations ?? 0, 'Relationships', 'booklore')}
        ${statCard(s.facts ?? 0, 'Facts', 'booklore')}
        ${statCard(s.timeline ?? 0, 'Timeline entries', 'booklore')}
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <div class="section-title">Extraction</div>
        <button class="btn btn-sm btn-primary" id="extract-lore">Extract the book's lore</button>
      </div>
      <div class="card muted small">
        Reads the imported passages and records the people, places, things, rules, relationships
        and facts the source establishes — each with the line it came from. The writer is grounded
        in this index, and the continuity checker uses it to catch a character who is dead in the
        book but acts in your story.
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <div class="section-title">${d.entities.length ? 'What the book establishes' : 'Nothing extracted yet'}</div>
        <div class="tabs" style="border:0;margin:0">
          ${LORE_KINDS.map((k) => `<button class="tab ${k.key === kind ? 'active' : ''}" data-kind="${k.key}">${k.label}</button>`).join('')}
        </div>
      </div>
      ${d.entities.length ? d.entities.map((e) => `
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${esc(e.name)}</div>
              <div class="card-sub">${esc(e.kind)}${e.role ? ` · ${esc(e.role)}` : ''}${e.status ? ` · ${esc(e.status)}` : ''}${e.mentions > 1 ? ` · seen ${e.mentions}×` : ''}</div>
            </div>
            <div class="row">
              <button class="btn btn-sm" data-edit-entity="${e.id}">Correct</button>
              <button class="btn btn-sm btn-ghost" data-drop-entity="${e.id}">Remove</button>
            </div>
          </div>
          ${e.summary ? `<p class="small">${esc(e.summary)}</p>` : ''}
          ${e.aliases.length ? `<div class="small faint">also: ${esc(e.aliases.join(', '))}</div>` : ''}
          ${Object.keys(e.attributes ?? {}).length ? `<div class="small faint">${Object.entries(e.attributes).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</div>` : ''}
          ${e.evidence ? `<div class="small" style="color:var(--text-faint);margin-top:6px">“${esc(e.evidence)}”${e.sourceRefs?.length ? ` <span class="faint">— ${esc(e.sourceRefs[0].source)}, ${esc(e.sourceRefs[0].locator)}</span>` : ''}</div>` : ''}
        </div>`).join('') :
        emptyState('No lore extracted yet', 'Run the extraction to turn the imported material into a structured index of people, places, rules and facts.',
          '<button class="btn btn-primary" id="extract-lore-2">Extract the book\'s lore</button>')}
    </div>

    ${d.relations.length ? `
    <div class="section">
      <div class="section-head"><div class="section-title">Relationships</div></div>
      <div class="card">
        ${d.relations.map((r) => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--border)">
          <strong>${esc(r.fromName)}</strong> → <strong>${esc(r.toName)}</strong> — ${esc(r.kind)}${r.description ? `: ${esc(r.description)}` : ''}
        </div>`).join('')}
      </div>
    </div>` : ''}

    ${d.facts.length ? `
    <div class="section">
      <div class="section-head"><div class="section-title">Facts</div></div>
      <div class="card">
        ${d.facts.map((f) => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--border)">
          ${f.topic ? `<span class="tag">${esc(f.topic)}</span> ` : ''}${esc(f.statement)}
          ${f.certainty === 'inferred' ? '<span class="tag tag-warning">inferred</span>' : ''}
        </div>`).join('')}
      </div>
    </div>` : ''}

    ${d.timeline.length ? `
    <div class="section">
      <div class="section-head"><div class="section-title">The book's timeline</div></div>
      <div class="card">
        <div class="timeline">
          ${d.timeline.map((t) => `
            <div class="tl-item">
              <div class="tl-time">${esc(t.when || 'order ' + t.seq)}</div>
              <div class="row" style="margin-top:2px"><strong>${esc(t.title)}</strong></div>
              ${t.summary ? `<div class="small muted">${esc(t.summary)}</div>` : ''}
              ${t.participants.length ? `<div class="small faint">who: ${esc(t.participants.join(', '))}</div>` : ''}
              ${t.location ? `<div class="small faint">where: ${esc(t.location)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>
    </div>` : ''}`;

  $$('.tab[data-kind]').forEach((b) => b.addEventListener('click', () => {
    state.loreKind = b.dataset.kind;
    viewBookLore();
  }));

  const extract = async () => {
    const res = await runJob('/api/book-lore/extract', {}, 'Reading the book');
    modal.close();
    toast('Lore extracted', `${res.entities} entities, ${res.relations} relationships, ${res.facts} facts.`, 'ok');
    refresh();
  };
  const b1 = $('#extract-lore');
  const b2 = $('#extract-lore-2');
  if (b1) b1.addEventListener('click', extract);
  if (b2) b2.addEventListener('click', extract);

  $$('[data-edit-entity]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.editEntity);
    const e = d.entities.find((x) => x.id === id);
    modal.open(`Correct "${e.name}"`);
    modal.result(`
      <div class="grid grid-2">
        <div class="field"><label class="field-label">Name</label><input class="input" id="e-name" value="${esc(e.name)}" /></div>
        <div class="field"><label class="field-label">Kind</label>
          <select class="input" id="e-kind">
            ${LORE_KINDS.filter((k) => k.key).map((k) => `<option value="${k.key}" ${e.kind === k.key ? 'selected' : ''}>${k.key}</option>`).join('')}
          </select></div>
        <div class="field"><label class="field-label">Role</label><input class="input" id="e-role" value="${esc(e.role)}" /></div>
        <div class="field"><label class="field-label">Status</label><input class="input" id="e-status" value="${esc(e.status)}" placeholder="alive, dead, missing" /></div>
      </div>
      <div class="field" style="margin-top:var(--s3)">
        <label class="field-label">Summary</label>
        <textarea class="input" id="e-summary">${esc(e.summary)}</textarea>
      </div>
      <div class="row" style="margin-top:var(--s4)">
        <button class="btn btn-primary" id="save-entity">Save</button>
        <button class="btn" id="cancel-entity">Cancel</button>
      </div>`);
    $('#cancel-entity').addEventListener('click', modal.close);
    $('#save-entity').addEventListener('click', async () => {
      await api('/api/book-lore/entity', {
        method: 'POST',
        body: {
          id,
          name: $('#e-name').value,
          kind: $('#e-kind').value,
          role: $('#e-role').value,
          status: $('#e-status').value,
          summary: $('#e-summary').value,
        },
      });
      modal.close();
      toast('Lore corrected');
      refresh();
    });
  }));

  $$('[data-drop-entity]').forEach((b) => b.addEventListener('click', async () => {
    const id = Number(b.dataset.dropEntity);
    if (!confirm('Remove this entry from the lore index?')) return;
    await api('/api/book-lore/entity/delete', { method: 'POST', body: { id } });
    toast('Removed');
    refresh();
  }));
}

/* -------------------------------------------------------------- lore gaps */

async function viewLoreGaps() {
  const d = await api('/api/lore-gaps');
  $('#content').innerHTML = `
    <div class="section">
      <div class="section-head">
        <div class="section-title">Possible gaps</div>
        <span class="muted small">${d.gaps.length} found</span>
      </div>
      <div class="card muted small" style="margin-bottom:var(--s3)">
        Nothing here has been changed. These are the places the index looks thin: characters with
        no relationships, and relationships the source states plainly that the graph does not hold.
        Check the passage, then enrich the character or correct the relation by hand.
      </div>
      ${d.gaps.length ? d.gaps.map((g) => `
        <div class="issue ${g.severity === 'warning' ? 'warning' : 'note'}">
          <div class="issue-head">
            <span class="tag tag-${g.severity === 'warning' ? 'warning' : 'note'}">${esc(g.kind)}</span>
            <strong>${esc(g.subject)}</strong>
          </div>
          <p class="issue-msg">${esc(g.message)}</p>
          ${g.evidence ? `<p class="issue-detail">${esc(g.evidence)}</p>` : ''}
          ${g.locator ? `<p class="issue-detail">at ${esc(g.locator)}</p>` : ''}
          <p class="issue-detail">${esc(g.suggestion)}</p>
        </div>`).join('') :
        '<div class="empty"><h3>No gaps found</h3><p>Every character has relationships, and no relationship the source states plainly is missing.</p></div>'}
    </div>`;
}

/* -------------------------------------------------------------- conflicts */

async function viewConflicts() {
  const d = await api('/api/conflicts');
  $('#content').innerHTML = `
    <div class="section">
      <div class="section-head">
        <div class="section-title">Open conflicts</div>
        <span class="muted small">${d.conflicts.length} found</span>
      </div>
      <div class="card muted small" style="margin-bottom:var(--s3)">
        A conflict is a chapter that says something the story has already established differently.
        Nothing established has been overwritten: both records are kept, and the conflict is here
        for you to accept or resolve.
      </div>
      ${d.conflicts.length ? d.conflicts.map((c) => `
        <div class="issue warning">
          <div class="issue-head">
            <span class="tag tag-warning">${esc(c.kind)}</span>
            <strong>${esc(c.subject)}</strong>
            ${c.chapterNumber ? `<span class="faint small">chapter ${c.chapterNumber}</span>` : ''}
          </div>
          <p class="issue-msg">${esc(c.message)}</p>
          ${c.evidence ? `<p class="issue-detail">${esc(c.evidence)}</p>` : ''}
          <p class="issue-detail">established: ${esc(c.existingRef)} · this chapter: ${esc(c.incomingRef)}</p>
          <div class="row" style="margin-top:var(--s2)">
            <button class="btn btn-sm" data-resolve="${c.id}" data-status="accepted">Accept as intended</button>
            <button class="btn btn-sm" data-resolve="${c.id}" data-status="resolved">Mark resolved</button>
          </div>
        </div>`).join('') :
        '<div class="empty"><h3>No conflicts</h3><p>Every approved chapter agrees with the story so far.</p></div>'}
    </div>`;

  $$('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/conflicts/resolve', {
      method: 'POST',
      body: { id: Number(b.dataset.resolve), resolution: b.dataset.status },
    });
    toast('Conflict updated', b.dataset.status === 'accepted' ? 'Accepted as intended.' : 'Marked resolved.', 'ok');
    refresh();
  }));
}

/* ------------------------------------------------------------------ graph */

async function viewGraph() {
  const d = await api('/api/graph');
  const kinds = Object.entries(d.stats.kinds ?? {}).sort((a, b) => b[1] - a[1]);
  const types = Object.entries(d.stats.types ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12);

  $('#content').innerHTML = `
    <div class="section">
      <div class="grid grid-3">
        ${statCard(d.stats.nodes ?? 0, 'Nodes')}
        ${statCard(d.stats.edges ?? 0, 'Connections')}
        ${statCard(d.stats.storyNodes ?? 0, 'Story nodes')}
      </div>
    </div>

    <div class="section">
      <div class="section-head"><div class="section-title">Find connections</div></div>
      <div class="card">
        <div class="row" style="flex-wrap:nowrap">
          <input class="input" id="graph-q" placeholder="a person, place or thing" />
          <select class="input" id="graph-hops" style="width:120px">
            <option value="1">1 hop</option>
            <option value="2">2 hops</option>
          </select>
          <button class="btn" id="graph-go">Traverse</button>
        </div>
        <div class="field-hint" style="margin-top:var(--s2)">
          One hop shows what a thing is directly connected to; two hops shows what
          that reaches, and so on. The writer uses the same traversal to gather
          context for a scene.
        </div>
        <div id="graph-results" style="margin-top:var(--s3)"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><div class="section-title">What is in the graph</div></div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><div class="card-title">Node kinds</div></div>
          ${kinds.map(([k, n]) => `<div class="row-between small" style="padding:3px 0"><span>${esc(k)}</span><span class="faint mono">${n}</span></div>`).join('')}
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">Connection types</div></div>
          ${types.map(([t, n]) => `<div class="row-between small" style="padding:3px 0"><span>${esc(t)}</span><span class="faint mono">${n}</span></div>`).join('')}
        </div>
      </div>
    </div>`;

  const run = async () => {
    const name = $('#graph-q').value.trim();
    if (!name) return;
    const hops = Number($('#graph-hops').value);
    const res = await api('/api/graph?name=' + encodeURIComponent(name) + '&hops=' + hops);
    const box = $('#graph-results');
    if (!res.connections.length) {
      box.innerHTML = `<p class="muted small">Nothing in the graph is connected to "${esc(name)}".</p>`;
      return;
    }
    box.innerHTML = `
      <div class="small muted" style="margin-bottom:var(--s2)">
        ${res.connections.length} connections from ${res.roots.map(esc).join(', ')} within ${hops} hop(s)
      </div>
      ${res.connections.map((c) => `
        <div class="passage" style="padding:var(--s2) var(--s3)">
          <div class="row" style="gap:var(--s2)">
            ${c.depth ? `<span class="faint mono">${'·'.repeat(c.depth)}</span>` : ''}
            <strong>${esc(c.from)}</strong>
            <span class="tag tag-accent">${esc(c.type)}</span>
            <strong>${esc(c.to)}</strong>
            ${c.scope === 'story' ? '<span class="tag">story</span>' : ''}
            ${c.confidence < 0.6 ? '<span class="tag tag-warning">uncertain</span>' : ''}
          </div>
          ${c.description ? `<div class="small muted" style="margin-top:3px">${esc(c.description)}</div>` : ''}
        </div>`).join('')}`;
  };

  $('#graph-go').addEventListener('click', run);
  $('#graph-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

/* ------------------------------------------------------------- issue list */

function issueList(issues) {
  if (!issues || !issues.length) return '<p class="muted small">No issues found.</p>';
  return issues.map((i) => `
    <div class="issue ${esc(i.severity)}">
      <div class="issue-head">
        <span class="tag tag-${i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'note'}">${esc(i.severity)}</span>
        <span class="tag">${esc(i.category)}</span>
        ${i.chapterNumber ? `<span class="faint small">chapter ${i.chapterNumber}</span>` : ''}
      </div>
      <p class="issue-msg">${esc(i.message)}</p>
      ${i.evidence ? `<p class="issue-detail"><b>evidence:</b> ${esc(i.evidence)}</p>` : ''}
      ${i.suggestion ? `<p class="issue-detail"><b>suggestion:</b> ${esc(i.suggestion)}</p>` : ''}
    </div>`).join('');
}

/* ----------------------------------------------------------------- state */

async function viewState() {
  const d = await api('/api/story-state');
  const tabs = ['characters', 'timeline', 'threads', 'facts', 'requests'];
  const active = state.stateTab || 'characters';

  const panel = {
    characters: () => `
      ${d.characters.length ? d.characters.map((c) => `
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${esc(c.name)}</div>
              ${c.aliases.length ? `<div class="card-sub">also: ${esc(c.aliases.join(', '))}</div>` : ''}
            </div>
            <button class="btn btn-sm" data-edit-char="${esc(c.name)}">Correct state</button>
          </div>
          ${c.profile ? `<p class="small">${esc(c.profile)}</p>` : ''}
          ${c.traits.length ? `<div class="row" style="margin-bottom:var(--s2)">${c.traits.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
          ${c.state ? `<div class="card-tight" style="background:var(--bg-sunken);border-radius:var(--radius-sm);border:1px solid var(--border)">
            <div class="field-label">Current state</div>
            <div class="small">${[c.state.location, c.state.condition, c.state.emotional, c.state.situation].filter(Boolean).map(esc).join(' · ') || '—'}</div>
            <div class="faint small">recorded from ${esc(c.state.source)}</div>
          </div>` : ''}
          ${c.knowledge.length ? `<div class="field-label" style="margin-top:var(--s3)">What they know</div>
            ${c.knowledge.map((k) => `<div class="small" style="padding:3px 0"><span class="tag tag-note">${esc(k.certainty)}</span> ${esc(k.fact)}</div>`).join('')}` : ''}
        </div>`).join('') : emptyState('No characters yet', 'Characters are recorded when you approve a chapter.')}
      ${d.relationships.length ? `<div class="card">
        <div class="card-head"><div class="card-title">Relationships</div></div>
        ${d.relationships.map((r) => `<div class="small" style="padding:3px 0"><strong>${esc(r.a)}</strong> &amp; <strong>${esc(r.b)}</strong> — ${esc(r.kind)}${r.description ? `: ${esc(r.description)}` : ''}</div>`).join('')}
      </div>` : ''}`,

    timeline: () => `
      <div class="card">
        <div class="card-head">
          <div class="card-title">Story timeline</div>
          <span class="muted small">events in this story, and the canon scenes they adapt</span>
        </div>
        ${d.timeline.length ? `<div class="timeline">
          ${d.timeline.map((e) => `
            <div class="tl-item ${e.kind === 'flashback' ? 'flashback' : ''}">
              <div class="tl-time">${esc(e.storyTime || 'order ' + e.storyOrder)}${e.chapterNumber ? ` · chapter ${e.chapterNumber}` : ''}</div>
              <div class="row" style="margin-top:2px">
                <strong>${esc(e.title)}</strong>
                ${e.adaptsCanonEventId ? `<span class="tag tag-accent">adapts canon #${e.adaptsCanonEventId}</span>` : ''}
                ${e.kind !== 'event' ? `<span class="tag tag-note">${esc(e.kind)}</span>` : ''}
                <button class="btn btn-sm btn-ghost" data-edit-event="${e.id}">edit</button>
              </div>
              ${e.summary ? `<div class="small muted">${esc(e.summary)}</div>` : ''}
              ${e.participants.length ? `<div class="small faint">who: ${esc(e.participants.join(', '))}</div>` : ''}
              ${e.location ? `<div class="small faint">where: ${esc(e.location)}</div>` : ''}
              ${e.divergenceNote ? `<div class="small" style="color:var(--warning)">changed from canon: ${esc(e.divergenceNote)}</div>` : ''}
            </div>`).join('')}
        </div>` : '<div class="muted small">No events yet. Approve a chapter to build the timeline.</div>'}
      </div>`,

    threads: () => `
      ${d.threads.length ? d.threads.map((t) => `
        <div class="card">
          <div class="card-head">
            <div class="card-title">${esc(t.title)}</div>
            <span class="tag ${t.status === 'open' ? 'tag-warning' : t.status === 'resolved' ? 'tag-ok' : ''}">${esc(t.status)}</span>
          </div>
          ${t.description ? `<p class="small">${esc(t.description)}</p>` : ''}
          ${t.events.length ? `<div class="small faint">events: ${esc(t.events.join(' · '))}</div>` : ''}
        </div>`).join('') : emptyState('No plot threads', 'Threads are picked up automatically when a chapter is approved.')}`,

    facts: () => `
      <div class="card">
        <div class="card-head"><div class="card-title">Established facts and decisions</div></div>
        ${d.facts.length ? d.facts.map((f) => `
          <div class="small" style="padding:5px 0;border-bottom:1px solid var(--border)">
            <span class="tag">${esc(f.kind)}</span> ${f.subject ? `<strong>${esc(f.subject)}:</strong> ` : ''}${esc(f.content)}
          </div>`).join('') : '<div class="muted small">Nothing established yet.</div>'}
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">Add a fact</div></div>
        <div class="row" style="flex-wrap:nowrap">
          <select class="input" id="fact-kind" style="width:130px">
            <option value="fact">fact</option><option value="decision">decision</option>
            <option value="promise">promise</option><option value="conflict">conflict</option>
            <option value="mystery">mystery</option>
          </select>
          <input class="input" id="fact-subject" placeholder="subject (optional)" style="width:180px" />
          <input class="input" id="fact-content" placeholder="What is established?" />
          <button class="btn" id="add-fact">Add</button>
        </div>
      </div>`,

    requests: () => `
      <div class="card">
        <div class="card-head"><div class="card-title">Context requests</div>
          <span class="muted small">what the writer asked for while writing</span></div>
        ${d.requests.length ? `<table class="table">
          <thead><tr><th>#</th><th>Kind</th><th>Query</th><th>Results</th><th>Status</th></tr></thead>
          <tbody>${d.requests.map((r) => `
            <tr><td class="mono">${r.id}</td><td><span class="tag tag-accent">${esc(r.kind)}</span></td>
            <td>${esc(r.query)}</td><td class="mono">${r.result_count}</td><td class="muted">${esc(r.status)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="muted small">No requests logged yet.</div>'}
      </div>`,
  };

  $('#content').innerHTML = `
    <div class="tabs">
      ${tabs.map((t) => `<button class="tab ${t === active ? 'active' : ''}" data-tab="${t}">${t}</button>`).join('')}
    </div>
    <div id="state-panel">${panel[active]()}</div>`;

  $$('.tab').forEach((b) => b.addEventListener('click', () => {
    state.stateTab = b.dataset.tab;
    viewState();
  }));

  $$('[data-edit-char]').forEach((b) => b.addEventListener('click', () => {
    const name = b.dataset.editChar;
    const c = d.characters.find((x) => x.name === name);
    modal.open(`Correct ${name}`);
    modal.result(`
      <div class="grid grid-2">
        <div class="field"><label class="field-label">Location</label><input class="input" id="c-loc" value="${esc(c?.state?.location ?? '')}" /></div>
        <div class="field"><label class="field-label">Condition</label><input class="input" id="c-cond" value="${esc(c?.state?.condition ?? '')}" /></div>
        <div class="field"><label class="field-label">Emotional state</label><input class="input" id="c-emo" value="${esc(c?.state?.emotional ?? '')}" /></div>
        <div class="field"><label class="field-label">Situation</label><input class="input" id="c-sit" value="${esc(c?.state?.situation ?? '')}" /></div>
      </div>
      <div class="row" style="margin-top:var(--s4)">
        <button class="btn btn-primary" id="save-char">Save</button>
        <button class="btn" id="cancel-char">Cancel</button>
      </div>`);
    $('#cancel-char').addEventListener('click', modal.close);
    $('#save-char').addEventListener('click', async () => {
      await api('/api/story-state/character', {
        method: 'POST',
        body: {
          name,
          location: $('#c-loc').value,
          condition: $('#c-cond').value,
          emotional: $('#c-emo').value,
          situation: $('#c-sit').value,
        },
      });
      modal.close();
      toast('State corrected');
      refresh();
    });
  }));

  $$('[data-edit-event]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.editEvent);
    const e = d.timeline.find((x) => x.id === id);
    modal.open('Correct timeline event');
    modal.result(`
      <div class="grid grid-2">
        <div class="field"><label class="field-label">Story order</label>
          <input class="input" id="e-order" type="number" step="0.5" value="${esc(e?.storyOrder ?? 0)}" /></div>
        <div class="field"><label class="field-label">Kind</label>
          <select class="input" id="e-kind">
            ${['event', 'scene', 'flashback', 'adaptation'].map((k) => `<option ${e?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
          </select></div>
      </div>
      <div class="field" style="margin-top:var(--s3)">
        <label class="field-label">What changed from canon</label>
        <textarea class="input" id="e-note">${esc(e?.divergenceNote ?? '')}</textarea>
      </div>
      <div class="row" style="margin-top:var(--s4)">
        <button class="btn btn-primary" id="save-event">Save</button>
        <button class="btn" id="cancel-event">Cancel</button>
      </div>`);
    $('#cancel-event').addEventListener('click', modal.close);
    $('#save-event').addEventListener('click', async () => {
      await api('/api/story-state/event', {
        method: 'POST',
        body: { id, order: $('#e-order').value, kind: $('#e-kind').value, note: $('#e-note').value },
      });
      modal.close();
      toast('Event corrected');
      refresh();
    });
  }));

  $('#add-fact')?.addEventListener('click', async () => {
    const content = $('#fact-content').value.trim();
    if (!content) return;
    await api('/api/story-state/fact', {
      method: 'POST',
      body: { kind: $('#fact-kind').value, subject: $('#fact-subject').value.trim(), content },
    });
    toast('Fact recorded', 'It is now part of the established story.', 'ok');
    refresh();
  });
}

/* ---------------------------------------------------------------- issues */

async function viewIssues() {
  const d = await api('/api/issues');
  const errors = d.issues.filter((i) => i.severity === 'error').length;

  $('#content').innerHTML = `
    <div class="section">
      <div class="section-head">
        <div class="section-title">Open issues</div>
        <span class="muted small">${d.issues.length} open${errors ? ` · ${errors} serious` : ''}</span>
      </div>
      ${d.issues.length ? d.issues.map((i) => `
        <div class="issue ${esc(i.severity)}">
          <div class="issue-head">
            <span class="tag tag-${i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'note'}">${esc(i.severity)}</span>
            <span class="tag">${esc(i.category)}</span>
            ${i.chapterNumber ? `<span class="faint small">chapter ${i.chapterNumber}</span>` : ''}
            <span class="spacer"></span>
            <button class="btn btn-sm" data-resolve="${i.id}" data-resolution="accepted">Accept</button>
            <button class="btn btn-sm" data-resolve="${i.id}" data-resolution="fixed">Mark fixed</button>
          </div>
          <p class="issue-msg">${esc(i.message)}</p>
          ${i.evidence ? `<p class="issue-detail"><b>evidence:</b> ${esc(i.evidence)}</p>` : ''}
          ${i.suggestion ? `<p class="issue-detail"><b>suggestion:</b> ${esc(i.suggestion)}</p>` : ''}
        </div>`).join('') :
        emptyState('No open issues', 'Run a continuity check on a chapter to look for problems.')}
    </div>`;

  $$('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/issues/resolve', {
      method: 'POST',
      body: { id: Number(b.dataset.resolve), resolution: b.dataset.resolution },
    });
    toast('Issue updated', b.dataset.resolution === 'fixed' ? 'Marked as fixed.' : 'Accepted as intended.');
    refresh();
  }));
}

/* -------------------------------------------------------------- settings */

async function viewSettings() {
  const d = await api('/api/settings');
  const g = d.global ?? {};
  const p = d.project ?? {};
  const c = d.continuity ?? { enabled: true, modelChecks: true, minSeverity: 'warning', onDraft: true };
  const cur = (k) => p[k] ?? g[k] ?? '';

  $('#content').innerHTML = `
    <div class="section">
      <div class="section-head"><div class="section-title">Model</div></div>
      <div class="card">
        <div class="grid grid-2">
          <div class="field">
            <label class="field-label" for="s-provider">Provider</label>
            <select class="input" id="s-provider">
              ${['ollama', 'llamacpp', 'openai', 'mock'].map((v) => `<option value="${v}" ${cur('provider') === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="s-model">Model</label>
            <input class="input" id="s-model" value="${esc(cur('model'))}" placeholder="qwen2.5:7b" />
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="field-label" for="s-base">Base URL</label>
            <input class="input" id="s-base" value="${esc(cur('baseUrl'))}" placeholder="http://127.0.0.1:11434" />
          </div>
          <div class="field">
            <label class="field-label" for="s-temp">Temperature</label>
            <input class="input" id="s-temp" type="number" step="0.05" min="0" max="2" value="${esc(cur('temperature') ?? 0.8)}" />
          </div>
          <div class="field">
            <label class="field-label" for="s-ctx">Context window</label>
            <input class="input" id="s-ctx" type="number" step="512" value="${esc(cur('contextTokens') ?? 8192)}" />
          </div>
        </div>
        <div class="row" style="margin-top:var(--s4)">
          <button class="btn btn-primary" id="save-settings">Save settings</button>
          <span class="muted small">Applies to this project and becomes the default for new ones.</span>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><div class="section-title">Continuity checking</div></div>
      <div class="card">
        <label class="checkbox" style="margin-bottom:var(--s3)">
          <input type="checkbox" id="c-enabled" ${c.enabled ? 'checked' : ''} />
          <span><strong>Check continuity</strong><br />
            <span class="muted small">Look for contradictions against the outline, the previous chapters,
            the canon and the current story state.</span></span>
        </label>
        <label class="checkbox" style="margin-bottom:var(--s3)">
          <input type="checkbox" id="c-model" ${c.modelChecks ? 'checked' : ''} />
          <span><strong>Use the model for deeper checks</strong><br />
            <span class="muted small">Catches things only reading can see — a character acting on
            information they do not have, a relationship that shifts for no reason. Costs one model
            call per chapter.</span></span>
        </label>
        <label class="checkbox" style="margin-bottom:var(--s3)">
          <input type="checkbox" id="c-ondraft" ${c.onDraft ? 'checked' : ''} />
          <span><strong>Check drafts as well as approved chapters</strong><br />
            <span class="muted small">Turn this off to only check a chapter when you approve it.</span></span>
        </label>
        <div class="field" style="max-width:320px">
          <label class="field-label" for="c-severity">Only report</label>
          <select class="input" id="c-severity">
            <option value="error" ${c.minSeverity === 'error' ? 'selected' : ''}>errors only</option>
            <option value="warning" ${c.minSeverity === 'warning' ? 'selected' : ''}>errors and warnings</option>
            <option value="note" ${c.minSeverity === 'note' ? 'selected' : ''}>everything, including notes</option>
          </select>
        </div>
        <div class="row" style="margin-top:var(--s4)">
          <button class="btn btn-primary" id="save-continuity">Save continuity settings</button>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><div class="section-title">How this works</div></div>
      <div class="card muted small">
        <p><strong>Canon is write-once.</strong> Imported sources are indexed for search and never changed by the story.</p>
        <p><strong>The story is separate.</strong> The AU has its own timeline, and links back to canon events when it adapts them.</p>
        <p><strong>Nothing is established until you approve it.</strong> Outlines and chapters are drafts; approving a chapter is what updates memory.</p>
        <p><strong>The writer can ask for more.</strong> While writing it can request canon passages, character records or story history, and the engine answers it.</p>
      </div>
    </div>`;

  $('#save-continuity').addEventListener('click', async () => {
    await api('/api/settings', {
      method: 'POST',
      body: {
        continuity: {
          enabled: $('#c-enabled').checked,
          modelChecks: $('#c-model').checked,
          onDraft: $('#c-ondraft').checked,
          minSeverity: $('#c-severity').value,
        },
      },
    });
    toast('Continuity settings saved', $('#c-enabled').checked ? 'The checker will run.' : 'The checker is off.', 'ok');
  });

  $('#save-settings').addEventListener('click', async () => {
    await api('/api/settings', {
      method: 'POST',
      body: {
        provider: $('#s-provider').value,
        model: $('#s-model').value,
        baseUrl: $('#s-base').value,
        temperature: $('#s-temp').value,
        contextTokens: $('#s-ctx').value,
      },
    });
    toast('Settings saved', 'The next model call uses them.', 'ok');
    loadSession();
  });
}

/* ----------------------------------------------------------------- boot */

async function loadSession() {
  state.session = await api('/api/session');
  state.projectId = state.session.currentProjectId;
  const sel = $('#project-select');
  sel.innerHTML = state.session.projects.length
    ? state.session.projects
        .map((p) => `<option value="${p.id}" ${p.id === state.projectId ? 'selected' : ''}>${esc(p.name)}</option>`)
        .join('')
    : '<option value="">no projects yet</option>';
  const m = state.session.model ?? {};
  $('#model-badge').textContent = `model: ${m.model ?? 'not set'}\n${m.provider ?? ''}`;
  sel.onchange = async () => {
    await api('/api/session/project', { method: 'POST', body: { id: Number(sel.value) } });
    state.projectId = Number(sel.value);
    state.selectedChapter = null;
    toast('Project switched', sel.options[sel.selectedIndex].text);
    refresh();
  };
}

document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    navigate(goto.dataset.goto);
    if (goto.dataset.chapter) {
      state.selectedChapter = Number(goto.dataset.chapter);
    }
  }
});

$('#modal-close').addEventListener('click', modal.close);
$('#modal-ok').addEventListener('click', modal.close);
$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modal-backdrop') modal.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal-backdrop').hidden) modal.close();
});

$('#new-project').addEventListener('click', () => {
  const box = $('#new-project-box');
  box.hidden = !box.hidden;
  if (!box.hidden) $('#new-project-name').focus();
});
$('#cancel-project').addEventListener('click', () => { $('#new-project-box').hidden = true; });
$('#create-project').addEventListener('click', async () => {
  const name = $('#new-project-name').value.trim();
  if (!name) return;
  const res = await api('/api/session/project', { method: 'POST', body: { name } });
  $('#new-project-name').value = '';
  $('#new-project-box').hidden = true;
  state.projectId = res.currentProjectId;
  await loadSession();
  toast('Project created', res.name, 'ok');
  refresh();
});

$$('.nav-item').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.view)));
window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#/', '');
  if (v && v !== state.view) navigate(v);
});

(async function boot() {
  await loadSession();
  const v = location.hash.replace('#/', '') || 'dashboard';
  await navigate(v);
})();
