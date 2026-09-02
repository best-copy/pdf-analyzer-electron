// 📄 E-book 시안 '단면(한 쪽씩)' E2E — 만든 시안 HTML을 실제 창에 띄워
//   화면에 페이지가 정말 한 쪽만 그려지는지 확인한다(양면과 대조).
//   실행: npx electron scripts/test/ebook-single.e2e.js
//   ⚠ show:true — 숨김 창은 합성이 안 돼 레이아웃·애니메이션 측정이 어긋난다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

// 코어를 실제 앱 파일에서 그대로 떼어 쓴다 (복사본을 만들면 드리프트)
function loadCore() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
  const s = src.indexOf('// <EBOOK-CORE>'), e = src.indexOf('// </EBOOK-CORE>');
  if (s < 0 || e < 0) throw new Error('EBOOK-CORE 마커 없음');
  return new Function(src.slice(s, e) + '\nreturn { buildEbookProofHtml };')();
}

// 쪽마다 다른 색을 칠한 작은 JPEG 대신, 색 사각형 SVG를 data URI로 (디코드 즉시 가능)
const pageImg = (hue) => ({
  u: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="595">`
    + `<rect width="420" height="595" fill="hsl(${hue},70%,60%)"/></svg>`),
  w: 420, h: 595,
});

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

const READSTATE = `(() => ({
    single: document.body.classList.contains('single'),
    boxes: [...document.querySelectorAll('.spread .pg')].filter(b => getComputedStyle(b).visibility !== 'hidden').length,
    blanks: [...document.querySelectorAll('.spread .pg.blank')].filter(b => getComputedStyle(b).visibility !== 'hidden').length,
    solo: document.querySelectorAll('.spread .pg.s').length,
    gutters: document.querySelectorAll('.spread .gut').length,
    label: (document.querySelector('#lbl') || {}).textContent || '',
    rail: document.querySelectorAll('#rail .ri').length,
}))()`;

// 쪽 번호로 이동해서 그 화면 상태를 읽는다 (하단 '쪽 이동' 입력 사용)
async function jump(win, pageNo) {
  await win.webContents.executeJavaScript(`(() => {
    const j = document.getElementById('jump');
    j.value = '${pageNo}'; document.getElementById('jumpBtn').click();
  })()`);
  // 넘김은 애니메이션이라 끝날 때까지 기다린다 (고정 대기는 중간 상태를 읽는다)
  await win.webContents.executeJavaScript(`(async () => {
    for (let k = 0; k < 160; k++) {
      if (!document.querySelector('.leaf')) return true;
      await new Promise(r => setTimeout(r, 50));
    } return false;
  })()`);
  await new Promise(r => setTimeout(r, 350));
  return win.webContents.executeJavaScript(READSTATE);
}

async function measure(win, file) {
  await win.loadFile(file);
  await new Promise(r => setTimeout(r, 900));
  return win.webContents.executeJavaScript(READSTATE);
}

app.whenReady().then(async () => {
  const { buildEbookProofHtml } = loadCore();
  const book = [0, 60, 120, 180, 240, 300].map(pageImg);   // 6쪽
  const mk = (view) => {
    const html = buildEbookProofHtml({
      title: '단면 검증', book, sheets: [],
      meta: { mm: [148, 210], bind: 'left', view },
      opts: { coverSingle: true },
    });
    const p = path.join(os.tmpdir(), `pdfedit_ebtest_${view}_${Date.now()}.html`);
    fs.writeFileSync(p, html, 'utf8');
    return p;
  };
  const fSingle = mk('single'), fSpread = mk('spread');

  const win = new BrowserWindow({ show: true, width: 1400, height: 900 });
  // 이전 실행이 남긴 '책 느낌 끔' 등이 결과를 바꾸지 않도록 저장소를 비운다
  try { await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); } catch (e) {}

  let ok = true;
  try {
    console.log('\n[1] 단면 — 첫 장·마지막은 한 면만, 가운데는 백지+인쇄면');
    const a = await measure(win, fSingle);
    ck('한 쪽씩 보기(모바일 세로용)로 강제되지 않음', a.single === false, a);
    ck('첫 장: 한 면만 (앞에 넘긴 장이 없다)', a.boxes === 1, a.boxes);
    ck('라벨이 "쪽" 단위', /쪽\s*$/.test(a.label.trim()), a.label);
    ck('6쪽 → 화면도 6개', /\/\s*6\s*쪽/.test(a.label), a.label);
    ck('목록은 인쇄면만 6줄', a.rail === 6, a.rail);
    // 가운데 쪽 — 앞장의 뒷면(흰 종이)이 실제로 있다
    const mid = await jump(win, 3);
    ck('가운데: 백지 + 인쇄면 두 면', mid.boxes === 2 && mid.blanks === 1, mid);
    ck('가운데: 책등 그늘 있음', mid.gutters >= 1, mid.gutters);
    // 마지막 — 뒤에 남은 장이 없으므로 한 면만
    const lastv = await jump(win, 6);
    ck('마지막: 한 면만 (뒤에 남은 장이 없다)', lastv.boxes === 1, lastv);
    ck('마지막: 보이는 백지 없음', lastv.blanks === 0, lastv);

    console.log('\n[2] 양면(펼침) — 대조군');
    const b = await measure(win, fSpread);
    ck('body.single 꺼짐', b.single === false, b);
    // 펼침에서는 표지 맞은편 빈 면도 한 쪽 자리를 차지한다(빼면 배율이 두 배가 된다)
    ck('표지 줄은 빈 면 + 표지 = 상자 2개', b.boxes === 2, b.boxes);
    ck('그중 하나가 빈 면', b.blanks === 1, b.blanks);
    ck('펼침면이라 한 쪽 전용 상자 아님', b.solo === 0, b.solo);
    ck('책등 그늘 있음', b.gutters >= 1, b.gutters);
    ck('라벨이 "펼침" 단위', /펼침\s*$/.test(b.label.trim()), b.label);
    ck('6쪽 → 표지+2+2+1 = 4 펼침', /\/\s*4\s*펼침/.test(b.label), b.label);
  } catch (e) {
    console.log('  ✘ 하네스 오류:', e && e.message);
    ok = false;
  }
  for (const f of [fSingle, fSpread]) { try { fs.unlinkSync(f); } catch (e) {} }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  app.exit(fail || !ok ? 1 : 0);
});
