// ── 라이선스 활성화 서버 (관리자 PC 전용) ───────────────────────────────────
// 테스터 앱이 체험 키를 처음 등록할 때만 이 서버에 붙는다. 서버는 키를 '소진' 처리하고
// 만료일이 박힌 서명 토큰을 돌려준다 → 같은 키를 다른 PC에서 다시 쓸 수 없다(진짜 1회용).
//
// 라우트 (둘 다 POST, JSON)
//   /lic/activate {key, hwid, ver, host} → {token} | {error}
//   /lic/recheck  {token, hwid}          → {token} | {error, revoked?}
//
// 보안 메모
// - 개인키가 없는 PC에서는 아예 뜨지 않는다(서명할 수 없으므로).
// - 인터넷에 노출되는 유일한 표면이라 라우트를 이 둘로만 제한하고, 그 밖의 요청은 404.
// - 평문 HTTP라도 만료일 조작은 불가능하다(응답이 Ed25519로 서명돼 있음). 다만 키 자체는
//   전송 중 노출될 수 있으므로, 가능하면 사설망·VPN 또는 리버스 프록시(HTTPS)를 권한다.
// - 키 무차별 대입 방지: IP당 실패 누적으로 차단(15분), 전체 요청도 분당 상한.
const http   = require('http');
const crypto = require('crypto');

const PORT_DEFAULT = 8736;
const DAY = 86400000;

let _lic = null;      // license.js 모듈 (순환 require 대신 주입)
let _cfgIO = null;    // { load(), save(cfg) }
let _srv = null;
let _lastError = '';
let _log = [];        // 최근 활동 (관리자 화면 표시용, 최대 200줄)

function log(line) {
  _log.unshift({ t: Date.now(), line: String(line).slice(0, 200) });
  if (_log.length > 200) _log.length = 200;
}

// ── 남용 방지 ───────────────────────────────────────────────────────────────
const _fails = new Map();   // ip → [실패 시각]
const _hits = [];           // 전체 요청 시각
function tooMany(ip) {
  const now = Date.now();
  while (_hits.length && now - _hits[0] > 60000) _hits.shift();
  if (_hits.length > 120) return '요청이 너무 많습니다.';
  _hits.push(now);
  const f = (_fails.get(ip) || []).filter(t => now - t < 15 * 60000);
  _fails.set(ip, f);
  if (f.length >= 8) return '실패가 많아 15분간 차단되었습니다.';
  return '';
}
function noteFail(ip) {
  const f = _fails.get(ip) || [];
  f.push(Date.now());
  _fails.set(ip, f);
}

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > (limit || 8192)) { req.destroy(); return reject(new Error('본문이 너무 큽니다.')); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 형식 오류')); }
    });
    req.on('error', reject);
  });
}

// ── 활성화 ──────────────────────────────────────────────────────────────────
function doActivate(body, ip) {
  const key = String(body.key || '').trim().toUpperCase();
  const hw  = String(body.hwid || '').trim();
  if (!/^PDFE(-[A-Z0-9]{4}){3}$/.test(key) || !/^[0-9a-f]{24}$/.test(hw)) {
    noteFail(ip);
    return { code: 400, body: { error: '키 또는 기기 정보가 올바르지 않습니다.' } };
  }
  const admin = _lic.adminData();
  if (!admin) return { code: 500, body: { error: '서버에 발급 권한이 없습니다.' } };

  const db = _lic.loadKeys();
  const row = db.keys.find(k => k.key === key);
  if (!row) {
    noteFail(ip);
    log(`거부: 없는 키 ${key} (${ip})`);
    return { code: 404, body: { error: '등록되지 않은 키입니다.' } };
  }
  if (row.status === 'revoked') {
    log(`거부: 취소된 키 ${key} (${ip})`);
    return { code: 403, body: { error: '취소된 키입니다.', revoked: true } };
  }
  // 이미 활성화된 키: 같은 PC면 재발급(재설치·앱 재설정 대비), 다른 PC면 거부 = 1회용의 핵심
  if (row.status === 'activated' && row.hwid && row.hwid !== hw) {
    noteFail(ip);
    log(`거부: 이미 사용된 키 ${key} — 다른 PC (${ip})`);
    return { code: 409, body: { error: '이미 다른 PC에서 사용된 키입니다. 새 키를 요청하세요.' } };
  }

  const now = Date.now();
  // 만료일은 '최초 활성화 시각 + 발급 일수'로 한 번만 확정한다. 재설치로 기간이 늘어나면 안 된다.
  if (row.status !== 'activated') {
    row.status = 'activated';
    row.hwid = hw;
    row.activatedAt = now;
    row.expiresAt = now + row.days * DAY;
    row.host = String(body.host || '').slice(0, 60);
    row.ver = String(body.ver || '').slice(0, 20);
    log(`활성화: ${key} · ${row.days}일 · ${row.host || ip}`);
  } else {
    log(`재발급: ${key} · 같은 PC (${ip})`);
  }
  row.lastSeen = now;
  _lic.saveKeys(db);

  const token = _lic.signToken({
    v: 1, key, hwid: hw,
    iat: now,
    exp: row.expiresAt,
    next: now + _lic.RECHECK_DAYS * _lic.DAY,
    note: row.note || '',
  }, admin.priv);
  return { code: 200, body: { token } };
}

