// 📨 문서가 열려 있을 때 또 문서를 열면(보내기·끌어다 놓기·최근 파일·열기 창) — 챕터로 추가 / 새 탭 / 취소를 고른다 (2026-10-21)
//   실행: node scripts/test/external-open-mode.e2e.js
//   실제 앱 본체(TEST_WINDOW=left · 검사용 사용자 폴더)를 띄우고, **두 번째 실행**으로 파일을 보내 실제 보내기 경로(second-instance →
//   external:open)를 그대로 탄다. 여러 파일이면 순서 창: 📄 개별창(파일마다 새 탭 — 예전엔 열린 문서에 챕터로 붙어 버렸다) ·
//   📑 지금 문서에 챕터로(열린 문서가 있을 때만 보임).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PDFLib = require(path.join(ROOT, 'src/libs/pdf-lib.min.js'));
const PORT = 9343;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_e2e_extopen_'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = u => new Promise((res, rej) => http.get(u, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));

async function makePdf(name, n) {
  const d = await PDFLib.PDFDocument.create();
  const f = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) d.addPage([300, 400]).drawText(`${name} ${i + 1}`, { x: 40, y: 200, size: 28, font: f });
  const p = path.join(TMP, name + '.pdf');
  fs.writeFileSync(p, await d.save());
  return p;
}
async function connect() {
  for (let i = 0; i < 200; i++) {
    try {
      const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const w = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (w.has(d.id)) { w.get(d.id)(d); w.delete(d.id); } };
        return expr => new Promise(r => { const k = ++id; w.set(k, r); ws.send(JSON.stringify({ id: k, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
          .then(d => d.result && d.result.result ? d.result.result.value : { __err: JSON.stringify(d).slice(0, 400) });
      }
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 연결 실패');
}
async function until(ev, expr, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(250); }
  return false;
}

const out = [];
const ck = (n, c, x) => { out.push(c ? '✔' : '✘'); console.log(`  ${c ? '✔' : '✘'} ${n} ${x === undefined ? '' : JSON.stringify(x).slice(0, 300)}`); };
const env = Object.assign({}, process.env, { TEST_WINDOW: 'left' });
const send = (...files) => spawn(electron, ['.', ...files], { cwd: ROOT, env, stdio: 'ignore' });   // 두 번째 실행 = 보내기

(async () => {
  let child;
  try {
    const A = await makePdf('Base', 3), B = await makePdf('Bee', 2), C = await makePdf('Cee', 4), D = await makePdf('Dee', 1);
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, A], { cwd: ROOT, env, stdio: 'ignore' });
    const ev = await connect();
    const st = `({ tabs: tabs.size, pages: pageResults.filter(Boolean).length, active: tabs.get(activeTabId) && tabs.get(activeTabId).fileName,
      ready: [...tabs.values()].every(t => t.status === 'ready'), ask: !!document.querySelector('.pt-box'), order: document.getElementById('orderModal').style.display === 'block' })`;
    ck('처음 실행 인자로 연 문서 — 묻지 않고 바로 열림(탭 1·3쪽)', await until(ev, `(() => { const s = ${st}; return s.tabs === 1 && s.pages === 3 && s.ready && !s.ask; })()`, 60000), await ev(st));
    await ev(`window.__errs = []; { const oe = window.showError; window.showError = m => { window.__errs.push(String(m)); try { oe(m); } catch (e) {} }; } 1`);

    // ① 하나 보내기 → 묻는 창 → 🗂 새 탭
    send(B);
    const asked = await until(ev, `!!document.querySelector('.pt-box')`, 20000);
    const q = await ev(`(() => { const b = document.querySelector('.pt-box'); return { text: b.textContent, btns: [...b.querySelectorAll('button')].map(x => x.textContent),
      focus: document.activeElement && document.activeElement.textContent }; })()`);
    ck('보내면 묻는 창 — 받은 파일·지금 문서 이름 · 버튼 3개 · Enter = 챕터로 추가', asked && /Bee\.pdf/.test(q.text) && /Base/.test(q.text)
      && q.btns.length === 3 && /챕터로 추가/.test(q.focus), q);
    await ev(`[...document.querySelectorAll('.pt-box button')].find(b => /새 탭/.test(b.textContent)).click(); 1`);
    ck('🗂 새 탭으로 열기 → 탭 2개 · 새 탭 2쪽', await until(ev, `(() => { const s = ${st}; return s.tabs === 2 && s.pages === 2 && s.ready; })()`, 30000), await ev(st));
    const baseKept = await ev(`[...tabs.values()].find(t => /Base/.test(t.fileName)).pageResults.filter(Boolean).length`);
    ck('원래 문서는 그대로(3쪽)', baseKept === 3, baseKept);

    // ② 하나 보내기 → Enter(기본 = 📑 챕터로 추가) → 지금 탭(Bee 2쪽)에 4쪽이 붙어 6쪽
    send(C);
    await until(ev, `!!document.querySelector('.pt-box')`, 20000);
    await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1`);
    ck('Enter → 📑 챕터로 추가 → 탭 수 그대로 · 지금 문서 2+4=6쪽', await until(ev, `(() => { const s = ${st}; return s.tabs === 2 && s.pages === 6 && s.ready && !s.ask; })()`, 30000), await ev(st));

    // ③ 하나 보내기 → Esc(취소) → 아무것도 안 바뀜
    send(D);
    await until(ev, `!!document.querySelector('.pt-box')`, 20000);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
    await sleep(2500);
    ck('Esc → 취소 — 탭·쪽 그대로', await ev(`(() => { const s = ${st}; return s.tabs === 2 && s.pages === 6 && !s.ask; })()`), await ev(st));

    // ④ 여러 개 보내기 → 순서 창 · 📑 지금 문서에 챕터로 보임 → 📄 개별창 = 파일마다 새 탭
    send(B, D);
    const ord = await until(ev, `document.getElementById('orderModal').style.display === 'block'`, 20000);
    const chVis = await ev(`getComputedStyle(document.getElementById('ordChapterBtn')).display !== 'none'`);
    ck('여러 개 → 순서 창 · 📑 지금 문서에 챕터로 버튼 보임', ord && chVis, { ord, chVis });
    await ev(`confirmOpenOrder('tabs'); 1`);
    ck('📄 개별창 → 파일마다 새 탭(탭 4개) · 묻지 않음', await until(ev, `(() => { const s = ${st}; return s.tabs === 4 && s.ready && !s.ask; })()`, 30000), await ev(st));

    // ⑤ 여러 개 → 📑 지금 문서에 챕터로 → 지금 탭에 2+1=3쪽 더
    const before = await ev(`({ tabs: tabs.size, pages: pageResults.filter(Boolean).length })`);
    send(B, D);
    await until(ev, `document.getElementById('orderModal').style.display === 'block'`, 20000);
    await ev(`document.getElementById('ordChapterBtn').click(); 1`);
    ck('📑 지금 문서에 챕터로 → 탭 수 그대로 · 쪽 +3', await until(ev, `(() => { const s = ${st}; return s.tabs === ${before.tabs} && s.pages === ${before.pages + 3} && s.ready && !s.ask; })()`, 30000),
      { before, now: await ev(st) });

    // ⑥ 앱 안에서 열기(최근 파일 — 📂 열기 창과 같은 모양) → '📂 … 엽니다' 묻는 창 → 🗂 새 탭
    const b6 = await ev(`tabs.size`);
    await ev(`openRecentFile({ name: 'Dee.pdf', path: ${JSON.stringify(D)} }); 1`);
    await until(ev, `!!document.querySelector('.pt-box')`, 20000);
    const q6 = await ev(`document.querySelector('.pt-box') && document.querySelector('.pt-box').textContent`);
    ck('최근 파일 열기 → "📂 \'Dee.pdf\' 문서를 엽니다" 묻는 창', /엽니다/.test(q6 || '') && /Dee\.pdf/.test(q6 || ''), q6);
    await ev(`[...document.querySelectorAll('.pt-box button')].find(b => /새 탭/.test(b.textContent)).click(); 1`);
    ck('🗂 새 탭 → 탭 하나 늘고 1쪽', await until(ev, `(() => { const s = ${st}; return s.tabs === ${b6 + 1} && s.pages === 1 && s.ready && !s.ask; })()`, 30000), await ev(st));

    // ⑦ 끌어다 놓기(여러 개) → '○○ 외 1개' 묻는 창 → Esc 취소 — 아무것도 안 바뀜
    //    (검사에서 만든 File에는 실제 경로가 없어 끝까지 열지는 못한다 — 묻는 것은 변환 전이라 여기까지 확인)
    const b7 = await ev(`({ tabs: tabs.size, pages: pageResults.filter(Boolean).length })`);
    await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['%PDF-1.4'], '끌어온1.pdf', { type: 'application/pdf' }));
      dt.items.add(new File(['%PDF-1.4'], '끌어온2.pdf', { type: 'application/pdf' }));
      document.getElementById('uploadSection').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
    await until(ev, `!!document.querySelector('.pt-box')`, 20000);
    const q7 = await ev(`document.querySelector('.pt-box') && document.querySelector('.pt-box').textContent`);
    ck('끌어다 놓기 → "📂 \'끌어온1.pdf\' 외 1개 문서를 엽니다" 묻는 창', /끌어온1\.pdf' 외 1개/.test(q7 || '') && /엽니다/.test(q7 || ''), q7);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
    await sleep(1500);
    ck('Esc → 취소 — 탭·쪽 그대로', await ev(`(() => { const s = ${st}; return s.tabs === ${b7.tabs} && s.pages === ${b7.pages} && !s.ask; })()`), await ev(st));

    ck('오류 없음', true, await ev(`window.__errs.slice()`));
    const errs = await ev(`window.__errs.length`);
    if (errs) ck('오류 표시 0건', false, await ev(`window.__errs.slice()`));
  } catch (e) {
    ck('실행 오류', false, String(e && e.stack || e));
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    await sleep(1000);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    const fail = out.filter(r => r === '✘').length;
    console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
    process.exit(fail ? 1 : 0);
  }
})();
