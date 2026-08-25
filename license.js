// ── 라이선스(1회용 체험 키) — 메인 프로세스 전용 ────────────────────────────
// 목표: ① 테스터에게 준 키는 딱 한 번만 활성화되고 ② 사용 기간은 발급자만 정하며
//       ③ 로컬에서 기간을 늘릴 수 없다.
//
// 구조
//   관리자 PC : 개인키(%USERPROFILE%\.pdfeditor-license\admin.json)로 키 발급 + 활성화 서버 운영
//   배포본    : 공개키만 내장(PUBKEY_B64). 검증만 할 수 있고 발급은 불가.
//   활성화    : 앱이 서버에 {키, 기기지문}을 보내면 서버가 키를 '소진' 처리하고
//               만료일이 박힌 서명 토큰을 돌려준다 → userData/license.dat 에 저장.
//   이후      : 만료일까지 오프라인 동작. 7일마다 서버 재확인(실패해도 3일 유예).
//
// 왜 서버가 필요한가: 오프라인만으로는 "같은 키를 다른 PC에 또 입력"을 막을 수 없다.
// 기기 바인딩은 흔적을 지우면 뚫리지만, 서버가 소진을 기록하면 진짜 1회용이 된다.
//
// ⚠ 이 파일은 평문 JS다. 2단계 하드닝(asar + bytenode)에서 바이트코드로 굳힌다.
//   그전까지는 "검사 코드를 지우는" 우회가 가능하다는 점을 감안할 것.
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const crypto  = require('crypto');
const { execFileSync } = require('child_process');

// 발급자 공개키(Ed25519, SPKI DER base64). 짝이 되는 개인키는 관리자 PC에만 있다.
// 이 상수를 바꾸면 기존에 발급한 모든 라이선스가 무효가 된다.
const PUBKEY_B64 = 'MCowBQYDK2VwAyEAFkgCJ0QV1dI2bT/0ShE9vWXT2tWI6asH/kH7fZ8PPug=';

const RECHECK_DAYS = 7;    // 서버 재확인 주기
const GRACE_DAYS   = 3;    // 재확인 실패 시 계속 쓸 수 있는 유예
const DAY = 86400000;

let _deps = null;          // { userDataDir, appVersion }
let _state = null;         // 캐시된 판정 결과
let _rechecking = false;

// ── 경로 ────────────────────────────────────────────────────────────────────
// 관리자 자료는 userData가 아니라 홈 폴더에 둔다 — 개발 실행(npm start)과 포터블 실행의
// userData 경로가 달라서, userData에 두면 "개발에선 관리자, 배포본에선 아님"이 된다.
function adminDir()  { return path.join(os.homedir(), '.pdfeditor-license'); }
function adminPath() { return path.join(adminDir(), 'admin.json'); }
function keysPath()  { return path.join(adminDir(), 'keys.json'); }
function tokenPath() { return path.join(_deps.userDataDir, 'license.dat'); }

// ── base64url ───────────────────────────────────────────────────────────────
const b64u  = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ── 토큰: base64url(payload).base64url(sig) — JWT와 같은 모양의 최소 구현 ────
function signToken(payload, privPem) {
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign(null, Buffer.from(body, 'utf8'), crypto.createPrivateKey(privPem));
  return body + '.' + b64u(sig);
}
function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const pub = crypto.createPublicKey({
      key: Buffer.from(PUBKEY_B64, 'base64'), format: 'der', type: 'spki',
    });
    if (!crypto.verify(null, Buffer.from(body, 'utf8'), pub, unb64u(sig))) return null;
    return JSON.parse(unb64u(body).toString('utf8'));
  } catch (e) { return null; }
}

// ── 기기 지문(HWID) ─────────────────────────────────────────────────────────
// 레지스트리 MachineGuid + 메인보드/시스템 UUID + 호스트명을 해시. 한 항목을 못 읽어도
// 나머지로 계속 진행한다(가상머신·권한 제한 환경 대비). 사용자 식별 정보는 남기지 않는다.
let _hwid = null;
function hwid() {
  if (_hwid) return _hwid;
  const parts = [];
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
    if (m) parts.push('mg:' + m[1]);
  } catch (e) {}
  try {
    const out = execFileSync('powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    const u = String(out).trim();
    if (u && !/^0{8}-/.test(u)) parts.push('uuid:' + u);
  } catch (e) {}
  parts.push('host:' + os.hostname());
  _hwid = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return _hwid;
}

