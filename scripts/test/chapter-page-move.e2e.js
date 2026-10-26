// 📑 챕터를 넘는 쪽 이동 — 실제 마우스 끌기(CDP 입력)로 (2026-10-21)
//   실행: node scripts/test/chapter-page-move.e2e.js
//   실제 앱 본체(TEST_WINDOW=left · 검사용 사용자 폴더). 두 파일을 📚 통합창으로 합친 뒤 **합친 안내 토스트를 닫지 않고** 끈다.
// 확인: ⑦ 여러 쪽을 골라 끌면 고른 쪽 전체가 문서 순서대로(되돌리기 한 번) ⑧ 챕터의 마지막 쪽까지 옮겨 챕터가 비어도 됨
//       ① 토스트 아래 쪽에도 놓인다(예전엔 토스트가 놓기를 가로챘다) · 옮긴 쪽은 놓은 자리의 챕터로(예전엔 'B | A | B'로 쪼개짐)
//       ② 챕터 경계(A 끝 → B 처음 앞)에 놓아도 챕터가 바뀐다(예전엔 순서가 같아 아무 일도 없었다) ③ 구분선 위에 놓으면 그 챕터 맨 앞
//       ④ Ctrl+Z가 챕터 소속까지 되돌림 ⑤ 챕터 안 이동은 그대로 ⑥ 끌기가 끝나면 끌던 쪽을 잊는다
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PDFLib = require(path.join(ROOT, 'src/libs/pdf-lib.min.js'));
const PORT = 9346;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_e2e_chmove_'));
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
    await sleep(1200);

    // 화면 상태: 쪽 = 원래 파일·쪽(A1…B3), 구분선 = 이름(쪽 수)
    const view = () => ev(`[...document.getElementById('pagesGrid').children].map(e => e.classList.contains('chapter-divider')
      ? '|' + e.querySelector('.chapter-name').textContent.replace(/[^AB.pdf]/g, '').replace('.pdf', '') + e.querySelector('.chapter-pages').textContent.replace('페이지', '') + '|'
      : ['A1','A2','A3','B1','B2','B3'][pageResults.find(r => r && r.pageNum === +e.dataset.page) ? pageResults.find(r => r && r.pageNum === +e.dataset.page).originalIdx : -1] || '?').join(' ')`);
    const chOf = () => ev(`pageResults.filter(Boolean).map(r => ['A1','A2','A3','B1','B2','B3'][r.originalIdx] + '=' + (r.chapter || '').replace('.pdf', '')).join(' ')`);
    // 끌기 — 대상: 쪽 라벨('B2') 또는 구분선('#B')
    const center = sel => ev(`(() => { const lab = ${JSON.stringify(sel)};
      let el;
      if (lab[0] === '#') el = [...document.querySelectorAll('#pagesGrid > .chapter-divider')].find(d => d.querySelector('.chapter-name').textContent.includes(lab.slice(1) + '.pdf'));
      else el = [...document.querySelectorAll('#pagesGrid > .page-item')].find(e => { const r = pageResults.find(p => p && p.pageNum === +e.dataset.page); return r && ['A1','A2','A3','B1','B2','B3'][r.originalIdx] === lab; });
      if (!el) return null;
      const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, top: b.top, bottom: b.bottom }; })()`);
    async function drag(from, to, side) {
      // 끌 쪽을 화면 가운데로(맨 위로 올리면 첫 줄이 고정 도구막대 밑에 깔린다)
      await ev(`(() => { const r = ${JSON.stringify(from)}; const el = [...document.querySelectorAll('#pagesGrid > .page-item')].find(e => { const p = pageResults.find(q => q && q.pageNum === +e.dataset.page); return p && ['A1','A2','A3','B1','B2','B3'][p.originalIdx] === r; }); if (el) el.scrollIntoView({ block: 'center' }); return 1; })()`);
      if (to[0] === '#') {   // 구분선이 대상이면 끌 쪽과 구분선의 가운데가 화면 가운데에 오게
        const p = await center(from), q = await center(to);
        await ev(`window.scrollBy(0, ${Math.round((p.y + q.y) / 2 - 450)}); document.scrollingElement.scrollTop; 1`);
      }
      await sleep(250);
      const a = await center(from), b = await center(to);
      if (!a || !b) return { err: 'no target', a, b };
      const tx = to[0] === '#' ? b.x : b.x + (side === 'after' ? b.w * 0.3 : -b.w * 0.3), ty = b.y;
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 15; i++) { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (tx - a.x) * i / 15, y: a.y + (ty - a.y) * i / 15, button: 'left', buttons: 1 }); await sleep(30); }
      // 놓기 전에 잠깐 머문다(사람 손처럼) — 바로 놓으면 마지막 dragover가 처리되기 전에 끝나 drop이 오지 않을 때가 있다
      for (let i = 0; i < 3; i++) { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx + (i % 2), y: ty, button: 'left', buttons: 1 }); await sleep(60); }
      const under = await ev(`(() => { const e = document.elementFromPoint(${tx}, ${ty}); return e ? (e.closest('#success') ? 'toast' : e.className) : null; })()`);
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 });
      await sleep(900);
      return { under };
    }

    // 썸네일을 작게 — 구분선과 쪽이 한 화면 가운데에 함께 들어오게(위쪽 가장자리에 가면 자동 스크롤로 대상이 밀린다)
    await ev('for (let i = 0; i < 4; i++) changeThumbZoom(-1); 1'); await sleep(600);
    console.log('  처음:', await view());
    const toast = await ev(`(() => { const s = document.getElementById('success'); return s.style.display !== 'none' && /합쳤습니다/.test(s.textContent); })()`);
    ck('합친 안내 토스트가 떠 있는 상태로 시작', toast);

    // ① A1 → B2 앞 (아래 줄 — 토스트에 가려진 자리일 수 있다)
    const tb = await ev(`(() => { const s = document.getElementById('success').getBoundingClientRect(); return { top: Math.round(s.top), bottom: Math.round(s.bottom) }; })()`);
    const d1 = await drag('A1', 'B2', 'before');
    const v1 = await view();
    ck('① A1 → B2 앞: B 챕터로 들어감(챕터 2개 유지 · A 2쪽 · B 4쪽)', v1 === '|A2| A2 A3 |B4| B1 A1 B2 B3', { v1, d1, toast: tb });
    ck('① 끄는 동안 토스트는 마우스를 통과(놓기를 가로채지 않음)', d1.under !== 'toast', d1);
    ck('① 옮긴 쪽의 챕터 = B', /A1=B/.test(await chOf()), await chOf());

    // ② 경계: A3(A의 끝) → B1 앞 — 순서는 그대로지만 B로 들어간다
    await drag('A3', 'B1', 'before');
    const v2 = await view();
    ck('② 챕터 경계(A 끝 → B 처음 앞) → B로 들어감(A 1쪽 · B 5쪽)', v2 === '|A1| A2 |B5| A3 B1 A1 B2 B3', v2);

    // ③ 구분선 위에 놓기: B1 → A 구분선 = A 맨 앞 (둘이 한 화면에 들어오게 B 첫 줄의 쪽으로)
    await drag('B1', '#A');
    const v3 = await view();
    ck('③ B1을 A 구분선 위에 → A 맨 앞(A 2쪽 · B 4쪽)', v3 === '|A2| B1 A2 |B4| A3 A1 B2 B3', v3);

    // ④ Ctrl+Z → ③ 이전으로(챕터 소속까지)
    await ev(`undoEdit(); 1`); await sleep(500);
    const v4 = await view();
    ck('④ 되돌리기 → 챕터 소속까지 원래대로', v4 === v2 && /B1=B/.test(await chOf()), { v4, ch: await chOf() });

    // ⑤ 챕터 안 이동: B2 → B1 앞
    await drag('B2', 'B1', 'before');
    const v5 = await view();
    ck('⑤ 챕터 안 이동은 그대로(B 안에서 순서만)', v5 === '|A1| A2 |B5| A3 B2 B1 A1 B3', v5);

    // ⑦ 여러 쪽을 골라 끌면 고른 쪽 전체가 옮겨진다(예전엔 끈 쪽 하나만) — B2·B1을 골라 B2를 A 구분선에
    const pick = labs => ev(`(() => { deselectAll(); const L = ['A1','A2','A3','B1','B2','B3'];
      ${JSON.stringify(labs)}.forEach(l => { const r = pageResults.find(p => p && L[p.originalIdx] === l);
        selectPageEl(r.pageNum, document.querySelector('#pagesGrid > .page-item[data-page="' + r.pageNum + '"]')); });
      updateSelectedCount(); return selectedPages.size; })()`);
    await pick(['B2', 'B1']);
    await drag('B2', '#A');
    const v7 = await view();
    ck('⑦ 두 쪽(B2·B1) 골라 A 구분선에 → 둘 다 A 맨 앞으로(문서 순서 유지 · A 3쪽 · B 3쪽)', v7 === '|A3| B2 B1 A2 |B3| A3 A1 B3', v7);
    ck('⑦ 옮긴 뒤에도 두 쪽이 선택된 채', await ev('selectedPages.size') === 2, await ev('selectedPages.size'));
    await ev('undoEdit(); 1'); await sleep(500);
    ck('⑦ 되돌리기 → 한 번에 원래대로(챕터 소속까지)', (await view()) === v5 && /B1=B/.test(await chOf()) && /B2=B/.test(await chOf()), { v: await view(), ch: await chOf() });

    // ⑧ 한 챕터의 유일한 쪽까지 함께: A2(A의 전부)·B3을 골라 A2를 B1 앞에 → A 챕터가 비고 둘 다 B로
    await pick(['A2', 'B3']);
    await drag('A2', 'B1', 'before');
    const v8 = await view();
    ck('⑧ A2(A의 유일한 쪽)·B3을 골라 B1 앞에 → A 챕터 없어짐 · 문서 순서대로 B1 앞에', v8 === '|B6| A3 B2 A2 B3 B1 A1', v8);
    await ev('deselectAll(); updateSelectedCount(); 1');

    // ⑥ 끌기가 끝나면 정리
    const st = await ev(`({ src: dragSrcPageNum, cls: document.body.classList.contains('page-dragging') })`);
    ck('⑥ 끌기가 끝나면 끌던 쪽을 잊고 토스트도 원래대로', st.src === null && !st.cls, st);
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
