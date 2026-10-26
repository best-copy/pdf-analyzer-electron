// ◲ 블리드 생성 — 바깥 띠를 그림으로(쪽은 한 번만 그린다)
//   실행: npx electron scripts/test/bleed-raster.e2e.js            (창 없음 · Ghostscript 필요)
//         BLEED_OLD=<옛 app-process.js 사본> 이면 옛 방식(쪽 9번 그리기)과 화소 비교도 한다
//         BLEED_PDF=<무거운 실파일.pdf> 이면 그 파일로 렌더 시간(gs)을 잰다
// 회귀(2026-10-26): 블리드가 쪽 전체를 9번 그려 투명도·사진 많은 도록을 아크로뱃이 열 때 한참 멈췄다.
// 확인: ① 결과 쪽은 원본 폼 1번 + 띠 그림 4장 ② 트림 안은 원본과 같다 ③ 띠는 미러(가장자리 반사)
//      ④ 무채색 쪽 띠는 DeviceGray → gs inkcov C+M+Y = 0 ⑤ /Rotate 90 쪽도 띠가 맞는다
//      ⑥ TrimBox·BleedBox ⑦ (선택) 옛 방식과 화소 비교 ⑧ (선택) 실파일 렌더 시간
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-bleedraster'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const DPI = 100, MMP = DPI / 25.4;

