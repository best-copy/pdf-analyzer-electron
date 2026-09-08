// 🔁 파일 교체 — 설정은 그대로, 원고만 바꾼다. 쪽에 매인 설정은 비워지는지까지 확인.
//   실행: npx electron scripts/test/replace-file.e2e.js
// 파일 선택 다이얼로그(IPC)는 하네스에서 대역을 등록해 두 번째 문서를 돌려준다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

// 시험용 PDF 2종 — 쪽수가 다른 원고로 바꿔 '쪽에 매인 설정'이 정리되는지 본다
async function makePdf(file, pages, label) {
  const { PDFDocument, StandardFonts } = require(path.join(ROOT, 'node_modules', 'pdf-lib'));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(`${label} ${i + 1}`, { x: 60, y: 500, size: 20, font });
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

app.whenReady().then(async () => {
  setTimeout(() => { console.log('\n✘ 시간 초과(5분)'); app.exit(1); }, 300000).unref();
  const a = await makePdf(path.join(os.tmpdir(), 'repl_A.pdf'), 6, 'AAA');
  const b = await makePdf(path.join(os.tmpdir(), 'repl_B.pdf'), 9, 'BBB');
  // 파일 선택 대역 — 교체할 원고(B)를 돌려준다
  ipcMain.handle('dialog:openFile', () => [{ name: path.basename(b), path: b }]);

  const win = new BrowserWindow({ show: true, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer]', msg); });
  try {
    await win.loadFile(path.join(ROOT, 'src/index.html'));
    await new Promise(r => setTimeout(r, 1600));
    const run = js => win.webContents.executeJavaScript(js);

    // A를 열고 설정을 잔뜩 걸어 둔다 (쪽 무관 + 쪽에 매인 것 섞어서)
    const before = await run(`(async () => {
      const ab = window.electronAPI.readFile(${JSON.stringify(a)});
      const file = { name: 'repl_A.pdf', size: ab.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(ab.slice(0)) };
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await new Promise(r => setTimeout(r, 40)); } return false; };
      window.__waitFor = waitFor;
      startLoad([file]);
      await waitFor(() => pageResults.length > 0 && pageResults.every(r => r && r.thumbnail !== undefined));
      const ls = activeLayoutSettings();
      // 쪽과 무관한 설정 — 교체 후에도 남아야 한다
      ls.scaling.mode = 'standard'; ls.scaling.paper = 'A4';
      ls.margins.enabled = true; ls.margins.top = 7;
      ls.bind.enabled = true; ls.bind.size = 12;
      ls.hf.enabled = true; ls.hf.fC = '보고서'; ls.hf.size = 11;
      Object.assign(ls.pn, { enabled: true, fmt: '- {page} -', pos: 'bottom-outer', start: 2, numFrom: 5, exclude: '3' });
      processingOptions.inkNorm = true;
      // 쪽에 매인 설정 — 교체하면 비워져야 한다
      selectedPages.add(1); selectedPages.add(2);
      editSettings.pageAdjust = { 0: { dx: 2, dy: 1, rot: 0 } };
      ls.hf.applyMode = 'pick'; ls.hf.applyPages = [1, 2, 3];
      return { pages: pageResults.length, name: originalFileName, tabId: activeTabId };
    })()`);
    console.log('\n[준비] A 원고:', JSON.stringify(before));
    ck('A가 6쪽으로 열렸다', before.pages === 6, before);

    // 교체 실행
    const after = await run(`(async () => {
      await replaceFileKeepSettings();
      await window.__waitFor(() => pageResults.length > 0 && pageResults.every(r => r && r.thumbnail !== undefined));
      const ls = activeLayoutSettings();
      return {
        pages: pageResults.length, name: originalFileName, tabId: activeTabId, tabCount: tabs.size,
        kept: { paper: ls.scaling.paper, mode: ls.scaling.mode, mgTop: ls.margins.top, mgOn: ls.margins.enabled,
                bind: ls.bind.enabled && ls.bind.size, hf: ls.hf.fC, hfSize: ls.hf.size,
                pn: JSON.parse(JSON.stringify(ls.pn)), inkNorm: processingOptions.inkNorm },
        dropped: { selected: selectedPages.size, pageAdjust: Object.keys(editSettings.pageAdjust || {}).length,
                   hfApplyMode: ls.hf.applyMode, hfApplyPages: (ls.hf.applyPages || []).length,
                   contentEdits: contentEdits ? contentEdits.size : 0 },
        ui: { pnFmt: document.getElementById('esPnFmt').value,
              pnChecked: document.getElementById('esPnEnabled').checked },
      };
    })()`);
    console.log('[교체 후]', JSON.stringify(after.kept), JSON.stringify(after.dropped));

    console.log('\n[1] 원고가 바뀌었다');
    ck('B가 9쪽으로 열렸다', after.pages === 9, after.pages);
    ck('파일 이름이 바뀌었다', after.name === 'repl_B', after.name);
    ck('탭이 늘지 않았다(같은 탭 재사용)', after.tabCount === 1 && after.tabId === before.tabId, [after.tabCount, after.tabId === before.tabId]);

    console.log('\n[2] 쪽과 무관한 설정은 그대로');
    ck('용지 규격 유지 (A4/standard)', after.kept.mode === 'standard' && after.kept.paper === 'A4', after.kept);
    ck('여백 유지 (켬·top 7)', after.kept.mgOn === true && after.kept.mgTop === 7, after.kept);
    ck('제본여백 유지 (12)', after.kept.bind === 12, after.kept.bind);
    ck('머리글 문구·크기 유지', after.kept.hf === '보고서' && after.kept.hfSize === 11, after.kept);
    ck('잉크 정규화 유지', after.kept.inkNorm === true, after.kept.inkNorm);
    ck('페이지 번호 설정 전부 유지',
       after.kept.pn.enabled === true && after.kept.pn.fmt === '- {page} -' && after.kept.pn.pos === 'bottom-outer'
       && after.kept.pn.start === 2 && after.kept.pn.numFrom === 5 && after.kept.pn.exclude === '3', after.kept.pn);
    ck('화면(UI)도 유지된 값으로 갱신됨', after.ui.pnChecked === true && after.ui.pnFmt === '- {page} -', after.ui);

    console.log('\n[3] 쪽에 매인 설정은 비워진다');
    ck('흑백 선택 페이지 비움', after.dropped.selected === 0, after.dropped.selected);
    ck('개별 보정 비움', after.dropped.pageAdjust === 0, after.dropped.pageAdjust);
    ck('머리글 체크 선택 → 전체로', after.dropped.hfApplyMode === 'all' && after.dropped.hfApplyPages === 0, after.dropped);
    ck('내부편집 비움', after.dropped.contentEdits === 0, after.dropped.contentEdits);

    console.log('\n[4] 교체 후 바로 적용하면 새 원고에 그대로 적용된다');
    const applied = await run(`(async () => {
      processedPdfBytes = null;
      await applyChanges();
      await window.__waitFor(() => !!processedPdfBytes);
      const pdf = await openPdfDoc({ data: processedPdfBytes.slice(0) }).promise;
      const out = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const tc = await (await pdf.getPage(i)).getTextContent();
        out.push(tc.items.map(t => t.str.trim()).filter(s => s && !/^BBB/.test(s)));
      }
      await pdf.destroy();
      return { n: pdf.numPages, out };
    })()`);
    ck('9쪽 그대로 나온다', applied.n === 9, applied.n);
    ck('1쪽은 번호 없음 (시작 위치 2)', applied.out[0].every(s => !/^- \\d+ -$/.test(s)), applied.out[0]);
    ck('2쪽 = - 5 - (시작 번호 5)', applied.out[1].some(s => s === '- 5 -'), applied.out[1]);
    ck('3쪽은 제외', applied.out[2].every(s => !/^- \\d+ -$/.test(s)), applied.out[2]);
    ck('4쪽 = - 7 -', applied.out[3].some(s => s === '- 7 -'), applied.out[3]);
    ck('머리글도 함께 찍힘', applied.out[1].some(s => s === '보고서'), applied.out[1]);
  } catch (e) {
    fail++; console.log('  ✘ 예외:', (e && e.message) || e);
  }
  try { fs.unlinkSync(a); fs.unlinkSync(b); } catch (e) {}
  console.log(`\n${fail ? '✘ 실패' : '✅ 통과'} — ${pass}개 성공, ${fail}개 실패`);
  app.exit(fail ? 1 : 0);
});
