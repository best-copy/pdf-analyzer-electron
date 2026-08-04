// ── 모바일(안드로이드) 연동용 LAN 변환 서버 ─────────────────────────────────
// 사무실 WiFi 안에서 폰이 HWP/Office/Adobe 변환·잉크 판정을 이 PC에 위임한다.
// - main.js의 변환 큐를 그대로 공유(직렬화) — PC 앱 작업과 충돌 없음
// - 토큰 인증(QR로 전달), LAN 바인딩. 외부 인터넷 노출 없음
// - GET /  : 폰 브라우저용 테스트 페이지 (파일 올려 변환 → PDF 다운로드)
// - WoL: 서버가 자신을 깨울 수는 없으므로, 연결정보에 MAC을 실어 폰 앱이
//   매직 패킷을 보낼 수 있게 한다(2단계 앱에서 전송 구현).
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const PORT_DEFAULT  = 8734;
const MAX_BODY      = 300 * 1024 * 1024;   // 업로드 상한 300MB
const EXT_BY_TYPE   = {
  hwp:    ['hwp', 'hwpx'],
  office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'],
  adobe:  ['ai', 'psd', 'indd'],
};

let _deps = null;      // { userDataDir, version, convert:{hwp,office,adobe}, inkCoverage }
let _cfg  = null;      // { enabled, port, token }
let _srv  = null;
let _lastError = '';

// ── 설정 (userData/remote-server.json) ──────────────────────────────────────
function cfgPath() { return path.join(_deps.userDataDir, 'remote-server.json'); }
function loadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    if (j && typeof j === 'object' && j.token) return { enabled: !!j.enabled, port: j.port || PORT_DEFAULT, token: String(j.token) };
  } catch (e) {}
  // 최초 실행: 토큰 생성(QR 입력용이라 혼동 문자 제외 8자)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let token = '';
  const rnd = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) token += alphabet[rnd[i] % alphabet.length];
  const cfg = { enabled: false, port: PORT_DEFAULT, token };
  saveCfg(cfg);
  return cfg;
}
function saveCfg(cfg) {
  try { fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) {}
}

// ── LAN 인터페이스 (IP + MAC — MAC은 폰의 Wake-on-LAN 매직 패킷용) ──────────
function lanInfo() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;           // APIPA 제외
      if (/virtual|vmware|vbox|wsl|loopback/i.test(name)) continue;
      out.push({ iface: name, ip: a.address, mac: (a.mac || '').toUpperCase() });
    }
  }
  return out;
}

