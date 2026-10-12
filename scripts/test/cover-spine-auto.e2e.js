// 📕 표지 책등 폭 자동 + 탭마다 따로 기억(임포징·블리드·폰트 안전화·표지) — 2026-10-12 사용자 요청
//   실행: npx electron scripts/test/cover-spine-auto.e2e.js   (창을 띄우지 않는다)
//   · 본문 쪽수 = 이 탭의 쪽 수 − 문서 안 표지 쪽(칸에 숫자로 채움), 지종을 고르면 책등 폭이 계산돼 채워진다
//   · 쪽을 지우면 다시 계산, 직접 적으면 그 값으로 생성(지종을 바꿔도 유지), 비우면 다시 자동
//   · 뒤표지 자동 생성이면 그 쪽은 본문(쪽수 +1)
//   · 탭마다: 블리드·폰트 안전화·표지 값이 다른 탭으로 따라가지 않고, 돌아오면 그대로 · 새 문서는 시작값
//   · 프리셋에는 자동인 칸이 빈칸 + auto 표식으로 저장된다(다른 문서에서 그 문서 쪽 수로 계산)
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-coverspine'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3 && !/No handler|Security/.test(m)) console.log('[앱오류]', m.slice(0, 300)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(80); } return false; };
    const g = id => document.getElementById(id);
    const type = (id, v) => { const el = g(id); el.value = v; el.dispatchEvent(new Event('input')); };
    const pickStock = i => { const el = g('coverStock'); el.selectedIndex = i; el.dispatchEvent(new Event('change')); };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const mk = async (name, n) => { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= n; i++) d.addPage([300, 420]).drawText(name + i, { x: 30, y: 300, size: 30, font: f, color: rgb(0, 0, 0) });
      const b = await d.save(); return { name: name + '.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }; };
    startLoad([await mk('A', 202), await mk('B', 98)]);
    await waitFor(() => tabs.size === 2 && [...tabs.values()].every(isTabReady), 240000);
    const [idA, idB] = [...tabs.keys()];
    activateTab(idA); await sleep(400);

    // ── 책등 자동 ──
    ck('본문 쪽수가 쪽 수 − 표지 2쪽으로 칸에 채워짐', g('coverBodyPages').value === '200', g('coverBodyPages').value);
    pickStock(1);   // 모조 80g 0.10mm
    const thick = parseFloat(g('coverThick').value);
    ck('지종을 고르면 책등 폭 자동 = ceil(200/2) × 두께', parseFloat(g('coverSpineMm').value) === coverSpineMm(200, thick, true), [g('coverSpineMm').value, thick]);
    ck('책등 안내가 같은 값', g('coverSpineInfo').textContent.includes('책등 ' + coverSpineMm(200, thick, true) + 'mm'), g('coverSpineInfo').textContent);
    deletePage(5); await sleep(600);
    ck('쪽을 지우면 본문 쪽수·책등 다시 계산', g('coverBodyPages').value === '199' && parseFloat(g('coverSpineMm').value) === coverSpineMm(199, thick, true), [g('coverBodyPages').value, g('coverSpineMm').value]);
    setCoverBackAuto('ai'); await sleep(100);
    ck('뒤표지 자동 생성이면 본문 +1', g('coverBodyPages').value === '200', g('coverBodyPages').value);
    setCoverBackAuto('none'); await sleep(100);
    type('coverSpineMm', '12.5');
    deletePage(5); await sleep(600);
    ck('직접 적은 책등 폭은 쪽이 바뀌어도 그대로', g('coverSpineMm').value === '12.5' && g('coverBodyPages').value === '198', [g('coverSpineMm').value, g('coverBodyPages').value]);
    ck('프리셋 저장: 자동 칸은 빈칸, 직접 칸은 값', (() => { const d = captureCoverState(); return d.auto.body && !d.auto.spine && d.v.coverBodyPages === '' && d.v.coverSpineMm === '12.5'; })(), captureCoverState().auto);
    type('coverSpineMm', '');
    ck('비우면 다시 자동', parseFloat(g('coverSpineMm').value) === coverSpineMm(198, thick, true), g('coverSpineMm').value);
    type('coverSpineMm', '9'); pickStock(3);   // 모조 120g
    const thick3 = parseFloat(g('coverThick').value);
    ck('직접 적은 책등 폭은 지종을 바꿔도 그대로', g('coverSpineMm').value === '9', [g('coverSpineMm').value, thick3]);
    // 생성도 직접 적은 값으로 — 스프레드 재단 폭 = 뒤표지 + 책등 + 앞표지 (생성 버튼과 같은 _coverInputs·조판 함수)
    {
      const c = _coverInputs();
      const sp = await buildCoverSpreadBytes(originalPdfBytes, { frontIdx: 0, backIdx: pageResults.filter(Boolean).length - 1, spineMm: c.spine, bleedMm: c.bleed, crop: c.crop, fold: c.fold, trimWmm: 0, trimHmm: 0 });
      const d = await PDFLib.PDFDocument.load(sp);
      const tb = d.getPage(0).node.lookup(PDFLib.PDFName.of('TrimBox')).asArray().map(x => x.asNumber());
      const mm = (tb[2] - tb[0]) * 25.4 / 72, trimW = 300 * 25.4 / 72;
      ck('생성한 스프레드의 책등 = 직접 적은 9mm', c.spine === 9 && Math.abs(mm - (trimW * 2 + 9)) < 0.05, [c.spine, +mm.toFixed(2), +(trimW * 2 + 9).toFixed(2)]);
    }
    type('coverSpineMm', ''); pickStock(3);
    ck('칸을 비우면 지종 기준 자동으로', parseFloat(g('coverSpineMm').value) === coverSpineMm(198, thick3, true), g('coverSpineMm').value);
    type('coverBodyPages', '100');
    ck('본문 쪽수를 직접 적으면 그 값으로 계산', parseFloat(g('coverSpineMm').value) === coverSpineMm(100, thick3, true), g('coverSpineMm').value);
    type('coverSpineText', 'A책 제목');

    // ── 탭마다 따로 ──
    setBleedEnabled(true); setOutlineEnabled(false); await sleep(200);
    activateTab(idB); await sleep(800);
    ck('B: 블리드 꺼짐(새 문서)', !_bleedEnabled && !g('bleedEnabled').checked);
    ck('B: 폰트 안전화 켜짐(완전 임베드)', _outlineEnabled && _outlineMode === 'embed' && g('esOutline').checked);
    ck('B: 본문 쪽수는 B의 쪽 수로 자동(96)', g('coverBodyPages').value === '96', g('coverBodyPages').value);
    ck('B: 책등 폭도 B 기준 자동 · 지종은 이어받음', parseFloat(g('coverSpineMm').value) === coverSpineMm(96, thick3, true) && g('coverThick').value === String(thick3), [g('coverSpineMm').value, g('coverThick').value]);
    ck('B: 책등 문구는 비어 있음(A 책의 값)', g('coverSpineText').value === '', g('coverSpineText').value);
    setOutlineMode('outline'); setOutlineEnabled(true); setOutlineMode('outline'); await sleep(100);
    activateTab(idA); await sleep(800);
    ck('A로 돌아오면 블리드 켜짐', _bleedEnabled && g('bleedEnabled').checked);
    ck('A로 돌아오면 폰트 안전화 꺼짐', !_outlineEnabled && !g('esOutline').checked);
    ck('A로 돌아오면 직접 적은 본문 쪽수·책등 문구 그대로', g('coverBodyPages').value === '100' && g('coverSpineText').value === 'A책 제목', [g('coverBodyPages').value, g('coverSpineText').value]);
    activateTab(idB); await sleep(800);
    ck('B로 다시 가면 B의 곡선 변환', _outlineEnabled && _outlineMode === 'outline');
    activateTab(idA); await sleep(500);
    return out;
  })()`);
  let fail = 0;
  res.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(m, n, m === '✔' ? '' : x); });
  console.log(`결과: ${res.length - fail} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
