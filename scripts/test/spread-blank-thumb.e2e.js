// 📖 펼침 보기에서 빈 쪽(originalIdx null)에 1쪽 그림이 구워지던 버그 회귀 — app-core thumbUpgradable
//   실행: npx electron scripts/test/spread-blank-thumb.e2e.js   (실파일: 울진군 보고서 .pdfw 202쪽 빈 쪽, 2026-10-01)
const path = require('path'); const os = require('os'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const { leftWin } = require('./_leftwin');
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-blankspread'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1400, height: 900, ...leftWin(1400, 900),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const out = await win.webContents.executeJavaScript(`(async () => { const sleep = ms => new Promise(r => setTimeout(r, ms));
    const { PDFDocument, StandardFonts, rgb } = PDFLib; const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i++) { const p = d.addPage([420, 595]); p.drawText('P' + i, { x: 60, y: 300, size: 120, font: f, color: rgb(0,0,0) }); }
    const b = await d.save(); startLoad([{ name: 'blank.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    while (!(pageResults.length === 4 && isTabReady(tabs.get(activeTabId)))) await sleep(100); await sleep(500); hideError(); hideSuccess();
    insertBlankPage(3); await sleep(800);
    const blank = pageResults[pageResults.length - 1]; const t0 = blank.thumbnail;
    toggleSpreadView(true); document.getElementById('pagesGrid').lastElementChild.scrollIntoView(); await sleep(4000);
    // 빈 쪽 그림의 실제 픽셀: 어두운 픽셀 비율
    const img = document.querySelector('#pagesGrid [data-page="5"] .page-thumbnail'); await img.decode().catch(()=>{});
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 100) dark++;
    return JSON.stringify({ isBlank: blank.isBlank, oi: blank.originalIdx, changed: blank.thumbnail !== t0, thumbW: blank.thumbW, darkPct: +(100 * dark / (px.length / 4)).toFixed(2), w: c.width });
  })()`);
  const r = JSON.parse(out); const ok = r.isBlank && !r.changed && r.darkPct === 0;
  console.log((ok ? '  ✔' : '  ✘') + ' 펼침 보기에서 빈 쪽은 빈 그대로', out);
  console.log(ok ? 'PASS 1/1' : 'FAIL'); app.exit(ok ? 0 : 1);
});
