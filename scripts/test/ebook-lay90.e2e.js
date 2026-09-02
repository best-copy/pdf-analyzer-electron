// ⟲ 눕혀 보기 검증 — 펼침면 전체를 왼쪽(반시계)으로 90° 돌려 보고, 다시 정상으로 돌아온다.
//   ① 회전 각도·방향  ② 눕힌 상태에서 화면에 맞게 커지는지  ③ 넘김이 그대로 되는지  ④ 복귀
//   실행: npx electron scripts/test/ebook-lay90.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

function loadCore() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
  const s = src.indexOf('// <EBOOK-CORE>'), e = src.indexOf('// </EBOOK-CORE>');
  return new Function(src.slice(s, e) + '\nreturn { buildEbookProofHtml };')();
}
// 가로 원고(폭>높이) — 눕혀 보기가 쓸모 있는 경우
const land = (n) => ({
  u: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="595" height="420">'
    + '<rect width="595" height="420" fill="rgb(250,250,250)"/>'
    + '<text x="297" y="240" font-size="60" text-anchor="middle" fill="#888">' + n + '</text></svg>'),
  w: 595, h: 420,
});

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

const READ = `(() => {
  const sp = document.querySelector('.spread');
  const st = document.getElementById('stage');
  const cs = sp ? getComputedStyle(sp).transform : '';
  const r = sp ? sp.getBoundingClientRect() : null;
  const box = sp ? sp.querySelector('.pg') : null;
  return {
    lay: document.body.classList.contains('lay90'),
    on: document.getElementById('layBtn').classList.contains('on'),
    matrix: cs,
    vis: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,   // 화면에서 차지하는 크기
    pageW: box ? box.offsetWidth : 0,
    stage: { w: st.clientWidth, h: st.clientHeight },
    lbl: (document.getElementById('lbl') || {}).textContent,
    fab: (() => {
      const b = document.getElementById('layFab');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const a = document.querySelector('#next i').getBoundingClientRect();
      const s = document.getElementById('next').getBoundingClientRect();
      return { inNext: !!b.closest('#next'), stripCx: Math.round(s.left + s.width / 2), stripCy: Math.round(s.top + s.height / 2), cx: Math.round(r.left + r.width / 2),
               cy: Math.round(r.top + r.height / 2), visible: +getComputedStyle(b).opacity > 0.2,
               arrowCx: Math.round(a.left + a.width / 2), arrowCy: Math.round(a.top + a.height / 2) };
    })(),
    nav: (() => {
      const p = document.getElementById('prev').getBoundingClientRect();
      const n = document.getElementById('next').getBoundingClientRect();
      return { prev: { w: Math.round(p.width), h: Math.round(p.height), top: Math.round(p.top) },
               next: { w: Math.round(n.width), h: Math.round(n.height), top: Math.round(n.top) } };
    })(),
  };
})()`;

