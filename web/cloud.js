// Sign-in and online projects (Supabase Auth + Storage).
// Storage layout, one folder per user:  <bucket>/<user id>/<project id>/project.json  +  <n>.dat per file
(function () {
  'use strict';
  const A = window.HMS_APP, CFG = window.HMS_CLOUD || {};
  if (!A) return;
  const $ = (id) => document.getElementById(id);
  const { esc } = A;

  const L = {
    th: {
      signIn: 'เข้าสู่ระบบ', signUp: 'สมัครสมาชิก', signOut: 'ออกจากระบบ', forgot: 'ลืมรหัสผ่าน',
      email: 'อีเมล', password: 'รหัสผ่าน (อย่างน้อย 6 ตัว)', newPassword: 'รหัสผ่านใหม่', setPassword: 'ตั้งรหัสผ่านใหม่',
      acctTitle: 'บัญชีและโปรเจกต์ออนไลน์', close: 'ปิด',
      acctLede: 'เข้าสู่ระบบเพื่อเก็บโปรเจกต์ HEC-HMS ไว้ออนไลน์ แล้วเปิดจากเครื่องไหนก็ได้ โปรเจกต์ของแต่ละบัญชีเปิดได้เฉพาะเจ้าของ',
      notSet: 'ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์ ใส่ url และ anonKey ของ Supabase ใน web/cloud-config.js (ดูวิธีใน supabase/setup.sql)',
      signedAs: (e) => `เข้าสู่ระบบเป็น ${e}`,
      myProjects: 'โปรเจกต์ของฉัน', none: 'ยังไม่มีโปรเจกต์ที่บันทึกไว้ เปิดหรืออัปโหลดโปรเจกต์ แล้วกด “☁ บันทึกออนไลน์”',
      open: 'เปิด', del: 'ลบ', delSure: 'ยืนยันลบ', saved: (d) => `บันทึก ${d}`, files: (n) => `${n} ไฟล์`,
      save: '☁ บันทึกออนไลน์', saveTip: 'บันทึกโปรเจกต์ที่เปิดอยู่ (รวมค่าที่แก้) ไว้ในบัญชีของคุณ',
      saveTitle: 'บันทึกโปรเจกต์ออนไลน์', projName: 'ชื่อโปรเจกต์', doSave: 'บันทึก', overwrite: 'บันทึกทับ',
      overwriteNote: 'มีโปรเจกต์ชื่อนี้อยู่แล้ว จะบันทึกทับของเดิม',
      saving: (i, n) => `กำลังอัปโหลด ${i}/${n}…`, savedOk: (n) => `บันทึก ${n} ออนไลน์แล้ว`,
      loading: (n) => `กำลังโหลด ${n} จากออนไลน์…`, loadedOk: (n) => `โหลด ${n} แล้ว`,
      group: 'โปรเจกต์ออนไลน์ของฉัน', acct: '👤 บัญชี', noProject: 'ยังไม่ได้เปิดโปรเจกต์',
      checkMail: 'ส่งอีเมลยืนยันแล้ว เปิดลิงก์ในอีเมลแล้วกลับมาเข้าสู่ระบบ',
      resetSent: 'ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว', pwChanged: 'เปลี่ยนรหัสผ่านแล้ว',
      needEmail: 'ใส่อีเมลก่อน', fail: (m) => `ทำไม่สำเร็จ: ${m}`, loadLib: 'โหลดไลบรารีเชื่อมต่อไม่ได้',
    },
    en: {
      signIn: 'Sign in', signUp: 'Create account', signOut: 'Sign out', forgot: 'Forgot password',
      email: 'Email', password: 'Password (6+ characters)', newPassword: 'New password', setPassword: 'Set new password',
      acctTitle: 'Account and online projects', close: 'Close',
      acctLede: 'Sign in to keep HEC-HMS projects online and open them from any computer. Only the owner of an account can open its projects.',
      notSet: 'No server is set up yet. Put your Supabase url and anonKey in web/cloud-config.js (steps in supabase/setup.sql).',
      signedAs: (e) => `Signed in as ${e}`,
      myProjects: 'My projects', none: 'No saved projects yet. Open or upload a project, then press “☁ Save online”.',
      open: 'Open', del: 'Delete', delSure: 'Confirm delete', saved: (d) => `saved ${d}`, files: (n) => `${n} files`,
      save: '☁ Save online', saveTip: 'Save the open project (with your edits) to your account',
      saveTitle: 'Save project online', projName: 'Project name', doSave: 'Save', overwrite: 'Overwrite',
      overwriteNote: 'A project with this name exists and will be replaced.',
      saving: (i, n) => `Uploading ${i}/${n}…`, savedOk: (n) => `Saved ${n} online`,
      loading: (n) => `Loading ${n} from online…`, loadedOk: (n) => `Loaded ${n}`,
      group: 'My online projects', acct: '👤 Account', noProject: 'No project is open',
      checkMail: 'Confirmation email sent. Open its link, then come back and sign in.',
      resetSent: 'A password reset link was sent to your email.', pwChanged: 'Password changed.',
      needEmail: 'Enter your email first', fail: (m) => `Failed: ${m}`, loadLib: 'Could not load the connection library',
    },
  };
  const t = (k, ...a) => { const v = L[A.LANG][k]; return typeof v === 'function' ? v(...a) : v; };

  let sb = null, user = null, list = [], recovering = false;
  const enabled = !!(CFG.url && CFG.anonKey);
  const bucket = CFG.bucket || 'hms-projects';
  const B = () => sb.storage.from(bucket);

  // ---------- UI ----------
  const dlg = $('acct-dlg'), sdlg = $('save-dlg');
  function msg(el, text, bad) { el.textContent = text || ''; el.className = 'cl-msg' + (bad ? ' bad' : ''); }
  function staticText() {
    document.querySelectorAll('[data-cl]').forEach(el => { el.textContent = t(el.dataset.cl); });
    document.querySelectorAll('[data-cl-ph]').forEach(el => { el.placeholder = t(el.dataset.clPh); });
    $('cloud-save').title = t('saveTip');
    renderAcct();
  }
  function renderAcct() {
    $('acct').textContent = user ? '👤 ' + user.email.split('@')[0] : t('signIn');
    $('acct').title = user ? t('signedAs', user.email) : t('acctTitle');
    $('cloud-save').hidden = !enabled;
    $('cl-off').hidden = enabled;
    $('cl-form').hidden = !enabled || !!user || recovering;
    $('cl-reset').hidden = !recovering;
    $('cl-in').hidden = !user || recovering;
    if (user) $('cl-who').textContent = t('signedAs', user.email);
    renderList();
  }
  function fmtDate(s) { try { return new Date(s).toLocaleString(A.LANG === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return s; } }
  function renderList() {
    const box = $('cl-list');
    if (!user) { box.innerHTML = ''; return; }
    box.innerHTML = list.length ? list.map(p => `<div class="cl-row" data-id="${esc(p.id)}">
        <div class="cl-name"><b>${esc(p.name)}</b><span class="hint">${esc(t('saved', fmtDate(p.savedAt)))} · ${esc(t('files', p.files.length))}</span></div>
        <button class="btn ghost" data-act="open">${esc(t('open'))}</button>
        <button class="btn ghost danger" data-act="del">${esc(t('del'))}</button>
      </div>`).join('') : `<p class="hint">${esc(t('none'))}</p>`;
    A.setCloud(list.map(p => ({ id: p.id, name: p.name })), t('group'));
  }

  $('acct').addEventListener('click', async () => {
    dlg.showModal();
    msg($('cl-msg'), '');
    if (enabled && !sb) await connect().catch(e => msg($('cl-msg'), e.message, true));
  });
  $('cl-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  sdlg.addEventListener('click', (e) => { if (e.target === sdlg) sdlg.close(); });

  // ---------- auth ----------
  function loadLib() {
    if (window.supabase) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = res; s.onerror = () => rej(new Error(t('loadLib')));
      document.head.appendChild(s);
    });
  }
  async function connect() {
    await loadLib();
    sb = window.supabase.createClient(CFG.url, CFG.anonKey);
    sb.auth.onAuthStateChange((ev, session) => {
      if (ev === 'PASSWORD_RECOVERY') { recovering = true; if (!dlg.open) dlg.showModal(); }
      setUser(session && session.user);
    });
    const { data } = await sb.auth.getSession();
    setUser(data.session && data.session.user);
  }
  function setUser(u) {
    const changed = (u && u.id) !== (user && user.id);
    user = u || null;
    if (!user) { list = []; A.setCloud([], ''); }
    renderAcct();
    if (changed && user) refresh();
  }
  const creds = () => ({ email: $('cl-email').value.trim(), password: $('cl-pass').value });
  async function busy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { msg($('cl-msg'), t('fail', e.message), true); } finally { btn.disabled = false; }
  }
  $('cl-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('cl-signin'), async () => {
      const { error } = await sb.auth.signInWithPassword(creds());
      if (error) throw error;
      msg($('cl-msg'), '');
    });
  });
  $('cl-signup').addEventListener('click', () => {
    if (!$('cl-form').reportValidity()) return;
    busy($('cl-signup'), async () => {
      const { data, error } = await sb.auth.signUp({ ...creds(), options: { emailRedirectTo: location.href.split('#')[0] } });
      if (error) throw error;
      if (!data.session) msg($('cl-msg'), t('checkMail'));
    });
  });
  $('cl-forgot').addEventListener('click', () => {
    const email = $('cl-email').value.trim();
    if (!email) { msg($('cl-msg'), t('needEmail'), true); $('cl-email').focus(); return; }
    busy($('cl-forgot'), async () => {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
      if (error) throw error;
      msg($('cl-msg'), t('resetSent'));
    });
  });
  $('cl-reset').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('cl-setpw'), async () => {
      const { error } = await sb.auth.updateUser({ password: $('cl-newpass').value });
      if (error) throw error;
      recovering = false; renderAcct(); msg($('cl-msg'), t('pwChanged'));
    });
  });
  $('cl-signout').addEventListener('click', () => busy($('cl-signout'), async () => { await sb.auth.signOut(); setUser(null); }));

  // ---------- projects ----------
  async function refresh() {
    const { data, error } = await B().list(user.id, { limit: 1000 });
    if (error) { msg($('cl-msg'), t('fail', error.message), true); return; }
    const ids = data.filter(x => !x.id).map(x => x.name); // folders
    const got = await Promise.all(ids.map(async (id) => {
      const r = await B().download(`${user.id}/${id}/project.json`);
      if (r.error) return null;
      try { return { ...JSON.parse(await r.data.text()), id }; } catch (_) { return null; }
    }));
    list = got.filter(Boolean).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    renderList();
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const byName = (name) => list.find(p => p.name.trim().toLowerCase() === name.trim().toLowerCase());

  $('cloud-save').addEventListener('click', async () => {
    if (!A.P) { A.showError(t('noProject')); return; }
    if (!sb) await connect().catch(e => A.showError(e.message));
    if (!user) { dlg.showModal(); return; }
    const cur = list.find(p => p.id === A.P.cloud);
    $('sv-name').value = cur ? cur.name : (A.P.name || 'Project');
    syncSave(); msg($('sv-msg'), '');
    sdlg.showModal();
    $('sv-name').select();
  });
  function syncSave() {
    const ex = byName($('sv-name').value);
    $('sv-go').textContent = ex ? t('overwrite') : t('doSave');
    $('sv-note').hidden = !ex;
  }
  $('sv-name').addEventListener('input', syncSave);
  $('sv-cancel').addEventListener('click', () => sdlg.close());
  $('sv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('sv-name').value.trim();
    if (!name) return;
    const ex = byName(name), id = ex ? ex.id : newId(), dir = `${user.id}/${id}`;
    const files = A.files();
    $('sv-go').disabled = true;
    try {
      const manifest = { name, savedAt: new Date().toISOString(), derive: A.P.derive || {}, files: [] };
      for (let i = 0; i < files.length; i++) {
        msg($('sv-msg'), t('saving', i + 1, files.length));
        const f = files[i], path = `${i}.dat`;
        const body = f.buf ? new Blob([f.buf], { type: 'application/octet-stream' }) : new Blob([f.text], { type: 'text/plain;charset=utf-8' });
        const { error } = await B().upload(`${dir}/${path}`, body, { upsert: true, contentType: body.type });
        if (error) throw new Error(`${f.name}: ${error.message}`);
        manifest.files.push({ name: f.name, path, dss: !!f.buf, size: body.size });
      }
      const { error } = await B().upload(`${dir}/project.json`, new Blob([JSON.stringify(manifest)], { type: 'application/json' }), { upsert: true, contentType: 'application/json' });
      if (error) throw error;
      // drop files left over from an older, larger save
      const keep = new Set(['project.json', ...manifest.files.map(f => f.path)]);
      const old = await B().list(dir, { limit: 1000 });
      const extra = (old.data || []).filter(x => !keep.has(x.name)).map(x => `${dir}/${x.name}`);
      if (extra.length) await B().remove(extra);
      A.P.cloud = id;
      await refresh();
      sdlg.close();
      $('runlog').textContent = '☁ ' + t('savedOk', name);
    } catch (err) {
      msg($('sv-msg'), t('fail', err.message), true);
    } finally { $('sv-go').disabled = false; }
  });

  async function openCloud(id) {
    const p = list.find(x => x.id === id);
    if (!p) return;
    $('runlog').textContent = t('loading', p.name);
    try {
      const files = await Promise.all(p.files.map(async (f) => {
        const r = await B().download(`${user.id}/${id}/${f.path}`);
        if (r.error) throw new Error(`${f.name}: ${r.error.message}`);
        return f.dss ? { name: f.name, buf: await r.data.arrayBuffer() } : { name: f.name, text: await r.data.text() };
      }));
      A.showError('');
      if (A.open(files, p.derive, id)) $('runlog').textContent = '☁ ' + t('loadedOk', p.name);
    } catch (e) { $('runlog').textContent = ''; A.showError(t('fail', e.message)); }
  }
  A.onCloudLoad(openCloud);

  $('cl-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('.cl-row').dataset.id;
    if (b.dataset.act === 'open') { dlg.close(); openCloud(id); return; }
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = t('delSure'); setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = t('del'); } }, 4000); return; }
    await busy(b, async () => {
      const dir = `${user.id}/${id}`;
      const { data, error } = await B().list(dir, { limit: 1000 });
      if (error) throw error;
      if (data.length) { const r = await B().remove(data.map(x => `${dir}/${x.name}`)); if (r.error) throw r.error; }
      if (A.P && A.P.cloud === id) A.P.cloud = undefined;
      await refresh();
    });
  });

  // ---------- start ----------
  A.onLang(staticText);
  staticText();
  // reconnect a saved session (and catch sign-up / reset links) without waiting for a click
  if (enabled) {
    const hasSession = Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k));
    if (hasSession || /access_token|type=recovery|code=/.test(location.hash + location.search)) connect().catch(() => {});
  }
})();
