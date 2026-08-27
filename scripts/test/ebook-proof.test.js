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
ck('책등 그늘·종이 두께 스타일', html.includes('.gut{') && html.includes('.edge{'));
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