// ── 시계 되돌리기 방어 ──────────────────────────────────────────────────────
// 마지막으로 본 시각을 토큰 파일 옆과 레지스트리 두 곳에 남긴다. 둘 중 큰 값보다
// 현재 시각이 (여유 10분을 넘겨) 과거면 시계를 되돌린 것으로 보고 만료로 취급한다.
// 두 곳을 다 지우면 초기화되지만, 그 시점엔 서버 재확인이 걸린다.
const REG_KEY = 'HKCU\\Software\\PDFEditor\\Lic';
function readMarks() {
  const vals = [];
  try { vals.push(parseInt(fs.readFileSync(path.join(_deps.userDataDir, 'lic.mark'), 'utf8'), 36) || 0); } catch (e) {}
  try {
    // stderr 무시 — 값이 아직 없을 때 reg가 콘솔에 오류를 찍는 것을 막는다(정상 상황)
    const out = execFileSync('reg', ['query', REG_KEY, '/v', 'st'],
      { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/st\s+REG_SZ\s+(\w+)/i);
    if (m) vals.push(parseInt(m[1], 36) || 0);
  } catch (e) {}
  return vals.length ? Math.max(...vals) : 0;
}
function writeMark(t) {
  const s = Math.floor(t).toString(36);
  try { fs.writeFileSync(path.join(_deps.userDataDir, 'lic.mark'), s, 'utf8'); } catch (e) {}
  try {
    execFileSync('reg', ['add', REG_KEY, '/v', 'st', '/t', 'REG_SZ', '/d', s, '/f'],
      { windowsHide: true, timeout: 5000, stdio: 'ignore' });
  } catch (e) {}
}

// ── 관리자 여부 ─────────────────────────────────────────────────────────────
// 개인키를 가진 PC = 발급자 본인 → 항상 무제한 사용(자기 앱이 만료되는 사고 방지).
function adminData() {
  try {
    const j = JSON.parse(fs.readFileSync(adminPath(), 'utf8'));
    if (j && j.priv && j.pub) return j;
  } catch (e) {}
  return null;
}
function isAdminPC() {
  const a = adminData();
  // 개인키가 이 앱의 공개키와 짝인지까지 확인 — 남의 admin.json을 갖다 놔도 소용없다.
  if (!a || a.pub !== PUBKEY_B64) return false;
  try {
    const t = signToken({ probe: 1 }, a.priv);
    return !!verifyToken(t);
  } catch (e) { return false; }
}

// ── 토큰 저장/로드 ──────────────────────────────────────────────────────────
function loadToken() {
  try { return fs.readFileSync(tokenPath(), 'utf8').trim(); } catch (e) { return ''; }
}
function saveToken(tok) {
  try { fs.writeFileSync(tokenPath(), tok, 'utf8'); return true; } catch (e) { return false; }
}

// ── 상태 판정 ───────────────────────────────────────────────────────────────
// mode: 'admin' | 'licensed' | 'expired' | 'none'
// canSave 는 저장·출력 길목이 참조하는 유일한 값이다.
function evaluate() {
  const now = Date.now();
  if (isAdminPC()) return { mode: 'admin', canSave: true, label: '관리자 PC (무제한)' };

  const tok = loadToken();
  if (!tok) return { mode: 'none', canSave: false, label: '체험 키 미등록', reason: '체험 키를 등록해야 저장·출력이 가능합니다.' };

  const p = verifyToken(tok);
  if (!p) return { mode: 'expired', canSave: false, label: '라이선스 파일 손상', reason: '라이선스가 위조되었거나 손상되었습니다 — 키를 다시 등록하세요.' };
  if (p.hwid !== hwid()) return { mode: 'expired', canSave: false, label: '다른 PC의 라이선스', reason: '이 라이선스는 다른 PC에 발급된 것입니다.' };

  const mark = readMarks();
  if (mark && now < mark - 10 * 60000) {
    return { mode: 'expired', canSave: false, label: '시스템 시계 이상', expiresAt: p.exp,
             reason: '시스템 시계가 과거로 돌아갔습니다 — 시계를 맞춘 뒤 다시 실행하세요.' };
  }
  writeMark(Math.max(now, mark));

  if (now > p.exp) {
    return { mode: 'expired', canSave: false, expiresAt: p.exp, key: p.key,
             label: '체험 기간 종료', reason: `체험 기간이 ${new Date(p.exp).toLocaleDateString('ko-KR')}에 끝났습니다.` };
  }
  // 재확인 기한 + 유예를 넘겼으면 잠금 (서버가 취소했을 수도 있으므로 확인 없이는 못 쓴다)
  if (p.next && now > p.next + GRACE_DAYS * DAY) {
    return { mode: 'expired', canSave: false, expiresAt: p.exp, key: p.key, needRecheck: true,
             label: '서버 재확인 필요', reason: `${RECHECK_DAYS}일마다 필요한 서버 확인이 ${GRACE_DAYS}일 넘게 이뤄지지 않았습니다 — 인터넷 연결 후 다시 실행하세요.` };
  }
  const daysLeft = Math.max(0, Math.ceil((p.exp - now) / DAY));
  return {
    mode: 'licensed', canSave: true, expiresAt: p.exp, key: p.key, daysLeft,
    recheckDue: !!(p.next && now > p.next),
    label: `체험판 · ${daysLeft}일 남음`,
  };
}
function status() {
  if (!_state) _state = evaluate();
  return _state;
}
function refresh() { _state = null; return status(); }
function canSave() { return status().canSave; }

// ── 서버 통신 ───────────────────────────────────────────────────────────────
// 서버 주소는 활성화할 때 받아 토큰과 함께 저장한다(재확인 때 다시 물어보지 않기 위해).
function serverUrlPath() { return path.join(_deps.userDataDir, 'license-server.txt'); }
function savedServer() { try { return fs.readFileSync(serverUrlPath(), 'utf8').trim(); } catch (e) { return ''; } }
function saveServer(u) { try { fs.writeFileSync(serverUrlPath(), String(u || '').trim(), 'utf8'); } catch (e) {} }

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('서버 주소 형식이 올바르지 않습니다.')); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length },
      timeout: timeoutMs || 12000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
        if (!j) return reject(new Error(`서버 응답을 읽을 수 없습니다 (HTTP ${res.statusCode}).`));
        resolve({ statusCode: res.statusCode, json: j });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('서버 응답 시간 초과 — 주소·방화벽을 확인하세요.')); });
    req.on('error', reject);
    req.end(data);
  });
}
function normalizeServer(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

// 체험 키 활성화 — 성공하면 서명 토큰을 저장한다.
async function activate(key, server) {
  const srv = normalizeServer(server);
  if (!srv) return { ok: false, error: '활성화 서버 주소를 입력하세요.' };
  const k = String(key || '').trim().toUpperCase();
  if (!/^PDFE(-[A-Z0-9]{4}){3}$/.test(k)) return { ok: false, error: '키 형식이 올바르지 않습니다. (예: PDFE-A1B2-C3D4-E5F6)' };
  try {
    const r = await postJson(srv + '/lic/activate', { key: k, hwid: hwid(), ver: _deps.appVersion, host: os.hostname() });
    if (r.statusCode !== 200 || !r.json.token) return { ok: false, error: r.json.error || '활성화에 실패했습니다.' };
    const p = verifyToken(r.json.token);
    // 서버가 준 토큰도 반드시 자체 검증 — 가짜 서버를 물려도 통과하지 않는다.
    if (!p || p.hwid !== hwid()) return { ok: false, error: '서버가 보낸 라이선스가 이 PC용이 아닙니다.' };
    saveToken(r.json.token);
    saveServer(srv);
    writeMark(Date.now());
    refresh();
    return { ok: true, status: status() };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '서버에 연결할 수 없습니다.' };
  }
}

