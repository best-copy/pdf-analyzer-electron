// ⚫ 검정 K100 — 앱 흐름(점검 미리보기 창 · 개체별 선택·해제 · 다운로드 파일 · 프리플라이트 · 상태 저장) · 2026-10-20
//   실행: npx electron scripts/test/rich-black-app.e2e.js   (창을 띄우지 않는다 — show:false · gs 필요)
// 확인: 🔍 검정 점검 → 미리보기 창(쪽 목록·개체 목록) · 미리보기 그림 위 개체 상자 자리 · 상자 클릭 = 선택·해제 ·
//       전체화면·Ctrl+휠·Ctrl + + / − / 0(메인 단축키 구간 그대로)·Space 이동 ·
//       글자만 빼고 [바꾸기] → 같은 창에서 바뀐 결과(고를 것 없음·상자 없음·되돌리기) → 닫으면 메인 썸네일 바뀜 ·
//       다시 점검하면 남은 글자만 · 내부 편집기 저장 뒤에도 K100 유지 · ⇩ 다운로드 파일: 면 C0 M0 Y0 K100 · 글자 그대로 · 빨강 그대로 ·
//       🖤 RGB검정 리치블랙처리(기본 꺼짐 — 켜고 검사): 컬러 쪽 RGB 검정 면 → C40 M30 Y30 K100 · 흑백 쪽은 먹 1도 ·
//       ↺ 되돌리기 · 🧪 프리플라이트 '혼합 검정'(CMYK)·'RGB 검정' · 프리셋 proc.k100 · 새 탭은 꺼짐
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

function findGs() {
  for (const d of ['D:/Ghostscript', 'C:/Program Files/gs']) {
    try { for (const v of fs.readdirSync(d).sort().reverse()) { const p = path.join(d, v, 'bin', 'gswin64c.exe'); if (fs.existsSync(p)) return p; } } catch (e) {}
  }
  return 'gswin64c';
}
const GS = findGs();
app.commandLine.appendSwitch('disable-gpu');
const USERDATA = path.join(os.tmpdir(), 'pdfedit-e2e-richblack-' + process.pid);   // 실행마다 새로 — 앞 실행의 '지난 작업' 안내가 끼어들지 않게
app.setPath('userData', USERDATA);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_rbapp_'));
let saveN = 0;
ipcMain.handle('dialog:saveFilePath', () => path.join(outDir, `save${++saveN}.pdf`));

const out = [];
const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);

