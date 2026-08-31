// 🔖 내부 편집기에서 '이 페이지의 머리글·바닥글' 확인·수정 E2E
//   실행: npx electron scripts/test/hf-editor.e2e.js
// ① 편집기로 넘기는 페이지별 문구가 실제 인쇄될 문구와 같은지(해석·범위 포함)
// ② 편집기에서 고친 문구가 그 페이지에만 반영되는지 — 결과 PDF 텍스트로 확인
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  let res;
  try {
    res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 40000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const d = await PDFDocument.create(); const ft = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 6; i++) { const p = d.addPage([300, 420]); p.drawText('x' + i, { x: 20, y: 380, size: 10, font: ft, color: rgb(0,0,0) }); }
    const b = await d.save(); const bf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    startLoad([{ name: 'hf.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(bf.slice(0)) }]);
    ck('6쪽 분석', await waitFor(() => pageResults.length === 6 && pageResults.every(r => r && r.thumbnail)));
    await new Promise(r => setTimeout(r, 500));

    const footers = async (bytes) => {
      const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const arr = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        arr.push(tc.items.map(t => t.str).filter(s => /^#/.test(s.trim())).join('').trim());
      }
      await doc.destroy(); return arr;
    };

    toggleEditSidebar(true);
    await new Promise(r => setTimeout(r, 400));
    const hf = activeLayoutSettings().hf;
    hf.enabled = true; hf.fC = '#{n}'; hf.pnumStyle = 0; hf.start = 2; hf.numFrom = 10;
    syncEditUI();

    // ① 편집기로 넘길 페이지별 문구 — 실제 인쇄물과 같아야 한다
    const info3 = hfForPage(3);
    ck('3쪽 문구 해석 = #11 (2쪽부터 10번)', info3 && info3.fields.fC === '#11', info3 && info3.fields);
    const info1 = hfForPage(1);
    ck('1쪽은 번호 전 — 문구만', info1 && info1.fields.fC === '#', info1 && info1.fields);
    let f = await footers((await applyChanges(), processedPdfBytes));
    ck('편집기에 넘길 문구 = 실제 인쇄 문구', f[2] === info3.fields.fC && f[0] === info1.fields.fC, [f[0], f[2]]);

    // 적용 범위 밖 페이지는 apply=false로 알려준다
    setHfApplyMode('from'); activeLayoutSettings().hf.applyFrom = 4;
    ck('범위 밖(2쪽) apply=false', hfForPage(2).apply === false);
    ck('범위 안(5쪽) apply=true', hfForPage(5).apply === true);
    setHfApplyMode('all');

    // ② 편집기 결과(페이지별 덮어쓰기) 반영
    await applyEditorResult({ edits: {}, removed: [], hfOverrides: { 3: { hL:'', hC:'', hR:'', fL:'', fC:'#고친문구', fR:'' } } });
    await new Promise(r => setTimeout(r, 300));
    ck('덮어쓰기가 설정에 저장됨', !!(editSettings.hf.perPage && editSettings.hf.perPage[3]), editSettings.hf.perPage);
    f = await footers((await applyChanges(), processedPdfBytes));
    ck('3쪽만 고친 문구로 인쇄', f[2] === '#고친문구', f);
    ck('다른 쪽은 그대로', f[3] === '#12' && f[5] === '#14', f);
    ck('편집기 재진입 시 고친 문구가 보임', hfForPage(3).fields.fC === '#고친문구' && hfForPage(3).over === true);

    // ③ 되돌리기(null) — 문서 설정으로 복귀
    await applyEditorResult({ edits: {}, removed: [], hfOverrides: { 3: null } });
    await new Promise(r => setTimeout(r, 300));
    f = await footers((await applyChanges(), processedPdfBytes));
    ck('되돌리면 원래 번호로', f[2] === '#11' && !(editSettings.hf.perPage || {})[3], f);
    return out;
  })()`);
  } catch (e) { console.error('  ✘ 스크립트 실행 오류:', e && e.message); app.exit(1); return; }

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
