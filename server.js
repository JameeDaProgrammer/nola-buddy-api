import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json());

const NOTION_SECRET = process.env.NOTION_SECRET;
if (!NOTION_SECRET) {
  console.warn('WARNING: NOTION_SECRET not set. Set it in env vars (Render) or .env for local dev.');
}

const NOTION_VERSION = '2022-06-28';

async function notionPost(path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_SECRET}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${res.status}: ${text}`);
  }
  return res.json();
}

function titleOf(db) {
  return (db.title?.map(t => t.plain_text).join('').trim() || '');
}

async function findDatabaseByName(name) {
  const data = await notionPost('/search', {
    query: name,
    filter: { property: 'object', value: 'database' },
    page_size: 50
  });
  const results = data.results || [];
  const lower = name.toLowerCase();
  const exact = results.find(d => titleOf(d).toLowerCase() === lower);
  return exact || results.find(d => titleOf(d).toLowerCase().includes(lower)) || null;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, node: process.version, hasSecret: !!NOTION_SECRET });
});

app.post('/nolaAddPage', async (req, res) => {
  try {
    if (!NOTION_SECRET) return res.status(500).json({ error: 'Server missing NOTION_SECRET' });
    const { databaseName, pageTitle, status, extraProperties } = req.body || {};
    if (!databaseName || !pageTitle) {
      return res.status(400).json({
        error: 'databaseName and pageTitle are required',
        example: { databaseName: 'Projects List', pageTitle: 'Money Man', status: 'Active' }
      });
    }

    const db = await findDatabaseByName(databaseName);
    if (!db) return res.status(404).json({ error: `Database "${databaseName}" not found or not shared with integration.` });

    const properties = {
      // If your DB's title property isn't called "Name", change it here
      Name: { title: [{ text: { content: pageTitle } }] },
      ...(status ? { Status: { status: { name: status } } } : {}),
      ...(extraProperties && typeof extraProperties === 'object' ? extraProperties : {})
    };

    const created = await notionPost('/pages', { parent: { database_id: db.id }, properties });
    res.json({ ok: true, databaseId: db.id, pageId: created.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NOLA Buddy API listening on port ${PORT}`);
});
