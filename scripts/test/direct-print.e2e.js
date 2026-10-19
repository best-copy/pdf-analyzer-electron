// 🖨 인쇄(아크로뱃식 인쇄 창 + 프린터 드라이버 + PDFium) · 2026-10-18
//   실행: npx electron scripts/test/direct-print.e2e.js   (창을 띄우지 않는다 — show:false · gs 필요)
//   ⚠ 실제 프린터로는 보내지 않는다: main.js의 인쇄 구간을 그대로 싣고, 인쇄는 'Microsoft Print to PDF' 드라이버로만
//     돌리되 StartDoc 출력 파일(PE_OUTPUT)을 임시 폴더로 돌린다. 다른 프린터로 인쇄하려 하면 검사가 막는다.
// 확인: 버튼 3곳 · 적용 전 안내 · 프린터 목록('PDF Editor' 제외) · 드라이버 정보(용지·인쇄 가능 영역) ·
//       맞추기+자동 회전 / 실제 크기(크기·가운데) / 쪽 크기에 맞는 용지 / 쪽 범위·역순·짝수 / 회색 명암 · 벡터 출력 ·
//       미리보기 배치 = 출력 배치 · 취소 · 임시 파일 정리
const path = require('path');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { PDFDocument } = require('pdf-lib');
const ROOT = path.join(__dirname, '..', '..');
const TEST_PRINTER = 'Microsoft Print to PDF';

function findGs() {
  for (const d of ['D:/Ghostscript', 'C:/Program Files/gs']) {
    try { for (const v of fs.readdirSync(d).sort().reverse()) { const p = path.join(d, v, 'bin', 'gswin64c.exe'); if (fs.existsSync(p)) return p; } } catch (e) {}
  }
  return 'gswin64c';
}
const GS = findGs();

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-print'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_printtest_'));

// ── main.js 인쇄 구간을 그대로 싣는다 — spawn만 감싸 인쇄 출력을 파일로 돌린다 ──
const jobs = [];
const spawn = (cmd, args, opts) => {
  const env = opts && opts.env;
  if (env && env.PE_MODE === 'print') {
    if (env.PE_PRINTER !== TEST_PRINTER) throw new Error('검사 안전장치: 실제 프린터(' + env.PE_PRINTER + ')로 인쇄하려 함');
    const out = path.join(outDir, `job${jobs.length + 1}.pdf`);
    jobs.push({ out, env: { ...env }, existed: fs.existsSync(env.PE_FILE) });
    opts = { ...opts, env: { ...env, PE_OUTPUT: out } };
  }
  return cp.spawn(cmd, args, opts);
};
const execFile = cp.execFile;
const licenseGate = () => true;
{
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const a = src.indexOf('function listPrintQueues()');
  const b = src.indexOf('\n});', src.indexOf("ipcMain.handle('printer:print'")) + 4;
  const __dirname = ROOT;   // print_helper.ps1·pdfium.dll 경로용
  eval(src.slice(a, b));
}

const out = [];
const ck = (n, c, x) => { out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]); };

