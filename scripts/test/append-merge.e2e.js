// 📎 열려 있는 문서에 파일을 추가할 때(가상 프린터 접수·드래그 등) 편집 상태가 유지되는지
//   실행: npx electron scripts/test/append-merge.e2e.js
// 회귀: 예전에는 원본 바이트로 합쳐서 '지운 페이지가 되살아나고' 순서·회전·빈 페이지가
//       전부 사라졌다. 지금은 지금 화면 그대로를 base로 굽고, 자동 방향 맞춤도 끼어들지 않는다.
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
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 40000)) { if (f()) return true; await new Promise(r => setTimeout(r, 60)); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const mk = async (name, n, tag) => {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= n; i++) { const p = d.addPage([420, 595]); p.drawText(tag + i, { x: 40, y: 500, size: 28, font: f, color: rgb(0,0,0) }); }
      const b = await d.save(); const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return { name: name + '.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) };
    };
    const textOf = async (bytes) => {
      const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const t = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        t.push(tc.items.map(x => x.str).join('').trim());
      }
      await doc.destroy(); return t;
    };

    // 6쪽 문서를 열고 3·4쪽 삭제 · 1쪽 90° 회전 · 끝에 빈 페이지 삽입
    startLoad([await mk('원고', 6, 'A')]);
    ck('원고 6쪽 분석', await waitFor(() => pageResults.length === 6 && pageResults.every(r => r && r.thumbnail)));
    await new Promise(r => setTimeout(r, 400));
    deletePage(3); deletePage(2);          // 표시 3·4쪽 삭제
    pageResults[0].rotation = 90;
    insertBlankPage(pageResults.length - 1);
    rerenderPages();
    const beforeN = pageResults.filter(Boolean).length;
    ck('편집 후 5쪽(삭제 2 + 빈 페이지 1)', beforeN === 5, beforeN);

    // 가상 프린터로 문서를 받은 것과 같은 경로 (external:open → prepareFiles → startLoad)
    startLoad([await mk('인쇄접수', 2, 'B')]);
    ck('합본 완료', await waitFor(() => pageResults.filter(Boolean).length === beforeN + 2
       && pageResults.every(r => r && (r.thumbnail || r.isBlank)), 40000),
       pageResults.filter(Boolean).length);
    await new Promise(r => setTimeout(r, 900));

    const txt = await textOf(originalPdfBytes);
    ck('지운 페이지가 되살아나지 않음', txt.join(',') === 'A1,A2,A5,A6,,B1,B2', txt);
    ck('쪽수 = 편집본 + 새 문서', pageResults.filter(Boolean).length === beforeN + 2,
       { before: beforeN, after: pageResults.filter(Boolean).length });
    const doc = await PDFDocument.load(originalPdfBytes.slice(0), { updateMetadata: false });
    const rots = doc.getPages().map(p => p.getRotation().angle);
    ck('사용자가 돌린 회전이 그대로 구워짐', rots[0] === 90, rots);
    ck('자동 방향 맞춤이 그 회전을 되돌리지 않음', (pageResults[0].rotation || 0) === 0, pageResults[0].rotation);
    ck('빈 페이지가 유지됨', txt[4] === '', txt[4]);
    const tab = tabs.get(activeTabId);
    ck('챕터 경계가 지금 기준으로 재계산', !!tab.chapters && tab.chapters.length === 2
       && tab.chapters[0].count === beforeN && tab.chapters[1].count === 2,
       tab.chapters);
    return out;
  })()`);
  } catch (e) { console.error('  ✘ 스크립트 실행 오류:', e && e.message); app.exit(1); return; }

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
