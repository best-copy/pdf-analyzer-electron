// E-book 시안 코어 검증 — src/app-process.js의 <EBOOK-CORE> 구간을 **실제 코드 그대로** 떼어 실행한다.
// (테스트용 복사본을 만들면 드리프트가 생긴다 — CLAUDE.md 7.2)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

function loadCore() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
  const s = src.indexOf('// <EBOOK-CORE>');
  const e = src.indexOf('// </EBOOK-CORE>');
  if (s < 0 || e < 0) throw new Error('EBOOK-CORE 마커를 찾을 수 없습니다');
  const body = src.slice(s, e);
  // 순수성 확인: 코어가 **빌드 시점에** 앱 전역·DOM을 만지면 독립 HTML 도구가 조용히 깨진다.
  // EBOOK_JS(생성될 뷰어 스크립트 문자열)는 브라우저에서 도는 코드라 검사에서 제외한다.
  const jsStart = body.indexOf('const EBOOK_JS');
  const jsEnd = body.indexOf("].join('\\n');", jsStart);
  const buildTime = jsStart < 0 ? body : body.slice(0, jsStart) + body.slice(jsEnd < 0 ? jsStart : jsEnd);
  const impure = ['document.', 'pdfjsLib', 'originalPdfBytes', 'pageResults', 'showSuccess', 'localStorage']
    .filter(t => buildTime.includes(t));
  return {
    impure, coreSrc: body,
    api: new Function(body + '\nreturn { ebookSpreads, buildEbookProofHtml, ebookWatermarkUri, EBOOK_CSS, EBOOK_JS };')(),
  };
}

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

const { impure, coreSrc, api } = loadCore();
const { ebookSpreads, buildEbookProofHtml, ebookWatermarkUri } = api;

console.log('\n[1] 코어 순수성');
ck('코어에 DOM·앱 전역 참조 없음', impure.length === 0, impure);
// 닫는 스크립트 태그가 코어에 문자로 들어가면(주석이라도!) 독립 HTML 도구가 그 지점에서 끊긴다.
// 실제로 "</scr␣ipt> 조심" 이라고 쓴 주석 때문에 도구가 통째로 죽은 적이 있다.
ck('코어에 닫는 스크립트 태그 문자열 없음', !coreSrc.includes('</scr' + 'ipt'));

console.log('\n[2] 펼침면(스프레드) 구성');
ck('표지 단독 + 이후 2쪽씩', JSON.stringify(ebookSpreads(8, true, 'left'))
    === JSON.stringify([[null, 0], [1, 2], [3, 4], [5, 6], [7, null]]));
ck('표지 단독 끄면 처음부터 2쪽씩', JSON.stringify(ebookSpreads(4, false, 'left'))
    === JSON.stringify([[0, 1], [2, 3]]));
ck('홀수 쪽이면 마지막은 빈 면', JSON.stringify(ebookSpreads(5, true, 'left'))
    === JSON.stringify([[null, 0], [1, 2], [3, 4]]));
ck('우철은 좌우가 뒤집힘', JSON.stringify(ebookSpreads(4, true, 'right'))
    === JSON.stringify([[0, null], [2, 1], [null, 3]]));
ck('0쪽이면 빈 배열', ebookSpreads(0, true, 'left').length === 0);
ck('1쪽이면 표지 하나', JSON.stringify(ebookSpreads(1, true, 'left')) === JSON.stringify([[null, 0]]));
// 모든 쪽이 정확히 한 번씩만 나와야 한다 (빠지거나 겹치면 고객이 잘못된 시안을 본다)
const seen = ebookSpreads(37, true, 'left').flat().filter(v => v !== null).sort((a, b) => a - b);
ck('37쪽: 모든 쪽이 한 번씩만', seen.length === 37 && seen.every((v, i) => v === i));

