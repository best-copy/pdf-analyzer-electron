// 🌀 트윈링 제본 검증 — 책등에 골(그늘) 대신 철사 고리와 타공이 보여야 하고,
//   넘기는 동안에도 고리가 종이보다 앞에 있어야 한다(철사가 종이를 꿰고 있으므로).
//   실행: npx electron scripts/test/ebook-twinring.e2e.js
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
const pageImg = () => ({
  u: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="595"><rect width="420" height="595" fill="rgb(250,250,250)"/></svg>'),
  w: 420, h: 595,
});

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

async function look(win, bindStyle, view, mm) {
  const { buildEbookProofHtml } = loadCore();
  const html = buildEbookProofHtml({
    title: '제본 검증', book: Array.from({ length: 8 }, pageImg), sheets: [],
    meta: { mm: (mm || [148, 210]), bind: 'left', view, bindStyle }, opts: { coverSingle: true },
  });
  const f = path.join(os.tmpdir(), `pdfedit_ring_${bindStyle}_${Date.now()}.html`);
  fs.writeFileSync(f, html, 'utf8');
  await win.loadFile(f);
  await new Promise(r => setTimeout(r, 900));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const q = (s) => document.querySelectorAll(s).length;
    const rest = {
      twinClass: document.body.classList.contains('twinring'),
      rings: q('.ringwrap .ring'), punches: q('.ringwrap .punch'), pages: [...document.querySelectorAll('.spread .pg')].filter(b => getComputedStyle(b).visibility !== 'hidden').length,
      ringShadow: q('.ringsh'),
      // 골 그늘은 요소가 있어도 CSS로 숨는다 — 실제로 보이는지로 판정
      gutVisible: [...document.querySelectorAll('.spread .gut')]
                    .filter(e => getComputedStyle(e).display !== 'none').length,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const sp = document.querySelector('.spread');
    const kids = sp ? [...sp.children] : [];
    const iLeaf = kids.findIndex(e => e.classList.contains('leaf'));
    const iRing = kids.findIndex(e => e.classList.contains('ringwrap'));
    return { ...rest, turning: iLeaf >= 0, ringAfterLeaf: iRing > iLeaf, iLeaf, iRing,
             ringsDuringTurn: q('.ringwrap .ring') };
  })()`);
  try { fs.unlinkSync(f); } catch (e) {}
  return out;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1200, height: 860 });
  const edge = async (bindStyle, view) => {
    const { buildEbookProofHtml } = loadCore();
    const html = buildEbookProofHtml({
      title: '가장자리', book: Array.from({ length: 6 }, pageImg), sheets: [],
      meta: { mm: [148, 210], bind: 'left', view: (view || 'spread'), bindStyle },
      opts: { coverSingle: true },        // 표지 단독 → 첫 장 [빈, 표지], 마지막 장 [내용, 빈]
    });
    const f2 = path.join(os.tmpdir(), `pdfedit_edge_${bindStyle}_${Date.now()}.html`);
    fs.writeFileSync(f2, html, 'utf8');
    await win.loadFile(f2);
    await new Promise(r => setTimeout(r, 800));
    const read = () => win.webContents.executeJavaScript(`(() => {
      const bs = [...document.querySelectorAll('.spread .pg')];
      const bl = bs.filter(b => b.classList.contains('blank'));
      const bg = bl.length ? getComputedStyle(bl[0]).backgroundColor : '';
      const vis = bs.filter(b => getComputedStyle(b).visibility !== 'hidden');
      return { boxes: vis.length, slots: bs.length, blanks: bl.length, blankBg: bg,
               side: vis.length ? vis[0].getAttribute('data-side') : null,
               pageW: vis.length ? vis[0].offsetWidth : 0,
               lbl: (document.getElementById('lbl') || {}).textContent };
    })()`);
    const first = await read();
    await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
    await new Promise(r => setTimeout(r, 2200));
    const mid = await read();
    await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
    await new Promise(r => setTimeout(r, 500));
    const last = await read();
    try { fs.unlinkSync(f2); } catch (e) {}
    return { first, mid, last };
  };
  try { await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); } catch (e) {}
  try {
    console.log('\n[1] 트윈링 — 고리·타공이 있고 책등 골은 없다');
    const t = await look(win, 'twinring', 'spread');
    ck('body.twinring 켜짐', t.twinClass === true, t);
    ck('철사 고리가 여러 개', t.rings >= 8, t.rings);
    ck('타공은 보이는 면마다 한 줄', t.punches === t.rings * t.pages, { rings: t.rings, punches: t.punches, pages: t.pages });
    ck('고리 그림자 있음', t.ringShadow === 1, t.ringShadow);
    ck('책등 골(그늘)은 보이지 않음', t.gutVisible === 0, t.gutVisible);
    ck('넘기는 중에도 고리가 유지됨', t.ringsDuringTurn === t.rings, t.ringsDuringTurn);
    ck('고리가 넘어가는 종이보다 앞', t.turning && t.ringAfterLeaf, { iLeaf: t.iLeaf, iRing: t.iRing });

    console.log('\n[2] 책자 제본 — 대조군: 골이 있고 고리는 없다');
    const b = await look(win, 'book', 'spread');
    ck('body.twinring 꺼짐', b.twinClass === false, b);
    ck('고리 없음', b.rings === 0, b.rings);
    ck('책등 골이 보임', b.gutVisible >= 1, b.gutVisible);

    console.log('\n[2-b] 타공 수 — 3:1 피치 A4 34홀 기준');
    const a4 = await look(win, 'twinring', 'spread', [210, 297]);
    ck('A4(297mm)는 34홀', a4.rings === 34, a4.rings);
    const a5 = await look(win, 'twinring', 'spread', [148, 210]);
    ck('A5(210mm)는 24홀 — 변 길이에 비례', a5.rings === 24, a5.rings);
    const a3 = await look(win, 'twinring', 'spread', [297, 420]);
    ck('A3(420mm)는 48홀', a3.rings === 48, a3.rings);

    console.log('\n[3] 단면 + 트윈링 — 같이 써도 고리가 나온다');
    const s = await look(win, 'twinring', 'single');
    ck('고리가 그려짐', s.rings >= 8, s.rings);
    ck('책등 골 없음', s.gutVisible === 0, s.gutVisible);
    console.log('\n[4] 트윈링 — 닫힌 책: 앞표지만 / 뒤표지만');
    const tw = await edge('twinring');
    // 종이가 없는 면은 자리째 만들지 않는다 → 한 면만 보이고 화면 가운데에 놓인다
    ck('첫 장: 한 면만 보인다', tw.first.boxes === 1, tw.first);
    ck('첫 장: 보이는 빈 면이 없다', tw.first.boxes === 1, tw.first);
    ck('첫 장: 그 면은 오른쪽(앞표지)', tw.first.side === '1', tw.first.side);
    ck('마지막 장: 한 면만 보인다', tw.last.boxes === 1, tw.last);
    ck('마지막 장: 그 면은 왼쪽(뒤표지)', tw.last.side === '0', tw.last.side);
    ck('가운데 펼침면은 두 면', tw.mid.boxes === 2, tw.mid);
    ck('닫힌 표지도 펼침면과 같은 크기', Math.abs(tw.first.pageW - tw.mid.pageW) <= 2,
       { cover: tw.first.pageW, spread: tw.mid.pageW });

    console.log('\n[4-b] 단면 + 트윈링 — 첫 장에는 앞장이 없으니 백지도 없다');
    const sv = await edge('twinring', 'single');
    ck('첫 장: 인쇄면 한 장만', sv.first.boxes === 1, sv.first);
    ck('가운데 쪽: 앞장의 뒷면(백지)이 실제로 있다', sv.mid.boxes === 2 && sv.mid.blanks === 1, sv.mid);

    console.log('\n[5] 책자 제본 — 대조군: 빈 자리가 옅게 보인다');
    const bk = await edge('book');
    ck('빈 면이 옅게 칠해져 있음', /^rgba\(255, 255, 255, 0\.0/.test(bk.first.blankBg), bk.first.blankBg);
  } catch (e) {
    console.log('  ✘ 하네스 오류:', e && e.message); fail++;
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
