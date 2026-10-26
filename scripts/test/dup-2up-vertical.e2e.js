// 📖 복제 2부 — 위아래 배치(세로 대지·긴 쪽 넘김) · 자동 방향 선택
//   실행: npx electron scripts/test/dup-2up-vertical.e2e.js   (창 없음 · Ghostscript 필요)
// 사용자 요청(2026-10-26): 가로형 A5(210×148) 도록을 219×312 대지에 복제 2부 — 좌우로는 420mm라 안 들어간다 → 위아래.
// 확인: ① 자동 = 가로형 원고는 위아래(세로 대지), 세로형 원고는 좌우(예전 그대로)
//      ② 앞면 위 = 1쪽 정방향, 아래 = 1쪽 180° / 뒷면 위 = 2쪽 정방향, 아래 = 2쪽 180°
//         (세로 대지를 긴 쪽(세로축)으로 넘기면 위 칸 뒤 = 위 칸 — 그래야 재단한 낱장의 앞뒤가 1·2쪽 정방향)
//      ③ 좌우 강제·위아래 강제 ④ 거터 = 입력값(위아래 간격) ⑤ 블리드 원고(TrimBox)의 재단선 자리
//      ⑥ UI(배치 선택 줄·옵션·프리셋 왕복)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-dupvert'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };

