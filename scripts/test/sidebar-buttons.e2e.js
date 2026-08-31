// 🔘 사이드바 버튼 2열 배치 회귀 테스트 — 폰트 안전화·워터마크/재단선·작업 열기/저장·E-book 화질이
// 각각 한 줄 2버튼인지, 체크박스를 대신한 토글 버튼이 숨은 상태와 동기되는지 확인한다.
//   실행: npx electron scripts/test/sidebar-buttons.e2e.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  let out;
  // 스크립트가 던지면(구문 오류 등) 그냥 매달리지 않고 실패로 끝낸다
  try { out = await win.webContents.executeJavaScript(`(async () => {
    const r = [];
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(x => setTimeout(x, 50)); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const d = await PDFDocument.create(); const ft = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i++) { const pg = d.addPage([420, 595]); pg.drawText('p' + i, { x: 40, y: 500, size: 28, font: ft, color: rgb(0,0,0) }); }
    const bb = await d.save(); const bf = bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength);
    startLoad([{ name: 't.pdf', size: bb.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(bf.slice(0)) }]);
    await waitFor(() => pageResults.length === 4 && pageResults.every(x => x && x.thumbnail));
    await new Promise(x => setTimeout(x, 600));
    const ck = (n, c, x) => r.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    // 접힌 섹션 펴기
    ['font','ebook','work'].forEach(k => {
      const sec = document.querySelector('[data-sbsec="'+k+'"]');
      sec.classList.remove('collapsed');
    });
    await new Promise(x => setTimeout(x, 150));
    const sameRow = (a, b) => Math.abs(Math.round(a.getBoundingClientRect().top) - Math.round(b.getBoundingClientRect().top)) <= 2;
    const g = id => document.getElementById(id);
    ck('안전화 켜기·평탄화 한 줄', sameRow(g('olOnBtn'), g('olFlatBtn')));
    ck('워터마크·재단선 한 줄', sameRow(g('ebWmBtn'), g('ebTrimBtn')));
    ck('작업 열기(왼쪽)·저장(오른쪽) 한 줄',
       sameRow(g('workOpenBtn'), g('workSaveBtn')) &&
       g('workOpenBtn').getBoundingClientRect().left < g('workSaveBtn').getBoundingClientRect().left);
    const dpis = [...document.querySelectorAll('[data-ebdpi]')].map(b => b.dataset.ebdpi);
    ck('DPI 표준·고화질 2개(가벼움 삭제)', dpis.join(',') === '150,200', dpis);
    ck('DPI 두 버튼 한 줄', sameRow(document.querySelector('[data-ebdpi="150"]'), document.querySelector('[data-ebdpi="200"]')));
    ck('인쇄 대수 버튼 제거', !document.getElementById('ebSheets'));
    // 토글 동작
    setOutlineEnabled(true);
    ck('안전화 버튼 활성 표시', g('olOnBtn').classList.contains('active') && g('esOutline').checked);
    setOutlineEnabled(false);
    toggleOutlineFlatten();
    ck('평탄화 토글 → 숨은 체크박스 동기', g('outlineFlatten').checked && g('olFlatBtn').classList.contains('active'));
    // 켤 때는 무거워질 수 있다는 경고가 떠야 한다(그라데이션 표지 사례)
    ck('평탄화 켜면 경고 안내', /평탄화 켜짐/.test(document.getElementById('success').textContent)
       && /⚠/.test(document.getElementById('success').textContent),
       document.getElementById('success').textContent.slice(0, 40));
    toggleOutlineFlatten();
    ck('평탄화 다시 끄기', !g('outlineFlatten').checked && !g('olFlatBtn').classList.contains('active'));
    toggleEbOpt('wm'); toggleEbOpt('trim');
    ck('워터마크·재단선 토글 반영', _ebOpts.wm === true && _ebOpts.trim === true
       && g('ebWmBtn').classList.contains('active') && g('ebTrimBtn').classList.contains('active'));
    toggleEbOpt('wm');
    ck('다시 끄기', _ebOpts.wm === false && !g('ebWmBtn').classList.contains('active'));
    ck('E-book 시트 옵션은 꺼진 채 유지', _ebOpts.sheets === false);

    // ── 폰트 방식 버튼: 안전화가 꺼져 있으면 색을 죽이고, 켜면 '완전 임베드'가 우선 선택
    const emb = document.querySelector('[data-olmode=embed]');
    const outl = document.querySelector('[data-olmode=outline]');
    setOutlineEnabled(false);
    ck('안전화 꺼짐 → 방식 버튼 색 죽음(dim)', emb.classList.contains('dim') && outl.classList.contains('dim'));
    setOutlineMode('outline');
    setOutlineEnabled(true);
    ck('안전화 켜면 폰트 완전 임베드 우선 선택',
       _outlineMode === 'embed' && emb.classList.contains('active') && !outl.classList.contains('active'), _outlineMode);
    ck('켜진 뒤엔 색이 살아남', !emb.classList.contains('dim'));
    setOutlineEnabled(false);
    ck('다시 끄면 색 죽음', emb.classList.contains('dim'));

    // ── 색의 의미 분리: 켜진 옵션 = 노란 테두리(상태) / 실행 버튼 = 노랑 fill
    // 오프스크린 창은 프레임이 돌지 않아 CSS transition이 진행되지 않는다 → 측정 전에 전환을 끈다
    const noTr = document.createElement('style');
    noTr.textContent = '* { transition: none !important; }';
    document.head.appendChild(noTr);
    const css = el => getComputedStyle(el);
    setOutlineEnabled(true);
    await new Promise(x => setTimeout(x, 250));   // 색 전환(transition) 끝난 뒤 측정
    const onOpt = css(g('olOnBtn'));
    ck('켜진 옵션 = 노란 테두리·노란 글씨(fill 아님)',
       onOpt.borderTopColor === 'rgb(255, 214, 10)' && onOpt.color === 'rgb(255, 214, 10)'
       && onOpt.backgroundColor !== 'rgb(255, 214, 10)',
       [onOpt.borderTopColor, onOpt.color, onOpt.backgroundColor]);
    ck('켜진 옵션은 사방 같은 굵기의 굵은 테두리(막대 없음)',
       onOpt.boxShadow.indexOf('0px 0px 0px 2px inset') >= 0 && onOpt.boxShadow.indexOf('255, 214, 10') >= 0,
       onOpt.boxShadow);
    const offOpt = css(g('ebWmBtn'));   // 위에서 껐던 버튼
    ck('꺼진 옵션은 무채색', offOpt.color !== 'rgb(255, 214, 10)' && offOpt.borderTopColor !== 'rgb(255, 214, 10)',
       [offOpt.color, offOpt.borderTopColor]);
    const run = css(g('ebGenBtn'));
    ck('실행 버튼(E-book 생성) = 노랑 fill', run.backgroundColor === 'rgb(255, 214, 10)', run.backgroundColor);
    const save = css(g('workSaveBtn'));
    ck('실행 버튼(작업 저장) = 노랑 fill', save.backgroundColor === 'rgb(255, 214, 10)', save.backgroundColor);
    ck('켜진 옵션과 실행 버튼의 배경이 서로 다름', onOpt.backgroundColor !== run.backgroundColor,
       [onOpt.backgroundColor, run.backgroundColor]);
    setOutlineEnabled(false);

    // ── 작업 열기·저장 폭이 다른 2버튼 줄과 같은지
    const wOpen = g('workOpenBtn').getBoundingClientRect(), wSave = g('workSaveBtn').getBoundingClientRect();
    const olOn = g('olOnBtn').getBoundingClientRect();
    ck('작업 열기·저장 폭이 서로 같음', Math.abs(wOpen.width - wSave.width) < 1.5, [wOpen.width, wSave.width]);
    ck('다른 2버튼 줄과 같은 폭', Math.abs(wOpen.width - olOn.width) < 1.5, [wOpen.width, olOn.width]);

    // ── 패널 하단 손잡이로 세로 크기 조절
    const grip = document.getElementById('sbPanelGrip');
    const body = document.getElementById('sbPanelBody');
    ck('하단 손잡이 존재', !!grip);
    const h0 = Math.round(body.getBoundingClientRect().height);
    const gb = grip.getBoundingClientRect();
    const ev = (t, y, tgt) => (tgt || document).dispatchEvent(new PointerEvent(t, { clientX: gb.left + gb.width / 2, clientY: y, bubbles: true, cancelable: true }));
    const gy = gb.top + gb.height / 2;
    ev('pointerdown', gy, grip); ev('pointermove', gy - 120); ev('pointerup', gy - 120);
    await new Promise(x => setTimeout(x, 100));
    const h1 = Math.round(body.getBoundingClientRect().height);
    ck('위로 끌면 패널이 줄어듦', h1 < h0 - 80, [h0, h1]);
    ck('줄어든 만큼 내부 스크롤', body.classList.contains('sbp-limited') && body.scrollHeight > body.clientHeight);
    ck('높이가 기억됨', Math.abs(parseInt(localStorage.getItem('sbPanelH'), 10) - h1) <= 1, [localStorage.getItem('sbPanelH'), h1]);
    ev('pointerdown', gy - 120, grip); ev('pointermove', gy + 60); ev('pointerup', gy + 60);
    await new Promise(x => setTimeout(x, 100));
    const h2 = Math.round(body.getBoundingClientRect().height);
    ck('아래로 끌면 다시 커짐', h2 > h1, [h1, h2]);
    grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(x => setTimeout(x, 100));
    ck('더블클릭 → 자동 높이 복귀', !body.classList.contains('sbp-limited') && !localStorage.getItem('sbPanelH'));
    return r;
  })()`); } catch (e) { console.error("  ✘ 스크립트 실행 오류:", e && e.message); app.exit(1); return; }
  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  const img = await win.webContents.capturePage();
  if (process.argv[2]) fs.writeFileSync(process.argv[2], img.toPNG());
  app.exit(fail ? 1 : 0);
});
