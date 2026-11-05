'use strict';
/* Aarviko Workforce: employee client + manager console. Backend: Supabase. */
const CFG = {
  url: 'https://wawtodxpfhzgiacthtej.supabase.co',
  key: 'sb_publishable_GnI3UN93rW2RzhEJFk4f_w_iKMJZTkg',
  tz: 'Asia/Kolkata',
  // Add a TURN server here if the two networks cannot connect directly.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }],
  idleMs: 5 * 60 * 1000,   // 5 minutes of no activity starts a break
  hbMs: 20000,             // heartbeat interval
  diffPct: 0.06,           // % of sampled pixels that must change to count as screen activity
  lumThresh: 10,
  lunchMin: 60, shiftStart: '10:00', grace: 10
};
const sb = supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true } });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = (ts) => ts ? new Date(ts).toLocaleTimeString('en-IN', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hour12: true }) : '-';
const fmtD = (ts) => new Date(ts).toLocaleDateString('en-IN', { timeZone: CFG.tz, day: '2-digit', month: 'short', year: 'numeric' });
const dur = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: CFG.tz });
const dayStart = (d) => new Date(`${d}T00:00:00+05:30`);
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const show = (id) => { ['v-login', 'v-emp', 'v-mgr'].forEach((v) => $(v).classList.toggle('hidden', v !== id)); };

let me = null;
(async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show('v-login');
  await enter();
})();

$('loginForm').onsubmit = async (e) => {
  e.preventDefault(); $('loginErr').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim().toLowerCase(), password: $('password').value });
  if (error) { $('loginErr').textContent = 'Wrong email or password.'; return; }
  await enter();
};

async function enter() {
  const { data: { user } } = await sb.auth.getUser();
  const { data: p } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (!p) { await sb.auth.signOut(); show('v-login'); $('loginErr').textContent = 'This account has no access.'; return; }
  me = p;
  if (p.role === 'manager') { show('v-mgr'); startManager(); } else { show('v-emp'); startEmployee(); }
}

/* ============================== EMPLOYEE ============================== */
const E = { att: null, stream: null, video: null, cv: null, ctx: null, prev: null, lastAct: Date.now(), state: 'active',
  lunchStart: null, change: 0, sig: null, pcs: new Map(), ice: new Map(), lastHb: 0, worker: null, idleSince: null };

async function startEmployee() {
  $('eName').textContent = me.full_name;
  const { data: att, error } = await sb.rpc('rpc_login');
  if (error) { alert(error.message); return; }
  E.att = att; E.lastAct = Date.now();
  $('eLogin').textContent = fmtT(att.login_at);
  const { data: open } = await sb.from('breaks').select('*').eq('user_id', me.id).eq('kind', 'lunch').is('end_at', null).limit(1);
  if (open && open[0]) { E.lunchStart = open[0].start_at; E.state = 'lunch'; }
  await loadEmpData();
  $('gate').classList.remove('hidden');
  initSignaling();
  ['mousemove', 'keydown', 'mousedown', 'wheel', 'touchstart', 'scroll'].forEach((ev) => document.addEventListener(ev, bump, { passive: true, capture: true }));
  const blob = new Blob(['setInterval(()=>postMessage(0),1000)'], { type: 'text/javascript' });
  E.worker = new Worker(URL.createObjectURL(blob));
  E.worker.onmessage = tick; // worker timers are not throttled when the tab is in the background
  renderEmp();
}
function bump() { if (E.state !== 'lunch') E.lastAct = Date.now(); }

