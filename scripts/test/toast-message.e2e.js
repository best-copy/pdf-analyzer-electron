// 🔔 알림(성공·오류) 토스트 — 스크롤과 무관하게 화면에 떠 있고, 닫기로 없앨 수 있다
//   실행: npx electron scripts/test/toast-message.e2e.js
// 회귀: 예전엔 문서 맨 위에 붙박이(정적 배너)라 아래로 스크롤하면 '적용 완료' 안내가 보이지 않았다.
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-toast'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const el = document.getElementById('success'), er = document.getElementById('error');
    const box = e => e.getBoundingClientRect();

    showSuccess('적용 완료! 60페이지 흑백 변환됨\\n두 번째 줄도 보입니다.');
    await sleep(300);
    const st = getComputedStyle(el);
    ck('성공 알림이 화면에 고정(fixed)', st.position === 'fixed', st.position);
    ck('화면 아래쪽 가운데', Math.abs((box(el).left + box(el).width / 2) - window.innerWidth / 2) < 3
       && box(el).bottom <= window.innerHeight && box(el).bottom > window.innerHeight - 200,
       { mid: box(el).left + box(el).width / 2, half: window.innerWidth / 2, bottom: box(el).bottom, h: window.innerHeight });
    ck('여러 줄 그대로(pre-line)', st.whiteSpace === 'pre-line' && /두 번째 줄/.test(el.textContent));
    ck('둥근 모서리·그림자(애플식)', parseFloat(st.borderRadius) >= 14 && st.boxShadow !== 'none', [st.borderRadius, st.boxShadow.slice(0, 24)]);

    // 스크롤해도 같은 자리
    const before = box(el).top;
    document.body.style.minHeight = '3000px';
    window.scrollTo(0, 1500);
    await sleep(300);
    ck('아래로 스크롤해도 같은 자리에 보인다', Math.abs(box(el).top - before) < 2 && el.style.display !== 'none',
       { before, after: box(el).top, scrollY: window.scrollY });
    document.body.style.minHeight = '';
    window.scrollTo(0, 0);

    // 진행 토스트가 뜨면 위로 비켜선다
    const bottomAlone = box(el).bottom;
    showLoading('처리 중…');
    await sleep(250);
    ck('진행 토스트가 뜨면 위로 비켜선다', box(el).bottom < bottomAlone - 40, { bottomAlone, withLoading: box(el).bottom });
    hideLoading();
    await sleep(250);
    ck('진행이 끝나면 제자리', Math.abs(box(el).bottom - bottomAlone) < 2, box(el).bottom);

    // 닫기 버튼
    const x = el.querySelector('.toast-close');
    ck('닫기 버튼이 있다', !!x);
    x.click();
    await sleep(150);
    ck('닫기를 누르면 사라진다', el.style.display === 'none');

    // 오류 알림도 같은 규칙 + 글자를 바꿔도 닫기 버튼이 남는다
    showError('오류 예시');
    await sleep(200);
    ck('오류 알림도 고정', getComputedStyle(er).position === 'fixed');
    showError('두 번째 오류');
    await sleep(120);
    ck('글자를 바꿔도 닫기 버튼 유지', !!er.querySelector('.toast-close') && /두 번째 오류/.test(er.textContent));
    ck('성공·오류는 함께 뜨지 않는다', el.style.display === 'none');
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