// ── 토큰 검사 (헤더 X-Auth-Token 또는 쿼리 ?t=) ─────────────────────────────
// PC가 공인 IP를 직접 가진 환경도 있으므로(사무실 회선에 따라) 무차별 대입 방어:
// 최근 1분간 인증 실패 10회 초과 시 잠시 차단(429).
let _authFails = [];
function authThrottled() {
  const now = Date.now();
  _authFails = _authFails.filter(t => now - t < 60000);
  return _authFails.length >= 10;
}
function checkToken(req, url) {
  const got = String(req.headers['x-auth-token'] || url.searchParams.get('t') || '');
  const want = _cfg.token;
  let ok = false;
  if (got.length === want.length) {
    try { ok = crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (e) { ok = false; }
  }
  if (!ok) _authFails.push(Date.now());
  return ok;
}

// ── 본문 수신 (크기 제한) ───────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('파일이 너무 큽니다 (300MB 초과)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

// ── 요청 처리 ───────────────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // CORS preflight (2단계 Capacitor 앱 오리진 대비)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Auth-Token, X-File-Name, Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  // 연결 확인 — 토큰 불필요(폰 앱의 서버 탐색용, 정보 최소화)
  if (req.method === 'GET' && p === '/ping')
    return json(res, 200, { app: 'pdf-editor-remote', version: _deps.version, host: os.hostname() });

  // 테스트 페이지 — 페이지 자체는 토큰 없이 열리고, 기능 호출에 토큰 필요
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(testPageHtml());
  }

  // 안드로이드 앱 APK 다운로드 — dist에 빌드된 APK가 있으면 제공 (USB 없이 폰 설치)
  if (req.method === 'GET' && p === '/apk') {
    try {
      const apkPath = path.join(__dirname, 'dist', 'PDF분석기-안드로이드-debug.apk');
      if (!fs.existsSync(apkPath)) return json(res, 404, { error: 'APK가 아직 빌드되지 않았습니다.' });
      const apk = fs.readFileSync(apkPath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="pdf-analyzer.apk"',
        'Content-Length': apk.length,
      });
      return res.end(apk);
    } catch (e) { return json(res, 500, { error: String(e && e.message || e) }); }
  }

  if (authThrottled()) return json(res, 429, { error: '인증 시도가 너무 많습니다 — 1분 후 다시 시도하세요.' });
  if (!checkToken(req, url)) return json(res, 401, { error: '인증 실패 — QR을 다시 스캔하거나 토큰을 확인하세요.' });

  // 서버 정보 (토큰 필요) — 연결 화면·WoL 정보
  if (req.method === 'GET' && p === '/info')
    return json(res, 200, { version: _deps.version, host: os.hostname(), lan: lanInfo(), queues: ['hwp', 'office', 'adobe'] });

  // 문서 변환: POST /convert/hwp|office|adobe (본문 = 파일 바이트, X-File-Name = 원본 이름)
  const mConv = p.match(/^\/convert\/(hwp|office|adobe)$/);
  if (req.method === 'POST' && mConv) {
    const type = mConv[1];
    let upPath = null, outPath = null;
    try {
      const rawName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
      const ext = (rawName.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';
      if (!EXT_BY_TYPE[type].includes(ext))
        return json(res, 400, { error: `${type} 변환은 .${EXT_BY_TYPE[type].join(' .')} 파일만 가능합니다 (받은 파일: ${rawName || '이름 없음'})` });
      const body = await readBody(req);
      if (!body.length) return json(res, 400, { error: '파일 내용이 비어 있습니다.' });
      upPath = path.join(os.tmpdir(), `remoteup_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`);
      fs.writeFileSync(upPath, body);
      outPath = await _deps.convert[type](upPath);      // main.js의 큐 공유 — PC 작업과 직렬화
      const pdf = fs.readFileSync(outPath);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rawName.replace(/\.\w+$/, '') + '.pdf')}`,
        'Content-Length': pdf.length,
      });
      return res.end(pdf);
    } catch (e) {
      return json(res, 500, { error: (e && e.message) || String(e) });
    } finally {
      for (const f of [upPath, outPath]) { if (f) { try { fs.unlinkSync(f); } catch (e) {} } }
    }
  }

  // 견적서 인쇄: POST /print/topdf (본문 = HTML utf8) → PDF (모바일엔 printToPDF가 없어 위임)
  if (req.method === 'POST' && p === '/print/topdf') {
    try {
      if (!_deps.htmlToPdf) return json(res, 501, { error: '이 서버 버전은 인쇄 변환을 지원하지 않습니다.' });
      const body = await readBody(req);
      if (!body.length) return json(res, 400, { error: 'HTML 내용이 비어 있습니다.' });
      const pdf = Buffer.from(await _deps.htmlToPdf(body.toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Access-Control-Allow-Origin': '*', 'Content-Length': pdf.length });
      return res.end(pdf);
    } catch (e) {
      return json(res, 500, { error: (e && e.message) || String(e) });
    }
  }

  // 잉크 커버리지: POST /ink/coverage (본문 = PDF 바이트) → 페이지별 CMYK
  if (req.method === 'POST' && p === '/ink/coverage') {
    let tmpPdf = null;
    try {
      const body = await readBody(req);
      if (!body.length) return json(res, 400, { error: 'PDF 내용이 비어 있습니다.' });
      tmpPdf = path.join(os.tmpdir(), `pdfedit_remote_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.pdf`);
      fs.writeFileSync(tmpPdf, body);
      const pages = await _deps.inkCoverage(tmpPdf);
      return json(res, 200, { pages });
    } catch (e) {
      return json(res, 500, { error: (e && e.message) || String(e) });
    } finally {
      if (tmpPdf) { try { fs.unlinkSync(tmpPdf); } catch (e) {} }
    }
  }

  json(res, 404, { error: '알 수 없는 요청: ' + p });
}

// ── 폰 브라우저 테스트 페이지 (1단계 검증용 — 앱 없이 변환 사용 가능) ────────
function testPageHtml() {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF 변환 서버 — 모바일</title>
<style>
  body{margin:0;font-family:'Malgun Gothic',sans-serif;background:#1d1d1f;color:#f5f5f7;padding:20px;}
  h1{font-size:20px;margin:0 0 4px;} h1 b{color:#ffd60a;}
  .hint{color:#98989d;font-size:12.5px;margin-bottom:16px;}
  .card{background:#2c2c2e;border:1px solid #48484a;border-radius:12px;padding:16px;margin-bottom:14px;}
  .card h2{font-size:15px;margin:0 0 10px;color:#ffd60a;}
  input[type=file]{width:100%;color:#f5f5f7;font-size:13px;margin-bottom:10px;}
  button{width:100%;background:#ffd60a;color:#1d1d1f;border:0;border-radius:8px;padding:12px;font-size:15px;font-weight:700;cursor:pointer;}
  button:disabled{background:#48484a;color:#98989d;}
  .stat{margin-top:10px;font-size:13px;color:#98989d;white-space:pre-line;word-break:break-all;}
  .ok{color:#ffd60a;} .err{color:#ff6b6b;}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;}
  td,th{border:1px solid #48484a;padding:4px 6px;text-align:right;} th{color:#ffd60a;}
</style></head><body>
<h1>🖨 PDF 변환 서버 <b>모바일 테스트</b></h1>
<div class="hint">사무실 PC의 한글·Office·Adobe로 변환합니다. 전용 앱이 설치돼 있으면 아래 버튼으로 연결 정보가 앱에 저장됩니다.</div>

<div class="card"><h2>📲 전용 앱으로 연결</h2>
  <button onclick="location.href='pdfeditor://connect' + location.search + '&host=' + location.host">앱에 이 PC 등록</button>
  <div class="stat">PDF 분석기 앱이 설치된 폰에서만 동작합니다 (미설치 시 반응 없음).</div>
  <button style="margin-top:8px;" onclick="location.href='/apk'">⬇ 앱 설치파일(APK) 다운로드</button>
  <div class="stat">다운로드 후 파일을 탭 → '출처를 알 수 없는 앱' 허용 → 설치.</div>
</div>

<div class="card"><h2>📄 문서 → PDF 변환</h2>
  <input type="file" id="convFile" accept=".hwp,.hwpx,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.ai,.psd,.indd">
  <button id="convBtn" onclick="doConvert()">변환 시작</button>
  <div class="stat" id="convStat">HWP·HWPX / DOC·XLSX·PPTX / AI·PSD·INDD 지원</div>
</div>

<div class="card"><h2>🧾 프린터 잉크 판정 (PDF)</h2>
  <input type="file" id="inkFile" accept=".pdf,application/pdf">
  <button id="inkBtn" onclick="doInk()">잉크 커버리지 분석</button>
  <div class="stat" id="inkStat">페이지별 CMYK 비율 — CMY&gt;0 이면 프린터가 컬러로 과금할 수 있는 페이지</div>
</div>

<script>
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const TYPE_BY_EXT = { hwp:'hwp', hwpx:'hwp', doc:'office', docx:'office', xls:'office', xlsx:'office', ppt:'office', pptx:'office', ai:'adobe', psd:'adobe', indd:'adobe' };

async function doConvert() {
  const f = document.getElementById('convFile').files[0];
  const st = document.getElementById('convStat'), btn = document.getElementById('convBtn');
  if (!f) { st.innerHTML = '<span class="err">파일을 먼저 선택하세요.</span>'; return; }
  const ext = (f.name.match(/\\.(\\w+)$/) || [])[1]?.toLowerCase();
  const type = TYPE_BY_EXT[ext];
  if (!type) { st.innerHTML = '<span class="err">지원하지 않는 형식: .' + ext + '</span>'; return; }
  btn.disabled = true;
  st.textContent = '⏳ PC로 전송·변환 중… (' + (type === 'adobe' ? 'Adobe 앱 첫 실행은 수십 초 걸릴 수 있음' : '문서 크기에 따라 수십 초') + ')';
  try {
    const r = await fetch('/convert/' + type, { method: 'POST', headers: { 'X-Auth-Token': TOKEN, 'X-File-Name': encodeURIComponent(f.name) }, body: f });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = f.name.replace(/\\.\\w+$/, '') + '.pdf';
    a.click();
    st.innerHTML = '<span class="ok">✔ 변환 완료 — PDF 다운로드됨 (' + (blob.size / 1048576).toFixed(1) + 'MB)</span>\\n다음: 다운로드된 PDF를 폰 앱(2단계)에서 열어 분석·임포징하세요.';
  } catch (e) { st.innerHTML = '<span class="err">✖ ' + e.message + '</span>'; }
  btn.disabled = false;
}

async function doInk() {
  const f = document.getElementById('inkFile').files[0];
  const st = document.getElementById('inkStat'), btn = document.getElementById('inkBtn');
  if (!f) { st.innerHTML = '<span class="err">PDF를 먼저 선택하세요.</span>'; return; }
  btn.disabled = true;
  st.textContent = '⏳ 분석 중…';
  try {
    const r = await fetch('/ink/coverage', { method: 'POST', headers: { 'X-Auth-Token': TOKEN }, body: f });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    let color = 0;
    let html = '<table><tr><th>쪽</th><th>C</th><th>M</th><th>Y</th><th>K</th><th>판정</th></tr>';
    j.pages.forEach((p, i) => {
      const isColor = p.c > 0 || p.m > 0 || p.y > 0;
      if (isColor) color++;
      html += '<tr><td>' + (i + 1) + '</td><td>' + (p.c * 100).toFixed(1) + '</td><td>' + (p.m * 100).toFixed(1) + '</td><td>' + (p.y * 100).toFixed(1) + '</td><td>' + (p.k * 100).toFixed(1) + '</td><td>' + (isColor ? '🎨컬러' : '⬛흑백') + '</td></tr>';
    });
    html += '</table>';
    st.innerHTML = '<span class="ok">✔ ' + j.pages.length + '쪽 — 컬러 ' + color + ' · 흑백 ' + (j.pages.length - color) + '</span>' + html;
  } catch (e) { st.innerHTML = '<span class="err">✖ ' + e.message + '</span>'; }
  btn.disabled = false;
}
</script></body></html>`;
}

