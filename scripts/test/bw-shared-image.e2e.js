// 흑백 쪽과 컬러 쪽이 **같은 이미지 객체**를 공유할 때 — 다운로드본에서도 컬러 쪽이 컬러로 남는가
//   실행: npx electron scripts/test/bw-shared-image.e2e.js [실제 PDF 경로 + 컬러로 남길 쪽(1부터, 쉼표)]
// 회귀(실파일 칼7흑213.pdf): 화면(적용본)은 컬러 7쪽인데 저장본은 3쪽만 컬러 → 프린터도 3쪽만 컬러.
//   다운로드 경로 buildBaseOptimized가 모든 쪽을 copyPages 한 번으로 복사(리소스 공유)한 뒤 흑백 쪽을
//   제자리 변환해, 흑백 쪽과 공유하던 컬러 쪽의 사진까지 회색이 됐다. 적용 경로는 흑백 쪽만 따로 복사해 멀쩡했다.
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

// 인자: <pdf> <남길 쪽들> — 없으면 합성 PDF
const args = process.argv.slice(2).filter(a => !a.startsWith('--') && !/electron|\.e2e\.js$/i.test(a) && a !== '.');
const REAL = args[0] && /\.pdf$/i.test(args[0]) ? args[0] : null;
const KEEP = REAL && args[1] ? args[1].split(',').map(Number) : null;

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-sharedimg-e2e'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try {
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, PDFName, rgb } = PDFLib;
    const N = n => PDFName.of(n);
    const REAL = ${JSON.stringify(REAL)};
    let bytes, keep;
    if (REAL) {
      const raw = await window.electronAPI.readFile(REAL);
      bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      keep = ${JSON.stringify(KEEP)};
    } else {
      // 합성: 4쪽 — 1·3쪽은 컬러로 남기고 2·4쪽은 흑백. 1↔2쪽, 3↔4쪽이 같은 컬러 이미지 객체를 공유
      const d = await PDFDocument.create();
      const px = new Uint8Array(8 * 8 * 3); for (let i = 0; i < px.length; i += 3) { px[i] = 230; px[i + 1] = 40; px[i + 2] = 20; }
      const mkImg = () => d.context.register(d.context.flateStream(px, { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
      const imgs = [mkImg(), mkImg()];
      for (let i = 0; i < 4; i++) {
        const p = d.addPage([300, 300]);
        p.node.set(N('Resources'), d.context.obj({ XObject: { Im0: imgs[i >> 1] } }));
        p.node.set(N('Contents'), d.context.register(d.context.flateStream('q 200 0 0 200 50 50 cm /Im0 Do Q')));
      }
      bytes = await d.save();
      keep = [1, 3];
    }
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    startLoad([{ name: 'shared.pdf', size: bytes.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) }]);
    await waitFor(() => pageResults.length > 0 && pageResults.every(r => r && r.thumbnail) && isTabReady(tabs.get(activeTabId)), 300000);
    await new Promise(r => setTimeout(r, 1000));
    const colorPages = pageResults.filter(r => r.isColor).map(r => r.pageNum);

    // 컬러 쪽 중 keep을 뺀 나머지를 흑백으로(사용자 작업 재현), 잉크 정규화 기본 ON
    processingOptions.bw = true; processingOptions.inkNorm = true;
    selectedPages.clear();
    colorPages.filter(p => !keep.includes(p)).forEach(p => selectedPages.add(p));

    // pdf.js로 쪽마다 컬러 픽셀 수
    const colorPx = async b => {
      const doc = await pdfjsLib.getDocument({ data: b.slice(0) }).promise;
      const res = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const pg = await doc.getPage(i); const vp = pg.getViewport({ scale: 0.4 });
        const c = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height)); const cx = c.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: cx, viewport: vp }).promise;
        const d = cx.getImageData(0, 0, c.width, c.height).data; let n = 0;
        for (let k = 0; k < d.length; k += 4) if (Math.max(d[k], d[k+1], d[k+2]) - Math.min(d[k], d[k+1], d[k+2]) > 25) n++;
        res.push(n); pg.cleanup();
      }
      await doc.destroy();
      return res;
    };
    const colored = arr => arr.map((n, i) => n ? i + 1 : 0).filter(Boolean);

    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 600000);
    const applied = colored(await colorPx(processedPdfBytes));
    ck('적용본(화면): 남긴 컬러 쪽이 전부 컬러', JSON.stringify(applied) === JSON.stringify(keep), applied);

    const opt = await buildOptimizedOutput(() => {});
    const optBytes = opt && (opt.bytes || opt);
    const saved = colored(await colorPx(optBytes));
    ck('저장본(다운로드): 남긴 컬러 쪽이 전부 컬러', JSON.stringify(saved) === JSON.stringify(keep), saved);

    // 🎨 저장본 컬러 검수 — 고친 저장본은 경고 없음
    const cc = _optBaseCache.stats && _optBaseCache.stats.colorCheck;
    ck('컬러 검수: 고친 저장본은 경고 없음', !!cc && !cc.lost.length && !cc.leftover.length && cc.keepColor === keep.length, cc);
    // 옛 방식(전 쪽 한 번에 복사 + 제자리 변환)을 그대로 재현해 검수가 잡아내는지
    const valid = pageResults.filter(Boolean);
    const src = await getSourceDoc();
    const old = await PDFDocument.create();
    (await old.copyPages(src, valid.map(r => r.originalIdx))).forEach(p => old.addPage(p));
    for (let i = 0; i < valid.length; i++) if (isBwTarget(valid[i])) await convertPageToGrayscaleVector(old, i, { errors: 0, errPages: [] }, 0);
    const oldSaved = colored(await colorPx(await old.save()));
    const lostWant = keep.filter(p => !oldSaved.includes(p));
    const occ = checkColorIntent(old, valid, src);
    ck('옛 방식 재현: 실제로 컬러를 잃은 쪽이 있음', lostWant.length > 0, oldSaved);
    ck('컬러 검수가 잃은 쪽을 정확히 짚음', !!occ && JSON.stringify(occ.lost) === JSON.stringify(lostWant), { lost: occ && occ.lost, want: lostWant });
    ck('경고 문구에 쪽 번호가 들어감', (colorCheckWarning(occ) || '').includes(lostWant.join(', ')), (colorCheckWarning(occ) || '').slice(0, 120));
    return { out, colorPages, keep, tmp: window.electronAPI.writeTempFile(new Uint8Array(optBytes), 'pdf') };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); return { out }; }
  })()`);

  if (res.colorPages) console.log(`  분석 컬러 쪽: ${res.colorPages.join(',')} · 남길 쪽: ${res.keep.join(',')}`);
  if (res.tmp) console.log(`  저장본: ${res.tmp}`);
  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
