// 📄 챕터(파일)별 임포징 E2E — 합본을 파일마다 따로 대수로 만들어 이어붙이는지,
// 편집 모드에서 챕터를 집중하면 그 파일의 대수만 보이는지 확인한다.
//   실행: npx electron scripts/test/imposition-perchapter.e2e.js
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
    const mk = async (name, n) => {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= n; i++) { const p = d.addPage([420, 595]); p.drawText(name + i, { x: 40, y: 500, size: 28, font: f, color: rgb(0,0,0) }); }
      const b = await d.save(); const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return { name: name + '.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) };
    };
    const cells = () => document.querySelectorAll('#previewGrid .pv-cell');

    // A 8쪽 + B 4쪽 = 12쪽 합본 (중철: A는 시트 4장, B는 시트 2장)
    await openMergedAsChapters([await mk('A', 8), await mk('B', 4)]);
    await waitFor(() => pageResults.length === 12 && pageResults.every(r => r && r.thumbnail));
    await new Promise(r => setTimeout(r, 700));

    toggleEditSidebar(true);
    await new Promise(r => setTimeout(r, 400));
    ck('합본이라 챕터별 임포징 옵션이 보임',
       document.getElementById('impPerChapterWrap').style.display !== 'none');

    // 임포징(중철) 켜기 — 우선 전체 문서 기준
    setImpMode('booklet');
    toggleImpEnabled(true);
    await new Promise(r => setTimeout(r, 2500));
    await waitFor(() => !!processedPdfBytes, 60000);
    const whole = await PDFDocument.load(processedPdfBytes.slice(0));
    ck('전체 임포징: 12쪽 → 시트 6장', whole.getPageCount() === 6, whole.getPageCount());

    // 📄 챕터별로 따로 임포징
    const pc = document.getElementById('impPerChapter');
    pc.checked = true; impPerChapterChanged();
    await new Promise(r => setTimeout(r, 3000));
    await waitFor(() => !!processedPdfBytes, 60000);
    const per = await PDFDocument.load(processedPdfBytes.slice(0));
    ck('챕터별 임포징: A 4장 + B 2장 = 6장', per.getPageCount() === 6, per.getPageCount());
    ck('챕터 구간이 기록됨', JSON.stringify(impChapterRanges()) === JSON.stringify([
      { name: 'A.pdf', from: 1, to: 4 }, { name: 'B.pdf', from: 5, to: 6 }]), impChapterRanges());

    // 시트 크기: 각 챕터가 독립 대수 → 모두 같은 용지(A5 2up = A4 가로)
    const sizes = per.getPages().map(p => Math.round(p.getWidth()) + 'x' + Math.round(p.getHeight()));
    ck('모든 시트 크기 동일', new Set(sizes).size === 1, sizes);

    // 챕터 집중 → 그 파일의 대수만 화면에 (임포징 포함 상태)
    editChapter('B.pdf');
    await waitFor(() => document.body.classList.contains('edit-fullscreen'));
    await new Promise(r => setTimeout(r, 3000));
    ck('B 챕터 집중 시 그 파일 시트 2장만 표시', cells().length === 2, cells().length);
    setEditScope('all');
    await new Promise(r => setTimeout(r, 2500));
    ck('전체 범위면 시트 6장 모두 표시', cells().length === 6, cells().length);

    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 400));

    // ── 파일마다 4의 배수가 아닌 경우: 전체와 결과가 달라져야 한다 ──────────
    // A 5쪽 + B 5쪽 = 10쪽. 전체 중철이면 12쪽 채워 시트 6장,
    // 파일별이면 각각 8쪽으로 채워 4장+4장 = 8장 (파일마다 독립 제본이므로)
    closeTab(activeTabId);
    await new Promise(r => setTimeout(r, 300));
    await openMergedAsChapters([await mk('C', 5), await mk('D', 5)]);
    await waitFor(() => pageResults.length === 10 && pageResults.every(r => r && r.thumbnail));
    await new Promise(r => setTimeout(r, 700));
    toggleEditSidebar(true);
    setImpMode('booklet');
    toggleImpEnabled(true);
    document.getElementById('impPerChapter').checked = false; impPerChapterChanged();
    await new Promise(r => setTimeout(r, 2500));
    await waitFor(() => !!processedPdfBytes, 60000);
    const w2 = await PDFDocument.load(processedPdfBytes.slice(0));
    ck('전체 중철: 10쪽 → 시트 6장', w2.getPageCount() === 6, w2.getPageCount());
    document.getElementById('impPerChapter').checked = true; impPerChapterChanged();
    await new Promise(r => setTimeout(r, 3000));
    await waitFor(() => !!processedPdfBytes, 60000);
    const p2 = await PDFDocument.load(processedPdfBytes.slice(0));
    ck('파일별 중철: 4장 + 4장 = 8장', p2.getPageCount() === 8, p2.getPageCount());
    ck('파일별 구간 기록', JSON.stringify(impChapterRanges()) === JSON.stringify([
      { name: 'C.pdf', from: 1, to: 4 }, { name: 'D.pdf', from: 5, to: 8 }]), impChapterRanges());
    // ── 챕터를 편집 중이어도 결과에는 모든 챕터가 남아야 한다 ──────────────
    // (한때 챕터 범위면 그 챕터만 남겨서, 메인으로 나오면 다른 파일이 통째로 사라졌다)
    editChapter('D.pdf');
    await waitFor(() => document.body.classList.contains('edit-fullscreen'));
    await new Promise(r => setTimeout(r, 1500));
    ck('편집 화면은 D 챕터 대수만', cells().length === 4, cells().length);
    setImpGenDone(false);
    await generateImposition();
    await waitFor(() => !!processedPdfBytes, 120000);
    const gen = await PDFDocument.load(processedPdfBytes.slice(0));
    ck('생성 결과는 전체(파일별 4+4=8장)', gen.getPageCount() === 8, gen.getPageCount());

    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const ap = await PDFDocument.load(processedPdfBytes.slice(0));
    ck('적용 결과도 전체 8장', ap.getPageCount() === 8, ap.getPageCount());

    // 편집 모드를 나오면 문서 전체(모든 챕터)가 보인다
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 1500));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const ap2 = await PDFDocument.load(processedPdfBytes.slice(0));
    ck('메인 화면에서도 전체 8장', ap2.getPageCount() === 8, ap2.getPageCount());
    ck('두 챕터 구간이 모두 남아 있음', JSON.stringify(impChapterRanges()) === JSON.stringify([
      { name: 'C.pdf', from: 1, to: 4 }, { name: 'D.pdf', from: 5, to: 8 }]), impChapterRanges());
    setEditScope('all');
    await new Promise(r => setTimeout(r, 800));

    // ── 직접 끈 '임포징' 체크가 되살아나지 않아야 한다 ──────────────────────
    toggleImpEnabled(false, true);              // 사용자가 체크를 끔
    await new Promise(r => setTimeout(r, 600));
    ck('끈 직후 꺼진 상태', !_impEnabled && !document.getElementById('impEnabled').checked);
    // 프리셋 불러오기 — 예전엔 여기서 자동으로 다시 켜졌다
    const psel3 = document.getElementById('impProfile');
    if (psel3 && psel3.options.length > 1) { psel3.selectedIndex = 1; loadImpProfile(); }
    await new Promise(r => setTimeout(r, 600));
    ck('프리셋 불러와도 꺼진 채', !_impEnabled && !document.getElementById('impEnabled').checked);
    // 임포징 생성 — 결과는 보여주되 체크는 켜지 않고, 저장은 그 결과 그대로
    setImpMode('booklet');
    setImpGenDone(false);
    await generateImposition();
    await waitFor(() => !!processedPdfBytes, 120000);
    ck('생성해도 체크는 꺼진 채', !_impEnabled && !document.getElementById('impEnabled').checked);
    ck('생성 결과가 그대로 저장되는 경로', !!directOutputBytes);
    // 다시 켜면 '직접 끔' 표시 해제
    toggleImpEnabled(true, true);
    await new Promise(r => setTimeout(r, 600));
    ck('다시 켜면 켜진 상태', _impEnabled && document.getElementById('impEnabled').checked);

    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 400));

    // ── 체크만 하면 '적용' 결과가 실제로 파일별로 갈리는지 (메인 화면 기준) ──────
    closeTab(activeTabId);
    await new Promise(r => setTimeout(r, 300));
    await openMergedAsChapters([await mk('E', 5), await mk('F', 5), await mk('G', 5)]);
    await waitFor(() => pageResults.length === 15 && pageResults.every(r => r && r.thumbnail));
    await new Promise(r => setTimeout(r, 700));
    toggleEditSidebar(true);
    setImpMode('booklet');
    toggleImpEnabled(true, true);
    document.getElementById('impPerChapter').checked = false; impPerChapterChanged();
    await new Promise(r => setTimeout(r, 2000));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const w3 = (await PDFDocument.load(processedPdfBytes.slice(0))).getPageCount();
    ck('전체 중철: 15쪽 → 시트 8장', w3 === 8, w3);
    document.getElementById('impPerChapter').checked = true; impPerChapterChanged();
    await new Promise(r => setTimeout(r, 2500));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const p3 = (await PDFDocument.load(processedPdfBytes.slice(0))).getPageCount();
    ck('파일별 중철: 4+4+4 = 12장 (전체와 다름)', p3 === 12, { p3, w3 });
    ck('구간 3개 기록', (impChapterRanges() || []).length === 3, impChapterRanges());
    ck('적용 안내에 파일별 표기', /📄 챕터별 따로/.test(impositionNoteOf()), impositionNoteOf());
    ck('나누지 못했다는 경고는 없음', impPerChapterStatusNote() === '', impPerChapterStatusNote());

    // ── 파일 구분이 없는 단일 문서에서 체크하면 이유를 알려 준다 ─────────────
    exitEditWorkspace(false);
    closeTab(activeTabId);
    await new Promise(r => setTimeout(r, 300));
    startLoad([await mk('H', 6)]);
    await waitFor(() => pageResults.length === 6 && pageResults.every(r => r && r.thumbnail), 60000);
    await new Promise(r => setTimeout(r, 700));
    document.getElementById('impPerChapter').checked = true;
    ck('단일 문서면 적용되지 않는다고 알림', impPerChapterStatusNote().indexOf('단일 문서') > 0,
       impPerChapterStatusNote());

    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
