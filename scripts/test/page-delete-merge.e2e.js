// 🗑 고른 쪽 모두 지우기 · 🔗 챕터 합치기 — 실제 앱(CDP 입력) (2026-10-22)
//   실행: node scripts/test/page-delete-merge.e2e.js
//   실제 앱 본체(TEST_WINDOW=left · 검사용 사용자 폴더). 세 파일(A 3쪽·B 3쪽·C 2쪽)을 📚 통합창으로 합친 문서에서:
// 확인: ① 고른 쪽(A2·B1) 중 하나의 ✕ → 둘 다 지움 · 되돌리기 한 번에 ② 사각형으로 고른 직후 Delete 키 → 고른 쪽만
//       (끄는 동안 지나간 쪽이 대상으로 남지 않음) ③ 우클릭 '삭제'도 고른 쪽 전체 ④ 고르지 않은 쪽의 ✕는 그 쪽만
//       ⑤ 전부 지우기는 막음 ⑥ 구분선 ⤒ 합치기(B → A) · 첫 챕터는 버튼 꺼짐 ⑦ 되돌리기 ⑧ 우클릭 '⤓ 아래 챕터와 합치기'
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PDFLib = require(path.join(ROOT, 'src/libs/pdf-lib.min.js'));
const PORT = 9354;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_e2e_delmerge_'));
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
const LAB = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2'];