async function loadEmpData() {
  const d = todayIST();
  const { data: tasks } = await sb.from('tasks').select('*').eq('user_id', me.id).order('created_at', { ascending: false });
  $('eTasks').innerHTML = (tasks && tasks.length) ? tasks.map((t) => `<label class="task ${t.done ? 'done' : ''}"><input type="checkbox" data-id="${t.id}" ${t.done ? 'checked' : ''}><span>${esc(t.title)}</span>${t.due ? `<span class="muted">due ${esc(t.due)}</span>` : ''}</label>`).join('') : 'No tasks.';
  $('eTasks').querySelectorAll('input').forEach((c) => c.onchange = async () => { await sb.rpc('rpc_complete_task', { p_id: c.dataset.id, p_done: c.checked }); loadEmpData(); });
  const { data: wl } = await sb.from('worklog').select('*').eq('user_id', me.id).eq('work_date', d).maybeSingle();
  if (wl) { $('wlPlan').value = wl.plan; $('wlSum').value = wl.summary; }
}
$('wlSave').onclick = async () => {
  const { error } = await sb.from('worklog').upsert({ user_id: me.id, work_date: todayIST(), plan: $('wlPlan').value, summary: $('wlSum').value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,work_date' });
  $('wlOk').textContent = error ? error.message : 'Saved';
  setTimeout(() => $('wlOk').textContent = '', 3000);
};

/* ---- screen share (entire monitor only) ---- */
async function startShare() {
  $('gateErr').textContent = '';
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor', frameRate: { ideal: 10, max: 15 }, width: { max: 1920 } }, audio: false,
      selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'include', preferCurrentTab: false
    });
  } catch (e) { $('gateErr').textContent = 'Screen sharing was cancelled. It is required to work.'; return; }
  const track = stream.getVideoTracks()[0];
  const surface = (track.getSettings() || {}).displaySurface;
  if (surface !== 'monitor') {
    stream.getTracks().forEach((t) => t.stop());
    $('gateErr').textContent = 'You shared a window or tab. Please choose "Entire Screen" and select your monitor.';
    sb.rpc('rpc_event', { p_kind: 'wrong_surface', p_detail: `Tried to share: ${surface || 'unknown'}` });
    return;
  }
  track.contentHint = 'detail';
  track.onended = () => { E.stream = null; closeAllPcs(); sb.rpc('rpc_event', { p_kind: 'share_stopped' }); sendHb(); renderEmp(); $('gate').classList.remove('hidden'); };
  E.stream = stream;
  E.video = document.createElement('video'); E.video.muted = true; E.video.playsInline = true; E.video.srcObject = stream; await E.video.play().catch(() => {});
  E.cv = document.createElement('canvas'); E.cv.width = 192; E.cv.height = 108; E.ctx = E.cv.getContext('2d', { willReadFrequently: true }); E.prev = null;
  $('gate').classList.add('hidden');
  E.lastAct = Date.now();
  sb.rpc('rpc_event', { p_kind: 'share_started', p_detail: 'Entire screen' });
  sendHb(); renderEmp();
}
$('gateBtn').onclick = startShare;

