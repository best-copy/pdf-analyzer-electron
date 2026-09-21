// 📖 복제 2-up(1 1* 2* 2) — 1GB 원고에서 "Array buffer allocation failed" 회귀
//   실행: npx electron scripts/test/dup-2up-memory.e2e.js            (합성 원고 ≈1.1GB · 창 없음)
//         set DUP_PDFW=D:\...\작업.pdfw  → 그 작업 파일의 적용본(없으면 원본)으로 검사 (파일은 읽기만)
// 원인: 복제 빌더가 원고를 정방향·180° 두 벌 embedPage 했다 — pdf-lib는 embed 할 때마다 이미지·폰트를
//       새로 복사하므로 결과가 원고의 약 2배. 1GB 원고면 2GB가 넘어 저장 버퍼 한계(2GB 미만)를 넘었다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-dup2up'));
ipcMain.handle('dialog:confirmSavePath', (_e, { filePath }) => filePath);

// 작업 파일에서 적용본(없으면 원본) 조각 위치를 찾는다 — 메인 쪽에서 머리만 읽는다
function pdfwBlob(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const magic = 'PDFEDITWORK1\n'.length;
    const h = Buffer.alloc(magic + 4); fs.readSync(fd, h, 0, h.length, 0);
    const jl = h.readUInt32LE(magic);
    const j = Buffer.alloc(jl); fs.readSync(fd, j, 0, jl, magic + 4);
    const man = JSON.parse(j.toString('utf8'));
    let p = magic + 4 + jl, pick = null;
    for (const e of man.entries) { if (e.k === 'result' || (!pick && e.k === 'pdf')) pick = { off: p, len: e.len, k: e.k }; p += e.len; }
    return pick;
  } finally { fs.closeSync(fd); }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2000));
  const real = process.env.DUP_PDFW ? { file: process.env.DUP_PDFW, ...pdfwBlob(process.env.DUP_PDFW) } : null;
  let res;
  try {
    res = await win.webContents.executeJavaScript(`(async () => {
      const out = [];
      const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
      const MB = 1 << 20;
      const real = ${JSON.stringify(real)};
      let src, label;
      if (real) {
        src = new Uint8Array(window.electronAPI.readFileRange(real.file, real.off, real.len));
        label = '실파일 ' + real.k + ' ' + Math.round(real.len / MB) + 'MB';
      } else {
        // 합성 원고: 쪽마다 고유한 무압축 회색 사진 1장(≈75MB) × 15쪽 ≈ 1.1GB — 압축이 안 되게 난수
        const doc = await PDFLib.PDFDocument.create();
        const W = 8660, H = 8660;               // 8660² ≈ 75MB
        let seed = 7;
        for (let i = 0; i < 15; i++) {
          const px = new Uint8Array(W * H);
          for (let k = 0; k < px.length; k += 4) { seed = (seed * 1103515245 + 12345) >>> 0; px[k] = seed >>> 24; px[k + 1] = seed >>> 16; px[k + 2] = seed >>> 8; px[k + 3] = seed; }
          const img = doc.context.stream(px, { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, BitsPerComponent: 8, ColorSpace: 'DeviceGray' });
          const ref = doc.context.register(img);
          const pg = doc.addPage([595, 842]);
          pg.node.setXObject(PDFLib.PDFName.of('Im0'), ref);
          pg.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(595, 0, 0, 842, 0, 0), PDFLib.drawObject('Im0'), PDFLib.popGraphicsState());
          pg.drawText('P' + (i + 1), { x: 40, y: 780, size: 40 });
        }
        src = await doc.save({ useObjectStreams: false });
        label = '합성 ' + Math.round(src.length / MB) + 'MB';
      }
      // 사용자가 쓴 프리셋 그대로 — 270-390_양면_2up_논문 (복제 2부 · 양면 · 시트 390×270)
      const prof = IMP_PROFILE_SEED.find(p => p.n === '270-390_양면_2up_논문');
      ck('프리셋 찾음', !!prof, prof);
      const opts = profileToOpts(prof);
      const t0 = Date.now();
      let r = null, err = '';
      try { r = await buildDup2upBytes(src, opts, null); } catch (e) { err = (e && e.message) || String(e); }
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      ck('복제 2-up 조립 성공 (' + label + ')', !!r && !err, err || { outMB: r && Math.round(r.bytes.length / MB), sheets: r && r.sheets, sec });
      if (r) {
        ck('결과 크기가 원고의 1.2배 이하 (180° 벌이 사진을 다시 복사하지 않음)', r.bytes.length <= src.length * 1.2,
           { srcMB: Math.round(src.length / MB), outMB: Math.round(r.bytes.length / MB) });
        // 결과를 pdf-lib로 다시 열어 면 수·시트 크기 확인
        const d = await PDFLib.PDFDocument.load(r.bytes, { updateMetadata: false });
        const n0 = (await PDFLib.PDFDocument.load(src, { updateMetadata: false })).getPageCount();
        const sz = d.getPage(0).getSize();
        ck('면 수 = 양면 시트 × 2 (쪽 수 올림 짝수)', d.getPageCount() === Math.ceil(n0 / 2) * 2, { faces: d.getPageCount(), n0 });
        ck('시트 크기 = 프리셋 시트(270×390mm)', Math.abs(sz.width - opts.sheet[0]) < 1 && Math.abs(sz.height - opts.sheet[1]) < 1, { sz, sheet: opts.sheet });
        window.__dupOut = r.bytes;   // 아래 렌더 검사용
      }
      return out;
    })()`);
  } catch (e) { res = [['✘', '실행 오류', String(e && e.message || e)]]; }

  // 합성 원고면 첫 면을 pdf.js로 그려 좌(정방향)·우(180°)에 같은 쪽이 들어갔는지 본다
  if (!real && res.every(x => x[0] === '✔')) {
    try {
      const v = await win.webContents.executeJavaScript(`(async () => {
        const doc = await pdfjsLib.getDocument({ data: window.__dupOut.slice(0) }).promise;
        const page = await doc.getPage(1);
        const tc = await page.getTextContent();
        const items = tc.items.map(t => ({ s: t.str, x: Math.round(t.transform[4]), a: Math.round(t.transform[0]) }));
        await doc.destroy();
        return items;
      })()`);
      const L = v.find(t => t.s === 'P1' && t.a > 0), R = v.find(t => t.s === 'P1' && t.a < 0);
      res.push([L && R ? '✔' : '✘', '첫 면: 왼쪽 P1 정방향 · 오른쪽 P1 180°', JSON.stringify(v)]);
    } catch (e) { res.push(['✘', '렌더 검사 오류', String(e && e.message || e)]); }
  }

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
