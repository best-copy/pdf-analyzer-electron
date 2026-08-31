// 📐 합본 자동 방향 맞춤 E2E — "파일을 합치면 한쪽이 왼쪽 90° 눕던" 증상 회귀 방지.
//   실행: npx electron scripts/test/merge-orient.e2e.js
// 세로 원고(6쪽) + 가로 원고(4쪽)를 합쳐 열고, 자동 방향 맞춤이 챕터를 통째로
// 돌리지 않는지 / 한 원고 안에 섞인 페이지만 바로잡는지 확인한다.
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const script = `(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;

    // sizes: [w,h] 목록으로 PDF 만들기
    const mk = async (name, sizes) => {
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      sizes.forEach((s, i) => {
        const pg = d.addPage(s);
        pg.drawText('p' + (i + 1), { x: 30, y: 60, size: 24, font: f, color: rgb(0, 0, 0) });
      });
      const b = await d.save();
      const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return { name: name + '.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) };
    };
    const P = [420, 595], L = [595, 420];

    // 자동 맞춤 ON (기본값 확인 겸 명시)
    setAutoOrient(true);

    // ── 1) 세로 원고 + 가로 원고를 합본으로 열기 ──
    const a = await mk('세로원고', [P, P, P, P, P, P]);
    const b = await mk('가로원고', [L, L, L, L]);
    await openMergedAsChapters([a, b]);
    ck('합본 10쪽', await waitFor(() => pageResults.length === 10 && pageResults.every(r => r && r.thumbnail)), pageResults.length);
    await new Promise(r => setTimeout(r, 900));   // 자동 방향 맞춤(400ms 지연) 통과 대기
    const rots = pageResults.map(r => r.rotation || 0);
    ck('가로 원고가 통째로 눕지 않음(회전 0)', rots.every(v => v === 0), rots);
    ck('챕터 태깅 유지', pageResults[0].chapter === '세로원고.pdf' && pageResults[9].chapter === '가로원고.pdf',
       [pageResults[0].chapter, pageResults[9].chapter]);
    ck('맞출 페이지 없음으로 계산', countMisorientedPages().n === 0, countMisorientedPages());

    // ── 2) 한 원고 안에 섞인 페이지는 여전히 바로잡는다 ──
    const c = await mk('섞인원고', [P, P, P, L, P, P]);      // 4쪽만 가로
    const d2 = await mk('가로원고2', [L, L, L]);
    await openMergedAsChapters([c, d2]);
    ck('합본 9쪽', await waitFor(() => pageResults.length === 9 && pageResults.every(r => r && r.thumbnail)), pageResults.length);
    await new Promise(r => setTimeout(r, 900));
    const rots2 = pageResults.map(r => r.rotation || 0);
    ck('섞인 1쪽만 회전(270=왼쪽 90°)', rots2[3] === 270 && rots2.filter(v => v !== 0).length === 1, rots2);
    ck('다른 챕터(가로원고2)는 그대로', rots2.slice(6).every(v => v === 0), rots2.slice(6));
    return out;
  })()`;

  let res;
  try { res = await win.webContents.executeJavaScript(script); }
  catch (e) { console.error('실행 오류:', e && e.message); app.exit(1); return; }
  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