function sample() {
  if (!E.stream || !E.video || E.video.readyState < 2) return 0;
  E.ctx.drawImage(E.video, 0, 0, 192, 108);
  const px = E.ctx.getImageData(0, 0, 192, 108).data; const n = 192 * 108; const lum = new Uint8Array(n);
  for (let i = 0; i < n; i++) lum[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
  let changed = 0;
  if (E.prev) for (let i = 0; i < n; i++) if (Math.abs(lum[i] - E.prev[i]) > CFG.lumThresh) changed++;
  E.prev = lum;
  return (changed / n) * 100;
}

function tick() {
  const now = Date.now();
  const pct = sample(); E.change = pct;
  if (pct >= CFG.diffPct && E.state !== 'lunch') E.lastAct = now;
  if (E.state !== 'lunch') {
    const idle = now - E.lastAct >= CFG.idleMs;
    if (idle && E.state !== 'idle') { E.state = 'idle'; E.idleSince = now; sendHb(); renderEmp(); }
    else if (!idle && E.state === 'idle') { E.state = 'active'; E.idleSince = null; sendHb(); renderEmp(); }
  }
  if (now - E.lastHb >= CFG.hbMs) sendHb();
  if (now % 30000 < 1000) renderEmp(true);
}
async function sendHb() {
  E.lastHb = Date.now();
  await sb.rpc('rpc_heartbeat', { p_state: E.state, p_sharing: !!E.stream, p_change: +E.change.toFixed(3), p_surface: E.stream ? 'monitor' : null });
}
/* ---- lunch / logout ---- */
$('eLunch').onclick = async () => {
  if (E.state === 'lunch') {
    await sb.rpc('rpc_end_lunch'); E.state = 'active'; E.lunchStart = null; E.lastAct = Date.now();
  } else {
    await sb.rpc('rpc_start_lunch'); E.state = 'lunch'; E.lunchStart = new Date().toISOString();
  }
  sendHb(); renderEmp();
};
async function empLogout() {
  if (!confirm('Log out for the day? Your screen sharing will stop.')) return;
  if (E.stream) E.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  E.stream = null; closeAllPcs(); if (E.worker) E.worker.terminate();
  await sb.rpc('rpc_logout'); await sb.auth.signOut(); location.reload();
}
$('eOut').onclick = empLogout; $('gateOut').onclick = empLogout;

async function renderEmp() {
  const st = E.state;
  $('eState').className = 'pill ' + st; $('eState').textContent = { active: 'Working', idle: 'On break (idle)', lunch: 'Lunch' }[st];
  $('eShare').className = 'pill ' + (E.stream ? 'active' : 'offline'); $('eShare').textContent = E.stream ? 'Entire screen shared' : 'Screen not shared';
  $('eLunch').textContent = st === 'lunch' ? 'End lunch' : 'Start lunch';
  $('eBanner').innerHTML = st === 'idle' ? `<div class="alert warn">Break started: no activity for 5 minutes (since ${fmtT(E.idleSince)}). Work on your screen to resume.</div>` : '';
  const { data: a } = await sb.rpc('rpc_my_today');
  if (a && a.login_at) { $('eActive').textContent = dur(a.active_seconds); $('eIdle').textContent = dur(a.idle_seconds); }
  const { data: l } = await sb.from('breaks').select('*').eq('user_id', me.id).eq('kind', 'lunch').eq('work_date', todayIST()).order('start_at');
  if (l && l.length) {
    const tot = l.reduce((s, b) => s + ((b.end_at ? new Date(b.end_at) : new Date()) - new Date(b.start_at)) / 1000, 0);
    $('eLunchT').textContent = dur(tot);
    $('eLunchS').innerHTML = `${fmtT(l[0].start_at)} to ${l[l.length - 1].end_at ? fmtT(l[l.length - 1].end_at) : 'now'}`;
  } else { $('eLunchT').textContent = '-'; $('eLunchS').textContent = 'Allowed: 60 min'; }
}

/* ---- WebRTC (employee = sender, signaling over a private Supabase Realtime channel) ---- */
function initSignaling() {
  E.sig = sb.channel('screen:' + me.id, { config: { private: true, broadcast: { self: false } } });
  E.sig.on('broadcast', { event: 'want' }, ({ payload }) => onWant(payload.from))
    .on('broadcast', { event: 'answer' }, async ({ payload }) => {
      if (payload.to !== me.id) return; const pc = E.pcs.get(payload.from); if (!pc) return;
      await pc.setRemoteDescription(payload.sdp); flushIce(payload.from, pc);
    })
    .on('broadcast', { event: 'ice' }, async ({ payload }) => {
      if (payload.to !== me.id) return; const pc = E.pcs.get(payload.from);
      if (pc && pc.remoteDescription) pc.addIceCandidate(payload.c).catch(() => {});
      else { const q = E.ice.get(payload.from) || []; q.push(payload.c); E.ice.set(payload.from, q); }
    }).subscribe();
}
function flushIce(id, pc) { (E.ice.get(id) || []).forEach((c) => pc.addIceCandidate(c).catch(() => {})); E.ice.delete(id); }
function closeAllPcs() { E.pcs.forEach((pc) => pc.close()); E.pcs.clear(); }
async function onWant(viewer) {
  if (!E.stream) return;
  const old = E.pcs.get(viewer);
  if (old && ['new', 'connecting', 'connected'].includes(old.connectionState)) return;
  if (old) old.close();
  const pc = new RTCPeerConnection({ iceServers: CFG.iceServers }); E.pcs.set(viewer, pc);
  E.stream.getTracks().forEach((t) => pc.addTrack(t, E.stream));
  pc.onicecandidate = (e) => { if (e.candidate) E.sig.send({ type: 'broadcast', event: 'ice', payload: { from: me.id, to: viewer, c: e.candidate } }); };
  try {
    const sender = pc.getSenders()[0]; const p = sender.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = 1500000; p.encodings[0].maxFramerate = 10; await sender.setParameters(p);
  } catch (_) { /* optional */ }
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  E.sig.send({ type: 'broadcast', event: 'offer', payload: { from: me.id, to: viewer, sdp: pc.localDescription } });
}

/* ============================== MANAGER ============================== */
const M = { emp: null, sal: 0, sig: null, pc: null, viewer: Math.random().toString(36).slice(2), connected: false, ice: [], pres: null, att: null, feed: [], tab: 'live' };

async function startManager() {
  $('attMonth').value = $('payMonth').value = todayIST().slice(0, 7);
  const { data: emps } = await sb.from('profiles').select('*').eq('role', 'employee').limit(1);
  M.emp = emps && emps[0]; if (!M.emp) { $('mAlerts').innerHTML = '<div class="alert">No employee found.</div>'; return; }
  $('tabs').onclick = (e) => { const t = e.target.dataset.t; if (!t) return; M.tab = t; [...$('tabs').children].forEach((b) => b.classList.toggle('on', b === e.target)); ['live', 'att', 'pay', 'work', 'hol'].forEach((k) => $('t-' + k).classList.toggle('hidden', k !== t)); loadTab(t); };
  await refreshLive();
  watchScreen();
  const ch = sb.channel('mgr-db');
  ['presence', 'events', 'attendance', 'breaks', 'tasks'].forEach((t) => ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => { if (M.tab === 'live') refreshLive(); else if (M.tab === 'work') loadTab(M.tab); }));
  ch.subscribe();
  setInterval(() => { $('mClock').textContent = new Date().toLocaleString('en-IN', { timeZone: CFG.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: true }); renderLive(); }, 5000);
  setInterval(() => { if (M.tab === 'live') refreshLive(); }, 30000);
}
$('mOut').onclick = async () => { await sb.auth.signOut(); location.reload(); };
$('mFs').onclick = () => $('mVideo').parentElement.requestFullscreen && $('mVideo').parentElement.requestFullscreen();

