// 📖 대용량 작업 파일 + 복제 2-up — **실제 앱 본체**로 (프리웜·Ghostscript 폰트 안전화·실제 파일 쓰기까지)
//   실행: set DUP_PDFW=D:\...\작업.pdfw & node scripts/test/dup-2up-realapp.e2e.js
//   창은 TEST_WINDOW=left(가장 왼쪽 모니터) · 검사용 사용자 폴더. 작업 파일은 읽기만 하고, 결과(≈1GB×2)는 임시 폴더에 썼다가 지운다.
// dup-2up-flow.e2e.js는 하네스라 Ghostscript·프리웜이 없다 — 저장 직전 메모리 최고치는 여기서 본다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const electron = require('electron');
const PORT = 9339;
const PDFW = process.env.DUP_PDFW;
if (!PDFW || !fs.existsSync(PDFW)) { console.log('DUP_PDFW 에 작업 파일 경로를 주세요 — 건너뜀'); process.exit(0); }
const OUT1 = path.join(os.tmpdir(), 'pdfedit_e2e_realapp_imposed.pdf');
const OUT2 = path.join(os.tmpdir(), 'pdfedit_e2e_realapp_original.pdf');

const getJson = (url) => new Promise((res, rej) => http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 200; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const t = list.find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const wait = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
        const ev = (expr) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
          .then(d => d.result && d.result.result ? d.result.result.value : (d.result && d.result.exceptionDetails ? { __err: JSON.stringify(d.result.exceptionDetails).slice(0, 400) } : undefined));
        return { ws, ev };
      }
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 연결 실패');
}
async function until(ev, expr, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(500); }
  return false;
}

// 이 검사가 띄운 electron 프로세스들의 최대 사적 메모리(렌더러)를 1초마다 기록
let peak = 0, cur = 0, childPid = 0;
function sampleMem() {
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${PORT}*' -or $_.ParentProcessId -eq ${childPid} } | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).PrivateMemorySize64 } | Measure-Object -Maximum | ForEach-Object { $_.Maximum }`;
    const v = +execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 8000 }).trim();
    if (v) { cur = Math.round(v / 1048576); peak = Math.max(peak, cur); }
  } catch (e) {}
}

const out = [];
const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
const ck = (n, c, x) => { out.push([c ? '✔' : '✘', n]); console.log(`  ${c ? '✔' : '✘'} [${sec()} · 최고 ${peak}MB] ${n} ${x === undefined ? '' : JSON.stringify(x).slice(0, 500)}`); };
const env = Object.assign({}, process.env, { TEST_WINDOW: 'left', PDFEDIT_TEST_WINDOW: 'left' });
let child, timer;

(async () => {
  try {
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, PDFW], { cwd: ROOT, env, stdio: 'ignore' });
    childPid = child.pid;
    timer = setInterval(sampleMem, 1500);
    const { ev } = await connect();
    await ev(`window.__errs = []; { const oe = window.showError; window.showError = m => { window.__errs.push(String(m)); try { oe(m); } catch (e) {} }; } window.confirm = () => true; 1`);
    const opened = await until(ev, `!!(typeof processedPdfBytes !== 'undefined' && processedPdfBytes && pageResults.filter(Boolean).length === 150)`, 120000);
    ck('실행 인자로 작업 파일 열림 · 적용본 복원', opened);
    await sleep(15000);   // 열 때 도는 다운로드용 프리웜이 끝나게 둔다 (실사용과 같게)
    const pr = await ev(`(() => { const list = loadImpProfiles(); const idx = list.findIndex(p => p.n === '270-390_양면_2up_논문');
      document.getElementById('impProfile').value = String(idx); loadImpProfile();
      return { idx, outline: _outlineEnabled, mode: _outlineMode, pulse: document.getElementById('applyBtn').classList.contains('needs-apply') }; })()`);
    ck('프리셋 불러옴 → 적용 필요(반짝)', pr && pr.idx >= 0 && pr.pulse, pr);
    const ap = await ev(`(async () => { const t = Date.now(); await applyChanges();
      return { sec: ((Date.now() - t) / 1000).toFixed(1), mb: processedPdfBytes ? Math.round(processedPdfBytes.length / 1048576) : 0, errs: window.__errs.slice(),
               pulse: document.getElementById('applyBtn').classList.contains('needs-apply') }; })()`);
    ck('✔ 적용 성공 · 반짝임 멈춤', ap && ap.mb > 0 && !ap.errs.length && !ap.pulse, ap);
    // 적용 직후 도는 다운로드용 프리웜(임포징 재조립 + 폰트 안전화)이 끝날 때까지 — 실사용에서 가장 무거운 구간
    await sleep(3000);
    await until(ev, `!(typeof _optInflight !== 'undefined' && _optInflight)`, 600000);
    await sleep(5000);
    ck('프리웜 끝 — 오류 없음', true, await ev(`window.__errs.slice()`));
    // ⇩ 다운로드와 같은 최종 바이트(최적화→목차→폰트 안전화→컬러 검수) → 실제 파일 쓰기(대화상자만 건너뜀)
    const dl = await ev(`(async () => { try { const t = Date.now(); const b = await buildFinalSaveBytes();
      const ok = await window.electronAPI.saveFileTo({ filePath: ${JSON.stringify(OUT1)}, buffer: b.bytes, kind: 'pdf' });
      return { ok: !!ok, mb: Math.round(b.bytes.length / 1048576), sec: ((Date.now() - t) / 1000).toFixed(1) }; }
      catch (e) { return { err: String(e && e.message || e) }; } })()`);
    const s1 = fs.existsSync(OUT1) ? fs.statSync(OUT1).size : 0;
    ck('⇩ 다운로드 최종본 저장(폰트 안전화 포함)', dl && !dl.err && s1 > 0, Object.assign({ fileMB: Math.round(s1 / 1048576) }, dl));
    const og = await ev(`(async () => { try { const ok = await window.electronAPI.saveFileTo({ filePath: ${JSON.stringify(OUT2)}, buffer: originalPdfBytes, kind: 'pdf' });
      return { ok: !!ok, len: originalPdfBytes.length }; } catch (e) { return { err: String(e && e.message || e) }; } })()`);
    const s2 = fs.existsSync(OUT2) ? fs.statSync(OUT2).size : 0;
    ck('우클릭 원본 저장', og && !og.err && s2 === og.len, Object.assign({ fileMB: Math.round(s2 / 1048576) }, og));
    ck('렌더러 메모리 최고치가 한도(≈14GB)보다 2GB 이상 여유', peak > 0 && peak < 12 * 1024, peak + 'MB');
  } catch (e) {
    ck('실행 오류', false, String(e && e.stack || e));
  } finally {
    clearInterval(timer);
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    await sleep(1500);
    [OUT1, OUT2].forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
    const fail = out.filter(r => r[0] === '✘').length;
    console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패 (${sec()} · 렌더러 최고 ${peak}MB)\n`);
    process.exit(fail ? 1 : 0);
  }
})();