// ── 재확인 ──────────────────────────────────────────────────────────────────
function doRecheck(body, ip) {
  const p = _lic.verifyToken(body.token);
  const hw = String(body.hwid || '').trim();
  if (!p || p.hwid !== hw) { noteFail(ip); return { code: 400, body: { error: '라이선스 정보가 올바르지 않습니다.' } }; }
  const admin = _lic.adminData();
  if (!admin) return { code: 500, body: { error: '서버에 발급 권한이 없습니다.' } };

  const db = _lic.loadKeys();
  const row = db.keys.find(k => k.key === p.key);
  if (!row || row.status === 'revoked') {
    log(`재확인 거부: ${p.key} (취소됨)`);
    return { code: 403, body: { error: '이 라이선스는 취소되었습니다.', revoked: true } };
  }
  if (row.hwid && row.hwid !== hw) {
    noteFail(ip);
    return { code: 409, body: { error: '다른 PC에서 사용 중인 키입니다.' } };
  }
  const now = Date.now();
  row.lastSeen = now;
  _lic.saveKeys(db);
  // 만료일은 절대 늘리지 않는다 — 서버 기록(row.expiresAt)이 언제나 기준이다.
  const token = _lic.signToken({
    v: 1, key: p.key, hwid: hw, iat: now,
    exp: row.expiresAt || p.exp,
    next: now + _lic.RECHECK_DAYS * _lic.DAY,
    note: row.note || '',
  }, admin.priv);
  return { code: 200, body: { token } };
}

// ── 서버 ────────────────────────────────────────────────────────────────────
async function handle(req, res) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'POST' || !/^\/lic\/(activate|recheck)$/.test(url.pathname)) {
    return json(res, 404, { error: 'not found' });
  }
  const blocked = tooMany(ip);
  if (blocked) return json(res, 429, { error: blocked });
  let body;
  try { body = await readBody(req, 8192); }
  catch (e) { return json(res, 400, { error: e.message }); }
  try {
    const r = url.pathname === '/lic/activate' ? doActivate(body, ip) : doRecheck(body, ip);
    return json(res, r.code, r.body);
  } catch (e) {
    _lastError = e.message;
    return json(res, 500, { error: '서버 처리 오류' });
  }
}

function start(cfg) {
  return new Promise((resolve) => {
    if (_srv) return resolve(status());
    if (!_lic.adminData()) { _lastError = '이 PC에는 발급 권한(개인키)이 없어 서버를 켤 수 없습니다.'; return resolve(status()); }
    const srv = http.createServer((req, res) => { handle(req, res).catch(() => { try { json(res, 500, { error: 'x' }); } catch (e) {} }); });
    srv.on('error', (e) => { _lastError = e.message; _srv = null; resolve(status()); });
    srv.listen(cfg.port || PORT_DEFAULT, '0.0.0.0', () => {
      _srv = srv; _lastError = '';
      log(`서버 시작 (포트 ${cfg.port || PORT_DEFAULT})`);
      resolve(status());
    });
  });
}
function stop() {
  if (_srv) { try { _srv.close(); } catch (e) {} _srv = null; log('서버 중지'); }
  return status();
}
function status() {
  const cfg = _cfgIO ? _cfgIO.load() : { enabled: false, port: PORT_DEFAULT };
  return {
    running: !!_srv,
    enabled: !!cfg.enabled,
    port: cfg.port || PORT_DEFAULT,
    isAdmin: !!(_lic && _lic.adminData()),
    lastError: _lastError,
    log: _log.slice(0, 40),
  };
}
async function setEnabled(on, port) {
  const cfg = _cfgIO.load();
  cfg.enabled = !!on;
  if (port) cfg.port = Math.max(1024, Math.min(65535, parseInt(port, 10) || PORT_DEFAULT));
  _cfgIO.save(cfg);
  if (cfg.enabled) return await start(cfg);
  return stop();
}
function init(lic, cfgIO) {
  _lic = lic;
  _cfgIO = cfgIO;
  const cfg = _cfgIO.load();
  if (cfg.enabled) start(cfg);
  return status();
}

module.exports = { init, start, stop, status, setEnabled, PORT_DEFAULT };