function watchScreen() {
  M.sig = sb.channel('screen:' + M.emp.id, { config: { private: true, broadcast: { self: false } } });
  M.sig.on('broadcast', { event: 'offer' }, async ({ payload }) => {
    if (payload.to !== M.viewer) return;
    if (M.pc) M.pc.close(); M.ice = [];
    const pc = new RTCPeerConnection({ iceServers: CFG.iceServers }); M.pc = pc;
    pc.ontrack = (e) => { $('mVideo').srcObject = e.streams[0]; $('mVideo').play().catch(() => {}); };
    pc.onicecandidate = (e) => { if (e.candidate) M.sig.send({ type: 'broadcast', event: 'ice', payload: { from: M.viewer, to: payload.from, c: e.candidate } }); };
    pc.onconnectionstatechange = () => { M.connected = pc.connectionState === 'connected'; setLive(M.connected); };
    await pc.setRemoteDescription(payload.sdp); M.ice.forEach((c) => pc.addIceCandidate(c).catch(() => {})); M.ice = [];
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    M.sig.send({ type: 'broadcast', event: 'answer', payload: { from: M.viewer, to: payload.from, sdp: pc.localDescription } });
  }).on('broadcast', { event: 'ice' }, ({ payload }) => {
    if (payload.to !== M.viewer) return;
    if (M.pc && M.pc.remoteDescription) M.pc.addIceCandidate(payload.c).catch(() => {}); else M.ice.push(payload.c);
  }).subscribe((s) => { if (s === 'SUBSCRIBED') want(); });
  setInterval(() => { if (!M.connected) want(); }, 4000);
}
function want() { if (M.sig) M.sig.send({ type: 'broadcast', event: 'want', payload: { from: M.viewer } }); }
function setLive(on) {
  $('mBadge').className = 'badge pill ' + (on ? 'active' : 'offline'); $('mBadge').textContent = on ? 'LIVE' : 'Waiting';
  $('mMsg').classList.toggle('hidden', on);
}

async function refreshLive() {
  const d = todayIST(); const id = M.emp.id;
  const [p, a, b, ev, lg] = await Promise.all([
    sb.from('presence').select('*').eq('user_id', id).maybeSingle(),
    sb.from('attendance').select('*').eq('user_id', id).eq('work_date', d).maybeSingle(),
    sb.from('breaks').select('*').eq('user_id', id).eq('work_date', d).order('start_at'),
    sb.from('events').select('*').eq('user_id', id).gte('ts', dayStart(d).toISOString()).order('ts', { ascending: false }).limit(60),
    sb.from('activity_log').select('ts,state,sharing').eq('user_id', id).gte('ts', dayStart(d).toISOString()).order('ts')
  ]);
  M.pres = p.data; M.att = a.data; M.breaks = b.data || []; M.feed = ev.data || []; M.log = lg.data || [];
  renderLive();
}

