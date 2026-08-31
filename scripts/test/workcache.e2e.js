// 💾 작업 파일(.pdfw) 분석 캐시 E2E — "다시 열 때 재분석 없음"을 실제 앱에서 확인한다.
//   실행: npx electron scripts/test/workcache.e2e.js
// 실제 index.html+preload를 오프스크린으로 띄우고, 앱 안에서 시험용 PDF를 만들어
// 분석 → 작업 파일 생성 → 다시 열기까지 태운 뒤, 캐시 사용 여부·판정 일치·소요시간을 잰다.
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
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

    // 1) 시험용 PDF (12쪽 · 짝수쪽만 컬러)
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 12; i++) {
      const pg = doc.addPage([420, 595]);
      pg.drawText('page ' + i, { x: 40, y: 500, size: 36, font, color: rgb(0, 0, 0) });
      if (i % 2 === 0) pg.drawRectangle({ x: 40, y: 200, width: 200, height: 120, color: rgb(0.9, 0.2, 0.2) });
    }
    const bytes = await doc.save();
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const file = { name: 'cache_test.pdf', size: bytes.byteLength, type: 'application/pdf',
                   arrayBuffer: () => Promise.resolve(buf.slice(0)) };

    // 2) 평소 경로로 분석
    let t0 = performance.now();
    startLoad([file]);
    ck('분석 완료', await waitFor(() => pageResults.length === 12 && pageResults.every(r => r && r.thumbnail)));
    const tAnalyze = Math.round(performance.now() - t0);
    const colors0 = pageResults.map(r => r.isColor);
    ck('컬러 판정: 짝수쪽만 컬러', colors0.every((c, i) => c === ((i + 1) % 2 === 0)), colors0);

    // 3) 작업 파일 만들기 (분석 캐시 포함)
    const built = await buildWorkFileBytes();
    const man = built.manifest;
    const ana = man.state.analysis;
    ck('매니페스트에 분석 캐시 메타', !!ana && ana.pages.length === 12, ana && { v: ana.v, n: ana.pages.length, thumbW: ana.thumbW });
    // len은 pack 시점에 채워지므로 실제 파일을 풀어서 확인한다
    const packed = unpackWorkFile(built.bytes).manifest;
    const anaEntry = packed.entries.find(e => e.k === 'analysis');
    ck('썸네일 블롭 엔트리 존재', !!anaEntry && anaEntry.len > 0, anaEntry && anaEntry.len);
    const pdfEntry = packed.entries.find(e => e.k === 'pdf');
    const overhead = anaEntry ? anaEntry.len : 0;
    out.push(['ℹ', '캐시 용량', JSON.stringify({ 원본PDF: pdfEntry.len, 캐시: overhead, 쪽당: Math.round(overhead / 12) })]);

    // 4) 그 작업 파일을 다시 열기 — 재분석 없이 열려야 한다
    t0 = performance.now();
    const ok = await openWorkFileBytes(built.bytes, 'test.pdfw');
    ck('작업 파일 열기 성공', ok === true);
    const tOpen = Math.round(performance.now() - t0);
    const tab = tabs.get(activeTabId);
    ck('캐시로 열림(재분석 없음)', tab.analysisFromCache === true);
    ck('쪽수 동일', pageResults.length === 12, pageResults.length);
    ck('컬러 판정 동일', pageResults.every((r, i) => r.isColor === colors0[i]), pageResults.map(r => r.isColor));
    ck('썸네일 모두 복원', pageResults.every(r => r.thumbnail && r.thumbnail.startsWith('blob:')));
    ck('저해상 표식(thumbLow)', pageResults.every(r => r.thumbLow === true));
    ck('화면 컬러 장수 표시 일치',
       +document.getElementById('colorPages').textContent === colors0.filter(Boolean).length,
       document.getElementById('colorPages').textContent);
    out.push(['ℹ', '소요시간(ms)', JSON.stringify({ 분석: tAnalyze, 캐시열기: tOpen })]);
    ck('캐시 열기가 분석보다 빠름', tOpen < tAnalyze, { tAnalyze, tOpen });

    // 5) 크게 볼 때 원해상도로 보정되는지
    const before = pageResults[0].thumbnail;
    await upgradeThumb(0);
    ck('썸네일 원해상도 보정', pageResults[0].thumbLow === false && pageResults[0].thumbnail !== before);

    // 6) 무효화 — 버전이 다르면 캐시를 버리고 정상 분석
    const un = unpackWorkFile(built.bytes);
    un.manifest.state.analysis.v = 999;
    const bad = packWorkFile(un.manifest, un.blobs);
    const ok2 = await openWorkFileBytes(bad, 'old.pdfw');
    const tab2 = tabs.get(activeTabId);
    ck('버전 불일치 → 캐시 무시', ok2 === true && !tab2.analysisFromCache);
    ck('그래도 정상 분석됨', pageResults.length === 12 && pageResults.every((r, i) => r.isColor === colors0[i]));
    return out;
  })()`;

  let res;
  try { res = await win.webContents.executeJavaScript(script); }
  catch (e) { console.error('실행 오류:', e && e.message); app.exit(1); return; }
  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  const total = res.filter(r => r[0] !== 'ℹ').length;
  console.log(`\n결과: ${total - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
