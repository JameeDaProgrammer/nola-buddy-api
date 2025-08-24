import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';

// -------------------- App bootstrap --------------------
const app = express();
app.use(express.json());

const NOTION_SECRET = process.env.NOTION_SECRET;
if (!NOTION_SECRET) {
  console.warn('WARNING: NOTION_SECRET not set. Set it in env vars (Render) or .env for local dev.');
}
const NOTION_VERSION = '2022-06-28';
const TZ = process.env.TZ || 'America/Chicago';

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
  const asParts = dateStr.includes('/') ? dateStr.split('/') : null;
  let isoBase;
  if (asParts) {
    const [m, d, y] = asParts;
    const mm = String(m).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    isoBase = `${y}-${mm}-${dd}`;
  } else {
    isoBase = dateStr; // already YYYY-MM-DD
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
  // returns Date adjusted to Chicago local (clock value equals local)
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  return local;
}
function formatChicago(ts = new Date(), withTime = true) {
  const d = new Date(ts.toLocaleString('en-US', { timeZone: TZ }));
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return withTime ? `${y}-${m}-${day} ${hh}:${mm}` : `${y}-${m}-${day}`;
}

// Produces UTC ISO bounds that match local Chicago midnight → 23:59:59.
function startEndOfToday() {
  const now = new Date();
  const chicagoNowDate = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const delta = now.getTime() - chicagoNowDate.getTime(); // UTC - Chicago offset
  const y = chicagoNowDate.getFullYear(), m = chicagoNowDate.getMonth(), d = chicagoNowDate.getDate();
  const startLocal = new Date(y, m, d, 0, 0, 0);
  const endLocal = new Date(y, m, d, 23, 59, 59);
  const start = new Date(startLocal.getTime() + delta); // convert to UTC
  const end = new Date(endLocal.getTime() + delta); // convert to UTC
  return { startISO: start.toISOString(), endISO: end.toISOString(), y, m: m + 1, d };
}
function next7Window() {
  const now = new Date();
  const chicagoNowDate = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const delta = now.getTime() - chicagoNowDate.getTime();
  const endChic = new Date(chicagoNowDate);
  endChic.setDate(endChic.getDate() + 7);
  const endLocal = new Date(endChic.getFullYear(), endChic.getMonth(), endChic.getDate(), 23, 59, 59);
  const endUTC = new Date(endLocal.getTime() + delta);
  return { startISO: new Date().toISOString(), endISO: endUTC.toISOString() };
}

// -------------------- Health --------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, node: process.version, hasSecret: !!NOTION_SECRET });
});

/* ===========================
   Legacy Notion endpoints kept
   (nolaAddPage, nolaListPages, actionBase/*, analysis/*, databases/*)
   — YOUR ORIGINAL CODE BLOCKS —
   I’m leaving them as-is for brevity; keep them in your file.
   =========================== */

// -----------------------------------------------------------------------------
// -------------------- Google Sheets Notes (Maal Secretary Notes) --------------
// -----------------------------------------------------------------------------

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
  // Prefer a sheet named exactly "Maal Secretary Notes"; else use the first sheet.
  const match = meta.data.sheets?.find(s => s.properties?.title === 'Maal Secretary Notes');
  const title = match?.properties?.title || meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  return title;
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

// ------------- Title + Tag helpers -------------
const EDU_WORDS = [
  'codecademy','freecodecamp','javascript','node','react','express','firebase','gsap','html','css',
  'data structures','algorithms','study','course','tutorial','lesson','practice','design refresher',
  'photoshop','illustrator','indesign','after effects','premiere','premier pro','adobe','bootcamp'
];
const WORK_WORDS = [
  'client','invoice','proposal','deliverable','website','web design','web dev','branding','logo','video','edit',
  'render','notion buddy','crazy monkey','krazy monkee','marketing','ad','campaign','portfolio','mockup'
];
const LIFE_WORDS = [
  'mom','dad','son','daughter','kids','jordan','jace','jamal jr','family','school','homework','pickup','dropoff',
  'work schedule','gentilly mail and copy center','luz','joe','van','dave','rob','exercise','workout','gym',
  'meditate','meditation','pray','prayer','court','appointment','doctor','volunteer','service','church','temple'
];