function statusOf() {
  const p = M.pres, a = M.att; const now = Date.now();
  const lateCut = new Date(dayStart(todayIST()).getTime() + (10 * 60 + CFG.grace) * 60000 + 60000);
  if (!a) return now > lateCut ? { k: 'absent', t: 'Not logged in (late)' } : { k: 'pending', t: 'Not logged in yet' };
  if (a.logout_at) return { k: 'offline', t: 'Logged out' };
  if (!p || !p.last_seen || now - new Date(p.last_seen) > 75000) return { k: 'lost', t: 'Connection lost' };
  return { k: p.state, t: { active: 'Working', idle: 'On break (idle)', lunch: 'At lunch' }[p.state] };
}

function renderLive() {
  if (!M.emp) return;
  const a = M.att, p = M.pres, s = statusOf(), now = Date.now();
  const alerts = [];
  if (!a && s.k === 'absent') alerts.push(['alert', `${M.emp.full_name} has not logged in. 10:10 AM has passed. A late/absent deduction applies.`]);
  if (a && !a.logout_at && p && !p.sharing && s.k !== 'lost') alerts.push(['alert', 'Screen sharing is OFF.']);
  if (s.k === 'lost') alerts.push(['alert warn', 'Connection lost: no heartbeat for over 75 seconds (tab closed, computer asleep, or no internet).']);
  if (a && a.late) alerts.push(['alert warn', `Late login at ${fmtT(a.login_at)}. 1/4 of today's pay will be cut.`]);
  $('mAlerts').innerHTML = alerts.map(([c, t]) => `<div class="${c}">${esc(t)}</div>`).join('');
  const lunches = (M.breaks || []).filter((b) => b.kind === 'lunch');
  const lunchSec = lunches.reduce((x, b) => x + ((b.end_at ? new Date(b.end_at) : new Date()) - new Date(b.start_at)) / 1000, 0);
  const active = a ? a.active_seconds : 0, idle = a ? a.idle_seconds : 0;
  const prod = active + idle ? Math.round(active / (active + idle) * 100) : 0;
  const worked = a ? ((a.logout_at ? new Date(a.logout_at) : new Date()) - new Date(a.login_at)) / 1000 - lunchSec : 0;
  const la = p && p.last_activity ? Math.round((now - new Date(p.last_activity)) / 60000) : null;
  const tile = (k, v, sub = '') => `<div class="card tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  $('mTiles').innerHTML =
    tile('Status', `<span class="pill ${s.k}">${s.t}</span>`, p && p.sharing ? 'Entire screen shared' : 'Not sharing') +
    tile('Login', a ? fmtT(a.login_at) : '-', a ? (a.late ? '<span class="pill late">Late</span>' : '<span class="pill present">On time</span>') : 'Shift 10:00, grace to 10:10') +
    tile('Lunch', lunches.length ? dur(lunchSec) : '-', lunches.length ? `${fmtT(lunches[0].start_at)} to ${lunches[lunches.length - 1].end_at ? fmtT(lunches[lunches.length - 1].end_at) : 'now'}${lunchSec > CFG.lunchMin * 60 ? ' (over 60m)' : ''}` : 'Allowed 60 min') +
    tile('Logout', a && a.logout_at ? fmtT(a.logout_at) : '-', a && !a.logout_at ? 'Still working' : '') +
    tile('Net working time', dur(worked), 'login to now, minus lunch') +
    tile('Active', dur(active), 'screen/keyboard activity') +
    tile('Idle breaks', dur(idle), `${(M.breaks || []).filter((b) => b.kind === 'idle').length} breaks (5+ min no activity)`) +
    tile('Productivity', a ? prod + '%' : '-', 'active ÷ (active + idle)') +
    tile('Last activity', la === null ? '-' : (la < 1 ? 'just now' : la + ' min ago'), '');
  const lbl = { login: 'Logged in', logout: 'Logged out', lunch_start: 'Lunch started', lunch_end: 'Lunch ended', idle_start: 'Break started (idle)', idle_end: 'Back from break', share_started: 'Started sharing entire screen', share_stopped: 'STOPPED screen sharing', wrong_surface: 'Tried sharing a window/tab (rejected)' };
  $('mFeed').innerHTML = M.feed.length ? M.feed.map((e) => `<div><time>${fmtT(e.ts)}</time><span>${esc(lbl[e.kind] || e.kind)}${e.detail ? ` <span class="muted">${esc(e.detail)}</span>` : ''}</span></div>`).join('') : '<span class="muted">No events yet today.</span>';
  drawTimeline();
}

function drawTimeline() {
  const cv = $('tl'); const dpr = window.devicePixelRatio || 1; const w = cv.clientWidth, h = 46;
  cv.width = w * dpr; cv.height = h * dpr; const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const d0 = dayStart(todayIST()).getTime(); const t0 = d0 + 9 * 3600e3, t1 = d0 + 20 * 3600e3; const X = (t) => ((t - t0) / (t1 - t0)) * w;
  c.fillStyle = '#3a4556'; c.fillRect(0, 0, w, 30);
  const col = { active: '#2ea66a', idle: '#e0a21f', lunch: '#4f8cff' };
  const log = M.log || [];
  log.forEach((r, i) => {
    const a = new Date(r.ts).getTime(); const nxt = log[i + 1] ? new Date(log[i + 1].ts).getTime() : a + CFG.hbMs; const b = Math.min(nxt, a + 60000);
    c.fillStyle = col[r.state] || '#3a4556'; c.fillRect(X(a), 0, Math.max(1, X(b) - X(a)), 30);
    if (!r.sharing) { c.fillStyle = '#e5534b'; c.fillRect(X(a), 34, Math.max(1, X(b) - X(a)), 6); }
  });
  c.fillStyle = '#8b98a9'; c.font = '10px system-ui';
  for (let hr = 9; hr <= 20; hr += 1) { const x = X(d0 + hr * 3600e3); c.fillRect(x, 30, 1, 3); if (hr % 2 === 1) c.fillText((hr % 12 || 12) + (hr < 12 ? 'a' : 'p'), x + 2, 45); }
  const nx = X(Date.now()); c.fillStyle = '#fff'; c.fillRect(nx, 0, 1.5, 32);
  $('tlRange').textContent = `${fmtD(Date.now())}`;
}

/* ---- tabs ---- */
function loadTab(t) { ({ live: refreshLive, att: loadAtt, pay: loadPay, work: loadWork, hol: loadHol })[t](); }
$('attMonth').onchange = loadAtt; $('payMonth').onchange = loadPay;
const monthRange = (m) => { const [y, mo] = m.split('-').map(Number); const last = new Date(y, mo, 0).getDate(); return [`${m}-01`, `${m}-${String(last).padStart(2, '0')}`]; };
const statusLbl = { present: 'Present', late: 'Late', absent: 'Absent', sunday: 'Sunday', holiday: 'Holiday', pending: 'Today', future: '' };

async function loadAtt() {
  const m = $('attMonth').value; const [s, e] = monthRange(m);
  const [pay, att, br] = await Promise.all([
    sb.rpc('payroll_month', { p_user: M.emp.id, p_month: s }),
    sb.from('attendance').select('*').eq('user_id', M.emp.id).gte('work_date', s).lte('work_date', e),
    sb.from('breaks').select('*').eq('user_id', M.emp.id).gte('work_date', s).lte('work_date', e)
  ]);
  const A = Object.fromEntries((att.data || []).map((r) => [r.work_date, r])); const B = br.data || [];
  const rows = (pay.data.days || []).filter((d) => d.status !== 'future').reverse().map((d) => {
    const a = A[d.day]; const lunch = B.filter((b) => b.work_date === d.day && b.kind === 'lunch').reduce((x, b) => x + (b.end_at ? (new Date(b.end_at) - new Date(b.start_at)) / 1000 : 0), 0);
    const idles = B.filter((b) => b.work_date === d.day && b.kind === 'idle').length;
    const hrs = a && a.logout_at ? (new Date(a.logout_at) - new Date(a.login_at)) / 1000 - lunch : null;
    return `<tr><td>${fmtD(d.day + 'T12:00:00+05:30')}</td><td><span class="pill ${d.status}">${statusLbl[d.status]}${d.holiday ? ': ' + esc(d.holiday) : ''}</span></td><td>${a ? fmtT(a.login_at) : '-'}</td><td>${a && a.logout_at ? fmtT(a.logout_at) : '-'}</td><td>${lunch ? dur(lunch) : '-'}</td><td>${hrs !== null ? dur(hrs) : '-'}</td><td>${a ? dur(a.active_seconds) : '-'}</td><td>${a ? dur(a.idle_seconds) + ` (${idles})` : '-'}</td></tr>`;
  });
  $('attTable').innerHTML = '<tr><th>Date</th><th>Status</th><th>Login</th><th>Logout</th><th>Lunch</th><th>Net hours</th><th>Active</th><th>Idle (breaks)</th></tr>' + rows.join('');
}

async function loadPay() {
  const m = $('payMonth').value; const [s] = monthRange(m);
  const { data: p, error } = await sb.rpc('payroll_month', { p_user: M.emp.id, p_month: s });
  if (error) { $('payTiles').innerHTML = `<div class="alert">${esc(error.message)}</div>`; return; }
  M.sal = p.salary; $('salIn').value = p.salary;
  const tile = (k, v, sub = '') => `<div class="card tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  $('payTiles').innerHTML = tile('Monthly salary', inr(p.salary), `Day rate ${inr(p.day_rate)} (÷ ${p.days_in_month} days)`) +
    tile('Late logins', p.late_count, `${inr(p.late_deduction)} cut (1/4 day each)`) + tile('Absent days', p.absent_count, `${inr(p.absent_deduction)} not paid`) +
    tile('Total deductions', inr(p.total_deduction)) + tile('Net pay', `<span style="color:var(--ok)">${inr(p.net)}</span>`, 'so far, future days not deducted');
  $('payTable').innerHTML = '<tr><th>Date</th><th>Status</th><th>Login</th><th>Deduction</th></tr>' + p.days.filter((d) => d.status !== 'future').map((d) => `<tr><td>${fmtD(d.day + 'T12:00:00+05:30')}</td><td><span class="pill ${d.status}">${statusLbl[d.status]}${d.holiday ? ': ' + esc(d.holiday) : ''}</span></td><td>${fmtT(d.login_at)}</td><td>${d.deduction > 0 ? '-' + inr(d.deduction) : '-'}</td></tr>`).join('');
}
$('salSave').onclick = async () => {
  const v = Number($('salIn').value); if (!(v >= 0)) return;
  if (!confirm(`Change monthly salary from ${inr(M.sal)} to ${inr(v)}?`)) return;
  const { error } = await sb.from('compensation').update({ monthly_salary: v }).eq('user_id', M.emp.id); if (error) alert(error.message); loadPay();
};