(async () => {
  let child;
  try {
    const A = await makePdf('A', 3), B = await makePdf('B', 3), C = await makePdf('C', 2);
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
    const { ev, call } = await connect();
    for (let i = 0; i < 100 && !(await ev(`typeof openExternalItems === 'function' && document.readyState === 'complete'`)); i++) await sleep(300);
    await sleep(1500);
    await ev(`window.__errs = []; { const oe = window.showError; window.showError = m => { window.__errs.push(String(m)); try { oe(m); } catch (e) {} }; } window.confirm = () => true; 1`);
    await ev(`openExternalItems([{ name: 'A.pdf', path: ${JSON.stringify(A)} }, { name: 'B.pdf', path: ${JSON.stringify(B)} }, { name: 'C.pdf', path: ${JSON.stringify(C)} }], { merge: true, mode: 'tab' }); 1`);
    for (let i = 0; i < 100 && !(await ev(`pageResults.filter(Boolean).length === 8 && tabs.get(activeTabId).status === 'ready'`)); i++) await sleep(300);
    await sleep(1000);
    await ev(`hideSuccess(); for (let i = 0; i < 4; i++) changeThumbZoom(-1); document.getElementById('pagesGrid').scrollIntoView({ block: 'center' }); 1`);
    await sleep(800);

    const L = JSON.stringify(LAB);
    // 화면: |A3| A1 A2 A3 |B3| … (구분선 = 이름 머리글자 + 쪽 수)
    const view = () => ev(`[...document.getElementById('pagesGrid').children].map(e => e.classList.contains('chapter-divider')
      ? '|' + e.querySelector('.chapter-name').textContent.replace(/[^ABC]/g, '') + e.querySelector('.chapter-pages').textContent.replace('페이지', '') + '|'
      : ${L}[(pageResults.find(r => r && r.pageNum === +e.dataset.page) || {}).originalIdx] || '?').join(' ')`);
    const cardEl = lab => `[...document.querySelectorAll('#pagesGrid > .page-item')].find(e => { const r = pageResults.find(p => p && p.pageNum === +e.dataset.page); return r && ${L}[r.originalIdx] === ${JSON.stringify(lab)}; })`;
    const pick = labs => ev(`(() => { deselectAll(); ${JSON.stringify(labs)}.forEach(l => { const r = pageResults.find(p => p && ${L}[p.originalIdx] === l);
        selectPageEl(r.pageNum, document.querySelector('#pagesGrid > .page-item[data-page="' + r.pageNum + '"]')); }); updateSelectedCount(); return selectedPages.size; })()`);
    const v0 = await view();
    console.log('  처음:', v0);

    // ① 고른 쪽 중 하나의 ✕
    await pick(['A2', 'B1']);
    await ev(`${cardEl('A2')}.querySelector('.page-btn-del').click(); 1`); await sleep(500);
    const v1 = await view(), msg1 = await ev(`document.getElementById('success').textContent`);
    ck('① 고른 A2·B1 중 A2의 ✕ → 둘 다 지움', v1 === '|A2| A1 A3 |B2| B2 B3 |C2| C1 C2', v1);
    ck('① 안내: "고른 2쪽을 지웠습니다 … Ctrl+Z"', /고른 2쪽을 지웠습니다/.test(msg1) && /Ctrl\+Z/.test(msg1), msg1);
    await ev(`undoEdit(); 1`); await sleep(500);
    ck('① 되돌리기 한 번에 둘 다 돌아옴', (await view()) === v0, await view());

    // ② 사각형으로 고른 직후 Delete 키 — 끄는 동안 지나간 쪽(고르지 않은 쪽)이 대상으로 남지 않아야
    await ev(`deselectAll(); updateSelectedCount(); hideSuccess(); 1`);
    // 첫 줄이 고정 도구막대 밑에 깔리지 않게 A1을 화면 가운데로
    await ev(`(${cardEl('A1')}).scrollIntoView({ block: 'center' }); 1`); await sleep(400);
    const rc = {};
    for (const l of ['A1', 'A2', 'B2']) rc[l] = await ev(`(() => { const b = (${cardEl(l)}).getBoundingClientRect(); return { l: b.left, r: b.right, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 }; })()`);
    const a = { x: (rc.A1.r + rc.A2.l) / 2, y: rc.A1.cy }, b = { x: rc.B2.cx, y: rc.B2.cy };
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * i / 12, y: a.y + (b.y - a.y) * i / 12, button: 'left', buttons: 1 }); await sleep(25); }
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(300);
    const selNow = await ev(`pageResults.filter(r => r && selectedPages.has(r.pageNum)).map(r => ${L}[r.originalIdx]).join(',')`);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await sleep(500);
    const v2 = await view();
    ck('② 사각형으로 고른(' + selNow + ') 직후 Delete → 고른 쪽만 지움', selNow === 'A2,B2' && v2 === '|A2| A1 A3 |B2| B1 B3 |C2| C1 C2', { selNow, v2 });
    await ev(`undoEdit(); 1`); await sleep(500);

    // ③ 우클릭 '삭제'(ctxDeletePage) — 대상이 고른 쪽이면 전체
    await pick(['B3', 'C1']);
    await ev(`ctxTargetIdx = pageResults.indexOf(pageResults.find(p => p && ${L}[p.originalIdx] === 'C1')); ctxDeletePage(); 1`); await sleep(500);
    ck('③ 우클릭 삭제(대상 C1, 고른 B3·C1) → 둘 다', (await view()) === '|A3| A1 A2 A3 |B2| B1 B2 |C1| C2', await view());
    await ev(`undoEdit(); 1`); await sleep(500);

    // ④ 고르지 않은 쪽의 ✕ → 그 쪽만
    await pick(['A1', 'A2']);
    await ev(`${cardEl('C2')}.querySelector('.page-btn-del').click(); 1`); await sleep(500);
    ck('④ 고르지 않은 C2의 ✕ → C2만(고른 A1·A2는 그대로 · 선택 유지)', (await view()) === '|A3| A1 A2 A3 |B3| B1 B2 B3 |C1| C1' && (await ev('selectedPages.size')) === 2, await view());
    await ev(`undoEdit(); 1`); await sleep(500);

    // ⑤ 전부 지우기는 막음
    await ev(`deselectAll(); pageResults.forEach(r => { if (r) selectedPages.add(r.pageNum); }); rerenderPages(); updateSelectedCount(); window.__errs.length = 0; 1`);
    await ev(`${cardEl('A1')}.querySelector('.page-btn-del').click(); 1`); await sleep(400);
    ck('⑤ 전부 고른 채 지우기 → 막고 안내', (await view()) === v0 && /모든 페이지를 지울 수는 없습니다/.test((await ev('window.__errs.join("|")')) || ''), await ev('window.__errs.slice()'));
    await ev(`window.__errs.length = 0; deselectAll(); updateSelectedCount(); 1`);

    // ⑥ 구분선 ⤒ 합치기 — B를 A에 · 첫 챕터는 꺼짐
    const btn = await ev(`[...document.querySelectorAll('#pagesGrid > .chapter-divider .ch-merge')].map(b => b.disabled)`);
    ck('⑥ 첫 챕터의 ⤒ 합치기는 꺼짐 · 나머지는 켜짐', JSON.stringify(btn) === '[true,false,false]', btn);
    await ev(`document.querySelectorAll('#pagesGrid > .chapter-divider .ch-merge')[1].click(); 1`); await sleep(500);
    const v6 = await view(), msg6 = await ev(`document.getElementById('success').textContent`);
    ck('⑥ B → A로 합침(쪽 순서 그대로 · A 6쪽 · C 2쪽)', v6 === '|A6| A1 A2 A3 B1 B2 B3 |C2| C1 C2', v6);
    ck('⑥ B 쪽들의 챕터 = A · 안내 문구', await ev(`pageResults.filter(r => r && ${L}[r.originalIdx][0] === 'B').every(r => r.chapter === 'A.pdf')`) && /합쳤습니다/.test(msg6), msg6);

    // ⑦ 되돌리기
    await ev(`undoEdit(); 1`); await sleep(500);
    ck('⑦ 되돌리기 → 챕터 셋 그대로', (await view()) === v0, await view());

    // ⑧ 우클릭 메뉴 '⤓ 아래 챕터와 합치기' — B 구분선에서 → C가 B로
    await ev(`(() => { const d = document.querySelectorAll('#pagesGrid > .chapter-divider')[1]; const b = d.getBoundingClientRect();
      d.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 10 })); return 1; })()`);
    await sleep(300);
    const items = await ev(`[...document.querySelectorAll('.ch-menu .ch-menu-item')].map(b => b.textContent + (b.disabled ? '(꺼짐)' : ''))`);
    ck('⑧ 챕터 우클릭 메뉴에 위·아래 합치기', items.some(t => /위 챕터와 합치기/.test(t)) && items.some(t => /아래 챕터와 합치기/.test(t)), items);
    await ev(`[...document.querySelectorAll('.ch-menu .ch-menu-item')].find(b => /아래 챕터와 합치기/.test(b.textContent)).click(); 1`); await sleep(500);
    ck('⑧ B + C → 한 챕터(이름 B · 5쪽)', (await view()) === '|A3| A1 A2 A3 |B5| B1 B2 B3 C1 C2', await view());

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
