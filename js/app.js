/* Walk in Light — app logic. Vanilla JS, no build step, no server.
 * State is saved to localStorage; export/import JSON for backups. */
(function () {
  'use strict';
  const SEED = window.WIL_SEED;
  const KEY = 'wil.state.v1';
  const XP = { S: 10, M: 25, L: 50 };
  const $ = (s, el) => (el || document).querySelector(s);
  const uid = (p) => (p || 'x') + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  const today = () => new Date().toISOString().slice(0, 10);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ───────────── state ───────────── */
  let S = load();
  const UI = { tab: 'home', sub: {}, open: new Set(), timeFilter: null, bibleFilter: 'all', bibleQuery: '', armed: null };

  function fresh() {
    return {
      v: 2, seedVersion: SEED.version, created: today(), updatedAt: new Date().toISOString(),
      pillars: JSON.parse(JSON.stringify(SEED.pillars)).map((p) => ({ ...p, milestones: p.milestones.map((m) => ({ ...m, tasks: m.tasks.map(seedTask) })) })),
      items: JSON.parse(JSON.stringify(SEED.items)),
      bible: JSON.parse(JSON.stringify(SEED.bible)),
      inbox: [], focus: null, log: [],
      settings: { glow: 'on', fs: 17, wake: '' },
    };
  }
  function seedTask(t) { return { ...t, steps: t.steps ? t.steps.slice() : [], checks: [], status: 'todo', notes: '', doneAt: null, seeded: true, edited: false }; }
  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) return migrate(JSON.parse(raw)); } catch (e) { console.warn('load failed', e); }
    return fresh();
  }
  function migrate(s) {
    if (!s.settings) s.settings = { glow: 'on', fs: 17 };
    if (!s.updatedAt) s.updatedAt = '1970-01-01T00:00:00.000Z'; // unknown age: a synced copy wins
    if (s.settings.fs && s.settings.fs >= 20) s.settings.fs = 17; // old pixel-font sizes
    s.pillars.forEach((p) => p.milestones.forEach((m) => m.tasks.forEach((t) => { if (!t.steps) t.steps = []; if (!t.checks) t.checks = []; })));
    return s;
  }
  function save(local) { if (!local) S.updatedAt = new Date().toISOString(); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Save failed. Storage may be full.'); } if (!local) syncSchedule(); }
  function commit() { save(); render(); }

  /* Merge a newer seed: add missing content, drop retired seeded tasks that were never touched,
     refresh guides on untouched seeded tasks, keep all progress. */
  function mergeSeed() {
    let added = 0, refreshed = 0, removed = 0;
    const seedIds = new Set(SEED.pillars.flatMap((p) => p.milestones.flatMap((m) => m.tasks.map((t) => t.id))));
    const seedPillarIds = new Set(SEED.pillars.map((p) => p.id));
    const seedMsIds = new Set(SEED.pillars.flatMap((p) => p.milestones.map((m) => m.id)));
    // remove retired seeded tasks the user never touched
    S.pillars.forEach((p) => p.milestones.forEach((m) => { const before = m.tasks.length; m.tasks = m.tasks.filter((t) => !(t.seeded && !t.edited && t.status === 'todo' && !t.notes && !seedIds.has(t.id))); removed += before - m.tasks.length; }));
    S.pillars.forEach((p) => { p.milestones = p.milestones.filter((m) => m.tasks.length || seedMsIds.has(m.id) || !/^(base|story|teach|lens|studio|music)-/.test(m.id)); });
    S.pillars = S.pillars.filter((p) => seedPillarIds.has(p.id) || p.milestones.some((m) => m.tasks.length));
    SEED.pillars.forEach((sp, idx) => {
      let p = S.pillars.find((x) => x.id === sp.id);
      if (!p) { p = { ...sp, milestones: [] }; S.pillars.splice(idx, 0, p); }
      ['name', 'short', 'color', 'icon', 'tagline', 'intro', 'pipeline'].forEach((k) => { if (sp[k] != null) p[k] = sp[k]; });
      sp.milestones.forEach((sm, mi) => {
        let m = p.milestones.find((x) => x.id === sm.id);
        if (!m) { m = { id: sm.id, name: sm.name, tasks: [] }; p.milestones.splice(mi, 0, m); } else m.name = sm.name;
        sm.tasks.forEach((st, ti) => {
          const t = m.tasks.find((x) => x.id === st.id);
          if (!t) { m.tasks.splice(ti, 0, seedTask(st)); added++; }
          else if (t.seeded && !t.edited) { t.title = st.title; t.guide = st.guide; t.size = st.size; t.steps = st.steps ? st.steps.slice() : []; refreshed++; }
        });
      });
    });
    SEED.items.forEach((si) => { if (!S.items.find((x) => x.id === si.id)) { S.items.push({ ...si }); added++; } });
    SEED.bible.forEach((sb) => { if (!S.bible.find((x) => x.id === sb.id)) { S.bible.push(JSON.parse(JSON.stringify(sb))); added++; } });
    S.seedVersion = SEED.version; S.v = 2;
    commit();
    toast(`Merged: ${added} added, ${refreshed} refreshed, ${removed} retired`);
  }

  /* ───────────── derived ───────────── */
  const allTasks = () => S.pillars.flatMap((p) => p.milestones.flatMap((m) => m.tasks.map((t) => ({ t, m, p }))));
  const findTask = (id) => allTasks().find((x) => x.t.id === id);
  const pillar = (id) => S.pillars.find((p) => p.id === id);
  const xp = () => allTasks().filter((x) => x.t.status === 'done').reduce((a, x) => a + (XP[x.t.size] || 10), 0);
  function level(x) { let l = 1, need = 100; while (x >= need) { x -= need; l++; need = Math.round(need * 1.3); } return { l, into: x, need }; }
  function streak() {
    const days = new Set(S.log.map((e) => e.at.slice(0, 10)));
    let n = 0; const d = new Date();
    if (!days.has(today())) d.setDate(d.getDate() - 1);
    while (days.has(d.toISOString().slice(0, 10))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  const pct = (list) => list.length ? Math.round(100 * list.filter((t) => t.status === 'done').length / list.length) : 0;
  const sizeOk = (t) => !UI.timeFilter || (UI.timeFilter === 15 ? t.size === 'S' : UI.timeFilter === 45 ? t.size !== 'L' : true);
  function nextUp(p) {
    const open = p.milestones.flatMap((m) => m.tasks.filter((t) => t.status !== 'done').map((t) => ({ t, m })));
    return open.find((x) => x.t.status === 'doing' && sizeOk(x.t)) || open.find((x) => sizeOk(x.t)) || null;
  }
  const verseOfDay = () => SEED.verses[Math.floor(Date.now() / 86400000) % SEED.verses.length];
  const colorVar = (c) => ({ blue: 'var(--blue-2)', cyan: 'var(--cyan)', violet: 'var(--violet)', gold: 'var(--gold)' }[c] || 'var(--blue-2)');
  const stepsDone = (t) => (t.steps || []).filter((_, i) => t.checks && t.checks[i]).length;

  /* ───────────── tiny markdown ───────────── */
  function md(src) {
    const lines = String(src || '').split('\n'); let out = '', list = null;
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`(.+?)`/g, '<span class="kbd">$1</span>').replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const close = () => { if (list) { out += `</${list}>`; list = null; } };
    lines.forEach((ln) => {
      let m;
      if ((m = ln.match(/^\s*[-•]\s+(.*)/))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
      else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
      else if (ln.trim() === '') { close(); }
      else { close(); out += `<p>${inline(ln)}</p>`; }
    });
    close(); return out;
  }

  /* ───────────── icons (24px line icons) ───────────── */
  const I = (d, extra) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra || ''}</svg>`;
  const ICON = {
    home: I('<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
    story: I('<path d="M12 2v4"/><path d="M8 9a4 4 0 1 1 8 0c0 2.5-2 3.5-2 5h-4c0-1.5-2-2.5-2-5z"/><path d="M10 18h4"/><path d="M11 21h2"/>'),
    teach: I('<rect x="3" y="5" width="18" height="13" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/><path d="M8 21h8"/>'),
    lens: I('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    music: I('<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
    studio: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    cross: I('<path d="M12 3v18"/><path d="M6 9h12"/>'),
    crossFill: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 2h4v6h6v4h-6v10h-4V12H4V8h6z"/></svg>',
    check: I('<path d="m5 12 5 5L20 7"/>', ''),
    dots: I('<circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>'),
    chev: I('<path d="m9 6 6 6-6 6"/>'),
    book: I('<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>'),
    settings: I('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'),
    close: I('<path d="M6 6l12 12M18 6 6 18"/>'),
    star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2 2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>',
    edit: I('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="m12.5 7.5 4 4"/>'),
    left: I('<path d="m15 6-6 6 6 6"/>'), right: I('<path d="m9 6 6 6-6 6"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
  };

  /* ───────────── render ───────────── */
  function render() {
    document.documentElement.dataset.glow = S.settings.glow === 'off' ? 'off' : 'on';
    document.documentElement.style.setProperty('--fs', (S.settings.fs || 17) + 'px');
    const app = $('#app');
    app.innerHTML = renderTop() + (UI.tab === 'home' ? renderHome() : renderPillar(pillar(UI.tab)));
    $('#nav').innerHTML = ['home', ...S.pillars.map((p) => p.id)].map((id) => {
      const p = id === 'home' ? { short: 'Home', icon: 'home', color: 'blue' } : pillar(id);
      return `<button data-action="tab" data-tab="${id}" class="${UI.tab === id ? 'on' : ''}" style="--c:${colorVar(p.color)}" aria-current="${UI.tab === id ? 'page' : 'false'}" aria-label="${esc(p.name || p.short)}">${ICON[p.icon] || ICON.home}<span>${esc(p.short)}</span></button>`;
    }).join('');
    window.scrollTo(0, UI.scrollKeep || 0); UI.scrollKeep = 0;
  }
  function renderTop() {
    const sub = UI.tab === 'home' ? 'Progress console' : pillar(UI.tab).name;
    return `<header class="topbar">
      <img class="logo" src="icons/icon-192.png" alt="">
      <h1>Walk in Light<small>${esc(sub)}</small></h1>
      <button class="iconbtn" data-action="playbook" aria-label="Playbook">${ICON.book}</button>
      <button class="iconbtn" data-action="settings" aria-label="Settings">${ICON.settings}</button>
    </header>`;
  }

  function renderHome() {
    const v = verseOfDay(); const x = xp(); const lv = level(x); const st = streak();
    const all = allTasks(); const done = all.filter((a) => a.t.status === 'done');
    const focus = S.focus && findTask(S.focus);
    const recent = S.log.slice(-5).reverse().map((e) => findTask(e.taskId)).filter(Boolean);
    const installHint = !S.settings.hideInstall && !window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone;
    return `
    <section class="verse" aria-label="Verse of the day"><div class="mark">${ICON.crossFill}</div><div><div class="text">${esc(v.text)}</div><div class="ref">${esc(v.ref)}</div></div></section>
    ${installHint ? `<section class="panel accent"><div class="row between"><h2 class="c-blue" style="margin:0">Install on iPhone</h2><button class="btn ghost sm" data-action="hide-install" aria-label="Dismiss">${ICON.close}</button></div><p class="small mt" style="margin-bottom:0">In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>. Runs offline and full screen. Free. Your data stays on this phone; export a backup monthly in Settings.</p></section>` : ''}
    <section class="panel">
      <div class="level"><span class="lv">Level ${lv.l}</span><div class="bar"><i style="width:${Math.round(100 * lv.into / lv.need)}%"></i></div><span class="n">${lv.into} / ${lv.need}</span></div>
      <div class="stats"><div class="stat"><b>${x}</b><span>Points</span></div><div class="stat"><b>${st}</b><span>Streak</span></div><div class="stat"><b>${done.length}<small style="font-size:0.9rem;color:var(--text-2)">/${all.length}</small></b><span>Done</span></div></div>
    </section>
    <section class="panel">
      <div class="row between"><h2>I have…</h2><span class="caption">${UI.timeFilter ? UI.timeFilter + ' minutes' : 'Any amount of time'}</span></div>
      <div class="chips" role="group" aria-label="Available time">${[[15, '15 min'], [45, '45 min'], [120, 'A deep block']].map(([n, l]) => `<button class="chip ${UI.timeFilter === n ? 'on' : ''}" aria-pressed="${UI.timeFilter === n}" data-action="time" data-n="${n}">${l}</button>`).join('')}</div>
    </section>
    ${focus ? `<section class="panel sacred"><h2 class="c-gold">This week's focus</h2>${taskRow(focus.t, focus.p, true)}</section>` : ''}
    <section class="panel accent">
      <h2 class="c-blue">Next up</h2>
      ${S.pillars.map((p) => { const n = nextUp(p); return `<div class="mt"><h3 style="color:${colorVar(p.color)}">${esc(p.name)}</h3>${n ? taskRow(n.t, p, true) : `<p class="caption">Nothing ${UI.timeFilter ? 'this size' : 'left'} here${UI.timeFilter ? '; try a longer slot' : ''}.</p>`}</div>`; }).join('')}
    </section>
    <section class="panel">
      <h2>Inbox</h2>
      <form data-action="inbox-add" class="row"><label class="sr" for="inbox-text">Capture an idea</label><input type="text" id="inbox-text" name="text" placeholder="Idea, line, scene, riff…" autocomplete="off"><button class="btn primary" type="submit" aria-label="Add">${ICON.plus}</button></form>
      ${S.inbox.length ? S.inbox.map((i) => `<div class="inbox-item"><span class="grow">${esc(i.text)}</span><select data-action="inbox-move" data-id="${i.id}" aria-label="Move to"><option value="">Move to…</option>${S.pillars.map((p) => `<option value="${p.id}">${esc(p.short)}</option>`).join('')}<option value="bible">Bible</option></select><button class="btn ghost sm" data-action="inbox-del" data-id="${i.id}" aria-label="Delete">${ICON.close}</button></div>`).join('') : '<p class="caption mt" style="margin-bottom:0">Capture ideas here in five seconds. Sort them once a week.</p>'}
    </section>
    <section class="panel">
      <h2>Projects</h2>
      ${S.pillars.map((p) => { const ts = p.milestones.flatMap((m) => m.tasks); return `<button class="pillarbtn" style="--c:${colorVar(p.color)}" data-action="tab" data-tab="${p.id}"><span class="ic">${ICON[p.icon]}</span><span><b>${esc(p.name)}</b><div class="caption">${esc(p.tagline)}</div><div class="bar thin"><i style="--c:${colorVar(p.color)};width:${pct(ts)}%"></i></div><div class="caption" style="margin-top:4px">${ts.filter((t) => t.status === 'done').length} of ${ts.length} steps</div></span></button>`; }).join('')}
    </section>
    ${recent.length ? `<section class="panel"><h2>Recent wins</h2>${recent.map((r) => `<div class="small row"><span class="c-ok">${ICON.check.replace('<svg', '<svg style="width:18px;height:18px"')}</span><span class="grow">${esc(r.t.title)}</span><span class="caption">${esc(r.p.short)}</span></div>`).join('')}</section>` : ''}
    <p class="caption" style="text-align:center">Walk as children of light. · content v${S.seedVersion}</p>`;
  }

  function taskRow(t, p, showPillar) {
    const mark = t.status === 'done' ? ICON.check : t.status === 'doing' ? ICON.dots : '';
    const sd = t.steps && t.steps.length ? `${stepsDone(t)}/${t.steps.length} steps` : '';
    const meta = [showPillar ? `${p.short} · ${findTask(t.id).m.name}` : '', sd, t.notes ? 'notes' : ''].filter(Boolean).join(' · ');
    const label = t.status === 'done' ? 'Done. Tap to reset' : t.status === 'doing' ? 'In progress. Tap to mark done' : 'To do. Tap to start';
    return `<div class="task ${t.status}">
      <button class="box" data-action="cycle" data-id="${t.id}" aria-label="${label}">${mark}</button>
      <button class="title" data-action="open-task" data-id="${t.id}">${esc(t.title)}${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</button>
      ${S.focus === t.id ? `<span class="pin" aria-label="Focus">${ICON.star}</span>` : ''}<span class="size ${t.size}" aria-label="Size ${t.size}">${t.size}</span>
    </div>`;
  }

  function renderPillar(p) {
    const subs = [['steps', 'Steps']]; if (p.pipeline) subs.push(['pipe', SEED.pipelines[p.pipeline].label]); if (p.id === 'story') subs.push(['bible', 'Bible']);
    const sub = UI.sub[p.id] || 'steps'; const ts = p.milestones.flatMap((m) => m.tasks); const c = colorVar(p.color);
    const body = sub === 'steps' ? renderSteps(p) : sub === 'pipe' ? renderPipeline(p) : renderBible();
    return `<section class="panel" style="--c:${c}"><div class="pillarhead"><span class="ic">${ICON[p.icon]}</span><div><h2 style="margin:0;color:${c}">${esc(p.name)}</h2><p class="caption" style="margin:2px 0 0">${esc(p.tagline)}</p></div></div><div class="bar mt"><i style="--c:${c};width:${pct(ts)}%"></i></div><div class="row between caption mt"><span>${ts.filter((t) => t.status === 'done').length} of ${ts.length} steps</span><span>${pct(ts)}%</span></div></section>
    ${subs.length > 1 ? `<div class="subtabs" role="tablist">${subs.map(([k, l]) => `<button role="tab" aria-selected="${sub === k}" class="${sub === k ? 'on' : ''}" data-action="sub" data-p="${p.id}" data-sub="${k}">${l}</button>`).join('')}</div>` : ''}
    ${body}`;
  }

  function renderSteps(p) {
    const firstOpen = p.milestones.findIndex((mm) => mm.tasks.some((t) => t.status !== 'done'));
    return `<section class="panel"><p class="small" style="margin:0">${md(p.intro).replace(/<\/?p>/g, '')}</p></section>
    ${p.milestones.map((m, i) => { const d = m.tasks.filter((t) => t.status === 'done').length; const open = UI.open.has(m.id) || (!UI.open.size && i === firstOpen);
      return `<details class="ms panel ${d === m.tasks.length && m.tasks.length ? 'complete' : ''}" ${open ? 'open' : ''} data-ms="${m.id}"><summary>${ICON.chev.replace('<svg', '<svg class="chev"')}<span class="name">${esc(m.name)}</span><span class="count">${d}/${m.tasks.length}</span><button class="btn ghost sm" data-action="edit-ms" data-id="${m.id}" aria-label="Edit milestone">${ICON.edit}</button></summary>
      <div class="body">${m.tasks.map((t) => taskRow(t, p, false)).join('')}
      <form class="row mt" data-action="task-add" data-ms="${m.id}"><label class="sr" for="add-${m.id}">Add a step</label><input type="text" id="add-${m.id}" name="title" placeholder="Add a step…" autocomplete="off"><select name="size" aria-label="Size" style="width:auto"><option>S</option><option selected>M</option><option>L</option></select><button class="btn primary" type="submit" aria-label="Add">${ICON.plus}</button></form></div></details>`; }).join('')}
    <form class="panel row" data-action="ms-add" data-p="${p.id}"><label class="sr" for="ms-${p.id}">New milestone</label><input type="text" id="ms-${p.id}" name="name" placeholder="New milestone…" autocomplete="off"><button class="btn" type="submit">Add</button></form>`;
  }

  function renderPipeline(p) {
    const pl = SEED.pipelines[p.pipeline]; const items = S.items.filter((i) => i.pillar === p.id); const c = colorVar(p.color);
    return `<section class="panel"><p class="caption" style="margin:0">Each ${esc(pl.itemNoun)} moves through: ${pl.stages.join(' → ')}. Tap a title to edit; use the arrows to move it.</p></section>
    <div class="board" style="--c:${c}">${items.length ? items.map((it) => { const last = it.stage >= pl.stages.length - 1; return `<div class="pitem ${last ? 'done' : ''}"><div class="row between"><button class="ptitle grow" data-action="open-item" data-id="${it.id}">${esc(it.title)}</button><div class="mv"><button class="btn sm" data-action="stage" data-id="${it.id}" data-d="-1" aria-label="Previous stage" ${it.stage === 0 ? 'disabled' : ''}>${ICON.left}</button><button class="btn sm ${last ? '' : 'primary'}" data-action="stage" data-id="${it.id}" data-d="1" aria-label="Next stage" ${last ? 'disabled' : ''}>${ICON.right}</button></div></div><div class="stages" aria-hidden="true">${pl.stages.map((s, i) => `<i class="${i <= it.stage ? 'on' : ''}"></i>`).join('')}</div><div class="stage">${esc(pl.stages[it.stage])}${it.notes ? ` <span class="faint">· notes</span>` : ''}</div></div>`; }).join('') : `<p class="empty">No ${esc(pl.itemNoun)}s yet.</p>`}</div>
    <form class="panel row mt" data-action="item-add" data-p="${p.id}"><label class="sr" for="item-${p.id}">New ${esc(pl.itemNoun)}</label><input type="text" id="item-${p.id}" name="title" placeholder="New ${esc(pl.itemNoun)}…" autocomplete="off"><button class="btn primary" type="submit">Add</button></form>`;
  }

  function renderBible() {
    const types = SEED.bibleTypes; const q = UI.bibleQuery.toLowerCase();
    const list = S.bible.filter((b) => (UI.bibleFilter === 'all' || b.type === UI.bibleFilter) && (!q || b.name.toLowerCase().includes(q) || Object.values(b.fields || {}).join(' ').toLowerCase().includes(q)));
    return `<section class="panel"><p class="caption">Characters, places, rules, events. Quick capture here; the deep bible lives in Obsidian.</p>
    <label class="sr" for="bible-q">Search</label><input type="text" id="bible-q" placeholder="Search the bible…" value="${esc(UI.bibleQuery)}" data-action="bible-q" autocomplete="off">
    <div class="chips mt" role="group" aria-label="Filter by type"><button class="chip ${UI.bibleFilter === 'all' ? 'on' : ''}" data-action="bible-f" data-t="all">All</button>${types.map((t) => `<button class="chip ${UI.bibleFilter === t.id ? 'on' : ''}" data-action="bible-f" data-t="${t.id}">${esc(t.label)}</button>`).join('')}</div>
    <div class="btnrow"><button class="btn primary" data-action="bible-new">${ICON.plus} New entry</button></div></section>
    ${list.length ? list.map((b) => { const ty = types.find((t) => t.id === b.type) || types[0]; const snip = Object.values(b.fields || {}).find(Boolean) || ''; return `<button class="bcard" data-action="open-bible" data-id="${b.id}"><div class="type">${esc(ty.label)}</div><div class="name">${esc(b.name)}</div><div class="snip">${esc(snip)}</div></button>`; }).join('') : '<p class="empty">Nothing here yet.</p>'}`;
  }

  /* ───────────── sheets ───────────── */
  function openSheet(html) { UI.armed = null; $('#sheet').innerHTML = `<button class="sheet-close iconbtn" data-action="close" aria-label="Close">${ICON.close}</button><div class="handle" data-action="close"></div>${html}`; $('#sheet').classList.add('open'); $('#sheet-bg').classList.add('open'); $('#sheet').scrollTop = 0; }
  function closeSheet() { $('#sheet').classList.remove('open'); $('#sheet-bg').classList.remove('open'); UI.armed = null; }

  function taskSheet(id) {
    const f = findTask(id); if (!f) return; const { t, m, p } = f;
    openSheet(`<form data-action="task-save" data-id="${t.id}">
      <h3 style="color:${colorVar(p.color)}">${esc(p.name)} · ${esc(m.name)}</h3>
      <label class="lbl" for="t-title">Step</label><input type="text" id="t-title" name="title" value="${esc(t.title)}">
      <div class="row mt"><label class="lbl" for="t-size" style="margin:0">Size</label><select id="t-size" name="size" style="width:auto"><option ${t.size === 'S' ? 'selected' : ''}>S</option><option ${t.size === 'M' ? 'selected' : ''}>M</option><option ${t.size === 'L' ? 'selected' : ''}>L</option></select><span class="caption">S 15 min · M 45 · L 90+</span></div>
      ${t.guide ? `<label class="lbl">How</label><div class="guide">${md(t.guide)}</div>` : ''}
      ${t.steps && t.steps.length ? `<label class="lbl">Tiny steps · ${stepsDone(t)}/${t.steps.length}</label><div class="steps" id="steps">${t.steps.map((s, i) => `<button type="button" class="step ${t.checks[i] ? 'on' : ''}" data-action="step" data-id="${t.id}" data-i="${i}" aria-pressed="${!!t.checks[i]}"><span class="cb">${t.checks[i] ? ICON.check : ''}</span><span class="t">${esc(s)}</span></button>`).join('')}</div>` : ''}
      <label class="lbl" for="t-notes">Your notes</label><textarea id="t-notes" name="notes" placeholder="Decisions, links, what you learned…">${esc(t.notes)}</textarea>
      <div class="btnrow"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cycle" data-id="${t.id}" data-close="1">${t.status === 'done' ? 'Mark to do' : t.status === 'doing' ? 'Mark done' : 'Start'}</button><button class="btn gold" type="button" data-action="focus" data-id="${t.id}">${S.focus === t.id ? 'Unpin' : 'Pin as focus'}</button><button class="btn danger" type="button" data-action="task-del" data-id="${t.id}">Delete</button></div>
    </form>`);
  }
  function itemSheet(id) {
    const it = S.items.find((i) => i.id === id); if (!it) return; const pl = SEED.pipelines[pillar(it.pillar).pipeline];
    openSheet(`<form data-action="item-save" data-id="${it.id}"><h3>${esc(pl.label)}</h3>
      <label class="lbl" for="i-title">Title</label><input type="text" id="i-title" name="title" value="${esc(it.title)}">
      <label class="lbl" for="i-stage">Stage</label><select id="i-stage" name="stage">${pl.stages.map((s, i) => `<option value="${i}" ${i === it.stage ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <label class="lbl" for="i-notes">Notes</label><textarea id="i-notes" name="notes">${esc(it.notes)}</textarea>
      <div class="btnrow"><button class="btn primary" type="submit">Save</button><button class="btn danger" type="button" data-action="item-del" data-id="${it.id}">Delete</button></div></form>`);
  }
  function bibleSheet(id, typeId, presetName) {
    const b = id ? S.bible.find((x) => x.id === id) : { id: '', type: typeId || 'character', name: presetName || '', fields: {} }; if (!b) return;
    const ty = SEED.bibleTypes.find((t) => t.id === b.type) || SEED.bibleTypes[0];
    openSheet(`<form data-action="bible-save" data-id="${b.id}"><h3 class="c-violet">Story bible</h3>
      <label class="lbl" for="b-type">Type</label><select id="b-type" name="type" data-action="bible-type">${SEED.bibleTypes.map((t) => `<option value="${t.id}" ${t.id === b.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
      <label class="lbl" for="b-name">Name</label><input type="text" id="b-name" name="name" value="${esc(b.name)}" placeholder="Name">
      ${ty.fields.map((f, i) => `<label class="lbl" for="b-f${i}">${esc(f)}</label><textarea id="b-f${i}" name="f:${esc(f)}" style="min-height:64px">${esc(b.fields[f] || '')}</textarea>`).join('')}
      <div class="btnrow"><button class="btn primary" type="submit">Save</button>${b.id ? `<button class="btn danger" type="button" data-action="bible-del" data-id="${b.id}">Delete</button>` : ''}</div></form>`);
  }
  function msSheet(id) {
    const p = S.pillars.find((pp) => pp.milestones.some((m) => m.id === id)); const m = p.milestones.find((x) => x.id === id); const i = p.milestones.indexOf(m);
    openSheet(`<form data-action="ms-save" data-id="${m.id}"><h3>Milestone</h3><label class="lbl" for="m-name">Name</label><input type="text" id="m-name" name="name" value="${esc(m.name)}">
      <div class="btnrow"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="ms-move" data-id="${m.id}" data-d="-1" ${i === 0 ? 'disabled' : ''}>Move up</button><button class="btn" type="button" data-action="ms-move" data-id="${m.id}" data-d="1" ${i === p.milestones.length - 1 ? 'disabled' : ''}>Move down</button><button class="btn danger" type="button" data-action="ms-del" data-id="${m.id}">Delete</button></div></form>`);
  }
  function playbookSheet() {
    openSheet(`<h3 class="c-blue">Playbook</h3><p class="caption">Solo creator practices. Read one when you feel behind.</p>${SEED.playbook.map((p) => `<details class="ms" style="padding:0"><summary>${ICON.chev.replace('<svg', '<svg class="chev"')}<span class="name">${esc(p.title)}</span></summary><div class="guide">${md(p.body)}</div></details>`).join('')}`);
  }
  function settingsSheet() {
    const canShare = !!(navigator.share);
    openSheet(`<h3 class="c-blue">Settings</h3>
      <label class="lbl">Glow effects</label><div class="chips"><button class="chip ${S.settings.glow !== 'off' ? 'on' : ''}" data-action="set-glow" data-v="on">On</button><button class="chip ${S.settings.glow === 'off' ? 'on' : ''}" data-action="set-glow" data-v="off">Off</button></div>
      <label class="lbl">Text size</label><div class="chips">${[16, 17, 18, 20].map((n) => `<button class="chip ${S.settings.fs === n ? 'on' : ''}" data-action="set-fs" data-v="${n}">${n === 16 ? 'Small' : n === 17 ? 'Default' : n === 18 ? 'Large' : 'Larger'}</button>`).join('')}</div>
      <hr class="sep"><h3>Daily reminder</h3>
      <p class="small mt">iPhone web apps cannot schedule notifications without a server, so the reminder lives in the Calendar app as a daily event with an alert.</p>
      <div class="row"><label class="sr" for="wake">Time</label><input type="text" name="wake" id="wake" value="${esc(S.settings.wake || '19:00')}" placeholder="19:00" style="width:110px" inputmode="numeric"><button class="btn primary" data-action="ics">Add to Calendar</button></div>
      <p class="caption mt">Or in the Reminders app: New Reminder, "Walk in Light: one small step", repeat daily.</p>
      <hr class="sep"><h3>Sync for daily briefs</h3>
      <p class="small mt">Saves your progress to one private GitHub repository so the scheduled briefs can read it. Create the repo (for example <b>walk-in-light-data</b>, private, empty), then a fine-grained personal access token with <b>Contents: Read and write</b> on that repo only. The token stays on this phone.</p>
      <label class="lbl" for="sync-repo">Repository (owner/name)</label><input type="text" id="sync-repo" value="${esc((S.settings.sync && S.settings.sync.repo) || '')}" placeholder="Glen-Skahill/walk-in-light-data" autocapitalize="off" autocomplete="off">
      <label class="lbl" for="sync-token">Token</label><input type="password" id="sync-token" value="${esc((S.settings.sync && S.settings.sync.token) || '')}" placeholder="github_pat_…" autocomplete="off">
      <div class="btnrow"><button class="btn primary" data-action="sync-save">Save and sync now</button>${syncCfg() ? '<button class="btn ghost" data-action="sync-off">Turn off</button>' : ''}</div>
      <p class="caption mt" id="sync-status">${esc(SYNC.status || (syncCfg() ? 'Configured' : 'Not configured'))}</p>
      <hr class="sep"><h3>Backup</h3>
      <div class="btnrow"><button class="btn primary" data-action="export">${canShare ? 'Export (share)' : 'Export JSON'}</button><label class="btn"><input type="file" accept="application/json,.json" data-action="import" style="display:none">Import JSON</label></div>
      <p class="caption mt">Export monthly into Drive. Import replaces everything on this phone with the file.</p>
      <hr class="sep"><h3>Content</h3>
      <p class="small mt">Content v${SEED.version}; your copy is from v${S.seedVersion}. Merging adds new steps, refreshes guides on steps you have not edited, retires old untouched steps, and keeps all progress.</p>
      <div class="btnrow"><button class="btn" data-action="merge">Merge latest content</button><button class="btn danger" data-action="reset">Reset everything</button></div>`);
  }

  /* ───────────── actions ───────────── */
  function cycle(id) {
    const f = findTask(id); if (!f) return; const t = f.t;
    const next = { todo: 'doing', doing: 'done', done: 'todo' }[t.status] || 'todo';
    setStatus(t, next);
    UI.scrollKeep = window.scrollY; commit();
  }
  function setStatus(t, next) {
    t.status = next;
    if (next === 'done') { t.doneAt = new Date().toISOString(); S.log.push({ taskId: t.id, at: t.doneAt }); if (S.focus === t.id) S.focus = null; if (t.steps && t.steps.length) t.checks = t.steps.map(() => true); toast(`+${XP[t.size] || 10} points · ${['Well done', 'Small things', 'Keep walking', 'One more stone'][Math.floor(Math.random() * 4)]}`); }
    else if (next === 'todo') { t.doneAt = null; S.log = S.log.filter((e) => e.taskId !== t.id); t.checks = []; }
  }
  /* two-tap delete: first tap arms the button, second tap deletes */
  function confirmTap(el, label, fn) {
    if (UI.armed === el.dataset.id) { UI.armed = null; fn(); return; }
    UI.armed = el.dataset.id; el.classList.add('armed'); el.textContent = label || 'Tap again to delete';
    setTimeout(() => { if (UI.armed === el.dataset.id) { UI.armed = null; el.classList.remove('armed'); el.textContent = 'Delete'; } }, 3000);
  }
  let toastTimer; function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200); }
  function exportJson() {
    const data = JSON.stringify(stripSecrets(S), null, 1); const name = `walk-in-light-${today()}.json`;
    const file = new File([data], name, { type: 'application/json' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Walk in Light backup' }).catch(() => {}); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function importJson(file) {
    const r = new FileReader(); r.onload = () => { try { const d = JSON.parse(r.result); if (!d.pillars) throw 0; const keep = S.settings.sync; S = migrate(d); S.settings.sync = keep; commit(); closeSheet(); toast('Imported'); } catch (e) { toast('Not a Walk in Light file'); } }; r.readAsText(file);
  }
  function ics() {
    const hhmm = ($('#wake').value || '19:00').replace(/[^0-9]/g, '').padStart(4, '0').slice(0, 4); S.settings.wake = hhmm.slice(0, 2) + ':' + hhmm.slice(2); save();
    const d = new Date(); const stamp = d.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'; const start = d.toISOString().slice(0, 10).replace(/-/g, '') + 'T' + hhmm + '00';
    const url = location.href.split('#')[0];
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Walk in Light//EN', 'BEGIN:VEVENT', `UID:wil-daily-${Date.now()}@walkinlight`, `DTSTAMP:${stamp}`, `DTSTART:${start}`, 'DURATION:PT15M', 'RRULE:FREQ=DAILY', 'SUMMARY:Walk in Light: one small step', `DESCRIPTION:Open the console and do one small step. ${url}`, `URL:${url}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0M', 'DESCRIPTION:Walk in Light', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const file = new File([body], 'walk-in-light-reminder.ics', { type: 'text/calendar' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Walk in Light reminder' }).catch(() => {}); return; }
    const a = document.createElement('a'); a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(body); a.download = 'walk-in-light-reminder.ics'; document.body.appendChild(a); a.click(); a.remove();
  }


  /* ───────────── sync (GitHub contents API, fine-grained token, one private repo) ─────────────
     Lets scheduled daily briefs read your progress. The token never leaves this phone:
     it is stripped from the uploaded file and from exports. */
  const SYNC = { timer: null, sha: null, busy: false, status: '' };
  const syncCfg = () => { const c = S.settings.sync; return c && c.token && c.repo ? c : null; };
  const ghHeaders = (c) => ({ Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
  const ghUrl = (c) => `https://api.github.com/repos/${c.repo}/contents/${c.path || 'data/state.json'}`;
  function stripSecrets(state) { const copy = JSON.parse(JSON.stringify(state)); if (copy.settings) delete copy.settings.sync; return copy; }
  function setSyncStatus(msg) { SYNC.status = msg; const el = $('#sync-status'); if (el) el.textContent = msg; }
  function syncSchedule() { if (!syncCfg()) return; clearTimeout(SYNC.timer); SYNC.timer = setTimeout(syncPush, 3000); }
  async function syncGetSha(c) {
    const r = await fetch(ghUrl(c) + '?ref=' + (c.branch || 'main'), { headers: ghHeaders(c), cache: 'no-store' });
    if (r.status === 404) return null; if (!r.ok) throw new Error('GitHub ' + r.status); const j = await r.json(); return j;
  }
  async function syncPull() {
    const c = syncCfg(); if (!c || !navigator.onLine) return;
    try {
      const j = await syncGetSha(c);
      if (!j) { setSyncStatus('Connected. No file on GitHub yet; the next change creates it.'); syncSchedule(); return; }
      SYNC.sha = j.sha;
      const remote = JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g, '')))));
      if (remote.updatedAt && (!S.updatedAt || remote.updatedAt > S.updatedAt)) { const keep = S.settings.sync; S = migrate(remote); S.settings.sync = keep; save(true); render(); toast('Updated from GitHub'); }
      setSyncStatus('Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (e) { setSyncStatus('Sync read failed: ' + e.message); }
  }
  async function syncPush(retry) {
    const c = syncCfg(); if (!c || SYNC.busy) { if (c) syncSchedule(); return; }
    if (!navigator.onLine) { setSyncStatus('Offline. Will sync when back online.'); return; }
    SYNC.busy = true; clearTimeout(SYNC.timer);
    try {
      if (SYNC.sha === null && !retry) { const j = await syncGetSha(c); SYNC.sha = j ? j.sha : undefined; }
      const body = { message: 'Walk in Light progress ' + new Date().toISOString(), branch: c.branch || 'main', content: btoa(unescape(encodeURIComponent(JSON.stringify(stripSecrets(S), null, 1)))) };
      if (SYNC.sha) body.sha = SYNC.sha;
      const r = await fetch(ghUrl(c), { method: 'PUT', headers: { ...ghHeaders(c), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if ((r.status === 409 || r.status === 422) && !retry) { SYNC.busy = false; const j = await syncGetSha(c); SYNC.sha = j ? j.sha : undefined; return syncPush(true); }
      if (!r.ok) throw new Error('GitHub ' + r.status + (r.status === 401 ? ' (bad token)' : r.status === 404 ? ' (repo not found or token lacks access)' : ''));
      const j = await r.json(); SYNC.sha = j.content.sha;
      setSyncStatus('Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (e) { setSyncStatus('Sync failed: ' + e.message); }
    SYNC.busy = false;
  }
  window.addEventListener('online', () => { syncPull(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncPull(); });

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return; const a = el.dataset.action; const id = el.dataset.id;
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'FORM') return;
    switch (a) {
      case 'tab': UI.tab = el.dataset.tab; UI.open = new Set(); render(); break;
      case 'sub': UI.sub[el.dataset.p] = el.dataset.sub; render(); break;
      case 'time': UI.timeFilter = UI.timeFilter === +el.dataset.n ? null : +el.dataset.n; render(); break;
      case 'cycle': cycle(id); if (el.dataset.close) closeSheet(); break;
      case 'open-task': taskSheet(id); break;
      case 'open-item': itemSheet(id); break;
      case 'open-bible': bibleSheet(id); break;
      case 'bible-new': bibleSheet(null, UI.bibleFilter === 'all' ? 'character' : UI.bibleFilter); break;
      case 'bible-f': UI.bibleFilter = el.dataset.t; render(); break;
      case 'edit-ms': e.preventDefault(); msSheet(id); break;
      case 'step': { const t = findTask(id).t; const i = +el.dataset.i; t.checks = t.checks || []; t.checks[i] = !t.checks[i]; if (t.status === 'todo' && t.checks[i]) t.status = 'doing';
        const all = t.steps.every((_, k) => t.checks[k]); if (all && t.status !== 'done') { setStatus(t, 'done'); }
        save(); const notes = $('#t-notes') ? $('#t-notes').value : null; UI.scrollKeep = window.scrollY; render(); const sc = $('#sheet').scrollTop; taskSheet(id); $('#sheet').scrollTop = sc; if (notes != null) $('#t-notes').value = notes; break; }
      case 'focus': { S.focus = S.focus === id ? null : id; commit(); closeSheet(); toast(S.focus ? 'Pinned as this week\'s focus' : 'Unpinned'); break; }
      case 'task-del': confirmTap(el, null, () => { S.pillars.forEach((p) => p.milestones.forEach((m) => { m.tasks = m.tasks.filter((t) => t.id !== id); })); if (S.focus === id) S.focus = null; commit(); closeSheet(); }); break;
      case 'item-del': confirmTap(el, null, () => { S.items = S.items.filter((i) => i.id !== id); commit(); closeSheet(); }); break;
      case 'bible-del': confirmTap(el, null, () => { S.bible = S.bible.filter((b) => b.id !== id); commit(); closeSheet(); }); break;
      case 'ms-del': confirmTap(el, 'Tap again to delete milestone and its steps', () => { S.pillars.forEach((p) => { p.milestones = p.milestones.filter((m) => m.id !== id); }); commit(); closeSheet(); }); break;
      case 'ms-move': { const p = S.pillars.find((pp) => pp.milestones.some((m) => m.id === id)); const i = p.milestones.findIndex((m) => m.id === id); const j = i + (+el.dataset.d); if (j >= 0 && j < p.milestones.length) { [p.milestones[i], p.milestones[j]] = [p.milestones[j], p.milestones[i]]; commit(); closeSheet(); } break; }
      case 'stage': { const it = S.items.find((i) => i.id === id); const n = SEED.pipelines[pillar(it.pillar).pipeline].stages.length; it.stage = Math.max(0, Math.min(n - 1, it.stage + (+el.dataset.d))); if (it.stage === n - 1 && +el.dataset.d > 0) toast('Shipped. Well done.'); UI.scrollKeep = window.scrollY; commit(); break; }
      case 'inbox-del': S.inbox = S.inbox.filter((i) => i.id !== id); commit(); break;
      case 'playbook': playbookSheet(); break;
      case 'settings': settingsSheet(); break;
      case 'set-glow': S.settings.glow = el.dataset.v; commit(); settingsSheet(); break;
      case 'set-fs': S.settings.fs = +el.dataset.v; commit(); settingsSheet(); break;
      case 'export': exportJson(); break;
      case 'ics': ics(); break;
      case 'merge': mergeSeed(); settingsSheet(); break;
      case 'reset': confirmTap(el, 'Tap again to erase everything', () => { S = fresh(); commit(); closeSheet(); }); break;
      case 'hide-install': S.settings.hideInstall = true; commit(); break;
      case 'sync-save': { const repo = ($('#sync-repo').value || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''); const token = ($('#sync-token').value || '').trim(); if (!repo || !token) { toast('Repository and token are both needed'); break; } S.settings.sync = { repo, token, path: 'data/state.json', branch: 'main' }; SYNC.sha = null; save(true); setSyncStatus('Connecting…'); syncPull().then(() => syncPush()); break; }
      case 'sync-off': delete S.settings.sync; SYNC.sha = null; save(true); settingsSheet(); toast('Sync turned off'); break;
      case 'close': closeSheet(); break;
    }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target; const a = f.dataset.action; if (!a) return; e.preventDefault(); const fd = new FormData(f); const id = f.dataset.id;
    const newTask = (title, size) => ({ id: uid('t'), title, size: size || 'M', guide: '', steps: [], checks: [], status: 'todo', notes: '', doneAt: null, seeded: false, edited: true });
    switch (a) {
      case 'inbox-add': { const text = (fd.get('text') || '').trim(); if (text) { S.inbox.push({ id: uid('in'), text, at: new Date().toISOString() }); commit(); } break; }
      case 'task-add': { const title = (fd.get('title') || '').trim(); if (!title) return; const m = S.pillars.flatMap((p) => p.milestones).find((mm) => mm.id === f.dataset.ms); m.tasks.push(newTask(title, fd.get('size'))); UI.open.add(m.id); UI.scrollKeep = window.scrollY; commit(); break; }
      case 'ms-add': { const name = (fd.get('name') || '').trim(); if (!name) return; pillar(f.dataset.p).milestones.push({ id: uid('m'), name, tasks: [] }); commit(); break; }
      case 'item-add': { const title = (fd.get('title') || '').trim(); if (!title) return; S.items.push({ id: uid('it'), pillar: f.dataset.p, title, stage: 0, notes: '' }); commit(); break; }
      case 'task-save': { const t = findTask(id).t; const title = (fd.get('title') || '').trim() || t.title; if (title !== t.title || fd.get('size') !== t.size) t.edited = true; t.title = title; t.size = fd.get('size'); t.notes = fd.get('notes') || ''; UI.scrollKeep = window.scrollY; commit(); closeSheet(); toast('Saved'); break; }
      case 'item-save': { const it = S.items.find((i) => i.id === id); it.title = (fd.get('title') || '').trim() || it.title; it.stage = +fd.get('stage'); it.notes = fd.get('notes') || ''; commit(); closeSheet(); break; }
      case 'ms-save': { const m = S.pillars.flatMap((p) => p.milestones).find((mm) => mm.id === id); m.name = (fd.get('name') || '').trim() || m.name; commit(); closeSheet(); break; }
      case 'bible-save': { const fields = {}; for (const [k, v] of fd.entries()) if (k.startsWith('f:')) fields[k.slice(2)] = v; const name = (fd.get('name') || '').trim() || 'Untitled'; if (id) { const b = S.bible.find((x) => x.id === id); b.type = fd.get('type'); b.name = name; b.fields = fields; } else S.bible.push({ id: uid('b'), type: fd.get('type'), name, fields }); UI.sub.story = 'bible'; commit(); closeSheet(); toast('Saved'); break; }
    }
  });
  document.addEventListener('change', (e) => {
    const el = e.target; const a = el.dataset.action; if (!a) return;
    if (a === 'inbox-move') { const i = S.inbox.find((x) => x.id === el.dataset.id); const v = el.value; if (!v) return;
      if (v === 'bible') { S.inbox = S.inbox.filter((x) => x !== i); save(); render(); bibleSheet(null, 'lore', i.text); return; }
      const p = pillar(v); let m = p.milestones.find((mm) => mm.id === v + '-inbox'); if (!m) { m = { id: v + '-inbox', name: 'From the inbox', tasks: [] }; p.milestones.push(m); }
      m.tasks.push({ id: uid('t'), title: i.text, size: 'M', guide: '', steps: [], checks: [], status: 'todo', notes: '', doneAt: null, seeded: false, edited: true }); S.inbox = S.inbox.filter((x) => x !== i); commit(); toast('Moved to ' + p.name); }
    if (a === 'import' && el.files[0]) importJson(el.files[0]);
    if (a === 'bible-type') { const form = el.closest('form'); const id = form.dataset.id; const name = form.querySelector('[name=name]').value; if (id) { const b = S.bible.find((x) => x.id === id); b.type = el.value; b.name = name; bibleSheet(id); } else bibleSheet(null, el.value, name); }
  });
  document.addEventListener('input', (e) => { if (e.target.dataset.action === 'bible-q') { UI.bibleQuery = e.target.value; const pos = e.target.selectionStart; render(); const el = $('[data-action=bible-q]'); el.focus(); el.setSelectionRange(pos, pos); } });
  document.addEventListener('toggle', (e) => { const d = e.target; if (d.dataset && d.dataset.ms) { if (d.open) UI.open.add(d.dataset.ms); else UI.open.delete(d.dataset.ms); } }, true);
  $('#sheet-bg').addEventListener('click', closeSheet);

  /* ───────────── boot ───────────── */
  if (S.seedVersion < SEED.version) setTimeout(() => toast('New content available: Settings → Merge'), 800);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
  syncPull();
})();
