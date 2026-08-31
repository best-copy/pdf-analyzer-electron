// 🔖 머리글·바닥글 적용 범위 + 시작 번호 E2E
//   실행: npx electron scripts/test/hf-scope.e2e.js
// ① 전체/이 쪽부터/체크 선택 3가지 범위가 실제 PDF에 그대로 반영되는지
// ② 시작 번호(numFrom)대로 번호가 매겨지는지 — 결과 PDF의 텍스트를 직접 읽어 확인한다.
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
    const mk = async (name, n) => {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= n; i++) { const p = d.addPage([300, 420]); p.drawText('x' + i, { x: 20, y: 380, size: 10, font: f, color: rgb(0,0,0) }); }
      const b = await d.save(); const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return { name: name + '.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) };
    };
    // A(4쪽) + B(4쪽) 합본 — 챕터 체크까지 확인
    await openMergedAsChapters([await mk('A', 4), await mk('B', 4)]);
    ck('합본 8쪽', await waitFor(() => pageResults.length === 8 && pageResults.every(r => r && r.thumbnail)), pageResults.length);
    await new Promise(r => setTimeout(r, 600));

    // 결과 PDF의 페이지별 바닥글 숫자 읽기 (pdf.js)
    const footers = async (bytes) => {
      const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const res = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        // 원본 본문은 'xN', 머리글/바닥글로 넣은 것은 '#'로 시작하게 둔다
        res.push(tc.items.map(t => t.str).filter(s => /^#/.test(s.trim())).join('').trim());
      }
      await doc.destroy();
      return res;
    };
    const build = async () => { await applyChanges(); return processedPdfBytes; };

    toggleEditSidebar(true);
    await new Promise(r => setTimeout(r, 400));
    const hf = activeLayoutSettings().hf;
    hf.enabled = true; hf.fC = '#{n}'; hf.pnumStyle = 0; hf.size = 9;
    syncEditUI();

    // ① 전체
    ck('기본은 전체 범위', (hf.applyMode || 'all') === 'all');
    let f = await footers(await build());
    ck('전체: 8쪽 모두 번호', f.join(',') === '#1,#2,#3,#4,#5,#6,#7,#8', f);

    // ② 이 쪽부터 (3쪽부터)
    setHfApplyMode('from');
    activeLayoutSettings().hf.applyFrom = 3;
    f = await footers(await build());
    ck('3쪽부터: 앞 2쪽은 비어 있음', f[0] === '' && f[1] === '', f.slice(0, 3));
    ck('3쪽부터: 3쪽 이후는 인쇄됨', f[2] === '#3' && f[7] === '#8', f);

    // ③ 체크 선택 — 페이지 2, 5만
    setHfApplyMode('pick');
    hfTogglePick('page', 2, true); hfTogglePick('page', 5, true);
    f = await footers(await build());
    ck('체크한 2·5쪽에만 인쇄', f[1] === '#2' && f[4] === '#5' && f.filter(Boolean).length === 2, f);

    // ④ 챕터 체크 — B.pdf(5~8쪽)
    hfTogglePick('page', 2, false); hfTogglePick('page', 5, false);
    hfTogglePick('chapter', 'B.pdf', true);
    ck('챕터 체크가 4쪽으로 펼쳐짐', hfPickedPageSet(activeLayoutSettings().hf).size === 4,
       [...hfPickedPageSet(activeLayoutSettings().hf)]);
    f = await footers(await build());
    ck('B 챕터(5~8쪽)에만 인쇄', f.slice(0, 4).every(v => !v) && f.slice(4).join(',') === '#5,#6,#7,#8', f);

    // ⑤ 시작 번호 — 5쪽부터, 그 쪽에 찍힐 첫 번호는 7
    setHfApplyMode('all');
    const hf2 = activeLayoutSettings().hf;
    hf2.start = 5; hf2.numFrom = 7;
    syncEditUI();
    f = await footers(await build());
    // 시작 전 페이지는 번호 토큰만 비고 나머지 문구('#')는 그대로 인쇄된다
    ck('앞 4쪽은 번호 없음(시작 전)', f.slice(0, 4).every(v => v === '#'), f.slice(0, 4));
    ck('5쪽에 7부터 매겨짐', f.slice(4).join(',') === '#7,#8,#9,#10', f.slice(4));

    // ⑥ UI 상태 반영
    setHfApplyMode('pick');
    ck('체크 목록 UI가 열림', document.getElementById('esHfPickBox').style.display !== 'none');
    ck('챕터 체크 항목 2개', document.querySelectorAll('#esHfPickList .es-hf-pick-ch').length === 2);
    ck('페이지 체크 항목 8개', document.querySelectorAll('#esHfPickList .es-hf-pick:not(.es-hf-pick-ch)').length === 8);
    setHfApplyMode('from');
    ck('이 쪽부터 UI가 열림', document.getElementById('esHfFromRow').style.display !== 'none');
    return out;
  })()`);
  } catch (e) { console.error('  ✘ 스크립트 실행 오류:', e && e.message); app.exit(1); return; }

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