// 72dpi ppm 읽기
function ppm(file, pageNo) {
  const out = file.replace(/\.pdf$/, '_' + pageNo + '.ppm');
  execFileSync('gswin64c', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', '-r72', '-dFirstPage=' + pageNo, '-dLastPage=' + pageNo, '-o', out, file]);
  const b = fs.readFileSync(out); let i = 0; const tok = [];
  while (tok.length < 4) { while (b[i] === 35) { while (b[i] !== 10) i++; i++; } const st = i; while (b[i] > 32) i++; tok.push(b.slice(st, i).toString()); i++; }
  try { fs.unlinkSync(out); } catch (e) {}
  const w = +tok[1], h = +tok[2];
  return { w, h, d: b.slice(b.length - w * h * 3) };
}
// 칸(트림 상자, 위에서 mm) 안: 가운데 빨강 → 쪽 번호, 검은 표식이 왼쪽 위면 정방향(0), 오른쪽 아래면 180
function readCell(img, x, y, cw, ch) {
  const MMP = 72 / 25.4, px = v => Math.round(v * MMP);
  const at = (xx, yy) => { const o = (px(yy) * img.w + px(xx)) * 3; return [img.d[o], img.d[o + 1], img.d[o + 2]]; };
  const c = at(x + cw / 2, y + ch / 2);
  const page = c[1] > 200 ? 0 : Math.round((c[0] - 40) / 30) + 1;
  const tl = at(x + 6, y + 6), br = at(x + cw - 6, y + ch - 6);
  const dark = p => p[0] < 30 && p[1] < 30 && p[2] < 30;
  return { page, rot: dark(tl) ? 0 : dark(br) ? 180 : -1 };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const MM = 72 / 25.4;
      const { PDFDocument, rgb } = PDFLib;
      // n쪽, 쪽마다 빨강 농도 + 왼쪽 위 검은 표식(10mm). bleedMm>0이면 MediaBox를 블리드만큼 키우고 TrimBox를 단다
      const mk = async (n, w, h, bleedMm) => {
        const d = await PDFDocument.create(); const b = (bleedMm || 0) * MM;
        for (let i = 0; i < n; i++) {
          const p = d.addPage([w * MM + 2 * b, h * MM + 2 * b]);
          p.drawRectangle({ x: 0, y: 0, width: w * MM + 2 * b, height: h * MM + 2 * b, color: rgb((40 + i * 30) / 255, 0, 0) });
          p.drawRectangle({ x: b, y: b + h * MM - 10 * MM, width: 10 * MM, height: 10 * MM, color: rgb(0, 0, 0) });
          if (b) p.setTrimBox(b, b, w * MM, h * MM);
        }
        return d.save();
      };
      const g = id => document.getElementById(id);
      setImpMode('dup');
      const rowShown = g('impDupRow').style.display !== 'none';
      populatePaperSelect('__custom__'); g('bkPaper').value = '__custom__';
      g('impCustomW').value = 219; g('impCustomH').value = 312; onImpPaperChange();
      g('impMargin').value = 0; g('bkGutter').value = 2; g('impBleed').value = 0;
      setImpScale('orig'); setCutSides(2);
      g('impDupDir').value = 'auto'; impSettingsChanged();
      const opts = currentImpOptions();
      const base = Object.assign({}, opts, { slug: null, stackNum: false, crop: false, cropDims: false, frame: false });
      const run = async (src, o) => { const res = await buildDup2upBytes(src, Object.assign({}, base, o));
        return { file: await window.electronAPI.writeTempFile(res.bytes, 'pdf'), dir: res.dir, sheets: res.sheets, gapMm: res.gapMm }; };
      const land4 = await mk(4, 210, 148), port4 = await mk(4, 148, 210), land2b = await mk(2, 210, 148, 1);
      const out = { rowShown, optDir: opts.dupDir, sheetMm: opts.sheet.map(v => +(v / MM).toFixed(1)) };
      out.auto  = await run(land4, { dupDir: 'auto' });
      out.autoP = await run(port4, { dupDir: 'auto' });
      out.forceH = await run(land4, { dupDir: 'h' });
      out.forceV = await run(port4, { dupDir: 'v' });
      out.bleed = await run(land2b, { dupDir: 'auto', crop: true });
      out.single = await run(land4, { dupDir: 'auto', sides: 1 });
      // 프리셋 왕복
      g('impDupDir').value = 'v'; impSettingsChanged();
      const seed = captureImpSeed('위아래');
      g('impDupDir').value = 'auto';
      applyProfileToUI(seed);
      out.seedDd = seed.dd; out.uiAfter = g('impDupDir').value; out.poDir = profileToOpts(seed).dupDir;
      _impEnabled = true; out.tag = impNameTag(); _impEnabled = false;
      return out;
    })()`);
    console.log('📖 복제 2부 — 위아래 배치');
    ok(r.rowShown, '복제 2부 모드에서 배치 선택 줄이 보인다');
    ok(r.optDir === 'auto', 'currentImpOptions.dupDir = auto');

    // 위아래: 세로 대지 219×312, 트림 210×148, 거터 2 → 위 칸 위끝 = (312-298)/2 = 7mm, 아래 칸 = 7+148+2 = 157mm, 좌우 = 4.5mm
    const V = (file, pageNo) => { const img = ppm(file, pageNo); return { w: img.w, h: img.h, top: readCell(img, 4.5, 7, 210, 148), bot: readCell(img, 4.5, 157, 210, 148) }; };
    const a1 = V(r.auto.file, 1), a2 = V(r.auto.file, 2), a3 = V(r.auto.file, 3);
    ok(r.auto.dir === 'v' && Math.abs(a1.w - 621) <= 1 && Math.abs(a1.h - 884) <= 1, `가로형 A5 + 219×312 → 자동 = 위아래 · 세로 대지 (${r.auto.dir} · ${a1.w}×${a1.h}px)`);
    ok(a1.top.page === 1 && a1.top.rot === 0 && a1.bot.page === 1 && a1.bot.rot === 180, '앞면: 위 = 1쪽 정방향 · 아래 = 1쪽 180° ' + JSON.stringify([a1.top, a1.bot]));
    ok(a2.top.page === 2 && a2.top.rot === 0 && a2.bot.page === 2 && a2.bot.rot === 180, '뒷면: 위 = 2쪽 정방향 · 아래 = 2쪽 180° (긴 쪽 넘김 → 위 칸 뒤 = 위 칸) ' + JSON.stringify([a2.top, a2.bot]));
    ok(a3.top.page === 3 && a3.bot.page === 3 && r.auto.sheets === 2, '둘째 시트 앞면 = 3쪽 · 시트 2장(4면)');
    ok(Math.abs(r.auto.gapMm - 2) < 0.01, '거터 = 입력값 2mm (' + r.auto.gapMm.toFixed(2) + ')');
    // 거터 실측: 세로 가운데 줄에서 위 칸 끝 ~ 아래 칸 시작
    {
      const img = ppm(r.auto.file, 1), x = Math.round(img.w / 2), MMP = 72 / 25.4;
      const red = y => { const o = (y * img.w + x) * 3; return img.d[o] > 30 && img.d[o + 1] < 60; };
      let y1 = -1, y2 = -1;
      for (let y = Math.round(140 * MMP); y < Math.round(170 * MMP); y++) { if (red(y) && !red(y + 1) && y1 < 0) y1 = y + 1; if (y1 > 0 && !red(y) && red(y + 1)) { y2 = y + 1; break; } }
      const gap = (y2 - y1) / MMP;
      ok(y1 > 0 && Math.abs(gap - 2) < 0.8, '렌더 실측 위아래 간격 ≈ 2mm (' + gap.toFixed(2) + 'mm)');
    }

    const p1 = ppm(r.autoP.file, 1);
    ok(r.autoP.dir === 'h' && p1.w > p1.h, `세로형 A5 + 219×312 → 자동 = 좌우 · 가로 대지(예전 그대로) (${r.autoP.dir} · ${p1.w}×${p1.h}px)`);
    {
      // 좌우: 가로 대지 312×219, 트림 148×210, 거터 2 → 왼쪽 칸 x = (312-298)/2 = 7, 오른쪽 = 157, 위 = 4.5
      const img2 = ppm(r.autoP.file, 2);
      const L = readCell(img2, 7, 4.5, 148, 210), R = readCell(img2, 157, 4.5, 148, 210);
      ok(L.page === 2 && L.rot === 180 && R.page === 2 && R.rot === 0, '좌우 뒷면은 예전 그대로: 왼쪽 2쪽 180° · 오른쪽 2쪽 정방향 ' + JSON.stringify([L, R]));
    }
    ok(r.forceH.dir === 'h' && r.forceV.dir === 'v', '좌우·위아래 강제 선택이 그대로 쓰인다');
    {
      // 블리드 1mm 원고(TrimBox): 트림은 같은 자리, 블리드는 거터 안으로 1mm씩 → 간격 2mm가 블리드로 꽉 찬다
      const img = ppm(r.bleed.file, 1), x = Math.round(img.w / 2), MMP = 72 / 25.4;
      let white = 0;
      for (let y = Math.round(155.2 * MMP); y <= Math.round(156.8 * MMP); y++) { const o = (y * img.w + x) * 3; if (img.d[o + 1] > 200) white++; }
      const top = readCell(img, 4.5, 7, 210, 148), bot = readCell(img, 4.5, 157, 210, 148);
      ok(r.bleed.dir === 'v' && white === 0 && top.rot === 0 && bot.rot === 180, '블리드 1mm 원고: 거터 2mm가 블리드로 채워짐(흰 틈 없음) · 트림 자리 그대로 ' + JSON.stringify({ white, top, bot }));
    }
    {
      const img = ppm(r.single.file, 2);
      const top = readCell(img, 4.5, 7, 210, 148), bot = readCell(img, 4.5, 157, 210, 148);
      ok(r.single.sheets === 4 && top.page === 2 && top.rot === 0 && bot.rot === 180, '단면: 쪽마다 1시트 · 위 정방향 · 아래 180°');
    }
    ok(r.seedDd === 'v' && r.uiAfter === 'v' && r.poDir === 'v', '프리셋 저장(dd)·불러오기·변환에 배치 방향이 남는다');
    ok(r.tag === '2up', '파일 이름표는 그대로 2up');
    for (const k of ['auto', 'autoP', 'forceH', 'forceV', 'bleed', 'single']) try { fs.unlinkSync(r[k].file); } catch (e) {}
  } catch (e) { fail++; console.error(e); }
  console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
  app.exit(fail ? 1 : 0);
});
