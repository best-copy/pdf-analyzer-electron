// 🔤 폰트 완전 임베드 가속 — (A) 이미 전부 임베드된 문서는 gs를 건너뛰는지,
//   (C) 대체될 폰트를 gs 실행 전에 찾아내 pdfwrite를 한 번만 돌리는지,
//   그리고 재귀 폰트 스캔이 Form XObject 안의 폰트를 찾는지 확인한다.
//   실행: npx electron scripts/test/font-embed-fast.e2e.js [원본.pdf] [이미전부임베드본.pdf]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const gsCalls = {};   // 채널별 gs 호출 횟수 (메인에서 집계)

// main.js의 gs 핸들러를 **원본 그대로 꺼내** 이 하네스에 등록한다.
// 테스트용 복사본을 만들면 플래그가 드리프트하므로(CLAUDE.md 7-2) 소스에서 추출해 eval 한다.
function installGsHandlers() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split('\r\n').join('\n');   // main.js는 CRLF
  const cut = (marker, end) => {
    const i = src.indexOf(marker);
    if (i < 0) throw new Error('main.js에서 못 찾음: ' + marker);
    const j = src.indexOf(end, i);
    if (j < 0) throw new Error('끝을 못 찾음: ' + marker);
    return src.slice(i, j + end.length);
  };
  const NL = '\n';
  const code = [
    'let _gsPath = null;',
    cut('function findGhostscript() {', NL + '}' + NL),
    // 폰트 색인·cidfmap 생성 블록 (CID 폰트를 설치본으로 잇는 부분)
    cut('let _fontIndex = null;', NL + '// ── IPC: 폰트 아웃라인화'),
    cut("ipcMain.handle('gs:outlineFonts'", NL + '});' + NL),
    cut("ipcMain.handle('gs:probeFonts'", NL + '});' + NL),
  ].join(NL);
  // gs 호출 횟수는 **메인에서** 센다 — contextBridge로 넘어간 electronAPI는 얼려 있어
  // 렌더러에서 함수를 갈아끼워도 조용히 무시된다(예전 하네스가 0회로 오판한 원인).
  const counter = {
    handle: (ch, fn) => ipcMain.handle(ch, (...a) => { gsCalls[ch] = (gsCalls[ch] || 0) + 1; return fn(...a); }),
  };
  new Function('ipcMain', 'path', 'os', 'fs', 'execFile', 'process', '__dirname', code)(
    counter, path, os, fs, execFile, process, ROOT);
}

const SRC = process.argv[2] || 'D:/바탕화면/수학_2up.pdf';
const EMBEDDED = process.argv[3] || null;   // 미임베드 폰트가 없는 문서(없으면 SRC를 gs로 구워 만든다)

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

