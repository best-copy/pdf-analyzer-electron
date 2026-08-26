// ── 외부 접속 터널 (Cloudflare Tunnel) — 관리자 PC 전용 ─────────────────────
// 활성화 서버(8736)를 공유기 포트포워딩·공인IP 없이 외부에 노출한다.
// cloudflared가 바깥으로 나가는 연결만 맺으므로, 인바운드가 막힌 회선에서도 동작한다.
//
// ⚠ 무료 임시 터널(trycloudflare.com) 주소는 **재시작할 때마다 바뀐다.**
//   테스터가 이 주소로 활성화하면 7일 재확인 때 옛 주소를 찾다가 실패한다
//   (유예 3일 뒤 잠김). 그래서 장기 사용에는 오프라인 등록을 권하고, 터널은
//   '등록 순간만 열어주는 통로'로 쓰는 것이 안전하다.
const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

let _proc = null;
let _url  = '';
let _err  = '';
let _port = 0;
let _log  = [];

function log(line) {
  _log.unshift({ t: Date.now(), line: String(line).slice(0, 200) });
  if (_log.length > 60) _log.length = 60;
}

// cloudflared 위치: PATH → winget 링크 → 기본 설치 경로 → 앱 동봉 순
function resolveExe() {
  try {
    // stderr 무시 — 없을 때 where가 콘솔에 오류를 찍는 것을 막는다(정상 상황)
    const out = execFileSync('where', ['cloudflared'],
      { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (e) {}
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    'C:\Program Files (x86)\cloudflared\cloudflared.exe',
    'C:\Program Files\cloudflared\cloudflared.exe',
    path.join(__dirname, 'vendor', 'cloudflared', 'cloudflared.exe'),
    path.join(process.resourcesPath || '', 'cloudflared', 'cloudflared.exe'),
  ];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  return '';
}

function status() {
  return {
    running: !!_proc,
    url: _url,
    port: _port,
    installed: !!resolveExe(),
    lastError: _err,
    log: _log.slice(0, 8),
  };
}

// 터널 기동 — 주소가 잡히거나 25초가 지나면 결과를 돌려준다.
function start(port) {
  return new Promise((resolve) => {
    if (_proc) return resolve(status());
    const exe = resolveExe();
    if (!exe) {
      _err = 'cloudflared가 설치되어 있지 않습니다 — 아래 [cloudflared 설치] 버튼을 누르세요.';
      return resolve(status());
    }
    _port = parseInt(port, 10) || 8736;
    _url = ''; _err = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(status()); } };

    const p = spawn(exe, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + _port], { windowsHide: true });
    _proc = p;
    // cloudflared는 주소를 stderr에 찍는다(로그 스트림이 stderr)
    const onData = (buf) => {
      const s = buf.toString('utf8');
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !_url) { _url = m[0]; log('터널 주소: ' + _url); finish(); }
      const e = s.match(/ERR .*/);
      if (e && !_url) { _err = e[0].slice(0, 160); log(e[0]); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => { _err = e.message; _proc = null; log('실행 실패: ' + e.message); finish(); });
    p.on('exit', (code) => {
      _proc = null; _url = '';
      log(`터널 종료 (code ${code})`);
      if (!_err && code) _err = `cloudflared가 종료되었습니다 (code ${code}).`;
      finish();
    });
    setTimeout(() => {
      if (!_url && !done) { _err = _err || '터널 주소를 받지 못했습니다 — 인터넷 연결을 확인하세요.'; finish(); }
    }, 25000);
  });
}

function stop() {
  if (_proc) { try { _proc.kill(); } catch (e) {} _proc = null; }
  _url = '';
  log('터널 중지');
  return status();
}

// winget으로 설치 (사용자가 버튼을 눌러 명시적으로 요청했을 때만 호출된다)
function install() {
  return new Promise((resolve) => {
    const p = spawn('winget', ['install', '--id', 'Cloudflare.cloudflared', '-e',
                    '--accept-source-agreements', '--accept-package-agreements'],
                    { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.stderr.on('data', d => { out += d.toString('utf8'); });
    p.on('error', (e) => resolve({ ok: false, error: 'winget 실행 실패: ' + e.message }));
    p.on('exit', (code) => {
      const ok = !!resolveExe();
      log(ok ? 'cloudflared 설치 완료' : `설치 실패 (code ${code})`);
      resolve(ok ? { ok: true }
                 : { ok: false, error: `설치에 실패했습니다 (code ${code}). ${out.slice(-200)}` });
    });
  });
}

module.exports = { start, stop, status, install, resolveExe };
