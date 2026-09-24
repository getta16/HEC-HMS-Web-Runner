// Mini HEC-HMS engine: parses HMS text files and runs an event simulation.
// Methods: Initial+Constant loss (with % impervious), Clark UH, Recession baseflow,
// Muskingum routing, Junction summation. English units (in, mi2, cfs, ac-ft).
(function (root) {
  'use strict';

  // ---------- HMS text-file parser ----------
  // Blocks look like "Kind: Name\n     Key: Value\n ... End:"
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
      else { cur.props[key] = val; cur.order.push(key); }
    }
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

  // ---------- time helpers ----------
  const MONTHS = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };
  function parseDateTime(d, t) {
    const [day, mon, yr] = d.split(/\s+/);
    const [hh, mm] = t.split(':').map(Number);
    return Date.UTC(+yr, MONTHS[mon], +day, hh, mm);
  }
  function fmtTime(ms) {
    const d = new Date(ms);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  }

  // ---------- precipitation ----------
  // Gage-weights method: depth weights from total-storm gages, temporal pattern
  // from a recording gage. Recording data = incremental depth at a fixed interval.
  function subbasinHyetograph(met, gages, sub, times, dtMin) {
    const sb = met.subbasins[sub];
    if (!sb) throw new Error('No gage weights for ' + sub);
    let total = 0;
    for (const [g, w] of Object.entries(sb.depth)) total += w * gages[g].total;
    // time pattern: weighted cumulative fraction of recording gages
    const cumAt = (ms) => {
      let c = 0;
      for (const [g, w] of Object.entries(sb.time)) c += w * cumFraction(gages[g], ms);
      return c;
    };
    const p = new Float64Array(times.length);
    for (let i = 1; i < times.length; i++) p[i] = total * (cumAt(times[i]) - cumAt(times[i - 1]));
    return p;
  }
  function cumFraction(g, ms) {
    // linear interpolation of the cumulative recording-gage curve
    const n = g.values.length, step = g.interval * 60000;
    const sum = g.cumulative[n];
    const x = (ms - g.start) / step;
    if (x <= 0) return 0;
    if (x >= n) return 1;
    const i = Math.floor(x), f = x - i;
    return (g.cumulative[i] + f * (g.cumulative[i + 1] - g.cumulative[i])) / sum;
  }

  // ---------- loss: initial + constant with impervious area ----------
  function lossInitialConstant(p, prm, dtH) {
    const imp = prm.impervious / 100, rate = prm.constantRate * dtH;
    let il = prm.initialLoss;
    const excess = new Float64Array(p.length), loss = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) {
      let pv = p[i], l = 0;
      if (il > 0) { const a = Math.min(pv, il); il -= a; l += a; pv -= a; }
      const c = Math.min(pv, rate); l += c; pv -= c;
      loss[i] = (1 - imp) * l;
      excess[i] = imp * p[i] + (1 - imp) * pv;
    }
    return { excess, loss };
  }

  // ---------- transform: Clark unit hydrograph ----------
  const IN_MI2_TO_CF = 5280 * 5280 / 12;
  function clark(excess, area, prm, dtH) {
    const tc = prm.tc, R = prm.storage;
    const cumA = (t) => {
      if (t <= 0) return 0;
      if (t >= tc) return 1;
      const r = t / tc;
      return r <= 0.5 ? 1.414 * Math.pow(r, 1.5) : 1 - 1.414 * Math.pow(1 - r, 1.5);
    };
    const nOrd = Math.ceil(tc / dtH) + 1;
    const ta = [];
    for (let k = 1; k <= nOrd; k++) ta.push(cumA(k * dtH) - cumA((k - 1) * dtH));
    const conv = area * IN_MI2_TO_CF / (dtH * 3600); // in over area in one step -> cfs
    const n = excess.length, inflow = new Float64Array(n + nOrd);
    for (let i = 0; i < n; i++) if (excess[i] > 0)
      for (let k = 0; k < nOrd; k++) inflow[i + k] += excess[i] * ta[k] * conv;
    const ca = dtH / (R + 0.5 * dtH), cb = 1 - ca;
    const q = new Float64Array(n);
    let o = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const iAvg = 0.5 * (prev + inflow[i]);
      o = ca * iAvg + cb * o;
      prev = inflow[i];
      q[i] = o;
    }
    return q;
  }

  // ---------- baseflow: recession ----------
  function recession(direct, area, prm, dtH) {
    const kStep = Math.pow(prm.recession, dtH / 24);
    const q0 = prm.initialPerArea * area;
    const n = direct.length, total = new Float64Array(n), base = new Float64Array(n);
    let peak = 0, receding = false, thr = 0;
    for (let i = 0; i < n; i++) {
      const b = q0 * Math.pow(kStep, i);
      let q = direct[i] + b;
      if (!receding) {
        if (q > peak) peak = q;
        else if (peak > q0 * 1.01 && q < prm.thresholdRatio * peak) { receding = true; thr = total[i - 1]; }
      }
      if (receding) { thr *= kStep; q = Math.max(thr, direct[i]); }
      total[i] = q; base[i] = q - direct[i];
    }
    return { total, base };
  }

  // ---------- routing: Muskingum ----------
  function muskingum(inflow, prm, dtH) {
    const n = Math.max(1, Math.round(prm.steps || 1));
    const K = prm.K / n, X = prm.X;
    const d = 2 * K * (1 - X) + dtH;
    const c0 = (dtH - 2 * K * X) / d, c1 = (dtH + 2 * K * X) / d, c2 = (2 * K * (1 - X) - dtH) / d;
    let I = inflow;
    for (let s = 0; s < n; s++) {
      const O = new Float64Array(I.length);
      O[0] = I[0];
      for (let i = 1; i < I.length; i++) O[i] = Math.max(0, c0 * I[i] + c1 * I[i - 1] + c2 * O[i - 1]);
      I = O;
    }
    return I;
  }

  // ---------- model assembly ----------
  const num = (v) => parseFloat(v);
  function readBasin(text) {
    const blocks = parseHms(text);
    const elements = [];
    let header = null;
    for (const b of blocks) {
      const p = b.props;
      if (b.kind === 'Basin') { header = b; continue; }
      const el = { kind: b.kind, name: b.name, downstream: p['Downstream'] || null, block: b };
      if (b.kind === 'Subbasin') {
        el.area = num(p['Area']);
        el.loss = { method: p['LossRate'], initialLoss: num(p['Initial Loss']), constantRate: num(p['Constant Loss Rate']), impervious: num(p['Percent Impervious Area'] || 0) };
        el.transform = { method: p['Transform'], tc: num(p['Time of Concentration']), storage: num(p['Storage Coefficient']) };
        el.baseflow = { method: p['Baseflow'], recession: num(p['Recession Factor']), initialPerArea: num(p['Initial Flow/Area Ratio']), thresholdRatio: num(p['Threshold Flow To Peak Ratio']) };
      } else if (b.kind === 'Reach') {
        el.route = { method: p['Route'], K: num(p['Muskingum K']), X: num(p['Muskingum x']), steps: num(p['Muskingum Steps'] || 1) };
      }
      if (p['Canvas X']) { el.x = num(p['Canvas X']); el.y = num(p['Canvas Y']); }
      elements.push(el);
    }
    return { header, elements };
  }

  function readMet(text) {
    const blocks = parseHms(text);
    const met = { header: blocks[0], subbasins: {} };
    for (const b of blocks.slice(1)) {
      if (b.kind !== 'Subbasin') continue;
      const depth = {}, time = {};
      for (const k of b.order) {
        let m = /^Depth Weight (.+)$/.exec(k); if (m) depth[m[1]] = num(b.props[k]);
        m = /^Time Weight (.+)$/.exec(k); if (m) time[m[1]] = num(b.props[k]);
      }
      met.subbasins[b.name] = { depth, time };
    }
    return met;
  }

  // Gage file: "Gage: name" blocks with Total Storm depth and, for recording
  // gages, an inline incremental series (stand-in for the DSS record).
  function readGages(text) {
    const gages = {};
    for (const b of parseHms(text)) {
      if (b.kind !== 'Gage') continue;
      const p = b.props;
      const g = { name: b.name, total: num(p['Total Storm Depth']) };
      if (p['Data Values']) {
        g.values = p['Data Values'].split(/[\s,]+/).filter(Boolean).map(Number);
        g.interval = num(p['Data Interval']);
        g.start = parseDateTime(p['Start Date'], p['Start Time']);
        g.cumulative = [0];
        for (const v of g.values) g.cumulative.push(g.cumulative[g.cumulative.length - 1] + v);
      }
      gages[b.name] = g;
    }
    return gages;
  }

  function readControl(text) {
    const b = parseHms(text)[0], p = b.props;
    const start = parseDateTime(p['Start Date'], p['Start Time']);
    const end = parseDateTime(p['End Date'], p['End Time']);
    const dt = num(p['Time Interval']);
    const times = [];
    for (let t = start; t <= end; t += dt * 60000) times.push(t);
    return { name: b.name, start, end, dtMin: dt, times };
  }

  function stats(series, times, area, dtH) {
    let mx = -Infinity, mi = 0, mn = Infinity;
    let vol = 0;
    for (let i = 0; i < series.length; i++) {
      if (series[i] > mx) { mx = series[i]; mi = i; }
      if (series[i] < mn) mn = series[i];
      if (i > 0) vol += series[i] * dtH * 3600;
    }
    const acft = vol / 43560;
    return { peak: mx, peakTime: fmtTime(times[mi]), peakIndex: mi, min: mn, vol: acft, depth: area ? acft * 12 / (area * 640) : null };
  }

  function run(basin, met, gages, control) {
    const dtH = control.dtMin / 60, times = control.times, n = times.length;
    const res = {};
    const byName = Object.fromEntries(basin.elements.map(e => [e.name, e]));
    const upstream = {};
    for (const e of basin.elements) if (e.downstream) (upstream[e.downstream] ||= []).push(e.name);
    const done = new Set();
    const compute = (name) => {
      if (done.has(name)) return res[name];
      const e = byName[name];
      if (!e) throw new Error('Unknown element ' + name);
      const ups = (upstream[name] || []).map(compute);
      const inflow = new Float64Array(n);
      let area = 0;
      for (const u of ups) { area += u.area; for (let i = 0; i < n; i++) inflow[i] += u.outflow[i]; }
      let r;
      if (e.kind === 'Subbasin') {
        const p = subbasinHyetograph(met, gages, name, times, control.dtMin);
        const { excess, loss } = lossInitialConstant(p, e.loss, dtH);
        const direct = clark(excess, e.area, e.transform, dtH);
        const { total, base } = recession(direct, e.area, e.baseflow, dtH);
        const sum = a => a.reduce((s, v) => s + v, 0);
        const lossMaxI = loss.reduce((b, v, i, a) => v > a[b] ? i : b, 0);
        r = { kind: e.kind, area: e.area, precip: p, loss, excess, direct, base, outflow: total,
          totals: { precip: sum(p), loss: sum(loss), excess: sum(excess), lossMax: loss[lossMaxI], lossMaxTime: fmtTime(times[lossMaxI]) } };
        r.baseStats = stats(base, times, e.area, dtH);
      } else if (e.kind === 'Reach') {
        r = { kind: e.kind, area, inflow, outflow: muskingum(inflow, e.route, dtH) };
      } else {
        r = { kind: e.kind, area, inflow, outflow: inflow };
      }
      r.name = name; r.upstream = upstream[name] || [];
      r.stats = stats(r.outflow, times, r.area, dtH);
      if (r.inflow) r.inStats = stats(r.inflow, times, r.area, dtH);
      res[name] = r; done.add(name);
      return r;
    };
    for (const e of basin.elements) compute(e.name);
    return { times, dtH, results: res, order: basin.elements.map(e => e.name) };
  }

  const api = { parseHms, writeHms, readBasin, readMet, readGages, readControl, run, fmtTime };
  if (typeof module !== 'undefined') module.exports = api; else root.MiniHMS = api;
})(this);
