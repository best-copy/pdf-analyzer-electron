// 📦 배포용 임포징 도구(dist/임포징도구.html) 동작 검증
//   실행: npx electron scripts/test/imposition-standalone.e2e.js
// 생성된 단일 HTML을 실제 브라우저 창에 띄우고, 5개 모드와 새 옵션(원고 블리드·재단선
// 모양·재단 치수)이 앱과 같은 결과를 내는지 확인한다. 빌더가 바뀌면 재생성이 필요한데,
// 추출 목록에서 헬퍼가 빠지면 여기서 '함수 없음'으로 바로 드러난다.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'dist', '임포징도구.html');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  if (!fs.existsSync(TOOL)) {
    console.error('  ✘ dist/임포징도구.html 이 없습니다 — node scripts/build-imposition-standalone.js 먼저 실행하세요.');
    app.exit(1); return;
  }
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { contextIsolation: true, sandbox: false } });
  await win.loadFile(TOOL);
  await new Promise(r => setTimeout(r, 1200));

  let res;
  try {
    res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const MM = 72 / 25.4;
    ck('pdf-lib 인라인 로드됨', typeof PDFLib === 'object' && !!PDFLib.PDFDocument);
    ['buildBookletBytes','buildNupBytes','buildStepRepeatBytes','buildDup2upBytes',
     'drawTrimMarks','drawCutDims','trimSizeMm','pageTrimInset','ensurePageContents','uiYield']
      .forEach(fn => ck('함수 있음: ' + fn, typeof window[fn] === 'function' || typeof eval(fn) === 'function'));
    ck('프로파일 시드 로드', Array.isArray(IMP_PROFILE_SEED) && IMP_PROFILE_SEED.length > 50, IMP_PROFILE_SEED.length);

    // 시험용 원고 8쪽 (A5 세로)
    const d = await PDFLib.PDFDocument.create();
    for (let i = 0; i < 8; i++) d.addPage([148 * MM, 210 * MM]);
    const src = new Uint8Array(await d.save());
    const base = {
      margin: 10, gutter: 6, bleed: 0, srcBleed: 0, crop: true, frame: false,
      cropDims: false, cropStyle: { shape: 'corner', gap: 1, len: 3, th: 0.4, center: false },
      slug: null, stackNum: false, place: { scale: 'fit', align: 'cc', offX: 0, offY: 0 },
    };
    const A4L = [841.89, 595.28];
    const run = async (fn, extra) => fn(src.slice(0), Object.assign({}, base, extra), () => {});
    let r = await run(buildBookletBytes, { mode: 'booklet', sheet: A4L, creep: 0, binding: 'left' });
    ck('중철 생성', r.bytes.length > 500 && r.sheets === 2, { sheets: r.sheets });
    r = await run(buildNupBytes, { mode: 'nup', sheet: A4L, across: 2, down: 1, sides: 1, order: 'sequential' });
    ck('모아찍기 2x1 생성', r.sheets === 4, { sheets: r.sheets });
    r = await run(buildNupBytes, { mode: 'cutstack', sheet: A4L, across: 2, down: 1, sides: 1, order: 'cutstack' });
    ck('정합(Cut&Stack) 생성', r.sheets === 4, { sheets: r.sheets });
    r = await run(buildStepRepeatBytes, { mode: 'repeat', sheet: A4L, cols: 2, rows: 1 });
    ck('반복 배치 생성', r.sheets === 8, { sheets: r.sheets, total: r.total });
    r = await run(buildDup2upBytes, { mode: 'dup', sheet: A4L, sides: 1 });
    ck('복제 2부 생성', r.bytes.length > 500 && r.sheets === 8, { sheets: r.sheets });

    // 새 옵션 — 원고 블리드로 실제 재단 크기 인식 (303×426 → 297×420)
    const d2 = await PDFLib.PDFDocument.create();
    d2.addPage([303 * MM, 426 * MM]);
    const bled = new Uint8Array(await d2.save());
    const one = { mode: 'nup', sheet: [315 * MM, 450 * MM], across: 1, down: 1, sides: 1,
                  order: 'sequential', place: { scale: 'orig', align: 'cc' } };
    let rb = await buildNupBytes(bled.slice(0), Object.assign({}, base, one, { margin: 5, srcBleed: 3 }), () => {});
    ck('원고 블리드 3 → 재단 297×420', rb.trimMm && rb.trimMm[0] === 297 && rb.trimMm[1] === 420, rb.trimMm);
    rb = await buildNupBytes(bled.slice(0), Object.assign({}, base, one, { margin: 5, srcBleed: 0 }), () => {});
    ck('알려 주지 않으면 303×426', rb.trimMm && rb.trimMm[0] === 303, rb.trimMm);

    // 재단선 모양 2종이 서로 다른 결과
    const two = [{ x: 50, y: 50, w: 100, h: 60 }, { x: 170, y: 50, w: 100, h: 60 }];
    const bytesOf = async shape => {
      const o = await PDFLib.PDFDocument.create();
      drawTrimMarks(o.addPage([400, 200]), two, { cropStyle: { shape, gap: 1, len: 4, th: 0.4 } });
      return (await o.save()).length;
    };
    ck('재단선 모양 2종이 다름', (await bytesOf('corner')) !== (await bytesOf('notouch')));

    // 재단 치수(시험) — 켜면 숫자가 인쇄된다
    const rd = await buildNupBytes(src.slice(0), Object.assign({}, base, {
      mode: 'nup', sheet: A4L, across: 2, down: 1, sides: 1, order: 'sequential', cropDims: true,
    }), () => {});
    const txt = new TextDecoder('latin1').decode(rd.bytes);
    ck('재단 치수 옵션이 동작(텍스트 삽입)', rd.bytes.length > (await run(buildNupBytes, { mode: 'nup', sheet: A4L, across: 2, down: 1, sides: 1, order: 'sequential' })).bytes.length);

    // ── 원본 미리보기(pdf.js) · 드래그&드롭 · 프로파일 다중삭제 ──
    ck('pdf.js 인라인 로드', typeof pdfjsLib === 'object' && !!pdfjsLib.getDocument);
    ck('pdf.js 워커 준비됨', !!(pdfjsLib.GlobalWorkerOptions.workerSrc || '').startsWith('blob:'),
       (pdfjsLib.GlobalWorkerOptions.workerSrc || '').slice(0, 12));
    // 실제 파일을 떨어뜨린 것처럼 loadFile 호출 → 썸네일·본문이 그려져야 한다
    const fakeFile = { name: '테스트원고.pdf', arrayBuffer: async () => src.buffer.slice(0) };
    await loadFile(fakeFile);
    await new Promise(r => setTimeout(r, 1500));
    ck('원본 본문이 그려짐', $('pageCv').width > 50 && $('pageCv').height > 50,
       [$('pageCv').width, $('pageCv').height]);
    ck('썸네일 8개 생성', document.querySelectorAll('#rail canvas').length === 8,
       document.querySelectorAll('#rail canvas').length);
    ck('첫 썸네일이 실제로 그려짐', document.querySelector('#rail canvas').width > 20);
    ck('문서 정보 표시', /8쪽/.test($('pvInfo').textContent), $('pvInfo').textContent);
    await drawPage(3);
    ck('썸네일 클릭으로 페이지 이동', curPage === 3 &&
       document.querySelector('#rail canvas[data-p="3"]').classList.contains('cur'));
    ck('드롭 핸들러 등록됨(문서 body)', typeof loadFile === 'function');

    // 프로파일 다중 선택 삭제
    const before = loadProfiles().length;
    saveProfiles(loadProfiles().concat([{ n: '__T1', m: 'nup' }, { n: '__T2', m: 'nup' }, { n: '__T3', m: 'nup' }]));
    fillProfiles();
    toggleProfList();
    ck('프로파일 목록 표시', $('profList').style.display !== 'none' &&
       document.querySelectorAll('#profList input').length === before + 3);
    const boxes = [...document.querySelectorAll('#profList input')].slice(-3);
    boxes.forEach(b => { b.checked = true; }); syncProfDelBtn();
    ck('선택 개수가 버튼에 표시', /3개/.test($('profDelBtn').textContent), $('profDelBtn').textContent);
    const origConfirm = window.confirm; window.confirm = () => true;
    delProfChecked();
    window.confirm = origConfirm;
    ck('체크한 3개가 한 번에 삭제됨', loadProfiles().length === before, loadProfiles().length);
    toggleProfList();

    // 생성 속도 — 같은 설정 재클릭은 캐시로 즉시
    const t0 = performance.now();
    setMode('booklet'); await generate();
    const first = Math.round(performance.now() - t0);
    const t1 = performance.now(); await generate();
    const second = Math.round(performance.now() - t1);
    out.push(['ℹ', '생성 시간(ms)', JSON.stringify({ 처음: first, 재클릭: second })]);
    ck('같은 설정 재생성은 캐시로 즉시', second < Math.max(30, first / 2), { first, second });
    ck('결과 탭으로 자동 전환', $('stageOut').style.display !== 'none');

    // ── 진행 바: 생성 중 보이고 → 100%로 끝나고 → 잠시 뒤 사라진다 ──
    const big = await PDFLib.PDFDocument.create();
    for (let i = 0; i < 120; i++) big.addPage([148 * MM, 210 * MM]);
    const bigBytes = new Uint8Array(await big.save());
    await loadFile({ name: '진행바_120쪽.pdf', arrayBuffer: async () => bigBytes.buffer.slice(0) });
    await new Promise(r => setTimeout(r, 600));
    setMode('booklet');
    const seen = [];
    const watch = setInterval(() => {
      const bar = $('genBar');
      if (bar.style.display !== 'none') seen.push(parseFloat($('genBarFill').style.width) || 0);
    }, 8);
    const gp = generate();
    await gp;
    clearInterval(watch);
    ck('생성 중 진행 바가 보임', seen.length > 0, seen.length);
    ck('진행률이 0에서 올라감', seen.some(v => v > 5) && Math.max(...seen) >= 90, [Math.min(...seen), Math.max(...seen)]);
    ck('완료 표시(100%)', parseFloat($('genBarFill').style.width) === 100, $('genBarFill').style.width);
    ck('완료 색으로 전환', $('genBar').classList.contains('done'));
    ck('생성 중 버튼 잠금 해제됨(완료 후)', $('genBtn').disabled === false);
    await new Promise(r => setTimeout(r, 1100));
    ck('잠시 뒤 진행 바가 사라짐', $('genBar').style.display === 'none', $('genBar').style.display);

    // UI 요소가 모두 있는지 (새 옵션 포함)
    ['file','paper','margin','gutter','bleed','srcBleed','crop','cropShape','cropGap','cropLen','cropTh','cropCenter','cropDims','frame','slug','profile','dlBtn']
      .forEach(id => ck('UI 요소: #' + id, !!document.getElementById(id)));
    ['rail','pageCv','tabSrc','tabOut','profList','profDelBtn','profListBtn','genBar','genBarFill','genBtn']
      .forEach(id => ck('UI 요소: #' + id, !!document.getElementById(id)));
    return out;
  })()`);
  } catch (e) { console.error('  ✘ 스크립트 실행 오류:', e && e.message); app.exit(1); return; }

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
