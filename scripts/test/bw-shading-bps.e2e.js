// 흑백변환: 표본 함수(FunctionType 0) 그러데이션의 비트 수 12·24도 회색으로 — 2026-10-14 실파일 '회재선조와 전통 예절' 5쪽
//   (24비트 표본 CMYK 그러데이션 3개가 '변환 불가'로 컬러 그대로 남아, 흑백 체크했는데 프린터가 컬러로 셈)
//   실행: npx electron scripts/test/bw-shading-bps.e2e.js   (창을 띄우지 않는다 · gs 필요)
//   쪽마다 CMYK 축 그러데이션 하나(표본 8·12·16·24·32비트) → 전 쪽 흑백 → 적용본: 셰이딩 DeviceGray · inkcov C+M+Y=0 · 밝기 변화 유지
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const BPS = [8, 12, 16, 24, 32];

function findGs() {
  for (const d of ['D:/Ghostscript', 'C:/Program Files/gs']) {
    try { for (const v of fs.readdirSync(d).sort().reverse()) { const p = path.join(d, v, 'bin', 'gswin64c.exe'); if (fs.existsSync(p)) return p; } } catch (e) {}
  }
  return 'gswin64c';
}

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-bwshading'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1300, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3 && !/No handler|Security|outlineFonts|프리웜/.test(m)) console.log('[앱오류]', m.slice(0, 300)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const checks = [];
  const ck = (n, c, x) => checks.push([c ? '✔' : '✘', n, x]);
  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(100); } return false; };
      window.confirm = () => true;
      const { PDFDocument, PDFName } = PDFLib;
      const d = await PDFDocument.create(); const ctx = d.context;
      // 표본 2개(빨강 C0 M1 Y1 K0 → 파랑 C1 M1 Y0 K0)를 bps 비트로 MSB부터 채운다
      const pack = (vals, bps) => { const bits = []; vals.forEach(v => { for (let k = bps - 1; k >= 0; k--) bits.push(Math.floor(v / Math.pow(2, k)) % 2); });
        while (bits.length % 8) bits.push(0); const out = new Uint8Array(bits.length / 8); bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); }); return out; };
      for (const bps of ${JSON.stringify(BPS)}) {
        const mx = Math.pow(2, bps) - 1;
        const fn = ctx.register(ctx.stream(pack([0, mx, mx, 0, mx, mx, 0, 0], bps), { FunctionType: 0, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1, 0, 1], Size: [2], BitsPerSample: bps }));
        const sh = ctx.register(ctx.obj({ ShadingType: 2, ColorSpace: 'DeviceCMYK', Coords: [0, 0, 300, 0], Function: fn }));
        const p = d.addPage([300, 200]);
        p.node.set(PDFName.of('Resources'), ctx.obj({ Shading: { Sh0: sh } }));
        p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q 0 0 300 200 re W n /Sh0 sh Q')));
      }
      const b = await d.save();
      startLoad([{ name: '그러데이션.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
      await waitFor(() => pageResults.length === ${BPS.length} && isTabReady(tabs.get(activeTabId)));
      setOutlineEnabled(false);
      if (!processingOptions.bw) toggleOption('bw');
      pageResults.forEach(x => x && selectedPages.add(x.pageNum));
      invalidateProcessed(); await applyChanges(); await waitFor(() => !!processedPdfBytes);
      const out = await PDFDocument.load(processedPdfBytes.slice(0));
      const cs = out.getPages().map(p => { const res = p.node.Resources(); const s = res && res.lookup(PDFName.of('Shading'));
        if (!s) return 'none'; const o = out.context.lookup(s.get(s.keys()[0])); return String(out.context.lookup((o.dict || o).get(PDFName.of('ColorSpace')))); });
      return { cs, path: window.electronAPI.writeTempFile(processedPdfBytes.slice(0), 'pdf') };
    })()`);
    BPS.forEach((b, i) => ck(`${b}비트 표본 그러데이션 → DeviceGray`, r.cs[i] === '/DeviceGray', r.cs[i]));
    const gs = findGs();
    const ink = execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-r36', '-o', '-', r.path]).toString().trim().split(/\r?\n/);
    ink.forEach((l, i) => { const v = l.trim().split(/\s+/).map(Number); ck(`${BPS[i]}비트 쪽 inkcov C+M+Y = 0`, v[0] + v[1] + v[2] < 1e-5, l.trim()); });
    // 밝기 변화가 남았는지(평평한 회색으로 뭉개지지 않았는지) — 왼쪽(빨강)·오른쪽(파랑) 끝 밝기가 달라야 한다
    const pgm = path.join(os.tmpdir(), 'bwshade-' + process.pid + '.pgm');
    execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pgmraw', '-r36', '-dFirstPage=4', '-dLastPage=4', '-o', pgm, r.path]);
    const buf = fs.readFileSync(pgm); fs.unlinkSync(pgm);
    let p = 0; const f = [];
    while (f.length < 4) { while (/\s/.test(String.fromCharCode(buf[p]))) p++; if (buf[p] === 0x23) { while (buf[p] !== 0x0a) p++; continue; } let s = ''; while (!/\s/.test(String.fromCharCode(buf[p]))) s += String.fromCharCode(buf[p++]); f.push(s); }
    p++; const w = +f[1], h = +f[2], row = Math.floor(h / 2) * w + p;
    const left = buf[row + 2], right = buf[row + w - 3];
    ck('24비트 쪽 회색 그러데이션 유지(양 끝 밝기 차)', Math.abs(left - right) > 15, [left, right]);
    fs.unlinkSync(r.path);
  } catch (e) { ck('실행 오류', false, e && e.message); }
  let fail = 0;
  checks.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(m, n, m === '✔' ? '' : JSON.stringify(x)); });
  console.log(`결과: ${checks.length - fail} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
