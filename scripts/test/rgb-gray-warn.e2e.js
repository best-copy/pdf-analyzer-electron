// ⚠ '화면은 흑백인데 색공간이 컬러'인 원고 감지 — 프린터가 컬러로 세는 원인을 분석 단계에서 알리는지.
//   실행: npx electron scripts/test/rgb-gray-warn.e2e.js
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, StandardFonts, rgb, grayscale } = PDFLib;

    // ① 회색을 RGB 값으로 칠한 원고 (프린터가 컬러로 세는 유형)
    const mkRgbGray = async () => {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 2; i++) {
        const p = d.addPage([300, 420]);
        p.drawRectangle({ x: 20, y: 20, width: 260, height: 380, color: rgb(0.2, 0.2, 0.2) });   // 0.2 0.2 0.2 rg
        p.drawText('p' + i, { x: 40, y: 380, size: 20, font: f, color: rgb(0, 0, 0) });
      }
      return new Uint8Array(await d.save());
    };
    // ② 회색을 DeviceGray로 칠한 원고 (경고 없어야 정상)
    const mkDeviceGray = async () => {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 2; i++) {
        const p = d.addPage([300, 420]);
        p.drawRectangle({ x: 20, y: 20, width: 260, height: 380, color: grayscale(0.2) });        // 0.2 g
        p.drawText('p' + i, { x: 40, y: 380, size: 20, font: f, color: grayscale(0) });
      }
      return new Uint8Array(await d.save());
    };

    const a = await mkRgbGray(), b = await mkDeviceGray();
    ck('RGB 회색 원고를 감지', docPaintsInColorSpace(a) === true);
    ck('DeviceGray 원고는 감지 안 함', docPaintsInColorSpace(b) === false);

    // 실제 분석 흐름에서 경고가 붙는지
    startLoad([{ name: 'rgbgray.pdf', size: a.length, type: 'application/pdf',
                 arrayBuffer: () => Promise.resolve(a.buffer.slice(0)) }]);
    await waitFor(() => pageResults.length === 2 && pageResults.every(r => r && r.thumbnail));
    await new Promise(r => setTimeout(r, 600));
    ck('분석은 컬러 0쪽으로 판정(화면상 흑백)', pageResults.filter(r => r.isColor).length === 0);
    const panel = document.getElementById('rangeSummary').textContent;
    ck('분석 결과 패널에 프린터 컬러 경고가 남음', /프린터가 컬러 장수로 셉니다/.test(panel), panel.slice(-90));
    ck('경고에 해결 방법도 안내', /DeviceGray로 바뀌어/.test(panel));

    // 잉크 정규화로 적용하면 색 지정 연산자가 DeviceGray로 바뀐다
    processingOptions.bw = false; processingOptions.inkNorm = true;
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    ck('적용본에는 RGB 색 지정이 남지 않음', docPaintsInColorSpace(processedPdfBytes) === false);
    ck('정규화 켠 상태는 위험 0', inkNormRiskCount() === 0, inkNormRiskCount());

    // ⛭ 잉크 정규화를 끄면: 흑백 쪽이 RGB인 채로 나간다 → 경고 대상
    processingOptions.inkNorm = false;
    clearProcessCaches();
    ck('정규화 끄면 위험 페이지 수 = 흑백 쪽 수', inkNormRiskCount() === 2, inkNormRiskCount());
    ck('적용 안내에 정규화 경고 문구', /잉크 정규화가 꺼져 있습니다/.test(inkNormRiskNote()), inkNormRiskNote().slice(0, 40));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    ck('정규화 끈 적용본에는 RGB가 남아 있음(경고가 맞는지 확인)', docPaintsInColorSpace(processedPdfBytes) === true);
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
