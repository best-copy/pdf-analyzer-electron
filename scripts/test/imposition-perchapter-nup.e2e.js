// 📄 파일(챕터)별 임포징이 '조판이 쪽 수를 바꾸는' 경우에도 먹는지 —
// 모아찍기(N-up)·정합처럼 여러 쪽이 한 칸으로 합쳐질 때 칸이 파일 경계를 넘지 않아야 한다.
// 그리고 챕터별 편집 설정(용지 등)이 편집창을 나온 뒤에도 파일마다 그대로 적용되어야 한다.
//   실행: npx electron scripts/test/imposition-perchapter-nup.e2e.js
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    // 파일마다 다른 색 띠 — 시트 안에서 어느 파일의 쪽인지 알아보기 위해
    const mk = async (tag, n, color) => {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= n; i++) {
        const p = d.addPage([420, 595]);
        p.drawRectangle({ x: 0, y: 545, width: 420, height: 50, color });
        p.drawText(tag + i, { x: 40, y: 480, size: 40, font: f, color: rgb(0, 0, 0) });
      }
      const b = await d.save(); const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return { name: tag + '.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) };
    };

    // A 3쪽 + B 3쪽 — 2up(1열 2행)이면 파일마다 2시트(마지막 칸은 빈칸), 전체로 걸면 3시트
    await openMergedAsChapters([await mk('A', 3, rgb(1, 0, 0)), await mk('B', 3, rgb(0, 0, 1))]);
    await waitFor(() => pageResults.length === 6 && pageResults.every(r => r && r.thumbnail));
    await new Promise(r => setTimeout(r, 700));

    toggleEditSidebar(true);
    await new Promise(r => setTimeout(r, 400));
    setImpMode('nup');
    document.getElementById('impAcross').value = 1;
    document.getElementById('impDown').value = 2;
    setCutSides(1);                       // 단면 — 시트 수로 파일별 여부를 명확히 구분하기 위해
    impSettingsChanged();
    toggleImpEnabled(true, true);
    document.getElementById('impPerChapter').checked = false; impPerChapterChanged();
    await new Promise(r => setTimeout(r, 2000));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const whole = (await PDFDocument.load(processedPdfBytes.slice(0))).getPageCount();
    ck('전체 모아찍기 2up(단면): 6쪽 → 3시트', whole === 3, whole);

    // 📄 파일별로 따로 — A 2시트 + B 2시트 = 4시트 (칸이 파일 경계를 넘지 않음)
    document.getElementById('impPerChapter').checked = true; impPerChapterChanged();
    await new Promise(r => setTimeout(r, 2500));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const per = (await PDFDocument.load(processedPdfBytes.slice(0))).getPageCount();
    ck('파일별 모아찍기: A 2시트 + B 2시트 = 4시트 (전체 3시트와 다름)', per === 4 && whole === 3, { per, whole });
    ck('구간이 파일 2개로 기록', JSON.stringify(impChapterRanges()) === JSON.stringify([
      { name: 'A.pdf', from: 1, to: 2 }, { name: 'B.pdf', from: 3, to: 4 }]), impChapterRanges());
    ck('나누지 못했다는 경고 없음', impPerChapterStatusNote() === '', impPerChapterStatusNote());

    // 편집창을 나와도 그대로 (메인 화면 기준 재적용)
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 1500));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const per2 = (await PDFDocument.load(processedPdfBytes.slice(0))).getPageCount();
    ck('편집창을 나와도 파일별 4시트 유지', per2 === 4, per2);

    // ── 챕터별 편집 설정이 파일마다 그대로 적용되는지 ────────────────────────
    // B 챕터만 A4 용지로 맞춘 뒤, 파일별 임포징 결과에서 B 구간 시트만 커져야 한다
    editChapter('B.pdf');
    await waitFor(() => document.body.classList.contains('edit-fullscreen'));
    await new Promise(r => setTimeout(r, 800));
    setScaleMode('standard');
    const psel = document.getElementById('esPaperSel'); psel.value = 'A4'; psel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1500));
    setEditScope('all');
    await new Promise(r => setTimeout(r, 800));
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 1200));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const doc = await PDFDocument.load(processedPdfBytes.slice(0));
    const sizes = doc.getPages().map(p => Math.round(p.getWidth()) + 'x' + Math.round(p.getHeight()));
    ck('시트 수는 그대로 4장', sizes.length === 4, sizes.length);
    const ranges = impChapterRanges() || [];
    const bRange = ranges.find(r => r.name === 'B.pdf');
    ck('B 챕터 구간이 기록됨', !!bRange, ranges);
    // A는 원고 크기(420x595) 2up → 시트 420x1190 근처, B는 A4(595x842) 2up → 595x1684 근처
    const aSheets = sizes.slice(0, 2), bSheets = bRange ? sizes.slice(bRange.from - 1, bRange.to) : [];
    ck('A 파일 시트와 B 파일 시트 크기가 다름 (챕터별 설정이 파일별로 적용됨)',
       aSheets.length && bSheets.length && aSheets[0] !== bSheets[0], { aSheets, bSheets });
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