function bagContains(text, list) {
  const t = ` ${text.toLowerCase()} `;
  return list.some(w => t.includes(` ${w} `) || t.includes(w));
}

function classifyTag({ title, notes }) {
  const text = `${title || ''} ${notes || ''}`.toLowerCase();
  if (bagContains(text, EDU_WORDS)) return 'Dev & Design Education';
  if (bagContains(text, WORK_WORDS)) return 'Krazy Monkee';
  if (bagContains(text, LIFE_WORDS)) return 'Hanuman Life';
  // fallback heuristic: education keywords > work > life order already handled, default to work focus
  return 'Krazy Monkee';
}

function generateTitle(notes) {
  const str = (notes || '').trim();
  if (!str) return 'General Note';
  // If line starts with something that looks like "Meeting with X" keep that
  const firstLine = str.split('\n')[0];
  const meet = firstLine.match(/(meeting|call|client|task|idea)[:\- ]+(.*)/i);
  if (meet && meet[2]) {
    return `${meet[1][0].toUpperCase()}${meet[1].slice(1).toLowerCase()}: ${meet[2]}`.slice(0, 60);
  }
  // else: first 6 words
  const short = firstLine.split(/\s+/).slice(0, 6).join(' ');
  return short.slice(0, 60) || 'General Note';
}

// Pull entire sheet → objects with rowIndex
async function listAllNotes() {
  const sheets = await getSheetsClient();
  const title = await ensureHeaders();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${title}!A2:D`
  });
  const rows = r.data.values || [];
  const res = rows.map((row, i) => ({
    rowIndex: i + 2, // account for header row
    title: row[0] || '',
    dateTime: row[1] || '',
    tag: row[2] || '',
    notes: row[3] || ''
  }));
  return { sheetTitle: title, rows: res };
}

async function createNote({ title, tag, notes }) {
  const sheets = await getSheetsClient();
  const sheetTitle = await ensureHeaders();
  const finalTitle = (title && title.trim()) || generateTitle(notes);
  const finalTag = (tag && tag.trim()) || classifyTag({ title: finalTitle, notes });
  const fixedTimestamp = formatChicago(chicagoNow(), true); // do not change on update
  const values = [[finalTitle, fixedTimestamp, finalTag, notes || '']];
  const r = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A:D`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
  // Compute rowIndex: append returns updates but not the index reliably; re-read tail
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

  // Get current row to preserve Date & Time as fixed
  const current = await readNote({ rowIndex: idx });
  if (!current) throw new Error(`Row ${idx} not found`);

  // Clear fields requested
  const toClear = new Set((deleteFields || []).map(s => s.toUpperCase()));
  const newTitle = toClear.has('TITLE') ? '' : (title ?? current.title);
  const newTag = toClear.has('TAG') ? '' : (tag ?? current.tag);
  const newNotes = toClear.has('NOTES') ? '' : (notes ?? current.notes);

  // If after clear we have no title, regenerate from existing/new notes
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

// --------- ANALYZE / SUGGEST ----------
const STOPWORDS = new Set('a an and are as at be but by for from has have i in is it of on or that the to was were will with you your ya heard me ya mama and them beaucoup'.split(/\s+/));

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w) && w.length > 2);
}

function topN(map, n = 10) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

