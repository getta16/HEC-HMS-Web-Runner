// Mini HEC-HMS engine: reads HEC-HMS 4.x project files (text + DSS 7) and runs
// an event simulation in the browser or Node.
// Loss: None, Initial+Constant, SCS Curve Number. Transform: None, User-Specified UH,
// Clark, SCS, Snyder (standard). Baseflow: None, Recession. Routing: None, Lag, Muskingum,
// Modified Puls.
// Reservoir: controlled outflow (orifice, box/circular culvert, head-discharge pump, ogee /
// broad-crested spillway, level dam top), specified-stage tailwater.
// Diversion: inflow-diversion table.
// Precip: Specified Average (one gage per subbasin), Weighted Gages (and the older Gage
// Weights format), Frequency Based Hypothetical.
(function (root) {
  'use strict';

  // ---------- messages (Thai / English) ----------
  const MSG = {
    th: {
      badDate: (d) => 'อ่านวันที่ไม่ได้: ' + d,
      notDss: () => 'ไม่ใช่ไฟล์ DSS',
      dss7: () => 'รองรับเฉพาะ DSS เวอร์ชัน 6 และ 7',
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
      noGrid: (g) => `ไม่พบ grid "${g}" (ต้องมีไฟล์ .grid และไฟล์ DSS ของ grid)`,
      noCells: (s, f) => `ไม่พบข้อมูล grid cell ของ ${s} (ต้องมีไฟล์ ${f})`,
      pumpHead: (h) => `head ของปั๊ม ${h.toFixed(2)} อยู่นอกช่วงตาราง Head-Discharge`,
      outOfTable: (t, el) => `ค่าที่คำนวณได้เกินช่วงของตาราง "${t}" ที่ ${el}`,
      noStormArea: () => 'Depth-Area Reduction แบบ TP-40/TP-49 ต้องกำหนด Storm Size (User Specified Storm Area: Yes)',
      noWeights: (s) => `${s}: ต้องมี Volume Weight และ Temporal Distribution Weight อย่างน้อยอย่างละหนึ่งสถานีที่มากกว่า 0`,
      notRecording: (g) => `สถานี "${g}" ไม่ใช่สถานีแบบบันทึกต่อเนื่อง ใช้เป็น Temporal Distribution Weight ไม่ได้`,
      noTable: (type, t, el) => `ไม่พบตาราง ${type} "${t}" ของ ${el} (ต้องมีไฟล์ .pdata และ .dss)`,
    },
    en: {
      badDate: (d) => 'Cannot read date: ' + d,
      notDss: () => 'Not a DSS file',
      dss7: () => 'Only DSS versions 6 and 7 are supported',
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
      noGrid: (g) => `Grid "${g}" not found (needs the .grid file and the grid DSS file)`,
      noCells: (s, f) => `No grid cells for ${s} (needs file ${f})`,
      pumpHead: (h) => `Pump head ${h.toFixed(2)} is outside the head-discharge table`,
      outOfTable: (t, el) => `Computed value is outside table "${t}" at ${el}`,
      noStormArea: () => 'TP-40/TP-49 depth-area reduction needs a Storm Size (User Specified Storm Area: Yes)',
      noWeights: (s) => `${s}: needs at least one gage with a volume weight and one with a temporal distribution weight above 0`,
      notRecording: (g) => `Gage "${g}" is not a recording gage, so it cannot have a temporal distribution weight`,
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
    if (bytes[16] === 0x36) return readDss6(dv, bytes);
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
      try { if (type >= 100 && type < 110) decodeRts(rec, s); else if (type >= 200 && type < 210) decodePaired(rec, s); else if (type >= 400 && type < 450) decodeGrid(rec, s); } catch (e) { rec.error = e.message; }
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
    // Grid (DSS 7): internal header ints 4–9 = lower-left x/y, cells x/y, compression (26 =
    // zlib, 0 = none), compressed bytes; data (float32) at the record's data address.
    function decodeGrid(rec, s) {
      const ia = W(s + 13), I = (k) => dv.getInt32(ia * 8 + k * 4, true), da = W(s + 21);
      const g = { type: I(1), llx: I(4), lly: I(5), nx: I(6), ny: I(7), method: I(8), bytes: I(9), units: rec.units || '' };
      // units string follows the numeric part of the second header block
      const vb = W(s + 19), nv = W(s + 20);
      g.units = String.fromCharCode(...bytes.slice(vb * 8 + 64, vb * 8 + nv * 4)).replace(/[^!-~]+/g, ' ').trim().split(' ')[0] || '';
      g.decode = () => {
        const n = g.nx * g.ny, out = new Float32Array(n), raw = bytes.subarray(da * 8, da * 8 + g.bytes);
        const data = g.method === 26 ? inflate(raw) : g.method === 0 ? raw : null;
        if (!data) throw new Error(msg('unsupported', 'DSS grid compression', g.method));
        const f = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 0; i < n && i * 4 + 3 < data.length; i++) { const v = f.getFloat32(i * 4, true); out[i] = v < -1e37 ? NaN : v; }
        return out;
      };
      rec.grid = g;
    }
    // Paired data: int 0 = ordinates, int 1 = curves; values = all X then each curve's Y.
    function decodePaired(rec, s) {
      const ia = W(s + 13), va = W(s + 19), n = dv.getInt32(ia * 8, true), nc = dv.getInt32(ia * 8 + 4, true);
      const dbl = rec.type === 205, rd = (j) => dbl ? dv.getFloat64(va * 8 + j * 8, true) : dv.getFloat32(va * 8 + j * 4, true);
      if (!(n > 0 && n < 100000 && nc > 0)) return;
      rec.x = []; rec.curves = [];
      for (let i = 0; i < n; i++) rec.x.push(rd(i));
      // float columns are padded to whole 8-byte words
      const stride = dbl ? n : n + (n % 2);
      for (let c = 0; c < nc; c++) { const y = []; for (let i = 0; i < n; i++) y.push(rd(stride * (c + 1) + i)); rec.curves.push(y); }
    }
    return { records };
  }
  function dssPaired(dss, pathname) {
    const want = pathParts(pathname);
    const r = dss.records.find(r => r.x && ['A', 'B', 'C', 'D', 'E', 'F'].every(k => upEq(pathParts(r.path)[k], want[k])));
    return r ? { x: r.x, y: r.curves[0] } : null;
  }

  // DSS 6 (HEC-DSS 6, written by HEC-HMS 3.x and older): 4-byte words in 128-word physical
  // blocks whose last word is a control word; record addresses are 1-based logical word numbers
  // that skip those control words. A record's info block is: flag −9753, status (1 = live),
  // pathname length, pathname, then data address/length, record type, internal header address/length.
  function readDss6(dv, bytes) {
    const nPhys = Math.floor(dv.byteLength / 4), nLog = nPhys - Math.floor(nPhys / 128);
    const log = new Int32Array(nLog);
    for (let p = 0, l = 0; p < nPhys; p++) if (p % 128 !== 127) log[l++] = dv.getInt32(p * 4, true);
    const f32 = new Float32Array(log.buffer), lb = new Uint8Array(log.buffer);
    const f64 = (i) => new DataView(log.buffer).getFloat64(i * 4, true);
    const text = (i, n) => String.fromCharCode(...lb.slice(i * 4, (i + n) * 4)).replace(/[^\x21-\x7e]+/g, ' ').trim();
    const records = [];
    for (let f = 0; f < nLog - 30; f++) {
      if (log[f] !== -9753 || log[f + 1] !== 1) continue;
      const plen = log[f + 2];
      if (plen < 7 || plen > 400 || lb[(f + 3) * 4] !== 47) continue;
      const path = String.fromCharCode(...lb.slice((f + 3) * 4, (f + 3) * 4 + plen));
      const g = f + 3 + Math.ceil(plen / 4);
      const type = log[g + 14], dAddr = log[g + 2] - 1, dLen = log[g + 3], hAddr = log[g + 17] - 1, hLen = log[g + 18], cLen = log[g + 20];
      const rec = { path, type, dss6: true };
      try {
        if (dAddr < 0 || dAddr + dLen > nLog) throw new Error('bad address');
        if (type >= 100 && type < 110) {
          const dbl = type === 105 || type === 106;
          let n = dbl ? dLen / 2 : dLen, raw = null;
          if (cLen > 0) { raw = dss6Uncompress(lb.slice((log[g + 19] - 1) * 4, (log[g + 19] - 1 + cLen) * 4), lb.slice(dAddr * 4, (dAddr + dLen) * 4)); n = raw.length; }
          const words = text(hAddr + 1, Math.max(0, hLen - 1)).split(/\s+/);
          rec.units = words[0] || ''; rec.dataType = words[1] || '';
          rec.pattern = type === 101 || type === 106; rec.firstIndex = 0; rec.n = n;
          const vals = new Float64Array(n);
          for (let i = 0; i < n; i++) { const v = raw ? raw[i] : dbl ? f64(dAddr + 2 * i) : f32[dAddr + i]; vals[i] = v < -3e38 || v === -901 || v === -902 ? NaN : v; }
          rec.values = vals;
        } else if (type >= 400 && type < 450) {
          rec.grid = dss6Grid(log, lb, f32, hAddr, dAddr);
        } else if (type >= 200 && type < 210) {
          const nOrd = log[hAddr], nc = log[hAddr + 1], dbl = type === 205, rd = (i) => dbl ? f64(dAddr + 2 * i) : f32[dAddr + i];
          if (nOrd > 0 && nOrd < 100000 && nc > 0) {
            rec.x = []; rec.curves = [];
            for (let i = 0; i < nOrd; i++) rec.x.push(rd(i));
            for (let c = 0; c < nc; c++) { const y = []; for (let i = 0; i < nOrd; i++) y.push(rd(nOrd * (c + 1) + i)); rec.curves.push(y); }
          }
        }
      } catch (e) { rec.error = e.message; }
      records.push(rec);
      f = g + 20;
    }
    return { records, version: 6 };
  }

  // ---------- zlib inflate (RFC 1950/1951), used for DSS 7 grids ----------
  function inflate(src) {
    let pos = (src[0] & 0x0f) === 8 ? 2 : 0, bit = 0, bits = 0; // skip zlib header
    let out = new Uint8Array(Math.max(1024, src.length * 8)), n = 0;
    const need = (k) => { while (bits < k) { bit |= src[pos++] << bits; bits += 8; } };
    const get = (k) => { need(k); const v = bit & ((1 << k) - 1); bit >>>= k; bits -= k; return v; };
    const put = (b) => { if (n >= out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; } out[n++] = b; };
    const build = (lens) => { // canonical Huffman: count per length + symbols ordered by code
      const count = new Uint16Array(16), sym = new Uint16Array(lens.length), offs = new Uint16Array(16);
      for (const l of lens) count[l]++;
      count[0] = 0;
      for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
      lens.forEach((l, s) => { if (l) sym[offs[l]++] = s; });
      return { count, sym };
    };
    const decode = (h) => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= get(1); const c = h.count[len];
        if (code - c < first) return h.sym[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error('inflate: bad code');
    };
    const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258], LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577], DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    let fixed = null;
    for (let last = 0; !last;) {
      last = get(1);
      const type = get(2);
      if (type === 0) {
        bit = 0; bits = 0;
        const len = src[pos] | (src[pos + 1] << 8); pos += 4;
        for (let i = 0; i < len; i++) put(src[pos++]);
        continue;
      }
      let lit, dist;
      if (type === 1) {
        if (!fixed) { const l = []; for (let i = 0; i < 288; i++) l.push(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8); fixed = { lit: build(l), dist: build(new Array(30).fill(5)) }; }
        ({ lit, dist } = fixed);
      } else if (type === 2) {
        const hlit = get(5) + 257, hdist = get(5) + 1, hclen = get(4) + 4, ord = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15], cl = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) cl[ord[i]] = get(3);
        const ch = build(cl), lens = [];
        while (lens.length < hlit + hdist) {
          const s = decode(ch);
          if (s < 16) lens.push(s);
          else if (s === 16) { const p = lens[lens.length - 1], r = 3 + get(2); for (let i = 0; i < r; i++) lens.push(p); }
          else { const r = s === 17 ? 3 + get(3) : 11 + get(7); for (let i = 0; i < r; i++) lens.push(0); }
        }
        lit = build(lens.slice(0, hlit)); dist = build(lens.slice(hlit));
      } else throw new Error('inflate: bad block');
      for (;;) {
        const s = decode(lit);
        if (s < 256) put(s);
        else if (s === 256) break;
        else {
          const len = LB[s - 257] + get(LE[s - 257]), ds = decode(dist), d = DB[ds] + get(DE[ds]);
          for (let i = 0; i < len; i++) put(out[n - d]);
        }
      }
    }
    return out.subarray(0, n);
  }
  // ---------- gridded data ----------
  // DSS 6 grid record (HRAP / SHG / Albers): GridInfo header + data packed with HEC's 2-byte
  // run-length scheme (PRECIP_2_BYTE): flag 11 = n missing, 10 = n zeros, else value·scale.
  function dss6Grid(log, lb, f32, hAddr, dAddr) {
    const H = (k) => log[hAddr + k], F = (k) => f32[hAddr + k];
    const g = { type: H(1), llx: H(10), lly: H(11), nx: H(12), ny: H(13), cell: F(14), method: H(15), bytes: H(16), scale: F(17), base: F(18), max: F(19), min: F(20),
      units: String.fromCharCode(...lb.slice((hAddr + 6) * 4, (hAddr + 8) * 4)).replace(/[^\x21-\x7e]+/g, ' ').trim() };
    g.decode = () => {
      const n = g.nx * g.ny, out = new Float32Array(n);
      if (g.max === g.min && g.min < -9e37) { out.fill(NaN); return out; }
      if (g.method !== 101001) throw new Error(msg('unsupported', 'DSS grid compression', g.method));
      let k = 0;
      const put = (s) => {
        if (!(s & 0x8000)) { out[k++] = s / g.scale + g.base; return; }
        const c = s & 0x3fff;
        if ((s & 0xc000) === 0xc000) { for (let i = 0; i < c; i++) out[k++] = NaN; }
        else for (let i = 0; i < c; i++) out[k++] = 0;
      };
      const nShort = g.bytes / 2;
      for (let w = 0, done = 0; done < nShort; w++) { // shorts are word-swapped on disk
        const b = (dAddr + w) * 4, s0 = lb[b] | (lb[b + 1] << 8), s1 = lb[b + 2] | (lb[b + 3] << 8);
        put(s1); if (++done < nShort) { put(s0); done++; }
      }
      return out;
    };
    return g;
  }
  // .grid file (Grid Manager): grid name → DSS file and pathname
  function readGrids(text) {
    const out = {};
    for (const b of parseHms(text)) if (b.kind === 'Grid') out[b.name] = { file: b.props['Filename'], pathname: b.props['Pathname'], type: b.props['Grid Type'] };
    return out;
  }
  // Grid-cell file (File-Specified discretization): SUBBASIN: name / GRIDCELL: x y travelLength area
  function readCells(text) {
    const out = {}; let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*(SUBBASIN|GRIDCELL):\s*(.*)$/i.exec(raw);
      if (!m) continue;
      if (/subbasin/i.test(m[1])) { cur = out[m[2].trim()] = []; continue; }
      const [x, y, len, area] = m[2].trim().split(/\s+/).map(Number);
      if (cur) cur.push({ x, y, len, area });
    }
    return out;
  }
  const dssTime = (s) => { // "17JAN1996:0100" (24:00 allowed)
    const m = /^(\d{1,2})([A-Za-z]{3})(\d{4}):?(\d{2})(\d{2})$/.exec(String(s).trim());
    return m ? Date.UTC(+m[3], monthIndex(m[2]), +m[1], +m[4], +m[5]) : NaN;
  };
  // Gridded precipitation for a set of cells: per step, depth (grid units) of every cell,
  // summing grid records over the part of each record interval that falls in the step.
  function gridPrecip(grid, dss, cells, times) {
    const want = pathParts(grid.pathname);
    const recs = dss.records.filter(r => r.grid && ['A', 'B', 'C', 'F'].every(k => !want[k] || upEq(pathParts(r.path)[k], want[k])))
      .map(r => ({ r, t0: dssTime(pathParts(r.path).D), t1: dssTime(pathParts(r.path).E) })).filter(x => x.t1 > x.t0).sort((a, b) => a.t0 - b.t0);
    const out = cells.map(() => new Float64Array(times.length));
    let units = '';
    for (const { r, t0, t1 } of recs) {
      const i1 = times.findIndex(t => t > t0);
      if (i1 < 1) continue;
      const g = r.grid, data = g.decode(); units = g.units;
      const idx = cells.map(c => { const ix = c.x - g.llx, iy = c.y - g.lly; return ix >= 0 && iy >= 0 && ix < g.nx && iy < g.ny ? iy * g.nx + ix : -1; });
      for (let i = i1; i < times.length && times[i - 1] < t1; i++) {
        const ov = Math.min(t1, times[i]) - Math.max(t0, times[i - 1]);
        if (ov <= 0) continue;
        const f = ov / (t1 - t0);
        idx.forEach((k, c) => { const v = k >= 0 ? data[k] : NaN; if (!isNaN(v) && v > 0) out[c][i] += v * f; });
      }
    }
    return { depth: out, units };
  }
  // Modified Clark for one grid cell (HEC-HMS 4.13): linear reservoir on the cell's excess,
  // then a lag of round(travel/(maxTravel/Tc)·60) minutes through a ring buffer that
  // interpolates between intervals. Excess in mm per step, area km², result m³/s.
  function modClarkCell(excess, len, maxLen, tc, R, areaKm2, dtMin) {
    const lag = Math.floor(0.5 + len * 60 / (maxLen / tc)), dtH = dtMin / 60;
    const d = R / dtH < 0.5 ? 1 : 2 * dtH / (2 * R + dtH);
    const a = Math.floor(lag / dtMin) + 2, rem = lag % dtMin, buf = new Array(a).fill(0);
    let e = 0, f = 1, g = a - 1;
    const q = new Float64Array(excess.length);
    for (let i = 1; i < excess.length; i++) { // HEC-HMS steps from the first interval
      const inflow = excess[i] / dtMin * areaKm2 * 16.667;
      const routed = inflow * d + buf[g] * (1 - d);
      e = (e + 1) % a; f = (f + 1) % a; g = (g + 1) % a;
      buf[g] = routed;
      q[i] = Math.max(0, buf[e] + (buf[f] - buf[e]) * (dtMin - rem) / dtMin);
    }
    return q;
  }
  // DSS 6 time-series compression (heclib DUREAL): header byte 4 = method bits (1 repeat,
  // 2 delta, 4 significant digits), bytes 5–8 = value count, repeat bitmap from byte 33.
  function dss6Uncompress(hb, db) {
    const B = (k) => hb[k - 1], method = B(4), n = new DataView(hb.buffer, hb.byteOffset + 4, 4).getInt32(0, true);
    const repeat = method & 1, delta = method & 2;
    if (method & 4) throw new Error('DSS 6 significant-digit compression');
    const bit = (i) => (hb[32 + ((i - 1) >> 3)] >> ((i - 1) & 7)) & 1;
    let stored = n;
    if (repeat) { stored = 0; for (let i = 1; i <= n; i++) if (!bit(i)) stored++; }
    const v = new Float64Array(stored);
    if (delta) {
      const size = B(12), prec = Math.pow(10, B(13) - 10), base = new DataView(hb.buffer, hb.byteOffset + 15, 4).getFloat32(0, true), full = Math.pow(2, 8 * size) - 1;
      for (let i = 0; i < stored; i++) { let x = 0; for (let j = size - 1; j >= 0; j--) x = x * 256 + db[i * size + j]; v[i] = x === full ? -901 : base + x * prec; }
    } else { const f = new DataView(db.buffer, db.byteOffset, db.byteLength); for (let i = 0; i < stored; i++) v[i] = f.getFloat32(i * 4, true); }
    if (!repeat) return v;
    const out = new Float64Array(n);
    out[0] = v[0];
    for (let i = 2, c = 0; i <= n; i++) out[i - 1] = bit(i) ? out[i - 2] : v[++c];
    return out;
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
    const need = (g) => { if (!gages[g]) throw new Error(msg('noGage', g)); if (!gages[g].values) throw new Error(gages[g].error || msg('noGage', g)); return prepGage(gages[g]); };
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
    if (met.method === 'Weighted Gages') return weightedGages(met, sb, need, times);
    throw new Error(msg('unsupported', 'Precipitation Method', met.method));
  }
  // Weighted Gages (HEC-HMS 4.13): volume and temporal weights are each normalised to sum to 1.
  // Depth = Σ volume weight × gage depth over the run window (× subbasin index / gage index when
  // indexing is on; Total Precipitation replaces a recording gage's depth when depth override is
  // on). The pattern is Σ temporal weight × recording-gage increments, each gage scaled to that
  // depth — or, with the HEC-1 scheme, the weighted sum scaled to it as a whole.
  function weightedGages(met, sb, need, times) {
    const wg = met.weighted || {}, n = times.length, gi = met.gageInfo || {};
    const metric = /metric|si/i.test(met.header.props['Unit System'] || '');
    const incOf = (name) => {
      const g = need(name), f = unitFactor(g.units, metric), inc = new Float64Array(n);
      for (let i = 1; i < n; i++) inc[i] = (cumFraction(g, times[i]) - cumFraction(g, times[i - 1])) * f;
      return inc;
    };
    const rows = sb.weights || [];
    const vSum = rows.reduce((a, r) => a + (r.volume > 0 ? r.volume : 0), 0), tSum = rows.reduce((a, r) => a + (r.temporal > 0 ? r.temporal : 0), 0);
    if (!(vSum > 0) || !(tSum > 0)) throw new Error(msg('noWeights', sb.name));
    const useIndex = wg.index && sb.index > 0 && rows.every(r => gi[r.gage] && gi[r.gage].index > 0);
    const cache = {}, inc = (g) => cache[g] ||= incOf(g), sum = (a) => a.reduce((x, v) => x + v, 0);
    let depth = 0;
    for (const r of rows) {
      if (!(r.volume > 0)) continue;
      const info = gi[r.gage] || {};
      let d;
      if (/total storm/i.test(info.type || '')) { d = info.total; if (!(d >= 0)) throw new Error(msg('noGage', r.gage)); }
      else d = wg.override && info.total >= 0 ? info.total : sum(inc(r.gage));
      depth += r.volume / vSum * d * (useIndex ? sb.index / info.index : 1);
    }
    const p = new Float64Array(n);
    let hec1 = 0;
    for (const r of rows) {
      if (!(r.temporal > 0)) continue;
      if (/total storm/i.test((gi[r.gage] || {}).type || '')) throw new Error(msg('notRecording', r.gage));
      const a = inc(r.gage), tot = sum(a), w = r.temporal / tSum;
      if (!(tot > 0)) continue;
      if (wg.hec1) { for (let i = 0; i < n; i++) p[i] += a[i] * w; hec1 += tot * w; }
      else for (let i = 0; i < n; i++) p[i] += a[i] * depth / tot * w;
    }
    if (wg.hec1) { const f = hec1 > 0 ? depth / hec1 : 0; for (let i = 0; i < n; i++) p[i] *= f; }
    return p;
  }
  const unitFactor = (units, metric) => /^mm$/i.test(units || '') && !metric ? 1 / 25.4 : /^in/i.test(units || '') && metric ? 25.4 : 1;

  // ---------- loss ----------
  function lossMethod(p, prm, dtH, u) {
    const n = p.length, excess = new Float64Array(n), loss = new Float64Array(n);
    const imp = (prm.impervious || 0) / 100;
    if (prm.method === 'None' || !prm.method) { excess.set(p); return { excess, loss }; }
    if (prm.method === 'Initial+Constant' || prm.method === 'Initial Constant') {
      // HEC-HMS: in the interval where the initial loss runs out, the constant rate only acts on
      // the part of the interval after that point (fraction (P − IL)/P).
      const rate = prm.constantRate * dtH;
      let il = prm.initialLoss;
      for (let i = 0; i < n; i++) {
        const pv = p[i];
        let l;
        if (pv <= il) { l = pv; il -= pv; }
        else if (il > 0) { const f = (pv - il) / pv; l = pv - il < f * rate ? pv : il + f * rate; il = 0; }
        else l = Math.min(rate, pv);
        loss[i] = (1 - imp) * l;
        excess[i] = imp * pv + (1 - imp) * (pv - l);
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
  const step = (h, n) => Array.from({ length: n }, (_, i) => +(i * h).toFixed(6));
  // SCS dimensionless unit hydrographs used by HEC-HMS 4.13 (t/Tp, q/qp); step(h, n) = 0, h, …
  const SCS_UH = {
    STANDARD: { span: 5, x: [0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1,1.1,1.2,1.3,1.4,1.5,1.6,1.7,1.8,1.9,2,2.2,2.4,2.6,2.8,3,3.2,3.4,3.6,3.8,4,4.5,5], y: [0,0.03,0.1,0.19,0.31,0.47,0.66,0.82,0.93,0.99,1,0.99,0.93,0.86,0.78,0.68,0.56,0.46,0.39,0.33,0.28,0.207,0.147,0.107,0.077,0.055,0.04,0.029,0.021,0.015,0.011,0.005,0] },
    DELMARVA: { span: 10, x: step(0.2, 51), y: [0,0.111,0.356,0.655,0.896,1,0.929,0.828,0.737,0.656,0.584,0.521,0.465,0.415,0.371,0.331,0.296,0.265,0.237,0.212,0.19,0.17,0.153,0.138,0.123,0.109,0.097,0.086,0.076,0.066,0.057,0.049,0.041,0.033,0.027,0.024,0.021,0.018,0.015,0.013,0.012,0.011,0.009,0.008,0.008,0.006,0.006,0.005,0.005,0,0] },
    PRF100: { span: 24, x: step(0.2, 152), y: [0,0.8142,0.9228,0.9722,0.9941,1,0.9955,0.984,0.9675,0.9475,0.925,0.9007,0.8753,0.849,0.8223,0.7954,0.7685,0.7417,0.7153,0.6893,0.6637,0.6387,0.6143,0.5905,0.5674,0.5449,0.5231,0.5019,0.4815,0.4618,0.4427,0.4243,0.4065,0.3894,0.3729,0.3571,0.3418,0.3272,0.3131,0.2996,0.2866,0.2741,0.2621,0.2506,0.2396,0.229,0.2189,0.2092,0.1999,0.191,0.1825,0.1743,0.1665,0.159,0.1519,0.145,0.1385,0.1322,0.1262,0.1205,0.115,0.1098,0.1048,0.1,0.0954,0.091,0.0869,0.0829,0.0791,0.0754,0.072,0.0686,0.0655,0.0624,0.0596,0.0568,0.0542,0.0517,0.0493,0.047,0.0448,0.0427,0.0407,0.0388,0.037,0.0353,0.0336,0.0321,0.0306,0.0291,0.0278,0.0265,0.0252,0.024,0.0229,0.0218,0.0208,0.0198,0.0189,0.018,0.0172,0.0164,0.0156,0.0148,0.0141,0.0135,0.0128,0.0122,0.0117,0.0111,0.0106,0.0101,0.0096,0.0091,0.0087,0.0083,0.0079,0.0075,0.0072,0.0068,0.0065,0.0062,0.0059,0.0056,0.0054,0.0051,0.0049,0.0046,0.0044,0.0042,0.004,0.0038,0.0036,0.0035,0.0033,0.0031,0.003,0.0028,0.0027,0.0026,0.0025,0.0023,0.0022,0.0021,0.002,0.0019,0.0018,0.0017,0.0017,0.0016,0.0015,0] },
    PRF150: { span: 16, x: step(0.2, 129), y: [0,0.6869,0.8635,0.9499,0.9893,1,0.9918,0.971,0.9415,0.9062,0.8673,0.8262,0.784,0.7415,0.6994,0.6582,0.6181,0.5794,0.5422,0.5067,0.4729,0.4409,0.4106,0.382,0.3551,0.3298,0.3061,0.2839,0.2631,0.2438,0.2257,0.2088,0.1931,0.1786,0.165,0.1524,0.1407,0.1299,0.1199,0.1106,0.102,0.094,0.0866,0.0798,0.0735,0.0677,0.0623,0.0574,0.0528,0.0486,0.0447,0.0411,0.0378,0.0348,0.032,0.0294,0.027,0.0248,0.0228,0.0209,0.0192,0.0177,0.0162,0.0149,0.0137,0.0126,0.0115,0.0106,0.0097,0.0089,0.0082,0.0075,0.0069,0.0063,0.0058,0.0053,0.0049,0.0045,0.0041,0.0037,0.0034,0.0031,0.0029,0.0026,0.0024,0.0022,0.002,0.0019,0.0017,0.0016,0.0014,0.0013,0.0012,0.0011,0.001,0.0009,0.0008,0.0008,0.0007,0.0007,0.0006,0.0005,0.0005,0.0005,0.0004,0.0004,0.0004,0.0003,0.0003,0.0003,0.0002,0.0002,0.0002,0.0002,0.0002,0.0002,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0] },
    PRF200: { span: 10, x: step(0.2, 88), y: [0,0.5489,0.7911,0.9212,0.983,1,0.987,0.954,0.9082,0.8545,0.7966,0.7372,0.6779,0.6203,0.565,0.5128,0.4638,0.4183,0.3763,0.3377,0.3025,0.2704,0.2413,0.2151,0.1914,0.1701,0.151,0.1339,0.1186,0.105,0.0928,0.082,0.0724,0.0638,0.0563,0.0496,0.0437,0.0384,0.0338,0.0297,0.0261,0.0229,0.0201,0.0176,0.0155,0.0136,0.0119,0.0104,0.0091,0.008,0.007,0.0061,0.0054,0.0047,0.0041,0.0036,0.0031,0.0027,0.0024,0.0021,0.0018,0.0016,0.0014,0.0012,0.0011,0.0009,0.0008,0.0007,0.0006,0.0005,0.0005,0.0004,0.0004,0.0003,0.0003,0.0002,0.0002,0.0002,0.0002,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0] },
    PRF250: { span: 7.4, x: step(0.2, 65), y: [0,0.4142,0.7086,0.8863,0.9751,1,0.9809,0.9332,0.868,0.7937,0.7159,0.6388,0.5648,0.4957,0.4322,0.3747,0.3233,0.2778,0.2378,0.2028,0.1725,0.1463,0.1238,0.1045,0.088,0.074,0.0621,0.0521,0.0436,0.0364,0.0304,0.0253,0.0211,0.0175,0.0146,0.0121,0.01,0.0083,0.0069,0.0057,0.0047,0.0039,0.0032,0.0027,0.0022,0.0018,0.0015,0.0012,0.001,0.0008,0.0007,0.0006,0.0005,0.0004,0.0003,0.0003,0.0002,0.0002,0.0001,0.0001,0.0001,0.0001,0.0001,0.0001,0] },
    PRF300: { span: 6, x: step(0.2, 51), y: [0,0.2943,0.6201,0.8458,0.9656,1,0.9736,0.9085,0.8217,0.7257,0.629,0.5369,0.4527,0.3776,0.3122,0.2561,0.2087,0.1691,0.1363,0.1093,0.0873,0.0695,0.0551,0.0436,0.0343,0.027,0.0212,0.0166,0.0129,0.0101,0.0078,0.0061,0.0047,0.0037,0.0028,0.0022,0.0017,0.0013,0.001,0.0008,0.0006,0.0005,0.0003,0.0003,0.0002,0.0002,0.0001,0.0001,0.0001,0.0001,0] },
    PRF350: { span: 6, x: step(0.2, 42), y: [0,0.197,0.53,0.8006,0.9546,1,0.9651,0.8803,0.7703,0.6532,0.5402,0.4378,0.349,0.2743,0.2131,0.1638,0.1248,0.0944,0.0708,0.0529,0.0392,0.0289,0.0213,0.0156,0.0114,0.0082,0.006,0.0043,0.0031,0.0022,0.0016,0.0011,0.0008,0.0006,0.0004,0.0003,0.0002,0.0001,0.0001,0.0001,0.0001,0] },
    PRF400: { span: 5, x: step(0.1, 69), y: [0,0.027,0.1244,0.2732,0.4429,0.6081,0.7517,0.8642,0.9421,0.9863,1,0.988,0.9555,0.9076,0.8491,0.7839,0.7155,0.6465,0.579,0.5144,0.4538,0.3977,0.3465,0.3004,0.2591,0.2224,0.1902,0.162,0.1376,0.1164,0.0982,0.0826,0.0693,0.0579,0.0484,0.0403,0.0335,0.0278,0.023,0.019,0.0157,0.0129,0.0106,0.0087,0.0072,0.0059,0.0048,0.0039,0.0032,0.0026,0.0021,0.0017,0.0014,0.0011,0.0009,0.0007,0.0006,0.0005,0.0004,0.0003,0.0003,0.0002,0.0002,0.0001,0.0001,0.0001,0.0001,0.0001,0] },
    PRF450: { span: 4.6, x: step(0.1, 60), y: [0,0.011,0.0739,0.1975,0.3614,0.5371,0.7,0.8333,0.9282,0.9829,1,0.985,0.9447,0.8859,0.8151,0.7377,0.6581,0.5798,0.5051,0.4357,0.3725,0.3159,0.266,0.2224,0.1849,0.1528,0.1257,0.1029,0.0838,0.068,0.055,0.0443,0.0356,0.0285,0.0227,0.0181,0.0143,0.0114,0.009,0.0071,0.0056,0.0044,0.0034,0.0027,0.0021,0.0016,0.0013,0.001,0.0008,0.0006,0.0005,0.0004,0.0003,0.0002,0.0002,0.0001,0.0001,0.0001,0.0001,0] },
    PRF500: { span: 4, x: step(0.1, 53), y: [0,0.004,0.0414,0.1376,0.2881,0.4677,0.6466,0.8001,0.913,0.9791,1,0.9817,0.9328,0.8623,0.7788,0.6893,0.5996,0.5135,0.4338,0.3621,0.2989,0.2444,0.198,0.1591,0.1269,0.1006,0.0792,0.062,0.0482,0.0374,0.0288,0.0221,0.0169,0.0129,0.0098,0.0074,0.0056,0.0042,0.0031,0.0023,0.0017,0.0013,0.001,0.0007,0.0005,0.0004,0.0003,0.0002,0.0002,0.0001,0.0001,0.0001,0] },
    PRF550: { span: 3.6, x: step(0.1, 48), y: [0,0.0013,0.0218,0.0923,0.2242,0.4012,0.5922,0.7649,0.8964,0.975,1,0.9781,0.9198,0.837,0.7405,0.6396,0.5408,0.449,0.3666,0.2951,0.2344,0.184,0.1429,0.1099,0.0837,0.0633,0.0475,0.0354,0.0262,0.0193,0.0141,0.0103,0.0074,0.0054,0.0038,0.0027,0.002,0.0014,0.001,0.0007,0.0005,0.0003,0.0002,0.0002,0.0001,0.0001,0.0001,0] },
    PRF600: { span: 3.4, x: step(0.1, 44), y: [0,0.0004,0.0108,0.0596,0.1703,0.3392,0.5378,0.7282,0.8785,0.9704,1,0.9741,0.9058,0.8101,0.7008,0.5891,0.4831,0.3875,0.3049,0.2358,0.1795,0.1348,0.0999,0.0732,0.0531,0.0381,0.0271,0.0191,0.0134,0.0093,0.0064,0.0044,0.003,0.002,0.0014,0.0009,0.0006,0.0004,0.0003,0.0002,0.0001,0.0001,0.0001,0] },
  };
  // Natural cubic spline, same construction as Apache Commons SplineInterpolator.
  function naturalSpline(x, y) {
    const n = x.length - 1, h = [], mu = [0], z = [0], b = [], c = new Array(n + 1).fill(0), d = [];
    for (let i = 0; i < n; i++) h.push(x[i + 1] - x[i]);
    for (let i = 1; i < n; i++) {
      const g = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
      mu[i] = h[i] / g;
      z[i] = (3 * (y[i + 1] * h[i - 1] - y[i] * (x[i + 1] - x[i - 1]) + y[i - 1] * h[i]) / (h[i - 1] * h[i]) - h[i - 1] * z[i - 1]) / g;
    }
    for (let j = n - 1; j >= 0; j--) {
      c[j] = z[j] - mu[j] * c[j + 1];
      b[j] = (y[j + 1] - y[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3;
      d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
    }
    return (v) => {
      if (v < x[0] || v > x[n]) return NaN;
      let j = 0; while (j < n - 1 && v >= x[j + 1]) j++;
      const t = v - x[j];
      return y[j] + t * (b[j] + t * (c[j] + t * d[j]));
    };
  }
  // SCS UH as in HEC-HMS 4.13: Tp = Δt/2 + lag (≥ Δt), spline through the dimensionless curve,
  // ordinates at 0, Δt, 2Δt … up to its span, rescaled to exactly one unit of depth.
  function scsUH(lagMin, type, conv, dtH) {
    const t = SCS_UH[String(type || 'STANDARD').toUpperCase().replace(/[\s-]/g, '')] || SCS_UH.STANDARD;
    const tp = Math.max(dtH / 2 + lagMin / 60, dtH), n = Math.floor(t.span * tp / dtH + 2), f = naturalSpline(t.x, t.y), uh = [];
    for (let i = 0; i < n; i++) { const v = f(Math.min(i * dtH / tp, t.span)); uh.push(isNaN(v) ? 0 : v); }
    const sum = uh.reduce((a, v) => a + v, 0);
    return uh.map(v => v * conv / sum);
  }
  function transform(excess, area, prm, dtMin, u) {
    const dtH = dtMin / 60;
    if (prm.method === 'None' || !prm.method) return Float64Array.from(excess, e => e * u.depthAreaToFlow(area, dtH));
    if (prm.method === 'User-Specified UH') {
      if (!prm.uh) throw new Error(msg('noUH', prm.uhName));
      return convolve(excess, resampleUH(prm.uh.values, prm.uh.interval, dtMin));
    }
    if (prm.method === 'SCS') return convolve(excess, scsUH(prm.lag, prm.uhType, u.depthAreaToFlow(area, dtH), dtH));
    if (prm.method === 'Snyder') {
      if (prm.snyderMethod && !/^standard$/i.test(prm.snyderMethod)) throw new Error(msg('unsupported', 'Snyder Method', prm.snyderMethod));
      return convolve(excess, snyderUH(area, prm.tp, prm.cp, dtH, u));
    }
    if (prm.method === 'Clark') return convolve(excess, clarkUH(prm.tc, prm.storage, u.depthAreaToFlow(area, dtH), dtH));
    throw new Error(msg('unsupported', 'Transform', prm.method));
  }

  // ---------- evapotranspiration ----------
  // Monthly Evaporation (HEC-HMS): pan × coefficient for the month of the interval start,
  // spread evenly over the month's minutes.
  function petSeries(met, sub, times) {
    const n = times.length, pet = new Float64Array(n), sb = met.subbasins[sub];
    if (!met.et || /^no evapotranspiration$|^none$/i.test(met.et)) return pet;
    if (!/^monthly evaporation$/i.test(met.et)) throw new Error(msg('unsupported', 'Evapotranspiration Method', met.et));
    if (!sb || sb.pan.length < 12) throw new Error(msg('noMetSub', sub));
    const dtMin = (times[1] - times[0]) / 60000;
    for (let i = 1; i < n; i++) {
      const d = new Date(times[i - 1]), m = d.getUTCMonth(), y = d.getUTCFullYear();
      const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m];
      pet[i] = sb.pan[m] * (isNaN(sb.etCoef[m]) ? 1 : sb.etCoef[m]) * dtMin / (days * 1440);
    }
    return pet;
  }

  // ---------- soil moisture accounting ----------
  // HEC-HMS 4.13 SMA with Simple canopy and Simple surface (lumped subbasin), ported from the
  // model's own sub-stepping: each interval is split into sub-steps limited by canopy/surface
  // filling and emptying, soil drainage and groundwater routing (≥ 1 min), and every sub-step
  // runs canopy → surface/infiltration → plant uptake → soil percolation → GW1 → GW2 → soil
  // overflow back to the surface. Depths are handled in mm, as HEC-HMS does internally.
  function smaLoss(p, pet, sub, dtH, u) {
    const k = u.metric ? 1 : 25.4, s = sub.sma, cn = sub.canopy || {}, sf = sub.surface || {};
    const pc = (v) => (isNaN(v) ? 0 : v) / 100;
    const imp = pc(s.impervious);
    const canCap = /simple/i.test(cn.method || '') ? cn.capacity * k : 0, crop = /simple/i.test(cn.method || '') && !isNaN(cn.crop) ? cn.crop : 1;
    const allowSim = /^yes/i.test(cn.allowSim || '');
    const surfCap = /simple/i.test(sf.method || '') ? sf.capacity * k : 0;
    if (cn.method && !/^(none|simple)$/i.test(cn.method)) throw new Error(msg('unsupported', 'Canopy', cn.method));
    if (sf.method && !/^(none|simple)$/i.test(sf.method)) throw new Error(msg('unsupported', 'Surface', sf.method));
    const soilCap = s.soilCap * k, tension = s.tension * k, maxInf = s.maxInf * k, maxPerc = s.maxPerc * k;
    const gw = [1, 2].map(j => s.gw[j - 1]).filter(g => g && !isNaN(g.cap)).map(g => ({ cap: g.cap * k, route: g.route, perc: g.perc * k, st: pc(g.init) * g.cap * k }));
    let can = pc(cn.initPct) * canCap, surf = pc(sf.initPct) * surfCap, soil = pc(s.soilInit) * soilCap;
    const n = p.length;
    const out = { excess: new Float64Array(n), loss: new Float64Array(n), infil: new Float64Array(n), gwOut: gw.map(() => new Float64Array(n)), soil: new Float64Array(n), canopy: new Float64Array(n), surface: new Float64Array(n), et: new Float64Array(n) };
    const soilPercRate = () => soilCap > 0 ? (gw[0] && gw[0].cap > 0 ? maxPerc * Math.min(soil / soilCap, 1) * (1 - Math.min(gw[0].st / gw[0].cap, 1)) : maxPerc * Math.min(soil / soilCap, 1)) : maxInf;
    const gwPercRate = (i) => { // i = 0-based layer
      const g = gw[i], nx = gw[i + 1];
      if (i < gw.length - 1) return g.cap > 0 ? (nx.cap > 0 ? g.perc * Math.min(g.st / g.cap, 1) * (1 - Math.min(nx.st / nx.cap, 1)) : g.perc * Math.min(g.st / g.cap, 1)) : (i === 0 ? soilPercRate() : gwPercRate(i - 1));
      return g.cap > 0 ? g.perc * Math.min(g.st / g.cap, 1) : (i > 0 ? gwPercRate(i - 1) : soilPercRate());
    };
    const upFactor = () => { if (!(tension > 0)) return 1; const r = soil / tension; return r > 0.6 ? 1 : r > 0.5 ? 5 * r - 2 : r; };
    const record = (i) => { out.soil[i] = soil / k; out.canopy[i] = can / k; out.surface[i] = surf / k; };
    record(0);
    for (let i = 1; i < n; i++) {
      const P = p[i] * k, PET = pet[i] * k * crop, wet = P > 0, et = !wet || allowSim;
      const pRate = P / dtH, eRate = PET / dtH;
      let rem = dtH, exc = 0, inf = 0, etSum = 0;
      const gwSum = gw.map(() => 0);
      while (rem > 1e-12) {
        // sub-step length
        let lim = rem;
        if (eRate > 0 && can > 0.00254) lim = Math.min(lim, can / eRate);
        { // plant uptake limit
          let d = rem;
          if (soil > tension) { const x = soil - tension; if (x > 0.0254 && eRate > 0) d = x / eRate; }
          else if (soil > 0.6 * tension) { const x = soil - 0.6 * tension; if (x > 0.0254 && eRate > 0) d = x / (upFactor() * eRate); }
          else if (soil > 0.0254 && eRate > 0) d = soil / (upFactor() * eRate);
          lim = Math.min(lim, d, rem);
        }
        if (eRate + maxPerc > 0 && surf > 0.00254) lim = Math.min(lim, surf / (eRate + maxPerc));
        { const pr = soilPercRate(); if (soil - tension > 0) lim = Math.min(lim, (soil - tension) / pr, rem); }
        if (pRate > 0 && canCap - can > 0) lim = Math.min(lim, (canCap - can) / pRate);
        if (pRate > 0 && surfCap - surf > 0) lim = Math.min(lim, (surfCap - surf) / pRate);
        lim = Math.min(lim, rem);
        { // soil / groundwater limit
          let d5 = lim, dem = Math.max(0, eRate * lim - (can + surf)), st = soil;
          if (st > tension) st -= Math.min(soilPercRate() * lim, st - tension);
          if (tension > 0 && st - dem < tension) { if (st < 0.5 * tension) { if (dem > 0.05 * tension) d5 = lim / dem * (0.05 * tension); } else if (dem > 0.02 * tension) d5 = lim / dem * (0.02 * tension); }
          for (const g of gw) d5 = Math.min(g.route / 3, d5);
          lim = Math.min(lim, d5);
        }
        lim = Math.min(lim, dtH, 24, rem);
        if (lim < 1 / 60) lim = 1 / 60;
        if (rem - lim < 1 / 60) lim = rem;
        const dt = lim, Ps = pRate * dt, Es = eRate * dt;
        // canopy
        let through = 0, canET = 0, petLeft = 0;
        if (Ps > 0) { if (canCap > 0) can += Ps; else through = Ps; }
        if (et && Es > 0) { if (can > Es) { canET = Es; can -= Es; } else { canET = can; can = 0; petLeft = Es - canET; } }
        if (canCap > 0 && can > canCap) { through = can - canCap; can = canCap; }
        // surface + infiltration
        const infPot = (soilCap > 0 ? maxInf * (1 - soil / soilCap) : maxInf) * dt;
        const infiltrate = (w) => infPot > 0 ? Math.min(w, infPot) : 0;
        let surfET = 0, petSoil = 0, sExc = 0, sInf = 0;
        if (surfCap === 0) {
          sInf = infiltrate(through); sExc = Math.max(0, through - sInf);
          if (imp > 0) sExc = imp * through + (1 - imp) * sExc;
          petSoil = petLeft;
        } else {
          let st = surf;
          if (et) { if (petLeft > 0) { if (st > petLeft) { surfET = petLeft; st -= petLeft; petSoil = 0; } else { surfET = st; st = 0; petSoil = petLeft - surfET; } } }
          else petSoil = petLeft;
          let w = st + through;
          sInf = infiltrate(w); w -= sInf;
          if (w > 0) { if (w > surfCap) { sExc = w - surfCap; st = surfCap; } else st = w; } else st = 0;
          if (imp > 0) sExc = imp * through + (1 - imp) * sExc;
          surf = st;
        }
        // plant uptake from the soil
        let up = 0;
        if (et && soilCap > 0) {
          let need = petSoil, avail = soil;
          if (soil > tension) { const x = soil - tension; if (x > need) { up = need; avail -= up; need = 0; } else { up = x; avail -= x; need -= x; } }
          if (need > 0) { let y = upFactor() * need; if (y > avail) y = avail; up += y; }
          soil = Math.max(0, soil - up);
        }
        // soil percolation and groundwater
        const percPot = soilPercRate() * dt;
        let perc = 0;
        if (soilCap === 0) { perc = sInf; soil = 0; }
        else {
          soil += sInf;
          if (percPot > 0 && soil > tension) { perc = Math.min(soil - tension, percPot); soil -= perc; }
        }
        let flowIn = perc;
        gw.forEach((g, j) => {
          const pot = gwPercRate(j) * dt, r0 = g.st > 0 && g.route > 0 ? g.st / g.route : 0;
          const r1 = g.route > 0 ? (flowIn + g.st - pot - r0 * 0.5 * dt) / (g.route + 0.5 * dt) : 0;
          let o, pe;
          if (pot > 0) {
            if (r1 < 0) { const f = (flowIn + g.st) / (pot + r0 * 0.5 * dt); o = f * r0 * 0.5 * dt; pe = f * pot; g.st = 0; }
            else { o = 0.5 * dt * (r0 + r1); pe = pot; g.st += flowIn - pe - o; }
          } else if (r1 < 0) { const f = (flowIn + g.st) / (r0 * 0.5 * dt); o = f * r0 * 0.5 * dt; pe = 0; g.st = 0; }
          else { o = 0.5 * dt * (r0 + r1); pe = 0; g.st += flowIn - o; }
          gwSum[j] += o;
          flowIn = pe;
        });
        // soil above capacity returns to the surface
        let back = 0;
        if (soil >= soilCap && soilCap > 0) { back = soil - soilCap; soil -= back; sInf -= back; }
        if (back > 0) {
          if (surfCap === 0) sExc += imp > 0 ? (1 - imp) * back : back;
          else { const room = surfCap - surf; if (room > back) surf += back; else { surf = surfCap; sExc += imp > 0 ? (1 - imp) * (back - room) : back - room; } }
        }
        exc += sExc; inf += sInf; etSum += canET + surfET + up;
        rem -= dt;
      }
      out.excess[i] = exc / k; out.infil[i] = inf / k; out.et[i] = etSum / k; out.loss[i] = Math.max(0, p[i] - exc / k);
      gw.forEach((g, j) => { out.gwOut[j][i] = gwSum[j] / k; });
      record(i);
    }
    return out;
  }
  // Deficit and constant (HEC-HMS 4.13, Canopy/Surface None): infiltration first fills the
  // moisture deficit, then continues at the percolation rate (with the partial-interval split
  // HMS uses when the deficit fills mid-step); water beyond the deficit percolates. Canopy None
  // has no plant uptake, so the deficit only shrinks. Sub-steps: time to drain the soil water
  // (max deficit − deficit) at the percolation rate, at least one minute.
  function deficitLoss(p, prm, dtH, u) {
    const k = u.metric ? 1 : 25.4, maxDef = prm.maxDeficit * k, rate = prm.constantRate * k, imp = (prm.impervious || 0) / 100;
    let def = isNaN(prm.initialDeficit) ? maxDef : Math.min(Math.max(prm.initialDeficit * k, 0), maxDef);
    const n = p.length, excess = new Float64Array(n), loss = new Float64Array(n), deficit = new Float64Array(n);
    deficit[0] = def / k;
    for (let i = 1; i < n; i++) {
      const pRate = p[i] * k / dtH;
      let rem = dtH, exc = 0;
      while (rem > 1e-12) {
        let lim = rem;
        const g = maxDef - def;
        if (g > 0 && rate > 0) lim = Math.min(g / rate, rem);
        lim = Math.min(lim, dtH, 24, rem);
        if (lim < 1 / 60) lim = 1 / 60;
        if (rem - lim < 1 / 60) lim = rem;
        const w = pRate * lim, cap = rate * lim;
        let inf;
        if (w <= def) inf = w;
        else if (def > 0) { const f = (w - def) / w; inf = w - def < f * cap ? w : def + f * cap; }
        else inf = Math.min(cap, w);
        def = inf > def ? 0 : def - inf;
        let e = w - inf;
        if (imp > 0) e = imp * w + (1 - imp) * e;
        exc += e; rem -= lim;
      }
      excess[i] = exc / k; loss[i] = p[i] - excess[i]; deficit[i] = def / k;
    }
    return { excess, loss, deficit };
  }
  // Linear reservoir baseflow fed by the SMA groundwater outflows (HEC-HMS: trapezoidal
  // routing of each layer's outflow volume through its cascade of reservoirs).
  function linearReservoir(gwOut, area, prm, dtH, u, imp) {
    const n = gwOut[0] ? gwOut[0].length : 0, base = new Float64Array(n), dt = dtH * 3600;
    const km2 = u.metric ? area : area * 2.589988110336, toProj = u.metric ? 1 : 1 / 0.028316846592, depthM = u.metric ? 1 / 1000 : 0.0254;
    prm.layers.forEach((L, j) => {
      if (!gwOut[j]) return;
      const K = Math.max(L.route, 0.5 * dtH) * 3600, nr = Math.max(1, Math.round(L.reservoirs || 1));
      const q0 = (!isNaN(L.initial) ? L.initial : (L.initialRatio || 0) * area) / toProj, q = new Array(nr).fill(q0);
      const a = 2 / (2 * K + dt), b = (2 * K - dt) / (2 * K + dt), c = dt / K / (2 + dt / K), d = (2 - dt / K) / (2 + dt / K);
      base[0] += q[nr - 1] * toProj;
      for (let i = 1; i < n; i++) {
        const V = gwOut[j][i] * depthM * km2 * 1e6 * (1 - (imp || 0) / 100);
        let prevUp = q[0];
        q[0] = a * V + b * q[0];
        for (let r = 1; r < nr; r++) { const old = q[r]; q[r] = c * prevUp + c * q[r - 1] + d * old; prevUp = old; }
        base[i] += q[nr - 1] * toProj;
      }
    });
    return base;
  }

  // ---------- baseflow ----------
  // Recession as in HEC-HMS 4.13: baseflow decays by k^(Δt/1 day); once the total flow falls
  // below the threshold (ratio × running peak, or a fixed flow) the total follows the recession
  // curve from the previous total, with a partial step on the crossing interval.
  function baseflow(direct, area, prm, dtH) {
    const n = direct.length;
    if (prm.method !== 'Recession') return { total: Float64Array.from(direct), base: new Float64Array(n) };
    const k = Math.pow(prm.recession, dtH / 24), ratio = isNaN(prm.thresholdFlow) ? prm.thresholdRatio : NaN;
    const q0 = !isNaN(prm.initialDischarge) ? prm.initialDischarge : (prm.initialPerArea || 0) * area;
    const total = new Float64Array(n), base = new Float64Array(n);
    let b = q0, peak = q0;
    base[0] = b; total[0] = direct[0] + b;
    for (let i = 1; i < n; i++) {
      const d = direct[i], prev = total[i - 1];
      let bn = b * k, q = bn + d, thr = isNaN(prm.thresholdFlow) ? 0 : prm.thresholdFlow;
      if (ratio > 0) { if (d <= 0) peak = 0; peak = Math.max(peak, q); thr = ratio * peak; }
      if (q < thr) {
        if (prev <= thr) thr = prev * k;
        else thr *= Math.pow(k, 1 - (prev - q > 1e-4 ? (prev - thr) / (prev - q) : 1));
        if (q < thr) { q = thr; bn = thr - d; }
      }
      b = bn; base[i] = bn; total[i] = q;
    }
    return { total, base };
  }

  // ---------- routing ----------
  function route(inflow, prm, dtMin, pdata, name) {
    const dtH = dtMin / 60;
    if (prm.method === 'Modified Puls') {
      // HEC-HMS: every subreach holds 1/n of the reach storage; each step solves
      // S2/(nΔt) + O2/2 = S1/(nΔt) − O1/2 + (I1 + I2)/2 on the storage-outflow table.
      const t = pdata && pdata[tableKey('Storage-Outflow', prm.table)];
      if (!t) throw new Error(msg('noTable', 'Storage-Outflow', prm.table, name));
      if (t.error) throw new Error(t.error);
      const n = Math.max(1, Math.round(prm.subreaches || 1)), sf = STORAGE_UNIT[(t.xUnits || '').toUpperCase()] || 1, dt = dtMin * 60;
      const Q = t.y, ind = t.x.map((v, i) => v * sf / (n * dt) + 0.5 * Q[i]);
      const qOf = (v) => { if (v < ind[0] || v > ind[ind.length - 1]) throw new Error(msg('outOfTable', prm.table, name)); return lerp(v, ind, Q); };
      const out = new Float64Array(inflow.length), o = new Array(n).fill(/specified/i.test(prm.initial || '') && !isNaN(prm.initialOutflow) ? prm.initialOutflow : inflow[0]);
      out[0] = o[n - 1];
      for (let i = 1; i < inflow.length; i++) {
        let i1 = inflow[i - 1], i2 = inflow[i];
        for (let k = 0; k < n; k++) {
          const o1 = o[k], rhs = Math.max(0, lerp(o1, Q, ind) - o1 + 0.5 * (i1 + i2));
          o[k] = Math.max(0, qOf(rhs));
          i1 = o1; i2 = o[k];
        }
        out[i] = o[n - 1];
      }
      return out;
    }
    if (prm.method === 'Muskingum') { // like HEC-HMS, negative outflow is not clipped
      const n = Math.max(1, Math.round(prm.steps || 1)), K = prm.K / n, X = prm.X;
      const d = 2 * K * (1 - X) + dtH;
      const c0 = (dtH - 2 * K * X) / d, c1 = (dtH + 2 * K * X) / d, c2 = (2 * K * (1 - X) - dtH) / d;
      let I = inflow;
      for (let s = 0; s < n; s++) { const O = new Float64Array(I.length); O[0] = I[0]; for (let i = 1; i < I.length; i++) O[i] = c0 * I[i] + c1 * I[i - 1] + c2 * O[i - 1]; I = O; }
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
      tailwater: [p['Main Tailwater Condition'], p['Auxiliary Tailwater Condition']], tailwaterGage: p['Main Tailwater Stage Gage Name'], evaporation: p['Evaporation Method'], structures,
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
  // ---------- culvert (HEC-HMS 4.13 / FHWA HY-8 routine, US units inside) ----------
  // Line-by-line port of HEC-HMS's culvert solver: the discharge is found by secant/bisection
  // on headwater(Q) = pool, where headwater(Q) is the larger of inlet control (FHWA chart/scale
  // equations) and outlet control (full-flow losses or a direct-step profile in the barrel).
  // Box and circular barrels are supported. State that HEC-HMS keeps in static fields
  // (previous friction slope / energy in the profile) is kept per culvert here.
  const CULVERT_COEF = [[[1,0.0098,2,0.0398,0.67,-0.5],[1,0.0078,2,0.0379,0.69,-0.5],[1,0.0018,2.5,0.03,0.74,-0.5],[1,0.026,1,0.0347,0.86,-0.5],[0,0.51,0.667,0.0309,0.8,0],[0,0.515,0.667,0.0375,0.79,0],[0,0.545,0.667,0.04505,0.68,0],[0,0.497,0.667,0.0339,0.803,0],[0,0.497,0.667,0.0302,0.835,0],[1,0.0083,2,0.0379,0.69,-0.5],[1,0.01,2,0.0398,0.67,-0.5],[1,0.01,2,0.0398,0.67,-0.5],[1,0.0083,2,0.0379,0.69,-0.5],[1,0.03,1.5,0.0496,0.57,-0.5],[1,0.03,1.5,0.0496,0.57,-0.5],[1,0.0083,2,0.0379,0.69,-0.5],[0,0.534,0.555,0.0196,0.9,0],[0,0.536,0.622,0.0368,0.83,0],[0,0.475,0.667,0.0179,0.97,0],[0,0.56,0.667,0.0466,0.85,0],[0,0.5,0.667,0.0466,0.65,0],[0,0.475,0.667,0.043,0.543,-0.5],[0,0.446,0.667,0.027,0.676,-0.5]],[[1,0.0078,2,0.0292,0.74,-0.5],[1,0.021,1.33,0.0463,0.75,0.7],[1,0.0018,2.5,0.0243,0.83,-0.5],[1,0.061,0.75,0.04,0.8,-0.5],[0,0.486,0.667,0.0249,0.83,0],[0,0.495,0.667,0.0314,0.82,0],[0,0.533,0.667,0.0425,0.705,0],[0,0.493,0.667,0.0361,0.806,0],[0,0.495,0.667,0.0252,0.881,0],[1,0.0145,1.75,0.0419,0.64,-0.5],[1,0.0018,2.5,0.0292,0.74,-0.5],[1,0.0018,2.5,0.0292,0.74,-0.5],[1,0.03,1,0.0463,0.75,0.7],[1,0.0088,2,0.0368,0.68,-0.5],[1,0.0088,2,0.0368,0.68,-0.5],[1,0.03,1,0.0463,0.75,0.7],[0,0.519,0.64,0.021,0.9,0],[0,0.5035,0.719,0.0478,0.8,0],[0,0,0,0,0,0],[0,0.56,0.667,0.0378,0.87,0],[0,0.5,0.667,0.0378,0.71,0],[0,0.5,0.667,0.039,0.67,-0.5],[0,0.455,0.667,0.035,0.595,-0.5]],[[1,0.0045,2,0.0317,0.69,-0.5],[1,0.034,1.5,0.0553,0.54,-0.5],[0,0,0,0,0,0],[1,0.061,0.75,0.0423,0.82,-0.5],[0,0,0,0,0,0],[0,0.486,0.667,0.0252,0.865,0],[0,0.522,0.667,0.0402,0.73,0],[0,0.495,0.667,0.0386,0.71,0],[0,0.493,0.667,0.0227,0.897,0],[1,0.034,1.5,0.0496,0.57,-0.5],[1,0.0045,2,0.0317,0.69,-0.5],[1,0.0095,2,0.0317,0.69,-0.5],[1,0.034,1.5,0.0496,0.57,-0.5],[1,0.003,2,0.0269,0.77,-0.5],[1,0.003,2,0.0269,0.77,0.7],[1,0.034,1.5,0.0496,0.57,-0.5],[0,0,0,0,0,0],[0,0.547,0.8,0.0598,0.75,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0.511,0.667,0.039,0.729,-0.5],[0,0.468,0.667,0.037,0.566,-0.5]],[[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0.498,0.667,0.0327,0.75,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0]]]; // [scale][chart] → [form, K, M, c, Y, Ks]
  const BIG = 3.4e38;
  function culvertSolver(par) {
    const ref = (v) => ({ v });
    const N = { a: {}, b: par.n, c: par.n, d: 0, e: 0, f: par.ke, g: par.kx, h: par.rise, j: par.span, k: par.length, l: par.inletInv, m: par.outletInv,
      s: 0.001, w: par.shape, y: par.barrels, z: par.chart, A: par.scale, B: 30, C: par.control, G: false, H: false };
    { // inlet coefficients (u.a)
      let sc = N.A, ch = N.z, c5 = ch;
      if (ch >= 70) c5 -= 48; else if (ch >= 55) c5 -= 38; else if (ch >= 41) { c5 = 16; if (ch === 52) { if (sc === 1) sc = 2; if (sc === 2) sc = 3; if (sc >= 3) sc = 1; } }
      else if (ch >= 34) c5 -= 21; else if (ch >= 29) c5 -= 18; else if (ch >= 16) c5 = 10; else if (ch >= 8) c5 -= 4;
      const row = ((CULVERT_COEF[sc - 1] || [])[c5 - 1]);
      if (!row) throw new Error('culvert chart/scale');
      N.F = row[0] === 1; N.a = { a: row[1], b: row[2], d: row[3], e: row[4], c: row[5] };
    }
    const st = { pA: 0, pB: 0, rA: 0, rB: 0 }; // static state of p.a / r.a
    const H = () => ({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, i: 0, j: 0, k: 0 });
    const hP = H(), hE = H(), hI = H(), hN = H(); // reused scratch sections (these helpers never nest)
    // --- geometry (d_0 / h_0) ---
    function geom(h, n) {
      let area = 0, top = 0, R = 0, K = 0, cen = 0, hi = h.i;
      const y = h.a;
      if (n.w === 2) { // box (h_0.c)
        if (y <= 0) { area = 0; top = n.j; R = 0; K = 0; cen = 0; hi = h.i; }
        else {
          let d6, wp;
          if (y >= n.h) { d6 = n.h; wp = 2 * d6 + 2 * n.j; } else { d6 = y; wp = 2 * d6 + n.j; }
          top = n.j; area = d6 * n.j; R = area / wp; K = 1.48592 / n.b * area * Math.pow(R, 2 / 3); cen = d6 / 2; hi = n.j;
        }
      } else if (n.w === 1) { // circular (h_0.a with bl2 = false)
        const D = n.h, r = D * 0.5;
        if (y <= 0) { area = 0; top = 0; R = 0; cen = 0; K = 0; }
        else {
          const d7 = y > D ? D : y, th = Math.asin((d7 - r) / r), ang = 3.141593 + 2 * th, wp = ang * r;
          top = 2 * r * Math.cos(th); area = 0.5 * ang * r * r + 0.5 * top * (d7 - r);
          if (y <= D) cen = r - Math.pow(top, 3) / (12 * area); else cen = r;
          R = area / wp; K = 1.48592 / n.b * area * Math.pow(R, 2 / 3);
          hi = d7 < r ? top : D;
        }
      } else throw new Error('culvert shape ' + n.w);
      h.b = area; h.h = top; h.g = R; h.c = K; h.i = hi;
      return y - cen;
    }
    function sect(depth, Q, n, h) { // c_0 (G, H false) → d_0
      if (depth <= 0) { Object.assign(h, { b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, j: 0, i: 0 }); return; }
      h.k = n.b; h.a = depth;
      const zc = geom(h, n);
      if (h.b > 0) { h.d = Q / h.b; h.j = Q * Q / (32.174 * h.b) + zc * h.b; if (h.a > 0) h.i = h.b / h.a; } else { h.d = 0; h.j = 0; }
      h.e = h.d * h.d / 64.348; h.f = h.a + h.e;
    }
    // --- critical depth (i / j / w) ---
    function wGuess(n) { const d = n.i; if (n.w === 2) return d - 0.01; if (n.w === 1) return 0.938 * d; if (n.w === 3) return 0.9 * d; if (n.w === 6) return 0.927 * d; return 0.93 * d; }
    function critical(Q, n, D) {
      if (D.g) return;
      const g = 32.174, tol = 0.01, h = H();
      let yc;
      if (n.w === 2) { yc = Math.pow(Q * Q / (n.j * n.j * g), 1 / 3); }
      else {
        let full = false, ymax = wGuess(n); yc = ymax;
        sect(yc, Q, n, h);
        const q2g = Q * Q / 32.174;
        if (q2g * 1.01 > Math.pow(h.b, 3) / h.h) { full = true; yc = n.i; }
        else if (n.w === 1 || n.w === 3 || n.w <= 8 && n.w !== 4 && n.w !== 5) yc = 1.01 / Math.pow(n.i, 0.26) * Math.pow(q2g, 0.25);
        else yc = 0.84 * Math.pow(n.j, 0.22) * Math.pow(q2g, 0.25);
        if (!full) {
          const d6 = Q * Q / g; let dx = 0.001, it = 0, ok = false, stop = false;
          if (yc < n.i) {
            let over = 0;
            while (!stop) {
              ++it;
              const y0 = yc; sect(yc + dx, Q, n, h); const A1 = h.b, T1 = h.h; sect(yc, Q, n, h); const A0 = h.b, T0 = h.h;
              const dA = (A1 - A0) / dx, dT = (T1 - T0) / dx, f = Math.pow(A0, 3) - d6 * T0, fp = 3 * A0 * A0 * dA - d6 * dT;
              yc = y0 - f / fp;
              if (yc < 0.01) stop = true;
              if (yc > ymax) { if (++over > 2) stop = true; yc = ymax; }
              else if (Math.abs(yc - y0) <= tol) { ok = true; stop = true; }
              if (it >= 10) stop = true;
            }
          }
          if (!ok) {
            stop = false; it = 0; yc = n.i / 2; let step = yc;
            sect(yc, Q, n, h); let f = d6 - Math.pow(h.b, 3) / h.h;
            while (!stop) {
              if (step > tol && ++it < 30) { step /= 2; yc += f < 0 ? -step : step; sect(yc, Q, n, h); f = d6 - Math.pow(h.b, 3) / h.h; continue; }
              stop = true; if (step < tol) ok = true;
            }
          }
          if (!ok) yc = n.i;
        }
      }
      yc = Math.min(yc, n.i);
      sect(yc, Q, n, h);
      D.e = h.e; D.d = yc; D.b = yc + D.a; D.c = D.b + D.e; D.f = yc + D.e; D.g = true;
    }
    // --- normal depth (n / m) ---
    function normalInit(n, l) {
      const h = H(); let y = wGuess(n), full = false;
      sect(y, l.a, n, h);
      const cap = 1.48592 * h.b * Math.pow(h.g, 2 / 3) * Math.sqrt(l.b) / h.k;
      if (l.a > cap) { full = true; y = n.i; }
      l.o = y;
      return { y, full };
    }
    function normalDepth(n, l) {
      if (l.b < 1e-6) { l.g = BIG; return; }
      if (l.g < 3e38) return;
      const h = hN, c = l.a / (1.48592 * Math.sqrt(l.b));
      let { y, full } = normalInit(n, l), d = y, it = 0;
      while (!full) {
        sect(y, l.a, n, h);
        const f = c * h.k - h.b * Math.pow(h.g, 2 / 3);
        if (f === 0) d = 0; else { d /= 2; d = Math.abs(d) * f / Math.abs(f); }
        y += d; ++it;
        if (Math.abs(d) < 0.005) full = true;
        if (it > 30) full = true;
      }
      l.g = y;
    }
    // --- profile helpers (p / r) ---
    function pStep(y, n, l) { // p.a → distance increment for depth step
      const h = hP; sect(y, l.a, n, h);
      const sf = Math.pow(h.k * h.d, 2) / (2.207955 * Math.pow(h.g, 4 / 3)), E = h.a + h.e, dE = st.pB - E, sAvg = (sf + st.pA) / 2;
      let dx = l.b - sAvg === 0 ? 0 : dE / (l.b - sAvg);
      if (!l.z) dx = -dx;
      st.pA = sf; st.pB = E;
      return dx;
    }
    function rStore(n, l, p, x, y, c, interp) { // r.a: stores depths at the 16 profile stations
      let d5, d4, n3;
      if (c.v === 0) { st.rA = 3.1e38; return; }
      let done = true; const n4 = c.v;
      if (l.z) {
        if (c.v >= 15) return;
        n3 = 1; if (x >= p.b[c.v]) done = false; d5 = x;
        if (!done && (st.rA < p.b[n4 - 1] || st.rA >= d5)) { st.rA = p.b[n4 - 1]; st.rB = l.n[n4 - 1]; }
      } else {
        if (c.v <= 2) return;
        n3 = -1; d4 = n.k - x; if (d4 <= p.b[c.v - 2]) done = false; d5 = d4;
        if (!done && (st.rA > p.b[n4 - 1] || st.rA <= d5)) { st.rA = p.b[n4 - 1]; st.rB = l.n[n4 - 1]; }
      }
      while (!done) {
        if (interp) { const x2 = st.rA, x3 = d5, x4 = p.b[c.v + n3 - 1]; l.n[c.v + n3 - 1] = x3 !== x2 ? (x3 - x4) * (y - st.rB) / (x2 - x3) + y : (st.rB + y) / 2; }
        else l.n[c.v + n3 - 1] = y;
        l.n[c.v - 1] = Math.min(l.n[c.v - 1], n.i);
        c.v += n3;
        if (l.z) { if (x < p.b[c.v]) done = true; } else { d4 = n.k - x; if (d4 > p.b[c.v - 2]) done = true; }
        if (c.v + n3 < 16 && c.v + n3 > 1) continue;
        done = true;
      }
      st.rA = d5; st.rB = y;
    }
    function fullLosses(t, len, n, l, h) { // b_0.a
      sect(n.i, l.a, n, h);
      const kf = 29.167257 * len / Math.pow(h.g, 4 / 3);
      l.h = kf * h.k * h.k * h.e; l.i = n.f * h.e;
      l.j = h.e > t.h ? n.g * Math.abs(h.e - t.h) : 0;
      if (h.f + n.q - l.j > t.d) l.j = h.f + n.q - t.d;
    }
    // --- outlet depth (y / v / i_0) ---
    function exitEnergy(t, n, l, y, lo, hi) { // i_0.a
      const h = hE;
      if (l.z) { sect(y - n.q, l.a, n, h); const d4 = h.e > t.h ? n.g * (h.e - t.h) : 0; lo.v = t.d + d4 - h.e; hi.v = t.d + d4; }
      else { sect(y - n.p, l.a, n, h); const d6 = n.f * h.e; lo.v = t.e - d6 - h.e; hi.v = t.e - d6; }
    }
    function outletStart(t, n, l, D, done, out) { // v.a
      const lo = ref(0), hi = ref(0), h = H();
      out.v = 0;
      const tw = t.f, inv = n.q, top = inv + n.i;
      critical(l.a, n, D);
      if (D.d >= n.i) { done.v = true; l.w = true; l.v = true; l.e = n.i; return; }
      if (n.g >= 1) {
        done.v = true;
        if (tw >= top) { l.w = true; l.v = true; l.e = n.i; return; }
        critical(l.a, n, D);
        l.e = tw >= D.b ? tw - inv : D.d;
        sect(l.e, l.a, n, h);
        const e = l.e + h.e + n.q;
        if (e < t.d) { done.v = false; out.v = Math.min((e + t.d) / 2, n.q + n.i); }
        return;
      }
      exitEnergy(t, n, l, top, lo, hi);
      if (lo.v + 0.1 >= top) { l.w = true; l.v = true; l.e = n.i; done.v = true; return; }
      critical(l.a, n, D);
      exitEnergy(t, n, l, D.b, lo, hi);
      if (lo.v <= D.b) { l.e = D.d; done.v = true; return; }
      const b4 = Math.min(tw, top);
      out.v = D.b + 0.7 * (b4 - D.b);
    }
    function outletDepth(t, n, l, D) { // y.a
      const done = ref(false), y = ref(0), lo = ref(0), hi = ref(0);
      outletStart(t, n, l, D, done, y);
      if (!done.v) {
        exitEnergy(t, n, l, y.v, lo, hi);
        let best = Math.abs(y.v - lo.v), bestY = lo.v, it = 0;
        while (!done.v) {
          ++it;
          y.v = Math.max(lo.v, D.b);
          exitEnergy(t, n, l, y.v, lo, hi);
          const e = Math.abs(y.v - lo.v);
          if (e < best) { best = e; bestY = lo.v; }
          if (best <= n.s) done.v = true;
          if (it >= 15) done.v = true;
        }
        if (bestY > n.q + n.i) { l.w = true; l.v = true; }
        if (bestY < D.b) bestY = D.b;
        l.e = bestY - n.q;
      }
      const h = H();
      sect(l.e, l.a, n, h);
      l.j = h.e > t.h ? n.g * Math.abs(h.e - t.h) : 0;
      if (h.f + n.q - l.j > t.d) l.j = h.f + n.q - t.d;
      if (!l.w && l.e >= n.i) { l.w = true; l.v = true; }
    }
    // --- profile start (s.a) ---
    function profileStart(n, l, p, D, x, y, dy, dyFirst, c, crit, done) {
      let dir = 0; const h = H(), tmp = ref(0);
      x.v = 0; dyFirst.v = 0; c.v = 0; crit.v = false;
      rStore(n, l, p, x.v, n.i, c, false);
      if (l.z) { c.v = 1; l.n[0] = l.e; } else { c.v = 16; l.n[15] = l.f; }
      critical(l.a, n, D);
      normalDepth(n, l);
      if (l.z) {
        y.v = l.e;
        if (l.x) {
          const r = normalInit(n, l); dyFirst.v = n.i - r.y; dir = -1; x.v = l.k;
          rStore(n, l, p, x.v, n.i, c, false);
        } else if (l.e <= D.d && l.g <= D.d) { l.f = D.d; done.v = true; rStore(n, l, p, n.k, D.d, c, false); l.n[15] = D.d; }
        else if (Math.abs(l.e - l.g) < n.s && l.g < n.i) { l.f = l.g; done.v = true; rStore(n, l, p, n.k, l.g, c, false); l.n[15] = l.g; }
        else if (l.e > l.g) {
          dir = -1;
          if (y.v > l.o) { sect(y.v, l.a, n, h); const sf = Math.pow(h.k * h.d, 2) / (2.207955 * Math.pow(h.g, 4 / 3)); if (sf > l.b) { dir = 1; crit.v = true; } }
        } else if (l.e < l.g) dir = 1;
      } else {
        if (l.B) {
          y.v = l.l;
          if (l.m >= n.k) { l.e = l.l; done.v = true; rStore(n, l, p, n.k, D.d, c, false); l.n[0] = D.d; return; }
          x.v += l.m; rStore(n, l, p, x.v, y.v, c, true);
        } else y.v = l.f;
        if (y.v >= D.d && l.g >= D.d) { l.e = D.d; done.v = true; rStore(n, l, p, n.k, D.d, c, false); l.n[0] = D.d; }
        else if (Math.abs(y.v - l.g) < n.s) { l.e = l.g; done.v = true; rStore(n, l, p, n.k, l.g, c, false); l.n[0] = l.g; }
        else if (y.v > l.g) {
          dir = -1;
          if (y.v > l.o) { sect(y.v, l.a, n, h); const sf = Math.pow(h.k * h.d, 2) / (2.207955 * h.g); if (sf > l.b) { dir = 1; crit.v = true; } }
        } else if (y.v < l.g) dir = 1;
      }
      let step = (Math.abs(n.p - n.q) + n.i) / 400;
      step = Math.max(step, 0.02);
      dyFirst.v = Math.max(dyFirst.v, step);
      dy.v = dir * step; dyFirst.v = dir * dyFirst.v;
    }
    // --- barrel profile (t.a) ---
    function profile(n, l, p, D, h, xOut) {
      const dy = ref(0), dyFirst = ref(0), c = ref(0), crit = ref(false), done = ref(false), y = ref(0), x = xOut;
      profileStart(n, l, p, D, x, y, dy, dyFirst, c, crit, done);
      let first = l.x, it = 0, interp = true, prevY = 0, dx = 0;
      dx = pStep(y.v, n, l);
      while (!done.v) {
        ++it; prevY = y.v;
        if (first) { first = false; y.v += dyFirst.v; } else y.v += dy.v;
        if (y.v >= n.i) {
          done.v = true; l.y = true; l.x = true; interp = false;
          rStore(n, l, p, n.k, y.v, c, interp);
          if (l.z) { l.f = n.i; l.n[15] = n.i; continue; }
          l.e = n.i; l.n[0] = n.i; continue;
        }
        if (y.v <= D.d && dy.v < 0 && l.z || y.v >= D.d && dy.v > 0 && !l.z) {
          done.v = true;
          if (l.z) { l.f = D.d; l.n[15] = D.d; } else { l.e = D.d; l.n[0] = D.d; }
          y.v = D.d; interp = false; rStore(n, l, p, n.k, y.v, c, interp); continue;
        }
        if (y.v <= l.g && dy.v < 0 || y.v >= l.g && dy.v > 0 && !crit.v) {
          done.v = true;
          if (l.z) { l.f = l.g; l.n[15] = l.g; } else { l.e = l.g; l.n[0] = l.g; }
          y.v = l.g; interp = false; rStore(n, l, p, n.k, y.v, c, interp); continue;
        }
        dx = pStep(y.v, n, l);
        if (dx <= 0) { done.v = true; if (l.z) l.f = D.d; else l.e = D.d; l.n.fill(D.d); continue; }
        x.v += dx;
        rStore(n, l, p, x.v, y.v, c, interp);
        if (x.v >= n.k) {
          done.v = true;
          const d3 = (y.v - prevY) * (n.k + dx - x.v) / dx;
          if (l.z) { l.f = prevY + d3; continue; }
          l.e = prevY + d3; continue;
        }
        if (it <= 500) continue;
        done.v = true;
        if (l.z) { l.f = l.g >= D.d ? l.g : D.d; y.v = l.f; } else { l.e = l.g <= D.d ? l.g : D.d; y.v = l.e; }
        interp = false; rStore(n, l, p, n.k, y.v, c, interp);
        if (l.z) { l.n[15] = y.v; continue; }
        l.n[0] = y.v;
      }
      sect(l.f, l.a, n, h);
      l.i = n.f * h.e;
      if (l.y) l.k = n.k - x.v;
      if (l.z) l.n[15] = l.f; else l.n[0] = l.e;
    }
    // --- outlet control (g_0 / k) ---
    function outletControl(t, n, l, p, D) {
      outletDepth(t, n, l, D);
      const h = H(), x = ref(0);
      if (l.w) {
        fullLosses(t, n.k, n, l, h);
        l.k = n.k; l.f = n.i;
        l.d = l.j + l.h + l.i + t.d;
        // k.a: partly full barrel
        const e = l.j + l.h + t.d; sect(n.i, l.a, n, h);
        const d4 = e - h.e - n.i - n.p;
        if (d4 >= 0 || d4 >= -0.5 && l.g > D.d || D.d >= n.i) { const c = ref(1); rStore(n, l, p, n.k, n.i, c, false); l.n[15] = n.i; }
        else {
          l.w = false; l.x = true;
          const d6 = t.d + l.j - h.e - n.i - n.q;
          l.k = d6 > 0 ? (d4 !== d6 ? (d4 - 0) * (n.k - 0) / (d6 - d4) + n.k : (0 + n.k) / 2) : 0;
          fullLosses(t, l.k, n, l, h);
        }
      }
      if (!l.w) {
        profile(n, l, p, D, h, x);
        if (l.y) {
          fullLosses(t, l.k, n, l, h);
          const d3 = x.v / n.k * (n.p - n.q) + n.q + n.i;
          l.d = d3 + l.h + l.i + h.e;
        } else l.d = n.p + l.i + l.f + h.e;
      }
    }
    // --- inlet control (f_0 / l) ---
    function inletControl(n, l, D) {
      const h = hI, c = n.a;
      sect(n.i, l.a, n, h);
      const q = l.a / (h.b * Math.sqrt(n.i));
      let un = 0, sub = 0;
      if (q < 4) {
        if (n.F) { critical(l.a, n, D); un = (c.a * Math.pow(q, c.b) + c.c * l.b) * n.i + D.d + D.e; }
        else un = c.a * Math.pow(q, c.b) * n.i;
      }
      if (q > 3.5) sub = n.i * (c.d * q * q + c.e + c.c * l.b);
      if (q <= 3.5) l.c = un + n.p;
      else if (q < 4) l.c = (4 - q) * (sub - un) / (3.5 - 4) + sub + n.p;
      else l.c = sub + n.p;
    }
    // --- headwater for a discharge (d / z / a_0) ---
    function headwater(t, n, l, p, Qtot) {
      const D = { a: n.q, b: 0, c: 0, d: 0, e: 0, f: 0, g: false };
      Object.assign(l, { y: false, w: false, x: false, v: false, D: false, A: false, B: false, C: false, k: BIG, g: BIG, r: 0, l: BIG, m: BIG, E: false });
      l.a = Qtot / n.x;
      const h = H(); sect(n.i, 1, n, h);
      if (l.a >= h.b * 500) l.a = h.b * 500;
      l.z = t.q;
      critical(l.a, n, D);
      p.b = []; for (let i = 0; i < 15; i++) p.b.push(i / 15 * n.k); p.b[15] = n.k;
      l.n = new Array(16).fill(BIG);
      inletControl(n, l, D);
      outletControl(t, n, l, p, D);
      let hw;
      if (n.C === 0) {
        if (l.E) { hw = l.d; l.q = 2; }
        else {
          if (l.c >= l.d) { hw = l.c; l.q = 1; } else { l.q = 2; hw = l.d; }
          if (l.q === 2 && D.g && l.f === D.b && l.f < n.i) { hw = l.c; l.q = 1; }
        }
      } else if (n.C === 1) { hw = l.c; l.q = 1; } else { hw = l.d; l.q = 2; }
      sect(hw - n.p, Qtot, n, h); l.p = h.i;
      return hw;
    }
    function setup(t, HW, TW) { // e.a
      Object.assign(t, { c: HW, d: TW, e: HW, f: TW, g: HW, h: 0, i: 0, j: 0, k: 0, l: BIG, q: true });
      const drop = N.p - N.q, run = Math.sqrt(N.k * N.k - drop * drop);
      return drop / run;
    }
    // discharge (cfs, all barrels) for headwater HW and tailwater TW (ft)
    return function flow(HW, TW) {
      Object.assign(N, { i: N.h, p: N.l, q: N.m, D: N.C, n: N.l, o: N.m, r: Math.max(N.l, N.m), x: N.y });
      const t = {}, l = { n: new Array(16).fill(BIG) }, p = { b: [] }, tol = N.s;
      const bracket = { qHi: BIG, qLo: 0, hwHi: BIG, hwLo: -BIG };
      const update = (target, hw, q) => { if (hw < target) { if (q > bracket.qLo) { bracket.hwLo = hw; bracket.qLo = q; } return true; } if (q < bracket.qHi) { bracket.hwHi = hw; bracket.qHi = q; } return false; };
      const HWof = (q) => { l.b = setup(t, HW, TW); return headwater(t, N, l, p, q); };
      const solve = (seed, useSeed) => {
        bracket.qHi = BIG; bracket.qLo = 0; bracket.hwHi = BIG; bracket.hwLo = -BIG;
        l.b = setup(t, HW, TW);
        // o.a: initial guesses (orifice / inlet equations)
        let g1 = 0, g2 = 0;
        {
          const c = N.a, dh = t.e - t.d, hd = t.e - N.p, D = N.i, h = H();
          sect(hd, 1, N, h);
          const A = h.b, qo = 5.614 * A * Math.sqrt(dh);
          let x = hd / (D * c.a); const qu = A * Math.sqrt(D) * Math.pow(x, 1 / c.b);
          x = Math.abs((hd / D - c.e + c.c * l.b) / c.d); const qs = A * Math.sqrt(D * x);
          x = qs / (A * Math.sqrt(D));
          let q2, qm;
          if (x >= 4) { q2 = qs; qm = qs; } else { x = qu / (A * Math.sqrt(D)); if (x <= 3.5) { q2 = qu; qm = qu; } else { q2 = 0.5 * (qs + qu); qm = Math.max(qs, qu); } }
          q2 *= N.x; qm *= N.x;
          g2 += Math.max(qm, qo * N.x);
          g1 += x >= 3.5 && t.f >= N.q + D ? qo * N.x : Math.min(q2, qo * N.x);
        }
        let q = useSeed ? seed : g1, hw = HWof(q);
        if (Math.abs(HW - hw) <= tol) return { q, done: true };
        let low = update(HW, hw, q);
        if (low) {
          q = g2; hw = HWof(q); low = update(HW, hw, q);
          if (low) for (let k = 0; k < 6 && low; k++) { q *= 2; hw = HWof(q); low = update(HW, hw, q); }
        }
        if (bracket.qHi > 3 * bracket.qLo) {
          let k = 0, f = useSeed ? 1.5 : 2; q *= useSeed ? 0.8 : 0.6;
          for (;;) { hw = HWof(q); update(HW, hw, q); if (++k >= 6 || bracket.qHi <= 3.5 * bracket.qLo) break; q /= f; f *= 1.2; }
        }
        // c.a: alternate secant and bisection
        let bis = false, it = 0;
        for (;;) {
          q = bis ? 0.5 * (bracket.qHi + bracket.qLo) : (bracket.hwLo !== bracket.hwHi ? (bracket.hwLo - HW) * (bracket.qLo - bracket.qHi) / (bracket.hwHi - bracket.hwLo) + bracket.qLo : (bracket.qHi + bracket.qLo) / 2);
          hw = HWof(q); update(HW, hw, q); ++it;
          if (Math.abs(HW - hw) <= tol || it >= N.B) break;
          bis = !bis;
        }
        return { q, done: false };
      };
      let r = solve(0, false);
      if (l.q === 1 && N.C === 0) {
        const h = H(); sect(l.e, l.a, N, h);
        if (h.f + N.q <= TW) { N.C = 2; r = solve(l.a, true); N.C = 0; }
      }
      return l.a * N.x;
    };
  }
  // One outflow structure: q(pool, tailwater) in project units (tailwater undefined = none),
  // its lowest active elevation, and for pumps an on/off state updated each sub-step.
  function structureFlow(st, u, pdata) {
    const p = st.p, g = u.metric ? 9.80665 : 32.174, ft = u.metric ? 1 / 0.3048 : 1, cfs = u.metric ? 0.028316846592 : 1;
    const submerged = (tw, z) => { if (tw !== undefined && tw > z) throw new Error(msg('unsupported', 'Submerged ' + st.method, '')); };
    if (st.type === 'Conduit' && st.method === 'Orifice') {
      const cd = num(p['Orifice Coefficient']), a = num(p['Orifice Area']), z = num(p['Centerline Elevation']), nb = num(p['Number Barrels'] || 1);
      return { low: z, q: (e, tw) => { const h = tw !== undefined && tw > z ? e - tw : e - z; return e > z && h > 0 ? nb * cd * a * Math.sqrt(2 * g * h) : 0; } };
    }
    if (st.type === 'Conduit' && st.method === 'Culvert') {
      const shape = { circular: 1, box: 2 }[String(p['Culvert Shape'] || '').toLowerCase()];
      if (!shape) throw new Error(msg('unsupported', 'Culvert Shape', p['Culvert Shape']));
      const rise = num(p['Rise'] ?? p['Diameter']), inv = num(p['Inlet Invert Elevation']), outv = num(p['Outlet Invert Elevation']);
      const flow = culvertSolver({
        shape, chart: num(p['Chart Number']), scale: num(p['Scale Number']), control: /inlet/i.test(p['Solution Control'] || '') ? 1 : /outlet/i.test(p['Solution Control'] || '') ? 2 : 0,
        barrels: num(p['Number Barrels'] || 1), rise: (shape === 1 ? num(p['Diameter'] ?? p['Rise']) : rise) * ft, span: num(p['Span'] ?? p['Diameter'] ?? p['Rise']) * ft, length: num(p['Culvert Length']) * ft,
        inletInv: inv * ft, outletInv: outv * ft, ke: num(p['Entrance Loss Coefficient']), kx: num(p['Exit Loss Coefficient']), n: num(p["Top Manning's n"] ?? p["Manning's n"]),
      });
      return { low: inv, q: (e, tw) => {
        if (tw === undefined) { if (e * ft < outv * ft || e <= inv) return 0; return flow(e * ft, outv * ft) * cfs; }
        if (e <= inv || e < tw) return 0;
        return flow(e * ft, tw * ft) * cfs;
      } };
    }
    if (st.type === 'Pump' && st.method === 'Head-Discharge Pump') {
      const t = pdata && pdata[tableKey('Stage-Flow', p['Head-Discharge Table Name'])];
      if (!t || !t.x) throw new Error(msg('noTable', 'Head-Discharge', p['Head-Discharge Table Name'], ''));
      const count = num(p['Number Of Pumps'] || 1), intake = num(p['Intake Elevation']), dis = num(p['Discharge Elevation']), on = num(p['Switch-On Elevation']), off = num(p['Switch-Off Elevation']), loss = num(p['Equipment Head Loss'] || 0);
      const minRun = num(p['Minimum Run Time']), minRest = num(p['Minimum Rest Time']);
      const table = (h) => { if (h < t.x[0] || h > t.x[t.x.length - 1]) throw new Error(msg('pumpHead', h)); return count * lerp(h, t.x, t.y); };
      const pump = { low: intake, running: false, since: null,
        update(e, time) { // HEC-HMS: switch on at/above the on level, off at/below the off level
          if (e < intake) { if (this.running) this.since = time; this.running = false; return; }
          if (this.running) { if (e <= off) { if (this.since !== null && !isNaN(minRun)) { if ((time - this.since) / 1000 >= 60 * minRun) { this.running = false; this.since = time; } } else { this.running = false; this.since = time; } } }
          else if (e >= on) { if (this.since !== null && !isNaN(minRest)) { if ((time - this.since) / 1000 >= 60 * minRest) { this.running = true; this.since = time; } } else { this.running = true; this.since = time; } }
        },
        q(e, tw) {
          if (!this.running || e < intake) return 0;
          let h = loss;
          if (tw !== undefined && tw > dis) { if (e < tw) h += tw - e; else h = Math.max(0, h - (e - tw)); }
          else if (e < dis) h += dis - e; else h = Math.max(0, h - (e - dis));
          return table(h);
        } };
      return pump;
    }
    if (st.type === 'Spillway' && st.method === 'Ogee Spillway') {
      const L = num(p['Spillway Crest Length']), z = num(p['Spillway Crest Elevation']), hd = num(p['Spillway Design Head']);
      const da = num(p['Spillway Approach Depth']), loss = num(p['Spillway Approach Loss'] || 0), nab = num(p['Number of Spillway Abutments'] || 0);
      const kaCol = /earth/i.test(p['Spillway Abutment Type'] || '') ? 5 : 4, cUnit = u.metric ? Math.sqrt(0.3048) : 1;
      // As HEC-HMS 4.13: He = H·(1 − loss/Hd), Da/Hd capped at 1.33, Le = L − He·N·Ka (no piers)
      return { low: z, q: (e, tw) => {
        if (e <= z) return 0;
        submerged(tw, z);
        const he = (e - z) * (1 - loss / hd), r = he / hd;
        const cq = ogeeCol(r, 1) * Math.pow(Math.min(da / hd, 1.33), ogeeCol(r, 2)) * cUnit;
        return cq * Math.min(L, L - he * nab * ogeeCol(r, kaCol)) * Math.pow(he, 1.5);
      } };
    }
    if (st.type === 'Spillway' && st.method === 'Broad-Crested Spillway') {
      const L = num(p['Spillway Crest Length']), z = num(p['Spillway Crest Elevation']), c = num(p['Spillway Coefficient']);
      return { low: z, q: (e, tw) => { if (e <= z) return 0; submerged(tw, z); return c * L * Math.pow(e - z, 1.5); } };
    }
    if (st.type === 'Dam Top' && st.method === 'Level Dam') {
      const c = num(p['Overflow Coefficient']), L = num(p['Top Length']), z = num(p['Top Elevation']);
      return { low: z, q: (e, tw) => { if (e <= z) return 0; submerged(tw, z); return c * L * Math.pow(e - z, 1.5); } };
    }
    throw new Error(msg('unsupported', 'Reservoir ' + st.type, st.method));
  }
  // Brent's method with HEC-HMS's bracketing (hms.model.basin.O): returns the best estimate
  // even when it cannot bracket, as HEC-HMS does.
  function brent(fn, a, b, tol, lo, hi) {
    let fa, fb;
    { // bracket
      if (a === b) b = 1.01 * a;
      fa = fn(a); fb = fn(b);
      let ok = false;
      for (let i = 0; i < 50; i++) {
        if (fa * fb < 0) { ok = true; break; }
        if (fa * fb === 0) break;
        if (Math.abs(fa) < Math.abs(fb)) { a += 1.6 * (a - b); a = Math.min(Math.max(a, lo), hi); fa = fn(a); }
        else { b += 1.6 * (b - a); b = Math.min(Math.max(b, lo), hi); fb = fn(b); }
      }
      if (!ok) { if (fa === 0) return a; if (fb === 0) return b; return Math.abs(fa) < Math.abs(fb) ? a : b; }
    }
    let c = b, fc = fb, d = 0, e = 0;
    for (let i = 0; i < 100; i++) {
      if (fb * fc > 0) { c = a; fc = fa; d = e = b - a; }
      if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
      const m = 0.5 * (c - b);
      if (Math.abs(m) <= tol || fb === 0) return b;
      const t = 4.440892098500626e-16 * Math.abs(b) + 0.5 * tol;
      if (Math.abs(e) >= t && Math.abs(fa) > Math.abs(fb)) {
        let pp, q;
        const s = fb / fa;
        if (a === c) { pp = 2 * m * s; q = 1 - s; }
        else { q = fa / fc; const r = fb / fc; pp = s * (2 * m * q * (q - r) - (b - a) * (r - 1)); q = (q - 1) * (r - 1) * (s - 1); }
        if (pp > 0) q = -q;
        pp = Math.abs(pp);
        if (2 * pp < Math.min(3 * m * q - Math.abs(t * q), Math.abs(e * q))) { e = d; d = pp / q; } else { d = e = m; }
      } else d = e = m;
      a = b; fa = fb;
      b = Math.abs(d) > t ? b + d : b + (m > 0 ? Math.abs(t) : -Math.abs(t));
      fb = fn(b);
    }
    return b;
  }
  const STORAGE_UNIT = { 'THOU M3': 1000, '1000 M3': 1000, 'M3': 1, 'MILLION M3': 1e6, 'AC-FT': 43560, 'ACRE-FT': 43560, 'FT3': 1 };
  const AREA_UNIT = { 'THOU M2': 1000, '1000 M2': 1000, 'M2': 1, 'KM2': 1e6, 'HA': 1e4, 'ACRE': 43560, 'AC': 43560, 'FT2': 1 };
  // Controlled-outflow reservoir (outflow structures).
  function reservoirRoute(inflow, res, pdata, dtMin, u, name, times, gages) {
    if (!/controlled outflow|outflow structures/i.test(res.route || '')) throw new Error(msg('unsupported', 'Reservoir Route', res.route));
    if (res.tailwater[1] && !/^none$/i.test(res.tailwater[1])) throw new Error(msg('unsupported', 'Auxiliary Tailwater', res.tailwater[1]));
    if (res.evaporation && !/zero evaporation|none/i.test(res.evaporation)) throw new Error(msg('unsupported', 'Evaporation Method', res.evaporation));
    let twAt = () => undefined;
    if (res.tailwater[0] && !/^none$/i.test(res.tailwater[0])) {
      if (!/^specified stage$/i.test(res.tailwater[0])) throw new Error(msg('unsupported', 'Tailwater', res.tailwater[0]));
      const gg = gages && gages[res.tailwaterGage];
      if (!gg || !gg.values) throw new Error(gg && gg.error || msg('noGage', res.tailwaterGage));
      const step = gg.interval * 60000;
      // As HEC-HMS's buffered reader: the gage is sampled at run-interval points of a buffer
      // grid (each gage value holding over the interval ending at its stamp) and interpolated
      // linearly in between; the grid starts one interval before the query that (re)fills it.
      const at = (t) => gg.values[Math.min(gg.values.length - 1, Math.max(0, Math.ceil((t - gg.start) / step - 1e-9) - 1))];
      const dt = dtMin * 60000;
      let g0 = null, g1 = null;
      twAt = (t) => {
        if (g0 === null || g0 > t || g1 < t) { g0 = t - dt; g1 = g0 + 2880 * dt; }
        const x = Math.round((t - g0) / 1000) / (dt / 1000), k = Math.floor(x), fr = x - k, v0 = at(g0 + k * dt);
        return fr > 0 ? v0 + fr * (at(g0 + (k + 1) * dt) - v0) : v0;
      };
    }
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
    const flows = res.structures.map(st => structureFlow(st, u, pdata)), pumps = flows.filter(f => f.update);
    // HEC-HMS 4.13 scheme (SI inside): each interval is split into whole-second sub-steps; every
    // sub-step solves (S(E) − S0)/h − Ī + (O(E) + O0)/2 = 0 for the pool elevation E, with Ī
    // the interval's mean inflow. The first sub-step is the time to drain to the lowest outlet
    // when outflow exceeds inflow; adaptive control shrinks or doubles the sub-step. Pumps switch
    // at the start of a sub-step; the tailwater is taken at its end.
    const fe = u.metric ? 1 : 0.3048, fq = u.metric ? 1 : 0.028316846592;
    const E = elevs.map(e => e * fe), Sv = stor.map(s => s * (u.metric ? 1 : 0.028316846592));
    const sOf = (e) => Math.max(0, lerp(e, E, Sv)), elevOfS = (s) => lerp(s, Sv, E);
    let tw;
    const qOf = (e) => flows.reduce((a, f) => a + f.q(e / fe, tw), 0) * fq;
    const eLowRaw = () => Math.min(E[E.length - 1], ...flows.map(f => f.low * fe).filter(v => !isNaN(v)));
    const eLow = eLowRaw();
    // HEC-HMS root finder: bracket from [E0, E0 + 0.25] (expanding ×1.6, not below the lowest
    // elevation that holds storage), then Brent's method to 1e-6 m.
    let eFloor = E[0];
    for (let i = 1; i < Sv.length; i++) if (Sv[i] > 1e-4 * i) { eFloor = E[i - 1]; break; }
    eFloor = Math.min(eFloor, eLowRaw());
    const solve = (e0, s0, q0, qin, h) => brent((e) => (sOf(e) - s0) / h - qin + (qOf(e) + q0) / 2, e0, e0 + 0.25, 1e-6, eFloor, 1.7e308);
    const shrink = (h, de, q0, q1, s0, s1, grow) => {
      if (Math.abs(de) > 0.1) return Math.trunc(h / Math.ceil(Math.abs(de) / 0.1));
      if (q0 > 0.025 && q1 > 0.025 && Math.abs(q0 - q1) / q0 > 0.1) return Math.trunc(h / Math.ceil(Math.abs(q0 - q1) / q0 / 0.1));
      if (Math.abs(s0 - s1) / s0 > 0.03) return Math.trunc(h / Math.ceil(Math.abs(s0 - s1) / s0 / 0.03));
      if (grow && (Math.abs(de) < 0.05 || Math.abs(q0 - q1) / q0 < 0.05 || Math.abs(s0 - s1) / s0 < 0.015)) return h * 2;
      return h;
    };
    tw = twAt(times[0]);
    let el;
    if (!isNaN(res.initialElevation)) el = res.initialElevation * fe;
    else if (!isNaN(res.initialStorage)) el = elevOfS(res.initialStorage * unit.f * (u.metric ? 1 : 0.028316846592));
    else { // inflow = outflow
      let lo = E[0], hi = E[E.length - 1];
      for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (qOf(m) > inflow[0] * fq) hi = m; else lo = m; }
      el = (lo + hi) / 2;
    }
    const n = inflow.length, full = Math.round(dtMin * 60);
    const outflow = new Float64Array(n), storage = new Float64Array(n), elevation = new Float64Array(n), tail = new Float64Array(n), parts = flows.map(() => new Float64Array(n));
    const record = (i) => {
      const e = el / fe; elevation[i] = e; storage[i] = sOf(el) / (u.metric ? 1 : 0.028316846592) / unit.f; tail[i] = tw === undefined ? NaN : tw;
      flows.forEach((f, j) => { parts[j][i] = f.q(e, tw); outflow[i] += parts[j][i]; });
    };
    record(0);
    let qPrev = outflow[0] * fq;
    for (let i = 1; i < n; i++) {
      let e0 = el, s0 = sOf(el), q0 = qPrev, t0 = times[i - 1];
      const qin = (Math.max(0, inflow[i - 1]) + Math.max(0, inflow[i])) / 2 * fq;
      for (const pm of pumps) pm.update(e0 / fe, t0);
      let left = full, h = full;
      if (q0 > qin) h = Math.trunc(-(s0 - sOf(eLow)) / (qin - q0));
      else if (q0 === 0 && e0 >= eLow && qin > 0) h = 5;
      h = Math.max(1, Math.min(h, full));
      left -= h;
      tw = twAt(times[i] - left * 1000);
      let e1 = solve(e0, s0, q0, qin, h), q1 = qOf(e1), s1 = sOf(e1);
      if (res.adaptive) {
        const h0 = h;
        h = Math.max(1, shrink(h, e0 - e1, q0, q1, s0, s1, false));
        if (h < h0) left += h0; else if (h > left) h = left;
      }
      let tStart = t0;
      while (left > 0) {
        for (const pm of pumps) pm.update(e0 / fe, tStart);
        left -= h;
        tw = twAt(times[i] - left * 1000);
        e1 = solve(e0, s0, q0, qin, h); q1 = qOf(e1); s1 = sOf(e1);
        if (res.adaptive) h = Math.max(1, shrink(h, e0 - e1, q0, q1, s0, s1, true));
        h = Math.min(h, full);
        if (left > 0 && h > left) h = left;
        h = Math.max(1, h);
        e0 = e1; s0 = s1; q0 = q1; tStart = times[i] - left * 1000;
      }
      el = e1; qPrev = q1;
      record(i);
    }
    return { outflow, storage, elevation, tailwater: tail, storageUnits: unit.label, structures: res.structures.map((st, j) => ({ type: st.type, method: st.method, flow: parts[j] })) };
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
        el.loss = { method: p['LossRate'], initialLoss: num(p['Initial Loss']), constantRate: num(p['Constant Loss Rate'] ?? p['Percolation Rate']), initialDeficit: num(p['Initial Deficit']), maxDeficit: num(p['Maximum Deficit']), impervious: num(p['Percent Impervious Area'] || 0), cn: num(p['Curve Number']), ia: num(p['Initial Abstraction']) };
        el.transform = { method: p['Transform'], tc: num(p['Time of Concentration']), storage: num(p['Storage Coefficient']), lag: num(p['Lag']), uhName: p['Unit Hydrograph Name'], snyderMethod: p['Snyder Method'], modClarkMethod: p['Mod Clark Method'], uhType: p['Unitgraph Type'], tp: num(p['Snyder Tp']), cp: num(p['Snyder Cp']) };
        el.canopy = { method: p['Canopy'], initPct: num(p['Initial Canopy Storage Percent']), capacity: num(p['Canopy Storage Capacity']), crop: num(p['Crop Coefficient']), allowSim: p['Allow Simultaneous Precip Et'] };
        el.surface = { method: p['Surface'], initPct: num(p['Initial Surface Storage Percent']), capacity: num(p['Surface Storage Capacity']) };
        if (/soil moisture account/i.test(p['LossRate'] || '')) el.sma = {
          impervious: num(p['Percent Impervious Area']), soilInit: num(p['Initial Soil Storage Percent']), maxInf: num(p['Soil Maximum Infiltration']), soilCap: num(p['Soil Storage Capacity']), tension: num(p['Soil Tension Capacity']), maxPerc: num(p['Soil Maximum Percolation']),
          gw: [1, 2].map(j => ({ init: num(p[`Initial Gw${j} Storage Percent`]), cap: num(p[`Groundwater ${j} Storage Capacity`]), route: num(p[`Groundwater ${j} Routing Coefficient`]), perc: num(p[`Groundwater ${j} Maximum Percolation`]) })),
        };
        el.baseflow = { method: p['Baseflow'], layers: [1, 2, 3].map(j => ({ reservoirs: num(p[`GW-${j} Number Reservoirs`]), route: num(p[`GW-${j} Routing Coefficient`]), initial: num(p[`GW-${j} Initial Baseflow`]), initialRatio: num(p[`GW-${j} Initial Flow/Area Ratio`]) })).filter(l => !isNaN(l.route)), recession: num(p['Recession Factor']), initialPerArea: num(p['Initial Flow/Area Ratio']), thresholdRatio: num(p['Threshold Flow To Peak Ratio'] ?? p['Threshold Flow to Peak Ratio']), thresholdFlow: num(p['Threshold Flow']), initialDischarge: num(p['Initial Baseflow'] ?? p['Initial Discharge']) };
      } else if (b.kind === 'Reach') {
        el.route = { method: p['Route'], K: num(p['Muskingum K']), X: num(p['Muskingum x']), steps: num(p['Muskingum Steps'] || 1), lag: num(p['Lag']), table: p['Storage Outflow Table Name'], subreaches: num(p['Number of Reaches'] || 1), initial: p['Initial Variable'], initialOutflow: num(p['Initial Outflow']) };
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
    const met = { header: head, method: head.props['Precipitation Method'], et: head.props['Evapotranspiration Method'], subbasins: {} };
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
      if (b.kind === 'Precip Method Parameters' && b.name === 'Gridded Precipitation') { met.gridName = b.props['Precip Grid Name']; met.timeShift = b.props['Time Shift Method']; continue; }
      if (b.kind === 'Precip Method Parameters' && b.name === 'Weighted Gages') {
        met.weighted = { hec1: /^yes/i.test(b.props['Use HEC1 Weighting Scheme'] || ''), index: /^yes/i.test(b.props['Use Indexing'] || ''), override: /^yes/i.test(b.props['Allow Depth Override'] || '') };
        continue;
      }
      if (b.kind === 'Gage') { // Weighted Gages: gage type, index and depth override
        (met.gageInfo ||= {})[b.name] = { type: b.props['Type'], index: num(b.props['Gage Index']), total: num(b.props['Total Precipitation']) };
        continue;
      }
      if (b.kind !== 'Subbasin') continue;
      const weights = [];
      for (const [k, v] of b.lines || []) {
        if (k === 'Gage') weights.push({ gage: v, volume: NaN, temporal: NaN });
        else if (k === 'Volume Weight' && weights.length) weights[weights.length - 1].volume = num(v);
        else if (k === 'Temporal Distribution Weight' && weights.length) weights[weights.length - 1].temporal = num(v);
      }
      const depth = {}, time = {};
      for (const k of b.order) {
        let m = /^Depth Weight (.+)$/.exec(k); if (m) depth[m[1]] = num(b.props[k]);
        m = /^Time Weight (.+)$/.exec(k); if (m) time[m[1]] = num(b.props[k]);
      }
      const pan = [], etCoef = [];
      for (const [k, v] of b.lines || []) { if (k === 'Pan Evaporation') pan.push(num(v)); else if (k === 'Evapotranspiration Coefficient') etCoef.push(num(v)); }
      met.subbasins[b.name] = { pan, etCoef, name: b.name, gage: b.props['Gage'], depth, time, depths: durDepths(b), weights, index: num(b.props['Subbasin Index']) };
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
          else {
            g.values = Array.from(s.values); g.interval = s.interval; g.start = s.start; g.units = s.units;
            // cumulative gage (…/PRECIP-CUM/…): difference, restarting when the total resets
            if (/CUM/i.test(pathParts(g.pathname).C)) { let last = 0; g.values = g.values.map(v => { if (isNaN(v)) return 0; const d = v >= last ? v - last : 0; last = v; return d; }); }
          }
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

  // Gridded subbasin (File-Specified cells): precipitation and loss per cell, Modified Clark
  // per cell (other transforms use the area-averaged excess).
  function griddedSubbasin(e, met, control, ext, u) {
    const times = control.times, dtMin = control.dtMin, dtH = dtMin / 60, n = times.length;
    const grid = ext && ext.grids && ext.grids[met.gridName];
    if (!grid) throw new Error(msg('noGrid', met.gridName));
    if (met.timeShift && !/^none$/i.test(met.timeShift)) throw new Error(msg('unsupported', 'Time Shift Method', met.timeShift));
    const dss = ext.getDss && ext.getDss(grid.file);
    if (!dss) throw new Error(msg('needFile', grid.file));
    const cells = ext.cells && ext.cells[e.name];
    if (!cells || !cells.length) throw new Error(msg('noCells', e.name, e.block.props['File'] || ''));
    const { depth, units } = gridPrecip(grid, dss, cells, times);
    const toMm = /^in/i.test(units) ? 25.4 : 1, k = u.metric ? 1 : 25.4; // grid units → mm → project depth
    const aSum = cells.reduce((a, c) => a + c.area, 0), maxLen = Math.max(...cells.map(c => c.len));
    // HEC-HMS scales the cell areas so that they add up to the subbasin area
    const areaScale = (u.metric ? e.area : e.area * 2.589988110336) / aSum;
    const p = new Float64Array(n), excess = new Float64Array(n), loss = new Float64Array(n), direct = new Float64Array(n);
    const modClark = e.transform.method === 'Modified Clark';
    if (modClark && e.transform.modClarkMethod && !/^specified$/i.test(e.transform.modClarkMethod)) throw new Error(msg('unsupported', 'Mod Clark Method', e.transform.modClarkMethod));
    cells.forEach((c, j) => {
      const pc = Float64Array.from(depth[j], v => v * toMm / k);
      const r = lossMethod(pc, e.loss, dtH, u);
      const w = c.area / aSum;
      for (let i = 0; i < n; i++) { p[i] += w * pc[i]; excess[i] += w * r.excess[i]; loss[i] += w * r.loss[i]; }
      if (modClark) {
        const q = modClarkCell(Float64Array.from(r.excess, v => v * k), c.len, maxLen, e.transform.tc, e.transform.storage, c.area * areaScale, dtMin);
        for (let i = 0; i < n; i++) direct[i] += q[i] / (u.metric ? 1 : 0.028316846592);
      }
    });
    return { p, excess, loss, direct: modClark ? direct : transform(excess, e.area, e.transform, dtMin, u) };
  }
  function run(basin, met, gages, control, pdata, ext) {
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
      // as in HEC-HMS, a negative upstream flow (e.g. Muskingum with small Δt) adds nothing
      for (const up of ups) { area += up.area; for (let i = 0; i < n; i++) inflow[i] += Math.max(0, up.outflow[i]); }
      for (const dv of (diverted[name] || []).map(compute)) for (let i = 0; i < n; i++) inflow[i] += dv.diverted[i];
      let r;
      if (e.kind === 'Subbasin') {
        const gridded = met.method === 'Gridded Precipitation' ? griddedSubbasin(e, met, control, ext, u) : null;
        const p = gridded ? gridded.p : subbasinHyetograph(met, gages, name, times);
        let sma = null;
        if (e.sma) sma = smaLoss(p, petSeries(met, name, times), e, dtH, u);
        else for (const [what, m] of [['Canopy', (e.canopy || {}).method], ['Surface', (e.surface || {}).method]]) if (m && !/^none$/i.test(m)) throw new Error(msg('unsupported', what, m));
        const { excess, loss } = gridded || sma || (/^deficit constant$/i.test(e.loss.method || '') ? deficitLoss(p, e.loss, dtH, u) : lossMethod(p, e.loss, dtH, u));
        const tr = { ...e.transform, uh: e.transform.uhName && pdata ? pdata[e.transform.uhName] : null };
        if (tr.uh && !tr.uh.values) throw new Error(tr.uh.error);
        const direct = gridded ? gridded.direct : transform(excess, e.area, tr, dtMin, u);
        let total, base;
        if (e.baseflow.method === 'Linear Reservoir') {
          if (!sma) throw new Error(msg('unsupported', 'Baseflow', 'Linear Reservoir + ' + e.loss.method));
          base = linearReservoir(sma.gwOut, e.area, e.baseflow, dtH, u, e.sma.impervious);
          total = Float64Array.from(direct, (v, i) => v + base[i]);
        } else ({ total, base } = baseflow(direct, e.area, e.baseflow, dtH));
        const sum = a => a.reduce((s, v) => s + v, 0);
        r = { kind: e.kind, area: e.area, precip: p, loss, excess, direct, base, outflow: total, sma, totals: { precip: sum(p), loss: sum(loss), excess: sum(excess) } };
      } else if (e.kind === 'Reach') {
        r = { kind: e.kind, area, inflow, outflow: route(inflow, e.route, dtMin, pdata, name) };
      } else if (e.kind === 'Reservoir') {
        r = { kind: e.kind, area, inflow, ...reservoirRoute(inflow, e.reservoir, pdata, dtMin, u, name, times, gages) };
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

  const api = { setLang, parseHms, writeHms, parseDateTime, fmtTime, fmtDate, fmtDateTime, hmsDate, intervalMinutes, readDss, dssSeries, readBasin, readMet, readGages, readGrids, readCells, frequencyStorm, readPairedData, readControl, setControl, readProject, readRuns, readResults, resampleUH, run, _test: { structureFlow, culvertSolver, gridPrecip, lossMethod } };
  if (typeof module !== 'undefined') module.exports = api; else root.MiniHMS = api;
})(this);