// 7일 주기 재확인 — 조용히 실패해도 유예 기간 안에서는 계속 쓸 수 있다.
async function recheckIfDue(force) {
  if (_rechecking) return { ok: false, error: '확인 중' };
  const st = status();
  if (st.mode === 'admin') return { ok: true };
  if (!force && st.mode === 'licensed' && !st.recheckDue) return { ok: true, skipped: true };
  const srv = savedServer();
  const tok = loadToken();
  if (!srv || !tok) return { ok: false, error: '등록된 서버 정보가 없습니다.' };
  _rechecking = true;
  try {
    const r = await postJson(srv + '/lic/recheck', { token: tok, hwid: hwid(), ver: _deps.appVersion }, 8000);
    if (r.statusCode === 200 && r.json.token && verifyToken(r.json.token)) {
      saveToken(r.json.token);
      refresh();
      return { ok: true, status: status() };
    }
    // 서버가 명시적으로 '취소됨'이라고 답하면 즉시 잠근다 (원격 차단)
    if (r.json && r.json.revoked) {
      try { fs.unlinkSync(tokenPath()); } catch (e) {}
      refresh();
      return { ok: false, revoked: true, error: r.json.error || '이 라이선스는 취소되었습니다.' };
    }
    return { ok: false, error: (r.json && r.json.error) || '재확인 실패' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '서버에 연결할 수 없습니다.' };
  } finally { _rechecking = false; }
}

