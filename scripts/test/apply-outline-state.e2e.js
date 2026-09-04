// ✔ '적용' 버튼과 ✒ 폰트 출력 안전화의 상태 규칙.
//   · 안전화는 **저장 시점 처리**라 '수정사항'이 아니다 → 적용 버튼을 활성화하지 않는다.
//     대신 다운로드 버튼에 배지(🔤/✒)로 반영 여부를 항상 보여 준다.
//   · 문서를 열 때 도는 '방향 자동 맞춤'은 사용자가 한 일이 아니므로 깜박이지 않는다.
//   실행: npx electron scripts/test/apply-outline-state.e2e.js
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 1500));

  const run = (js) => win.webContents.executeJavaScript(js);
  const SETUP = `(async () => {
    const waitFor = async (f, ms) => { const t = Date.now();
      while (Date.now() - t < (ms || 120000)) { if (f()) return true; await new Promise(r => setTimeout(r, 40)); } return false; };
    window.__S = (tag) => { const b = document.getElementById('applyBtn'), d = document.getElementById('downloadBtn');
      return { tag, outline: _outlineEnabled, applyDisabled: b.disabled,
               blink: b.classList.contains('needs-apply'), processed: !!processedPdfBytes,
               dlLabel: d.textContent.trim(), dlTitle: d.title }; };
    window.__open = async (landscape) => {
      const { PDFDocument, StandardFonts, rgb } = PDFLib;
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 4; i++) { const p = d.addPage(i === 3 && landscape ? [842, 595] : [595, 842]);
        p.drawText('P' + i, { x: 60, y: 400, size: 40, font: f, color: rgb(0, 0, 0) }); }
      const b = await d.save(); const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      startLoad([{ name: (landscape ? 'mixed' : 'plain') + '.pdf', size: b.byteLength, type: 'application/pdf',
                   arrayBuffer: () => Promise.resolve(buf.slice(0)) }]);
      await waitFor(() => pageResults.length === 4 && pageResults.every(r => r && r.thumbnail));
      await new Promise(r => setTimeout(r, 900));
    };
    return true;
  })()`;

  try {
    await run(SETUP);
    await run('window.__open(false)');

    console.log('\n[1] 안전화 = 저장 시점 처리 (적용 대상 아님)');
    // 다른 수정이 없는 상태를 만든다 — 잉크 정규화도 끈다
    const off = await run(`(() => { processingOptions.inkNorm = false; setOutlineEnabled(false);
      updateDownloadBtn(); return __S('기준'); })()`);
    ck('수정이 하나도 없으면 적용 버튼 비활성', off.applyDisabled === true, off);
    const on = await run(`(() => { setOutlineEnabled(true); return __S('안전화만 켬'); })()`);
    ck('안전화만 켜도 적용 버튼은 그대로 비활성', on.applyDisabled === true, on);
    ck('다운로드 버튼에 🔤 배지가 붙는다', /🔤/.test(on.dlLabel), on.dlLabel);
    ck('배지 설명에 "적용은 필요 없습니다"', /적용은 필요 없습니다/.test(on.dlTitle), on.dlTitle);
    const off2 = await run(`(() => { setOutlineEnabled(false); return __S('안전화 끔'); })()`);
    ck('끄면 배지도 사라진다', !/🔤|✒/.test(off2.dlLabel), off2.dlLabel);
    const curve = await run(`(() => { setOutlineEnabled(true); setOutlineMode('outline'); return __S('곡선화'); })()`);
    ck('곡선화 모드는 ✒ 배지', /✒/.test(curve.dlLabel), curve.dlLabel);
    await run(`(() => { setOutlineMode('embed'); processingOptions.inkNorm = true; updateDownloadBtn(); })()`);

    console.log('\n[2] 적용한 뒤 안전화를 체크해도 상태가 보인다');
    await run(`(async () => { document.getElementById('applyBtn').click();
      const t = Date.now(); while (applying && Date.now() - t < 120000) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 300)); })()`);
    const applied = await run(`__S('적용 후')`);
    ck('적용 결과가 만들어졌다', applied.processed === true, applied);
    const after = await run(`(() => { setOutlineEnabled(false); setOutlineEnabled(true); return __S('적용 뒤 체크'); })()`);
    ck('적용본은 버리지 않는다(재적용 불필요)', after.processed === true, after);
    ck('그래도 배지로 반영 여부가 보인다', /🔤/.test(after.dlLabel), after.dlLabel);

    console.log('\n[3] 방향 자동 맞춤은 "적용 필요"로 깜박이지 않는다');
    await run('window.__open(true)');            // 가로 페이지가 섞인 문서
    const auto = await run(`__S('자동 회전 문서')`);
    ck('자동 회전이 돌아도 깜박이지 않는다', auto.blink === false, auto);
    ck('적용 버튼은 활성(회전을 반영하려면 적용이 필요)', auto.applyDisabled === false, auto);
    const manual = await run(`(() => { selectedPages.clear();
      pageResults.forEach(r => { if (r) selectedPages.add(r.pageNum); });
      if (typeof rotatePages === 'function') rotatePages(90);
      else { pageEdited = true; pageEditedByUser = true; processedPdfBytes = null; }
      updateDownloadBtn(); return __S('사용자가 직접 회전'); })()`);
    ck('사용자가 직접 돌리면 깜박인다', manual.blink === true, manual);
  } catch (e) { console.log('  ✘ 하네스 오류:', e && e.message); fail++; }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
