// 🖱 썸네일 우클릭 메뉴(인쇄 드라이버 구성) — 실제 화면·preload·조립 워커
//   실행: npx electron scripts/test/page-ctx-menu.e2e.js   (창을 띄우지 않는다 — show:false)
// 확인:
//   · 메뉴 구성(잘라내기…삭제 / 회전 ▸ / 새 원본 페이지 추가 / 새 장 / 쪽별 예외 3종 / 컬러 모드 ▸)과 ✓ 표시
//   · 📂 새 원본 페이지 추가: PDF·이미지를 우클릭한 쪽 바로 뒤에, 기존 쪽의 회전·흑백 선택 유지, Ctrl+Z로 되돌림
//   · 쪽별 예외가 **저장본**에 실제로 반영되는지(pdf.js로 읽음)
//       원본 배율 조정 안 함 → 그 쪽만 글자 배율 1(나머지는 A4 맞춤으로 확대) · 용지는 모두 A4
//       머리글·바닥글 안 함 → 그 쪽만 머리글·페이지 번호 없음, 번호는 이어짐
//       워터마크 안 함 → 그 쪽만 워터마크 그림 없음
//   · 되돌리기·작업 기록(.pdfw와 같은 docState)에서 표식이 살아남는지
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-ctxmenu'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_ctx_'));
let pickQueue = [];
// main.js의 파일 열기 다이얼로그 자리 — 검사에서는 준비한 파일을 바로 준다
ipcMain.handle('dialog:openFile', () => pickQueue.shift() || []);

