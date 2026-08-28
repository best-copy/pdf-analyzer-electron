// 📐 열 순서 정하기 창 — 우측/하단/모서리 끌어 크기 조절 E2E (실제 앱 화면 구동)
//   실행: npx electron scripts/test/order-resize.e2e.js
// 오프스크린 BrowserWindow에 src/index.html을 실제 preload와 함께 띄우고,
// 손잡이에 포인터 드래그를 흘려 넣어 폭·높이가 의도대로만 변하는지 확인한다.
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));   // 부트스트랩 완료 대기

  const script = `(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try { localStorage.removeItem('orderPanelSize'); } catch (e) {}
    showOpenOrderDialog([{name:'A.pdf',path:'C:/x/A.pdf'},{name:'B.pdf',path:'C:/x/B.pdf'},{name:'C.pdf',path:'C:/x/C.pdf'}]);
    await new Promise(r => requestAnimationFrame(r));
    const el = document.getElementById('orderPanel');
    ck('모달이 열림', document.getElementById('orderModal').style.display === 'block');
    ck('행 3개 렌더', document.querySelectorAll('#orderRows .ord-row').length === 3);
    ck('손잡이 3개(우측·하단·모서리)', document.querySelectorAll('#orderPanel .ord-grip').length === 3);

    const drag = async (sel, dx, dy) => {
      const g = document.querySelector(sel);
      const b = g.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const ev = (t, cx, cy, tgt) => (tgt || document).dispatchEvent(new PointerEvent(t, { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      ev('pointerdown', x, y, g);
      ev('pointermove', x + dx, y + dy);
      ev('pointerup', x + dx, y + dy);
      await new Promise(r => requestAnimationFrame(r));
    };

    let w0 = el.offsetWidth, h0 = el.offsetHeight;
    await drag('.ord-grip-r', 160, 90);
    ck('우측 가장자리 → 가로만 커짐', el.offsetWidth === w0 + 160 && el.offsetHeight === h0, [w0, el.offsetWidth, h0, el.offsetHeight]);

    w0 = el.offsetWidth; h0 = el.offsetHeight;
    await drag('.ord-grip-b', 120, 70);
    ck('하단 가장자리 → 세로만 커짐', el.offsetHeight === h0 + 70 && el.offsetWidth === w0, [w0, el.offsetWidth, h0, el.offsetHeight]);

    w0 = el.offsetWidth; h0 = el.offsetHeight;
    await drag('.ord-grip-c', 50, 40);
    ck('모서리 → 가로·세로 동시', el.offsetWidth === w0 + 50 && el.offsetHeight === h0 + 40, [w0, el.offsetWidth, h0, el.offsetHeight]);

    // 화면보다 크게
    await drag('.ord-grip-c', 2000, 2000);
    ck('화면보다 크게 확대됨', el.offsetWidth > window.innerWidth && el.offsetHeight > window.innerHeight,
       [el.offsetWidth, window.innerWidth, el.offsetHeight, window.innerHeight]);
    const modal = document.getElementById('orderModal');
    ck('모달이 스크롤 가능(잘리지 않음)', modal.scrollWidth > modal.clientWidth && getComputedStyle(modal).overflow === 'auto');

    // 최소 크기 아래로는 안 줄어듦
    await drag('.ord-grip-c', -9000, -9000);
    ck('최소 크기 유지(380×300)', el.offsetWidth === 380 && el.offsetHeight === 300, [el.offsetWidth, el.offsetHeight]);

    // 크기 기억
    const sz = JSON.parse(localStorage.getItem('orderPanelSize') || 'null');
    ck('크기가 저장됨', sz && sz.w === 380 && sz.h === 300, sz);
    document.getElementById('orderModal').style.display = 'none';
    showOpenOrderDialog([{name:'A.pdf'},{name:'B.pdf'}]);
    await new Promise(r => requestAnimationFrame(r));
    ck('다시 열면 크기 복원', el.offsetWidth === 380 && el.offsetHeight === 300, [el.offsetWidth, el.offsetHeight]);

    // 하단 버튼은 한 줄
    const foot = [...document.querySelectorAll('#orderFooter .ord-foot')];
    const tops = new Set(foot.map(b => Math.round(b.getBoundingClientRect().top)));
    ck('하단 버튼 3개가 한 줄', foot.length === 3 && tops.size === 1, [foot.map(b => b.textContent.trim()), [...tops]]);
    const line = foot.every(b => b.getBoundingClientRect().height < 44);
    ck('버튼 글자가 두 줄로 안 접힘', line, foot.map(b => Math.round(b.getBoundingClientRect().height)));
    ck('닫기 ✕가 제목줄 우측', !!document.getElementById('ordClose') &&
       document.getElementById('ordClose').getBoundingClientRect().right > document.getElementById('orderPanel').getBoundingClientRect().left + 300);
    return out;
  })()`;

  let res;
  try { res = await win.webContents.executeJavaScript(script); }
  catch (e) { console.error('실행 오류:', e && e.message); app.exit(1); return; }
  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
