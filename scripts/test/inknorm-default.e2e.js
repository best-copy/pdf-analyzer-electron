// ⛭ 잉크 정규화는 '항상 기본 켬' — 새 문서·해제 버튼·저장된 설정 복원이 이걸 끄지 않는지.
// (꺼진 채 저장하면 흑백 페이지가 RGB 색공간 그대로 나가 프린터가 컬러로 센다)
//   실행: npx electron scripts/test/inknorm-default.e2e.js
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
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const mk = async (tag, n) => {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= n; i++) {
        const p = d.addPage([300, 420]);
        p.drawRectangle({ x: 20, y: 20, width: 260, height: 380, color: rgb(0.2, 0.2, 0.2) });  // RGB 회색
        p.drawText(tag + i, { x: 40, y: 380, size: 18, font: f, color: rgb(0, 0, 0) });
      }
      const b = await d.save();
      return { name: tag + '.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) };
    };

    startLoad([await mk('A', 2)]);
    await waitFor(() => pageResults.length === 2 && pageResults.every(r => r && r.thumbnail));
    ck('① 문서를 열면 잉크 정규화 켜짐', processingOptions.inkNorm === true);

    // ② '✖ 해제'는 흑백변환만 끈다
    processingOptions.bw = true;
    clearOptions();
    ck('② 해제해도 잉크 정규화는 유지', processingOptions.inkNorm === true && processingOptions.bw === false,
       JSON.stringify(processingOptions));
    ck('② 버튼 표시도 켜짐', document.getElementById('opt-inkNorm').classList.contains('active'));

    // ③ 저장된 설정(꺼짐)을 복원해도 꺼지지 않는다
    applyPresetData({ proc: { bw: false, inkNorm: false } });
    await new Promise(r => setTimeout(r, 300));
    ck('③ 꺼짐으로 저장된 설정을 불러와도 유지', processingOptions.inkNorm === true, processingOptions.inkNorm);
    ck('③ 켜짐으로 저장된 설정도 정상 반영', (() => {
      toggleOption('inkNorm');                       // 직접 끔
      applyPresetData({ proc: { inkNorm: true } });   // 저장된 켜짐 복원
      return processingOptions.inkNorm === true;
    })());

    // ④ 직접 끄는 것은 가능하고, 그 문서에서만 유지된다
    toggleOption('inkNorm');
    ck('④ 직접 끄면 꺼짐', processingOptions.inkNorm === false);
    ck('④ 끄면 경고 안내가 뜸', /프린터가 그 페이지를 컬러 장수로 셀 수 있습니다/.test(
      (document.getElementById('success') || {}).textContent || ''));
    ck('④ 끈 상태에서 위험 페이지 수가 잡힘', inkNormRiskCount() === 2, inkNormRiskCount());

    // ⑤ 새 문서를 열면 다시 켜져 있다
    startLoad([await mk('B', 2)]);
    await waitFor(() => pageResults.length === 2 && pageResults.every(r => r && r.thumbnail) && originalFileName === 'B', 60000);
    await new Promise(r => setTimeout(r, 300));
    ck('⑤ 새 문서에서는 다시 켜짐', processingOptions.inkNorm === true, processingOptions.inkNorm);
    ck('⑤ 위험 없음', inkNormRiskCount() === 0);
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