app.whenReady().then(async () => {
  // 끼워 넣을 파일: 2쪽 PDF(N1·N2) + 빨간 이미지 1장
  const nd = await PDFDocument.create();
  const nf = await nd.embedFont(StandardFonts.Helvetica);
  for (const t of ['N1', 'N2']) nd.addPage([300, 300]).drawText(t, { x: 40, y: 150, size: 40, font: nf, color: rgb(0, 0, 0) });
  const newPdf = path.join(tmp, '추가원고.pdf');
  fs.writeFileSync(newPdf, await nd.save());
  const W = 40, H = 20, bmp = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { bmp[i * 4] = 0; bmp[i * 4 + 1] = 0; bmp[i * 4 + 2] = 255; bmp[i * 4 + 3] = 255; }   // BGRA 빨강
  const png = path.join(tmp, '사진.png');
  fs.writeFileSync(png, nativeImage.createFromBitmap(bmp, { width: W, height: H }).toPNG());
  pickQueue.push([{ path: newPdf, name: '추가원고.pdf' }, { path: png, name: '사진.png' }]);

  const win = new BrowserWindow({ show: false, width: 1300, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(50); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const labels = () => pageResults.filter(Boolean).map(r => r.__lbl || '?');

    // 4쪽(300×300pt) — 쪽마다 'P<번호>'
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i++) d.addPage([300, 300]).drawText('P' + i, { x: 40, y: 150, size: 40, font: f, color: rgb(0, 0, 0) });
    const b = await d.save();
    startLoad([{ name: '원고.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    await waitFor(() => pageResults.length === 4 && isTabReady(tabs.get(activeTabId)));
    await sleep(1200);   // 자동 방향 맞춤(지연 실행)이 지나간 뒤에 회전을 건다
    setOutlineEnabled(false);   // 검사 하네스에는 Ghostscript IPC가 없다
    pageResults.forEach((r, i) => { r.__lbl = 'P' + (i + 1); });

    // ── 메뉴 구성 ──
    const cell = n => document.querySelector('#pagesGrid [data-page="' + n + '"]');
    cell(2).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    const menu = document.getElementById('pageCtxMenu');
    ck('우클릭하면 메뉴가 열림', menu.style.display === 'block');
    const top = [...menu.children].filter(x => x.classList.contains('ctx-item')).map(x => x.firstElementChild.textContent.replace(/\\s+/g, ' ').trim());
    const want = ['잘라내기', '복사', '붙여넣기', '삭제', '원본 페이지 회전', '새 원본 페이지 추가', '새 장 추가', '원본 배율 조정 안 함', '컬러 모드', '머리글·바닥글 삽입 안 함', '워터마크 삽입 안 함', '원본 페이지 설정'];
    let pos = -1, inOrder = true;
    for (const w of want) { const k = top.findIndex(t => t.includes(w)); if (k <= pos) inOrder = false; pos = k; }
    ck('메뉴가 캡처 순서대로(잘라내기…원본 페이지 설정)', inOrder, top);
    ck('기존 항목도 남아 있음(크게 보기·내부 편집·복제·챕터 나누기)', ['크게 보기', '내부 내용 편집', '페이지 복제', '챕터 나누기'].every(w => top.some(t => t.includes(w))));
    const subs = [...menu.querySelectorAll('.ctx-sub .ctx-submenu')].map(s => s.textContent.replace(/\\s+/g, ' '));
    ck('회전 하위 메뉴 = 오른쪽 90°·왼쪽 90°·180°', /오른쪽 90°/.test(subs[0]) && /왼쪽 90°/.test(subs[0]) && /180°/.test(subs[0]), subs[0]);
    ck('컬러 모드 하위 메뉴 = 컬러·흑백', /컬러/.test(subs[1]) && /흑백/.test(subs[1]), subs[1]);
    ck('붙여넣을 것이 없으면 붙여넣기가 흐림', document.getElementById('ctxPasteItem').classList.contains('ctx-disabled'));
    const r = menu.getBoundingClientRect();
    ck('메뉴가 화면 안에 들어옴', r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, [r.top, r.bottom, innerHeight]);
    hideCtxMenu();

    // ── 180° 회전 ──
    ctxTargetIdx = 0; ctxRotate(180);
    ck('180° 회전', pageResults[0].rotation === 180, pageResults[0].rotation);
    ctxTargetIdx = 0; ctxRotate(180);

    // ── 📂 새 원본 페이지 추가 (2쪽 뒤에 PDF 2쪽 + 이미지 1쪽) ──
    rotatePage(2, 90);                                   // P3 회전 — 끼워 넣은 뒤에도 남아야 한다
    selectPageEl(1, cell(1)); updateSelectedCount();     // P1 흑백 선택 — 남아야 한다
    await insertFilePagesAfter(1);
    await waitFor(() => pageResults.filter(Boolean).length === 7, 60000);
    const lbl = pageResults.filter(Boolean).map((r, i) => r.__lbl || ('new' + i));
    ck('7쪽이 됨(4 + PDF 2 + 이미지 1)', pageResults.filter(Boolean).length === 7, lbl);
    ck('2쪽 바로 뒤에 들어감(P1 P2 새 새 새 P3 P4)', lbl[0] === 'P1' && lbl[1] === 'P2' && !/^P/.test(lbl[2]) && !/^P/.test(lbl[3]) && !/^P/.test(lbl[4]) && lbl[5] === 'P3' && lbl[6] === 'P4', lbl);
    ck('기존 쪽 회전 유지(P3 = 90°)', pageResults[5].rotation === 90, pageResults[5].rotation);
    ck('기존 흑백 선택 유지(1쪽)', selectedPages.has(1) && pageResults[0].__lbl === 'P1');
    ck('이미지 쪽은 컬러로 판정', pageResults[4].isColor === true && pageResults[2].isColor === false, [pageResults[2].isColor, pageResults[4].isColor]);
    ck('새 쪽 썸네일이 있음', pageResults.slice(2, 5).every(r => !!r.thumbnail));
    ck('성공 안내에 위치·되돌리기', /2쪽 뒤에 넣었습니다/.test(document.getElementById('success').textContent) && /Ctrl\\+Z/.test(document.getElementById('success').textContent), document.getElementById('success').textContent.slice(0, 60));
    ck('그리드에도 7칸', document.querySelectorAll('#pagesGrid .page-item').length === 7);
    // 새 쪽 내용 확인 — 원본 문서 끝에 붙어 있고 목록이 그 번호를 가리킨다
    {
      const doc = await pdfjsLib.getDocument({ data: originalPdfBytes.slice(0) }).promise;
      const t = async oi => (await (await doc.getPage(oi + 1)).getTextContent()).items.map(x => x.str).join('');
      ck('새 쪽이 N1·N2를 가리킴', (await t(pageResults[2].originalIdx)) === 'N1' && (await t(pageResults[3].originalIdx)) === 'N2');
      await doc.destroy();
    }
    undoEdit();
    ck('Ctrl+Z로 되돌리면 4쪽', pageResults.filter(Boolean).length === 4 && labels().join() === 'P1,P2,P3,P4', labels());
    rotatePage(2, -90);
    deselectPageEl(1, cell(1)); updateSelectedCount();

    // ── 쪽별 예외 3종 ──
    togglePageFlag(1, 'noScale');   // P2
    togglePageFlag(2, 'noHf');      // P3
    togglePageFlag(3, 'noWm');      // P4
    ck('표식이 쪽에 붙음', pageResults[1].noScale && pageResults[2].noHf && pageResults[3].noWm && !pageResults[0].noScale);
    ck('썸네일에 꼬리표', /100%/.test(cell(2).textContent) && /머리✕/.test(cell(3).textContent) && /워터✕/.test(cell(4).textContent));
    // ✓ 표시
    ctxTargetIdx = 1; showCtxMenu({ clientX: 100, clientY: 100 }, 1);
    ck('✓ 원본 배율 조정 안 함(P2)', document.getElementById('ctxChk_noScale').classList.contains('on') && !document.getElementById('ctxChk_noHf').classList.contains('on'));
    hideCtxMenu();
    // 되돌리기에도 표식이 따라감
    togglePageFlag(0, 'noWm'); ck('P1 워터마크 안 함 켜짐', !!pageResults[0].noWm);
    undoEdit(); ck('Ctrl+Z로 표식만 되돌려짐', !pageResults[0].noWm && pageResults[1].noScale && pageResults[3].noWm);
    // 작업 파일·작업 기록(docState)에 담김
    const ds = captureDocState();
    pageResults.forEach(r => { delete r.noScale; delete r.noHf; delete r.noWm; });
    restoreDocState(ds);
    ck('docState 저장·복원으로 표식 유지', pageResults[1].noScale && pageResults[2].noHf && pageResults[3].noWm && !pageResults[0].noHf, ds.order.map(o => o.pf || 0));

    // 설정: A4 맞춤 + 머리글 'HEAD' + 페이지 번호 'N{page}' + 워터마크 'WM'
    const es = editSettings;
    es.scaling.mode = 'standard'; es.scaling.paper = 'A4'; es.scaling.orient = 'portrait';
    es.hf.enabled = true; es.hf.hC = 'HEAD';
    es.pn.enabled = true; es.pn.fmt = 'N{page}';
    es.wm.enabled = true; es.wm.text = 'WM';
    invalidateProcessed();
    ck('편집기용 머리글 판정: P3는 찍지 않음', hfForPage(3) && hfForPage(3).apply === false && hfForPage(2).apply === true);
    const bytes = await buildOptimizedBase();
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const info = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      const items = (await pg.getTextContent()).items;
      const p = items.find(x => /^P\\d$/.test(x.str));
      const ops = await pg.getOperatorList();
      const imgs = ops.fnArray.filter(fn => fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject).length;
      info.push({ w: Math.round(vp.width), h: Math.round(vp.height), p: p && p.str, k: p ? +Math.hypot(p.transform[0], p.transform[1]).toFixed(1) : 0,
                  head: items.some(x => x.str === 'HEAD'), num: (items.find(x => /^N\\d$/.test(x.str)) || {}).str || '', imgs });
    }
    await doc.destroy();
    ck('저장본 4쪽 모두 A4', info.every(x => x.w === 595 && x.h === 842), info.map(x => x.w + 'x' + x.h));
    ck('원본 배율 조정 안 함: P2만 글자 크기 40(100%)', Math.abs(info[1].k - 40) < 0.5 && info[0].k > 70 && info[2].k > 70 && info[3].k > 70, info.map(x => x.k));
    ck('머리글·바닥글 안 함: P3만 HEAD 없음', info[2].head === false && info[0].head && info[1].head && info[3].head, info.map(x => x.head));
    ck('페이지 번호: P3만 빠지고 번호는 이어짐(N1 N2 - N4)', info.map(x => x.num).join() === 'N1,N2,,N4', info.map(x => x.num));
    ck('워터마크 안 함: P4만 그림 없음', info[3].imgs === 0 && info[0].imgs > 0 && info[1].imgs > 0 && info[2].imgs > 0, info.map(x => x.imgs));

    // 표식을 끄면 저장본도 돌아온다(캐시에 옛 결과가 남지 않음)
    togglePageFlag(1, 'noScale');
    const bytes2 = await buildOptimizedBase();
    const doc2 = await pdfjsLib.getDocument({ data: bytes2.slice(0) }).promise;
    const it2 = (await (await doc2.getPage(2)).getTextContent()).items.find(x => x.str === 'P2');
    await doc2.destroy();
    ck('표식을 끄면 P2도 A4에 맞춰 확대', it2 && Math.hypot(it2.transform[0], it2.transform[1]) > 70, it2 && it2.transform[0]);
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(fail ? `FAIL ${fail}/${res.length}` : `PASS ${res.length}/${res.length}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  win.destroy();
  app.exit(fail ? 1 : 0);
});