// tiffsep 판(압축 없음) — 사각 영역 평균 잉크 %
function plates(file, page, x0, y0, x1, y1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbsep_'));
  try {
    execFileSync(GS, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=tiffsep', '-sCompression=none', '-r36', `-dFirstPage=${page}`, `-dLastPage=${page}`, '-o', path.join(dir, 'p.tif'), file]);
    return ['Cyan', 'Magenta', 'Yellow', 'Black'].map(pl => {
      const f = fs.readdirSync(dir).find(n => n.includes(`(${pl})`));
      const b = fs.readFileSync(path.join(dir, f));
      const le = b[0] === 0x49, r16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o), r32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
      const ifd = r32(4), cnt = r16(ifd); let W = 0, off = 0;
      for (let k = 0; k < cnt; k++) { const e = ifd + 2 + k * 12, tag = r16(e), typ = r16(e + 2), val = typ === 3 ? r16(e + 8) : r32(e + 8);
        if (tag === 256) W = val; else if (tag === 273) off = r32(e + 4) === 1 ? val : r32(val); }
      let s = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += 255 - b[off + y * W + x]; n++; }
      return Math.round(s / n / 255 * 100);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const px = v => Math.round(v / 2), box = (x0, y0, x1, y1) => [px(x0) + 3, px(400 - y1) + 3, px(x1) - 3, px(400 - y0) - 3];

// 검사 스크립트 오류가 사용자 화면에 Electron 오류 창으로 뜨지 않게 — 기록만 하고 끝낸다
process.on('uncaughtException', e => { console.log('✘ 검사 스크립트 오류', e && e.stack || e); app.exit(1); });
// main.js의 확대 단축키 구간(_zoomCaptured ~ installZoomShortcuts)을 그대로 싣는다
{
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split(String.fromCharCode(13)).join('');
  const a = src.indexOf('const _zoomCaptured'), b = src.indexOf('\n}\n', src.indexOf('function installZoomShortcuts')) + 3;
  if (a < 0 || b < 3) throw new Error('main.js 확대 단축키 구간을 찾지 못함');
  global.__installZoom = new Function('ipcMain', src.slice(a, b).replace(/\r/g, '') + '\nreturn installZoomShortcuts;')(ipcMain);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 950,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3 && !/No handler|Security|outlineFonts|프리웜/.test(m)) console.log('[앱오류]', m.slice(0, 300)); });
  global.__installZoom(win);
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const ctrlKey = async (k) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] }); await new Promise(r => setTimeout(r, 120)); };
  const js = (code) => win.webContents.executeJavaScript(`(async () => { const sleep = ms => new Promise(r => setTimeout(r, ms)); ${code}\n})()`);
  const openDlg = (o) => js(`runRichBlackCheck(${o ? JSON.stringify(o) : ''}); const t = Date.now();
      while (!(document.querySelector('.rbv-modal') && document.getElementById('rbLoading') && document.getElementById('rbLoading').style.display === 'none') && Date.now() - t < 30000) await sleep(50);
      await sleep(100);`);
  try {
    // 3쪽(400pt): 1쪽 = 혼합 검정 면(왼쪽 위)+빨강 면(오른쪽 위)+혼합 검정 큰 글자(아래) · 2쪽 = RGB 검정 선(흑백 쪽) · 3쪽 = K100뿐
    const r0 = await js(`
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(50); } return false; };
      window.confirm = () => true;
      const { PDFDocument, PDFName, StandardFonts } = PDFLib;
      const d = await PDFDocument.create(); const ctx = d.context;
      const f = await d.embedFont(StandardFonts.HelveticaBold);
      const mk = c => { const p = d.addPage([400, 400]); p.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref } })); p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(c))); };
      mk('q 0.75 0.68 0.67 0.9 k 20 220 160 160 re f Q q 0 1 1 0 k 220 220 160 160 re f Q BT /F1 90 Tf 0.75 0.68 0.67 0.9 k 30 60 Td (MMM) Tj ET q 0 0 0 rg 300 10 90 40 re f Q');
      mk('q 0 0 0 RG 6 w 20 200 m 380 200 l S Q');
      mk('q 0 0 0 1 k 20 20 100 100 re f Q');
      const b = await d.save();
      startLoad([{ name: '검정.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
      await waitFor(() => pageResults.length === 3 && isTabReady(tabs.get(activeTabId)));
      setOutlineEnabled(false);   // 하네스에는 Ghostscript IPC가 없다(gs 뒤 K100 유지는 rich-black.test.js가 확인)
      return { k100: _k100Enabled, btn: !!document.getElementById('k100CheckBtn') };`);
    ck('새 문서는 K100 꺼짐 · 왼쪽 패널에 점검 버튼', r0.k100 === false && r0.btn, r0);

    // 🔍 점검 미리보기 창
    await openDlg();
    const d1 = await js(`
      const m = document.querySelector('.rbv-modal');
      if (!m) return { err: '창 없음', body: document.querySelector('.merge-modal') ? document.querySelector('.merge-modal').textContent.slice(0, 200) : '' };
      const heads = [...m.querySelectorAll('.rbv-pghead')].map(h => h.textContent.replace(/\\s+/g, ' ').trim());
      const items = [...m.querySelectorAll('.rbv-item')].map(l => ({ key: l.dataset.key, text: l.textContent.trim(), on: l.querySelector('input').checked }));
      return { sub: m.querySelector('.merge-sub').textContent, heads, items, apply: document.getElementById('rbApply').textContent, lbl: document.getElementById('rbPageLbl').textContent,
               canvasW: document.getElementById('rbCanvas').width, hidden: document.getElementById('rbHidden').textContent };`);
    if (d1.err) throw new Error(d1.err + ' ' + d1.body);
    ck('창: 쪽 목록 1(1쪽 — 흑백 쪽은 먹 1도로 나가 목록에 없음)', d1.heads.length === 1 && /^1쪽/.test(d1.heads[0]), d1.heads);
    ck('창: 1쪽 개체 2(면·글자) 모두 선택', d1.items.length === 2 && /^면 1/.test(d1.items[0].text) && /^글자 2/.test(d1.items[1].text) && d1.items.every(i => i.on), d1.items);
    ck('창: 미리보기 그림이 그려짐 · 숨은 개체 없음', d1.canvasW > 300 && !d1.hidden, d1);
    ck('창: [선택한 2곳 K100으로 바꾸기]', /선택한 2곳/.test(d1.apply), d1.apply);
    // 미리보기 상자 자리 — 겹침 캔버스의 화소로(면 = 왼쪽 위, 글자 = 아래, 빨강 = 없음)
    const geo = await js(`
      const bs = [...document.querySelectorAll('#rbBoxes .rbv-box')].map(d => ({ x: parseFloat(d.style.left) / 100, y: parseFloat(d.style.top) / 100, w: parseFloat(d.style.width) / 100, h: parseFloat(d.style.height) / 100 }));
      const hit = (fx, fy) => bs.some(b => fx >= b.x && fx <= b.x + b.w && fy >= b.y && fy <= b.y + b.h);
      return { rectInside: hit(0.25, 0.25), redArea: hit(0.75, 0.25), textArea: hit(0.2, 0.78), n: bs.length };`);
    ck('미리보기: 혼합 검정 면 자리에 상자', geo.rectInside, geo);
    ck('미리보기: 빨강 면에는 상자 없음', !geo.redArea, geo);
    ck('미리보기: 글자 자리에 상자', geo.textArea, geo);
    // 상자 클릭 = 선택 해제(면) → 다시 클릭 = 선택
    const clk = await js(`
      const o = document.getElementById('rbStage'), rc = o.getBoundingClientRect();
      const fire = (fx, fy) => o.dispatchEvent(new MouseEvent('click', { clientX: rc.left + rc.width * fx, clientY: rc.top + rc.height * fy, bubbles: true }));
      fire(0.25, 0.25); await sleep(50);
      const a = [...document.querySelectorAll('.rbv-item input')].map(c => c.checked);
      fire(0.25, 0.25); await sleep(50);
      const b = [...document.querySelectorAll('.rbv-item input')].map(c => c.checked);
      return { a, b, rc: [rc.width, rc.height] };`);
    ck('상자 클릭 → 그 개체만 해제, 다시 클릭 → 선택', JSON.stringify(clk.a) === '[false,true]' && JSON.stringify(clk.b) === '[true,true]', clk);
    // ⛶ 전체화면 · Ctrl+휠 확대 · Space+끌기 이동
    const zp = await js(`
      const m = document.querySelector('.rbv-modal'), w0 = m.getBoundingClientRect().width;
      document.getElementById('rbFull').click(); await sleep(150);
      const full = { cls: m.classList.contains('rbv-full'), w: m.getBoundingClientRect().width, win: innerWidth };
      const wrap = document.getElementById('rbWrap'), stage = document.getElementById('rbStage'), sw0 = stage.offsetWidth;
      const rc = wrap.getBoundingClientRect();
      for (let i = 0; i < 4; i++) wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: rc.left + rc.width * 0.3, clientY: rc.top + rc.height * 0.3, bubbles: true, cancelable: true }));
      await sleep(600);
      const zoomed = { pct: document.getElementById('rbZoomPct').textContent, sw: stage.offsetWidth, cvw: document.getElementById('rbCanvas').width, canScroll: wrap.scrollWidth > wrap.clientWidth };
      // Space 누른 채 끌기
      const sl0 = wrap.scrollLeft, st0 = wrap.scrollTop;
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
      const before = [...document.querySelectorAll('.rbv-item input')].map(c => c.checked);
      wrap.dispatchEvent(new MouseEvent('mousedown', { clientX: rc.left + 300, clientY: rc.top + 300, button: 0, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: rc.left + 200, clientY: rc.top + 220, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      stage.dispatchEvent(new MouseEvent('click', { clientX: rc.left + 200, clientY: rc.top + 220, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
      const panned = { dx: wrap.scrollLeft - sl0, dy: wrap.scrollTop - st0, same: JSON.stringify(before) === JSON.stringify([...document.querySelectorAll('.rbv-item input')].map(c => c.checked)) };
      document.getElementById('rbZoomFit').click(); await sleep(50);
      const fit = document.getElementById('rbZoomPct').textContent;
      document.getElementById('rbFull').click(); await sleep(100);
      return { w0, full, sw0, zoomed, panned, fit, back: !m.classList.contains('rbv-full') };`);
    ck('⛶ 전체화면 → 창이 화면 폭 전체 · 다시 누르면 원래대로', zp.full.cls && zp.full.w >= zp.full.win - 2 && zp.full.w > zp.w0 && zp.back, zp);
    ck('Ctrl+휠 위 4번 → 244% · 그림이 커지고 스크롤 생김', zp.zoomed.pct === '244%' && zp.zoomed.sw > zp.sw0 * 2.2 && zp.zoomed.canScroll, zp.zoomed);
    ck('확대하면 그림을 더 크게 다시 그림(선명하게)', zp.zoomed.cvw > 1200, zp.zoomed.cvw);
    ck('Space+끌기 → 화면 이동(오른쪽·아래로 100·80) · 선택은 그대로', zp.panned.dx === 100 && zp.panned.dy === 80 && zp.panned.same, zp.panned);
    ck('[맞춤] → 100%', zp.fit === '100%', zp.fit);
    const z0 = win.webContents.getZoomLevel();
    await ctrlKey('='); await ctrlKey('=');
    const zk1 = await js(`return document.getElementById('rbZoomPct').textContent;`);
    await ctrlKey('-');
    const zk2 = await js(`return document.getElementById('rbZoomPct').textContent;`);
    await ctrlKey('0');
    const zk3 = await js(`return document.getElementById('rbZoomPct').textContent;`);
    ck('Ctrl + + 두 번 → 156% · Ctrl + − → 125% · Ctrl + 0 → 100% (창 배율)', zk1 === '156%' && zk2 === '125%' && zk3 === '100%', [zk1, zk2, zk3]);
    ck('점검 창이 떠 있는 동안 Ctrl + + / − 는 앱 화면 배율을 바꾸지 않음', win.webContents.getZoomLevel() === z0, win.webContents.getZoomLevel());

    // 글자만 해제하고 바꾸기 → 같은 창에서 바뀐 결과(고를 것 없음) · 되돌리기 버튼
    const ap = await js(`
      const px = (fx, fy) => { const c = document.getElementById('rbCanvas'); return [...c.getContext('2d').getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data].slice(0, 3); };
      const before = px(0.25, 0.25), thumb0 = pageResults[0].thumbnail, modal0 = document.querySelector('.rbv-modal');
      const c = [...document.querySelectorAll('.rbv-item input')][1]; c.click(); await sleep(50);
      const apply = document.getElementById('rbApply').textContent;
      document.getElementById('rbApply').click();
      const t = Date.now(); while (document.getElementById('rbUndo').style.display === 'none' && Date.now() - t < 60000) await sleep(100);
      while (!(document.getElementById('rbLoading').style.display === 'none' && /바뀐 결과/.test(document.getElementById('rbPageLbl').textContent)) && Date.now() - t < 60000) await sleep(100);
      await sleep(300);
      const m = document.querySelector('.rbv-modal');
      const r = { apply, same: m === modal0, sub: document.getElementById('rbSub').textContent, inputs: m.querySelectorAll('#rbList input').length,
        head: m.querySelector('.rbv-pghead').textContent, boxes: document.querySelectorAll('#rbBoxes .rbv-box').length,
        applyHidden: document.getElementById('rbApply').style.display === 'none', undo: document.getElementById('rbUndo').style.display !== 'none',
        before, after: px(0.25, 0.25), red: px(0.75, 0.25), lbl: document.getElementById('rbPageLbl').textContent,
        ed: contentEdits.has(0) ? contentEdits.get(0).k100 : null, k100: _k100Enabled };
      document.getElementById('rbClose').click(); await sleep(300);
      r.closed = !document.querySelector('.rbv-modal');
      r.msg = document.getElementById('success').textContent;
      r.thumbChanged = pageResults[0].thumbnail !== thumb0; const gi = document.querySelector('[data-page="1"] .page-thumbnail'), si = document.querySelector('[data-sb-page="1"] img'); r.domThumb = !!gi && gi.src === pageResults[0].thumbnail && (!si || si.src === pageResults[0].thumbnail);
      return r;`);
    ck('글자 해제 → [선택한 1곳 K100으로 바꾸고 다시 점검]', /선택한 1곳/.test(ap.apply), ap.apply);
    ck('바꾸기 → 창은 그대로(닫았다 다시 열지 않음) · "✔ 적용됨 1쪽 1곳"', ap.same && /적용됨/.test(ap.sub) && /1쪽 1곳/.test(ap.sub), ap);
    ck('바꾼 뒤 왼쪽: 고를 항목(체크칸) 없음 · 쪽 결과 "✔ K100 1곳 · 그대로 1곳"', ap.inputs === 0 && /K100 1곳/.test(ap.head) && /그대로 1곳/.test(ap.head), ap);
    ck('바꾼 뒤 미리보기: 바뀐 결과 그림 · 상자 없음 · 면 색이 바뀜(K100) · 빨강 그대로', ap.boxes === 0 && /바뀐 결과/.test(ap.lbl) && ap.before.join() !== ap.after.join() && ap.red[0] > 200 && ap.red[1] < 60, ap);
    ck('바꾼 뒤 버튼: [바꾸기] 숨김 · [↺ 되돌리기] 보임', ap.applyHidden && ap.undo, ap);
    ck('쪽 편집본에 K100 표시(뺀 글자 1) · 저장 단계 K100은 그대로 꺼짐', ap.ed && ap.ed.n === 1 && ap.ed.off.length === 1 && /^o0:c1$/.test(ap.ed.off[0]) && ap.k100 === false, ap.ed);
    ck('닫기 → 메인 썸네일(가운데 목록·사이드바 그림까지)이 바뀐 쪽으로 · 안내 "1쪽 1곳"', ap.closed && ap.thumbChanged && ap.domThumb && /1쪽 1곳을 K100/.test(ap.msg), ap.msg);

    // 다시 점검 → 바꾼 면은 없고 남은 글자만
    await openDlg();
    const re = await js(`const r = [...document.querySelectorAll('.rbv-item')].map(l => l.textContent); const h = document.querySelectorAll('.rbv-pghead').length; document.getElementById('rbClose').click(); return { r, h };`);
    ck('다시 점검 → 남은 글자 1곳만(바꾼 면은 없음)', re.h === 1 && re.r.length === 1 && /^글자/.test(re.r[0]), re);

    // 내부 편집기로 그 쪽 편집을 지워도(편집기는 원본에서 다시 굽는다) K100은 남는다
    const ee = await js(`await applyEditorResult({ edits: {}, removed: [0] }); await sleep(200);
      const rows = await k100ScanPages(); const p1 = rows.find(x => x.r.originalIdx === 0);
      return { has: contentEdits.has(0), left: p1 ? p1.items.length : 0 };`);
    ck('내부 편집기 저장 뒤에도 K100 유지(남은 혼합 검정 = 뺀 글자 1)', ee.has && ee.left === 1, ee);

    // 🖤 RGB검정 리치블랙처리 — 기본 꺼짐(2026-10-21) · 켜야 동작
    const rr0 = await js(`return { on: _rgbRich, btn: document.getElementById('rgbRichBtn').classList.contains('active') };`);
    ck('🖤 RGB검정 리치블랙처리 기본 꺼짐(버튼도 꺼짐)', rr0.on === false && rr0.btn === false, rr0);
    await js(`toggleRgbRich(); return _rgbRich;`);

    // ⇩ 다운로드 — 면만 K100, 글자는 그대로
    const dl = await js(`
      invalidateProcessed(); await applyChanges(); let t = Date.now(); while (!processedPdfBytes && Date.now() - t < 60000) await sleep(50);
      document.getElementById('success').textContent = '';
      await downloadProcessed();
      t = Date.now(); while (!/저장|다운로드/.test(document.getElementById('success').textContent) && Date.now() - t < 30000) await sleep(50);
      return document.getElementById('success').textContent;`);
    ck('다운로드 완료 · 안내에 "RGB 검정 1쪽·1곳 → 리치블랙"', /저장|다운로드/.test(dl) && /RGB 검정 1쪽·1곳 → 리치블랙/.test(dl), dl.slice(0, 300));
    const f1 = path.join(outDir, 'save1.pdf');
    if (fs.existsSync(f1)) {
      const rb = plates(f1, 1, ...box(20, 220, 180, 380)), red = plates(f1, 1, ...box(220, 220, 380, 380)), txt = plates(f1, 1, ...box(30, 60, 220, 120));
      ck('저장 파일: 고른 면 → C0 M0 Y0 K100', rb[0] === 0 && rb[1] === 0 && rb[2] === 0 && rb[3] >= 98, rb);
      ck('저장 파일: 뺀 글자 → 혼합 검정 그대로(C·M·Y 있음)', txt[0] > 5 && txt[1] > 5, txt);
      ck('저장 파일: 빨강 그대로', red[0] === 0 && red[1] >= 98 && red[2] >= 98 && red[3] === 0, red);
      const rgbBlk = plates(f1, 1, ...box(300, 10, 390, 50)), p2line = plates(f1, 2, ...box(30, 190, 370, 210));
      ck('저장 파일: 컬러 쪽 RGB 검정 면 → 리치블랙 C40 M30 Y30 K100(🖤 RGB검정 리치블랙처리 켬)', Math.abs(rgbBlk[0] - 40) <= 2 && Math.abs(rgbBlk[1] - 30) <= 2 && Math.abs(rgbBlk[2] - 30) <= 2 && rgbBlk[3] >= 98, rgbBlk);
      ck('저장 파일: 흑백 쪽 RGB 검정 선은 먹 1도(C·M·Y 없음)', p2line[0] === 0 && p2line[1] === 0 && p2line[2] === 0 && p2line[3] > 30, p2line);
    } else ck('저장 파일', false, fs.readdirSync(outDir));

    // 남은 글자도 바꾼 뒤 ↺ 되돌리기 → 바꾸기 전(면만 K100)으로 · 처음 점검 창(글자)으로
    await openDlg();
    const ud = await js(`
      document.getElementById('rbApply').click();
      let t = Date.now(); while (document.getElementById('rbUndo').style.display === 'none' && Date.now() - t < 60000) await sleep(100);
      const sub = document.getElementById('rbSub').textContent;
      document.getElementById('rbUndo').click();
      t = Date.now(); while (!(document.querySelector('.rbv-modal') && document.getElementById('rbApply').style.display !== 'none' && document.querySelector('.rbv-item')) && Date.now() - t < 60000) await sleep(100);
      await sleep(200);
      const r = { sub, items: [...document.querySelectorAll('.rbv-item')].map(l => l.textContent), k: contentEdits.get(0) && contentEdits.get(0).k100 };
      // 전체 해제 → 바꾸기 버튼 꺼짐
      document.getElementById('rbNone').click(); await sleep(50);
      r.noneBtn = document.getElementById('rbApply').textContent; r.noneOff = document.getElementById('rbApply').disabled;
      document.getElementById('rbClose').click();
      return r;`);
    ck('남은 글자까지 바꾸기 → "1쪽 1곳" 적용', /1쪽 1곳/.test(ud.sub), ud.sub);
    ck('↺ 되돌리기 → 바꾸기 전(면만 K100)으로 · 점검 창에 글자 다시 보임', ud.items.length === 1 && /^글자/.test(ud.items[0]) && ud.k && ud.k.n === 1, ud);
    ck('전체 해제 → "바꿀 곳을 고르세요"(버튼 꺼짐)', /바꿀 곳을 고르세요/.test(ud.noneBtn) && ud.noneOff, ud);

    // 🧪 프리플라이트 경고
    const pf = await js(`runPreflight(); const t = Date.now();
      while (!/혼합 검정/.test((document.getElementById('preflightModal') || document.body).textContent) && Date.now() - t < 30000) await sleep(100);
      const m = document.getElementById('preflightModal'); const txt = m ? m.textContent : ''; if (m) m.style.display = 'none'; return txt;`);
    ck('프리플라이트: "혼합 검정(리치 블랙) 1쪽"(CMYK만) · "RGB 검정 2쪽 … 리치블랙처리 켜짐"', /혼합 검정\(리치 블랙\) 1쪽/.test(pf) && /RGB 검정 2쪽[^]*리치블랙처리' 켜짐/.test(pf), pf.slice(pf.indexOf('혼합'), pf.indexOf('혼합') + 300));

    // 프리셋·새 탭
    const ps = await js(`setK100Enabled(true, true); const p = captureExtraPreset(); setK100Enabled(false, true); applyExtraPreset(JSON.parse(JSON.stringify(p)));
      return { saved: p.proc.k100, restored: _k100Enabled, offInPreset: JSON.stringify(p).includes('k100Off'), fresh: freshTabExtras().k100 };`);
    ck('프리셋에 proc.k100 저장·복원(뺀 개체는 프리셋에 안 담김)', ps.saved === true && ps.restored === true && !ps.offInPreset, ps);
    ck('처음 여는 문서의 시작값은 꺼짐·뺀 개체 없음', ps.fresh && ps.fresh.enabled === false && ps.fresh.off.length === 0, ps.fresh);
  } catch (e) { ck('실행 오류', false, e && (e.stack || e.message)); }

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(m, n, m === '✔' ? '' : x); });
  console.log(`결과: ${out.length - fail} 통과 / ${fail} 실패`);
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => { try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch (e) {} }, 0);
  app.exit(fail ? 1 : 0);
});