// ── 관리자 기능 (개인키가 있는 PC에서만 동작) ───────────────────────────────
function loadKeys() {
  try { const j = JSON.parse(fs.readFileSync(keysPath(), 'utf8')); return Array.isArray(j.keys) ? j : { keys: [] }; }
  catch (e) { return { keys: [] }; }
}
function saveKeys(db) {
  try { fs.mkdirSync(adminDir(), { recursive: true }); fs.writeFileSync(keysPath(), JSON.stringify(db, null, 2), 'utf8'); return true; }
  catch (e) { return false; }
}
// 혼동 문자(0/O/1/I) 제외 32자 알파벳 — 전화·메신저로 불러줘도 틀리지 않게
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newKeyString() {
  const r = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHA[r[i] % ALPHA.length];
  return 'PDFE-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}
function issueKey({ days, note }) {
  if (!isAdminPC()) return { ok: false, error: '이 PC에는 발급 권한(개인키)이 없습니다.' };
  const d = Math.max(1, Math.min(3650, parseInt(days, 10) || 7));
  const db = loadKeys();
  const key = newKeyString();
  db.keys.unshift({ key, days: d, note: String(note || '').slice(0, 100), status: 'issued', createdAt: Date.now() });
  saveKeys(db);
  return { ok: true, key, days: d };
}
function listKeys() {
  if (!isAdminPC()) return { ok: false, error: '권한 없음', keys: [] };
  return { ok: true, keys: loadKeys().keys };
}
function revokeKey(key) {
  if (!isAdminPC()) return { ok: false, error: '권한 없음' };
  const db = loadKeys();
  const row = db.keys.find(k => k.key === key);
  if (!row) return { ok: false, error: '키를 찾을 수 없습니다.' };
  row.status = 'revoked';
  row.revokedAt = Date.now();
  saveKeys(db);
  // 이미 활성화된 라이선스는 다음 재확인(최대 7+3일) 때 잠긴다 — 즉시 차단은 불가.
  return { ok: true, note: `취소했습니다. 이미 활성화된 PC는 다음 서버 재확인(최대 ${RECHECK_DAYS + GRACE_DAYS}일 이내) 때 잠깁니다.` };
}

function init(deps) {
  _deps = deps;
  _state = null;
  return status();
}

module.exports = {
  init, status, refresh, canSave, hwid, activate, recheckIfDue,
  isAdminPC, adminDir, adminPath, keysPath, adminData,
  issueKey, listKeys, revokeKey, loadKeys, saveKeys,
  signToken, verifyToken, savedServer, saveServer,
  RECHECK_DAYS, GRACE_DAYS, DAY, PUBKEY_B64,
};
