// 🔄 업데이트 적용 — 실제 앱 본체(main.js IPC)로 화면 흐름 끝까지
//   실행: node scripts/test/update-apply.e2e.js   (관리자 PC 전용 — 업데이트 파일을 진짜 서명으로 만든다)
// 창은 TEST_WINDOW=left(가장 왼쪽 모니터)·검사용 사용자 폴더. 설치 폴더는 임시 폴더의 가짜 설치(PDFEDIT_UPDATE_ROOT).
// 확인: ① 지금 버전 표시 ② 파일 확인(버전·바뀐 점) ③ '🔄 업데이트 적용'(확인 창 자동 승인) → 파일·버전 바뀜
//      ④ 백업 정보 → ⚙ 메뉴에 '이전 버전으로' ⑤ 되돌리기 ⑥ 위조 파일은 화면에서 거부 안내 ⑦ 같은 버전은 경고 문구
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const license = require(path.join(ROOT, 'license.js'));
const U = require(path.join(ROOT, 'updater.js'));
const PORT = 9351;

const admin = license.adminData();
if (!admin || !license.isAdminPC()) { console.log('관리자 개인키가 없어 건너뜀'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 200; i++) {
    try {
      const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const wait = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
        return expr => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
          .then(d => d.result && d.result.result ? d.result.result.value : { __err: JSON.stringify(d.result && d.result.exceptionDetails || d).slice(0, 500) });
      }
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 연결 실패');
}
const mk = (dir, files) => { for (const [p, c] of Object.entries(files)) { const a = path.join(dir, ...p.split('/')); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, c); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-upde2e-'));
let child;
(async () => {
  try {
    const inst = path.join(tmp, 'install'), newer = path.join(tmp, 'newer');
    const base = { 'resources/app/package.json': '{"name":"pdf-analyzer","version":"3.8.1","main":"main.js"}', 'resources/app/src/a.js': 'a-v1' };
    mk(inst, base);
    mk(newer, Object.assign({}, base, { 'resources/app/src/a.js': 'a-v2', 'resources/app/src/b.js': 'b-new' }));
    const good = path.join(tmp, 'PDF분석기-업데이트-3.9.0.pdfupd');
    fs.writeFileSync(good, U.buildUpdate({ installDir: newer, version: '3.9.0', notes: '복제 2부 위아래 · 블리드 가속', privPem: admin.priv }).bytes);
    const same = path.join(tmp, 'same.pdfupd');
    fs.writeFileSync(same, U.buildUpdate({ installDir: newer, version: '3.9.0', privPem: admin.priv }).bytes);
    const kp = crypto.generateKeyPairSync('ed25519');
    const forged = path.join(tmp, 'forged.pdfupd');
    fs.writeFileSync(forged, U.buildUpdate({ installDir: newer, version: '9.0.0', privPem: kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }).bytes);

    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore',
      env: Object.assign({}, process.env, { TEST_WINDOW: 'left', PDFEDIT_UPDATE_ROOT: inst }) });
    const ev = await connect();
    await sleep(2500);
    await ev(`window.__msgs = []; window.__errs = [];
      { const s = window.showSuccess, e = window.showError; window.showSuccess = m => { window.__msgs.push(String(m)); try { s(m); } catch (x) {} }; window.showError = m => { window.__errs.push(String(m)); try { e(m); } catch (x) {} }; }
      window.__asked = []; window.askChoice = async (msg, ch) => { window.__asked.push(String(msg)); return 'ok'; }; 1`);
    console.log('🔄 업데이트 적용 — 실제 앱');
    const v0 = await ev(`window.electronAPI.appVersion()`);
    ok(v0 === '3.8.1', '지금 버전 = 설치 폴더 package.json (' + v0 + ')');
    const info = await ev(`window.electronAPI.updateInspect(${JSON.stringify(good)})`);
    ok(info && info.ok && info.version === '3.9.0' && info.current === '3.8.1' && info.cmp === 1 && info.canApply && /위아래/.test(info.notes), '파일 확인: 3.8.1 → 3.9.0 · 바뀐 점 ' + JSON.stringify(info));
    const r = await ev(`(async () => { const r = await updateApplyClick(${JSON.stringify(good)}); return { r, asked: window.__asked.slice(-1)[0], msgs: window.__msgs.slice(-1)[0], errs: window.__errs.slice() }; })()`);
    ok(r && r.r && r.r.ok && r.r.changed === 3 && r.r.relaunch === false, '🔄 적용 → 바뀐 파일 3개(검사 모드라 다시 시작은 안 함) ' + JSON.stringify(r.r));
    ok(/3\.8\.1 → 3\.9\.0/.test(r.asked || '') && /백업/.test(r.asked || ''), '확인 창에 버전·백업 안내');
    ok(fs.readFileSync(path.join(inst, 'resources/app/src/a.js'), 'utf8') === 'a-v2' && fs.existsSync(path.join(inst, 'resources/app/src/b.js'))
       && JSON.parse(fs.readFileSync(path.join(inst, 'resources/app/package.json'), 'utf8')).version === '3.9.0', '설치 폴더 파일·버전이 바뀜');
    ok((await ev(`window.electronAPI.appVersion()`)) === '3.9.0', '앱이 보는 버전 3.9.0');
    const bk = await ev(`window.electronAPI.updateBackupInfo()`);
    ok(bk && bk.fromVersion === '3.8.1' && bk.toVersion === '3.9.0', '백업 정보');
    const menu = await ev(`(async () => { window.__asked = []; let labels = null; const orig = window.askChoice; window.askChoice = async (m, ch) => { labels = ch.map(c => c.label); return null; }; await openSettingsMenu(); window.askChoice = orig; return labels; })()`);
    ok(Array.isArray(menu) && menu.includes('🔄 업데이트 적용') && menu.some(l => /이전 버전\(3\.8\.1\)/.test(l)), '⚙ 메뉴: 업데이트 적용 · 이전 버전(3.8.1)으로 ' + JSON.stringify(menu));
    const same2 = await ev(`(async () => { window.__asked = []; window.askChoice = async (m) => { window.__asked.push(m); return null; }; await updateApplyClick(${JSON.stringify(same)}); return window.__asked[0]; })()`);
    ok(/같은 버전/.test(same2 || ''), '같은 버전 파일은 경고 문구(취소하면 그대로)');
    const fg = await ev(`(async () => { window.__errs = []; await updateApplyClick(${JSON.stringify(forged)}); return window.__errs.slice(); })()`);
    ok(fg.length === 1 && /서명이 맞지 않습니다/.test(fg[0]), '위조 파일 → 화면에서 거부 안내 ' + JSON.stringify(fg));
    const rb = await ev(`(async () => { window.askChoice = async () => 'ok'; return await updateRollbackClick(); })()`);
    ok(rb && rb.ok && rb.version === '3.8.1' && fs.readFileSync(path.join(inst, 'resources/app/src/a.js'), 'utf8') === 'a-v1'
       && !fs.existsSync(path.join(inst, 'resources/app/src/b.js')) && (await ev(`window.electronAPI.appVersion()`)) === '3.8.1', '↺ 이전 버전으로 → 3.8.1 · 파일 원래대로');
  } catch (e) { fail++; console.error(e); }
  finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    await sleep(800);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
    process.exit(fail ? 1 : 0);
  }
})();
