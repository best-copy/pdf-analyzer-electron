// 📄 저장 파일명 규칙 — 조판 표기(2up·중철 등)가 이미 있으면 표기를 또 붙이지 않고
//    끝 번호만 올린다. 실행: node scripts/test/download-name.test.js
// ⚠ 테스트용 복사본을 만들지 않는다 — app-core.js에서 실제 함수를 추출해 돌린다(CLAUDE.md 7-2).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ck = (n, got, want) => {
  if (got === want) { pass++; console.log('  ✔', n, '→', got); }
  else { fail++; console.log('  ✘', n, '→', JSON.stringify(got), '(기대:', JSON.stringify(want) + ')'); }
};

// app-core.js는 CRLF — 줄바꿈을 맞춰 두지 않으면 앵커를 못 찾는다
const src = fs.readFileSync(path.join(ROOT, 'src/app-core.js'), 'utf8').split('\r\n').join('\n');
const cut = (marker, end) => {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('app-core.js에서 못 찾음: ' + marker);
  const j = src.indexOf(end, i);
  if (j < 0) throw new Error('끝을 못 찾음: ' + marker);
  return src.slice(i, j + end.length);
};
const NL = '\n';
const code = [
  cut('const IMP_TAG_RE =', NL),
  cut('function nameWithImpTag(base, tag) {', NL + '    }' + NL),
  'return nameWithImpTag;',
].join(NL);
const nameWithImpTag = new Function(code)();

console.log('\n[1] 표기가 없던 이름 — 평소대로 태그를 붙인다');
ck('국어',            nameWithImpTag('국어', '2up'), '국어_2up');
ck('국어 워크시트',    nameWithImpTag('국어 워크시트', '중철'), '국어 워크시트_중철');
ck('정합4up 태그',     nameWithImpTag('문서', '정합4up'), '문서_정합4up');

console.log('\n[1-2] 임포징을 하지 않으면(빈 태그) 표기를 붙이지 않는다');
ck('표기 없는 이름',   nameWithImpTag('국어 워크시트', ''), '국어 워크시트');
ck('밑줄이 남지 않음', /_$/.test(nameWithImpTag('문서', '')), false);
ck('이미 표기 있으면', nameWithImpTag('국어_2up', ''), '국어_2up-1');
ck('표기+번호',        nameWithImpTag('국어_2up-3', ''), '국어_2up-4');
ck('정합',            nameWithImpTag('안내문', '정합4up'), '안내문_정합4up');

console.log('\n[2] 이미 표기가 있으면 — 태그를 더 붙이지 않고 번호만 올린다');
ck('국어_2up',        nameWithImpTag('국어_2up', '2up'), '국어_2up-1');
ck('국어_2up-1',      nameWithImpTag('국어_2up-1', '2up'), '국어_2up-2');
ck('국어_2up-9',      nameWithImpTag('국어_2up-9', '2up'), '국어_2up-10');
ck('문서_1up',        nameWithImpTag('문서_1up', '1up'), '문서_1up-1');
ck('국어_중철',        nameWithImpTag('국어_중철', '중철'), '국어_중철-1');
ck('다른 태그여도',    nameWithImpTag('국어_2up', '중철'), '국어_2up-1');
ck('모아찍기2x2양면',  nameWithImpTag('안내문_모아찍기2x2양면', '중철'), '안내문_모아찍기2x2양면-1');
ck('반복3x2',         nameWithImpTag('스티커_반복3x2', '반복3x2'), '스티커_반복3x2-1');

console.log('\n[3] 금액 표기는 떼고 다시 붙인다 (이것도 쌓이던 항목)');
ck('국어_2up_12000원', nameWithImpTag('국어_2up_12000원', '2up'), '국어_2up-1');
ck('국어_12000원',     nameWithImpTag('국어_12000원', '2up'), '국어_2up');

console.log('\n[4] 오탐 방지 — 조판 표기가 아닌 이름은 건드리지 않는다');
ck('backup',          nameWithImpTag('backup', '2up'), 'backup_2up');
ck('가이드_10매',      nameWithImpTag('모바일 가이드_10매', '2up'), '모바일 가이드_10매_2up');
ck('P2up(경계 없음)',  nameWithImpTag('설계도P2up', '2up'), '설계도P2up_2up');
ck('숫자로 끝나도',    nameWithImpTag('견적서-2026', '2up'), '견적서-2026_2up');

console.log(`\n${fail ? '✘ 실패' : '✅ 통과'} — ${pass}개 성공, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