// 이 PC에 **없는** CID(Adobe-Korea1) 폰트를 요구하는 PDF를 만든다 — 대체·이미지화 분기 검증용.
// (수학_2up.pdf의 KoPubWorldDotum,Bold는 이제 설치본으로 이어지므로 그 분기를 못 덮는다)
function makeMissingCidPdf(file, nPages, usePages, fontName) {
  const NL = String.fromCharCode(10);
  const hex = Buffer.from('없는폰트 시험', 'utf16le').swap16().toString('hex').toUpperCase();
  const objs = [];
  const add = t => { objs.push(t); return objs.length; };
  add('');                                          // 1: Catalog (뒤에서 채움)
  add('');                                          // 2: Pages
  const fT0 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${fontName} /Encoding /UniKS-UTF16-H /DescendantFonts [${objs.length + 2} 0 R] >>`);
  const fDesc = objs.length + 2;                     // 자손 폰트 다음이 디스크립터
  add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${fontName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor ${fDesc} 0 R /DW 1000 >>`);
  add(`<< /Type /FontDescriptor /FontName /${fontName} /Flags 4 /FontBBox [-200 -250 1200 950] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>`);
  const kids = [];
  for (let i = 0; i < nPages; i++) {
    const uses = usePages.includes(i);
    const content = uses ? `BT /F1 20 Tf 40 120 Td <${hex}> Tj ET` : '0 0 0 RG 2 w 20 20 200 100 re S';
    const cObj = add(`<< /Length ${content.length} >>${NL}stream${NL}${content}${NL}endstream`);
    const res = uses ? '<< /Font << /F1 ' + fT0 + ' 0 R >> >>' : '<< >>';
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources ${res} /Contents ${cObj} 0 R >>`));
  }
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4' + NL;
  const offs = [];
  objs.forEach((o, i) => { offs[i] = out.length; out += `${i + 1} 0 obj${NL}${o}${NL}endobj${NL}`; });
  const xref = out.length;
  out += `xref${NL}0 ${objs.length + 1}${NL}0000000000 65535 f ${NL}`
    + offs.map(o => String(o).padStart(10, '0') + ' 00000 n ' + NL).join('');
  out += `trailer${NL}<< /Size ${objs.length + 1} /Root 1 0 R >>${NL}startxref${NL}${xref}${NL}%%EOF${NL}`;
  fs.writeFileSync(file, Buffer.from(out, 'latin1'));
  return file;
}

// 렌더러로 PDF를 넘길 때는 임시파일 경로만 준다 (대용량 IPC 직렬화 금지 규칙)
function stage(src) {
  const p = path.join(os.tmpdir(), `pdfedit_fetest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`);
  fs.copyFileSync(src, p);
  return p;
}

app.whenReady().then(async () => {
  // 하네스가 오류로 멈춰도 무한 대기하지 않게 상한을 둔다 (E2E 하네스 함정)
  setTimeout(() => { console.log('\n✘ 시간 초과(6분)'); app.exit(1); }, 360000).unref();
  installGsHandlers();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer]', msg); });
  try {
    await win.loadFile(path.join(ROOT, 'src/index.html'));
    await new Promise(r => setTimeout(r, 1600));
    const run = js => win.webContents.executeJavaScript(js);

    // ── 1. 재귀 폰트 스캔 (Form XObject 안의 폰트) ─────────────────────────
    console.log('\n[1] 폰트 스캔 — 임포징 원고는 내용이 Form XObject 안에 있다');
    const srcPath = stage(SRC);
    const scan = await run(`(async () => {
      const bytes = new Uint8Array(window.electronAPI.readFile(${JSON.stringify(srcPath)}));
      window.__b = bytes;
      const doc = await PDFLib.PDFDocument.load(bytes.slice(0), { ignoreEncryption: true });
      const s = scanDocFonts(doc);
      return {
        pages: doc.getPageCount(),
        embedded: s.embedded.size,
        missing: [...s.missing.entries()].map(([n, p]) => [n, p.size]),
      };
    })()`);
    console.log('    ', JSON.stringify(scan));
    ck('임베드 폰트를 찾는다 (페이지 Resources만 보면 0종)', scan.embedded > 0, scan.embedded);
    ck('미임베드 폰트를 찾는다', scan.missing.length > 0, scan.missing);

    // ── 2. C — gs 실행 전 대체 폰트 확정 (nullpage 프로브) ────────────────
    console.log('\n[2] 대체될 폰트 사전 감지 (gs nullpage 프로브)');
    const t0 = Date.now();
    const probe = await run(`(async () => {
      const doc = await PDFLib.PDFDocument.load(window.__b.slice(0), { ignoreEncryption: true });
      const s = scanDocFonts(doc);
      return await _probeSubstitutedFonts(window.__b, s.missing);
    })()`);
    console.log('    ', JSON.stringify(probe), (Date.now() - t0) + 'ms');
    ck('프로브가 동작한다 (null = 폴백)', probe !== null, probe);
    ck('프로브가 3초 안에 끝난다', Date.now() - t0 < 3000, Date.now() - t0);

    // ── 3. 완전 임베드 실행 — gs 호출 횟수·소요 시간 ──────────────────────
    console.log('\n[3] 완전 임베드 실행 (gs 호출 횟수를 세어 2패스 여부 확인)');
    const res = await run(`(async () => {
      _outlineCache = { key: null, bytes: null, rasterInfo: null, skipInfo: null, fontWarn: null };
      _outlineMode = 'embed';
      const t = Date.now();
      const out = await buildOutlinedBytes(window.__b);
      const ms = Date.now() - t;
      const after = scanDocFonts(await PDFLib.PDFDocument.load(out.slice(0), { ignoreEncryption: true }));
      return { ms, size: out.byteLength, inSize: window.__b.byteLength,
               raster: _outlineRasterInfo, skip: _outlineSkipInfo, warn: _outlineFontWarn,
               cidLinked: _outlineCidLinked, leftover: [...after.missing.keys()],
               note: outlineResultNote(), same: out === window.__b };
    })()`);
    console.log('    ', JSON.stringify(res));
    ck('pdfwrite는 한 번만 돈다', gsCalls['gs:outlineFonts'] === 1, gsCalls);
    if (res.cidLinked) {
      // 미임베드 CID 폰트가 이 PC에 설치돼 있으면 cidfmap으로 이어 실어야 한다
      ck('설치된 CID 폰트를 찾아 이어 실었다', res.cidLinked.length > 0, res.cidLinked);
      ck('이었으므로 이미지화·경고가 없다', !res.raster && !res.warn, { raster: res.raster, warn: res.warn });
      ck('결과에 미임베드 폰트가 남지 않는다', res.leftover.length === 0, res.leftover);
      ck('대체 글꼴 안내가 아니라 이어 실었다고 안내한다', /찾아 실었습니다/.test(res.note || ''), res.note);
    }
    ck('프로브가 먼저 돌았다', (gsCalls['gs:probeFonts'] || 0) >= 1, gsCalls);
    ck('결과 PDF가 생성됐다', res.size > 1000, res.size);
    if (res.warn) {
      ck('문서 대부분이 대체 대상이면 이미지화하지 않고 경고한다', !res.raster && res.warn.count > 0, res.warn);
      ck('경고에 폰트 이름이 담긴다', res.warn.fonts.length > 0, res.warn.fonts);
      ck('통째로 이미지가 되지 않아 용량이 폭증하지 않는다', res.size < res.inSize * 4, [res.inSize, res.size]);
    }

    // ── 4. 캐시 적중 시 상태 복원 ─────────────────────────────────────────
    console.log('\n[4] 같은 바이트 재요청 — 캐시 적중');
    const again = await run(`(async () => {
      const t = Date.now();
      await buildOutlinedBytes(window.__b);
      return { ms: Date.now() - t, warn: !!_outlineFontWarn, raster: !!_outlineRasterInfo };
    })()`);
    console.log('    ', JSON.stringify(again));
    ck('캐시 적중은 즉시(200ms 미만)', again.ms < 200, again.ms);
    ck('경고/이미지화 정보도 함께 복원된다', again.warn === !!res.warn && again.raster === !!res.raster, again);

    // ── 5. A — 이미 전부 임베드된 문서는 굽지 않는다 ──────────────────────
    console.log('\n[5] 이미 모든 폰트가 임베드된 문서 — gs 생략');
    let embPath = EMBEDDED;
    if (!embPath) {
      // 3번 결과(완전 임베드본)를 파일로 떨궈 그대로 쓴다 — 미임베드 폰트가 없는 문서
      embPath = await run(`(async () => {
        const out = await buildOutlinedBytes(window.__b);
        return window.electronAPI.writeTempFile(out, 'pdf');
      })()`);
    } else embPath = stage(embPath);
    const before = { out: gsCalls['gs:outlineFonts'] || 0, probe: gsCalls['gs:probeFonts'] || 0 };
    const skip = await run(`(async () => {
      const bytes = new Uint8Array(window.electronAPI.readFile(${JSON.stringify(embPath)}));
      _outlineCache = { key: null, bytes: null, rasterInfo: null, skipInfo: null, fontWarn: null };
      const doc = await PDFLib.PDFDocument.load(bytes.slice(0), { ignoreEncryption: true });
      const s = scanDocFonts(doc);
      const t = Date.now();
      const out = await buildOutlinedBytes(bytes);
      const ms = Date.now() - t;
      return { missing: [...s.missing.keys()], ms, same: out === bytes, skip: _outlineSkipInfo,
               note: (typeof outlineResultNote === 'function' ? outlineResultNote() : '') };
    })()`);
    console.log('    ', JSON.stringify(skip));
    ck('이 문서에는 미임베드 폰트가 없다', skip.missing.length === 0, skip.missing);
    ck('gs를 한 번도 부르지 않는다', gsCalls['gs:outlineFonts'] === before.out && gsCalls['gs:probeFonts'] === before.probe, [before, gsCalls]);
    ck('입력 바이트를 그대로 돌려준다', skip.same === true, skip.same);
    ck('1초 안에 끝난다', skip.ms < 1000, skip.ms);
    ck('건너뛴 사실을 안내한다', /다시 굽지 않았습니다/.test(skip.note || ''), skip.note);

    // ── 6·7. 이 PC에 없는 폰트 — 소수 쪽이면 이미지화, 대부분이면 경고만 ──
    const runMissing = async (label, nPages, usePages) => {
      const f = path.join(os.tmpdir(), `pdfedit_fetest_miss_${Date.now()}_${nPages}_${usePages.length}.pdf`);
      makeMissingCidPdf(f, nPages, usePages, 'ZZNoSuchKoreanFont,Bold');
      const r = await run(`(async () => {
        const bytes = new Uint8Array(window.electronAPI.readFile(${JSON.stringify(f)}));
        _outlineCache = { key: null, bytes: null, rasterInfo: null, skipInfo: null, fontWarn: null };
        const out = await buildOutlinedBytes(bytes);
        const after = scanDocFonts(await PDFLib.PDFDocument.load(out.slice(0), { ignoreEncryption: true }));
        return { raster: _outlineRasterInfo, warn: _outlineFontWarn, cidLinked: _outlineCidLinked,
                 leftover: [...after.missing.keys()], note: outlineResultNote(),
                 pages: (await PDFLib.PDFDocument.load(out.slice(0))).getPageCount() };
      })()`);
      try { fs.unlinkSync(f); } catch (e) {}
      console.log('    ', label, JSON.stringify(r));
      return r;
    };

    console.log(String.fromCharCode(10)+'[6] 이 PC에 없는 폰트가 1/10쪽 — 그 쪽만 300DPI 이미지화');
    const few = await runMissing('1/10쪽:', 10, [0]);
    ck('그 쪽만 이미지화했다 (1쪽)', few.raster && few.raster.count === 1, few.raster);
    ck('이미지화한 쪽 번호가 맞다 (1p)', few.raster && few.raster.pages[0] === 1, few.raster);
    ck('경고 대신 이미지화로 처리했다', !few.warn, few.warn);
    ck('쪽 수는 그대로 10쪽', few.pages === 10, few.pages);
    ck('결과에 미임베드 폰트가 남지 않는다', few.leftover.length === 0, few.leftover);

    console.log(String.fromCharCode(10)+'[7] 이 PC에 없는 폰트가 10/10쪽 — 이미지화하지 않고 경고');
    const many = await runMissing('10/10쪽:', 10, [0,1,2,3,4,5,6,7,8,9]);
    ck('전 쪽이 대상이면 이미지화하지 않는다', !many.raster, many.raster);
    ck('대신 경고를 남긴다', !!many.warn && many.warn.count === 10, many.warn);
    ck('경고 문구에 폰트 설치 안내가 있다', /설치한 뒤/.test(many.note || ''), many.note);

    try { fs.unlinkSync(srcPath); } catch (e) {}
  } catch (e) {
    fail++; console.log('  ✘ 예외:', e && e.message ? e.message : e);
  }
  console.log(`\n${fail ? '✘ 실패' : '✅ 통과'} — ${pass}개 성공, ${fail}개 실패`);
  app.exit(fail ? 1 : 0);
});
