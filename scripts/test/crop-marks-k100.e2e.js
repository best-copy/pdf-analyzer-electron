// ✂ 재단선·표시는 먹 1도(K100) — RGB 검정이면 프린터가 C·M·Y까지 써 흑백 쪽이 컬러로 셀 수 있다
//   실행: npx electron scripts/test/crop-marks-k100.e2e.js   (창 없음 · Ghostscript 필요)
// 사용자 결정(2026-10-26). 흑백 원고를 모아찍기·반반·복제 2부·반복(셔플)로 놓고 재단선·재단 치수·슬러그·
// 묶음번호·프레임을 모두 켠 결과에서: ① gs inkcov 쪽마다 C+M+Y = 0 ② 내용에 K100 연산자(0 0 0 1 K/k)
// ③ RGB 검정(0 0 0 RG/rg)이 없다 ④ 표지 오시선·조립 워커 테두리도 같은 색(소스 확인)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-cropk100'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
function inkcov(file) {
  const out = execFileSync('gswin64c', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-o', '-', file], { encoding: 'utf8' });
  return out.trim().split(/\r?\n/).filter(l => /CMYK/.test(l)).map(l => l.trim().split(/\s+/).slice(0, 4).map(Number));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const MM = 72 / 25.4;
      const { PDFDocument, grayscale } = PDFLib;
      const d = await PDFDocument.create();
      for (let i = 0; i < 4; i++) {
        const p = d.addPage([148 * MM, 210 * MM]);
        p.drawRectangle({ x: 0, y: 0, width: 148 * MM, height: 210 * MM, color: grayscale(0.9) });
        p.drawRectangle({ x: 20 * MM, y: 20 * MM, width: 60 * MM, height: 80 * MM, color: grayscale(0.2) });
      }
      const src = await d.save();
      const base = Object.assign({}, currentImpOptions(), {
        sheet: [320 * MM, 450 * MM], margin: 12, gutter: 8, hgap: null, vgap: null, bleed: 0, srcBleed: 0,
        crop: true, cropDims: true, frame: true, stackNum: true,
        slug: { text: 'test sheet', fontBytes: null },
        cropStyle: { shape: 'double', gap: 3, len: 4, th: 0.3, center: true },
        place: { scale: 'orig', align: 'cc' } });
      const cases = {
        nup:      [buildNupBytes, { mode: 'nup', across: 2, down: 2, sides: 1, order: 'sequential' }],
        cutstack: [buildNupBytes, { mode: 'cutstack', across: 2, down: 1, sides: 2, order: 'cutstack' }],
        dup:      [buildDup2upBytes, { mode: 'dup', sides: 2, dupDir: 'v' }],
        shuffle:  [buildStepRepeatBytes, { mode: 'repeat', cols: 2, rows: 2, shuffleCopies: 3, shuffleDuplex: 'long' }],
      };
      const out = {};
      for (const [k, [fn, o]] of Object.entries(cases)) {
        const res = await fn(src, Object.assign({}, base, o));
        // 내용 스트림에서 색 연산자 모으기(풀어서)
        const doc = await PDFDocument.load(res.bytes);
        let txt = '';
        for (const pg of doc.getPages()) {
          const c = pg.node.Contents();
          const arr = c instanceof PDFLib.PDFArray ? c.asArray() : [pg.node.get(PDFLib.PDFName.of('Contents'))];
          for (const ref of arr) {
            const st = doc.context.lookup(ref);
            try { txt += new TextDecoder('latin1').decode(PDFLib.decodePDFRawStream(st).decode()) + '\\n'; } catch (e) {}
          }
        }
        out[k] = { file: await window.electronAPI.writeTempFile(res.bytes, 'pdf'),
          k100: (txt.match(/\\b0 0 0 1 [Kk]\\b/g) || []).length,
          rgbBlack: (txt.match(/(^|\\s)0 0 0 (RG|rg)\\b/g) || []).length };
      }
      return out;
    })()`);
    console.log('✂ 재단선·표시 = 먹 1도(K100)');
    for (const [k, v] of Object.entries(r)) {
      const ic = inkcov(v.file);
      const cmy = ic.reduce((a, x) => a + x[0] + x[1] + x[2], 0);
      ok(ic.length > 0 && cmy === 0 && v.k100 > 0 && v.rgbBlack === 0,
        `${k}: 쪽 ${ic.length}개 inkcov C+M+Y 합 ${cmy} · K100 연산자 ${v.k100}개 · RGB 검정 ${v.rgbBlack}개`);
      try { fs.unlinkSync(v.file); } catch (e) {}
    }
    const proc = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
    const wk = fs.readFileSync(path.join(ROOT, 'src/worker-assemble.js'), 'utf8');
    ok(!/PDFLib\.rgb\(0, ?0, ?0\)/.test(proc) && !/PDFLib\.rgb\(0, ?0, ?0\)/.test(wk),
      '앱(표지 오시선 포함)·조립 워커(편집 모드 테두리·재단선)에 RGB 검정이 남아 있지 않다');
  } catch (e) { fail++; console.error(e); }
  console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
  app.exit(fail ? 1 : 0);
});
