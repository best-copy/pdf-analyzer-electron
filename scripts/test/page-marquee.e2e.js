// ⬚ 끌어서 쪽 고르기(사각형 선택) — 실제 마우스 끌기(CDP 입력)로 (2026-10-22)
//   실행: node scripts/test/page-marquee.e2e.js
//   실제 앱 본체(TEST_WINDOW=left · 검사용 사용자 폴더). 두 파일을 📚 통합창으로 합친(챕터 2개) 문서에서:
// 확인: ① 쪽 사이 빈 곳 → 다른 챕터 쪽까지 끌면 사각형에 닿은 쪽만 선택(구분선을 넘어도) · 선택 수 표시
//       ② 그냥 끌기는 더하기(먼저 고른 쪽 유지) ③ Ctrl+끌기 = 빼기 ④ Esc = 끌기 전으로 ⑤ 챕터 구분선 빈 곳에서도 시작
//       ⑥ 쪽 카드에서 끌면 여전히 쪽 이동(사각형 아님) ⑦ 끝나면 사각형·십자 커서가 남지 않음
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PDFLib = require(path.join(ROOT, 'src/libs/pdf-lib.min.js'));
const PORT = 9352;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_e2e_marquee_'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = u => new Promise((res, rej) => http.get(u, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));

async function makePdf(name, n) {
  const d = await PDFLib.PDFDocument.create();
  const f = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) d.addPage([300, 400]).drawText(name + (i + 1), { x: 60, y: 200, size: 60, font: f });
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
        const call = (method, params) => new Promise(r => { const k = ++id; w.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
        const ev = expr => call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
          .then(d => d.result && d.result.result ? d.result.result.value : { __err: JSON.stringify(d).slice(0, 400) });
        return { ev, call };
      }
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 연결 실패');
}

const out = [];
const ck = (n, c, x) => { out.push(c ? '✔' : '✘'); console.log(`  ${c ? '✔' : '✘'} ${n} ${x === undefined ? '' : JSON.stringify(x).slice(0, 300)}`); };
const env = Object.assign({}, process.env, { TEST_WINDOW: 'left' });
const LAB = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'];