// 출력 PDF 쪽 크기(mm)
async function pageSizes(file) {
  const d = await PDFDocument.load(fs.readFileSync(file));
  return d.getPages().map(p => [Math.round(p.getWidth() / 72 * 25.4), Math.round(p.getHeight() / 72 * 25.4)]);
}
// gs로 그려 빨간 테두리(원고 가장자리)의 상자(mm)와 회색 여부를 잰다
function measure(file, page) {
  const ppm = path.join(outDir, 'm.ppm');
  cp.execFileSync(GS, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', '-r50', `-dFirstPage=${page}`, `-dLastPage=${page}`, '-o', ppm, file]);
  const buf = fs.readFileSync(ppm);
  let p = 0; const f = [];
  while (f.length < 4) { while (/\s/.test(String.fromCharCode(buf[p]))) p++; if (buf[p] === 0x23) { while (buf[p] !== 0x0a) p++; continue; } let s = ''; while (!/\s/.test(String.fromCharCode(buf[p]))) s += String.fromCharCode(buf[p++]); f.push(s); }
  p++;
  const w = +f[1], h = +f[2];
  let x0 = w, y0 = h, x1 = -1, y1 = -1, chroma = 0, dark = 0, gx = 0, gy = 0, gn = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = p + (y * w + x) * 3, r = buf[i], g = buf[i + 1], b = buf[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) chroma++;
    const red = r > 150 && g < 110 && b < 110;
    const ink = r < 235 || g < 235 || b < 235;
    if (ink) dark++;
    if (Math.abs(r - 128) < 20 && Math.abs(g - 128) < 20 && Math.abs(b - 128) < 20) { gx += x; gy += y; gn++; }   // 회색 상자(원고 왼쪽 아래)
    if (red || ink) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  const mm = v => Math.round(v / 50 * 25.4 * 10) / 10;
  return { box: x1 < 0 ? null : { x: mm(x0), y: mm(y0), w: mm(x1 - x0 + 1), h: mm(y1 - y0 + 1) }, pageW: mm(w), pageH: mm(h), chroma, dark, grayAt: gn ? { x: mm(gx / gn), y: mm(gy / gn) } : null };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1300, height: 950,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3 && !/No handler|Security|outlineFonts|프리웜/.test(m)) console.log('[앱오류]', m.slice(0, 300)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code}\n})()`);
  const waitJobs = async (n) => { const t = Date.now(); while (jobs.length < n && Date.now() - t < 90000) await new Promise(r => setTimeout(r, 50)); return jobs.length >= n; };
  // 인쇄 창을 열고(우클릭=원본) 테스트 프린터·정보가 준비되면 fill을 실행한다. fill이 'go'를 돌려주면 [인쇄]
  const dialog = (opener, fill) => js(`
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $ = id => document.getElementById(id);
    ${opener};
    let t = Date.now();
    while (Date.now() - t < 60000) { const s = $('prPrinter'); if (s && [...s.options].some(o => o.value === ${JSON.stringify(TEST_PRINTER)})) break; await sleep(50); }
    const sel = $('prPrinter');
    const names = [...sel.options].map(o => o.value);
    if (sel.value !== ${JSON.stringify(TEST_PRINTER)}) { sel.value = ${JSON.stringify(TEST_PRINTER)}; sel.dispatchEvent(new Event('change')); }
    t = Date.now(); await sleep(100);
    while (Date.now() - t < 60000 && (/읽는 중/.test($('prStatus').textContent) || $('prGo').disabled)) await sleep(50);
    const radio = (n, v) => { const r = document.querySelector('input[name=' + n + '][value="' + v + '"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); };
    const set = (id, v) => { const el = $(id); if (el.type === 'checkbox') el.checked = v; else el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    const r = await (async () => { ${fill} })();
    await sleep(400);
    const res = { names, status: $('prStatus').textContent, paper: $('prPaperDim').textContent, warn: $('prWarn').textContent, go: !$('prGo').disabled, extra: r };
    if (r && r.go) $('prGo').click(); else if (r && r.cancel) $('prCancel').click();
    return res;`);
  const waitDone = () => js(`const t = Date.now(); while (!/보냈습니다|하지 못했습니다/.test(document.getElementById('success').textContent + document.getElementById('error').textContent) && Date.now() - t < 90000) await new Promise(r => setTimeout(r, 100));
    const s = document.getElementById('success').textContent, e = document.getElementById('error').textContent;
    document.getElementById('success').textContent = ''; document.getElementById('error').textContent = ''; return s || e;`);

  try {
    // 4쪽 — A4 세로 · A3 가로 · A5 세로 · A4 가로. 빨간 테두리(가장자리)와 회색 상자.
    await js(`
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(50); } return false; };
      window.confirm = () => true;
      try { localStorage.removeItem('printPrefs'); } catch (e) {}
      const { PDFDocument, StandardFonts, rgb } = PDFLib;
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      const MM = 72 / 25.4;
      [[210, 297, 'A4 P'], [420, 297, 'A3 L'], [148, 210, 'A5 P'], [297, 210, 'A4 L']].forEach(([w, h, t]) => {
        const p = d.addPage([w * MM, h * MM]);
        p.drawRectangle({ x: 1.5, y: 1.5, width: w * MM - 3, height: h * MM - 3, borderColor: rgb(0.9, 0.1, 0.1), borderWidth: 3 });
        p.drawText(t, { x: 30, y: h * MM / 2, size: 30, font: f });
        p.drawRectangle({ x: 20, y: 20, width: 40, height: 20, color: rgb(0.5, 0.5, 0.5) });
      });
      const b = await d.save();
      startLoad([{ name: '인쇄시험.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
      await waitFor(() => pageResults.length === 4 && isTabReady(tabs.get(activeTabId)));
      setOutlineEnabled(false);`);

    const st = await js(`return ['printBtn', 'sb-printBtn', 'esPrintBtn'].map(id => { const b = document.getElementById(id); return b ? { id, dis: b.disabled, dim: b.classList.contains('btn-dim') } : { id, missing: true }; });`);
    ck('🖨 인쇄 버튼 3곳 — 적용 전에도 누를 수 있고 흐리게', st.every(b => !b.missing && !b.dis && b.dim), st);
    const err0 = await js(`await printProcessed(); const t = document.getElementById('error').textContent; document.getElementById('error').textContent = ''; return t;`);
    ck('적용 전 좌클릭 → 적용부터 하라는 안내', /적용/.test(err0) && /오른쪽/.test(err0), err0.slice(0, 60));

    // Ctrl+P → 인쇄 창(적용 전이면 원본 그대로) · Esc로 닫힘
    const kp = await js(`const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }));
      const t = Date.now(); while (!document.querySelector('.pr-modal') && Date.now() - t < 10000) await sleep(50);
      const open = !!document.querySelector('.pr-modal'), sub = open ? document.querySelector('.pr-sub').textContent : '';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }));   // 떠 있는 동안 다시 눌러도 하나만
      await sleep(300); const count = document.querySelectorAll('.pr-modal').length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200);
      return { open, sub, count, closed: !document.querySelector('.pr-modal') };`);
    ck('Ctrl+P → 인쇄 창(적용 전 = 원본 그대로)', kp.open && /원본 그대로/.test(kp.sub), kp);
    ck('Ctrl+P를 다시 눌러도 창은 하나 · Esc로 닫힘', kp.count === 1 && kp.closed, kp);

    // ① 모두 · 맞추기 · 자동 방향
    const d1 = await dialog(`printOriginal({ preventDefault() {} })`, `radio('prScale', 'fit'); radio('prOrient', 'auto'); await sleep(300);
      return { go: true, pct: $('prPct').disabled };`);
    ck("프린터 목록에 테스트 프린터가 있고 'PDF Editor'는 없음", d1.names.includes(TEST_PRINTER) && !d1.names.includes('PDF Editor'), d1.names);
    ck('드라이버 정보: 용지 크기 표시', /용지: \d/.test(d1.paper), d1.paper);
    ck('맞추기일 때 비율 칸은 잠김', d1.extra && d1.extra.pct === true);
    await waitJobs(1);
    const m1 = await waitDone();
    ck('① 인쇄 완료 안내', /보냈습니다/.test(m1) && /4쪽/.test(m1), m1.slice(0, 80));
    const j1 = jobs[0];
    if (j1 && fs.existsSync(j1.out)) {
      const sz = await pageSizes(j1.out);
      ck('① 4쪽 모두 같은 용지(드라이버 기본)', sz.length === 4 && sz.every(s => s[0] === sz[0][0] && s[1] === sz[0][1]), sz);
      const pw = sz[0][0], ph = sz[0][1];
      const a3 = measure(j1.out, 2);   // A3 가로 → 세로 용지에 돌려서 맞춤 → 세로로 길게
      ck('① A3 가로 쪽은 돌려 앉혀 용지에 맞춤(세로로 김)', a3.box && a3.box.h > a3.box.w && a3.box.h > ph * 0.9, a3.box);
      ck('① 반시계 90°(원고 왼쪽 아래 → 용지 오른쪽 아래 — 미리보기와 같음)', a3.grayAt && a3.grayAt.x > a3.pageW / 2 && a3.grayAt.y > a3.pageH / 2, a3.grayAt);
      const a5 = measure(j1.out, 3);   // A5 → 맞추기라 확대
      ck('① A5 쪽은 맞추기로 확대', a5.box && a5.box.w > 148 + 30, a5.box);
      ck('① 출력은 벡터(작은 파일)', fs.statSync(j1.out).size < 200000, fs.statSync(j1.out).size);
      ck('① 인쇄 원본 임시 파일 삭제', !fs.existsSync(j1.env.PE_FILE));
      ck('① 작업 이름 = 원본 파일 이름', /인쇄시험\.pdf$/.test(j1.env.PE_DOCNAME), j1.env.PE_DOCNAME);
      ck('① 용지 정보(드라이버)와 출력 용지가 같음', d1.paper.includes(String(pw)) && d1.paper.includes(String(ph)), [d1.paper, sz[0]]);
    } else ck('① 출력 파일', false, j1);

    // ② 페이지 3 · 실제 크기 → A5가 148×210mm 그대로, 용지 가운데
    const d2 = await dialog(`printOriginal({ preventDefault() {} })`, `radio('prRange', 'pages'); set('prSpec', '3'); radio('prScale', 'actual'); await sleep(500);
      return { go: true };`);
    ck('② 미리보기 안내에 배율 100%', /배율 100%/.test(d2.warn), d2.warn);
    await waitJobs(2); await waitDone();
    if (jobs[1] && fs.existsSync(jobs[1].out)) {
      const m = measure(jobs[1].out, 1);
      ck('② 실제 크기: 148×210mm (±1.5)', m.box && Math.abs(m.box.w - 148) <= 1.5 && Math.abs(m.box.h - 210) <= 1.5, m.box);
      ck('② 용지 가운데(좌우·위아래 여백 차 ≤1.5mm)', m.box && Math.abs(m.box.x - (m.pageW - m.box.x - m.box.w)) <= 1.5 && Math.abs(m.box.y - (m.pageH - m.box.y - m.box.h)) <= 1.5, m);
      ck('② 1쪽만 인쇄', (await pageSizes(jobs[1].out)).length === 1);
      ck('② 컬러(빨간 테두리) 그대로', m.chroma > 50, m.chroma);
    } else ck('② 출력 파일', false);

    // ③ PDF 페이지 크기에 따라 용지 선택 + 역순 → 쪽마다 맞는 용지, 순서 뒤집힘
    await dialog(`printOriginal({ preventDefault() {} })`, `radio('prRange', 'all'); set('prPaperByPage', true); set('prReverse', true); radio('prScale', 'actual'); await sleep(400); return { go: true };`);
    await waitJobs(3); await waitDone();
    if (jobs[2] && fs.existsSync(jobs[2].out)) {
      const sz = await pageSizes(jobs[2].out);
      ck('③ 쪽 크기대로 용지 · 역순(A4가로·A5·A3가로·A4세로)', JSON.stringify(sz) === JSON.stringify([[297, 210], [148, 210], [420, 297], [210, 297]]), sz);
    } else ck('③ 출력 파일', false);

    // ④ 짝수 페이지만 + 회색 명암 → 2쪽, 무채색
    await dialog(`printOriginal({ preventDefault() {} })`, `set('prPaperByPage', true); set('prReverse', false); set('prSubset', 'even'); set('prGray', true); await sleep(600); return { go: true };`);
    await waitJobs(4); await waitDone();
    if (jobs[3] && fs.existsSync(jobs[3].out)) {
      const sz = await pageSizes(jobs[3].out);
      ck('④ 짝수 쪽만(2·4쪽 = A3가로·A4가로)', JSON.stringify(sz) === JSON.stringify([[420, 297], [297, 210]]), sz);
      const m = measure(jobs[3].out, 2);
      ck('④ 회색 명암: 색 없음', m.chroma === 0 && m.dark > 100, m);
      ck('④ 드라이버에 흑백(dmColor=1) 전달', jobs[3].env.PE_COLOR === '1' && jobs[3].env.PE_GRAY === '1', [jobs[3].env.PE_COLOR, jobs[3].env.PE_GRAY]);
    } else ck('④ 출력 파일', false);

    // ⑤ 쪽 범위가 틀리면 [인쇄] 잠김 → 취소하면 보내지 않음
    const d5 = await dialog(`printOriginal({ preventDefault() {} })`, `set('prSubset', 'all'); set('prGray', false); radio('prRange', 'pages'); set('prSpec', '3-9'); await sleep(300); return { cancel: true, dis: $('prGo').disabled, warn: $('prWarn').textContent };`);
    ck('⑤ 없는 쪽(3-9)이면 [인쇄] 잠김·안내', d5.extra && d5.extra.dis && /4쪽까지/.test(d5.extra.warn), d5.extra);
    await new Promise(r => setTimeout(r, 800));
    ck('⑤ 취소하면 인쇄하지 않음', jobs.length === 4, jobs.length);

    // ⑥ 적용본(좌클릭) — 적용 후 인쇄, 지난 설정(쪽 크기 용지)을 기억
    await js(`const sleep = ms => new Promise(r => setTimeout(r, ms)); if (!processingOptions.bw) toggleOption('bw'); selectedPages.add(1);
      invalidateProcessed(); await applyChanges(); const t = Date.now(); while (!processedPdfBytes && Date.now() - t < 60000) await sleep(50);`);
    const d6 = await dialog(`printProcessed()`, `radio('prRange', 'all'); return { go: true, remembered: $('prPaperByPage').checked, sub: document.querySelector('.pr-sub').textContent };`);
    ck('⑥ 적용본 인쇄 창은 "완성본" 안내', d6.extra && /완성본/.test(d6.extra.sub), d6.extra && d6.extra.sub);
    ck('⑥ 지난 설정(쪽 크기 용지)을 기억', d6.extra && d6.extra.remembered === true);
    await waitJobs(5); await waitDone();
    if (jobs[4] && fs.existsSync(jobs[4].out)) {
      const m1p = measure(jobs[4].out, 1);
      ck('⑥ 흑백 적용한 1쪽은 무채색으로 인쇄', m1p.chroma === 0 && m1p.dark > 100, m1p.chroma);
      const m2p = measure(jobs[4].out, 2);
      ck('⑥ 컬러로 둔 2쪽은 컬러', m2p.chroma > 50, m2p.chroma);
    } else ck('⑥ 출력 파일', false);
  } catch (e) { ck('실행 오류', false, e && (e.stack || e.message)); }

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(m, n, m === '✔' ? '' : x); });
  console.log(`결과: ${out.length - fail} 통과 / ${fail} 실패`);
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
  app.exit(fail ? 1 : 0);
});
