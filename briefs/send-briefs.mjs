// Walk in Light — brief sender. Runs inside GitHub Actions in your private data repo.
// Reads data/state.json (synced by the app), decides whether a brief is due in your timezone,
// composes three lines (Yesterday / Today / Verse) and sends each as a web push notification
// to the phone where you enabled notifications. Nothing is written anywhere.
//
// Env: FORCE=1 sends now regardless of schedule (used by "Send a test now").
//      DRY_RUN=1 prints instead of sending. STATE_PATH overrides the file path.
import fs from 'node:fs';

const FORCE = process.env.FORCE === '1';
const DRY = process.env.DRY_RUN === '1';
const statePath = process.env.STATE_PATH || 'data/state.json';
const SEED_URL = process.env.SEED_URL || 'https://raw.githubusercontent.com/Glen-Skahill/walk-in-light/main/js/seed.js';
const SIZE = { S: '15 min', M: '45 min', L: '90+ min' };
const FALLBACK_VERSES = [
  { ref: 'John 8:12', text: 'I am the light of the world: he that followeth me shall not walk in darkness, but shall have the light of life.' },
  { ref: 'Psalm 119:105', text: 'Thy word is a lamp unto my feet, and a light unto my path.' },
  { ref: 'Zechariah 4:10', text: 'For who hath despised the day of small things?' },
  { ref: 'Galatians 6:9', text: 'And let us not be weary in well doing: for in due season we shall reap, if we faint not.' },
  { ref: 'Colossians 3:23', text: 'And whatsoever ye do, do it heartily, as to the Lord, and not unto men.' },
  { ref: 'Matthew 5:16', text: 'Let your light so shine before men, that they may see your good works, and glorify your Father which is in heaven.' },
  { ref: 'Isaiah 9:2', text: 'The people that walked in darkness have seen a great light.' },
];

const S = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const tz = (S.settings && S.settings.tz) || 'UTC';
const sched = Object.assign({ enabled: true, weekday: '17:05', sat: '10:00', sun: '14:05' }, (S.settings && S.settings.briefs) || {});
const push = S.push;

function local(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { dow, y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, key: `${p.year}-${p.month}-${p.day}` };
}
const now = new Date();
const L = local(now);
const target = L.dow === 0 ? sched.sun : L.dow === 6 ? sched.sat : sched.weekday;
function due() {
  if (!target) return false;
  const [h, m] = target.split(':').map(Number);
  const t = h * 60 + m, n = L.h * 60 + L.min;
  return n >= t && n < t + 45; // GitHub cron can run late; accept a 45 minute window
}
if (!push || !push.sub || !push.priv || !push.pub) { console.log('Notifications are not enabled in the app yet (no subscription in state.json).'); process.exit(0); }
if (!FORCE && (sched.enabled === false || !due())) { console.log(`Not due. Local time ${L.h}:${String(L.min).padStart(2, '0')} (${tz}), target ${target || 'none'} today.`); process.exit(0); }

/* ── compose ── */
const tasks = [];
(S.pillars || []).forEach((p) => (p.milestones || []).forEach((m) => (m.tasks || []).forEach((t) => tasks.push({ t, p, m }))));
const yesterdayKey = (() => { const d = new Date(Date.UTC(L.y, L.m - 1, L.d) - 86400000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; })();
const doneY = (S.log || []).filter((e) => local(new Date(e.at)).key === yesterdayKey).map((e) => tasks.find((x) => x.t.id === e.taskId)).filter(Boolean);
const titles = doneY.map((x) => x.t.title);
const yesterday = titles.length ? `${titles.slice(0, 3).join(' · ')}${titles.length > 3 ? ` and ${titles.length - 3} more` : ''}` : 'A rest day. Today is a new page.';

let pick = S.focus ? tasks.find((x) => x.t.id === S.focus && x.t.status !== 'done') : null;
if (!pick) pick = tasks.find((x) => x.t.status === 'doing') || tasks.find((x) => x.t.status !== 'done');
const today = pick ? `${pick.t.title} (${pick.p.short || pick.p.name}, ${SIZE[pick.t.size] || pick.t.size})` : 'Everything is done. Add the next step in the app.';

async function verses() {
  try {
    const code = await (await fetch(SEED_URL)).text();
    const w = {}; new Function('window', code)(w);
    if (w.WIL_SEED && w.WIL_SEED.verses && w.WIL_SEED.verses.length) return w.WIL_SEED.verses;
  } catch (e) { console.log('Using built-in verses:', e.message); }
  return FALLBACK_VERSES;
}
const vs = await verses();
const dayIndex = Math.floor(Date.UTC(L.y, L.m - 1, L.d) / 86400000);
const v = vs[(dayIndex + 3) % vs.length];
const verse = `"${v.text}" (${v.ref})`;

const url = (S.settings && S.settings.appUrl) || './';
const messages = [
  { title: 'Yesterday', body: yesterday, tag: 'wil-yesterday' },
  { title: 'Today', body: today, tag: 'wil-today' },
  { title: 'Verse', body: verse, tag: 'wil-verse' },
].map((m) => ({ ...m, title: `Walk in Light · ${m.title}`, url }));

/* ── send ── */
if (DRY) { messages.forEach((m) => console.log(m.title + ': ' + m.body)); process.exit(0); }
const webpush = (await import('web-push')).default;
webpush.setVapidDetails('mailto:' + ((S.settings && S.settings.contact) || 'walkinlight@users.noreply.github.com'), push.pub, push.priv);
let failed = 0;
for (const m of messages) {
  try {
    await webpush.sendNotification(push.sub, JSON.stringify(m), { TTL: 3600, urgency: 'normal' });
    console.log('Sent:', m.title);
    await new Promise((r) => setTimeout(r, 1500));
  } catch (e) {
    failed++;
    console.log('Failed:', m.title, e.statusCode || '', e.body || e.message);
    if (e.statusCode === 404 || e.statusCode === 410) { console.log('The subscription has expired. Open the app and enable notifications again.'); break; }
  }
}
process.exit(failed ? 1 : 0);
