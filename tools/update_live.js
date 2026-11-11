#!/usr/bin/env node
// Copy telemetry CSV exports into web/data/<project>/live/<station>.csv for the iWASAM page.
//
//   node tools/update_live.js [--since YYYY-MM-DD] <export.csv> [...]
//
// The station comes from the file name (e.g. weather-data-RID-KU030_2026-10-02.csv → RID-KU030,
// RID-KU-WL001-2026-10-02.csv → RID-KU-WL001), matched against "station" in web/data/iwasam.json.
// Rows before --since (default: one day before the start of the run's control) are dropped, rows
// already in the live file are kept, rows in the new export replace rows with the same time, and
// the result is written oldest-first.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'web');
const L = require(path.join(ROOT, 'live.js'));
const H = require(path.join(ROOT, 'engine.js'));

const args = process.argv.slice(2);
let since = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') since = L.parseTime(args[++i]);
  else files.push(args[i]);
}
if (!files.length) { console.error('usage: node tools/update_live.js [--since YYYY-MM-DD] <export.csv> [...]'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'iwasam.json'), 'utf8'));
const projDir = path.join(ROOT, 'data', cfg.project);
if (since == null) {
  // start of the run's control specifications, less a day
  const runs = fs.readdirSync(projDir).filter(n => /\.run$/i.test(n)).flatMap(n => H.readRuns(fs.readFileSync(path.join(projDir, n), 'utf8')));
  const run = runs.find(r => r.name === cfg.run);
  for (const n of fs.readdirSync(projDir).filter(n => /\.control$/i.test(n))) {
    const text = fs.readFileSync(path.join(projDir, n), 'utf8');
    const b = H.parseHms(text).find(x => x.kind === 'Control');
    if (b && run && b.name === run.control) since = H.readControl(text).start - 86400000;
  }
  if (since == null) { console.error(`cannot find the control of run "${cfg.run}"; pass --since`); process.exit(1); }
}

const quote = (c) => /[",\n]/.test(c) || c === '' ? `"${String(c).replace(/"/g, '""')}"` : c;
const stations = Object.entries(cfg.gages).map(([name, c]) => ({ name, c, code: L.normCode(c.station || name) })).sort((a, b) => b.code.length - a.code.length);
let failed = 0;
for (const f of files) {
  const key = L.normCode(path.basename(f));
  const hit = stations.find(s => key.includes(s.code));
  if (!hit) { console.error(`${f}: no station of iwasam.json in the file name`); failed++; continue; }
  const out = path.join(projDir, (hit.c.csv && hit.c.csv[0]) || `live/${hit.c.station}.csv`);
  const rows = new Map(); // time → cells
  let head = null;
  const add = (file, replace) => {
    const tb = L.parseTable(fs.readFileSync(file, 'utf8'));
    const { timeOf } = L.timeReader(tb.head, tb.rows);
    if (head && head.join() !== tb.head.join()) { console.warn(`${out}: columns differ from ${path.basename(file)}; the old rows are dropped`); rows.clear(); }
    head = tb.head;
    const seen = new Set();
    for (const r of tb.rows) {
      const t = timeOf(r);
      if (isNaN(t) || t < since) continue;
      if (replace || !rows.has(t)) { rows.set(t, r); seen.add(t); }
    }
    return seen.size;
  };
  if (fs.existsSync(out)) add(out, false);
  const added = add(f, true);
  const times = [...rows.keys()].sort((a, b) => a - b);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, [head, ...times.map(t => rows.get(t))].map(r => r.map(quote).join(',')).join('\r\n') + '\r\n');
  console.log(`${path.basename(f)} → ${path.relative(path.join(ROOT, '..'), out)} (${hit.name}): ${added} rows from the export, ${times.length - added} kept from before, ${times.length} in all, ${H.fmtDateTime(times[0])} to ${H.fmtDateTime(times[times.length - 1])}`);
}
process.exit(failed ? 1 : 0);