function analyzeRows(rows) {
  const byTag = { 'Hanuman Life': 0, 'Krazy Monkee': 0, 'Dev & Design Education': 0, '': 0 };
  const byDay = new Map();            // YYYY-MM-DD -> count
  const vocab = new Map();            // token -> count
  const recentCut = Date.now() - 7 * 24 * 3600 * 1000;

  let recent = 0;
  for (const r of rows) {
    byTag[r.tag || ''] = (byTag[r.tag || ''] || 0) + 1;
    const day = (r.dateTime || '').split(' ')[0];
    if (day) byDay.set(day, (byDay.get(day) || 0) + 1);
    const toks = tokenize(`${r.title} ${r.notes}`);
    toks.forEach(t => vocab.set(t, (vocab.get(t) || 0) + 1));

    const t = new Date(r.dateTime.replace(' ', 'T') + ':00Z');
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
    recs.push('Reflect: add one small habit (5–10 min) tied to meditation, prayer, or fitness.');
  } else {
    recs.push('Tag your notes for better insights (Hanuman Life, Krazy Monkee, Dev & Design Education).');
  }

  if (keywords.length) {
    recs.push(`Consider actions around: ${keywords.join(', ')}.`);
  }

  return { headline, recommendations: recs };
}

// -------------------- NOTES Endpoints --------------------

// Trigger helper for GPT flow (“Take these notes.” / “Jot this down.”)
app.post('/notes/trigger', (req, res) => {
  // Let GPT decide when to call this; we simply reply with the prompt-line you wanted.
  res.json({ ok: true, message: 'Ready to Take some notes' });
});

// Create (WRITE)
app.post('/notes/create', async (req, res) => {
  try {
    const { title, tag, notes } = req.body || {};
    if (!notes || typeof notes !== 'string' || !notes.trim()) {
      return res.status(400).json({ error: 'notes is required' });
    }
    const created = await createNote({ title, tag, notes });
    res.json({ ok: true, ...created, message: 'Note saved.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// LIST (quick listing; optional filters)
app.post('/notes/list', async (req, res) => {
  try {
    const { tag, fromDate, toDate, limit = 50 } = req.body || {};
    const { rows } = await listAllNotes();
    let filtered = rows;
    if (tag) filtered = filtered.filter(r => (r.tag || '').toLowerCase() === tag.toLowerCase());
    if (fromDate) filtered = filtered.filter(r => r.dateTime >= `${fromDate} 00:00`);
    if (toDate) filtered = filtered.filter(r => r.dateTime <= `${toDate} 23:59`);
    res.json({ ok: true, count: filtered.length, rows: filtered.slice(-limit) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// READ single (by rowIndex)
app.post('/notes/read', async (req, res) => {
  try {
    const { rowIndex } = req.body || {};
    if (!rowIndex) return res.status(400).json({ error: 'rowIndex is required' });
    const row = await readNote({ rowIndex });
    if (!row) return res.status(404).json({ error: 'Note not found' });
    res.json({ ok: true, note: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// UPDATE (preserves Date & Time)
app.post('/notes/update', async (req, res) => {
  try {
    const { rowIndex, title, tag, notes, deleteFields } = req.body || {};
    if (!rowIndex) return res.status(400).json({ error: 'rowIndex is required' });
    const updated = await updateNote({ rowIndex, title, tag, notes, deleteFields });
    res.json({ ok: true, ...updated, message: 'Note updated.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE (entire row)
app.post('/notes/delete', async (req, res) => {
  try {
    const { rowIndex } = req.body || {};
    if (!rowIndex) return res.status(400).json({ error: 'rowIndex is required' });
    const r = await deleteNote({ rowIndex });
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ANALYZE
app.post('/notes/analyze', async (req, res) => {
  try {
    const { rows } = await listAllNotes();
    const analysis = analyzeRows(rows);
    res.json({ ok: true, analysis });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// SUGGEST / RECOMMEND based on analysis
app.post('/notes/suggest', async (req, res) => {
  try {
    const { rows } = await listAllNotes();
    const analysis = analyzeRows(rows);
    const ideas = suggestFromAnalysis(analysis);
    res.json({ ok: true, analysisSummary: analysis.totals, suggestion: ideas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------------
// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NOLA Buddy API listening on port ${PORT}`);
});
