import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';

// put near the top of server.js
function getGooglePrivateKey() {
  let k = process.env.GOOGLE_PRIVATE_KEY || "";
  // strip accidental surrounding quotes
  k = k.replace(/^"+|"+$/g, "");
  // normalize Windows newlines
  k = k.replace(/\r\n/g, "\n");
  // convert escaped \n into real newlines
  if (k.includes("\\n")) k = k.replace(/\\n/g, "\n");
  return k;
}

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  getGooglePrivateKey(),  // 👈 use the sanitizer here
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });

// -------------------- App bootstrap --------------------
const app = express();
app.use(express.json());

const NOTION_SECRET = process.env.NOTION_SECRET;
const NOTION_VERSION = '2022-06-28';
const TZ = process.env.TZ || 'America/Chicago';

if (!NOTION_SECRET) {
  console.warn('WARNING: NOTION_SECRET not set. Set it in env vars (Render) or .env for local dev.');
}

// -------------------- Notion helpers -------------------
async function notion(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_SECRET}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text}`);
  }
  return res.json();
}

function titleOf(dbOrPage) {
  return (dbOrPage.title?.map(t => t.plain_text).join('').trim())
      || (dbOrPage.properties?.Name?.title?.map(t => t.plain_text).join('').trim())
      || '';
}

async function findDatabaseByName(name) {
  const data = await notion('/search', {
    method: 'POST',
    body: {
      query: name,
      filter: { property: 'object', value: 'database' },
      page_size: 50
    }
  });
  const results = data.results || [];
  const lower = name.toLowerCase();
  const exact = results.find(d => titleOf(d).toLowerCase() === lower);
  return exact || results.find(d => titleOf(d).toLowerCase().includes(lower)) || null;
}

async function findPageInDbByTitle(database_id, pageTitle) {
  const q = await notion(`/databases/${database_id}/query`, {
    method: 'POST',
    body: { filter: { property: 'Name', title: { equals: pageTitle } }, page_size: 25 }
  });
  return (q.results && q.results[0]) || null;
}

function toISOLocal(dateStr, timeStr) {
  // Accepts: 'MM/DD/YYYY' or 'YYYY-MM-DD' + optional 'HH:MM' 24h
  const parts = dateStr.includes('/') ? dateStr.split('/') : null;
  let isoBase;
  if (parts) {
    const [m, d, y] = parts;
    const mm = String(m).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    isoBase = `${y}-${mm}-${dd}`;
  } else {
    isoBase = dateStr;
  }
  const t = timeStr ? `${timeStr}:00` : '00:00:00';
  return `${isoBase}T${t}`;
}

// Build Action Base property payload (set only what’s provided)
function buildActionBaseProperties(payload) {
  const p = {};
  if (payload.name) p['Name'] = { title: [{ text: { content: payload.name } }] };
  if (payload.status) p['Status'] = { status: { name: payload.status } };
  if (payload.type) p['Type'] = { select: { name: payload.type } };
  if (payload.priorityLevel) p['Priority Level'] = { select: { name: payload.priorityLevel } };
  if (payload.alignment) p['Alignment'] = { select: { name: payload.alignment } };
  if (payload.doDate?.date) p['Do Date'] = {
    date: { start: toISOLocal(payload.doDate.date, payload.doDate.time), time_zone: TZ }
  };
  if (payload.dueDate?.date) p['Due Date'] = {
    date: { start: toISOLocal(payload.dueDate.date, payload.dueDate.time), time_zone: TZ }
  };
  if (payload.projectAttributePageId) p['Project Attribute'] = {
    relation: [{ id: payload.projectAttributePageId }]
  };
  return p;
}

function iconForActionBase({ type, alignment, priorityLevel }) {
  if (priorityLevel === 'HIGH') return { type: 'emoji', emoji: '🔥' };
  if (type === 'Call') return { type: 'emoji', emoji: '📞' };
  if (type === 'Event') return { type: 'emoji', emoji: '📅' };
  if (type === 'Errand') return { type: 'emoji', emoji: '🧾' };
  if (alignment === 'KRAZY MONKEE') return { type: 'emoji', emoji: '🐒' };
  if (alignment === 'DEV ED') return { type: 'emoji', emoji: '🧠' };
  if (alignment === 'HANUMAN LIFE') return { type: 'emoji', emoji: '🙏' };
  return { type: 'emoji', emoji: '✅' };
}

function readProp(page, key) {
  const p = page.properties?.[key];
  if (!p) return null;
  if (p.type === 'date') return p.date;
  if (p.type === 'status') return p.status?.name || null;
  if (p.type === 'select') return p.select?.name || null;
  if (p.type === 'relation') return (p.relation || []).map(r => r.id);
  if (p.type === 'title') return (p.title || []).map(t => t.plain_text).join('');
  return null;
}

// -------------------- Time helpers (America/Chicago aware) -------------------
function chicagoNow() {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: TZ }));
}
function startEndOfToday() {
  const now = new Date();
  const chic = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const delta = now.getTime() - chic.getTime();
  const y = chic.getFullYear(), m = chic.getMonth(), d = chic.getDate();
  const startLocal = new Date(y, m, d, 0, 0, 0);
  const endLocal = new Date(y, m, d, 23, 59, 59);
  const start = new Date(startLocal.getTime() + delta);
  const end = new Date(endLocal.getTime() + delta);
  return { startISO: start.toISOString(), endISO: end.toISOString(), y, m: m + 1, d };
}
function next7Window() {
  const now = new Date();
  const chic = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const delta = now.getTime() - chic.getTime();
  const endChic = new Date(chic);
  endChic.setDate(endChic.getDate() + 7);
  const endLocal = new Date(endChic.getFullYear(), endChic.getMonth(), endChic.getDate(), 23, 59, 59);
  const endUTC = new Date(endLocal.getTime() + delta);
  return { startISO: new Date().toISOString(), endISO: endUTC.toISOString() };
}

// -------------------- Health --------------------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    hasSecret: !!NOTION_SECRET,
    tz: TZ,
    nowChicago: new Date().toLocaleString('en-US', { timeZone: TZ })
  });
});

// ==========================================================================
// ===============   ACTION BASE (Notion) — LEGACY ENDPOINTS   ===============
// ==========================================================================

// nolaAddPage
app.post('/nolaAddPage', async (req, res) => {
  try {
    if (!NOTION_SECRET) return res.status(500).json({ error: 'Server missing NOTION_SECRET' });
    const { databaseName, pageTitle, status, extraProperties } = req.body || {};
    if (!databaseName || !pageTitle) {
      return res.status(400).json({ error: 'databaseName and pageTitle are required' });
    }
    const db = await findDatabaseByName(databaseName);
    if (!db) return res.status(404).json({ error: `Database "${databaseName}" not found or not shared with integration.` });

    const properties = {
      Name: { title: [{ text: { content: pageTitle } }] },
      ...(status ? { Status: { status: { name: status } } } : {}),
      ...(extraProperties && typeof extraProperties === 'object' ? extraProperties : {})
    };
    const created = await notion('/pages', { method: 'POST', body: { parent: { database_id: db.id }, properties } });
    res.json({ ok: true, databaseId: db.id, pageId: created.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// nolaListPages
app.post('/nolaListPages', async (req, res) => {
  try {
    if (!NOTION_SECRET) return res.status(500).json({ error: 'Server missing NOTION_SECRET' });
    const { databaseName } = req.body || {};
    if (!databaseName) return res.status(400).json({ error: 'databaseName is required' });
    const db = await findDatabaseByName(databaseName);
    if (!db) return res.status(404).json({ error: `Database "${databaseName}" not found or not shared with integration.` });

    const response = await notion(`/databases/${db.id}/query`, { method: 'POST', body: {} });
    const pages = response.results.map(page => {
      const title = page.properties.Name?.title?.map(t => t.plain_text).join('') || '(Untitled)';
      const status = page.properties.Status?.status?.name || 'No Status';
      return { id: page.id, title, status };
    });
    res.json({ ok: true, count: pages.length, pages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- Action Base CRUD --------------------
app.post('/actionBase/createItem', async (req, res) => {
  try {
    const { name, status, type, priorityLevel, alignment, doDate, dueDate, projectAttributePageId } = req.body || {};
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    const props = buildActionBaseProperties({ name, status, type, priorityLevel, alignment, doDate, dueDate, projectAttributePageId });
    if (!props.Name) return res.status(400).json({ error: 'name is required to create an item' });

    const created = await notion('/pages', {
      method: 'POST',
      body: { parent: { database_id: db.id }, icon: iconForActionBase({ type, alignment, priorityLevel }), properties: props }
    });
    res.json({ ok: true, pageId: created.id });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/actionBase/updateItem', async (req, res) => {
  try {
    const { pageId, pageTitle, ...rest } = req.body || {};
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    let pid = pageId;
    if (!pid) {
      if (!pageTitle) return res.status(400).json({ error: 'Provide pageId or pageTitle' });
      const page = await findPageInDbByTitle(db.id, pageTitle);
      if (!page) return res.status(404).json({ error: `Page "${pageTitle}" not found in Action Base` });
      pid = page.id;
    }

    const props = buildActionBaseProperties(rest);
    const patch = { properties: props };
    if (rest.type || rest.alignment || rest.priorityLevel) patch.icon = iconForActionBase(rest);

    const updated = await notion(`/pages/${pid}`, { method: 'PATCH', body: patch });
    res.json({ ok: true, pageId: updated.id });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/actionBase/clearProperties', async (req, res) => {
  try {
    const { pageId, pageTitle, properties } = req.body || {};
    if (!Array.isArray(properties) || properties.length === 0) {
      return res.status(400).json({ error: 'properties must be a non-empty array of property names to clear' });
    }
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    let pid = pageId;
    if (!pid) {
      if (!pageTitle) return res.status(400).json({ error: 'Provide pageId or pageTitle' });
      const page = await findPageInDbByTitle(db.id, pageTitle);
      if (!page) return res.status(404).json({ error: `Page "${pageTitle}" not found in Action Base` });
      pid = page.id;
    }

    const empties = {};
    for (const prop of properties) {
      if (prop === 'Name') empties['Name'] = { title: [] };
      else if (prop === 'Status') empties['Status'] = { status: null };
      else if (prop === 'Type') empties['Type'] = { select: null };
      else if (prop === 'Priority Level') empties['Priority Level'] = { select: null };
      else if (prop === 'Alignment') empties['Alignment'] = { select: null };
      else if (prop === 'Do Date') empties['Do Date'] = { date: null };
      else if (prop === 'Due Date') empties['Due Date'] = { date: null };
      else if (prop === 'Project Attribute') empties['Project Attribute'] = { relation: [] };
      else empties[prop] = null;
    }

    const updated = await notion(`/pages/${pid}`, { method: 'PATCH', body: { properties: empties } });
    res.json({ ok: true, pageId: updated.id });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/actionBase/deleteItem', async (req, res) => {
  try {
    const { pageId, pageTitle } = req.body || {};
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    let pid = pageId;
    if (!pid) {
      if (!pageTitle) return res.status(400).json({ error: 'Provide pageId or pageTitle' });
      const page = await findPageInDbByTitle(db.id, pageTitle);
      if (!page) return res.status(404).json({ error: `Page "${pageTitle}" not found in Action Base` });
      pid = page.id;
    }

    const updated = await notion(`/pages/${pid}`, { method: 'PATCH', body: { archived: true } });
    res.json({ ok: true, pageId: updated.id, archived: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// -------------------- Page content helpers --------------------
app.post('/actionBase/pageAppend', async (req, res) => {
  try {
    const { pageId, pageTitle, text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required' });

    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    let pid = pageId;
    if (!pid) {
      if (!pageTitle) return res.status(400).json({ error: 'Provide pageId or pageTitle' });
      const page = await findPageInDbByTitle(db.id, pageTitle);
      if (!page) return res.status(404).json({ error: `Page "${pageTitle}" not found in Action Base` });
      pid = page.id;
    }

    const children = [{
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text } }] }
    }];

    const appended = await notion(`/blocks/${pid}/children`, { method: 'PATCH', body: { children } });
    res.json({ ok: true, pageId: pid, appendedBlocks: appended?.results?.length ?? 0 });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/actionBase/addDateMention', async (req, res) => {
  try {
    const { pageId, pageTitle, which, date, time } = req.body || {};
    if (!which || !['do','due'].includes(which)) return res.status(400).json({ error: 'which must be "do" or "due"' });
    if (!date) return res.status(400).json({ error: 'date is required' });

    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    let pid = pageId;
    if (!pid) {
      if (!pageTitle) return res.status(400).json({ error: 'Provide pageId or pageTitle' });
      const page = await findPageInDbByTitle(db.id, pageTitle);
      if (!page) return res.status(404).json({ error: `Page "${pageTitle}" not found in Action Base` });
      pid = page.id;
    }

    const iso = toISOLocal(date, time);
    const children = [{
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: `Reminder for ${which === 'do' ? 'Do Date' : 'Due Date'}: ` } },
          { type: 'mention', mention: { type: 'date', date: { start: iso } } }
        ]
      }
    }];

    const appended = await notion(`/blocks/${pid}/children`, { method: 'PATCH', body: { children } });
    res.json({ ok: true, pageId: pid, appendedBlocks: appended?.results?.length ?? 0 });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// -------------------- Coach/Analysis helpers --------------------
function coachWhyMatters(page) {
  const t = readProp(page, 'Type') || '';
  const pr = readProp(page, 'Priority Level') || '';
  if (pr === 'HIGH') return 'High-impact lever — moves a top outcome forward.';
  if (t === 'Event') return 'Time-bound; missing it creates downstream delays.';
  if (t === 'Call') return 'Maintains momentum and unblocks next steps.';
  return 'Keeps your cadence strong and reduces task spillover.';
}
function coachNextMove(page) {
  const t = readProp(page, 'Type') || '';
  if (t === 'Call') return 'Confirm agenda + dial in five minutes early.';
  if (t === 'Event') return 'Skim notes + prep one question to ask.';
  return 'Define the first 10-minute action and start it.';
}
function coachFixNow() { return 'Do the smallest unblocked step right now and log it in the page.'; }
function tsLocal(iso) { return iso ? new Date(iso) : null; }
function getPrimaryWhen(page) {
  const dd = readProp(page, 'Do Date')?.start || null;
  const due = readProp(page, 'Due Date')?.start || null;
  const which = dd ? 'do' : 'due';
  const pick = dd || due;
  return { which, iso: pick, date: tsLocal(pick) };
}
function asCoachLine(page, which, now = new Date()) {
  const name = readProp(page, 'Name') || '(Untitled)';
  const type = readProp(page, 'Type') || '';
  const alignment = readProp(page, 'Alignment') || '';
  const status = readProp(page, 'Status') || '';
  const dd = readProp(page, 'Do Date')?.start || null;
  const due = readProp(page, 'Due Date')?.start || null;
  const label = which === 'do' ? 'Do' : 'Due';
  const dtISO = which === 'do' ? dd : due;
  const dt = dtISO ? new Date(dtISO) : null;
  const timeLabel = dt ? dt.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : 'no time';
  return {
    id: page.id,
    line: `**${name}** — ${label} • ${timeLabel}${type ? ` — ${type}` : ''}${alignment ? ` — ${alignment}` : ''} — Status: ${status || 'N/A'}`,
    why: coachWhyMatters(page),
    next: coachNextMove(page),
    fix: coachFixNow(page),
    suggestReminder: !!dt && dt > now
  };
}

// -------------------- Analyses --------------------
app.post('/analysis/today', async (req, res) => {
  try {
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    const { startISO, endISO, y, m, d } = startEndOfToday();
    const q = await notion(`/databases/${db.id}/query`, {
      method: 'POST',
      body: {
        filter: {
          or: [
            { property: 'Do Date', date: { on_or_after: startISO, on_or_before: endISO } },
            { property: 'Due Date', date: { on_or_after: startISO, on_or_before: endISO } }
          ]
        },
        page_size: 100
      }
    });

    const now = new Date();
    const items = q.results || [];

    // Sort: Priority -> time -> Status
    const prioRank = { HIGH: 1, MID: 2, LOW: 3, '': 4 };
    const statusRank = { 'Not started': 1, 'In progress': 2, 'Done': 3, '': 4 };
    const getTime = (p) => {
      const w = getPrimaryWhen(p).date;
      return w ? w.getTime() : Number.MAX_SAFE_INTEGER;
    };
    items.sort((a,b) => {
      const ap = readProp(a, 'Priority Level') || '';
      const bp = readProp(b, 'Priority Level') || '';
      const aP = prioRank[ap] || 99, bP = prioRank[bp] || 99;
      if (aP !== bP) return aP - bP;
      const at = getTime(a), bt = getTime(b);
      if (at !== bt) return at - bt;
      const as = statusRank[readProp(a, 'Status') || ''] || 99;
      const bs = statusRank[readProp(b, 'Status') || ''] || 99;
      return as - bs;
    });

    const header = `TODAY FOCUS (${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')}/${y}) — “Alright J-Maal, here’s what wins the day. Tight focus, clean execution, ya heard me.”`;
    const overdue = [];
    const scheduled = [];
    const scheduledTimed = [];

    for (const page of items) {
      const { which, date } = getPrimaryWhen(page);
      if (date) {
        if (date < now) overdue.push(asCoachLine(page, which, now));
        else {
          const line = asCoachLine(page, which, now);
          scheduled.push(line);
          scheduledTimed.push({ date, line });
        }
      } else {
        scheduled.push(asCoachLine(page, 'do', now));
      }
    }

    // Gaps (≥60 min) from timed items
    scheduledTimed.sort((a,b) => a.date - b.date);
    const gaps = [];
    for (let i = 0; i < scheduledTimed.length - 1; i++) {
      const a = scheduledTimed[i].date, b = scheduledTimed[i+1].date;
      const diffMin = (b - a) / 60000;
      if (diffMin >= 60) {
        gaps.push({
          window: `${a.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })}–${b.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })}`,
          suggestions: (items.filter(p => (readProp(p,'Priority Level') || '') !== 'HIGH').slice(0,2).map(p => readProp(p,'Name')) || [])
        });
      }
    }

    const total = items.length;
    const high = items.filter(p => readProp(p, 'Priority Level') === 'HIGH').length;
    const dueHard = items.filter(p => !!readProp(p, 'Due Date')?.start).length;
    const doCount = items.filter(p => !!readProp(p, 'Do Date')?.start).length;
    const ns = items.filter(p => readProp(p, 'Status') === 'Not started').length;
    const ip = items.filter(p => readProp(p, 'Status') === 'In progress').length;
    const dn = items.filter(p => readProp(p, 'Status') === 'Done').length;

    res.json({
      ok: true,
      header,
      overdue,
      scheduled,
      gaps,
      quickTally: { total, high, dueHard, doCount, statusMix: { notStarted: ns, inProgress: ip, done: dn } },
      coachNudge: 'Win the morning, win the day. Knock out the 🔥 HIGHs first, slide a 💡 Strategic Win into your biggest gap, and keep momentum rolling — bet!'
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/analysis/7day', async (req, res) => {
  try {
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    const { startISO, endISO } = next7Window();
    const q = await notion(`/databases/${db.id}/query`, {
      method: 'POST',
      body: {
        filter: {
          or: [
            { property: 'Do Date', date: { on_or_after: startISO, on_or_before: endISO } },
            { property: 'Due Date', date: { on_or_after: startISO, on_or_before: endISO } }
          ]
        },
        page_size: 200
      }
    });

    const items = q.results || [];
    const getPriority = p => readProp(p, 'Priority Level') || '';
    const getStatus = p => readProp(p, 'Status') || '';
    const getType = p => readProp(p, 'Type') || '';
    const getAlign = p => readProp(p, 'Alignment') || '';

    const highPriority = items.filter(p => getPriority(p) === 'HIGH');
    const strategicWins = items.filter(p => {
      const pr = getPriority(p);
      return pr === 'MID' || pr === 'LOW' || pr === '';
    });
    const soon = Date.now() + 48 * 3600 * 1000;
    const riskWatch = items.filter(p => {
      const st = getStatus(p);
      const doStart = readProp(p, 'Do Date')?.start;
      const dueStart = readProp(p, 'Due Date')?.start;
      const first = doStart || dueStart;
      const t = first ? new Date(first).getTime() : Infinity;
      return st === 'Not started' && t < soon;
    });

    const groups = items.reduce((m,p) => {
      const a = getAlign(p) || 'Unassigned';
      m[a] = (m[a] || 0) + 1;
      return m;
    }, {});
    const alignmentCheck = Object.entries(groups).map(([alignment, count]) => ({ alignment, count }));

    function line(page) {
      const name = readProp(page, 'Name') || '(Untitled)';
      const type = getType(page);
      const alignment = getAlign(page);
      const status = getStatus(page) || 'N/A';
      const pr = getPriority(page) || 'N/A';
      const dd = readProp(page, 'Do Date')?.start || null;
      const due = readProp(page, 'Due Date')?.start || null;
      const which = dd ? 'Do' : 'Due';
      const pick = dd || due;
      const dt = pick ? new Date(pick).toLocaleString('en-US', { timeZone: TZ, month:'2-digit', day:'2-digit', hour:'numeric', minute:'2-digit' }) : 'no time';
      return `**${name}** — ${which} • ${dt}${type ? ` — ${type}` : ''}${alignment ? ` — ${alignment}` : ''} — Priority: ${pr} — Status: ${status}`;
    }

    res.json({
      ok: true,
      sections: {
        highPriority: highPriority.map(line),
        strategicWins: strategicWins.map(line),
        riskWatch: riskWatch.map(line),
        alignmentCheck
      },
      wrapUp: 'J-Maal, the next 7 days ain’t about doing everything, it’s about doing the right things. Hit the 🔥 Critical Moves first, sprinkle in 💡 Strategic Wins, and watch the ⚠ risks.'
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/analysis/period', async (req, res) => {
  try {
    const { startDate, endDate } = req.body || {}; // 'YYYY-MM-DD'
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    const startISO = `${startDate}T00:00:00Z`;
    const endISO = `${endDate}T23:59:59Z`;

    const q = await notion(`/databases/${db.id}/query`, {
      method: 'POST',
      body: {
        filter: {
          or: [
            { property: 'Do Date', date: { on_or_after: startISO, on_or_before: endISO } },
            { property: 'Due Date', date: { on_or_after: startISO, on_or_before: endISO } }
          ]
        }
      }
    });

    const items = q.results || [];
    const getPriority = p => readProp(p, 'Priority Level') || '';
    const getStatus = p => readProp(p, 'Status') || '';
    const getType = p => readProp(p, 'Type') || '';
    const getAlign = p => readProp(p, 'Alignment') || '';

    const line = (page) => {
      const name = readProp(page, 'Name') || '(Untitled)';
      const type = getType(page), alignment = getAlign(page);
      const status = getStatus(page) || 'N/A';
      const pr = getPriority(page) || 'N/A';
      const dd = readProp(page, 'Do Date')?.start || null;
      const due = readProp(page, 'Due Date')?.start || null;
      const which = dd ? 'Do' : 'Due';
      const pick = dd || due;
      const dt = pick ? new Date(pick).toLocaleString('en-US', { timeZone: TZ, month:'2-digit', day:'2-digit', hour:'numeric', minute:'2-digit' }) : 'no time';
      return `**${name}** — ${which} • ${dt}${type ? ` — ${type}` : ''}${alignment ? ` — ${alignment}` : ''} — Priority: ${pr} — Status: ${status}`;
    };

    const highPriority = items.filter(p => getPriority(p) === 'HIGH').map(line);
    const strategicWins = items.filter(p => ['MID','LOW',''].includes(getPriority(p))).map(line);
    const soon = Date.now() + 48*3600*1000;
    const riskWatch = items.filter(p => getStatus(p) === 'Not started' && (() => {
      const dd = readProp(p, 'Do Date')?.start || readProp(p, 'Due Date')?.start || null;
      return dd ? new Date(dd).getTime() < soon : false;
    })()).map(line);

    const groups = items.reduce((m,p) => {
      const a = getAlign(p) || 'Unassigned';
      m[a] = (m[a] || 0) + 1;
      return m;
    }, {});
    const alignmentCheck = Object.entries(groups).map(([alignment, count]) => ({ alignment, count }));

    res.json({ ok:true, sections: { highPriority, strategicWins, riskWatch, alignmentCheck }});
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/analysis/productivity', async (req, res) => {
  try {
    const { days = 14 } = req.body || {};
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (days - 1));
    const startISO = start.toISOString();
    const endISO = end.toISOString();

    const q = await notion(`/databases/${db.id}/query`, {
      method: 'POST',
      body: {
        filter: {
          or: [
            { property: 'Do Date', date: { on_or_after: startISO, on_or_before: endISO } },
            { property: 'Due Date', date: { on_or_after: startISO, on_or_before: endISO } }
          ]
        },
        page_size: 200
      }
    });

    const items = q.results || [];
    const bucket = {};
    for (const p of items) {
      const dd = readProp(p, 'Do Date')?.start || readProp(p, 'Due Date')?.start || null;
      const status = readProp(p, 'Status') || 'Unknown';
      if (!dd) continue;
      const d = new Date(dd).toLocaleDateString('en-US', { timeZone: TZ });
      bucket[d] = bucket[d] || { total: 0, done: 0 };
      bucket[d].total += 1;
      if (status === 'Done') bucket[d].done += 1;
    }

    const series = Object.entries(bucket).sort((a,b) => new Date(a[0]) - new Date(b[0]))
      .map(([date, { total, done }]) => ({ date, total, done, completionRate: total ? Math.round((done/total)*100) : 0 }));
    const totals = series.reduce((m, x) => ({ total: m.total + x.total, done: m.done + x.done }), { total:0, done:0 });
    const overallRate = totals.total ? Math.round((totals.done / totals.total)*100) : 0;

    res.json({ ok: true, days, overallRate, series });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Convenience
app.post('/actionBase/getItem', async (req, res) => {
  try {
    const { pageId, pageTitle } = req.body || {};
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    let pid = pageId;
    if (!pid) {
      if (!pageTitle) return res.status(400).json({ error: 'Provide pageId or pageTitle' });
      const page = await findPageInDbByTitle(db.id, pageTitle);
      if (!page) return res.status(404).json({ error: `Page "${pageTitle}" not found in Action Base` });
      pid = page.id;
    }

    const page = await notion(`/pages/${pid}`);
    const props = page.properties || {};
    const read = (k) => readProp({ properties: props }, k);
    res.json({
      ok: true,
      pageId: pid,
      properties: {
        Name: read('Name'),
        Status: read('Status'),
        Type: read('Type'),
        'Priority Level': read('Priority Level'),
        Alignment: read('Alignment'),
        'Do Date': read('Do Date'),
        'Due Date': read('Due Date'),
        'Project Attribute': read('Project Attribute')
      }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/actionBase/list', async (req, res) => {
  try {
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    const r = await notion(`/databases/${db.id}/query`, { method: 'POST', body: {} });
    const pages = (r.results || []).map(p => ({
      id: p.id,
      name: readProp(p, 'Name'),
      status: readProp(p, 'Status'),
      type: readProp(p, 'Type'),
      priority: readProp(p, 'Priority Level'),
      alignment: readProp(p, 'Alignment'),
      doDate: readProp(p, 'Do Date'),
      dueDate: readProp(p, 'Due Date')
    }));
    res.json({ ok: true, count: pages.length, pages });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Optional DB-level helpers
app.post('/databases/create', async (req, res) => {
  try {
    const { parentPageId, databaseTitle } = req.body || {};
    if (!parentPageId || !databaseTitle) {
      return res.status(400).json({ error: 'parentPageId and databaseTitle are required' });
    }
    const created = await notion('/databases', {
      method: 'POST',
      body: {
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ type: 'text', text: { content: databaseTitle } }],
        properties: { Name: { title: {} } }
      }
    });
    res.json({ ok: true, databaseId: created.id });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/databases/archiveByName', async (req, res) => {
  try {
    const { databaseName } = req.body || {};
    if (!databaseName) return res.status(400).json({ error: 'databaseName is required' });
    const db = await findDatabaseByName(databaseName);
    if (!db) return res.status(404).json({ error: `Database "${databaseName}" not found or not shared.` });

    const updated = await notion(`/databases/${db.id}`, { method: 'PATCH', body: { archived: true } });
    res.json({ ok: true, databaseId: updated.id, archived: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ==========================================================================
// ===================  GOOGLE SHEETS — NOTES ENGINE  ========================
// ==========================================================================
const NOTE_HEADERS = ['TITLE', 'Date & Time', 'Tag', 'Notes'];
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !SPREADSHEET_ID) {
    console.warn('WARNING: Google Sheets env vars missing. Set GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, SPREADSHEET_ID.');
  }
  const auth = new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY || undefined,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function getPrimarySheetTitle() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const match = meta.data.sheets?.find(s => s.properties?.title === 'Maal Secretary Notes');
  return match?.properties?.title || meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
}

async function ensureHeaders() {
  const sheets = await getSheetsClient();
  const title = await getPrimarySheetTitle();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${title}!A1:D1`
  });
  const row = r.data.values?.[0] || [];
  const need = NOTE_HEADERS;
  const same = need.every((h, i) => row[i] === h);
  if (!same) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${title}!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: { values: [need] }
    });
  }
  return title;
}

// Title / Tag helpers
const EDU_WORDS = ['codecademy','freecodecamp','javascript','node','react','express','firebase','gsap','html','css','data structures','algorithms','study','course','tutorial','lesson','practice','design refresher','photoshop','illustrator','indesign','after effects','premiere','premier pro','adobe','bootcamp'];
const WORK_WORDS = ['client','invoice','proposal','deliverable','website','web design','web dev','branding','logo','video','edit','render','notion buddy','crazy monkey','krazy monkee','marketing','ad','campaign','portfolio','mockup'];
const LIFE_WORDS = ['mom','dad','son','daughter','kids','jordan','jace','jamal jr','family','school','homework','pickup','dropoff','work schedule','gentilly mail and copy center','luz','joe','van','dave','rob','exercise','workout','gym','meditate','meditation','pray','prayer','court','appointment','doctor','volunteer','service','church','temple'];

function bagContains(text, list) {
  const t = ` ${text.toLowerCase()} `;
  return list.some(w => t.includes(` ${w} `) || t.includes(w));
}
function classifyTag({ title, notes }) {
  const text = `${title || ''} ${notes || ''}`.toLowerCase();
  if (bagContains(text, EDU_WORDS)) return 'Dev & Design Education';
  if (bagContains(text, WORK_WORDS)) return 'Krazy Monkee';
  if (bagContains(text, LIFE_WORDS)) return 'Hanuman Life';
  return 'Krazy Monkee';
}
function generateTitle(notes) {
  const str = (notes || '').trim();
  if (!str) return 'General Note';
  const first = str.split('\n')[0];
  const m = first.match(/(meeting|call|client|task|idea)[:\- ]+(.*)/i);
  if (m && m[2]) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}: ${m[2]}`.slice(0, 60);
  return first.split(/\s+/).slice(0, 6).join(' ').slice(0, 60) || 'General Note';
}

// Data access
async function listAllNotes() {
  const sheets = await getSheetsClient();
  const title = await ensureHeaders();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${title}!A2:D`
  });
  const rows = r.data.values || [];
  return {
    sheetTitle: title,
    rows: rows.map((row, i) => ({
      rowIndex: i + 2,
      title: row[0] || '',
      dateTime: row[1] || '',
      tag: row[2] || '',
      notes: row[3] || ''
    }))
  };
}

function formatChicagoStamp() {
  const d = chicagoNow();
  const y = d.getFullYear();
  const m = `${d.getMonth()+1}`.padStart(2,'0');
  const day = `${d.getDate()}`.padStart(2,'0');
  const hh = `${d.getHours()}`.padStart(2,'0');
  const mm = `${d.getMinutes()}`.padStart(2,'0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

async function createNote({ title, tag, notes }) {
  const sheets = await getSheetsClient();
  const sheetTitle = await ensureHeaders();
  const finalTitle = (title && title.trim()) || generateTitle(notes);
  const finalTag = (tag && tag.trim()) || classifyTag({ title: finalTitle, notes });
  const fixedTimestamp = formatChicagoStamp(); // immutable

  const values = [[finalTitle, fixedTimestamp, finalTag, notes || '']];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A:D`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });

  const all = await listAllNotes();
  const rowIndex = all.rows[all.rows.length - 1]?.rowIndex;
  return { rowIndex, title: finalTitle, tag: finalTag, dateTime: fixedTimestamp };
}

async function readNote({ rowIndex }) {
  const { rows } = await listAllNotes();
  return rows.find(r => r.rowIndex === Number(rowIndex)) || null;
}

async function updateNote({ rowIndex, title, tag, notes, deleteFields }) {
  const sheets = await getSheetsClient();
  const sheetTitle = await ensureHeaders();
  const idx = Number(rowIndex);
  if (!idx || idx < 2) throw new Error('rowIndex must be >= 2');

  const current = await readNote({ rowIndex: idx });
  if (!current) throw new Error(`Row ${idx} not found`);

  const toClear = new Set((deleteFields || []).map(s => s.toUpperCase()));
  const newTitle = toClear.has('TITLE') ? '' : (title ?? current.title);
  const newTag = toClear.has('TAG') ? '' : (tag ?? current.tag);
  const newNotes = toClear.has('NOTES') ? '' : (notes ?? current.notes);

  const finalTitle = newTitle || generateTitle(newNotes);
  const finalTag = newTag || classifyTag({ title: finalTitle, notes: newNotes });

  const values = [[finalTitle, current.dateTime, finalTag, newNotes]];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A${idx}:D${idx}`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });

  return { rowIndex: idx, title: finalTitle, tag: finalTag, dateTime: current.dateTime };
}

async function deleteNote({ rowIndex }) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets?.[0];
  if (!sheet) throw new Error('No sheet found');
  const sheetId = sheet.properties?.sheetId;
  const idx = Number(rowIndex);
  if (!idx || idx < 2) throw new Error('rowIndex must be >= 2');

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: idx - 1, endIndex: idx }
        }
      }]
    }
  });
  return { ok: true, rowIndex: idx, deleted: true };
}

// Analyze / Suggest
const STOPWORDS = new Set('a an and are as at be but by for from has have i in is it of on or that the to was were will with you your ya heard me ya mama and them beaucoup this that those these our your their we he she they him her them what which whose whom where when how why not dont can cant will wont its it’s just make makes made like look looking'.split(/\s+/));

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w) && w.length > 2);
}
function topN(map, n = 15) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([term, count]) => ({ term, count }));
}
function analyzeRows(rows) {
  const byTag = { 'Hanuman Life': 0, 'Krazy Monkee': 0, 'Dev & Design Education': 0, '': 0 };
  const byDay = new Map();
  const vocab = new Map();
  const recentCut = Date.now() - 7 * 24 * 3600 * 1000;
  let recent = 0;

  for (const r of rows) {
    byTag[r.tag || ''] = (byTag[r.tag || ''] || 0) + 1;
    const day = (r.dateTime || '').split(' ')[0];
    if (day) byDay.set(day, (byDay.get(day) || 0) + 1);

    tokenize(`${r.title} ${r.notes}`).forEach(t => vocab.set(t, (vocab.get(t) || 0) + 1));

    const t = new Date(r.dateTime.replace(' ', 'T'));
    if (!isNaN(t) && t.getTime() >= recentCut) recent++;
  }

  return {
    totals: { count: rows.length, recent7d: recent },
    byTag,
    byDay: [...byDay.entries()].map(([date, count]) => ({ date, count })),
    topTerms: topN(vocab, 15)
  };
}
function suggestFromAnalysis(analysis) {
  const { byTag, topTerms } = analysis;
  const maxTag = Object.entries(byTag).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0]?.[0] || '';
  const focus = maxTag === 'Krazy Monkee' ? 'client work & marketing'
              : maxTag === 'Dev & Design Education' ? 'skills growth & study blocks'
              : 'personal logistics & well-being';

  const headline = `Focus is leaning toward **${maxTag || 'Unassigned'}** — prioritize ${focus}.`;
  const keywords = topTerms.slice(0, 5).map(t => t.term);
  const recs = [];

  if (maxTag === 'Krazy Monkee') {
    recs.push('Turn top mentions into tasks (“proposal”, “edit”, “invoice”) with Do/Due times.');
    recs.push('Schedule a 60–90 min deep block for a Strategic Win inside your biggest gap.');
  } else if (maxTag === 'Dev & Design Education') {
    recs.push('Create a repeating “study sprint” block (45–60 min) and log outcomes.');
    recs.push('Convert repeated topics into a mini-curriculum checklist.');
  } else if (maxTag === 'Hanuman Life') {
    recs.push('Batch errands and calls into a single afternoon block this week.');
    recs.push('Add one small daily habit tied to meditation, prayer, or fitness.');
  } else {
    recs.push('Tag your notes (Hanuman Life, Krazy Monkee, Dev & Design Education) for sharper insights.');
  }

  if (keywords.length) {
    recs.push(`Consider actions around: ${keywords.join(', ')}.`);
  }
  return { headline, recommendations: recs };
}

// -------------------- NOTES Endpoints --------------------
app.post('/notes/trigger', (req, res) => {
  res.json({ ok: true, message: 'Ready to Take some notes' });
});

app.post('/notes/create', async (req, res) => {
  try {
    const { title, tag, notes } = req.body || {};
    if (!notes || typeof notes !== 'string' || !notes.trim()) {
      return res.status(400).json({ error: 'notes is required' });
    }
    const created = await createNote({ title, tag, notes });
    res.json({ ok: true, ...created, message: 'Note saved.' });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/notes/list', async (req, res) => {
  try {
    const { tag, fromDate, toDate, limit = 50 } = req.body || {};
    const { rows } = await listAllNotes();
    let filtered = rows;
    if (tag) filtered = filtered.filter(r => (r.tag || '').toLowerCase() === tag.toLowerCase());
    if (fromDate) filtered = filtered.filter(r => r.dateTime >= `${fromDate} 00:00`);
    if (toDate) filtered = filtered.filter(r => r.dateTime <= `${toDate} 23:59`);
    res.json({ ok: true, count: filtered.length, rows: filtered.slice(-limit) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/notes/read', async (req, res) => {
  try {
    const { rowIndex } = req.body || {};
    if (!rowIndex) return res.status(400).json({ error: 'rowIndex is required' });
    const row = await readNote({ rowIndex });
    if (!row) return res.status(404).json({ error: 'Note not found' });
    res.json({ ok: true, note: row });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/notes/update', async (req, res) => {
  try {
    const { rowIndex, title, tag, notes, deleteFields } = req.body || {};
    if (!rowIndex) return res.status(400).json({ error: 'rowIndex is required' });
    const updated = await updateNote({ rowIndex, title, tag, notes, deleteFields });
    res.json({ ok: true, ...updated, message: 'Note updated.' });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/notes/delete', async (req, res) => {
  try {
    const { rowIndex } = req.body || {};
    if (!rowIndex) return res.status(400).json({ error: 'rowIndex is required' });
    const r = await deleteNote({ rowIndex });
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/notes/analyze', async (req, res) => {
  try {
    const { rows } = await listAllNotes();
    const analysis = analyzeRows(rows);
    res.json({ ok: true, analysis });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/notes/suggest', async (req, res) => {
  try {
    const { rows } = await listAllNotes();
    const analysis = analyzeRows(rows);
    const ideas = suggestFromAnalysis(analysis);
    res.json({ ok: true, analysisSummary: analysis.totals, suggestion: ideas });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NOLA Buddy API listening on port ${PORT}`);
});
