// node tools/test_live.js — checks for the iWASAM data functions in web/live.js
'use strict';
const assert = require('assert'), path = require('path');
const L = require(path.join(__dirname, '..', 'web', 'live.js'));
const M = 60000, T = (h, m = 0, d = 2) => Date.UTC(2026, 9, d, h, m);
let n = 0; const ok = (name, f) => { f(); n++; console.log('ok', name); };

ok('time formats', () => {
  assert.strictEqual(L.parseTime('2026-10-02 12:00'), T(12));
  assert.strictEqual(L.parseTime('02/10/2026 12:00'), T(12));
  assert.strictEqual(L.parseTime('02/10/2569 12:00'), T(12)); // Buddhist year
  assert.strictEqual(L.parseTime('02Oct2026, 12:00'), T(12));
  assert.strictEqual(L.parseTime('02-Oct-26 12:00'), T(12));
  assert.strictEqual(L.parseTime('2026-10-02T05:00:00Z'), T(12)); // UTC → GMT+7
  assert.strictEqual(L.parseTime('2026-10-02T12:00:00+07:00'), T(12));
});

ok('telemetry CSV: date + time columns, newest first, "-" missing, repeated rows', () => {
  const csv = '﻿"date (GMT+7)","time (GMT+7)","h (m)","Q (m3/s)"\n"2026-10-02","12:14","1","9"\n"2026-10-02","11:59","1","-"\n"2026-10-02","11:59","1","8"\n"2026-10-02","11:44","1","7"\n';
  const s = L.readSeries(csv, 'flow');
  assert.deepStrictEqual(s.points, [[T(11, 44), 7], [T(11, 59), 8], [T(12, 14), 9]]);
  const g = { start: T(11, 15), step: 15 * M, n: 4 }; // 11:30 11:45 12:00 12:15
  assert.deepStrictEqual(Array.from(L.flowToGrid(s, g)), [NaN, 7, 8, 9]);
});

ok('HEC-HMS CSV export with "18-Sep-23, 00:00" times', () => {
  const s = L.readSeries('Time (ddMMMYYYY, HH:mm),Discharge (M3/S)\n02-Oct-26, 00:00,17.62\n02-Oct-26, 00:15,18.03\n', 'flow');
  assert.deepStrictEqual(s.points, [[T(0), 17.62], [T(0, 15), 18.03]]);
});

ok('rain since 07:00 → 5-minute depths, reset after 07:00, gaps spread', () => {
  const csv = 'datetime (GMT+7),rainfall from 7am (mm)\n02/10/2026 06:50,4\n02/10/2026 06:55,5\n02/10/2026 07:00,6\n02/10/2026 07:05,0.5\n02/10/2026 07:20,2\n';
  const s = L.readSeries(csv, 'rain');
  assert.ok(s.cumulative);
  const g = { start: T(6, 50), step: 5 * M, n: 6 }; // periods ending 6:55 … 7:20
  const v = Array.from(L.rainToGrid(s, g));
  assert.deepStrictEqual(v.map(x => +x.toFixed(3)), [1, 1, 0.5, 0.5, 0.5, 0.5]);
  // a gap across 07:00: only the rain since 07:00 is known
  const s2 = L.readSeries('datetime,rainfall from 7am (mm)\n2026-10-02 06:50,4\n2026-10-02 07:10,1\n', 'rain');
  const v2 = Array.from(L.rainToGrid(s2, { start: T(6, 50), step: 5 * M, n: 4 }));
  assert.deepStrictEqual(v2.map(x => isNaN(x) ? 'x' : +x.toFixed(3)), ['x', 'x', 0.5, 0.5]);
});

ok('DSS record onto a coarser grid sums, missing stays missing', () => {
  const rec = { start: T(0), interval: 5, values: [1, 2, 3, 4, NaN, 6] };
  assert.deepStrictEqual(Array.from(L.recordToGrid(rec, { start: T(0), step: 15 * M, n: 2 }, 'rain')), [6, NaN]);
});

ok('merge by priority and IDW fill', () => {
  const S = L.SRC;
  const m = L.mergeLayers([{ code: S.DSS, values: [1, NaN, NaN] }, { code: S.CSV, values: [9, 2, NaN] }], 3);
  assert.deepStrictEqual([Array.from(m.values), Array.from(m.src)], [[1, 2, NaN], [S.DSS, S.CSV, 0]]);
  const f = L.fillRain([
    { name: 'a', values: [NaN, NaN], src: [0, 0], coord: [16.4, 99.2] },
    { name: 'b', values: [4, NaN], src: [S.CSV, 0], coord: [16.5, 99.2] },
    { name: 'c', values: [8, NaN], src: [S.CSV, 0], coord: [16.6, 99.2] },
  ]);
  assert.ok(f[0].values[0] > 4 && f[0].values[0] < 6, 'nearer gage weighs more');
  assert.strictEqual(f[0].src[0], S.IDW);
  assert.deepStrictEqual([f[0].values[1], f[0].src[1]], [0, S.ZERO]);
  assert.deepStrictEqual([f[1].values[0], f[1].src[0]], [4, S.CSV]);
});

ok('flow fill: short gap linear, long gap and tail simulated', () => {
  const S = L.SRC, obs = [1, NaN, 3, 3, NaN, NaN, NaN, 5, NaN], sim = [0, 0, 0, 0, 7, 7, 7, 0, 9];
  const f = L.fillFlow(obs, sim, 2);
  assert.deepStrictEqual(Array.from(f.values), [1, 2, 3, 3, 7, 7, 7, 5, 9]);
  assert.deepStrictEqual(Array.from(f.how), [0, S.INTERP, 0, 0, S.SIM, S.SIM, S.SIM, 0, S.SIM]);
});

console.log(`${n} checks passed`);
