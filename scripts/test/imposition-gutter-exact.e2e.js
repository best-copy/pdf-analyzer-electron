// ↔ 임포징 거터 = 입력값 그대로 (모아찍기·반반·복제 2부) + 이중 코너(돔보) 재단선
//   실행: npx electron scripts/test/imposition-gutter-exact.e2e.js   (창 없음 · Ghostscript 필요)
// 회귀(사용자 제보 2026-09-29, 복제 2부):
//   · 복제 2부는 원고를 대지 '반쪽 가운데'에 앉혀 거터 0이어도 사이가 떴고, 거터를 올려도 그만큼 벌어지지 않았다
//   · 100% 원본에서 거터가 대지 여유보다 크면 칸이 원고보다 작아져, 간격이 입력의 절반만 늘고 원고끼리 겹쳤다
//   이제 원고 사이(재단 기준) = 거터 그대로, 대지 좌우 = 남는 폭(모자라면 대지 밖으로 밀려남).
//   재단선 켬/끔은 배치에 영향이 없어야 한다.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-gutterexact'));

// 72dpi 렌더 → 세로 가운데 가로줄에서 칠해진(파랑) 구간(mm)
function runsOf(file) {
  const out = file.replace(/\.pdf$/, '.ppm');
  execFileSync('gswin64c', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', '-r144', '-dFirstPage=1', '-dLastPage=1', '-o', out, file]);
  const b = fs.readFileSync(out); let i = 0; const tok = [];
  while (tok.length < 4) { while (b[i] === 35) { while (b[i] !== 10) i++; i++; } const st = i; while (b[i] > 32) i++; tok.push(b.slice(st, i).toString()); i++; }
  const w = +tok[1], h = +tok[2], data = b.slice(b.length - w * h * 3);
  const y = (h / 2) | 0, runs = []; let on = false, st = 0;
  for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3, blue = data[o + 2] > 150 && data[o] < 120;
    if (blue && !on) { on = true; st = x; } if (!blue && on) { on = false; runs.push([st, x]); }
  }
  if (on) runs.push([st, w]);
  try { fs.unlinkSync(out); fs.unlinkSync(file); } catch (e) {}
  const mm = v => v * 25.4 / 144;
  return { W: mm(w), runs: runs.map(r => [mm(r[0]), mm(r[1])]) };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const cases = await win.webContents.executeJavaScript(`(async () => {
    const MM = 72 / 25.4;
    const { PDFDocument, rgb } = PDFLib;
    const d = await PDFDocument.create();
    for (let i = 0; i < 4; i++) d.addPage([210 * MM, 297 * MM]).drawRectangle({ x: 0, y: 0, width: 210 * MM, height: 297 * MM, color: rgb(0.2, 0.3, 0.8) });
    const src = await d.save();
    const out = [];
    const SHEET = [460 * MM, 320 * MM];   // A4 2장 + 여유 40mm
    for (const mode of ['nup', 'cutstack', 'dup'])
      for (const crop of [false, true])
        for (const g of [0, 10, 34, 50]) {
          const opts = Object.assign({}, currentImpOptions(), {
            mode, sheet: SHEET, gutter: g, hgap: null, vgap: null, margin: 0, crop, bleed: 0, srcBleed: 0,
            frame: false, slug: null, stackNum: false, cropDims: false,
            cropStyle: { shape: 'double', gap: 3, len: 4, th: 0.4 },
            place: { scale: 'orig', align: 'cc' }, across: 2, down: 1, sides: mode === 'dup' ? 2 : 1,
            order: mode === 'cutstack' ? 'cutstack' : 'sequential' });
          const build = mode === 'dup' ? buildDup2upBytes : buildNupBytes;
          const res = await build(src, opts);
          out.push({ mode, crop, g, file: await window.electronAPI.writeTempFile(res.bytes, 'pdf') });
        }
    // ↔ 양끝 맞춤: 원고를 대지 좌우 끝(여백 위치)에 붙이고 가운데 간격은 자동 — 거터 입력(99)은 무시
    // 끝 여백(justifyEdge)은 일반 여백(margin=7)과 따로 — 좌우 끝만 정한다. 5mm 초과는 5로.
    for (const mode of ['nup', 'dup'])
      for (const m of [0, 3, 5, 9]) {
        const opts = Object.assign({}, currentImpOptions(), {
          mode, sheet: SHEET, gutter: 99, hgap: null, vgap: null, margin: 7, justifyX: true, justifyEdge: m, crop: true, bleed: 0, srcBleed: 0,
          frame: false, slug: null, stackNum: false, cropDims: false,
          cropStyle: { shape: 'double', gap: 3, len: 4, th: 0.4 },
          place: { scale: 'orig', align: 'cc' }, across: 2, down: 1, sides: mode === 'dup' ? 2 : 1, order: 'sequential' });
        const res = await (mode === 'dup' ? buildDup2upBytes : buildNupBytes)(src, opts);
        out.push({ mode: 'justify-' + mode, crop: true, g: m, gapMm: res.gapMm, file: await window.electronAPI.writeTempFile(res.bytes, 'pdf') });
      }
    // 칸 맞춤(fit)도 거터 그대로 — 원고가 줄어들 뿐 사이는 입력값
    for (const g of [0, 20]) {
      const opts = Object.assign({}, currentImpOptions(), {
        mode: 'dup', sheet: SHEET, gutter: g, hgap: null, vgap: null, margin: 0, crop: false, bleed: 0, srcBleed: 0,
        frame: false, slug: null, stackNum: false, cropDims: false,
        place: { scale: 'fit', align: 'cc' }, sides: 2 });
      const res = await buildDup2upBytes(src, opts);
      out.push({ mode: 'dup-fit', crop: false, g, file: await window.electronAPI.writeTempFile(res.bytes, 'pdf') });
    }
    return out;
  })()`);

  const out = [];
  const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
  const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.6);
  const byKey = {};
  for (const c of cases) {
    const m = runsOf(c.file);
    byKey[c.mode + '|' + c.crop + '|' + c.g] = m;
    const r = m.runs;
    if (c.mode.startsWith('justify-')) {
      const m0 = Math.min(5, c.g), want = 460 - 420 - 2 * m0;   // 끝 여백 m(최대 5) → 좌우 m, 가운데 = 남는 폭
      const gap = r.length >= 2 ? r[1][0] - r[0][1] : -1;
      const left = r.length ? r[0][0] : -1, right = r.length ? m.W - r[r.length - 1][1] : -1;
      ck(`↔ 양끝 맞춤 ${c.mode.slice(8) === 'dup' ? '복제 2부' : '모아찍기'} · 끝 여백 ${c.g} → 좌우 ${m0}mm · 가운데 ${want}mm(자동)`,
         near(left, m0) && near(right, m0) && near(gap, want) && near(c.gapMm, want, 0.05),
         { 왼쪽: +left.toFixed(1), 오른쪽: +right.toFixed(1), 가운데: +gap.toFixed(1), 알린값: +(+c.gapMm).toFixed(2) });
      continue;
    }
    if (c.mode === 'dup-fit') {
      const gap = c.g === 0 ? 0 : (r.length >= 2 ? r[1][0] - r[0][1] : -1);
      ck(`복제 2부 칸 맞춤 · 거터 ${c.g} → 사이 ${c.g}mm`, c.g === 0 ? r.length === 1 : near(gap, c.g), r.map(x => x.map(v => +v.toFixed(1))));
      continue;
    }
    const name = { nup: '모아찍기', cutstack: '반반', dup: '복제 2부' }[c.mode] + (c.crop ? '·재단선' : '');
    if (c.g === 0) {   // 맞닿는다 → 한 덩어리 420mm, 대지 좌우 20mm씩
      ck(`${name} · 거터 0 → 맞닿음(좌우 20mm)`, r.length === 1 && near(r[0][0], 20) && near(m.W - r[0][1], 20),
         r.map(x => x.map(v => +v.toFixed(1))));
      continue;
    }
    const gap = r.length >= 2 ? r[1][0] - r[0][1] : -1;
    const left = r.length ? r[0][0] : -1, right = r.length ? m.W - r[r.length - 1][1] : -1;
    const wantSide = Math.max(0, (460 - 420 - c.g) / 2);
    ck(`${name} · 거터 ${c.g} → 사이 ${c.g}mm · 좌우 ${wantSide}mm`, near(gap, c.g) && near(left, wantSide) && near(right, wantSide),
       { 사이: +gap.toFixed(1), 왼쪽: +left.toFixed(1), 오른쪽: +right.toFixed(1) });
  }
  // 재단선 켬/끔이 배치를 바꾸지 않는다
  for (const mode of ['nup', 'cutstack', 'dup'])
    for (const g of [10, 50]) {
      const a = byKey[mode + '|false|' + g], b = byKey[mode + '|true|' + g];
      ck(`${mode} 거터 ${g}: 재단선 켬/끔 배치 동일`, JSON.stringify(a.runs.map(x => x.map(v => v.toFixed(1)))) === JSON.stringify(b.runs.map(x => x.map(v => v.toFixed(1)))));
    }

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
