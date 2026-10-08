// E-book 시안 워터마크 — 안내 문구 고치기·목록 저장, 이미지 워터마크(자리 9곳·크기·진하기·좌우 반대)·목록 저장
//   실행: npx electron scripts/test/ebook-watermark.e2e.js
// 사용자 요청(2026-10-08): 안내 문구를 수정·목록 저장, 워터마크에 이미지 삽입 + 위치 지정(가운데·상하좌우 가장자리 등) + 목록 저장.
// 확인: 앱 함수로 문구·이미지 목록 저장/불러오기/지우기 → 시안 HTML(buildEbookProofHtml)을 실제로 열어
//       빨간 정사각형 로고가 오른쪽 쪽은 오른쪽 아래, 왼쪽 쪽(좌우 반대)은 왼쪽 아래에 찍히는지 화소로 본다.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { leftWin } = require('./_leftwin');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
const UD = path.join(os.tmpdir(), 'pdfedit-ebwm-e2e');
try { fs.rmSync(UD, { recursive: true, force: true }); } catch (e) {}
app.setPath('userData', UD);
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1300, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 3 && !/No handler|Security/.test(msg)) console.log('  [앱] ' + msg.slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await sleep(2500);

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try {
    window.confirm = () => true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // ── 안내 문구 ──
    setEbWm('notice');
    ck('안내 켜면 문구 설정이 보인다', document.getElementById('ebWmSet').style.display !== 'none' && document.getElementById('ebNoteSet').style.display !== 'none');
    ck('처음 문구 = 기본 문구', document.getElementById('ebNoteText').value === EBOOK_NOTE_TEXT);
    const ta = document.getElementById('ebNoteText');
    ta.value = '테스트 인쇄소 확인용 <시안>'; ebNoteTextChanged();
    ck('고친 문구가 쓰인다(꺾쇠는 빠짐)', ebNoteText() === '테스트 인쇄소 확인용 시안', ebNoteText());
    ebNoteSave();
    ta.value = '두 번째 문구'; ebNoteTextChanged(); ebNoteSave();
    ck('문구 목록 2개', JSON.parse(localStorage.getItem('ebNoteList')).length === 2 && document.getElementById('ebNoteList').options.length === 3);
    ebNotePick('0');
    ck('목록에서 고르면 그 문구', ebNoteText() === '테스트 인쇄소 확인용 시안' && ta.value === '테스트 인쇄소 확인용 시안');
    document.getElementById('ebNoteList').value = '1'; ebNoteDelete();
    ck('목록에서 지우기', JSON.parse(localStorage.getItem('ebNoteList')).length === 1);
    // ── 이미지 워터마크 (빨간 정사각형 100×100) ──
    const c = document.createElement('canvas'); c.width = c.height = 100;
    const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 100, 100);
    ebWmImgSave({ on: true, u: c.toDataURL('image/png'), w: 100, h: 100, name: '빨간 로고' });
    setEbWmPos('br'); document.getElementById('ebWmImgSize').value = '20'; document.getElementById('ebWmImgOp').value = '100'; ebWmImgNumChanged();
    ebWmImgMirrorChanged(true);
    const im = ebWmImg();
    ck('이미지 설정 기억(자리·크기·진하기·좌우 반대)', im.on && im.pos === 'br' && im.size === 20 && im.op === 100 && im.mirror, { pos: im.pos, size: im.size, op: im.op, mirror: im.mirror });
    ck('버튼 표시: 안내 + 이미지', /안내 \\+ 이미지/.test(document.getElementById('ebWmBtn').textContent), document.getElementById('ebWmBtn').textContent);
    ck('자리 버튼 ↘가 켜짐', document.querySelector('[data-ebwmpos="br"]').classList.contains('active'));
    ebWmImgListSave();
    setEbWmPos('c'); ebWmImgMirrorChanged(false);
    ebWmImgListPick('0');
    const im2 = ebWmImg();
    ck('이미지 목록에서 고르면 저장한 자리·좌우 반대로', im2.pos === 'br' && im2.mirror && JSON.parse(localStorage.getItem('ebWmImgList')).length === 1);
    // ── 시안 HTML (생성 버튼과 같은 opts 모양) ──
    const pg = document.createElement('canvas'); pg.width = 420; pg.height = 594;
    const pc = pg.getContext('2d'); pc.fillStyle = '#fff'; pc.fillRect(0, 0, 420, 594);
    pc.fillStyle = '#ccc'; pc.fillRect(60, 80, 300, 30);
    const u = pg.toDataURL('image/jpeg', 0.9);
    const book = [0, 1, 2, 3].map(() => ({ u, w: 420, h: 594 }));
    const html = buildEbookProofHtml({ title: '워터마크 검사', meta: { mm: [210, 297], bind: 'left', view: 'spread', target: 'web', bindStyle: 'book' },
      book, sheets: [], opts: { watermark: _ebOpts.wm, wmText: '시안', noteText: ebNoteText(), trimPct: 0, coverSingle: true, wmImg: ebWmImg().on ? ebWmImg() : null } });
    ck('시안 HTML에 고친 안내 문구가 들어감', html.indexOf(encodeURIComponent('테스트 인쇄소 확인용 시안')) > 0);
    const p = html;   // 바깥에서 .html 파일로 쓴다(writeTempFile은 .pdf로 저장)
    // 이미지 끄면 시안에서도 빠짐
    setEbWmImgOn(false);
    const html2 = buildEbookProofHtml({ title: 'x', meta: { mm: [210, 297] }, book, sheets: [], opts: { watermark: false, wmImg: ebWmImg().on ? ebWmImg() : null } });
    ck('이미지 끄면 시안에 이미지 없음', JSON.parse(html2.match(/var D=(\\{.*?\\});\\n/) ? '{}' : '{}') && html2.indexOf('"wmi":""') > 0);
    return { out, p };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); return { out }; }
  })()`);

  if (res.p) {
    { const hp = path.join(os.tmpdir(), 'pdfedit_ebwm_test.html'); fs.writeFileSync(hp, res.p); res.p = hp; }
    // 시안 열기 — 2쪽(오른쪽 단독 표지 다음 펼침면 2|3)으로 가서 쪽 상자 위치의 화소를 본다
    // 넘김 애니메이션을 돌려야 하므로 보이는 창(숨긴 창은 rAF가 1fps) — 가장 왼쪽 모니터
    const v = new BrowserWindow({ show: true, width: 1400, height: 900, ...leftWin(1400, 900), useContentSize: true, webPreferences: { contextIsolation: true } });
    await v.loadFile(res.p);
    await sleep(1200);
    const boxes = await v.webContents.executeJavaScript(`(async () => {
      document.body.classList.remove('paper');
      const n = document.querySelectorAll('.wmi').length;
      // 다음 펼침면으로(→ 키)
      document.getElementById('next').click();
      await new Promise(r => setTimeout(r, 2500));
      const bs = [...document.querySelectorAll('[data-side]')].filter(e => e.getBoundingClientRect().width > 50).map(e => { const r = e.getBoundingClientRect(); return { side: e.getAttribute('data-side'), x: r.left, y: r.top, w: r.width, h: r.height, wmi: !!e.querySelector('.wmi') }; });
      return { n, bs };
    })()`);
    const img = await v.webContents.capturePage();
    const sz = img.getSize(), bm = img.toBitmap();   // BGRA
    const scale = sz.width / (await v.webContents.executeJavaScript('innerWidth'));
    const px = (x, y) => { const i = (Math.round(y * scale) * sz.width + Math.round(x * scale)) * 4; return [bm[i + 2], bm[i + 1], bm[i]]; };
    const red = ([r, g, b]) => r > 200 && g < 80 && b < 80;
    const corner = (b, where) => {   // 로고 중심: 가장자리 4% + 크기 20%의 절반
      const cx = where === 'r' ? b.x + b.w * (1 - 0.04 - 0.10) : b.x + b.w * (0.04 + 0.10);
      const cy = b.y + b.h - b.w * (0.04 + 0.10);
      return red(px(cx, cy));
    };
    const L = boxes.bs.find(b => b.side === '0'), R = boxes.bs.find(b => b.side === '1');
    res.out.push([boxes.n > 0 ? '✔' : '✘', '시안에 이미지 워터마크 층이 있다', JSON.stringify(boxes.n)]);
    if (L && R) {
      res.out.push([corner(R, 'r') && !corner(R, 'l') ? '✔' : '✘', '오른쪽 쪽: 오른쪽 아래에 로고', JSON.stringify(R)]);
      res.out.push([corner(L, 'l') && !corner(L, 'r') ? '✔' : '✘', '왼쪽 쪽: 좌우 반대 → 왼쪽 아래에 로고', JSON.stringify(L)]);
      const mid = px(R.x + R.w / 2, R.y + R.h / 2);
      res.out.push([!red(mid) ? '✔' : '✘', '쪽 가운데에는 로고 없음', JSON.stringify(mid)]);
    } else res.out.push(['✘', '펼침면 쪽 상자를 못 찾음', JSON.stringify(boxes.bs)]);
    fs.writeFileSync(path.join(os.tmpdir(), 'pdfedit_ebwm_shot.png'), img.toPNG());
    try { fs.unlinkSync(res.p); } catch (e) {}
  }
  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
