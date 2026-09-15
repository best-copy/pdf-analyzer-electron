// 투명도 쪽 흑백변환 → 임포징(중철)·다운로드까지 프린터 흑백(gs inkcov CMY 0)인지 — 실제 앱 흐름
//   실행: npx electron scripts/test/gray-blend-imposition.e2e.js
// 회귀: 흑백변환은 전부 DeviceGray인데 페이지 투명도 그룹이 없어 겹친 회색이 C=M=Y+K로 합성됨(A1 포맥스 실파일),
//       embedPage로 판에 올리면 판에 그룹이 없어 같은 문제. 저장 직전 savePdfDoc → addGrayBlendGroups가 막는다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

// gs: PATH → 흔한 설치 위치
function findGs() {
  const cands = ['gswin64c', 'gs'];
  for (const base of ['C:/Program Files/gs', 'D:/Ghostscript']) {
    try { for (const d of fs.readdirSync(base)) cands.push(path.join(base, d, 'bin/gswin64c.exe')); } catch (e) {}
  }
  try { if (fs.existsSync('D:/Ghostscript/gs10.07.1/bin/gswin64c.exe')) cands.unshift('D:/Ghostscript/gs10.07.1/bin/gswin64c.exe'); } catch (e) {}
  for (const c of cands) { const r = spawnSync(c, ['--version'], { encoding: 'utf8' }); if (r.status === 0) return c; }
  return null;
}
function inkcov(gs, pdf) {
  const r = spawnSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=inkcov', '-o', '-', pdf], { encoding: 'latin1' });
  return (r.stdout || '').split(/\r?\n/).filter(l => /CMYK/.test(l)).map(l => l.trim().split(/\s+/).slice(0, 4).map(Number));
}

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-grayblend-e2e'));
app.whenReady().then(async () => {
  const gs = findGs();
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    try {
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, PDFName } = PDFLib;
    const N = n => PDFName.of(n);

    // 컬러 + 격리 투명도 그룹 폼(/Group /I true — 포맥스 실파일 구조) 4쪽 — 흑백 대상.
    // (단순 반투명 ca는 gs가 회색으로 섞어 재현되지 않는다 — 격리 그룹이 C=M=Y를 만든다)
    const d = await PDFDocument.create();
    for (let i = 0; i < 4; i++) {
      const p = d.addPage([420, 595]);
      const form = d.context.register(d.context.flateStream('1 0.2 0 rg 0 0 200 200 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200],
        Group: d.context.obj({ Type: 'Group', S: 'Transparency', I: true, CS: 'DeviceRGB' }) }));
      p.node.set(N('Resources'), d.context.obj({ XObject: { F0: form } }));
      p.node.set(N('Contents'), d.context.register(d.context.flateStream('0 0.4 1 rg 40 200 300 300 re f q 1 0 0 1 120 100 cm /F0 Do Q')));
    }
    const src = await d.save();
    const buf = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
    startLoad([{ name: 'transparent.pdf', size: src.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) }]);
    await waitFor(() => pageResults.length === 4 && pageResults.every(r => r && r.thumbnail) && isTabReady(tabs.get(activeTabId)), 60000);
    await new Promise(r => setTimeout(r, 800));
    ck('4쪽 모두 컬러로 분석', pageResults.filter(r => r.isColor).length === 4, pageResults.map(r => r.isColor));

    const paths = {};
    const hasGroups = async bytes => { if (!bytes) return ['없음']; const doc = await PDFDocument.load(bytes.slice(0)); return doc.getPages().map(pg => { const g = doc.context.lookup(pg.node.get(N('Group'))); return g ? String(g.get(N('CS'))) : null; }); };

    // ① 흑백 적용(임포징 없음)
    processingOptions.bw = true; processingOptions.inkNorm = true;
    pageResults.forEach(r => selectedPages.add(r.pageNum));   // 전 쪽 흑백변환 대상
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const g1 = await hasGroups(processedPdfBytes);
    ck('① 흑백 적용본: 쪽마다 DeviceGray 투명도 그룹', g1.length === 4 && g1.every(x => x === '/DeviceGray'), g1);
    paths.applied = window.electronAPI.writeTempFile(new Uint8Array(processedPdfBytes), 'pdf');

    // ② 중철 임포징을 켠 적용본 — 판(embedPage)에도 그룹
    setImpMode('booklet');
    toggleImpEnabled(true);
    await new Promise(r => setTimeout(r, 2500));
    await waitFor(() => !!processedPdfBytes, 120000);
    const g2 = await hasGroups(processedPdfBytes);
    ck('② 중철 판 2장 모두 DeviceGray 그룹', g2.length === 2 && g2.every(x => x === '/DeviceGray'), g2);
    paths.booklet = window.electronAPI.writeTempFile(new Uint8Array(processedPdfBytes), 'pdf');

    // ③ 다운로드 경로(최적화 출력)
    const opt = await buildOptimizedOutput(() => {});
    const optBytes = opt && (opt.bytes || opt);
    const g3 = optBytes && optBytes.byteLength ? await hasGroups(optBytes) : null;
    ck('③ 다운로드본도 DeviceGray 그룹', !!g3 && g3.every(x => x === '/DeviceGray'), g3);
    if (optBytes && optBytes.byteLength) paths.download = window.electronAPI.writeTempFile(new Uint8Array(optBytes), 'pdf');
    return { out, paths };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 400)]); return { out, paths: {} }; }
  })()`);

  const out = res.out;
  if (gs) {
    for (const [k, p] of Object.entries(res.paths)) {
      const ink = inkcov(gs, p);
      const cmy = ink.reduce((s, x) => s + x[0] + x[1] + x[2], 0);
      const k0 = ink.reduce((s, x) => s + x[3], 0);
      out.push([ink.length && cmy === 0 && k0 > 0 ? '✔' : '✘', `gs inkcov ${k}: CMY 0 · K 있음`, JSON.stringify(ink)]);
      try { fs.unlinkSync(p); } catch (e) {}
    }
  } else out.push(['✔', 'gs 없음 — inkcov 대조는 건너뜀', '']);

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
