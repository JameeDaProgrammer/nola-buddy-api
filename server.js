// ------------------- ADDITIONS + FIXES FOR NOLA NOTION BUDDY -------------------

// 1) Get full property snapshot for an Action Base item
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 2) List Action Base items (title + key props)
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 3) Fix: remove stray no-op in /actionBase/pageAppend
// If you have this line in /actionBase/pageAppend, DELETE it:
// const resp = await notion('/blocks', {});

// 4) Helper functions for Today Focus
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
function coachFixNow(page) {
  return 'Do the smallest unblocked step right now and log it in the page.';
}
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
  const timeLabel = dt
    ? dt.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
    : 'no time';

  return {
    id: page.id,
    line: `**${name}** — ${label} • ${timeLabel}${type ? ` — ${type}` : ''}${alignment ? ` — ${alignment}` : ''} — Status: ${status || 'N/A'}`,
    why: coachWhyMatters(page),
    next: coachNextMove(page),
    fix: coachFixNow(page),
    suggestReminder: !!dt && dt > now
  };
}

// 5) Today Focus endpoint
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
          suggestions: (items.filter(p => {
            const pr = readProp(p, 'Priority Level') || '';
            return pr !== 'HIGH';
          }).slice(0,2).map(p => readProp(p, 'Name')) || [])
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
      coachNudge: 'Win the morning, win the day. Knock out the HIGHs first, slide a Strategic Win into your biggest gap, and keep momentum rolling — bet!'
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 6) Flexible period analysis
app.post('/analysis/period', async (req, res) => {
  try {
    const { startDate, endDate } = req.body || {};
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 7) Productivity analysis
app.post('/analysis/productivity', async (req, res) => {
  try {
    const { days = 14 } = req.body || {};
    const db = await findDatabaseByName('Action Base');
    if (!db) return res.status(404).json({ error: 'Database "Action Base" not found or not shared.' });

    const end = new Date();
    const start = new Date(); start.setDate(end.getDate() - (days - 1));
    const startISO = start.toISOString(); const endISO = end.toISOString();

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

    const series = Object.entries(bucket).sort(
      (a,b) => new Date(a[0]) - new Date(b[0])
    ).map(([date, { total, done }]) => ({
      date, total, done, completionRate: total ? Math.round((done/total)*100) : 0
    }));

    const totals = series.reduce((m, x) => ({ total: m.total + x.total, done: m.done + x.done }), { total:0, done:0 });
    const overallRate = totals.total ? Math.round((totals.done / totals.total)*100) : 0;

    res.json({ ok: true, days, overallRate, series });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
