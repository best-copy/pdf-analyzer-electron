// 🔗 편집본 합치기 — 파일(탭)마다 해 둔 편집을 그대로 적용한 최종본을 이어 붙인다 (2026-10-13 사용자 결정)
//   실행: npx electron scripts/test/edited-merge.e2e.js   (창을 띄우지 않는다)
//   A(세로 4쪽) = 1면 2쪽 모아찍기·용지 원본(적용 안 함 → 자동 적용), B(가로 3쪽) = A4 맞춤(적용함)
//   · 합본 = A의 시트 + B의 A4 쪽, 파일별 챕터 2개 · 합본 탭은 임포징 꺼짐(두 번 걸리지 않게)
//   · 원래 탭의 설정은 그대로 · 합치기 창 버튼 이름
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-editedmerge'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3 && !/No handler|Security|outlineFonts|프리웜/.test(m)) console.log('[앱오류]', m.slice(0, 1500)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(100); } return false; };
    window.confirm = () => true;
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const mk = async (name, n, w, h) => { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= n; i++) d.addPage([w, h]).drawText(name + i, { x: 30, y: h - 60, size: 30, font: f, color: rgb(0, 0, 0) });
      const b = await d.save(); return { name: name + '.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }; };
    startLoad([await mk('A', 4, 300, 420), await mk('B', 3, 420, 300)]);
    await waitFor(() => tabs.size === 2 && [...tabs.values()].every(isTabReady));
    const [idA, idB] = [...tabs.keys()];
    activateTab(idA); await sleep(300); setOutlineEnabled(false);
    qpSetNup('2'); await sleep(300);
    activateTab(idB); await sleep(300); setOutlineEnabled(false);
    qpSetPaper('A4'); invalidateProcessed(); await applyChanges(); await waitFor(() => !!processedPdfBytes);
    const bSheets = (await PDFLib.PDFDocument.load(processedPdfBytes.slice(0))).getPageCount();

    // 합치기 창 버튼
    mergeAllTabs(); await sleep(200);
    ck('합치기 창: 원본 합치기 · 편집본 합치기 두 버튼', /원본 합치기/.test(document.getElementById('mergeConfirm').textContent)
       && /편집본 합치기/.test(document.getElementById('mergeEditedConfirm').textContent));
    document.getElementById('mergeEditedConfirm').click();
    await waitFor(() => tabs.size === 3 && isTabReady(tabs.get(activeTabId)) && tabs.get(activeTabId).editedMerge, 300000);
    await sleep(800);
    const err = (document.getElementById('error') || {}).textContent || ''; if (err) out.push(['✘', '오류 없음', err]);
    const m = tabs.get(activeTabId);
    const sizes = pageResults.filter(Boolean).map(r => [Math.round(r.pageWpt), Math.round(r.pageHpt)]);
    ck('합본 이름 = 첫 파일_편집본합본', m.fileName === 'A_편집본합본.pdf', m.fileName);
    // A: 4쪽 1면 2쪽(양면) → 2시트, B: A4 가로 3쪽
    ck('A 부분 = 모아찍기 시트 2장(세로 300×420 두 쪽 → 600×420)', sizes.slice(0, 2).every(s => s[0] === 600 && s[1] === 420), sizes);
    ck('B 부분 = A4 맞춤 쪽(' + bSheets + '쪽)', sizes.length === 2 + bSheets && sizes.slice(2).every(s => s[0] === 842 && s[1] === 595), sizes);
    const runs = chapterRuns();
    ck('파일별 챕터 2개', runs.length === 2 && runs[0].idxs.length === 2 && runs[1].idxs.length === bSheets, runs.map(r => r.name + ':' + r.idxs.length));
    ck('합본 탭은 임포징 꺼짐(두 번 걸리지 않게)', !_impEnabled);
    activateTab(idA); await sleep(300);
    ck('A 탭 설정은 그대로(1면 2쪽)', _impEnabled && _impMode === 'nup' && document.getElementById('qpNup').value === '2');
    activateTab(idB); await sleep(300);
    ck('B 탭은 임포징 없음·결과 유지', !_impEnabled && !!processedPdfBytes);
    return out;
  })()`);
  let fail = 0;
  res.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(m, n, m === '✔' ? '' : x); });
  console.log(`결과: ${res.length - fail} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