// ── 공개 API (main.js에서 사용) ─────────────────────────────────────────────
function init(deps) { _deps = deps; _cfg = loadCfg(); return _cfg; }

function start() {
  return new Promise((resolve) => {
    if (_srv) return resolve(status());
    _lastError = '';
    const srv = http.createServer((req, res) => {
      handle(req, res).catch(e => { try { json(res, 500, { error: String(e && e.message || e) }); } catch (e2) {} });
    });
    srv.timeout = 0;                       // 변환은 수 분 걸릴 수 있음 — 소켓 타임아웃 해제
    srv.requestTimeout = 15 * 60 * 1000;   // 요청 전체 상한 15분
    srv.headersTimeout = 60 * 1000;
    srv.on('error', (e) => {
      _lastError = e.code === 'EADDRINUSE' ? `포트 ${_cfg.port}가 이미 사용 중입니다.` : (e.message || String(e));
      _srv = null;
      resolve(status());
    });
    srv.listen(_cfg.port, '0.0.0.0', () => { _srv = srv; resolve(status()); });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!_srv) return resolve(status());
    const s = _srv; _srv = null;
    s.close(() => resolve(status()));
    // 열린 keep-alive 소켓 때문에 close가 안 끝나는 것 방지
    setTimeout(() => resolve(status()), 1500);
  });
}

async function setEnabled(on) {
  _cfg.enabled = !!on;
  saveCfg(_cfg);
  return on ? start() : stop();
}

function status() {
  const lan = lanInfo();
  return {
    running: !!_srv,
    enabled: _cfg ? _cfg.enabled : false,
    port: _cfg ? _cfg.port : PORT_DEFAULT,
    token: _cfg ? _cfg.token : '',
    lan,
    // 폰이 QR로 받는 연결 URL — 토큰·MAC(WoL용) 포함
    urls: lan.map(l => `http://${l.ip}:${_cfg ? _cfg.port : PORT_DEFAULT}/?t=${_cfg ? _cfg.token : ''}&mac=${encodeURIComponent(l.mac)}`),
    lastError: _lastError,
  };
}

module.exports = { init, start, stop, setEnabled, status };