app.whenReady().then(async () => {
  const { buildEbookProofHtml } = loadCore();
  const html = buildEbookProofHtml({
    title: '눕혀 보기', book: [1, 2, 3, 4].map(land), sheets: [],
    meta: { mm: [297, 210], bind: 'left', view: 'spread' }, opts: { coverSingle: false },
  });
  const f = path.join(os.tmpdir(), `pdfedit_lay_${Date.now()}.html`);
  fs.writeFileSync(f, html, 'utf8');
  const win = new BrowserWindow({ show: true, width: 820, height: 1000 });
  try { await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); } catch (e) {}
  await win.loadFile(f);
  await new Promise(r => setTimeout(r, 1000));

  try {
    const a0 = await win.webContents.executeJavaScript(READ);
    console.log('\n[1] 처음 — 눕히지 않은 상태');
    ck('lay90 꺼짐', a0.lay === false && a0.on === false, a0);
    ck('회전 없음', a0.matrix === 'none' || a0.matrix === '', a0.matrix);

    await win.webContents.executeJavaScript("document.getElementById('layBtn').click()");
    await new Promise(r => setTimeout(r, 500));
    const a1 = await win.webContents.executeJavaScript(READ);
    console.log('\n[2] 눕혀 보기 — 오른쪽으로 90°');
    ck('lay90 켜짐', a1.lay === true && a1.on === true, a1);
    // rotate(90deg) = matrix(0, 1, -1, 0, 0, 0)
    ck('시계 90° (matrix 0,1,-1,0)', /matrix\(\s*0,\s*1,\s*-1,\s*0/.test(a1.matrix), a1.matrix);
    ck('화면에서 가로세로가 바뀜', a1.vis.h > a1.vis.w, a1.vis);
    ck('화면 안에 들어옴', a1.vis.w <= a1.stage.w + 2 && a1.vis.h <= a1.stage.h + 2, { vis: a1.vis, stage: a1.stage });
    // 눕히면 세로 공간을 폭으로 쓰므로 가로 원고가 더 크게 보인다
    ck('가로 원고가 더 크게 보임', a1.pageW > a0.pageW, { before: a0.pageW, after: a1.pageW });
    // 오른쪽으로 눕히면 '다음'은 화면 아래, '이전'은 위 — 넘김 표시도 따라 옮겨야 한다
    ck('넘김 표시가 위/아래 띠로 바뀜',
       a1.nav.prev.w > a1.nav.prev.h && a1.nav.next.w > a1.nav.next.h,
       { prev: a1.nav.prev, next: a1.nav.next });
    ck('이전은 위, 다음은 아래', a1.nav.next.top > a1.nav.prev.top,
       { prevTop: a1.nav.prev.top, nextTop: a1.nav.next.top });
    ck('눕히기 전에는 좌우 띠였음', a0.nav.prev.h > a0.nav.prev.w, a0.nav.prev);

    // 눕힌 상태에서 넘김
    await win.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
    await win.webContents.executeJavaScript(`(async () => {
      for (let k = 0; k < 120; k++) {                 // 낱장이 사라질 때까지(=넘김 완료)
        if (!document.querySelector('.leaf')) return true;
        await new Promise(r => setTimeout(r, 50));
      } return false;
    })()`);
    await new Promise(r => setTimeout(r, 200));
    const a2 = await win.webContents.executeJavaScript(READ);
    console.log('\n[2-b] 넘김 표시 안의 눕혀 보기 버튼');
    ck('버튼이 넘김 표시 안에 있다', a0.fab && a0.fab.inNext === true, a0.fab);
    ck('정상 모드에서는 늘 보인다', a0.fab.visible === true, a0.fab);
    ck('정상: 화살표 아래에, 같은 세로선', a0.fab.cy > a0.fab.arrowCy && Math.abs(a0.fab.cx - a0.fab.arrowCx) <= 4,
       { fab: [a0.fab.cx, a0.fab.cy], arrow: [a0.fab.arrowCx, a0.fab.arrowCy] });
    ck('눕히면: 화살표 오른쪽에, 같은 높이', a1.fab.cx > a1.fab.arrowCx && Math.abs(a1.fab.cy - a1.fab.arrowCy) <= 4,
       { fab: [a1.fab.cx, a1.fab.cy], arrow: [a1.fab.arrowCx, a1.fab.arrowCy] });
    // 이 버튼으로도 켜고 끌 수 있어야 한다
    await win.webContents.executeJavaScript("document.getElementById('layFab').click()");
    // 붙어 있으면 넘기려다 잘못 눌린다 — 중심 간격을 넉넉히 둔다
    ck('정상: 버튼과 화살표 간격 충분', a0.fab.cy - a0.fab.arrowCy >= 80, a0.fab.cy - a0.fab.arrowCy);
    ck('눕힘: 버튼과 화살표 간격 충분', a1.fab.cx - a1.fab.arrowCx >= 80, a1.fab.cx - a1.fab.arrowCx);
    // 화살표(넘김 버튼)는 띠의 정확한 가운데에 있어야 한다
    ck('정상: 넘김 버튼이 띠 가운데', Math.abs(a0.fab.arrowCy - a0.fab.stripCy) <= 3
       && Math.abs(a0.fab.arrowCx - a0.fab.stripCx) <= 3,
       { arrow: [a0.fab.arrowCx, a0.fab.arrowCy], strip: [a0.fab.stripCx, a0.fab.stripCy] });
    ck('눕힘: 넘김 버튼이 띠 가운데', Math.abs(a1.fab.arrowCy - a1.fab.stripCy) <= 3
       && Math.abs(a1.fab.arrowCx - a1.fab.stripCx) <= 3,
       { arrow: [a1.fab.arrowCx, a1.fab.arrowCy], strip: [a1.fab.stripCx, a1.fab.stripCy] });
    // 눕히면 띠가 페이지 위에 겹친다 — 평소엔 감추고 근처에 가면 나타나야 내용을 안 가린다
    ck('눕힘: 평소에는 감춰져 있다', a1.fab.visible === false, a1.fab);
    const hov = await win.webContents.executeJavaScript(`(() => {
      const n = document.getElementById('next');
      n.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // :hover는 실제 포인터로만 켜지므로, 규칙이 존재하는지로 확인한다
      const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch (e) { return []; } })
        .map(r => r.cssText).join(' ');
      return { rule: /\.lay90 \.nav:hover \.layfab/.test(css.replace(/\s+/g, ' ')),
               clickable: getComputedStyle(document.getElementById('layFab')).pointerEvents !== 'none' };
    })()`);
    ck('눕힘: 넘김 띠에 마우스가 가면 나타나는 규칙이 있다', hov.rule === true, hov);
    ck('눕힘: 감춰져 있어도 누를 수는 있다', hov.clickable === true, hov);
    await new Promise(r => setTimeout(r, 500));
    const aF = await win.webContents.executeJavaScript(READ);
    ck('버튼으로 정상 복귀', aF.lay === false, aF.lay);
    await win.webContents.executeJavaScript("document.getElementById('layFab').click()");
    await new Promise(r => setTimeout(r, 500));
    const aG = await win.webContents.executeJavaScript(READ);
    ck('버튼으로 다시 눕히기', aG.lay === true, aG.lay);
    ck('90° 회전 버튼은 없다',
       await win.webContents.executeJavaScript("!document.getElementById('rotBtn')"), null);

    console.log('\n[3] 눕힌 채로 넘기기');
    ck('페이지가 넘어감', a2.lbl !== a1.lbl, { before: a1.lbl, after: a2.lbl });
    ck('눕힌 상태 유지', a2.lay === true, a2.lay);
    ck('회전도 유지', /matrix\(\s*0,\s*1,\s*-1,\s*0/.test(a2.matrix), a2.matrix);

    await win.webContents.executeJavaScript("document.getElementById('layBtn').click()");
    await new Promise(r => setTimeout(r, 500));
    const a3 = await win.webContents.executeJavaScript(READ);
    console.log('\n[4] 정상으로 복귀');
    ck('lay90 꺼짐', a3.lay === false && a3.on === false, a3);
    ck('회전 없음', a3.matrix === 'none' || a3.matrix === '', a3.matrix);
    ck('원래 크기로', Math.abs(a3.pageW - a0.pageW) <= 2, { before: a0.pageW, after: a3.pageW });
  } catch (e) { console.log('  ✘ 하네스 오류:', e && e.message); fail++; }
  try { fs.unlinkSync(f); } catch (e) {}
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
