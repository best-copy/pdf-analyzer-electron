// 적용 결과 화면의 챕터 구분 — 모아찍기는 챕터가 섞이지 않게(남는 칸은 빈칸) + 결과 시트에 챕터 구분선·버튼
//   실행: npx electron scripts/test/chapter-result-view.e2e.js
// 사용자 요청(2026-10-06): 편집 모드에서 적용해도 메인 결과 화면이 챕터별로 구분되고(✏ ▲▼ 🗑),
//   2쪽 모아찍기에서 한 시트에 두 챕터가 섞이지 않게 — 시트가 모자라면 그 칸은 빈칸, 다음 챕터는 새 시트부터.
// 확인: 시트 글자(gs txtwrite)로 섞임 여부 · 구분선 수·시트 수 · ▲▼🗑 뒤에도 결과 화면 유지 · 삭제 취소는 그대로
//       · 중철은 종전대로(체크 안 하면 한 권) · 작업 파일 저장→열기에도 구분선 유지
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const { leftWin } = require('./_leftwin');

let gsPath = null;
function installMainHandlers() {   // main.js 원본 그대로(작업 파일 열기·gs 경로)
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split('\r\n').join('\n');
  const cut = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('main.js에서 못 찾음: ' + a); return src.slice(i, j); };
  const code = ['let _gsPath = null;', cut('function findGhostscript() {', '\n// gs inkcov 실행'),
    cut('// ── 설치된 폰트 색인', '// ── IPC: 2GB'), 'return findGhostscript;'].join('\n');
  return new Function('ipcMain', 'path', 'os', 'fs', 'spawn', 'execFile', 'app', 'process', '__dirname', code)(ipcMain, path, os, fs, spawn, execFile, app, process, ROOT);
}
const sheetTexts = (file, n) => {   // 시트마다 글자 — 'A3' 같은 쪽 표식 (txtwrite는 쪽 구분을 넣지 않아 한 장씩 뽑는다)
  const out = [];
  for (let p = 1; p <= n; p++) {
    const t = execFileSync(gsPath, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=txtwrite', `-dFirstPage=${p}`, `-dLastPage=${p}`, '-o', '-', file], { encoding: 'latin1', maxBuffer: 1 << 24 });
    out.push((t.match(/[AB]\d+/g) || []).join(' '));
  }
  return out;
};

app.commandLine.appendSwitch('disable-gpu');
const UD = path.join(os.tmpdir(), 'pdfedit-chresult-e2e');
try { fs.rmSync(UD, { recursive: true, force: true }); } catch (e) {}
app.setPath('userData', UD);
app.whenReady().then(async () => {
  gsPath = installMainHandlers()();
  const win = new BrowserWindow({ show: false, width: 1300, height: 900, ...leftWin(1300, 900),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 3 && !/No handler|Security/.test(msg)) console.log('  [앱] ' + msg.slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const wfPath = path.join(os.tmpdir(), 'pdfedit_chresult.pdfw');

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitApplied = async () => { for (let i = 0; i < 600; i++) { await sleep(100); if (!applying && processedPdfBytes && document.querySelectorAll('#previewGrid .pv-cell').length) break; } await sleep(500); };
    window.confirm = () => window.__yes !== false;
    // 합성: A장 3쪽 + B장 3쪽(둘 다 홀수 — 2쪽 모아찍기에서 남는 칸이 생긴다)
    const d = await PDFLib.PDFDocument.create(); const f = await d.embedFont(PDFLib.StandardFonts.Helvetica);
    ['A1','A2','A3','B1','B2','B3'].forEach(t => { const p = d.addPage([300, 420]); p.drawText(t, { x: 90, y: 200, size: 60, font: f }); });
    const b = await d.save();
    startLoad([{ name: 'ch.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.slice(0).buffer) }]);
    for (let i = 0; i < 300 && !(pageResults.length === 6 && pageResults.every(r => r && r.thumbnail) && isTabReady(tabs.get(activeTabId))); i++) await sleep(100);
    pageResults.forEach((r, i) => { r.chapter = i < 3 ? 'A장' : 'B장'; }); rerenderPages();
    // 2쪽 모아찍기(가로 2 × 세로 1), 단면 — 체크박스는 꺼 둔 채(모아찍기는 강제로 챕터별이어야 한다)
    setImpMode('nup'); setCutSides(1);
    document.getElementById('impAcross').value = '2'; document.getElementById('impDown').value = '1';
    const pc = document.getElementById('impPerChapter');
    ck('모아찍기: 챕터별로 따로가 켜진 채 잠김', pc.checked && pc.disabled, { checked: pc.checked, disabled: pc.disabled });
    if (!_impEnabled) toggleImpEnabled(true);
    await applyChanges(); await waitApplied();
    const divs = () => [...document.querySelectorAll('#previewGrid .chapter-divider')];
    const between = () => { const c = []; let k = -1; [...document.getElementById('previewGrid').children].forEach(el => { if (el.classList.contains('chapter-divider')) { c.push(0); k++; } else if (el.classList.contains('pv-cell') && k >= 0) c[k]++; }); return c; };
    ck('결과 화면이 기본으로 보인다', document.getElementById('previewSection').style.display !== 'none');
    ck('결과 시트에 챕터 구분선 2개 · 시트 2장씩', divs().length === 2 && JSON.stringify(between()) === '[2,2]', { n: divs().length, between: between() });
    ck('구분선 표기: 원고 3쪽 → 2장', divs().every(d => /원고 3쪽 → 2장/.test(d.querySelector('.chapter-pages').textContent)), divs().map(d => d.querySelector('.chapter-pages').textContent));
    ck('구분선 버튼 ✏ ▲▼ 🗑', divs()[0].querySelectorAll('.ch-btn').length === 4);
    const t1 = window.electronAPI.writeTempFile(processedPdfBytes, 'pdf');
    // ▼: A장을 아래로 → 결과 화면 유지·순서 바뀜
    divs()[0].querySelectorAll('.ch-btn')[2].click(); await sleep(300); await waitApplied();
    ck('▼ 뒤에도 결과 화면 유지 · B장이 먼저', document.getElementById('previewSection').style.display !== 'none' && /B장/.test(divs()[0].textContent), divs().map(d => d.querySelector('.chapter-name').textContent));
    // 🗑 취소 → 그대로
    window.__yes = false; const n0 = pageResults.length;
    divs()[1].querySelector('.ch-del').click(); await sleep(400);
    ck('🗑 취소: 쪽도 결과 화면도 그대로', pageResults.length === n0 && divs().length === 2);
    // 작업 파일 저장 → 다시 열기: 구분선 유지(재계산 없이)
    window.__yes = true;
    const wf = await buildWorkFileBytes();
    const wfTmp = window.electronAPI.writeTempFile(wf.bytes, 'pdf');
    return { out, t1, wfTmp };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); return { out }; }
  })()`);

  if (res.t1) {
    const sheets = sheetTexts(res.t1, 4);
    const mixed = sheets.filter(s => /A/.test(s) && /B/.test(s));
    res.out.push([sheets.length === 4 && !mixed.length && sheets[1] === 'A3' && sheets[3] === 'B3' ? '✔' : '✘',
      '결과 시트 글자: 두 챕터가 한 시트에 없음 · 챕터 끝 시트는 한 쪽만(나머지 빈칸)', JSON.stringify(sheets)]);
    try { fs.unlinkSync(res.t1); } catch (e) {}
  }
  // 작업 파일을 정식 이름으로 옮겨 다시 연다
  if (res.wfTmp) {
    fs.copyFileSync(res.wfTmp, wfPath); try { fs.unlinkSync(res.wfTmp); } catch (e) {}
    const r2 = await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (const id of [...tabs.keys()]) { try { closeTab(id, { force: true }); } catch (e) {} }
      await sleep(400);
      await openWorkFilePath(${JSON.stringify(wfPath)});
      for (let i = 0; i < 300 && !(pageResults.length && isTabReady(tabs.get(activeTabId)) && document.querySelectorAll('#previewGrid .pv-cell').length); i++) await sleep(100);
      await sleep(600);
      return { dividers: document.querySelectorAll('#previewGrid .chapter-divider').length, cells: document.querySelectorAll('#previewGrid .pv-cell').length };
    })()`);
    res.out.push([r2.dividers === 2 && r2.cells === 4 ? '✔' : '✘', '작업 파일 다시 열기: 결과 화면 구분선 그대로', JSON.stringify(r2)]);
    try { fs.unlinkSync(wfPath); } catch (e) {}
  }
  // 중철은 종전대로 — 체크하지 않으면 챕터를 나누지 않는다(합본 한 권)
  const r3 = await win.webContents.executeJavaScript(`(async () => {
    setImpMode('booklet');
    const pc = document.getElementById('impPerChapter');
    return { forced: impPerChapterForced(), on: impPerChapterOn(), disabled: pc.disabled };
  })()`);
  res.out.push([!r3.forced && !r3.disabled ? '✔' : '✘', '중철은 강제 아님(체크 풀림·종전 동작)', JSON.stringify(r3)]);

  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
