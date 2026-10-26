// 🔀 임포징 셔플(반복 배치 옵션) — N부 전체를 PDF 하나로, 재단 후 더미를 차례로 겹치면 1부·2부… 순서대로
//   실행: npx electron scripts/test/imposition-shuffle.e2e.js   (창 없음 · Ghostscript 필요)
// 사용자 사례(2026-10-25): A6 33쪽 × 100부, 230×315 대지 → 2×2 = 4칸, 시트 825장.
// 확인: ① UI(반복 + 🔀 셔플 + 부수) → currentImpOptions.shuffleCopies ② 결과 시트 수·칸 배치
//      ③ 재단 → 더미 1 위에 2, 3, 4를 겹친 순서 = 1부 1~33쪽, 2부 1~33쪽 … (시트 출처 sheetSrc로)
//      ④ 나누어떨어지지 않으면 빈 칸은 마지막 더미 끝에만 ⑤ 프리셋 저장 → 불러오기 왕복 ⑥ 파일 이름표
//      ⑦ gs로 첫 시트 렌더(쪽 번호 4칸이 다른지 — 1·34·67·100번째 쪽이 아니라 S[j·M]이 맞는지)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-shuffle'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const MM = 72 / 25.4;
      const { PDFDocument, rgb, StandardFonts } = PDFLib;
      const mk = async n => {
        const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.HelveticaBold);
        for (let i = 0; i < n; i++) {
          const p = d.addPage([105 * MM, 148 * MM]);
          p.drawRectangle({ x: 0, y: 0, width: 105 * MM, height: 148 * MM, color: rgb(1, 1, 1) });
          p.drawText(String(i + 1), { x: 20, y: 150, size: 120, font: f, color: rgb(0, 0, 0) });
        }
        return d.save();
      };
      const g = id => document.getElementById(id);
      setImpMode('repeat');
      populatePaperSelect('__custom__'); g('bkPaper').value = '__custom__';
      g('impCustomW').value = 230; g('impCustomH').value = 315; onImpPaperChange();
      g('impMargin').value = 0; g('bkGutter').value = 0;
      g('repCols').value = ''; g('repRows').value = '';
      const rowShown = g('impShuffleRow').style.display !== 'none';
      const copiesDisabledBefore = g('repCopies').disabled;
      g('repShuffle').checked = true; syncRepShuffleUI();
      g('repCopies').value = 100; impSettingsChanged();
      const opts = currentImpOptions();
      const stackShown = g('impStackWrap').style.display !== 'none';
      const src = await mk(33);
      const t0 = performance.now();
      const res = await buildStepRepeatBytes(src, Object.assign({}, opts, { slug: null, stackNum: false }));
      const ms = Math.round(performance.now() - t0);
      _impEnabled = true; const tag = impNameTag(); _impEnabled = false;
      // 프리셋 왕복: 저장 → UI 흐트러뜨림 → 불러오기
      const seed = captureImpSeed('셔플시험');
      g('repShuffle').checked = false; g('repCopies').value = 1; syncRepShuffleUI();
      applyProfileToUI(seed);
      const ui = { on: g('repShuffle').checked, n: g('repCopies').value, dis: g('repCopies').disabled };
      const po = profileToOpts(seed);
      // 7부(33×7=231, 4칸 → 58시트, 빈 칸 1)
      const res7 = await buildStepRepeatBytes(src, Object.assign({}, opts, { shuffleCopies: 7, slug: null, stackNum: false }));
      // 셔플 끔 → 기존 반복 배치(쪽마다 1시트)
      const resOff = await buildStepRepeatBytes(src, Object.assign({}, opts, { shuffleCopies: 0, slug: null, stackNum: false }));
      const file = await window.electronAPI.writeTempFile(res.bytes, 'pdf');
      return { rowShown, copiesDisabledBefore, stackShown, shuffleCopies: opts.shuffleCopies, sheets: res.sheets, grid: res.grid,
        sheetSrc: res.sheetSrc, total: res.total, sf: res.shuffle, ms, tag, seed, po: { sc: po.shuffleCopies, cols: po.cols },
        s7: { sheets: res7.sheets, src: res7.sheetSrc, blanks: res7.shuffle.blanks }, offSheets: resOff.sheets, offShuffle: !!resOff.shuffle,
        size: res.bytes.length, file, ui };
    })()`);
    console.log('🔀 셔플 — A6 33쪽 × 100부, 230×315');
    ok(r.rowShown, '반복 모드에서 🔀 셔플 줄이 보인다');
    ok(r.copiesDisabledBefore, '셔플을 켜기 전에는 부수 칸이 꺼져 있다');
    ok(r.stackShown, '셔플을 켜면 ① 묶음번호가 보인다');
    ok(r.shuffleCopies === 100, 'currentImpOptions.shuffleCopies = 100 (' + r.shuffleCopies + ')');
    ok(r.grid && r.grid.cols * r.grid.rows === 4, '시트당 4칸 (' + JSON.stringify(r.grid) + ')');
    ok(r.sheets === 825 && r.sheetSrc.length === 825, '시트 825장 (' + r.sheets + ')');
    ok(r.total === 3300 && r.sf.blanks === 0, '총 3,300쪽 · 빈 칸 0');
    const seqOf = (srcs, per) => { const q = []; for (let j = 0; j < per; j++) for (let s = 0; s < srcs.length; s++) q.push(srcs[s][j]); return q; };
    // sheetSrc[s]는 칸 순서대로 출처 쪽(0부터) — 빈 칸은 기록이 없어 길이가 짧다
    const want = n => { const a = []; for (let c = 0; c < n; c++) for (let p = 0; p < 33; p++) a.push(p); return a; };
    const seq = seqOf(r.sheetSrc, 4);
    ok(JSON.stringify(seq) === JSON.stringify(want(100)), '재단 → 더미 1·2·3·4 겹친 순서 = 1부 1~33쪽 … 100부 1~33쪽');
    ok(JSON.stringify(r.sheetSrc[0]) === JSON.stringify([0, 825 % 33, 1650 % 33, 2475 % 33]), '첫 시트 = S[0]·S[825]·S[1650]·S[2475] (' + JSON.stringify(r.sheetSrc[0]) + ')');
    console.log('    조립 ' + r.ms + 'ms · ' + (r.size / 1048576).toFixed(1) + 'MB');
    ok(r.s7.sheets === 58 && r.s7.blanks === 1, '7부: 시트 58장 · 빈 칸 1');
    const seq7 = seqOf(r.s7.src, 4).filter(x => x !== undefined);
    ok(JSON.stringify(seq7) === JSON.stringify(want(7)), '7부: 겹친 순서 그대로');
    ok(r.s7.src[57].length === 3, '7부: 빈 칸은 마지막 시트의 마지막 더미에만');
    ok(r.offSheets === 33 && !r.offShuffle, '셔플 끄면 기존 반복 배치(쪽마다 1시트)');
    ok(r.tag === '셔플100부', '파일 이름표 = 셔플100부 (' + r.tag + ')');
    ok(r.ui.on && r.ui.n === '100' && !r.ui.dis, '프리셋 불러오기 → 🔀 셔플 켬·100부 복원 (' + JSON.stringify(r.ui) + ')');
    ok(r.seed.rs === 100 && r.po.sc === 100, '프리셋 저장·변환에 부수가 남는다');
    // gs 첫 시트 렌더(눈 확인용 PNG)
    const png = path.join(os.tmpdir(), 'pdfedit-shuffle-sheet1.png');
    try {
      execFileSync('gswin64c', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', '-r40', '-dFirstPage=1', '-dLastPage=1', '-o', png, r.file]);
      ok(fs.existsSync(png), 'gs 첫 시트 렌더 → ' + png);
    } catch (e) { ok(false, 'gs 렌더 실패: ' + e.message); }
    try { fs.unlinkSync(r.file); } catch (e) {}

    // ── 양면 셔플: 쪽마다 다른 빨강 농도로 칠한 원고 → gs로 칸 가운데 화소를 읽어 어느 쪽이 앉았는지 ──
    console.log('\n🔀 양면 셔플 — 뒷면 칸 = 넘김 방향 거울');
    const d = await win.webContents.executeJavaScript(`(async () => {
      const MM = 72 / 25.4;
      const { PDFDocument, rgb } = PDFLib;
      const mk = async n => {
        const doc = await PDFDocument.create();
        for (let i = 0; i < n; i++) doc.addPage([105 * MM, 148 * MM]).drawRectangle({ x: 0, y: 0, width: 105 * MM, height: 148 * MM, color: rgb((20 + (i % 9) * 25) / 255, 0, 0) });
        return doc.save();
      };
      const g = id => document.getElementById(id);
      g('repShuffleSides').value = 'long'; impSettingsChanged();
      const opts = currentImpOptions();
      const base = Object.assign({}, opts, { slug: null, stackNum: false, crop: false, margin: 0, gutter: 0, hgap: null, vgap: null });
      const out = { uiDuplex: opts.shuffleDuplex, dis: g('repShuffleSides').disabled };
      _impEnabled = true; out.tag = impNameTag(); _impEnabled = false;
      out.seedRd = captureImpSeed('양면').rd;
      const src8 = await mk(8), src6 = await mk(6), src7 = await mk(7);
      const run = async (src, o) => { const res = await buildStepRepeatBytes(src, Object.assign({}, base, o));
        return { file: await window.electronAPI.writeTempFile(res.bytes, 'pdf'), sheets: res.sheets, grid: res.grid, sf: res.shuffle, src: res.sheetSrc }; };
      out.A = await run(src8, { shuffleCopies: 1, shuffleDuplex: 'long', cols: 0, rows: 0 });
      out.B = await run(src8, { shuffleCopies: 1, shuffleDuplex: 'short', cols: 0, rows: 0 });
      out.C = await run(src6, { shuffleCopies: 1, shuffleDuplex: 'long', cols: 3, rows: 1 });
      out.D = await run(src6, { shuffleCopies: 1, shuffleDuplex: 'short', cols: 3, rows: 1 });
      out.E = await run(src7, { shuffleCopies: 1, shuffleDuplex: 'long', cols: 0, rows: 0 });
      const big = await buildStepRepeatBytes(await mk(33), Object.assign({}, base, { shuffleCopies: 100, shuffleDuplex: 'long', cols: 0, rows: 0 }));
      out.big = { sheets: big.sheets, pages: big.sheetSrc.length, src: big.sheetSrc, leaves: big.shuffle.leaves };
      g('repShuffleSides').value = ''; g('repShuffle').checked = false; syncRepShuffleUI();
      out.disOff = g('repShuffleSides').disabled;
      return out;
    })()`);
    // 72dpi ppm → 칸(가로 먼저) 가운데 화소의 빨강으로 쪽 번호(1부터, 0 = 빈 칸)
    const readSlots = (file, pageNo, cols, rows) => {
      const ppm = file.replace(/\.pdf$/, '_' + pageNo + '.ppm');
      execFileSync('gswin64c', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', '-r72', '-dFirstPage=' + pageNo, '-dLastPage=' + pageNo, '-o', ppm, file]);
      const b = fs.readFileSync(ppm); let i = 0; const tok = [];
      while (tok.length < 4) { while (b[i] === 35) { while (b[i] !== 10) i++; i++; } const st = i; while (b[i] > 32) i++; tok.push(b.slice(st, i).toString()); i++; }
      const w = +tok[1], h = +tok[2], data = b.slice(b.length - w * h * 3);
      try { fs.unlinkSync(ppm); } catch (e) {}
      const MMP = 72 / 25.4, cw = 105 * MMP, ch = 148 * MMP, ox = (w - cols * cw) / 2, oy = (h - rows * ch) / 2, res = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = Math.round(ox + (c + 0.5) * cw), y = Math.round(oy + (r + 0.5) * ch), o = (y * w + x) * 3;
        res.push(data[o + 1] > 200 ? 0 : Math.round((data[o] - 20) / 25) + 1);
      }
      return res;
    };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok(d.uiDuplex === 'long' && !d.dis, '셔플 켬 → 인쇄 면 선택 가능 · currentImpOptions.shuffleDuplex = long');
    ok(d.disOff, '셔플 끄면 인쇄 면 선택도 꺼진다');
    ok(d.tag === '셔플100부양면' && d.seedRd === 'long', '이름표 = 셔플100부양면 · 프리셋에 rd 저장 (' + d.tag + ')');
    const chk = (k, label, cols, rows, front, back) => {
      const c = d[k];
      const f = readSlots(c.file, 1, cols, rows), bk = readSlots(c.file, 2, cols, rows);
      ok(c.sheets === 1 && c.grid.cols === cols && c.grid.rows === rows && same(f, front) && same(bk, back),
        `${label}: 앞 ${JSON.stringify(f)} · 뒤 ${JSON.stringify(bk)} (기대 ${JSON.stringify(front)} · ${JSON.stringify(back)})`);
      try { fs.unlinkSync(c.file); } catch (e) {}
    };
    chk('A', '8쪽 2×2 세로 대지 · 긴 쪽 넘김(좌우 거울)', 2, 2, [1, 3, 5, 7], [4, 2, 8, 6]);
    chk('B', '8쪽 2×2 세로 대지 · 짧은 쪽 넘김(위아래 거울)', 2, 2, [1, 3, 5, 7], [6, 8, 2, 4]);
    chk('C', '6쪽 3×1 가로 대지 · 긴 쪽 넘김(위아래 거울 = 1줄이라 그대로)', 3, 1, [1, 3, 5], [2, 4, 6]);
    chk('D', '6쪽 3×1 가로 대지 · 짧은 쪽 넘김(좌우 거울)', 3, 1, [1, 3, 5], [6, 4, 2]);
    chk('E', '7쪽(홀수) 2×2 · 긴 쪽 넘김 — 마지막 장 뒷면 빈 칸', 2, 2, [1, 3, 5, 7], [4, 2, 0, 6]);
    // 33쪽 × 100부 양면: 1부 = 17장, 1,700장 ÷ 4칸 = 425시트 = PDF 850쪽, 더미를 겹치면 앞면 = 1·3·…·33쪽이 100번
    const bg = d.big;
    ok(bg.leaves === 17 && bg.sheets === 425 && bg.pages === 850, `33쪽 × 100부 양면: 낱장 17장/부 · 시트 425장 · PDF 850쪽 (${bg.sheets} · ${bg.pages})`);
    const fronts = []; for (let j = 0; j < 4; j++) for (let s = 0; s < 425; s++) fronts.push(bg.src[s * 2][j]);
    const wantF = []; for (let c = 0; c < 100; c++) for (let l = 0; l < 17; l++) wantF.push(l * 2);
    ok(same(fronts, wantF), '양면: 더미 1~4를 겹친 낱장 순서 = 1부 1~17장 … 100부 1~17장');
    const backs = bg.src.filter((_, k) => k % 2).reduce((a, x) => a + x.length, 0);
    ok(backs === 1600, '양면: 뒷면 쪽 1,600개(부마다 마지막 장 뒷면은 비움) (' + backs + ')');
  } catch (e) { fail++; console.error(e); }
  console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
  app.exit(fail ? 1 : 0);
});
