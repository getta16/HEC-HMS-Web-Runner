// Mini HEC-HMS engine: reads HEC-HMS 4.x project files (text + DSS 7) and runs
// an event simulation in the browser or Node.
// Loss: None, Initial+Constant, SCS Curve Number. Transform: None, User-Specified UH,
// Clark, SCS, Snyder (standard). Baseflow: None, Recession. Routing: None, Lag, Muskingum.
// Reservoir: controlled outflow (orifice, ogee / broad-crested spillway, level dam top).
// Diversion: inflow-diversion table.
// Precip: Specified Average (one gage per subbasin), Gage Weights, Frequency Based Hypothetical.
(function (root) {
  'use strict';

  // ---------- messages (Thai / English) ----------
  const MSG = {
    th: {
      badDate: (d) => 'อ่านวันที่ไม่ได้: ' + d,
      notDss: () => 'ไม่ใช่ไฟล์ DSS',
      dss7: () => 'รองรับเฉพาะ DSS เวอร์ชัน 7 (HEC-HMS 4.x)',
      noMetSub: (s) => `ไม่พบข้อมูลฝนของ ${s} ในไฟล์ .met`,
      noGage: (g) => `ไม่พบข้อมูลสถานีฝน "${g}"`,
      unsupported: (what, m) => `ยังไม่รองรับ ${what}: ${m}`,
      noUH: (n) => `ไม่พบ Unit Hydrograph "${n}" (ต้องมีไฟล์ .pdata และ .dss)`,
      needFile: (f) => `ต้องใช้ไฟล์ ${f}`,
      noPath: (p, f) => `ไม่พบ ${p} ใน ${f}`,
      badDt: () => 'Time Interval ไม่ถูกต้อง',
      endBeforeStart: () => 'เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น',
      tooMany: (n) => `ช่วงเวลามากเกินไป (${n.toLocaleString()} ช่วง) เพิ่ม Time Interval หรือย่นช่วงเวลา`,
      loop: (n) => 'โครงข่ายวนซ้ำที่ ' + n,
      noElement: (n) => 'ไม่พบ element ' + n,
      noDepths: () => 'Frequency Based Hypothetical ต้องมีความลึกฝนอย่างน้อย 2 ช่วงเวลา',
      noStormArea: () => 'Depth-Area Reduction แบบ TP-40/TP-49 ต้องกำหนด Storm Size (User Specified Storm Area: Yes)',
      noTable: (type, t, el) => `ไม่พบตาราง ${type} "${t}" ของ ${el} (ต้องมีไฟล์ .pdata และ .dss)`,
    },
    en: {
      badDate: (d) => 'Cannot read date: ' + d,
      notDss: () => 'Not a DSS file',
      dss7: () => 'Only DSS version 7 (HEC-HMS 4.x) is supported',
      noMetSub: (s) => `No precipitation data for ${s} in the .met file`,
      noGage: (g) => `Gage "${g}" not found`,
      unsupported: (what, m) => `${what} not supported yet: ${m}`,
      noUH: (n) => `Unit hydrograph "${n}" not found (needs the .pdata and .dss files)`,
      needFile: (f) => `Requires file ${f}`,
      noPath: (p, f) => `${p} not found in ${f}`,
      badDt: () => 'Invalid Time Interval',
      endBeforeStart: () => 'End time must be after start time',
      tooMany: (n) => `Too many time steps (${n.toLocaleString()}). Increase the Time Interval or shorten the window`,
      loop: (n) => 'Network loops back at ' + n,
      noElement: (n) => 'Element not found: ' + n,
      noDepths: () => 'Frequency Based Hypothetical needs depths for at least 2 durations',
      noStormArea: () => 'TP-40/TP-49 depth-area reduction needs a Storm Size (User Specified Storm Area: Yes)',
      noTable: (type, t, el) => `${type} table "${t}" for ${el} not found (needs the .pdata and .dss files)`,
    },
  };
  let LANG = 'th';
  const msg = (k, ...a) => (MSG[LANG] || MSG.th)[k](...a);
  function setLang(l) { if (MSG[l]) LANG = l; }

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
      if (!cur) cur = { kind: key, name: val, props: {}, order: [], lines: [] };
      else { cur.lines.push([key, val]); if (!(key in cur.props)) { cur.props[key] = val; cur.order.push(key); } }
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  // Writes every original line (repeated keys in sub-blocks included); the first occurrence
  // of each key takes its value from props, and keys added later are appended.
  function writeHms(blocks) {
    return blocks.map(b => {
      const lines = [`${b.kind}: ${b.name}`], seen = new Set();
      for (const [k, v] of b.lines || []) { lines.push(`     ${k}: ${seen.has(k) || !(k in b.props) ? v : b.props[k]}`); seen.add(k); }
      for (const k of b.order) if (!seen.has(k)) lines.push(`     ${k}: ${b.props[k]}`);
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
    if (!m) throw new Error(msg('badDate', d));
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
    if (String.fromCharCode(...bytes.slice(0, 4)) !== 'ZDSS') throw new Error(msg('notDss'));
    if (bytes[16] !== 0x37) throw new Error(msg('dss7'));
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
      try { if (type >= 100 && type < 110) decodeRts(rec, s); else if (type >= 200 && type < 210) decodePaired(rec, s); } catch (e) { rec.error = e.message; }
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
      // units + data type strings start at int 17 of the internal header
      const txt = ni > 17 ? String.fromCharCode(...bytes.slice(ia * 8 + 68, ia * 8 + ni * 4)) : '';
      const words = txt.replace(/[^\x21-\x7e]/g, ' ').trim().split(/\s+/);
      rec.units = words[0] || ''; rec.dataType = words[1] || '';
      // int 9: 0 = none, 1 = repeat bits in header 2, 2 = every value equals the first
      const compression = I(9);
      const vals = new Float64Array(nvals);
      let k = 0, prev = 0;
      const rd = (j) => dbl ? dv.getFloat64(va * 8 + j * 8, true) : dv.getFloat32(va * 8 + j * 4, true);
      for (let i = 0; i < nvals; i++) {
        const rep = compression === 2 ? i > 0 : nh2 > 0 ? (dv.getUint32(h2 * 8 + (i >> 5) * 4, true) >>> (i & 31)) & 1 : 0;
        if (!rep) { prev = rd(k); k++; }
        vals[i] = prev;
      }
      for (let i = 0; i < nvals; i++) if (vals[i] < -3e38 || vals[i] === -901 || vals[i] === -902) vals[i] = NaN;
      rec.values = vals;
    }
    // Paired data: int 0 = ordinates, int 1 = curves; values = all X then each curve's Y.
    function decodePaired(rec, s) {
      const ia = W(s + 13), va = W(s + 19), n = dv.getInt32(ia * 8, true), nc = dv.getInt32(ia * 8 + 4, true);
      const dbl = rec.type === 205, rd = (j) => dbl ? dv.getFloat64(va * 8 + j * 8, true) : dv.getFloat32(va * 8 + j * 4, true);
      if (!(n > 0 && n < 100000 && nc > 0)) return;
      rec.x = []; rec.curves = [];
      for (let i = 0; i < n; i++) rec.x.push(rd(i));
      for (let c = 0; c < nc; c++) { const y = []; for (let i = 0; i < n; i++) y.push(rd(n * (c + 1) + i)); rec.curves.push(y); }
    }
    return { records };
  }
  function dssPaired(dss, pathname) {
    const want = pathParts(pathname);
    const r = dss.records.find(r => r.x && ['A', 'B', 'C', 'D', 'E', 'F'].every(k => upEq(pathParts(r.path)[k], want[k])));
    return r ? { x: r.x, y: r.curves[0] } : null;
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
  // Frequency Based Hypothetical (as HEC-HMS 4.13): the depth-duration curve is interpolated
  // log-log at every simulation time step (the storm's own Time Interval is not used), and the
  // incremental blocks are placed alternately before/after the peak, largest first when re-sorted.
  // TP-40/TP-49 reduction multiplies each depth by 1 − k(D)·(1 − e^(−0.015·A)), A in mi².
  const TP40_D = [30, 60, 180, 360, 1440, 2880, 5760, 10080, 14400], TP40_K = [0.48, 0.35, 0.22, 0.17, 0.09, 0.068, 0.055, 0.049, 0.044];
  const logLog = (x, xs, ys) => {
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let k = 1; while (xs[k] <= x) k++;
    return Math.exp(Math.log(ys[k - 1]) + (Math.log(ys[k]) - Math.log(ys[k - 1])) / (Math.log(xs[k]) - Math.log(xs[k - 1])) * (Math.log(x) - Math.log(xs[k - 1])));
  };
  function frequencyStorm(fs, depths, dt, metric) {
    const N = Math.round(fs.duration / dt);
    let pts = Object.entries(depths).map(([d, v]) => [+d, v]).filter(([d, v]) => d > 0 && v > 0).sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) throw new Error(msg('noDepths'));
    if (/^tp-40\/tp-49$/i.test(fs.areaReduction || '')) {
      if (!fs.userArea || !(fs.stormArea > 0)) throw new Error(msg('noStormArea'));
      const a = fs.stormArea / (metric ? 2.589988110336 : 1);
      pts = pts.map(([d, v]) => [d, v * (1 - logLog(Math.max(d, 30), TP40_D, TP40_K) * (1 - Math.exp(-0.015 * a)))]);
    } else if (!/^no reduction$/i.test(fs.areaReduction || 'No Reduction')) throw new Error(msg('unsupported', 'Depth-Area Reduction Method', fs.areaReduction));
    const D = (t) => {
      let k = 1; while (k < pts.length - 1 && pts[k][0] < t) k++;
      const [t0, d0] = pts[k - 1], [t1, d1] = pts[k];
      return d0 * Math.pow(t / t0, Math.log(d1 / d0) / Math.log(t1 / t0));
    };
    const inc = []; let prev = 0;
    for (let k = 1; k <= N; k++) { const c = D(k * dt); inc.push(Math.max(0, c - prev)); prev = c; }
    if (fs.resort) inc.sort((a, b) => b - a);
    const peak = Math.min(N - 1, Math.floor(N * fs.peakPct / 100)), values = new Array(N).fill(0);
    let before = peak - 1, after = peak + 1, side = 0;
    values[peak] = inc[0];
    for (let k = 1; k < N; k++) {
      if (after >= N || (before >= 0 && side === 0)) values[before--] = inc[k]; else values[after++] = inc[k];
      side ^= 1;
    }
    return values;
  }
  function subbasinHyetograph(met, gages, sub, times) {
    if (met.method === 'Frequency Based Hypothetical') {
      const fs = met.frequency, dt = (times[1] - times[0]) / 60000;
      const own = met.subbasins[sub] && met.subbasins[sub].depths;
      const depths = fs.uniform || !own || !Object.values(own).some(v => v > 0) ? fs.depths : own;
      const storm = frequencyStorm(fs, depths, dt, /metric|si/i.test(met.header.props['Unit System'] || ''));
      const p = new Float64Array(times.length);
      for (let i = 1; i < times.length && i <= storm.length; i++) p[i] = storm[i - 1];
      return p;
    }
    const sb = met.subbasins[sub];
    if (!sb) throw new Error(msg('noMetSub', sub));
    const need = (g) => { if (!gages[g]) throw new Error(msg('noGage', g)); return prepGage(gages[g]); };
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
    throw new Error(msg('unsupported', 'Precipitation Method', met.method));
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
    throw new Error(msg('unsupported', 'LossRate', prm.method));
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
  // Clark UH as HEC-HMS 4.13 builds it (also used for Snyder): time-area increments routed
  // through a linear reservoir, ordinates are averages of consecutive outflows, the UH stops
  // once 99.5% of the volume is reached (or at n ordinates) and is rescaled to unit depth.
  // conv = flow from a unit depth spread over one step; uh[j] = flow j steps after the excess.
  const clarkCum = (x) => x <= 0 ? 0 : x < 0.5 ? 1.41421356 * Math.pow(x, 1.5) : x < 1 ? 1 - 1.41421356 * Math.pow(1 - x, 1.5) : 1;
  function clarkUH(tc, R, conv, dtH, n) {
    let d9 = tc / dtH, n5 = Math.floor(d9) + 1;
    const d10 = Math.max(R / dtH, 0.5);
    if (n5 < 2) { d9 = 1; n5 = 2; }
    if (n === undefined) { const cb = 1 - 1 / (d10 + 0.5); n = cb > 0 ? n5 + Math.floor(Math.log10(0.005) / Math.log10(cb)) + 2 : n5 + 2; }
    n = Math.max(n, n5 + 1);
    const a = new Array(n).fill(0);
    for (let i = 0; i < n5; i++) a[i] = conv * clarkCum(i / d9);
    a[n5] = conv;
    for (let i = n5; i > 0; i--) a[i] -= a[i - 1];
    const ca = 1 / (d10 + 0.5), cb = 1 - ca;
    let prev = a[0] / d10, sum;
    a[0] = prev; sum = prev;
    for (let i = 1; i < n; i++) {
      const next = (i <= n5 ? a[i] * ca : 0) + prev * cb;
      a[i] = 0.5 * (prev + next);
      if ((sum += a[i]) > 0.995 * conv) { if (i + 1 < n) a[i + 1] = 0; break; }
      prev = next;
    }
    return a.map(v => v * conv / sum);
  }
  // Snyder standard UH (HEC-HMS 4.13): start from Tc = R = tp and rescale R and Tc (up to 40
  // passes) until the Clark UH's Cp and tp estimates are within ±0.5% of the given values.
  function snyderUH(area, tp, cp, dtH, u) {
    const conv = u.depthAreaToFlow(area, dtH);
    const n = Math.floor(Math.max(Math.max(18 - 19 * cp, 3.25) * Math.max(dtH / 2 + tp, dtH), 17.5 - 17.5 * cp) / dtH) + 2;
    const estimate = (a) => { // HMS peak location between ordinates, then Cp and tp
      let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i;
      let x = k;
      if (k <= 1) x = 1.5 - (a[1] - a[2]) / 0.5 * a[1];
      else if (a[k - 1] < a[k + 1]) x += 0.5 - 0.5 * (a[k] - a[k + 1]) / (a[k] - a[k - 1]);
      else if (a[k - 1] > a[k + 1]) x += -0.5 + 0.5 * (a[k] - a[k - 1]) / (a[k] - a[k + 1]);
      return { cp: a[k] * (x - 0.5) / conv, tp: (x - 0.75) * dtH * 1.048 };
    };
    let tc = tp, R = tp, uh;
    for (let pass = 0; pass < 40; pass++) {
      uh = clarkUH(tc, R, conv, dtH, n);
      const est = estimate(uh);
      let done = true, f = cp / est.cp;
      if (f < 0.995 || f > 1.005) { R = Math.max(R / f, 0.5 * dtH); done = false; }
      f = tp / est.tp;
      if (f < 0.995 || f > 1.005) { tc = Math.max(tc * f, dtH); done = false; }
      if (done) break;
    }
    return uh;
  }
  function transform(excess, area, prm, dtMin, u) {
    const dtH = dtMin / 60;
    if (prm.method === 'None' || !prm.method) return Float64Array.from(excess, e => e * u.depthAreaToFlow(area, dtH));
    if (prm.method === 'User-Specified UH') {
      if (!prm.uh) throw new Error(msg('noUH', prm.uhName));
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
    if (prm.method === 'Snyder') {
      if (prm.snyderMethod && !/^standard$/i.test(prm.snyderMethod)) throw new Error(msg('unsupported', 'Snyder Method', prm.snyderMethod));
      return convolve(excess, snyderUH(area, prm.tp, prm.cp, dtH, u));
    }
    if (prm.method === 'Clark') return convolve(excess, clarkUH(prm.tc, prm.storage, u.depthAreaToFlow(area, dtH), dtH));
    throw new Error(msg('unsupported', 'Transform', prm.method));
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
        else if (peak > q0 * 1.01 && q < (isNaN(prm.thresholdFlow) ? prm.thresholdRatio * peak : prm.thresholdFlow)) { receding = true; thr = total[i - 1]; }
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
    throw new Error(msg('unsupported', 'Route', prm.method));
  }

  // ---------- reservoir ----------
  // Outflow structures are sub-blocks ("Spillway: ... End Spillway:") inside the element.
  function readReservoir(b) {
    const p = b.props, structures = [];
    let cur = null;
    for (const [k, v] of b.lines || []) {
      if (/^(Conduit|Spillway|Dam Top|Pump|Dam Break|Outlet|Additional Outflow)$/.test(k)) { cur = { type: k, method: v, p: {} }; structures.push(cur); continue; }
      if (/^End /.test(k)) { cur = null; continue; }
      if (cur) cur.p[k] = v;
    }
    return {
      route: p['Route'], curve: p['Routing Curve'], initialElevation: num(p['Initial Elevation']), initialStorage: num(p['Initial Storage']), adaptive: !/^off$/i.test(p['Adaptive Control'] || 'On'),
      tables: { 'Elevation-Storage': p['Elevation-Storage Table'], 'Elevation-Area': p['Elevation-Area Table'] },
      tailwater: [p['Main Tailwater Condition'], p['Auxiliary Tailwater Condition']], evaporation: p['Evaporation Method'], structures,
    };
  }
  const lerp = (x, xs, ys) => {
    let k = 1;
    while (k < xs.length - 1 && xs[k] < x) k++;
    return ys[k - 1] + (ys[k] - ys[k - 1]) * (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
  };
  // Ogee coefficients vs He/Hd (HEC-HMS Technical Reference, US units): C, E, Kp, Ka concrete, Ka earth
  const OGEE = [[0, 3.1, 0, .123, -.008, .005], [.1, 3.205, .0059, .101, .023, .03], [.2, 3.32, .009, .082, .045, .053], [.3, 3.415, .0114, .063, .062, .074], [.4, 3.52, .0135, .046, .074, .092], [.5, 3.617, .0155, .034, .081, .112], [.6, 3.71, .0174, .026, .089, .123], [.7, 3.8, .0191, .017, .093, .137], [.8, 3.88, .0208, .009, .097, .15], [.9, 3.943, .0224, .003, .099, .162], [1, 4, .0241, 0, .1, .174], [1.1, 4.045, .026, -.006, .1, .182], [1.2, 4.07, .0281, -.012, .1, .189], [1.3, 4.09, .0307, -.013, .1, .194]];
  const ogeeCol = (r, j) => lerp(Math.min(r, 1.3), OGEE.map(o => o[0]), OGEE.map(o => o[j]));
  // Returns flow as a function of pool elevation for one outflow structure.
  function structureFlow(st, u) {
    const p = st.p, g = u.metric ? 9.80665 : 32.174;
    if (st.type === 'Conduit' && st.method === 'Orifice') {
      const cd = num(p['Orifice Coefficient']), a = num(p['Orifice Area']), z = num(p['Centerline Elevation']), nb = num(p['Number Barrels'] || 1);
      return (e) => e > z ? nb * cd * a * Math.sqrt(2 * g * (e - z)) : 0;
    }
    if (st.type === 'Spillway' && st.method === 'Ogee Spillway') {
      const L = num(p['Spillway Crest Length']), z = num(p['Spillway Crest Elevation']), hd = num(p['Spillway Design Head']);
      const da = num(p['Spillway Approach Depth']), loss = num(p['Spillway Approach Loss'] || 0), nab = num(p['Number of Spillway Abutments'] || 0);
      const kaCol = /earth/i.test(p['Spillway Abutment Type'] || '') ? 5 : 4, cUnit = u.metric ? Math.sqrt(0.3048) : 1;
      // As HEC-HMS 4.13: He = H·(1 − loss/Hd), Da/Hd capped at 1.33, Le = L − He·N·Ka (no piers)
      return (e) => {
        if (e <= z) return 0;
        const he = (e - z) * (1 - loss / hd), r = he / hd;
        const cq = ogeeCol(r, 1) * Math.pow(Math.min(da / hd, 1.33), ogeeCol(r, 2)) * cUnit;
        return cq * Math.min(L, L - he * nab * ogeeCol(r, kaCol)) * Math.pow(he, 1.5);
      };
    }
    if (st.type === 'Spillway' && st.method === 'Broad-Crested Spillway') {
      const L = num(p['Spillway Crest Length']), z = num(p['Spillway Crest Elevation']), c = num(p['Spillway Coefficient']);
      return (e) => e > z ? c * L * Math.pow(e - z, 1.5) : 0;
    }
    if (st.type === 'Dam Top' && st.method === 'Level Dam') {
      const c = num(p['Overflow Coefficient']), L = num(p['Top Length']), z = num(p['Top Elevation']);
      return (e) => e > z ? c * L * Math.pow(e - z, 1.5) : 0;
    }
    throw new Error(msg('unsupported', 'Reservoir ' + st.type, st.method));
  }
  const STORAGE_UNIT = { 'THOU M3': 1000, '1000 M3': 1000, 'M3': 1, 'MILLION M3': 1e6, 'AC-FT': 43560, 'ACRE-FT': 43560, 'FT3': 1 };
  const AREA_UNIT = { 'THOU M2': 1000, '1000 M2': 1000, 'M2': 1, 'KM2': 1e6, 'HA': 1e4, 'ACRE': 43560, 'AC': 43560, 'FT2': 1 };
  // Controlled-outflow reservoir (outflow structures).
  function reservoirRoute(inflow, res, pdata, dtMin, u, name) {
    if (!/controlled outflow|outflow structures/i.test(res.route || '')) throw new Error(msg('unsupported', 'Reservoir Route', res.route));
    if (res.tailwater.some(t => t && !/^none$/i.test(t))) throw new Error(msg('unsupported', 'Tailwater', res.tailwater.join(', ')));
    if (res.evaporation && !/zero evaporation|none/i.test(res.evaporation)) throw new Error(msg('unsupported', 'Evaporation Method', res.evaporation));
    const tbl = (type) => {
      const t = pdata && pdata[tableKey(type, res.tables[type])];
      if (!t) throw new Error(msg('noTable', type, res.tables[type], name));
      if (t.error) throw new Error(t.error);
      return t;
    };
    let elevs, stor, unit;
    if (res.curve === 'Elevation-Storage') {
      const t = tbl('Elevation-Storage');
      unit = { f: STORAGE_UNIT[(t.yUnits || '').toUpperCase()] || 1, label: t.yUnits || '' };
      elevs = t.x; stor = t.y.map(v => v * unit.f);
    } else if (res.curve === 'Elevation-Area') { // conic formula between table rows
      const t = tbl('Elevation-Area'), af = AREA_UNIT[(t.yUnits || '').toUpperCase()] || 1;
      elevs = t.x; stor = [0];
      for (let i = 1; i < t.x.length; i++) { const a1 = t.y[i - 1] * af, a2 = t.y[i] * af; stor.push(stor[i - 1] + (t.x[i] - t.x[i - 1]) / 3 * (a1 + a2 + Math.sqrt(a1 * a2))); }
      unit = u.metric ? { f: 1000, label: 'THOU M3' } : { f: 43560, label: 'AC-FT' };
    } else throw new Error(msg('unsupported', 'Routing Curve', res.curve));
    const flows = res.structures.map(st => structureFlow(st, u));
    // HEC-HMS 4.13 scheme (SI inside): each interval is split into whole-second sub-steps; every
    // sub-step solves (S(E) − S0)/h − Ī + (O(E) + O0)/2 = 0 for the pool elevation E, with Ī
    // the interval's mean inflow. The first sub-step is the time to drain to the lowest outlet
    // when outflow exceeds inflow; adaptive control shrinks or doubles the sub-step.
    const fe = u.metric ? 1 : 0.3048, fq = u.metric ? 1 : 0.028316846592;
    const E = elevs.map(e => e * fe), Sv = stor.map(s => s * (u.metric ? 1 : 0.028316846592));
    const sOf = (e) => Math.max(0, lerp(e, E, Sv)), elevOfS = (s) => lerp(s, Sv, E);
    const qOf = (e) => flows.reduce((a, f) => a + f(e / fe), 0) * fq;
    const lows = res.structures.map(st => num(st.p['Centerline Elevation'] ?? st.p['Spillway Crest Elevation'] ?? st.p['Top Elevation']) * fe).filter(v => !isNaN(v));
    const eLow = Math.min(E[E.length - 1], ...lows);
    const solve = (e0, s0, q0, qin, h) => {
      const f = (e) => (sOf(e) - s0) / h - qin + (qOf(e) + q0) / 2;
      let lo = E[0], hi = E[E.length - 1];
      if (f(lo) >= 0) return lo;
      if (f(hi) <= 0) return hi;
      for (let k = 0; k < 200 && hi - lo > 1e-12; k++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
      return (lo + hi) / 2;
    };
    const shrink = (h, de, q0, q1, s0, s1, grow) => {
      if (Math.abs(de) > 0.1) return Math.trunc(h / Math.ceil(Math.abs(de) / 0.1));
      if (q0 > 0.025 && q1 > 0.025 && Math.abs(q0 - q1) / q0 > 0.1) return Math.trunc(h / Math.ceil(Math.abs(q0 - q1) / q0 / 0.1));
      if (Math.abs(s0 - s1) / s0 > 0.03) return Math.trunc(h / Math.ceil(Math.abs(s0 - s1) / s0 / 0.03));
      if (grow && (Math.abs(de) < 0.05 || Math.abs(q0 - q1) / q0 < 0.05 || Math.abs(s0 - s1) / s0 < 0.015)) return h * 2;
      return h;
    };
    let el;
    if (!isNaN(res.initialElevation)) el = res.initialElevation * fe;
    else if (!isNaN(res.initialStorage)) el = elevOfS(res.initialStorage * unit.f * (u.metric ? 1 : 0.028316846592));
    else { // inflow = outflow
      let lo = E[0], hi = E[E.length - 1];
      for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (qOf(m) > inflow[0] * fq) hi = m; else lo = m; }
      el = (lo + hi) / 2;
    }
    const n = inflow.length, full = Math.round(dtMin * 60);
    const outflow = new Float64Array(n), storage = new Float64Array(n), elevation = new Float64Array(n), parts = flows.map(() => new Float64Array(n));
    const record = (i) => { const e = el / fe; elevation[i] = e; storage[i] = sOf(el) / (u.metric ? 1 : 0.028316846592) / unit.f; flows.forEach((f, j) => { parts[j][i] = f(e); outflow[i] += parts[j][i]; }); };
    record(0);
    for (let i = 1; i < n; i++) {
      let e0 = el, s0 = sOf(el), q0 = qOf(el);
      const qin = (Math.max(0, inflow[i - 1]) + Math.max(0, inflow[i])) / 2 * fq;
      let left = full, h = full;
      if (q0 > qin) h = Math.trunc(-(s0 - sOf(eLow)) / (qin - q0));
      else if (q0 === 0 && e0 >= eLow && qin > 0) h = 5;
      h = Math.max(1, Math.min(h, full));
      left -= h;
      let e1 = solve(e0, s0, q0, qin, h), q1 = qOf(e1), s1 = sOf(e1);
      if (res.adaptive) {
        const h0 = h;
        h = Math.max(1, shrink(h, e0 - e1, q0, q1, s0, s1, false));
        if (h < h0) left += h0; else if (h > left) h = left;
      }
      while (left > 0) {
        left -= h;
        e1 = solve(e0, s0, q0, qin, h); q1 = qOf(e1); s1 = sOf(e1);
        if (res.adaptive) h = Math.max(1, shrink(h, e0 - e1, q0, q1, s0, s1, true));
        h = Math.min(h, full);
        if (left > 0 && h > left) h = left;
        h = Math.max(1, h);
        e0 = e1; s0 = s1; q0 = q1;
      }
      el = e1;
      record(i);
    }
    return { outflow, storage, elevation, storageUnits: unit.label, structures: res.structures.map((st, j) => ({ type: st.type, method: st.method, flow: parts[j] })) };
  }

  // ---------- diversion ----------
  function divert(inflow, dv, pdata, dtMin, u, name) {
    if (dv.method !== 'Inflow-Diversion Table') throw new Error(msg('unsupported', 'Diverter', dv.method));
    const t = pdata && pdata[tableKey('Inflow-Diversion', dv.table)];
    if (!t) throw new Error(msg('noTable', 'Inflow-Diversion', dv.table, name));
    if (t.error) throw new Error(t.error);
    const n = inflow.length, diverted = new Float64Array(n), outflow = new Float64Array(n);
    // Maximum Diversion Volume is in 1000 m³ (metric) or ac-ft (US)
    let left = isNaN(dv.maxVolume) ? Infinity : dv.maxVolume * (u.metric ? 1000 : 43560);
    for (let i = 0; i < n; i++) {
      let d = Math.max(0, Math.min(inflow[i], lerp(inflow[i], t.x, t.y)));
      if (!isNaN(dv.maxFlow)) d = Math.min(d, dv.maxFlow);
      if (i > 0) { d = Math.min(d, left / (dtMin * 60)); left -= d * dtMin * 60; }
      diverted[i] = d; outflow[i] = inflow[i] - d;
    }
    return { diverted, outflow };
  }

  // ---------- model assembly ----------
  const num = (v) => v === undefined || v === '' ? NaN : parseFloat(v);
  function units(system) {
    const metric = /metric|si/i.test(system || '');
    return metric
      ? { metric, area: 'km²', depth: 'mm', flow: 'm³/s', vol: '10⁶ m³', volFactor: 1e-6, depthAreaToFlow: (a, dtH) => a * 1e6 / 1000 / (dtH * 3600), rate: 'mm/hr', flowPerArea: 'm³/s/km²' }
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
      if (!['Subbasin', 'Reach', 'Junction', 'Sink', 'Source', 'Reservoir', 'Diversion'].includes(b.kind)) { other.push(b); continue; }
      const el = { kind: b.kind, name: b.name, downstream: p['Downstream'] || null, block: b };
      if (b.kind === 'Subbasin') {
        el.area = num(p['Area']);
        el.loss = { method: p['LossRate'], initialLoss: num(p['Initial Loss']), constantRate: num(p['Constant Loss Rate']), impervious: num(p['Percent Impervious Area'] || 0), cn: num(p['Curve Number']), ia: num(p['Initial Abstraction']) };
        el.transform = { method: p['Transform'], tc: num(p['Time of Concentration']), storage: num(p['Storage Coefficient']), lag: num(p['Lag']), uhName: p['Unit Hydrograph Name'], snyderMethod: p['Snyder Method'], tp: num(p['Snyder Tp']), cp: num(p['Snyder Cp']) };
        el.baseflow = { method: p['Baseflow'], recession: num(p['Recession Factor']), initialPerArea: num(p['Initial Flow/Area Ratio']), thresholdRatio: num(p['Threshold Flow To Peak Ratio']), thresholdFlow: num(p['Threshold Flow']) };
      } else if (b.kind === 'Reach') {
        el.route = { method: p['Route'], K: num(p['Muskingum K']), X: num(p['Muskingum x']), steps: num(p['Muskingum Steps'] || 1), lag: num(p['Lag']) };
      } else if (b.kind === 'Reservoir') {
        el.reservoir = readReservoir(b);
      } else if (b.kind === 'Diversion') {
        el.divertTo = p['Divert To'] || null;
        el.diversion = { method: p['Diverter'], table: p['Inflow Diversion Table Name'], maxFlow: num(p['Maximum Diversion Flow']), maxVolume: num(p['Maximum Diversion Volume']) };
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
    const durDepths = (b) => { const d = {}; for (const k of b.order) { const m = /^Depth (\d+(?:\.\d+)?)$/.exec(k); if (m) d[m[1]] = num(b.props[k]); } return d; };
    for (const b of blocks.slice(1)) {
      if (b.kind === 'Precip Method Parameters' && b.name === 'Frequency Based Hypothetical') {
        const p = b.props, pct = num(p['Percent of Duration Before Peak Rainfall']);
        met.frequency = {
          duration: num(p['Total Duration']), interval: num(p['Time Interval']), peakPct: isNaN(pct) ? 50 : pct,
          uniform: !/^no$/i.test(p['Uniform Depth Duration Curve'] || 'Yes'), resort: /^yes$/i.test(p['Re-sort Storm Symmetrically'] || ''),
          areaReduction: p['Depth-Area Reduction Method'], userArea: /^yes$/i.test(p['User Specified Storm Area'] || ''), stormArea: num(p['Storm Size']), depths: durDepths(b),
        };
        continue;
      }
      if (b.kind !== 'Subbasin') continue;
      const depth = {}, time = {};
      for (const k of b.order) {
        let m = /^Depth Weight (.+)$/.exec(k); if (m) depth[m[1]] = num(b.props[k]);
        m = /^Time Weight (.+)$/.exec(k); if (m) time[m[1]] = num(b.props[k]);
      }
      met.subbasins[b.name] = { gage: b.props['Gage'], depth, time, depths: durDepths(b) };
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
        if (!dss) g.error = msg('needFile', g.file);
        else {
          const s = dssSeries(dss, g.pathname);
          if (!s) g.error = msg('noPath', g.pathname, g.file);
          else { g.values = Array.from(s.values); g.interval = s.interval; g.start = s.start; g.units = s.units; }
        }
      }
      if (g.values && isNaN(g.total)) g.total = g.values.reduce((a, v) => a + (v > 0 ? v : 0), 0);
      if (g.values || g.error) gages[b.name] = g;
    }
    return gages;
  }

  const tableKey = (type, name) => 'Table:' + type + '|' + name;
  function readPairedData(text, getDss) {
    const out = {};
    for (const b of parseHms(text)) {
      if (b.kind !== 'Pattern' && b.kind !== 'Table') continue;
      const p = b.props, rec = { name: b.name, kind: b.kind, tableType: p['Table Type'], xUnits: p['X-Units'], yUnits: p['Y-Units'], dataType: p['Data Type'], units: p['Units'], duration: num(p['Duration']), file: p['DSS File'], pathname: p['Pathname'] };
      const dss = rec.pathname && getDss ? getDss(rec.file) : null;
      // tables are keyed by type too: HMS allows one name per table type
      if (b.kind === 'Table') {
        const t = dss && dssPaired(dss, rec.pathname);
        if (t) { rec.x = t.x; rec.y = t.y; } else rec.error = dss ? msg('noPath', rec.pathname, rec.file) : msg('needFile', rec.file);
        out[tableKey(rec.tableType, b.name)] = rec;
        continue;
      }
      if (dss) {
        const s = dssSeries(dss, rec.pathname);
        if (s) { rec.values = Array.from(s.values); rec.interval = rec.duration || s.interval; }
      }
      if (!rec.values) rec.error = msg('needFile', rec.file);
      out[b.name] = rec;
    }
    return out;
  }

  function readControl(text) {
    const blocks = parseHms(text), b = blocks[0], p = b.props;
    const start = parseDateTime(p['Start Date'], p['Start Time']);
    const end = parseDateTime(p['End Date'], p['End Time']);
    const dt = num(p['Time Interval']);
    if (!(dt > 0)) throw new Error(msg('badDt'));
    if (end <= start) throw new Error(msg('endBeforeStart'));
    const n = Math.floor((end - start) / (dt * 60000)) + 1;
    if (n > 200000) throw new Error(msg('tooMany', n));
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
    const diverted = {}; // target -> diversion elements feeding it
    for (const e of basin.elements) {
      if (e.downstream) (upstream[e.downstream] ||= []).push(e.name);
      if (e.divertTo) (diverted[e.divertTo] ||= []).push(e.name);
    }
    const done = new Set(), visiting = new Set();
    const compute = (name) => {
      if (done.has(name)) return res[name];
      if (visiting.has(name)) throw new Error(msg('loop', name));
      visiting.add(name);
      const e = byName[name];
      if (!e) throw new Error(msg('noElement', name));
      const ups = (upstream[name] || []).map(compute);
      const inflow = new Float64Array(n);
      let area = 0;
      for (const up of ups) { area += up.area; for (let i = 0; i < n; i++) inflow[i] += up.outflow[i]; }
      for (const dv of (diverted[name] || []).map(compute)) for (let i = 0; i < n; i++) inflow[i] += dv.diverted[i];
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
      } else if (e.kind === 'Reservoir') {
        r = { kind: e.kind, area, inflow, ...reservoirRoute(inflow, e.reservoir, pdata, dtMin, u, name) };
      } else if (e.kind === 'Diversion') {
        r = { kind: e.kind, area, inflow, divertTo: e.divertTo, ...divert(inflow, e.diversion, pdata, dtMin, u, name) };
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

  const api = { setLang, parseHms, writeHms, parseDateTime, fmtTime, fmtDate, fmtDateTime, hmsDate, intervalMinutes, readDss, dssSeries, readBasin, readMet, readGages, frequencyStorm, readPairedData, readControl, setControl, readProject, readRuns, readResults, resampleUH, run };
  if (typeof module !== 'undefined') module.exports = api; else root.MiniHMS = api;
})(this);