(async () => {
  let child;
  try {
    const A = await makePdf('A', 3), B = await makePdf('B', 3);
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
    const { ev, call } = await connect();
    for (let i = 0; i < 100 && !(await ev(`typeof openExternalItems === 'function' && document.readyState === 'complete'`)); i++) await sleep(300);
    await sleep(1500);
    await ev(`window.__errs = []; { const oe = window.showError; window.showError = m => { window.__errs.push(String(m)); try { oe(m); } catch (e) {} }; } 1`);
    await ev(`openExternalItems([{ name: 'A.pdf', path: ${JSON.stringify(A)} }, { name: 'B.pdf', path: ${JSON.stringify(B)} }], { merge: true, mode: 'tab' }); 1`);
    for (let i = 0; i < 100 && !(await ev(`pageResults.filter(Boolean).length === 6 && tabs.get(activeTabId).status === 'ready'`)); i++) await sleep(300);
    await sleep(1000);
    await ev(`hideSuccess(); for (let i = 0; i < 4; i++) changeThumbZoom(-1); 1`);   // 두 챕터가 한 화면에 들어오게
    await sleep(800);
    await ev(`document.getElementById('pagesGrid').scrollIntoView({ block: 'center' }); 1`);
    await sleep(500);

    const sel = () => ev(`pageResults.filter(r => r && selectedPages.has(r.pageNum)).map(r => ${JSON.stringify(LAB)}[r.originalIdx]).join(',')`);
    const rects = () => ev(`(() => { const o = {}; document.querySelectorAll('#pagesGrid > .page-item').forEach(e => { const r = pageResults.find(p => p && p.pageNum === +e.dataset.page);
      const b = e.getBoundingClientRect(); o[${JSON.stringify(LAB)}[r.originalIdx]] = { l: b.left, r: b.right, t: b.top, b: b.bottom, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 }; });
      const d = [...document.querySelectorAll('#pagesGrid > .chapter-divider')].map(x => { const b = x.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; });
      return { cards: o, dividers: d }; })()`);
    async function mdrag(a, b, mods, opts) {
      const m = mods || 0;
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, modifiers: m });
      for (let i = 1; i <= 12; i++) { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * i / 12, y: a.y + (b.y - a.y) * i / 12, button: 'left', buttons: 1, modifiers: m }); await sleep(25); }
      if (opts && opts.beforeUp) await opts.beforeUp();
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, modifiers: m });
      await sleep(400);
    }
    const R = await rects();
    const c = R.cards;
    const under = (x, y) => ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? (e.closest('.page-item') ? 'card' : e.className || e.id || e.tagName) : null; })()`);
    // A1과 A2 사이 틈(첫 줄) → B2 가운데(둘째 챕터)
    const gap = { x: (c.A1.r + c.A2.l) / 2, y: c.A1.cy };
    console.log('  시작점:', await under(gap.x, gap.y), JSON.stringify(gap));
    ck('준비: 선택 없음', (await sel()) === '');

    await mdrag(gap, { x: c.B2.cx, y: c.B2.cy });
    const s1 = await sel(), cnt1 = await ev(`selectedCountEl.textContent`);
    ck('① 빈 틈 → B2까지 끌기: 사각형에 닿은 A2·B2만 선택(챕터 구분선 넘어서)', s1 === 'A2,B2', s1);
    ck('① 선택 수 표시 "2개 선택됨"', /2개 선택됨/.test(cnt1), cnt1);

    // ② 그냥 끌기는 더하기: A3 오른쪽 여백 → A3 가운데 (A3만 닿게)
    await mdrag({ x: (c.A2.r + c.A3.l) / 2, y: c.A3.t + 4 }, { x: c.A3.cx, y: c.A3.cy });
    ck('② 그냥 끌기는 더하기(A2·B2 유지 + A3)', (await sel()) === 'A2,A3,B2', await sel());

    // ③ Ctrl+끌기 = 빼기 (A2 쪽만 닿게)
    await mdrag({ x: (c.A1.r + c.A2.l) / 2, y: c.A2.t + 4 }, { x: c.A2.cx, y: c.A2.cy }, 2 /* Ctrl */);
    ck('③ Ctrl+끌기 = 빼기(A2 빠짐)', (await sel()) === 'A3,B2', await sel());

    // ④ Esc = 끌기 전으로
    await mdrag(gap, { x: c.B3.cx, y: c.B3.cy }, 0, { beforeUp: async () => {
      const mid = await sel();
      ck('④ 끄는 동안 사각형에 닿은 쪽이 바로 선택됨', mid.split(',').length >= 3 && /B3/.test(mid), mid);
      await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
    } });
    ck('④ Esc → 끌기 전 선택(A3·B2)으로', (await sel()) === 'A3,B2', await sel());

    // ⑤ 챕터 구분선 빈 곳에서 시작 → B1 가운데
    await ev(`deselectAll(); updateSelectedCount(); 1`);
    const dv = R.dividers[1];
    const dStart = { x: dv.l + (dv.r - dv.l) * 0.55, y: (dv.t + dv.b) / 2 };
    console.log('  구분선 시작점:', await under(dStart.x, dStart.y));
    await mdrag(dStart, { x: c.B1.cx - 10, y: c.B1.cy });
    ck('⑤ 챕터 구분선 빈 곳에서 시작 → 구분선 아래 B 줄만 선택(A 없음)', /B1/.test(await sel()) && !/A/.test(await sel()), await sel());

    // ⑥ 쪽 카드에서 끌면 쪽 이동 — 사각형 아님(선택 그대로, 순서가 바뀜)
    const before = await sel();
    const order0 = await ev(`pageResults.filter(Boolean).map(r => ${JSON.stringify(LAB)}[r.originalIdx]).join(' ')`);
    await mdrag({ x: c.A1.cx, y: c.A1.cy }, { x: c.A3.cx + (c.A3.r - c.A3.l) * 0.3, y: c.A3.cy });
    await sleep(600);
    const order1 = await ev(`pageResults.filter(Boolean).map(r => ${JSON.stringify(LAB)}[r.originalIdx]).join(' ')`);
    ck('⑥ 쪽 카드에서 끌기는 여전히 쪽 이동(선택은 그대로)', order1 !== order0 && (await sel()) === before, { order0, order1, sel: await sel() });

    const left = await ev(`({ box: !!document.querySelector('.page-marquee'), cls: document.body.classList.contains('page-marqueeing') })`);
    ck('⑦ 끝나면 사각형·십자 커서가 남지 않음', !left.box && !left.cls, left);
    ck('오류 표시 없음', !(await ev(`window.__errs.length`)), await ev(`window.__errs.slice()`));
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
