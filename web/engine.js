// Mini HEC-HMS engine: reads HEC-HMS 4.x project files (text + DSS 7) and runs
// an event simulation in the browser or Node.
// Loss: None, Initial+Constant, SCS Curve Number. Transform: None, User-Specified UH,
// Clark, SCS. Baseflow: None, Recession. Routing: None, Lag, Muskingum.
// Precip: Specified Average (one gage per subbasin), Gage Weights.
(function (root) {
  'use strict';

  // ---------- HMS text-file parser ----------
  // Blocks look like "Kind: Name\n     Key: Value\n ... End:". Nested sub-blocks
  // (Variant:, Element Layer:) are flattened into the parent's props.
  function parseHms(text) {
    const blocks = [];
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line === 'End:') { if (cur) blocks.push(cur); cur = null; continue; }
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim(), val = line.slice(i + 1).trim();
      if (!cur) cur = { kind: key, name: val, props: {}, order: [] };
      else if (!(key in cur.props)) { cur.props[key] = val; cur.order.push(key); }
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  function writeHms(blocks) {
    return blocks.map(b => {
      const lines = [`${b.kind}: ${b.name}`];
      for (const k of b.order) lines.push(`     ${k}: ${b.props[k]}`);
      lines.push('End:');
      return lines.join('\n');
    }).join('\n\n') + '\n';
  }

  // ---------- time helpers (all times are naive local time stored as UTC ms) ----------
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON3 = MONTHS.map(m => m.slice(0, 3).toUpperCase());
  function monthIndex(s) { return MON3.indexOf(s.slice(0, 3).toUpperCase()); }
  // "1 September 2026" + "07:00", or "01Sep2026" + "07:00"
  function parseDateTime(d, t) {
    let day, mon, yr;
    const m = /^(\d{1,2})\s*([A-Za-z]+)\s*(\d{4})$/.exec(d.trim().replace(/,$/, ''));
    if (!m) throw new Error('อ่านวันที่ไม่ได้: ' + d);
    day = +m[1]; mon = monthIndex(m[2]); yr = +m[3];
    const [hh, mm] = (t || '00:00').split(':').map(Number);
    return Date.UTC(yr, mon, day, hh, mm || 0);
  }
  const p2 = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) { const d = new Date(ms); return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); }
  function fmtDate(ms) { const d = new Date(ms); return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(); }
  function fmtDateTime(ms) { return fmtDate(ms) + ' ' + fmtTime(ms); }
  function hmsDate(ms) { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
  // DSS E part / HMS interval text -> minutes
  function intervalMinutes(s) {
    const m = /^(\d+)\s*(MIN|MINUTE|MINUTES|HOUR|HOURS|DAY|DAYS|WEEK|MON|MONTH)/i.exec(String(s).trim());
    if (!m) return null;
    const u = m[2].toUpperCase();
    return +m[1] * (u.startsWith('MIN') ? 1 : u.startsWith('HOUR') ? 60 : u.startsWith('DAY') ? 1440 : u.startsWith('WEEK') ? 10080 : 43200);
  }

  // ---------- DSS 7 reader ----------
  // Scans for record info blocks (flag -97534), keeps live records (status 1)
  // and decodes regular time series / patterns stored as float or double,
  // including DSS 7 repeat compression (bit set = repeat previous value).
  const DSS_INFO_FLAG = -97534, DSS_MISSING = -3.402823466e38;
  function readDss(buf) {
    const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const bytes = new Uint8Array(dv.buffer);
    if (String.fromCharCode(...bytes.slice(0, 4)) !== 'ZDSS') throw new Error('ไม่ใช่ไฟล์ DSS');
    if (bytes[16] !== 0x37) throw new Error('รองรับเฉพาะ DSS เวอร์ชัน 7 (HEC-HMS 4.x)');
    const nw = Math.floor(dv.byteLength / 8);
    const W = (i) => dv.getInt32(i * 8, true) + dv.getInt32(i * 8 + 4, true) * 4294967296;
    const records = [];
    for (let s = 0; s < nw - 31; s++) {
      if (dv.getInt32(s * 8, true) !== DSS_INFO_FLAG || dv.getInt32(s * 8 + 4, true) !== -1) continue;
      if (W(s + 1) !== 1) continue; // live record only
      const plen = W(s + 2);
      if (plen < 7 || plen > 400) continue;
      let path = '';
      for (let k = 0; k < plen; k++) path += String.fromCharCode(bytes[(s + 30) * 8 + k]);
      if (path[0] !== '/') continue;
      const type = dv.getInt32((s + 4) * 8, true);
      const rec = { path, type, writeTime: W(s + 6) };
      try { if (type >= 100 && type < 110) decodeRts(rec, s); } catch (e) { rec.error = e.message; }
      records.push(rec);
    }
    function decodeRts(rec, s) {
      const ia = W(s + 13), ni = W(s + 14), h2 = W(s + 15), nh2 = W(s + 16);
      const va = W(s + 19), nvals = W(s + 26);
      const I = (k) => k < ni ? dv.getInt32(ia * 8 + k * 4, true) : 0;
      const dbl = rec.type === 105 || rec.type === 106;
      rec.pattern = rec.type === 101 || rec.type === 106;
      rec.firstIndex = I(4);
      rec.n = nvals;
      // units + data type strings live after the numeric part of the internal header
      const txt = String.fromCharCode(...bytes.slice(ia * 8, ia * 8 + ni * 4)).replace(/\0/g, ' ');
      const words = txt.replace(/[^\x20-\x7e]/g, ' ').trim().split(/\s+/).filter(w => /^[A-Za-z][\w\/\-]*$/.test(w));
      rec.units = words[0] || ''; rec.dataType = words[1] || '';
      const vals = new Float64Array(nvals);
      let k = 0, prev = 0;
      const rd = (j) => dbl ? dv.getFloat64(va * 8 + j * 8, true) : dv.getFloat32(va * 8 + j * 4, true);
      for (let i = 0; i < nvals; i++) {
        const rep = nh2 > 0 ? (dv.getUint32(h2 * 8 + (i >> 5) * 4, true) >>> (i & 31)) & 1 : 0;
        if (!rep) { prev = rd(k); k++; }
        vals[i] = prev;
      }
      for (let i = 0; i < nvals; i++) if (vals[i] < -3e38 || vals[i] === -901 || vals[i] === -902) vals[i] = NaN;
      rec.values = vals;
    }
    return { records };
  }

  function pathParts(p) { const a = p.split('/'); return { A: a[1] || '', B: a[2] || '', C: a[3] || '', D: a[4] || '', E: a[5] || '', F: a[6] || '' }; }
  const upEq = (a, b) => a.trim().toUpperCase() === b.trim().toUpperCase();

  // Merge every live block of a regular time series (D part ignored) into {start, interval, values}
  // where values[i] is the value for the period ending at start + (i+1)*interval.
  function dssSeries(dss, pathname) {
    const want = pathParts(pathname), dtw = intervalMinutes(want.E);
    const recs = dss.records.filter(r => {
      const p = pathParts(r.path);
      return r.values && upEq(p.A, want.A) && upEq(p.B, want.B) && upEq(p.C, want.C) && upEq(p.F, want.F) && intervalMinutes(p.E) === dtw;
    });
    if (!recs.length) return null;
    if (recs[0].pattern) return { pattern: true, interval: dtw, values: Array.from(recs[0].values, v => isNaN(v) ? 0 : v), units: recs[0].units };
    const pts = new Map();
    for (const r of recs) {
      const D = pathParts(r.path).D;
      const m = /^(\d{2})([A-Za-z]{3})(\d{4})$/.exec(D);
      if (!m) continue;
      const blockStart = Date.UTC(+m[3], monthIndex(m[2]), +m[1]);
      for (let i = 0; i < r.n; i++) {
        const v = r.values[i];
        if (isNaN(v)) continue;
        pts.set(blockStart + (r.firstIndex + i + 1) * dtw * 60000, v);
      }
    }
    const times = [...pts.keys()].sort((a, b) => a - b);
    if (!times.length) return null;
    const step = dtw * 60000, start = times[0] - step;
    const n = Math.round((times[times.length - 1] - start) / step);
    const values = new Float64Array(n);
    for (const [t, v] of pts) values[Math.round((t - start) / step) - 1] = v;
    return { start, interval: dtw, values, units: recs[0].units };
  }

  // ---------- precipitation ----------
  function cumFraction(g, ms) { // cumulative depth at time ms (linear within each period)
    const step = g.interval * 60000, n = g.values.length;
    const x = (ms - g.start) / step;
    if (x <= 0) return 0;
    if (x >= n) return g.cumulative[n];
    const i = Math.floor(x), f = x - i;
    return g.cumulative[i] + f * (g.cumulative[i + 1] - g.cumulative[i]);
  }
  function prepGage(g) {
    if (!g.cumulative) { g.cumulative = [0]; for (const v of g.values) g.cumulative.push(g.cumulative[g.cumulative.length - 1] + (v > 0 ? v : 0)); }
    return g;
  }
  function subbasinHyetograph(met, gages, sub, times) {
    const sb = met.subbasins[sub];
    if (!sb) throw new Error('ไม่พบข้อมูลฝนของ ' + sub + ' ในไฟล์ .met');
    const need = (g) => { if (!gages[g]) throw new Error(`ไม่พบข้อมูลสถานีฝน "${g}"`); return prepGage(gages[g]); };
    const p = new Float64Array(times.length);
    if (met.method === 'Specified Average') {
      const g = need(sb.gage);
      for (let i = 1; i < times.length; i++) p[i] = cumFraction(g, times[i]) - cumFraction(g, times[i - 1]);
      return p;
    }
    if (met.method === 'Gage Weights') {
      let total = 0;
      for (const [g, w] of Object.entries(sb.depth)) total += w * need(g).total;
      const cumAt = (ms) => { let c = 0; for (const [g, w] of Object.entries(sb.time)) { const G = need(g); c += w * cumFraction(G, ms) / G.cumulative[G.values.length]; } return c; };
      for (let i = 1; i < times.length; i++) p[i] = total * (cumAt(times[i]) - cumAt(times[i - 1]));
      return p;
    }
    throw new Error('ยังไม่รองรับวิธีฝน: ' + met.method);
  }

  // ---------- loss ----------
  function lossMethod(p, prm, dtH, u) {
    const n = p.length, excess = new Float64Array(n), loss = new Float64Array(n);
    const imp = (prm.impervious || 0) / 100;
    if (prm.method === 'None' || !prm.method) { excess.set(p); return { excess, loss }; }
    if (prm.method === 'Initial+Constant' || prm.method === 'Initial Constant') {
      const rate = prm.constantRate * dtH;
      let il = prm.initialLoss;
      for (let i = 0; i < n; i++) {
        let pv = p[i], l = 0;
        if (il > 0) { const a = Math.min(pv, il); il -= a; l += a; pv -= a; }
        const c = Math.min(pv, rate); l += c; pv -= c;
        loss[i] = (1 - imp) * l;
        excess[i] = imp * p[i] + (1 - imp) * pv;
      }
      return { excess, loss };
    }
    if (prm.method === 'SCS') {
      const S = u.metric ? 25400 / prm.cn - 254 : 1000 / prm.cn - 10;
      const Ia = isNaN(prm.ia) ? 0.2 * S : prm.ia;
      let P = 0, peOld = 0;
      for (let i = 0; i < n; i++) {
        P += p[i];
        const pe = P > Ia ? (P - Ia) * (P - Ia) / (P - Ia + S) : 0;
        const e = pe - peOld; peOld = pe;
        excess[i] = imp * p[i] + (1 - imp) * e;
        loss[i] = (1 - imp) * (p[i] - e);
      }
      return { excess, loss };
    }
    throw new Error('ยังไม่รองรับ LossRate: ' + prm.method);
  }

  // ---------- transform ----------
  // Unit hydrograph at the simulation step from a UH of duration D (S-curve method).
  // uh[j] is the flow j steps after the end of a unit-depth excess period.
  function resampleUH(U, D, dtMin) {
    if (Math.abs(D - dtMin) < 1e-9) return [0, ...U.slice(1)].concat([0]);
    const Ui = (x) => { if (x < 0) return 0; const k = Math.floor(x), f = x - k; const a = U[k] || 0, b = U[k + 1] || 0; return a + (b - a) * f; };
    const S = (t) => { let s = 0; for (let i = 0; i * D <= t; i++) s += Ui((t - i * D) / D); return s; };
    const n = Math.ceil((U.length + 1) * D / dtMin) + 1, u = [];
    for (let j = 0; j <= n; j++) u.push((D / dtMin) * (S(j * dtMin) - S((j - 1) * dtMin)));
    return u;
  }
  function convolve(excess, uh) {
    const n = excess.length, q = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const e = excess[i]; if (!e) continue;
      for (let j = 1; j < uh.length && i + j - 1 < n; j++) q[i + j - 1] += e * uh[j];
    }
    return q;
  }
  const SCS_DIM = [[0, 0], [.1, .03], [.2, .1], [.3, .19], [.4, .31], [.5, .47], [.6, .66], [.7, .82], [.8, .93], [.9, .99], [1, 1], [1.1, .99], [1.2, .93], [1.3, .86], [1.4, .78], [1.5, .68], [1.6, .56], [1.7, .46], [1.8, .39], [1.9, .33], [2, .28], [2.2, .207], [2.4, .147], [2.6, .107], [2.8, .077], [3, .055], [3.2, .04], [3.4, .029], [3.6, .021], [3.8, .015], [4, .011], [4.5, .005], [5, 0]];
  function transform(excess, area, prm, dtMin, u) {
    const dtH = dtMin / 60;
    if (prm.method === 'None' || !prm.method) return Float64Array.from(excess, e => e * u.depthAreaToFlow(area, dtH));
    if (prm.method === 'User-Specified UH') {
      if (!prm.uh) throw new Error('ไม่พบ Unit Hydrograph "' + prm.uhName + '" (ต้องมีไฟล์ .pdata และ .dss)');
      return convolve(excess, resampleUH(prm.uh.values, prm.uh.interval, dtMin));
    }
    if (prm.method === 'SCS') {
      const tp = dtH / 2 + prm.lag / 60;
      const shape = (r) => { if (r >= 5) return 0; let k = 1; while (SCS_DIM[k][0] < r) k++; const [x0, y0] = SCS_DIM[k - 1], [x1, y1] = SCS_DIM[k]; return y0 + (y1 - y0) * (r - x0) / (x1 - x0); };
      const raw = [0]; for (let j = 1; j * dtH <= 5 * tp + dtH; j++) raw.push(shape(j * dtH / tp));
      const sum = raw.reduce((a, b) => a + b, 0);
      const unit = u.depthAreaToFlow(area, dtH); // flow from unit depth spread over one step
      return convolve(excess, raw.map(v => v / sum * unit));
    }
    if (prm.method === 'Clark') {
      const tc = prm.tc, R = prm.storage;
      const cumA = (t) => { if (t <= 0) return 0; if (t >= tc) return 1; const r = t / tc; return r <= 0.5 ? 1.414 * Math.pow(r, 1.5) : 1 - 1.414 * Math.pow(1 - r, 1.5); };
      const nOrd = Math.ceil(tc / dtH) + 1, ta = [];
      for (let k = 1; k <= nOrd; k++) ta.push(cumA(k * dtH) - cumA((k - 1) * dtH));
      const conv = u.depthAreaToFlow(area, dtH);
      const n = excess.length, inflow = new Float64Array(n + nOrd);
      for (let i = 0; i < n; i++) if (excess[i] > 0) for (let k = 0; k < nOrd; k++) inflow[i + k] += excess[i] * ta[k] * conv;
      const ca = dtH / (R + 0.5 * dtH), cb = 1 - ca, q = new Float64Array(n);
      let o = 0, prev = 0;
      for (let i = 0; i < n; i++) { o = ca * 0.5 * (prev + inflow[i]) + cb * o; prev = inflow[i]; q[i] = o; }
      return q;
    }
    throw new Error('ยังไม่รองรับ Transform: ' + prm.method);
  }

  // ---------- baseflow ----------
  function baseflow(direct, area, prm, dtH) {
    const n = direct.length;
    if (prm.method !== 'Recession') return { total: Float64Array.from(direct), base: new Float64Array(n) };
    const kStep = Math.pow(prm.recession, dtH / 24), q0 = prm.initialPerArea * area;
    const total = new Float64Array(n), base = new Float64Array(n);
    let peak = 0, receding = false, thr = 0;
    for (let i = 0; i < n; i++) {
      let q = direct[i] + q0 * Math.pow(kStep, i);
      if (!receding) {
        if (q > peak) peak = q;
        else if (peak > q0 * 1.01 && q < prm.thresholdRatio * peak) { receding = true; thr = total[i - 1]; }
      }
      if (receding) { thr *= kStep; q = Math.max(thr, direct[i]); }
      total[i] = q; base[i] = q - direct[i];
    }
    return { total, base };
  }

  // ---------- routing ----------
  function route(inflow, prm, dtMin) {
    const dtH = dtMin / 60;
    if (prm.method === 'Muskingum') {
      const n = Math.max(1, Math.round(prm.steps || 1)), K = prm.K / n, X = prm.X;
      const d = 2 * K * (1 - X) + dtH;
      const c0 = (dtH - 2 * K * X) / d, c1 = (dtH + 2 * K * X) / d, c2 = (2 * K * (1 - X) - dtH) / d;
      let I = inflow;
      for (let s = 0; s < n; s++) { const O = new Float64Array(I.length); O[0] = I[0]; for (let i = 1; i < I.length; i++) O[i] = Math.max(0, c0 * I[i] + c1 * I[i - 1] + c2 * O[i - 1]); I = O; }
      return I;
    }
    if (prm.method === 'Lag') {
      const k = prm.lag / dtMin, out = new Float64Array(inflow.length);
      for (let i = 0; i < out.length; i++) { const x = i - k, j = Math.floor(x), f = x - j; out[i] = x <= 0 ? inflow[0] : (1 - f) * inflow[j] + f * (inflow[j + 1] ?? inflow[j]); }
      return out;
    }
    if (prm.method === 'None' || !prm.method) return Float64Array.from(inflow);
    throw new Error('ยังไม่รองรับ Route: ' + prm.method);
  }

  // ---------- model assembly ----------
  const num = (v) => v === undefined || v === '' ? NaN : parseFloat(v);
  function units(system) {
    const metric = /metric|si/i.test(system || '');
    return metric
      ? { metric, area: 'km²', depth: 'mm', flow: 'm³/s', vol: 'ล้าน m³', volFactor: 1e-6, depthAreaToFlow: (a, dtH) => a * 1e6 / 1000 / (dtH * 3600), rate: 'mm/hr', flowPerArea: 'm³/s/km²' }
      : { metric, area: 'mi²', depth: 'in', flow: 'cfs', vol: 'ac-ft', volFactor: 1 / 43560, depthAreaToFlow: (a, dtH) => a * 5280 * 5280 / 12 / (dtH * 3600), rate: 'in/hr', flowPerArea: 'cfs/mi²' };
  }
  function readBasin(text) {
    const blocks = parseHms(text);
    const elements = [];
    let header = null;
    const other = [];
    for (const b of blocks) {
      const p = b.props;
      if (b.kind === 'Basin') { header = b; continue; }
      if (!['Subbasin', 'Reach', 'Junction', 'Sink', 'Source'].includes(b.kind)) { other.push(b); continue; }
      const el = { kind: b.kind, name: b.name, downstream: p['Downstream'] || null, block: b };
      if (b.kind === 'Subbasin') {
        el.area = num(p['Area']);
        el.loss = { method: p['LossRate'], initialLoss: num(p['Initial Loss']), constantRate: num(p['Constant Loss Rate']), impervious: num(p['Percent Impervious Area'] || 0), cn: num(p['Curve Number']), ia: num(p['Initial Abstraction']) };
        el.transform = { method: p['Transform'], tc: num(p['Time of Concentration']), storage: num(p['Storage Coefficient']), lag: num(p['Lag']), uhName: p['Unit Hydrograph Name'] };
        el.baseflow = { method: p['Baseflow'], recession: num(p['Recession Factor']), initialPerArea: num(p['Initial Flow/Area Ratio']), thresholdRatio: num(p['Threshold Flow To Peak Ratio']) };
      } else if (b.kind === 'Reach') {
        el.route = { method: p['Route'], K: num(p['Muskingum K']), X: num(p['Muskingum x']), steps: num(p['Muskingum Steps'] || 1), lag: num(p['Lag']) };
      }
      if (p['Canvas X']) { el.x = num(p['Canvas X']); el.y = num(p['Canvas Y']); }
      elements.push(el);
    }
    return { header, elements, other, units: units(header && header.props['Unit System']) };
  }

  function readMet(text) {
    const blocks = parseHms(text);
    const head = blocks[0];
    const met = { header: head, method: head.props['Precipitation Method'], subbasins: {} };
    for (const b of blocks.slice(1)) {
      if (b.kind !== 'Subbasin') continue;
      const depth = {}, time = {};
      for (const k of b.order) {
        let m = /^Depth Weight (.+)$/.exec(k); if (m) depth[m[1]] = num(b.props[k]);
        m = /^Time Weight (.+)$/.exec(k); if (m) time[m[1]] = num(b.props[k]);
      }
      met.subbasins[b.name] = { gage: b.props['Gage'], depth, time };
    }
    return met;
  }

  // Gages: DSS-backed (Filename + Pathname) or inline "Data Values".
  // getDss(filename) returns a parsed DSS or null.
  function readGages(text, getDss) {
    const gages = {};
    for (const b of parseHms(text)) {
      if (b.kind !== 'Gage') continue;
      const p = b.props;
      const g = { name: b.name, total: num(p['Total Storm Depth']), source: p['Data Source Type'] || '', file: p['Filename'], pathname: p['Pathname'] };
      if (p['Data Values']) {
        g.values = p['Data Values'].split(/[\s,]+/).filter(Boolean).map(Number);
        g.interval = num(p['Data Interval']);
        g.start = parseDateTime(p['Start Date'], p['Start Time']);
      } else if (g.pathname && getDss) {
        const dss = getDss(g.file);
        if (!dss) g.error = `ต้องใช้ไฟล์ ${g.file}`;
        else {
          const s = dssSeries(dss, g.pathname);
          if (!s) g.error = `ไม่พบ ${g.pathname} ใน ${g.file}`;
          else { g.values = Array.from(s.values); g.interval = s.interval; g.start = s.start; g.units = s.units; }
        }
      }
      if (g.values && isNaN(g.total)) g.total = g.values.reduce((a, v) => a + (v > 0 ? v : 0), 0);
      if (g.values || g.error) gages[b.name] = g;
    }
    return gages;
  }

  function readPairedData(text, getDss) {
    const out = {};
    for (const b of parseHms(text)) {
      if (b.kind !== 'Pattern' && b.kind !== 'Table') continue;
      const p = b.props, rec = { name: b.name, dataType: p['Data Type'], units: p['Units'], duration: num(p['Duration']), file: p['DSS File'], pathname: p['Pathname'] };
      const dss = rec.pathname && getDss ? getDss(rec.file) : null;
      if (dss) {
        const s = dssSeries(dss, rec.pathname);
        if (s) { rec.values = Array.from(s.values); rec.interval = rec.duration || s.interval; }
      }
      if (!rec.values) rec.error = `ต้องใช้ไฟล์ ${rec.file}`;
      out[b.name] = rec;
    }
    return out;
  }

  function readControl(text) {
    const blocks = parseHms(text), b = blocks[0], p = b.props;
    const start = parseDateTime(p['Start Date'], p['Start Time']);
    const end = parseDateTime(p['End Date'], p['End Time']);
    const dt = num(p['Time Interval']);
    if (!(dt > 0)) throw new Error('Time Interval ไม่ถูกต้อง');
    if (end <= start) throw new Error('เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น');
    const n = Math.floor((end - start) / (dt * 60000)) + 1;
    if (n > 200000) throw new Error(`ช่วงเวลามากเกินไป (${n.toLocaleString()} ช่วง) เพิ่ม Time Interval หรือย่นช่วงเวลา`);
    const times = [];
    for (let i = 0; i < n; i++) times.push(start + i * dt * 60000);
    return { name: b.name, block: b, start, end, dtMin: dt, times };
  }
  function setControl(block, start, end, dtMin) {
    const set = (k, v) => { if (!(k in block.props)) block.order.push(k); block.props[k] = v; };
    set('Start Date', hmsDate(start)); set('Start Time', fmtTime(start));
    const e = new Date(end);
    // HMS writes midnight at the end of a run as 24:00 of the previous day
    if (e.getUTCHours() === 0 && e.getUTCMinutes() === 0) { set('End Date', hmsDate(end - 86400000)); set('End Time', '24:00'); }
    else { set('End Date', hmsDate(end)); set('End Time', fmtTime(end)); }
    set('Time Interval', String(dtMin));
  }

  // Project file (.hms) -> names of basin/met/control models and their files
  function readProject(text) {
    const pr = { name: '', basins: {}, mets: {}, controls: {} };
    for (const b of parseHms(text)) {
      const f = b.props['Filename'] || b.props['FileName'];
      if (b.kind === 'Project') { pr.name = b.name; pr.dss = b.props['DSS File Name']; }
      else if (b.kind === 'Basin') pr.basins[b.name] = f;
      else if (b.kind === 'Precipitation' || b.kind === 'Meteorology') pr.mets[b.name] = f;
      else if (b.kind === 'Control') pr.controls[b.name] = f;
    }
    return pr;
  }
  function readRuns(text) {
    return parseHms(text).filter(b => b.kind === 'Run').map(b => ({ name: b.name, basin: b.props['Basin'], met: b.props['Precip'] || b.props['Meteorology'], control: b.props['Control'] }));
  }
  // RUN_x.results (XML) -> { element: {peak, peakTime, volume, precip} }
  function readResults(text) {
    const tag = (t) => (new RegExp(`<${t}>(.*?)</${t}>`).exec(text) || [])[1];
    const when = (s) => { if (!s) return null; const [d, t] = s.split(','); try { return parseDateTime(d, (t || '').trim()); } catch (_) { return null; } };
    const iv = /\/FLOW\/\/([^/]+)\/RUN/.exec(text);
    const out = { run: tag('RunName'), executed: tag('ExecutionTime'), start: when(tag('StartTime')), end: when(tag('EndTime')), interval: iv ? intervalMinutes(iv[1]) : null, when, elements: {} };
    const re = /<BasinElement name="([^"]+)"[\s\S]*?<\/BasinElement>/g;
    let m;
    while ((m = re.exec(text))) {
      const st = (t) => { const r = new RegExp(`type="${t}"[^>]*value="([^"]*)"`).exec(m[0]); return r ? r[1] : null; };
      out.elements[m[1]] = { peak: parseFloat(st('Outflow Maximum')), peakTime: when(st('Outflow Maximum Time')), volume: parseFloat(st('Outflow Volume')), precip: parseFloat(st('Precipitation Total')) };
    }
    return out;
  }

  function stats(series, times, dtH, u) {
    let mx = -Infinity, mi = 0, vol = 0;
    for (let i = 0; i < series.length; i++) {
      if (series[i] > mx) { mx = series[i]; mi = i; }
      if (i > 0) vol += series[i] * dtH * 3600;
    }
    return { peak: mx, peakTime: times[mi], peakIndex: mi, vol: vol * u.volFactor, volRaw: vol };
  }

  function run(basin, met, gages, control, pdata) {
    const u = basin.units, dtMin = control.dtMin, dtH = dtMin / 60, times = control.times, n = times.length;
    const res = {};
    const byName = Object.fromEntries(basin.elements.map(e => [e.name, e]));
    const upstream = {};
    for (const e of basin.elements) if (e.downstream) (upstream[e.downstream] ||= []).push(e.name);
    const done = new Set(), visiting = new Set();
    const compute = (name) => {
      if (done.has(name)) return res[name];
      if (visiting.has(name)) throw new Error('โครงข่ายวนซ้ำที่ ' + name);
      visiting.add(name);
      const e = byName[name];
      if (!e) throw new Error('ไม่พบ element ' + name);
      const ups = (upstream[name] || []).map(compute);
      const inflow = new Float64Array(n);
      let area = 0;
      for (const up of ups) { area += up.area; for (let i = 0; i < n; i++) inflow[i] += up.outflow[i]; }
      let r;
      if (e.kind === 'Subbasin') {
        const p = subbasinHyetograph(met, gages, name, times);
        const { excess, loss } = lossMethod(p, e.loss, dtH, u);
        const tr = { ...e.transform, uh: e.transform.uhName && pdata ? pdata[e.transform.uhName] : null };
        if (tr.uh && !tr.uh.values) throw new Error(tr.uh.error);
        const direct = transform(excess, e.area, tr, dtMin, u);
        const { total, base } = baseflow(direct, e.area, e.baseflow, dtH);
        const sum = a => a.reduce((s, v) => s + v, 0);
        r = { kind: e.kind, area: e.area, precip: p, loss, excess, direct, base, outflow: total, totals: { precip: sum(p), loss: sum(loss), excess: sum(excess) } };
      } else if (e.kind === 'Reach') {
        r = { kind: e.kind, area, inflow, outflow: route(inflow, e.route, dtMin) };
      } else {
        r = { kind: e.kind, area, inflow, outflow: inflow };
      }
      r.name = name; r.upstream = upstream[name] || []; r.downstream = e.downstream;
      r.stats = stats(r.outflow, times, dtH, u);
      r.stats.depth = r.area ? r.stats.volRaw / (r.area * (u.metric ? 1e6 : 5280 * 5280)) * (u.metric ? 1000 : 12) : null;
      res[name] = r; done.add(name); visiting.delete(name);
      return r;
    };
    for (const e of basin.elements) compute(e.name);
    const outlets = basin.elements.filter(e => !e.downstream).map(e => e.name);
    const outlet = outlets.sort((a, b) => res[b].area - res[a].area)[0];
    return { times, dtH, results: res, order: basin.elements.map(e => e.name), outlet };
  }

  const api = { parseHms, writeHms, parseDateTime, fmtTime, fmtDate, fmtDateTime, hmsDate, intervalMinutes, readDss, dssSeries, readBasin, readMet, readGages, readPairedData, readControl, setControl, readProject, readRuns, readResults, resampleUH, run };
  if (typeof module !== 'undefined') module.exports = api; else root.MiniHMS = api;
})(this);