console.log('\n[3] HTML 조립');
const img = { u: 'data:image/jpeg;base64,/9j/AAAA', w: 620, h: 877 };
const html = buildEbookProofHtml({
  title: '테스트 <문서> & "인용"',
  meta: { mm: [210, 297], bind: 'left', spec: '210×297mm · 4쪽', date: '2026-08-26', by: '일청기획' },
  book: [img, img, img, img],
  sheets: [img],
  opts: { watermark: true, wmText: '시안', trimPct: 0.014, coverSingle: true },
});
ck('단일 HTML 문서', /^<!DOCTYPE html>/.test(html) && html.trim().endsWith('</html>'));
ck('제목의 특수문자 이스케이프', html.includes('&lt;문서&gt;') && !html.includes('<문서>'));
ck('이미지가 인라인(data URI)', html.includes('data:image/jpeg;base64,/9j/AAAA'));
ck('외부 리소스 참조 없음', !/(src|href)\s*=\s*["'](?!data:)(https?:|\.\/|\/)/i.test(html),
   (html.match(/(src|href)\s*=\s*["'][^"']+/gi) || []).slice(0, 3));
ck('인쇄 대수 토글 버튼 있음', html.includes('id="tabSheet"'));
ck('워터마크 SVG 인라인', html.includes('data:image/svg+xml'));
ck('페이로드에 스프레드 포함', /"spreads":\[\[null,0\],\[1,2\]/.test(html.replace(/\s/g, '')));
ck('재단선 비율 전달', /"trimPct":0\.014/.test(html));

console.log('\n[3-b] 뷰어 구성요소 (책 넘김·페이지 목록·쪽 이동)');
ck('왼쪽 페이지 목록 자리', html.includes('id="rail"') && html.includes('id="railBtn"'));
ck('쪽 이동 입력·버튼', html.includes('id="jump"') && html.includes('id="jumpBtn"') && html.includes('id="jlbl"'));
ck('책 느낌 토글', html.includes('id="paperBtn"'));
ck('낱장 넘김(rotateY) 코드 포함', html.includes('rotateY(') && html.includes('preserve-3d'));
ck('책등 그늘 스타일', html.includes('.gut{'));
// 좌우에 남은 종이가 쌓인 효과는 뺐다(사용자 요청) — 다시 들어오면 이 검사가 잡는다
ck('종이 두께 효과 없음', !html.includes('.edge{') && !html.includes('function edge('));
// 전체화면 버튼 — 휴대폰 가로 보기에서 화면을 통째로 쓴다
ck('전체화면 버튼', html.includes('id="fsBtn"') && html.includes('requestFullscreen'));
// 프레임마다 그라데이션 문자열을 새로 만들면 CSS 재파싱으로 끊긴다 — 투명도만 바꾼다
ck('넘김 중에는 투명도만 갱신', html.includes('.stgu') && html.includes('s.fs.style.opacity=fb')
   && !html.includes('function shade(el,a,b,rev)'));
// 조각별 분배는 가중치 W로 준다(자세한 성질은 아래 '고르게 휘는 분배'에서 확인)
ck('조각별 분배 사용', html.includes('c*W[k]/S'));
// 목록의 빈 면 높이는 퍼센트 padding(줄 폭 기준)이 아니라 비율로 잡아야 옆 칸과 같아진다
ck('목록 빈 칸 높이 = 옆 칸', html.includes('cell.style.aspectRatio') && !html.includes('cell.style.paddingTop'));
// 모바일 가로에서는 눌러도 확대되지 않는다
ck('모바일 가로 확대 없음', html.includes('var noZoom=(MOB&&!single)'));
// 확대 보기는 핀치·끌기로 어디든 볼 수 있어야 한다(처음엔 한 쪽 전체가 보이고, 가장자리까지 닿음)
ck('핀치줌 확대 보기', html.includes('function zFit(') && html.includes('function zClamp(')
   && html.includes('function zZoomAt(') && html.includes('.zimg{'));
ck('확대 보기 닫기 수단', html.includes('.zx{') && html.includes('function zClose('));
// 넘김은 천천히·완만하게 (사인 이징)
// 넘김 시간도 다듬는 값 — 숫자 대신 '느긋한 범위'만 본다(너무 빠르면 목적에 어긋난다)
ck('넘김이 느긋한 범위', (() => { var t=+(html.match(/TURN_MS=(\d+)/)||[0,0])[1];
  return t>=900 && t<=2500; })(), (html.match(/TURN_MS=(\d+)/)||[])[1]);
// 속도 곡선: 가운데가 너무 빠르면 "확 넘어가는" 느낌이 난다 — 최고 속도를 평균의 1.4배 이내로
ck('속도 곡선이 고르다', (() => {
  var ez = function (x) { var t = Math.max(0, Math.min(1, x)); return 0.5*t + 0.5*(0.5-0.5*Math.cos(Math.PI*t)); };
  var mx = 0, prev = 0, h = 0.002;
  for (var x = h; x <= 1; x += h) { var v = (ez(x) - prev) / h; if (v > mx) mx = v; prev = ez(x); }
  return Math.abs(ez(0)) < 1e-9 && Math.abs(ez(1)-1) < 1e-9 && mx < 1.4;
})());
ck('이징 코드 반영', html.includes('0.5*t + 0.5*(0.5-0.5*Math.cos(Math.PI*t))'));
// 휨은 **바깥 끝 각도의 비율**로 준다 — 잘라내기(clamp)가 없어 기울기가 꺾이지 않는다.
// 세기는 계속 다듬는 값이라 숫자를 박지 않고, 실제 상수를 읽어 성질만 본다.
var BENDV = +(html.match(/BEND=([\d\.]+)/) || [0, 0])[1];
ck('휨 상수 읽힘', BENDV > 0 && BENDV < 1, BENDV);
var bend = function (p) { return 180 * p * BENDV * Math.pow(Math.sin(Math.PI * p), 1.6); };
ck('시작·끝에서 휨이 0', bend(0) === 0 && Math.abs(bend(1)) < 1e-9);
ck('가운데에서 충분히 휜다', bend(0.5) > 45 && bend(0.6) > 45, [bend(0.5), bend(0.6)]);
ck('착지 직전에는 거의 평평', bend(0.95) < 10, bend(0.95));
// 억지로 휘었다 갑자기 펴지면 끊겨 보인다 — 진행 1%당 휨 변화가 완만해야 한다
ck('휨 변화가 완만(끊김 없음)', (() => {
  var mx = 0, prev = bend(0);
  for (var i = 1; i <= 100; i++) { var b = bend(i / 100); mx = Math.max(mx, Math.abs(b - prev)); prev = b; }
  return mx < 3.0;
})(), (() => { var mx = 0, prev = bend(0);
  for (var i = 1; i <= 100; i++) { var b = bend(i / 100); mx = Math.max(mx, Math.abs(b - prev)); prev = b; }
  return +mx.toFixed(2); })());
// 한 번만 부풀었다 가라앉아야 한다(오르내림이 여러 번이면 펄럭인다)
ck('휨은 한 번만 부푼다', (() => {
  var dir = 0, flips = 0, prev = bend(0);
  for (var i = 1; i <= 200; i++) {
    var b = bend(i / 200), d = Math.sign(b - prev);
    if (d !== 0 && d !== dir) { if (dir !== 0) flips++; dir = d; }
    prev = b;
  }
  return flips <= 1;
})());
// 바깥쪽 끝 각도는 0→180으로 **단조 증가** — 넘었다가 되돌아오면 한 번 튕겨 보인다
ck('바운스 없음(바깥끝 단조 증가)', (() => {
  var prev = -1;
  for (var i = 0; i <= 200; i++) { var E = 180 * (i / 200); if (E < prev - 1e-6) return false; prev = E; }
  return true;
})());
ck('바깥끝 각도 모델', html.includes('var E=180*p') && html.includes('var m=E-c;')
   && !html.includes('if(c>E)c=E;'));
// 얇은 종이는 한곳이 접히지 않는다 — 조각별 분배(W)를 실제로 계산해 성질을 본다.
// (좁은 가우시안으로 한곳에 몰면 접힌 자국처럼 보였다 — 그 형태는 금지)
ck('가우시안 집중 분배 아님', !html.includes('Math.exp(-dq*dq)'));
var wExpr = (html.match(/W\[q\]=([^;]+);/) || [0, ''])[1];
ck('분배식 읽힘', !!wExpr, wExpr);
var wf = wExpr ? new Function('u', 'return ' + wExpr.split('q/n').join('u') + ';') : null;
ck('분배가 매끄럽고 한곳에 몰리지 않음', (() => {
  if (!wf) return false;
  var mn = Infinity, mx = 0;
  for (var i = 1; i < 100; i++) { var v = wf(i / 100); if (!(v > 0)) return false; mn = Math.min(mn, v); mx = Math.max(mx, v); }
  return mx / mn < 6;      // 최대/최소 6배 이내 = 접힌 자국이 아니라 완만한 곡면
})());
// 휨의 중심(누적 절반 지점)은 책등 쪽(0.25~0.48)에 있어야 한다 — 가운데(0.5)면 어색하다고 했다
ck('휨 중심이 책등 쪽', (() => {
  if (!wf) return false;
  var n = 18, W = [], S = 0, q;
  for (q = 1; q < n; q++) { W[q] = wf(q / n); S += W[q]; }
  var acc = 0;
  for (q = 1; q < n; q++) { acc += W[q]; if (acc >= S / 2) return (q / n) >= 0.25 && (q / n) <= 0.48; }
  return false;
})(), (() => {
  if (!wf) return null;
  var n = 18, W = [], S = 0, q;
  for (q = 1; q < n; q++) { W[q] = wf(q / n); S += W[q]; }
  var acc = 0;
  for (q = 1; q < n; q++) { acc += W[q]; if (acc >= S / 2) return +(q / n).toFixed(2); }
  return null;
})());
// style.display는 처음에 빈 문자열이라 '열림' 판정에 쓰면 드래그가 아예 안 된다(실제로 그랬다)
ck('확대 열림 판정은 요소로', html.includes('if(zImg)return;') && !html.includes('zv.style.display!=="none")return'));
// 넘김 표시를 클릭해도 넘어가야 한다(누르는 순간 낱장이 잡히므로 클릭만으로는 되돌아갔었다)
ck('넘김 표시 클릭으로 넘김', html.includes('drag.nav') && html.includes('navTap'));
// 낱장은 여러 조각(.st)을 경첩처럼 이어 붙여 휘게 만든다 — 한 판때기로 돌면 뻣뻣해 보인다
ck('낱장이 조각으로 휘는 구조', html.includes('.st{') && html.includes('.sfc{') && html.includes('.sbc{')
   && html.includes('function buildLeaf') && html.includes('BEND'));
// 넘김 중 스크롤바가 생겼다 사라지면 화면이 좌우로 떨린다 → 무대는 고정, 실제 크기 모드만 스크롤
ck('무대 고정(떨림 방지)', /\.stage\{[^}]*overflow:hidden/.test(html)
   && html.includes('.realsize .stage{overflow:auto'));
// 책 느낌을 끄면 연출 없이 곧바로 교체돼야 한다(흐려졌다 나타나면 깜박임으로 보인다)
ck('책 느낌 끄면 즉시 교체', html.includes('if(V!=="book"||!paper){ i=n; render(); return; }'));
// 목록은 화면과 같이 펼침면(두 쪽)을 한 줄에
ck('목록이 펼침면 두 쪽 구성', html.includes('.rp{') && html.includes('data-v'));
// 손으로 잡고 끄는 넘김(마우스·터치 공용) — 포인터 이벤트 한 벌로 처리한다
ck('드래그로 넘기기', html.includes('pointerdown') && html.includes('pointermove')
   && html.includes('pointerup') && html.includes('function poseLeaf'));
ck('끄는 동안 화면이 스크롤되지 않게', /\.stage\{[^}]*touch-action:none/.test(html));
// 넘기는 동안 아래에는 「지금 쪽 + 드러날 쪽」을 깐다 — 목적지 펼침면을 통째로 깔면
// 반대쪽 페이지가 시작하자마자 툭 바뀐다
ck('넘김 중 섞인 펼침면', html.includes('function beginTurn') && html.includes('mixed'));
// 책등 그늘이 낱장에도 이어져야 가운데 음영이 사라졌다 나타나지 않는다
ck('책등 그늘이 낱장에도 이어짐', html.includes('gutAt') && html.includes('GUTS'));
// 빈 면도 화면에서 한 쪽 자리를 차지한다 — 폭 계산에서 빼면 좁은 화면에서 책이 잘린다
ck('빈 면도 폭 계산에 포함', html.includes('else if(book){ w+=rw;'));
ck('휴대폰 화면 대응', html.includes('@media (max-width:760px)') && html.includes('NARROW'));
// 📱 모바일용으로 만들면 세로=한 쪽씩, 가로=두 쪽 가득(막대 자동 숨김)
ck('보는 기기 기본은 웹용', /"target":"web"/.test(html));
ck('한 쪽씩 보기·몰입 보기 코드', html.includes('single') && html.includes('immersive')
   && html.includes('.mob .stage'));
const mob = buildEbookProofHtml({
  title: 'm', meta: { mm: [210, 297], bind: 'left', target: 'mobile' },
  book: [img, img, img], sheets: [], opts: {},
});
ck('모바일용으로 표시됨', /"target":"mobile"/.test(mob));
ck('엉뚱한 값은 웹용으로', /"target":"web"/.test(buildEbookProofHtml({
  title: 'x', meta: { target: '이상한값' }, book: [img], opts: {} })));
// localStorage는 file:·data: 환경에서 접근 자체가 예외를 던진다 —
// 감싸지 않으면 뷰어 스크립트가 첫 줄에서 죽어 화면이 통째로 빈다(실제로 그랬다).
ck('localStorage 첫 접근이 try로 감싸짐', html.includes('try{ MM=Number(localStorage')
   && !html.includes('var MM=Number(localStorage'));
// 낱장을 미디어쿼리로 숨기면 윈도우 '애니메이션 표시'를 끈 PC에서 넘김이 아예 안 보인다
ck('reduced-motion으로 낱장을 숨기지 않음',
   !/prefers-reduced-motion[^}]*\\.leaf{display:none/.test(html));

console.log('\n[4] 스크립트 조기 종료 방어');
// 페이로드 문자열에 </script>가 들어가면 브라우저가 거기서 스크립트를 끊는다 → 뷰어 전체가 죽는다
const evil = buildEbookProofHtml({
  title: 'x', meta: {}, book: [{ u: 'data:image/jpeg;base64,AAA</script><b>깨짐', w: 10, h: 10 }],
  opts: {},
});
ck('페이로드의 </script>가 이스케이프됨', !evil.includes('AAA</script>') && evil.includes('AAA<\\/script>'));
const scriptOpens = (evil.match(/<script/gi) || []).length;
const scriptCloses = (evil.match(/<\/script>/gi) || []).length;
ck('script 태그 짝이 맞음', scriptOpens === 2 && scriptCloses === 2, { scriptOpens, scriptCloses });

console.log('\n[5] 인쇄 대수 없을 때');
const only = buildEbookProofHtml({ title: 'x', meta: {}, book: [img], sheets: [], opts: {} });
ck('시트 없으면 토글 버튼도 없음', !only.includes('id="tabSheet"'));
ck('워터마크 끄면 빈 값', /"wm":""/.test(only));

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