async function loadWork() {
  const [t, w] = await Promise.all([
    sb.from('tasks').select('*').eq('user_id', M.emp.id).order('created_at', { ascending: false }).limit(50),
    sb.from('worklog').select('*').eq('user_id', M.emp.id).order('work_date', { ascending: false }).limit(14)
  ]);
  $('tkList').innerHTML = (t.data || []).map((k) => `<div class="task ${k.done ? 'done' : ''}"><span>${esc(k.title)}</span><span class="muted">${k.due ? 'due ' + esc(k.due) : ''}</span><span class="sp" style="flex:1"></span>${k.done ? `<span class="pill present">Done ${fmtT(k.done_at)}</span>` : '<span class="pill pending">Open</span>'}</div>`).join('') || '<span class="muted">No tasks.</span>';
  $('wlList').innerHTML = (w.data || []).map((r) => `<div style="margin-bottom:12px"><b>${fmtD(r.work_date + 'T12:00:00+05:30')}</b><div class="muted">Plan</div><div>${esc(r.plan) || '-'}</div><div class="muted">Summary</div><div>${esc(r.summary) || '-'}</div></div>`).join('') || '<span class="muted">No work logs yet.</span>';
}
$('tkAdd').onclick = async () => {
  const title = $('tkTitle').value.trim(); if (!title) return;
  await sb.from('tasks').insert({ user_id: M.emp.id, title, due: $('tkDue').value || null }); $('tkTitle').value = ''; loadWork();
};

async function loadHol() {
  const { data } = await sb.from('holidays').select('*').order('day', { ascending: false });
  $('hTable').innerHTML = '<tr><th>Date</th><th>Festival</th><th></th></tr>' + (data || []).map((h) => `<tr><td>${fmtD(h.day + 'T12:00:00+05:30')}</td><td>${esc(h.name)}</td><td><button class="ghost" data-d="${h.day}">Remove</button></td></tr>`).join('');
  $('hTable').querySelectorAll('button').forEach((b) => b.onclick = async () => { if (confirm('Remove this holiday?')) { await sb.from('holidays').delete().eq('day', b.dataset.d); loadHol(); } });
}
$('hAdd').onclick = async () => {
  const day = $('hDate').value, name = $('hName').value.trim(); if (!day || !name) return;
  const { error } = await sb.from('holidays').upsert({ day, name }); if (error) alert(error.message); $('hName').value = ''; loadHol();
};
