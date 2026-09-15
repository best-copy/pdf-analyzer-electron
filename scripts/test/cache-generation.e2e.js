// 흑백 캐시·비동기 빌드 안정성 — 문서가 바뀌는 도중의 결과가 섞이지 않는지, 대용량에서 쪽이 비지 않는지
//   실행: npx electron scripts/test/cache-generation.e2e.js   (창을 띄우지 않는다 — show:false)
// 회귀:
//  · 흑백 대상이 800쪽을 넘으면 캐시 FIFO가 방금 변환한 쪽을 지워 적용본 앞쪽이 빈 A4로 나옴
//  · 프리웜 도중 파일 교체·내부편집(같은 탭)을 하면 옛 원고의 변환 결과가 새 캐시에 들어감
//  · 같은 서명의 진행 중 빌드에 합류 — 교체한 원고인데 옛 원고 바이트를 받음
//  · '적용' 도중 탭을 바꾸면 끝난 결과가 새 탭에 붙음
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-cachegen'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 240000)) { if (f()) return true; await sleep(50); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const mk = async (tag, n) => {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= n; i++) {
        const p = d.addPage([300, 420]);
        p.drawRectangle({ x: 20, y: 20, width: 260, height: 60, color: rgb(0.3, 0.3, 0.3) });
        p.drawText(tag + i, { x: 40, y: 360, size: 18, font: f, color: rgb(0, 0, 0) });
      }
      const b = await d.save();
      return { name: tag + '.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) };
    };
    const ready = () => pageResults.length > 0 && pageResults.every(r => r && r.thumbnail !== undefined);
    const idle = () => !_inkPrewarmPromise;

    // ── [1] 흑백 대상 810쪽 — 앞쪽이 빈 A4로 바뀌지 않는다 ─────────────────
    startLoad([await mk('BIG', 810)]);
    ck('[1] 810쪽 문서 분석 완료', await waitFor(() => pageResults.length === 810 && ready(), 600000), pageResults.length);
    await waitFor(idle, 600000);
    await applyChanges();
    {
      const d = processedPdfBytes ? await PDFDocument.load(processedPdfBytes) : null;
      const pages = d ? d.getPages() : [];
      const a4 = pages.filter(p => Math.round(p.getWidth()) !== 300 || Math.round(p.getHeight()) !== 420).length;
      ck('[1] 적용본 810쪽', pages.length === 810, pages.length);
      ck('[1] 판형이 바뀐(빈 A4) 쪽 없음', a4 === 0, a4);
      const noContent = pages.filter(p => !p.node.get(PDFLib.PDFName.of('Contents'))).length;
      ck('[1] 내용 없는 쪽 없음', noContent === 0, noContent);
      ck('[1] 흑백 캐시에 810쪽 모두 남음(상한으로 지우지 않음)', _bwCache.size === 810, _bwCache.size);
    }

    // ── [2] 변환 도중 캐시가 비워지면(파일 교체·내부편집) 결과를 캐시에 넣지 않는다 ──
    // startLoad는 열린 문서에 합본하므로, 새 탭은 createTab + analyzePDF로 직접 연다
    const openTab = async (tag, n) => { const f = await mk(tag, n); const t = createTab(f); activateTab(t.id); await analyzePDF(f, t); await waitFor(() => originalFileName === tag && pageResults.length === n && ready()); return t.id; };
    const tabA = await openTab('TABA', 40);
    await waitFor(idle);
    clearProcessCaches();
    {
      const p = ensureBwConverted([...Array(40).keys()], null, null).then(() => 'done', e => e && e.stale ? 'stale' : 'error:' + e.message);
      clearProcessCaches();                       // 변환이 도는 동안 교체·편집 반영이 캐시를 비운 상황
      const r = await p;
      ck('[2] 도중에 비워진 변환은 stale로 끝남', r === 'stale', r);
      ck('[2] 새 캐시에 옛 결과가 들어가지 않음', _bwCache.size === 0, _bwCache.size);
    }

    // ── [3] 진행 중 다운로드 빌드에 '서명만 같다고' 합류하지 않는다 ─────────
    {
      const p1 = buildOptimizedOutput().then(b => 'bytes', e => e && e.stale ? 'stale' : 'error:' + e.message);
      clearProcessCaches();                       // 같은 서명(쪽 수·설정 동일)이지만 문서가 바뀐 상황
      const p2 = buildOptimizedOutput().then(b => b && b.length ? 'bytes' : 'empty', e => 'error:' + e.message);
      const [r1, r2] = await Promise.all([p1, p2]);
      ck('[3] 옛 빌드는 stale로 버려짐', r1 === 'stale', r1);
      ck('[3] 새 빌드는 따로 만들어져 결과가 나옴', r2 === 'bytes', r2);
      ck('[3] 옛 빌드가 캐시를 채우지 않음(새 빌드 결과만)', !!_optCache.bytes, !!_optCache.bytes);
    }

    // ── [4] 적용 도중 탭을 바꾸면 결과를 새 탭에 붙이지 않는다 ─────────────
    const tabB = await openTab('TABB', 5);
    ck('[4] 탭 두 개가 열림', tabA !== tabB && tabs.has(tabA) && tabs.has(tabB), [tabA, tabB]);
    activateTab(tabA);
    await waitFor(idle);
    clearProcessCaches();                         // 캐시 없이 실제로 변환하게
    processedPdfBytes = null;
    const applyP = applyChanges();
    activateTab(tabB);                            // 적용이 첫 await에 들어간 직후 탭 전환(작은 문서는 수십 ms 안에 끝나 버린다)
    processedPdfBytes = null;
    await applyP;
    ck('[4] 적용이 끝나도 B탭 결과는 비어 있음', processedPdfBytes === null, processedPdfBytes && processedPdfBytes.length);
    ck('[4] 버렸다는 안내', /버렸습니다/.test((document.getElementById('success') || {}).textContent || ''),
       (document.getElementById('success') || {}).textContent);
    ck('[4] B탭은 여전히 B 문서', originalFileName === 'TABB' && pageResults.length === 5, [originalFileName, pageResults.length]);
    // B탭에서 적용하면 B 문서 그대로 나온다
    await applyChanges();
    const db = processedPdfBytes ? await PDFDocument.load(processedPdfBytes) : null;
    ck('[4] 이어서 B탭 적용 → B 5쪽', db && db.getPageCount() === 5, db && db.getPageCount());
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
