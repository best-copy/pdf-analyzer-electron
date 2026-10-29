// 📊 사용 기록·💬 불편 메모 — 실제 앱 본체로: 기록이 날짜 파일에 쌓이는지, 메모(Ctrl+Shift+M)가 상황과 함께 남는지,
//   기록 어디에도 문서 이름·경로가 없는지, scripts/usage-report.js가 요약하는지
//   실행: node scripts/test/usage-log.e2e.js   (TEST_WINDOW=left + USAGE_LOG_TEST=1 · 검사용 사용자 폴더 tmpdir/pdfedit-test-userdata)
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execSync, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9377;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 240; i++) {
    try {
      const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const wait = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
        const send = (method, params) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
        const ev = expr => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
          .then(d => d.result && d.result.result ? d.result.result.value : { __err: JSON.stringify(d.result && d.result.exceptionDetails || d).slice(0, 800) });
        ev.send = send;
        return ev;
      }
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 연결 실패');
}
async function until(ev, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(300); } return false; }
const key = async (ev, k, code, mods) => {
  for (const type of ['keyDown', 'keyUp']) await ev.send('Input.dispatchKeyEvent', { type, key: k, code, modifiers: mods || 0, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : (k === 'Enter' ? 13 : k === 'Escape' ? 27 : 0) });
};

const LOGDIR = path.join(os.tmpdir(), 'pdfedit-test-userdata', 'usage-log');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-usage-'));
let child;
(async () => {
  try {
    try { fs.rmSync(LOGDIR, { recursive: true, force: true }); } catch (e) {}
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { TEST_WINDOW: 'left', USAGE_LOG_TEST: '1' }) });
    const ev = await connect();
    await sleep(2500);
    ok(await ev(`typeof usageLog === 'function' && typeof openUsageMemo === 'function' && showError.__usage === true && prepareFiles.__usage === true`), '사용 기록 붙음 (showError·prepareFiles 감쌈)');
    // 비밀스러운 이름의 문서를 연다
    const made = await ev(`(async () => { const d = await PDFLib.PDFDocument.create(); d.addPage([300, 300]); d.addPage([300, 300]); return window.electronAPI.writeTempFile(await d.save(), 'pdf'); })()`);
    const secret = path.join(tmp, '홍길동_비밀견적.pdf');
    fs.copyFileSync(made, secret);
    await ev(`openExternalItems([{ name: '홍길동_비밀견적.pdf', path: ${JSON.stringify(secret)} }]); 1`);
    ok(await until(ev, `!!(originalPdfBytes && pageResults.filter(Boolean).length === 2)`, 60000), '문서 열림');
    await sleep(1000);
    // 버튼 누르기·설정 바꾸기·오래 걸린 작업·오류
    await ev(`(async () => {
      document.getElementById('opt-bw').click();
      const sel = document.getElementById('dotGainSelect'); sel.value = '15'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      showLoading('🧪 시험 작업 중…'); await new Promise(r => setTimeout(r, 1000)); hideLoading();
      showError("'홍길동_비밀견적.pdf' 열기 실패: D:\\\\고객\\\\홍길동\\\\원본.pdf");
      showSuccess('💾 저장했습니다 — 홍길동_비밀견적.pdf');
      return 1;
    })()`);
    // 💬 메모 — 실제 키(Ctrl+Shift+M) → 글 → Ctrl+Enter
    await ev(`document.body.focus(); 1`);
    await key(ev, 'M', 'KeyM', 2 | 8);
    ok(await until(ev, `!!document.querySelector('.um-box')`, 5000), 'Ctrl+Shift+M → 💬 불편 메모 창');
    await ev(`(() => { const t = document.querySelector('.um-text'); t.value = '흑백변환 켤 때마다 Dot Gain을 15로 바꿔야 해서 번거로움'; t.focus(); return 1; })()`);
    await key(ev, 'Enter', 'Enter', 2);
    ok(await until(ev, `!document.querySelector('.um-box')`, 5000), 'Ctrl+Enter → 남기기');
    await sleep(800);
    await ev(`usageFlush(); 1`);
    await sleep(1500);

    const files = fs.existsSync(LOGDIR) ? fs.readdirSync(LOGDIR) : [];
    const dayFile = files.find(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    ok(!!dayFile && files.includes('memos.jsonl'), '기록 파일: ' + files.join(', '));
    const raw = dayFile ? fs.readFileSync(path.join(LOGDIR, dayFile), 'utf8') : '';
    const evs = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const has = (t, f) => evs.some(e => e.t === t && (!f || f(e)));
    ok(has('start', e => e.v && e.cores > 0), '켤 때 한 줄(버전·코어)');
    ok(has('open', e => e.ext === 'pdf' && e.n === 1), '문서 열기(확장자·크기만)');
    ok(has('click', e => e.id === 'opt-bw'), '버튼 누름(opt-bw)');
    ok(has('set', e => e.id === 'dotGainSelect' && /15/.test(e.v)), '설정 바꿈(Dot Gain 15%)');
    ok(has('busy', e => /시험 작업/.test(e.m) && e.ms >= 900 && e.p === 2), '오래 걸린 작업(시간·쪽 수)');
    ok(has('error', e => /열기 실패/.test(e.m)) && has('ok', e => /저장했습니다/.test(e.m)), '오류·성공 안내');
    ok(has('key', e => e.k === 'Ctrl+Shift+M'), '단축키');
    const memoRaw = fs.readFileSync(path.join(LOGDIR, 'memos.jsonl'), 'utf8');
    const memo = JSON.parse(memoRaw.trim().split('\n').pop());
    ok(/Dot Gain을 15로/.test(memo.text) && memo.p === 2 && memo.recent.length >= 5, `메모 = 글 + 상황(${memo.p}쪽 · 최근 동작 ${memo.recent.length}개)`);
    const allText = raw + memoRaw.replace(memo.text, '');
    ok(!/홍길동|비밀견적|고객\\\\|원본\.pdf/.test(allText), '기록 어디에도 문서 이름·경로 없음');

    // 분석 스크립트
    const rep = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'usage-report.js'), '--dir', LOGDIR, '--days', '2'], { encoding: 'utf8' });
    ok(/연 문서 1개/.test(rep) && /시험 작업/.test(rep) && /열기 실패/.test(rep) && /dotGainSelect/.test(rep) && /불편 메모 1개/.test(rep) && /Dot Gain을 15로/.test(rep), '분석 보고서에 문서·오래 걸린 작업·오류·설정·메모');
    if (process.env.SHOW_REPORT) console.log(rep);
  } catch (e) {
    fail++; console.log('  ✘ 예외: ' + (e && e.stack || e));
  } finally {
    try { if (child) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
    process.exit(fail ? 1 : 0);
  }
})();
