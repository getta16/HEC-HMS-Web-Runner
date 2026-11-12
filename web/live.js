// iWASAM live runner: keeps the KSM (Sep 2026) run going up to the current time.
// Rainfall and flow come from the project's DSS file, telemetry CSV files in data/<project>/live/,
// an optional web API and files dropped on the page; gaps are filled (rain: inverse-distance from the
// other rain gages, else 0; flow: linear across short gaps, else the simulated flow).
// The pure functions at the top are also loaded by tests in Node (module.exports).
(function (root) {
  'use strict';
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  // where a value came from; codes >= 10 are filled
  const SRC = { NONE: 0, DSS: 1, CSV: 2, API: 3, DROP: 4, IDW: 10, ZERO: 11, INTERP: 12, SIM: 13 };
  const isReal = (c) => c > 0 && c < 10;

  // ---------- tables (CSV or JSON) ----------
  function splitLine(line, sep) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === sep) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }
  // JSON: an array of objects or arrays, or an object holding one (at `path`, e.g. "data.items")
  function jsonTable(j, path) {
    let arr = Array.isArray(j) ? j : path ? path.split('.').reduce((o, k) => o && o[k], j) : null;
    if (!arr && j && typeof j === 'object') {
      const seen = [j];
      while (seen.length && !arr) { const o = seen.shift(); for (const v of Object.values(o)) { if (Array.isArray(v)) { arr = v; break; } if (v && typeof v === 'object') seen.push(v); } }
    }
    if (!arr || !arr.length) return { head: [], rows: [] };
    const str = (x) => x == null ? '' : String(x);
    if (Array.isArray(arr[0])) return { head: arr[0].map(str), rows: arr.slice(1).map(r => r.map(str)) };
    // nested objects are flattened ({flow_data: {Q: 1}} → "Q", or "flow_data.Q" when the name repeats);
    // the columns are those of every row, as rows may lack fields
    const flat = arr.map(o => { const out = {}; (function walk(x, p) { for (const [k, v] of Object.entries(x || {})) { if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p ? p + '.' + k : k); else out[p ? p + '.' + k : k] = v; } })(o, ''); return out; });
    const paths = [...new Set(flat.flatMap(Object.keys))], leaf = (p) => p.split('.').pop();
    const head = paths.map(p => paths.filter(q => leaf(q) === leaf(p)).length > 1 ? p : leaf(p));
    return { head, rows: flat.map(o => paths.map(k => str(o[k]))) };
  }
  function parseTable(text, jsonPath) {
    text = String(text).replace(/^﻿/, '');
    if (/^\s*[\[{]/.test(text)) return jsonTable(JSON.parse(text), jsonPath);
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { head: [], rows: [] };
    const sep = [',', ';', '\t'].map(c => [c, lines[0].split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
    return { head: splitLine(lines[0], sep), rows: lines.slice(1).map(l => splitLine(l, sep)) };
  }

  // ---------- time ----------
  // Local (naive) times as UTC milliseconds, like the HMS engine. A time with an explicit offset
  // ("Z", "+07:00") is moved to local time with tzMs. Buddhist years and 2-digit years are accepted.
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function parseTime(s, dayFirst = true, tzMs = 7 * HOUR) {
    s = String(s).trim().replace(/^"|"$/g, '');
    if (/^\d{10,13}$/.test(s)) { const n = +s; return (s.length === 10 ? n * 1000 : n) + tzMs; } // epoch
    const mk = (y, mo, d, h, mi, sec) => {
      y = +y; if (y < 100) y += 2000; if (y > 2400) y -= 543;
      h = +(h || 0); mi = +(mi || 0);
      return mo >= 0 && mo <= 11 && d >= 1 && d <= 31 && h <= 24 && mi < 60 ? Date.UTC(y, mo, +d, h, mi, +(sec || 0)) : NaN;
    };
    const zone = (v, z) => {
      if (!z || isNaN(v)) return v;
      if (/^z$/i.test(z)) return v + tzMs;
      const m = /^([+-])(\d{2}):?(\d{2})$/.exec(z);
      return m ? v - (m[1] === '-' ? -1 : 1) * (+m[2] * HOUR + +m[3] * MIN) + tzMs : v;
    };
    let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
    if (m) return zone(mk(m[1], m[2] - 1, m[3], m[4], m[5], m[6]), m[7]);
    m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) return dayFirst ? mk(m[3], m[2] - 1, m[1], m[4], m[5], m[6]) : mk(m[3], m[1] - 1, m[2], m[4], m[5], m[6]);
    m = /^(\d{1,2})[-\s]?([A-Za-z]{3})[A-Za-z]*[-\s]?(\d{2,4})(?:[ ,T]+(\d{1,2}):?(\d{2}))?$/.exec(s);
    if (m && MON[m[2].toLowerCase()] !== undefined) return mk(m[3], MON[m[2].toLowerCase()], m[1], m[4], m[5]);
    return NaN;
  }

  // ---------- telemetry readers ----------
  // A station export (RID-KU weather / water-level CSV, an HEC-HMS CSV export, or API rows): a date-time
  // column (or separate date and time columns) and a value column. Rows may be newest-first, repeated or
  // off the clock; "-" and blanks are missing. Rain "rainfall from 7am" is cumulative since 07:00.
  const RAIN_COL = /rain|precip|ฝน/i, RAIN_CUM = /from\s*7\s*am|since\s*7|cum|สะสม/i;
  const FLOW_COL = /^q\b|^q\s*\(|discharge|\bflow\b|น้ำท่า|ปริมาณน้ำ/i;
  // time: "datetime"/"timestamp", else "date" + "time", else the first column (joined with the second
  // when that holds the clock, as in HEC-HMS exports "18-Sep-23, 00:00") → { timeOf(row), tcols }
  function timeReader(head, rows, tzMs) {
    let tcols = null;
    const dti = head.findIndex(h => /date\s*-?\s*time|timestamp|วันเวลา/i.test(h));
    const di = head.findIndex(h => /date|วันที่/i.test(h)), ti = head.findIndex((h, j) => j !== di && /^time\b|เวลา/i.test(h) && !/date/i.test(h));
    if (dti >= 0) tcols = [dti]; else if (di >= 0 && ti >= 0) tcols = [di, ti];
    const dateOf = (r, cols) => cols.map(c => r[c] || '').join(' ');
    const sample = rows.slice(0, 50).concat(rows.slice(-50));
    if (!tcols) tcols = sample.some(r => /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(r[1] || '').trim())) ? [0, 1] : [0];
    // d/m/y unless a row only makes sense as m/d/y
    const dayFirst = !sample.some(r => { const m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.]\d{2,4}/.exec(dateOf(r, tcols)); return m && +m[2] > 12; });
    return { tcols, timeOf: (r) => parseTime(dateOf(r, tcols), dayFirst, tzMs) };
  }
  function readSeries(text, kind, opt = {}) {
    const tb = parseTable(text, opt.jsonPath);
    const head = tb.head.map(h => h.replace(/^"|"$/g, ''));
    if (!head.length || !tb.rows.length) throw new Error('empty');
    const want = opt.column ? new RegExp(opt.column, 'i') : kind === 'rain' ? RAIN_COL : FLOW_COL;
    const vi = head.findIndex(h => want.test(h));
    if (vi < 0) throw new Error('no ' + kind + ' column');
    const cumulative = kind === 'rain' && (opt.cumulative != null ? !!opt.cumulative : RAIN_CUM.test(head[vi]));
    const unit = head[vi];
    const k = kind === 'rain' ? (/\(\s*in(ch(es)?)?\s*\)/i.test(unit) ? 25.4 : 1) : (/cfs/i.test(unit) ? 0.3048 ** 3 : 1);
    const { timeOf, tcols } = timeReader(head, tb.rows, opt.tzMs);
    const val = vi + (tcols.length === 2 && tcols[1] === 1 && vi > 0 && head.length < (tb.rows[0] || []).length ? 1 : 0);
    const byT = new Map();
    let bad = 0;
    for (const r of tb.rows) {
      const tm = timeOf(r);
      if (isNaN(tm)) { bad++; continue; }
      const sv = String(r[val] ?? '').replace(/^"|"$/g, '').trim();
      const x = sv === '' || /^(-|—|na|n\/a|nan|null|none)$/i.test(sv) ? NaN : parseFloat(sv.replace(/,/g, ''));
      const v = x <= -900 ? NaN : x * k; // -999, -990: the telemetry's "no reading"
      if (!byT.has(tm) || (isNaN(byT.get(tm)) && !isNaN(v))) byT.set(tm, v); // repeated rows: keep a value
    }
    if (!byT.size) throw new Error('no dated rows');
    const points = [...byT.entries()].sort((a, b) => a[0] - b[0]);
    return { points, cumulative, column: head[vi], rows: tb.rows.length, bad, first: points[0][0], last: lastValid(points) };
  }
  function lastValid(points) { for (let i = points.length - 1; i >= 0; i--) if (!isNaN(points[i][1])) return points[i][0]; return NaN; }
  // an earlier read followed by a newer one that starts later: the newer one wins where both have rows
  function joinSeries(old, add) {
    const points = old.points.filter(p => p[0] < add.first).concat(add.points);
    return { ...add, points, rows: old.rows + add.rows, first: points[0][0], last: lastValid(points) };
  }
  // the end of the last value of a gage's DSS record (NaN if none)
  function recLast(g) {
    const r = g && g.rec;
    if (!r || r.pattern || !r.values) return NaN;
    for (let i = r.values.length - 1; i >= 0; i--) if (!isNaN(r.values[i])) return r.start + (i + 1) * r.interval * MIN;
    return NaN;
  }

  // ---------- onto a regular grid ----------
  // grid = { start, step (ms), n }; value i belongs to the period (start + i·step, start + (i+1)·step],
  // as an HMS gage record with that start and interval.
  const gridTime = (g, i) => g.start + (i + 1) * g.step;
  // spread `depth` evenly over the grid periods inside (a, b] (a, b on the grid)
  function addDepth(out, g, a, b, depth) {
    const i0 = Math.max(0, Math.round((a - g.start) / g.step)), i1 = Math.min(g.n, Math.round((b - g.start) / g.step));
    const k = Math.round((b - a) / g.step);
    if (k <= 0) return;
    for (let i = i0; i < i1; i++) out[i] = (isNaN(out[i]) ? 0 : out[i]) + depth / k;
  }
  // rainfall readings → depth per period (NaN where unknown). Cumulative "since 07:00" readings are
  // differenced; across 07:00 only the rain since 07:00 is known. Steps above maxPerHour (mm/h) are dropped.
  function rainToGrid(series, g, opt = {}) {
    const out = new Float64Array(g.n).fill(NaN);
    const snap = (t) => g.start + Math.round((t - g.start) / g.step) * g.step;
    const pts = series.points.filter(p => !isNaN(p[1]) && p[1] >= 0);
    const resetMs = (opt.resetHour ?? 7) * HOUR;
    const lo = g.start, hi = g.start + g.n * g.step;
    if (series.cumulative) {
      for (let j = 1; j < pts.length; j++) {
        const ta = snap(pts[j - 1][0]), tb = snap(pts[j][0]), ca = pts[j - 1][1], cb = pts[j][1];
        if (tb <= ta || tb <= lo || ta >= hi) continue;
        const s7 = Math.floor((tb - resetMs - 1) / DAY) * DAY + resetMs; // last reset strictly before tb
        if (ta >= s7) addDepth(out, g, ta, tb, cb >= ca ? cb - ca : cb);
        else addDepth(out, g, s7, tb, cb); // the rain before the reset is unknown
      }
    } else {
      let dt = Infinity;
      for (let j = 1; j < pts.length; j++) dt = Math.min(dt, pts[j][0] - pts[j - 1][0]);
      if (!isFinite(dt)) dt = g.step;
      for (const [t, v] of pts) { const tb = snap(t); if (tb > lo && tb - dt < hi) addDepth(out, g, snap(tb - dt), tb, v); }
    }
    const max = (opt.maxPerHour ?? 150) * g.step / HOUR;
    for (let i = 0; i < g.n; i++) if (out[i] > max) out[i] = NaN;
    // shiftMinutes moves the depths in time (e.g. -5: the rain between two readings goes to the earlier one, as in the KSM DSS records)
    const k = Math.round((opt.shiftMinutes || 0) * MIN / g.step);
    if (k) { const sh = new Float64Array(g.n).fill(NaN); for (let i = 0; i < g.n; i++) if (i - k >= 0 && i - k < g.n) sh[i - k] = out[i]; return sh; }
    return out;
  }
  // flow readings → value at each grid time from the nearest reading within half a step
  function flowToGrid(series, g) {
    const out = new Float64Array(g.n).fill(NaN), dist = new Float64Array(g.n).fill(Infinity);
    for (const [t, v] of series.points) {
      if (isNaN(v) || v < 0) continue;
      const i = Math.round((t - g.start) / g.step) - 1, d = Math.abs(t - gridTime(g, i));
      if (i < 0 || i >= g.n || d > g.step / 2 || d >= dist[i]) continue;
      out[i] = v; dist[i] = d;
    }
    return out;
  }
  // an HMS-style record {start, interval (min), values} → grid (rain: sum or split depths; flow: linear)
  function recordToGrid(s, g, kind) {
    const out = new Float64Array(g.n).fill(NaN), ds = s.interval * MIN, vals = s.values;
    if (kind === 'rain') {
      if (ds <= g.step) {
        const sum = new Float64Array(g.n), cov = new Float64Array(g.n), bad = new Uint8Array(g.n);
        const j0 = Math.max(0, Math.floor((g.start - s.start) / ds)), j1 = Math.min(vals.length, Math.ceil((g.start + g.n * g.step - s.start) / ds));
        for (let j = j0; j < j1; j++) {
          const b = s.start + (j + 1) * ds, i = Math.ceil((b - g.start) / g.step) - 1;
          if (i < 0 || i >= g.n) continue;
          if (isNaN(vals[j])) bad[i] = 1; else sum[i] += vals[j];
          cov[i] += ds;
        }
        for (let i = 0; i < g.n; i++) if (!bad[i] && cov[i] >= g.step - 1) out[i] = sum[i];
      } else {
        for (let j = 0; j < vals.length; j++) if (!isNaN(vals[j])) addDepth(out, g, s.start + j * ds, s.start + (j + 1) * ds, vals[j]);
      }
      return out;
    }
    for (let i = 0; i < g.n; i++) {
      const x = (gridTime(g, i) - s.start) / ds - 1, j = Math.floor(x + 1e-9), f = x - j;
      if (j < 0 || j >= vals.length) continue;
      out[i] = f < 1e-9 ? vals[j] : j + 1 < vals.length ? vals[j] + f * (vals[j + 1] - vals[j]) : NaN;
    }
    return out;
  }
  // layers in priority order (first wins where it has a value) → {values, src}
  function mergeLayers(layers, n) {
    const values = new Float64Array(n).fill(NaN), src = new Uint8Array(n);
    for (const L of layers) for (let i = 0; i < n; i++) if (!src[i] && !isNaN(L.values[i])) { values[i] = L.values[i]; src[i] = L.code; }
    return { values, src };
  }

  // ---------- gap filling ----------
  function distKm(a, b) {
    const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  // gages: [{name, values, src, coord:[lat, lon]}] on one grid; missing steps take the inverse-distance
  // weighted rain of the gages that have data at that step, or 0 when none has
  function fillRain(gages, power = 2) {
    const n = gages.length ? gages[0].values.length : 0;
    const out = gages.map(g => ({ name: g.name, values: Float64Array.from(g.values), src: Uint8Array.from(g.src) }));
    const W = gages.map(a => gages.map(b => a === b || !a.coord || !b.coord ? 0 : 1 / Math.max(0.01, distKm(a.coord, b.coord)) ** power));
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < gages.length; a++) {
        if (isReal(gages[a].src[i])) continue;
        let sw = 0, sv = 0;
        for (let b = 0; b < gages.length; b++) if (W[a][b] > 0 && isReal(gages[b].src[i])) { sw += W[a][b]; sv += W[a][b] * gages[b].values[i]; }
        out[a].values[i] = sw > 0 ? sv / sw : 0;
        out[a].src[i] = sw > 0 ? SRC.IDW : SRC.ZERO;
      }
    }
    return out;
  }
  // observed flow with gaps (NaN) → linear across gaps of at most maxSteps with data on both sides,
  // else the simulated flow. how: 0 observed, SRC.INTERP, SRC.SIM
  function fillFlow(obs, sim, maxSteps) {
    const n = obs.length, values = Float64Array.from(obs), how = new Uint8Array(n);
    for (let i = 0; i < n;) {
      if (!isNaN(obs[i])) { i++; continue; }
      let j = i; while (j < n && isNaN(obs[j])) j++;
      const a = i - 1, b = j; // valid neighbours (a >= 0, b < n)
      if (a >= 0 && b < n && j - i <= maxSteps) for (let k = i; k < j; k++) { values[k] = obs[a] + (obs[b] - obs[a]) * (k - a) / (b - a); how[k] = SRC.INTERP; }
      else for (let k = i; k < j; k++) { values[k] = sim ? sim[k] : NaN; how[k] = SRC.SIM; }
      i = j;
    }
    return { values, how };
  }
  // runs of flagged steps → [[t0, t1]] for periods (t0 = period start)
  function spans(flags, timeOf, step) {
    const out = [];
    for (let i = 0; i < flags.length;) {
      if (!flags[i]) { i++; continue; }
      let j = i; while (j < flags.length && flags[j]) j++;
      out.push([timeOf(i) - step, timeOf(j - 1)]);
      i = j;
    }
    return out;
  }
  const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const core = { SRC, isReal, parseTable, parseTime, timeReader, readSeries, joinSeries, rainToGrid, flowToGrid, recordToGrid, mergeLayers, fillRain, fillFlow, spans, distKm, normCode, gridTime };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }

  // =====================================================================================
  // browser: drive the HEC-HMS web runner (app.js passes its internals to start())
  // =====================================================================================
  const STR = {
    th: {
      lede: 'รันแบบจำลอง HEC-HMS ลุ่มน้ำ KSM (Run sep2026) ต่อเนื่องจนถึงเวลาปัจจุบันในเบราว์เซอร์ ทุก 15 นาทีหน้านี้จะดึงข้อมูลฝนและน้ำท่าล่าสุด เติมช่วงที่ข้อมูลขาดหาย แล้วรันใหม่ให้เอง',
      notice: '<b>ค่าที่เติมไม่ใช่ข้อมูลตรวจวัด</b> ช่วงที่แรเงาสีส้มบนกราฟคือช่วงที่เติมข้อมูล ช่วงสีแดงคือไม่มีข้อมูลฝนเลยจึงถือว่าฝน = 0 ค่าสถิติเทียบน้ำท่า (NSE, KGE) คำนวณจากข้อมูลจริงเท่านั้น',
      methodsTitle: 'ที่มาของข้อมูลและวิธีเติมข้อมูล',
      methods: '<p><b>ลำดับแหล่งข้อมูล</b>ไฟล์ที่นำเข้าในหน้านี้ → KSM_004_Desktop_V2.dss (ถึง 30 ก.ย. 2026) → ไฟล์โทรมาตรใน web/data/ksm/live/ → API iwasam.com/ksm (ถ้าเปิดใน iwasam.json) ช่วงเวลาใดที่แหล่งก่อนหน้าไม่มีค่า จะใช้แหล่งถัดไป</p><p><b>สถานีฝน</b>RID-KU 001 ← RID-KU030 คลองน้ำไหล · 002 ← RID-KU033 หินชะโงก · 003 ← RID-KU040 เทพนคร · 004 ← RID-KU045 อบต.เนินสว่าง ฝน “rainfall from 7am” เป็นฝนสะสมตั้งแต่ 7 โมงเช้า หน้านี้แปลงเป็นฝนราย 5 นาที (ผลต่างของค่าสะสม เริ่มนับใหม่หลัง 07:00) ค่าที่เกิน 150 มม./ชม. ถือว่าเครื่องวัดผิดพลาด</p><p><b>เติมข้อมูลฝน</b>ช่วงที่สถานีไม่มีข้อมูล ใช้ค่าเฉลี่ยถ่วงน้ำหนักด้วยระยะทาง (IDW, กำลัง 2) จากสถานีอื่นที่มีข้อมูลในช่วงเวลาเดียวกัน ถ้าไม่มีสถานีใดมีข้อมูล ถือว่าฝน = 0</p><p><b>สถานีน้ำท่า</b>RID-KU-WL001 (Weir_KSM), RID-KU-WL008 (Weir_TKD) จากไฟล์โทรมาตร ค่า Q (m3/s) ราย 15 นาที · RID-KU-WL006 (Weir_NPK) ยกเลิกแล้ว ใช้ RID-KU-WL008 × 0.8</p><p><b>เติมข้อมูลน้ำท่า</b>ช่องว่างไม่เกิน 6 ชั่วโมงที่มีข้อมูลทั้งสองฝั่ง ลากเส้นตรง ช่องว่างที่ยาวกว่านั้นหรือหลังข้อมูลล่าสุด ใช้น้ำท่าจากแบบจำลอง ปุ่ม “ส่งออกน้ำท่าเป็น CSV” ที่ element จะมีคอลัมน์น้ำท่าเติมข้อมูลและวิธีที่ใช้</p><p><b>อัปเดตข้อมูล</b>หน้านี้ดึงข้อมูลจาก API iwasam.com/ksm เอง (ฝน: api/weather/สถานี, น้ำท่า: api/water/สถานี ค่า -999 ถือว่าไม่มีข้อมูล) ครั้งแรกขอเฉพาะช่วงหลังข้อมูล DSS/CSV จากนั้นขอเฉพาะวันล่าสุดทุกครั้งที่อัปเดต หรือดาวน์โหลดไฟล์ CSV จากระบบโทรมาตร แล้วลากมาวางในหน้านี้ (ใช้เฉพาะเครื่องนี้) หรือให้ทุกคนเห็น: รัน <code>node tools/update_live.js ไฟล์.csv …</code> แล้ว commit โฟลเดอร์ web/data/ksm/live</p>',
      liveTitle: 'ข้อมูลฝนและน้ำท่า · อัปเดตอัตโนมัติ',
      liveHint: (a, b) => `รันล่าสุด ${a} · อัปเดตครั้งต่อไป ${b}`,
      liveHintOff: (a) => `รันล่าสุด ${a} · ปิดการอัปเดตอัตโนมัติ`,
      window: (a, b, d) => `ช่วงที่รัน ${a} ถึง ${b} (ปัจจุบัน) · ${d} วัน`,
      updateNow: '⟳ อัปเดตเดี๋ยวนี้', importTele: '⭱ นำเข้าไฟล์โทรมาตร', importTip: 'ไฟล์ CSV ที่ดาวน์โหลดจากระบบโทรมาตร เช่น weather-data-RID-KU030_….csv หรือ RID-KU-WL001-….csv ใช้เฉพาะในหน้านี้ (ไม่ได้บันทึกขึ้นเว็บ)',
      auto: 'อัปเดตอัตโนมัติ',
      fetching: 'กำลังดึงข้อมูลฝนและน้ำท่า…', loadingCfg: 'กำลังโหลด iWASAM…',
      thGage: 'สถานีในแบบจำลอง', thStation: 'ข้อมูลจาก', thKind: 'ชนิด', thLast: 'ข้อมูลจริงล่าสุด', thReal: 'ข้อมูลจริง', thFilled: 'เติมข้อมูล', thStrip: 'ความครบของข้อมูลในช่วงที่รัน',
      rain: 'ฝน', flow: 'น้ำท่า',
      lgReal: 'ข้อมูลจริง', lgIdw: 'เติมจากสถานีข้างเคียง (IDW)', lgZero: 'ไม่มีข้อมูล ถือว่าฝน = 0', lgInterp: 'ประมาณช่วงสั้น (เส้นตรง)', lgSim: 'ใช้น้ำท่าจากแบบจำลอง',
      filledRain: (idw, zero) => `IDW ${idw} · ฝน 0 ${zero}`, filledFlow: (ip, sim) => `เส้นตรง ${ip} · แบบจำลอง ${sim}`,
      derived: (g, k) => `= ${g} × ${k}`,
      srcNames: { 1: 'DSS', 2: 'CSV', 3: 'API', 4: 'นำเข้า' },
      noFile: (f) => `ไม่พบไฟล์ ${f}`, readErr: (f, e) => `อ่าน ${f} ไม่ได้: ${e}`, apiErr: (s, e) => `API ${s}: ${e}`,
      dropped: (ok, bad) => `นำเข้า ${ok}${bad ? ` · ไม่รู้จักสถานีของไฟล์ ${bad}` : ''}`,
      dropNone: 'ไม่พบไฟล์ที่ตรงกับสถานีในแบบจำลอง (ชื่อไฟล์ต้องมีรหัสสถานี เช่น RID-KU030 หรือ RID-KU-WL001)',
      notes: 'หมายเหตุ', obsFilled: (g) => `น้ำท่าเติมข้อมูล (${g})`, bandFill: 'ช่วงที่เติมข้อมูล', bandNone: 'ช่วงที่ไม่มีข้อมูลฝน',
      colFilled: (g, u) => `${g} filled (${u})`, colHow: 'fill method',
      steps: (n) => n.toLocaleString('en-US'),
      cfgErr: (e) => `อ่าน iwasam.json ไม่ได้ (${e}) ใช้ค่าตั้งต้น`,
      nowNote: (t) => `หลัง ${t} ยังไม่มีข้อมูลจริงจากสถานีใดเลย ฝนช่วงนั้นจึงเป็น 0 และน้ำท่าตรวจวัดใช้ค่าจากแบบจำลอง`,
    },
    en: {
      lede: 'Runs the HEC-HMS model of the KSM basin (Run sep2026) continuously up to the current time in the browser. Every 15 minutes the page fetches the latest rainfall and flow, fills the missing periods and runs again.',
      notice: '<b>Filled values are not measurements.</b> Orange shading on the charts marks filled periods; red marks periods with no rainfall data at all, where rain is taken as 0. Fit statistics (NSE, KGE) use real observations only.',
      methodsTitle: 'Data sources and gap filling',
      methods: '<p><b>Source order</b>Files imported on this page → KSM_004_Desktop_V2.dss (to 30 Sep 2026) → telemetry files in web/data/ksm/live/ → the iwasam.com/ksm API (when enabled in iwasam.json). Where a source has no value, the next one is used.</p><p><b>Rain gages</b>RID-KU 001 ← RID-KU030 Khlong Nam Lai · 002 ← RID-KU033 Hin Chanong · 003 ← RID-KU040 Thep Nakhon · 004 ← RID-KU045 Noen Sawang SAO. “Rainfall from 7am” is cumulative since 07:00; the page turns it into 5-minute rain (differences of the cumulative value, restarting after 07:00). Steps above 150 mm/h are treated as gauge errors.</p><p><b>Rain gap filling</b>A gage without data takes the inverse-distance weighted rain (IDW, power 2) of the gages that have data at that time; when none has, rain is 0.</p><p><b>Flow gages</b>RID-KU-WL001 (Weir_KSM) and RID-KU-WL008 (Weir_TKD) from the telemetry files, Q (m3/s) every 15 minutes · RID-KU-WL006 (Weir_NPK) is closed and uses RID-KU-WL008 × 0.8.</p><p><b>Flow gap filling</b>Gaps of up to 6 hours with data on both sides are interpolated linearly; longer gaps and the time after the latest reading take the simulated flow. “Export flow CSV” on an element adds the filled flow and the method used.</p><p><b>Updating data</b>The page reads the iwasam.com/ksm API itself (rain: api/weather/station, flow: api/water/station; -999 is missing): at first only the time after the DSS/CSV data, then only the latest day on each update. Otherwise, download CSV files from the telemetry system and drop them on this page (this computer only), or for everyone: run <code>node tools/update_live.js file.csv …</code> and commit web/data/ksm/live.</p>',
      liveTitle: 'Rainfall and flow · auto-update',
      liveHint: (a, b) => `Last run ${a} · next update ${b}`,
      liveHintOff: (a) => `Last run ${a} · auto-update off`,
      window: (a, b, d) => `Run window ${a} to ${b} (now) · ${d} days`,
      updateNow: '⟳ Update now', importTele: '⭱ Import telemetry files', importTip: 'CSV exports from the telemetry system, e.g. weather-data-RID-KU030_….csv or RID-KU-WL001-….csv. Used on this page only (not uploaded).',
      auto: 'Auto-update',
      fetching: 'Fetching rainfall and flow…', loadingCfg: 'Loading iWASAM…',
      thGage: 'Model gage', thStation: 'Data from', thKind: 'Type', thLast: 'Latest real data', thReal: 'Real data', thFilled: 'Filled', thStrip: 'Data coverage in the run window',
      rain: 'Rain', flow: 'Flow',
      lgReal: 'Real data', lgIdw: 'Filled from nearby gages (IDW)', lgZero: 'No data, rain taken as 0', lgInterp: 'Short gap, linear', lgSim: 'Simulated flow used',
      filledRain: (idw, zero) => `IDW ${idw} · zero ${zero}`, filledFlow: (ip, sim) => `linear ${ip} · simulated ${sim}`,
      derived: (g, k) => `= ${g} × ${k}`,
      srcNames: { 1: 'DSS', 2: 'CSV', 3: 'API', 4: 'imported' },
      noFile: (f) => `File ${f} not found`, readErr: (f, e) => `Cannot read ${f}: ${e}`, apiErr: (s, e) => `API ${s}: ${e}`,
      dropped: (ok, bad) => `Imported ${ok}${bad ? ` · unknown station for ${bad}` : ''}`,
      dropNone: 'No file matches a model gage (the file name must hold the station code, e.g. RID-KU030 or RID-KU-WL001)',
      notes: 'Notes', obsFilled: (g) => `Filled flow (${g})`, bandFill: 'Filled period', bandNone: 'No rainfall data',
      colFilled: (g, u) => `${g} filled (${u})`, colHow: 'fill method',
      steps: (n) => n.toLocaleString('en-US'),
      cfgErr: (e) => `Could not read iwasam.json (${e}); using defaults`,
      nowNote: (t) => `After ${t} no station has real data yet, so rain there is 0 and observed flow takes the simulated flow`,
    },
  };
  const DEFAULTS = {
    project: 'ksm', run: 'Run sep2026', start: 'control', refreshMinutes: 15, rainStep: 5, priority: ['drop', 'dss', 'csv', 'api'],
    fill: { idwPower: 2, flowInterpHours: 6, rainMaxPerHour: 150, resetHour: 7, rainShiftMinutes: 0 }, gages: {}, api: { enabled: false },
  };

  let A, CFG, BASE = null, DROP = {}, APIC = {}, LAST = null, FILL = {}, MEMO = {}, timer = null, busy = false, lastRun = 0, auto = true;
  const s = (k, ...a) => { const v = (STR[A.LANG] || STR.th)[k]; return typeof v === 'function' ? v(...a) : v; };

  async function start(app) {
    A = app;
    const $ = A.$;
    // rain chips read "telemetry" instead of "CSV" for the merged records
    A.I18N.th.rainSrcCsv = 'DSS + โทรมาตร + เติมข้อมูล'; A.I18N.en.rainSrcCsv = 'DSS + telemetry + filled';
    Object.assign(A.HOOK, { series: hookSeries, bands: hookBands, legend: hookLegend, afterRun: hookAfterRun, reset: () => update(), lang: renderLive, drop: importFiles, flowCols: hookFlowCols });
    $('live-update').addEventListener('click', () => update());
    $('live-import').addEventListener('click', () => $('live-file').click());
    $('live-file').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
    $('live-auto').addEventListener('click', () => { auto = !auto; schedule(); renderLive(); });
    applyText();
    $('runlog').textContent = s('loadingCfg');
    CFG = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const r = await fetch('data/iwasam.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const c = await r.json();
      CFG = { ...CFG, ...c, fill: { ...CFG.fill, ...(c.fill || {}) }, api: { ...CFG.api, ...(c.api || {}) } };
    } catch (e) { CFG.cfgError = s('cfgErr', e.message); }
    if (!await A.loadSampleList()) return;
    if (!await A.loadSample(CFG.project, false)) return;
    if (CFG.run && A.P.runs.some(r => r.name === CFG.run)) A.pickRun(CFG.run);
    BASE = buildBase();
    await update();
    schedule();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && auto && Date.now() - lastRun > CFG.refreshMinutes * MIN) update(); });
    setInterval(renderHint, 30000);
  }
  function schedule() {
    clearInterval(timer); timer = null;
    if (auto) timer = setInterval(() => { if (!document.hidden) update(); }, Math.max(1, CFG.refreshMinutes) * MIN);
  }

  // what does not change between updates: gage records from DSS, gage coordinates, the control window
  function buildBase() {
    const P = A.P, H = A.H, lc = (x) => (x || '').toLowerCase(), base = (p) => p.split(/[\\/]/).pop();
    const gages = {};
    for (const n of Object.keys(P.texts).filter(n => /\.gage$/i.test(n))) {
      for (const b of H.parseHms(P.texts[n])) {
        if (b.kind !== 'Gage') continue;
        const p = b.props, kind = /^flow$/i.test(p['Gage Type'] || '') ? 'flow' : /^precip/i.test(p['Gage Type'] || '') ? 'rain' : null;
        if (!kind) continue;
        const dss = p['Filename'] && P.dss[lc(base(p['Filename']))];
        let rec = null;
        try { rec = dss && !dss.error && p['Pathname'] ? H.dssSeries(dss, p['Pathname'], NaN) : null; } catch (_) {}
        const lat = parseFloat(p['Latitude Degrees']), lon = parseFloat(p['Longitude Degrees']);
        gages[b.name] = { name: b.name, kind, rec, coord: isFinite(lat) && isFinite(lon) ? [lat, lon] : null };
      }
    }
    for (const [name, c] of Object.entries(CFG.gages || {})) { if (!gages[name]) gages[name] = { name, kind: c.kind, rec: null, coord: null }; if (c.coord) gages[name].coord = c.coord; }
    const ctl = H.readControl(A.P.texts[A.S.controlFile]);
    const tz = parseFloat(H.parseHms(A.P.texts[A.S.controlFile])[0].props['Time Zone GMT Offset']);
    return { gages, ctl, tzMs: isFinite(tz) ? tz : 7 * HOUR };
  }

  async function fetchText(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) { const e = new Error(r.status === 404 ? 'not found' : 'HTTP ' + r.status); e.status = r.status; throw e; }
    return r.text();
  }
  const fmtIso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const fmtIsoT = (ms) => new Date(ms).toISOString().slice(0, 16);
  async function update() {
    if (busy || !BASE) return;
    busy = true;
    const $ = A.$, H = A.H;
    $('runlog').textContent = s('fetching');
    const notes = [];
    try {
      const dt = BASE.ctl.dtMin * MIN;
      const start = CFG.start === 'control' || !CFG.start ? BASE.ctl.start : /^-\d+d$/.test(CFG.start) ? Math.floor((Date.now() + BASE.tzMs + parseInt(CFG.start) * DAY) / DAY) * DAY : parseTime(CFG.start);
      const end = Math.max(start + dt, Math.floor((Date.now() + BASE.tzMs) / dt) * dt);
      const rg = { start, step: (CFG.rainStep || 5) * MIN }; rg.n = Math.round((end - start) / rg.step);
      const fg = { start: start - dt, step: dt, n: Math.round((end - start) / dt) + 1 };
      // read every source of every configured gage
      const reads = {}; // gage -> [{code, series, label}]
      await Promise.all(Object.entries(CFG.gages || {}).map(async ([name, c]) => {
        const list = reads[name] = [];
        const kind = c.kind || (BASE.gages[name] || {}).kind;
        for (const f of c.csv || []) {
          try { const sr = readSeries(await fetchText(`data/${CFG.project}/${f}`), kind, { ...c, tzMs: BASE.tzMs }); list.push({ code: SRC.CSV, series: sr, label: f }); }
          catch (e) { notes.push(e.status === 404 ? s('noFile', f) : s('readErr', f, e.message)); }
        }
        const api = CFG.api && CFG.api.enabled && CFG.api[kind];
        if (api && api.url && c.station) {
          // ask only for what is not at hand: from the day before the last API reading kept from an earlier
          // update, or before the last reading of the DSS / CSV sources (the API comes after them)
          const cache = APIC[name];
          let from = start;
          if (cache) from = Math.max(from, cache.points[cache.points.length - 1][0]);
          else { const lasts = list.map(r => r.series.last).concat(recLast(BASE.gages[name])).filter(isFinite); if (lasts.length) from = Math.max(from, ...lasts); }
          from = Math.floor((from - DAY) / DAY) * DAY; // whole days, so cumulative rain has its 07:00 reading
          const url = api.url.replace(/\{station\}/g, encodeURIComponent(c.apiStation || c.station)).replace(/\{from\}/g, fmtIso(from)).replace(/\{to\}/g, fmtIso(end + DAY))
            .replace(/\{fromT\}/g, fmtIsoT(from)).replace(/\{toT\}/g, fmtIsoT(end));
          try {
            let sr = readSeries(await fetchText(url), kind, { ...c, ...api, tzMs: BASE.tzMs });
            if (cache) sr = joinSeries(cache, sr);
            APIC[name] = sr;
            list.push({ code: SRC.API, series: sr, label: 'API' });
          } catch (e) {
            notes.push(s('apiErr', c.station, e.message));
            if (cache) list.push({ code: SRC.API, series: cache, label: 'API' });
          }
        }
        if (DROP[name]) list.push({ code: SRC.DROP, series: DROP[name].series, label: DROP[name].file });
      }));
      // rain: merge by priority, then fill
      const order = CFG.priority || DEFAULTS.priority, codeOf = { dss: SRC.DSS, csv: SRC.CSV, api: SRC.API, drop: SRC.DROP };
      const rank = (c) => { const i = order.findIndex(k => codeOf[k] === c); return i < 0 ? 99 : i; };
      const rainNames = Object.values(BASE.gages).filter(g => g.kind === 'rain').map(g => g.name);
      const merged = {};
      for (const kind of ['rain', 'flow']) {
        const grid = kind === 'rain' ? rg : fg;
        for (const g of Object.values(BASE.gages).filter(g => g.kind === kind)) {
          const layers = [];
          if (g.rec) layers.push({ code: SRC.DSS, values: recordToGrid(g.rec, grid, kind) });
          for (const r of reads[g.name] || []) layers.push({ code: r.code, values: kind === 'rain' ? rainToGrid(r.series, grid, { maxPerHour: CFG.fill.rainMaxPerHour, resetHour: CFG.fill.resetHour, shiftMinutes: CFG.fill.rainShiftMinutes }) : flowToGrid(r.series, grid) });
          layers.sort((a, b) => rank(a.code) - rank(b.code));
          merged[g.name] = { ...mergeLayers(layers, grid.n), kind, reads: reads[g.name] || [] };
        }
      }
      const filled = fillRain(rainNames.map(n => ({ name: n, values: merged[n].values, src: merged[n].src, coord: BASE.gages[n].coord })), CFG.fill.idwPower);
      const P = A.P;
      P.rain = {}; P.flow = {};
      for (const f of filled) { P.rain[f.name] = { start: rg.start, interval: rg.step / MIN, values: Array.from(f.values), units: 'MM' }; merged[f.name].src = f.src; }
      for (const [name, m] of Object.entries(merged)) if (m.kind === 'flow') P.flow[name] = { start: fg.start, interval: fg.step / MIN, values: Array.from(m.values), units: 'M3/S' };
      // the last time any station has real data
      let lastAny = -Infinity;
      for (const m of Object.values(merged)) for (let i = m.src.length - 1; i >= 0; i--) if (isReal(m.src[i])) { lastAny = Math.max(lastAny, gridTime(m.kind === 'rain' ? rg : fg, i)); break; }
      if (lastAny < end - 6 * HOUR) notes.unshift(s('nowNote', isFinite(lastAny) ? H.fmtDateTime(lastAny) : H.fmtDateTime(start)));
      if (CFG.cfgError) notes.push(CFG.cfgError);
      LAST = { rg, fg, start, end, merged, notes, ranAt: Date.now() };
      A.setWindow(start, end, BASE.ctl.dtMin);
      A.runModel();
      lastRun = Date.now();
    } catch (e) {
      console.error(e);
      A.showError(e.message);
    } finally { busy = false; }
    renderLive();
  }

  // ---------- after a run: fill observed flow per element ----------
  function hookAfterRun() {
    FILL = {};
    const OUT = A.OUT; if (!OUT) return;
    const maxSteps = Math.round(CFG.fill.flowInterpHours * 60 / OUT.control.dtMin);
    for (const [name, r] of Object.entries(OUT.results)) {
      const ob = r.observed;
      if (!ob || !ob.values) continue;
      const f = fillFlow(ob.values, r.outflow, maxSteps);
      if (f.how.some(h => h)) FILL[name] = { ...f, gage: ob.gage };
    }
    MEMO = {};
  }
  function hookSeries(series, ctx) {
    const f = FILL[ctx.name]; if (!f) return;
    const n = f.values.length, data = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (f.how[i] || (i > 0 && f.how[i - 1]) || (i + 1 < n && f.how[i + 1])) data[i] = f.values[i]; // join the observed ends
    series.push({ key: 'fill', label: s('obsFilled', f.gage), color: 'var(--fill)', data, dash: true, thin: true });
  }
  function hookFlowCols(name) {
    const f = FILL[name]; if (!f || !A.OUT) return [];
    const word = { 0: 'observed', [SRC.INTERP]: 'linear', [SRC.SIM]: 'simulated' };
    return [{ head: s('colFilled', f.gage, A.OUT.u.metric ? 'm3/s' : 'cfs'), values: f.values }, { head: s('colHow'), values: Array.from(f.how, h => word[h]) }];
  }
  // shaded spans: filled observed flow for a gauged element, else filled rain of the gages it depends on
  function rainGagesFor(name) {
    const OUT = A.OUT, out = new Set();
    const walk = (n, seen = new Set()) => {
      if (seen.has(n)) return; seen.add(n);
      const sb = OUT.met && OUT.met.subbasins && OUT.met.subbasins[n];
      if (sb) for (const g of [sb.gage, ...(sb.weights || []).map(w => w.gage), ...Object.keys(sb.depth || {}), ...Object.keys(sb.time || {})]) if (g) out.add(g);
      for (const u of (OUT.results[n] && OUT.results[n].upstream) || []) walk(u, seen);
    };
    walk(name);
    return [...out];
  }
  function hookBands(name) {
    if (!LAST || !A.OUT || !name) return [];
    if (MEMO[name]) return MEMO[name];
    let out = [];
    const f = FILL[name], T = A.OUT.times, dt = A.OUT.control.dtMin * MIN;
    if (f) out = spans(f.how, (i) => T[i], dt).map(([a, b]) => [a, b, 'var(--band)']);
    else {
      const { rg, merged } = LAST, gs = rainGagesFor(name).filter(g => merged[g]);
      if (gs.length) {
        const fill = new Uint8Array(rg.n), none = new Uint8Array(rg.n);
        for (const g of gs) { const src = merged[g].src; for (let i = 0; i < rg.n; i++) { if (src[i] === SRC.ZERO) none[i] = 1; else if (src[i] === SRC.IDW) fill[i] = 1; } }
        for (let i = 0; i < rg.n; i++) if (none[i]) fill[i] = 0;
        const at = (i) => gridTime(rg, i);
        out = [...spans(fill, at, rg.step).map(([a, b]) => [a, b, 'var(--band)']), ...spans(none, at, rg.step).map(([a, b]) => [a, b, 'var(--band-none)'])];
      }
    }
    return (MEMO[name] = out);
  }
  function hookLegend(name) {
    const b = hookBands(name); if (!b.length) return '';
    const has = (c) => b.some(x => x[2] === c);
    return (has('var(--band)') ? `<span><span class="swatch" style="background:var(--band);border:1px solid var(--fill)"></span>${A.esc(s('bandFill'))}</span>` : '')
      + (has('var(--band-none)') ? `<span><span class="swatch" style="background:var(--band-none);border:1px solid var(--bad)"></span>${A.esc(s('bandNone'))}</span>` : '');
  }

  // ---------- telemetry files dropped or picked on the page ----------
  async function importFiles(files) {
    const ok = [], bad = [];
    for (const file of files) {
      if (!/\.(csv|txt|json)$/i.test(file.name)) { bad.push(file.name); continue; }
      const key = normCode(file.name);
      // the longest station code found in the file name wins (RID-KU-WL001 before RID-KU 001)
      const hit = Object.entries(CFG.gages || {}).map(([name, c]) => ({ name, c, code: normCode(c.station || name) })).filter(x => x.code && key.includes(x.code)).sort((a, b) => b.code.length - a.code.length)[0];
      if (!hit) { bad.push(file.name); continue; }
      try {
        const kind = hit.c.kind || (BASE.gages[hit.name] || {}).kind;
        DROP[hit.name] = { file: file.name, series: readSeries(await file.text(), kind, { ...hit.c, tzMs: BASE.tzMs }) };
        ok.push(`${file.name} → ${hit.name}`);
      } catch (e) { bad.push(`${file.name} (${e.message})`); }
    }
    if (!ok.length) { A.showError(s('dropNone') + (bad.length ? ` · ${bad.join(', ')}` : '')); return; }
    A.showError(null);
    await update();
    A.$('runlog').innerHTML += ` · ${A.esc(s('dropped', ok.join(', '), bad.join(', ')))}`;
  }

  // ---------- live panel ----------
  const fmtClock = (ms) => new Date(ms + (BASE ? BASE.tzMs : 7 * HOUR)).toISOString().slice(11, 16);
  function renderHint() {
    const $ = A.$; if (!LAST) { $('live-hint').textContent = ''; return; }
    $('live-hint').textContent = auto ? s('liveHint', fmtClock(LAST.ranAt), fmtClock(LAST.ranAt + CFG.refreshMinutes * MIN)) : s('liveHintOff', fmtClock(LAST.ranAt));
  }
  function strip(codes, kind) {
    // run-length segments, coloured by real / IDW / zero / linear / simulated
    const n = codes.length; if (!n) return '';
    const col = (c) => isReal(c) ? 'var(--accent)' : c === SRC.IDW || c === SRC.INTERP ? 'var(--fill)' : c === SRC.SIM ? 'var(--s-out)' : 'var(--bad)';
    let h = '', i = 0;
    while (i < n) { let j = i; const c = col(codes[i]); while (j < n && col(codes[j]) === c) j++; h += `<rect x="${(i / n * 1000).toFixed(2)}" y="0" width="${Math.max(0.6, (j - i) / n * 1000).toFixed(2)}" height="12" fill="${c}"/>`; i = j; }
    return `<svg class="strip" viewBox="0 0 1000 12" preserveAspectRatio="none" role="img" aria-label="${A.esc(kind)}">${h}</svg>`;
  }
  function applyText() {
    document.querySelectorAll('[data-live]').forEach(el => { el.textContent = s(el.dataset.live); });
    document.querySelectorAll('[data-live-html]').forEach(el => { el.innerHTML = s(el.dataset.liveHtml); });
    document.querySelectorAll('[data-live-title]').forEach(el => { el.title = s(el.dataset.liveTitle); });
  }
  function renderLive() {
    const $ = A.$, esc = A.esc, H = A.H;
    applyText();
    renderHint();
    $('live-auto').setAttribute('aria-checked', auto);
    if (!LAST) { $('live-body').innerHTML = ''; return; }
    const { rg, fg, start, end, merged, notes } = LAST;
    $('live-window').textContent = s('window', H.fmtDateTime(start), H.fmtDateTime(end), ((end - start) / DAY).toFixed(1));
    const pct = (k, n) => n ? `${(k / n * 100).toFixed(k === n || k === 0 ? 0 : 1)}%` : '—';
    const derive = A.P.derive || {};
    const flowEl = {}; if (A.OUT) for (const e of A.OUT.basin.elements) if (e.observed) flowEl[e.observed] = e.name;
    let rows = '';
    for (const g of Object.values(BASE.gages).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'rain' ? -1 : 1) || a.name.localeCompare(b.name))) {
      const d = derive[g.name], dv = d && d.from && d.from !== g.name;
      const m = merged[dv ? d.from : g.name]; if (!m) continue;
      const c = CFG.gages[g.name] || {}, kind = s(g.kind);
      let codes = m.src, last = NaN;
      for (let i = codes.length - 1; i >= 0; i--) if (isReal(codes[i])) { last = gridTime(g.kind === 'rain' ? rg : fg, i); break; }
      const by = {}; for (const x of codes) by[x] = (by[x] || 0) + 1;
      const real = codes.reduce((a, x) => a + (isReal(x) ? 1 : 0), 0);
      let filled = '';
      if (g.kind === 'rain') filled = s('filledRain', s('steps', by[SRC.IDW] || 0), s('steps', by[SRC.ZERO] || 0));
      else {
        const el = flowEl[g.name], f = el && FILL[el];
        if (f) { codes = Uint8Array.from(f.how, (h, i) => h || (isNaN(f.values[i]) ? SRC.NONE : SRC.DSS)); const k = {}; for (const h of f.how) k[h] = (k[h] || 0) + 1; filled = s('filledFlow', s('steps', k[SRC.INTERP] || 0), s('steps', k[SRC.SIM] || 0)); }
        else filled = '—';
      }
      const from = dv ? s('derived', d.from, d.factor) : [c.station ? `${c.station}${c.label ? ' ' + c.label : ''}` : '', ...new Set([g.rec ? 'DSS' : null, ...m.reads.map(r => s('srcNames')[r.code])].filter(Boolean))].filter(Boolean).join(' · ');
      const lastReads = m.reads.map(r => `${s('srcNames')[r.code]} ${isFinite(r.series.last) ? H.fmtDateTime(r.series.last) : '—'}`).join(' · ');
      rows += `<tr><td class="mono">${esc(g.name)}</td><td>${esc(from)}</td><td>${esc(kind)}</td><td class="mono" title="${esc(lastReads)}">${isFinite(last) ? esc(H.fmtDateTime(last)) : '—'}</td><td class="num">${pct(real, codes.length)}</td><td class="mono">${esc(filled)}</td><td class="strip-cell">${strip(codes, kind)}</td></tr>`;
    }
    const lg = (c, k) => `<span><span class="swatch" style="background:${c}"></span>${esc(s(k))}</span>`;
    $('live-body').innerHTML = `<div class="tbl-wrap"><table class="live-tbl"><thead><tr><th>${s('thGage')}</th><th>${s('thStation')}</th><th>${s('thKind')}</th><th>${s('thLast')}</th><th>${s('thReal')}</th><th>${s('thFilled')}</th><th>${s('thStrip')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      + `<div class="legend">${lg('var(--accent)', 'lgReal')}${lg('var(--fill)', 'lgIdw')}${lg('var(--bad)', 'lgZero')}${lg('var(--fill)', 'lgInterp')}${lg('var(--s-out)', 'lgSim')}</div>`
      + (notes.length ? `<ul class="live-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '');
  }

  root.IWASAM = { start, core };
})(this);