function ppm(file, pageNo, dpi) {
  const out = file.replace(/\.pdf$/, '_' + pageNo + '_' + Math.random().toString(36).slice(2) + '.ppm');
  execFileSync('gswin64c', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', '-r' + (dpi || DPI), '-dFirstPage=' + pageNo, '-dLastPage=' + pageNo, '-o', out, file]);
  const b = fs.readFileSync(out); let i = 0; const tok = [];
  while (tok.length < 4) { while (b[i] === 35) { while (b[i] !== 10) i++; i++; } const st = i; while (b[i] > 32) i++; tok.push(b.slice(st, i).toString()); i++; }
  try { fs.unlinkSync(out); } catch (e) {}
  return { w: +tok[1], h: +tok[2], d: b.slice(b.length - (+tok[1]) * (+tok[2]) * 3) };
}
const px = (img, xmm, ymm) => { const x = Math.min(img.w - 1, Math.round(xmm * MMP)), y = Math.min(img.h - 1, Math.round(ymm * MMP)); const o = (y * img.w + x) * 3; return [img.d[o], img.d[o + 1], img.d[o + 2]]; };
const near = (a, b2, t) => Math.abs(a[0] - b2[0]) <= t && Math.abs(a[1] - b2[1]) <= t && Math.abs(a[2] - b2[2]) <= t;
// 두 렌더의 평균 차(영역: 'all' | 'trim' | 'bleed'), bleedMm = 블리드 폭
function meanDiff(A, B, bleedMm, region) {
  if (A.w !== B.w || A.h !== B.h) return 999;
  const bp = bleedMm * MMP + 2; let s = 0, n = 0;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    const inTrim = x > bp && y > bp && x < A.w - bp && y < A.h - bp;
    if (region === 'trim' && !inTrim) continue;
    if (region === 'bleed' && inTrim) continue;
    const o = (y * A.w + x) * 3;
    s += Math.abs(A.d[o] - B.d[o]) + Math.abs(A.d[o + 1] - B.d[o + 1]) + Math.abs(A.d[o + 2] - B.d[o + 2]); n += 3;
  }
  return s / Math.max(1, n);
}
function inkcov(file) {
  const out = execFileSync('gswin64c', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-o', '-', file], { encoding: 'utf8' });
  return out.trim().split(/\r?\n/).filter(l => /CMYK/.test(l)).map(l => l.trim().split(/\s+/).slice(0, 4).map(Number));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const files = [];
  try {
    // 옛 함수(선택) — 같은 화면 전역으로 꺼내 둔다
    let oldSrc = null;
    if (process.env.BLEED_OLD && fs.existsSync(process.env.BLEED_OLD)) {
      const a = fs.readFileSync(process.env.BLEED_OLD, 'utf8');
      const s = a.indexOf('    async function buildBleedBytes('), e = a.indexOf('\n    }\n', s) + 6;
      oldSrc = a.slice(s, e).replace('async function buildBleedBytes(', 'window.__oldBleed = async function (');
    }
    const r = await win.webContents.executeJavaScript(`(async () => {
      ${oldSrc ? oldSrc + ';' : ''}
      const MM = 72 / 25.4;
      const { PDFDocument, rgb, grayscale, degrees } = PDFLib;
      // 컬러 쪽: 가장자리마다 다른 색 띠(5mm) + 가운데 대각 무늬 + 맨 가장자리 0.1mm 테두리(가려져야 할 줄)
      const d = await PDFDocument.create();
      const W = 148 * MM, H = 105 * MM;
      for (let i = 0; i < 2; i++) {
        const p = d.addPage([W, H]);
        p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 0.9) });
        p.drawRectangle({ x: 0, y: 0, width: 5 * MM, height: H, color: rgb(0.9, 0.1, 0.1) });        // 왼쪽 빨강
        p.drawRectangle({ x: W - 5 * MM, y: 0, width: 5 * MM, height: H, color: rgb(0.1, 0.2, 0.9) }); // 오른쪽 파랑
        p.drawRectangle({ x: 0, y: H - 5 * MM, width: W, height: 5 * MM, color: rgb(0.1, 0.7, 0.2) }); // 위 초록
        p.drawRectangle({ x: 0, y: 0, width: W, height: 5 * MM, color: rgb(0.95, 0.6, 0.1) });       // 아래 주황
        for (let k = 0; k < 12; k++) p.drawLine({ start: { x: 10 * MM + k * 10 * MM, y: 10 * MM }, end: { x: 20 * MM + k * 10 * MM, y: H - 10 * MM }, thickness: 2, color: rgb(0.2, 0.2, 0.2) });
        p.drawRectangle({ x: 0.15, y: 0.15, width: W - 0.3, height: H - 0.3, borderColor: rgb(0, 0, 0), borderWidth: 0.3 });   // 가장자리 자국
        if (i === 1) p.setRotation(degrees(90));
      }
      const colorSrc = await d.save();
      // 무채색 쪽(회색 칠·회색 글자 대신 회색 상자들)
      const g = await PDFDocument.create();
      const gp = g.addPage([W, H]);
      gp.drawRectangle({ x: 0, y: 0, width: W, height: H, color: grayscale(0.85) });
      gp.drawRectangle({ x: 0, y: 0, width: 8 * MM, height: H, color: grayscale(0.3) });
      gp.drawRectangle({ x: 20 * MM, y: 20 * MM, width: 50 * MM, height: 40 * MM, color: grayscale(0.1) });
      const graySrc = await g.save();
      const T = s => window.electronAPI.writeTempFile(s, 'pdf');
      const out = {};
      const t0 = performance.now();
      const nb = await buildBleedBytes(colorSrc, 3, null, { crop: false });
      out.ms = Math.round(performance.now() - t0);
      out.newFile = await T(nb.bytes); out.srcFile = await T(colorSrc);
      const doc = await PDFDocument.load(nb.bytes);
      out.pages = doc.getPages().map(pg => {
        const xo = pg.node.Resources().lookup(PDFLib.PDFName.of('XObject'));
        const kinds = [...xo.entries()].map(([, v]) => String(doc.context.lookup(v).dict.get(PDFLib.PDFName.of('Subtype'))));
        return { forms: kinds.filter(k => k === '/Form').length, images: kinds.filter(k => k === '/Image').length,
                 trim: String(pg.node.get(PDFLib.PDFName.of('TrimBox'))), size: pg.getSize() };
      });
      const gb = await buildBleedBytes(graySrc, 3, null, { crop: true });   // 재단선도 먹 1도(K100)라 C·M·Y 0이어야 한다
      out.grayFile = await T(gb.bytes);
      const gd = await PDFDocument.load(gb.bytes);
      out.grayCs = [...gd.getPage(0).node.Resources().lookup(PDFLib.PDFName.of('XObject')).entries()]
        .map(([, v]) => gd.context.lookup(v).dict).filter(dd => String(dd.get(PDFLib.PDFName.of('Subtype'))) === '/Image')
        .map(dd => String(dd.get(PDFLib.PDFName.of('ColorSpace'))));
      if (window.__oldBleed) { const ob = await window.__oldBleed(colorSrc, 3, null, { crop: false }); out.oldFile = await T(ob.bytes); }
      return out;
    })()`);
    files.push(r.newFile, r.srcFile, r.grayFile, r.oldFile);
    console.log('◲ 블리드 — 띠를 그림으로 (만들기 ' + r.ms + 'ms)');
    ok(r.pages.every(p => p.forms === 1 && p.images === 4), '결과 쪽마다 원본 폼 1번 + 띠 그림 4장 ' + JSON.stringify(r.pages.map(p => [p.forms, p.images])));
    const MMpt = 72 / 25.4;
    ok(Math.abs(r.pages[0].size.width - 154 * MMpt) < 0.1 && Math.abs(r.pages[0].size.height - 111 * MMpt) < 0.1 && /8\.50|8\.5039/.test(r.pages[0].trim),
      '쪽 크기 = 트림 + 3mm × 2, TrimBox 기록 ' + r.pages[0].trim);
    const N = ppm(r.newFile, 1), S = ppm(r.srcFile, 1);
    // 트림 안(가장자리 1mm 제외)은 원본과 같다
    {
      let s = 0, n = 0;
      for (let y = Math.round(4 * MMP); y < N.h - Math.round(4 * MMP); y++) for (let x = Math.round(4 * MMP); x < N.w - Math.round(4 * MMP); x++) {
        const o = (y * N.w + x) * 3, sx = x - Math.round(3 * MMP), sy = y - Math.round(3 * MMP);
        if (sx < 0 || sy < 0 || sx >= S.w || sy >= S.h) continue;
        const q = (sy * S.w + sx) * 3;
        s += Math.abs(N.d[o] - S.d[q]) + Math.abs(N.d[o + 1] - S.d[q + 1]) + Math.abs(N.d[o + 2] - S.d[q + 2]); n += 3;
      }
      ok(s / n < 2, '트림 안은 원본과 같다 (평균 차 ' + (s / n).toFixed(2) + ')');
    }
    // 띠 = 미러: 블리드 1.5mm 자리 색 = 그 가장자리 색, 모서리 = 가까운 두 띠 중 위에 그린 색
    const red = [230, 26, 26], blue = [26, 51, 230], green = [26, 179, 51], orange = [242, 153, 26];
    const midY = 111 / 2, midX = 154 / 2;
    ok(near(px(N, 1.5, midY), red, 30) && near(px(N, 154 - 1.5, midY), blue, 30) && near(px(N, midX, 1.5), green, 30) && near(px(N, midX, 111 - 1.5), orange, 30),
      '사방 블리드 = 가장자리 색 반사 ' + JSON.stringify([px(N, 1.5, midY), px(N, 154 - 1.5, midY), px(N, midX, 1.5), px(N, midX, 111 - 1.5)]));
    // 가장자리 자국(검은 0.3pt 테두리)은 트림선 위·바깥에 남지 않는다
    {
      let dark = 0;
      for (let y = Math.round(10 * MMP); y < N.h - Math.round(10 * MMP); y++) for (let x = 0; x < Math.round(3.4 * MMP); x++) {
        const c = [N.d[(y * N.w + x) * 3], N.d[(y * N.w + x) * 3 + 1], N.d[(y * N.w + x) * 3 + 2]];
        if (c[0] < 120 && c[1] < 60) dark++;
      }
      ok(dark === 0, '원고 가장자리 자국이 트림선 부근에 남지 않는다 (어두운 화소 ' + dark + ')');
    }
    // /Rotate 90 쪽: 돌린 뒤 왼쪽 = 원래 아래(주황)
    {
      const R2 = ppm(r.newFile, 2);
      ok(R2.h > R2.w && near(px(R2, 1.5, 154 / 2), orange, 30) && near(px(R2, 111 - 1.5, 154 / 2), green, 30),
        '/Rotate 90 쪽도 띠 방향이 맞다 ' + JSON.stringify([px(R2, 1.5, 77), px(R2, 109.5, 77)]));
    }
    ok(r.grayCs.length === 4 && r.grayCs.every(c => c === '/DeviceGray'), '무채색 쪽 띠 = DeviceGray ' + JSON.stringify(r.grayCs));
    {
      const ic = inkcov(r.grayFile)[0];
      ok(ic && ic[0] + ic[1] + ic[2] === 0, '무채색 쪽(재단선 포함): gs inkcov C+M+Y = 0 ' + JSON.stringify(ic));
    }
    if (r.oldFile) {
      const O = ppm(r.oldFile, 1), O2 = ppm(r.oldFile, 2), N2 = ppm(r.newFile, 2);
      const tA = meanDiff(N, O, 3, 'trim'), bA = meanDiff(N, O, 3, 'bleed'), b2 = meanDiff(N2, O2, 3, 'bleed');
      ok(tA < 1.5 && bA < 6 && b2 < 6, `옛 방식(쪽 9번)과 화소 비교 — 트림 안 ${tA.toFixed(2)} · 블리드 ${bA.toFixed(2)} · 회전 쪽 블리드 ${b2.toFixed(2)}`);
    } else console.log('  (BLEED_OLD 없음 — 옛 방식 비교 건너뜀)');

    // 실파일: 블리드 1mm 만들어 gs 렌더 시간 비교
    const real = process.env.BLEED_PDF;
    if (real && fs.existsSync(real)) {
      const q = await win.webContents.executeJavaScript(`(async () => {
        const src = new Uint8Array(await (await fetch('file:///' + ${JSON.stringify(real.replace(/\\/g, '/'))})).arrayBuffer());
        const t0 = performance.now(); const nb = await buildBleedBytes(src, 1, null, { crop: false }); const ms = Math.round(performance.now() - t0);
        const out = { ms, mb: +(nb.bytes.length / 1048576).toFixed(1), file: await window.electronAPI.writeTempFile(nb.bytes, 'pdf') };
        if (window.__oldBleed) { const ob = await window.__oldBleed(src, 1, null, { crop: false }); out.oldFile = await window.electronAPI.writeTempFile(ob.bytes, 'pdf'); }
        return out;
      })()`);
      files.push(q.file, q.oldFile);
      const time = f => { const t = Date.now(); execFileSync('gswin64c', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=nullpage', '-r100', f]); return Date.now() - t; };
      const tSrc = time(real), tNew = time(q.file), tOld = q.oldFile ? time(q.oldFile) : null;
      console.log(`    실파일: 만들기 ${q.ms}ms · ${q.mb}MB · gs 전체 렌더 원본 ${tSrc}ms · 새 블리드 ${tNew}ms` + (tOld ? ` · 옛 블리드 ${tOld}ms` : ''));
      ok(tNew < tSrc * 2.5, '실파일: 블리드본 렌더가 원본의 2.5배 안 (' + (tNew / tSrc).toFixed(2) + '배)');
      if (q.oldFile) {
        const pages = [1, 2, 10];
        const diffs = pages.map(p => meanDiff(ppm(q.file, p, 50), ppm(q.oldFile, p, 50), 1, 'all'));
        ok(diffs.every(v => v < 2), '실파일: 옛 방식과 쪽 전체 화소 차 ' + diffs.map(v => v.toFixed(2)).join(' / '));
      }
    }
  } catch (e) { fail++; console.error(e); }
  for (const f of files) try { if (f) fs.unlinkSync(f); } catch (e) {}
  console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
  app.exit(fail ? 1 : 0);
});
