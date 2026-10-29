// 📊 사용 기록 — 글 지우기(usageSanitize) 단위 검사 (smoke): 파일 이름·경로·따옴표 안·메일·전화가 남지 않는다
'use strict';
const path = require('path');
const { usageSanitize: S } = require(path.join(__dirname, '..', '..', 'src', 'usage-log.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const cases = [
  ["💾 저장했습니다 — 홍길동_견적서.pdf (3.2MB)", '홍길동', '파일 이름'],
  ["'(주)대한상사 사업계획서' 외 2개 문서를 받았습니다", '대한상사', '따옴표 안 문서 이름'],
  ['덮어쓴 파일: D:\\고객\\김철수\\결과.pdfw', '김철수', '윈도 경로'],
  ['열 수 없음: \\\\NAS\\공유\\비밀.hwp', '비밀', '네트워크 경로'],
  ['보낼 곳 kim.cs@example.co.kr 로 전송', 'example', '메일'],
  ['연락처 010-1234-5678 확인', '5678', '전화'],
  ['“신규 고객” 탭을 열었습니다', '신규 고객', '둥근 따옴표'],
  ['문서번호 202610290001', '202610290001', '긴 숫자'],
];
for (const [inp, bad, what] of cases) { const out = S(inp); ok(!out.includes(bad), `${what}: ${out}`); }
ok(S('🧹 267쪽을 정리했습니다 · 18.8초') === '🧹 267쪽을 정리했습니다 · 18.8초', '기능 이름·숫자는 그대로');
ok(S('가'.repeat(100), 10).length === 11, '길이 제한');
console.log(`\nusage-log: 통과 ${pass} · 실패 ${fail}`);
if (fail) process.exit(1);
