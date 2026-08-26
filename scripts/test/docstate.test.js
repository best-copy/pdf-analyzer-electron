// 📄 문서 상태 스냅샷(captureDocState / restoreDocState) 검증
// — src/app-ui.js의 **실제 함수를 추출해** 돌린다(복사본 금지, CLAUDE.md 7.2).
// 작업 파일(.pdfw)·최근 작업 기록이 공유하는 경로라, 여기서 빠지는 필드는 두 기능 모두에서 증발한다.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

function extract(src, header) {
  const s = src.indexOf(header);
  if (s < 0) throw new Error('함수를 찾을 수 없습니다: ' + header);
  let i = src.indexOf('{', s), depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(s, j + 1); }
  }
  throw new Error('닫는 괄호를 찾지 못했습니다: ' + header);
}

const ui = fs.readFileSync(path.join(ROOT, 'src/app-ui.js'), 'utf8');
const body = extract(ui, 'function captureDocState()') + '\n' + extract(ui, 'function restoreDocState(ds)');

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

// 앱 전역 대역 — 실제 앱과 같은 이름·모양만 갖춘 최소 환경
function mkEnv(pages, selected, pageAdjust) {
  const env = {
    pageResults: pages,
    selectedPages: new Set(selected || []),
    editSettings: { pageAdjust: pageAdjust || {} },
    console,
  };
  const fn = new Function(...Object.keys(env), body + '\nreturn { captureDocState, restoreDocState };');
  return { api: fn(...Object.values(env)), env };
}
const page = (oi, extra) => Object.assign({ pageNum: oi + 1, originalIdx: oi, isColor: false, isBlank: false, rotation: 0, thumbnail: 'T' + oi }, extra || {});

console.log('\n[1] 순서·회전·흑백확정·선택 왕복');
{
  const src = [page(0, { rotation: 90 }), page(1, { appliedBw: true }), page(2, { chapter: '본문' })];
  const { api } = mkEnv(src, [1, 3], { 2: { dx: 3 } });
  const snap = api.captureDocState();
  // 새로 분석한 문서(순서·회전 전부 초기값)에 스냅샷을 되씌운다
  const fresh = [page(0), page(1), page(2)];
  const { api: api2, env: env2 } = mkEnv(fresh, [], {});
  ck('복원 성공', api2.restoreDocState(snap) === true);
  ck('회전 복원', env2.pageResults[0].rotation === 90, env2.pageResults[0].rotation);
  ck('흑백확정 복원', env2.pageResults[1].appliedBw === true);
  ck('챕터 복원', env2.pageResults[2].chapter === '본문');
  ck('선택 복원', [...env2.selectedPages].join(',') === '1,3');
  ck('개별보정 복원', JSON.stringify(env2.editSettings.pageAdjust) === '{"2":{"dx":3}}');
}

console.log('\n[2] 📑 목차 페이지 표식·북마크 제목 (작업 파일 복원의 핵심)');
{
  const src = [page(0, { isTocPage: true }), page(1, { tocTitle: '1장 서론' }), page(2, { isRoman: true })];
  const { api } = mkEnv(src, [], {});
  const snap = api.captureDocState();
  ck('스냅샷에 목차 표식이 담긴다', snap.order[0].toc === 1, snap.order[0]);
  ck('스냅샷에 북마크 제목이 담긴다', snap.order[1].tt === '1장 서론', snap.order[1]);
  const fresh = [page(0), page(1), page(2)];
  const { api: api2, env: env2 } = mkEnv(fresh, [], {});
  api2.restoreDocState(snap);
  ck('목차 페이지 복원', env2.pageResults[0].isTocPage === true);
  ck('북마크 제목 복원', env2.pageResults[1].tocTitle === '1장 서론');
  ck('로마자 지정 복원', env2.pageResults[2].isRoman === true);
  ck('목차가 아닌 페이지는 표식이 붙지 않는다', env2.pageResults[1].isTocPage === false);
}

console.log('\n[3] 페이지 재배열 + 빈 페이지');
{
  const src = [page(2), page(0), { pageNum: 3, originalIdx: null, isBlank: true, rotation: 0, pageSize: [100, 200] }];
  src.forEach((r, i) => { r.pageNum = i + 1; });
  const { api } = mkEnv(src, [], {});
  const snap = api.captureDocState();
  const fresh = [page(0), page(1), page(2)];
  const { api: api2, env: env2 } = mkEnv(fresh, [], {});
  ck('복원 성공', api2.restoreDocState(snap) === true);
  ck('원본 순서가 뒤바뀐 채로 복원', env2.pageResults.map(r => r.originalIdx).join(',') === '2,0,', env2.pageResults.map(r => r.originalIdx));
  ck('빈 페이지 크기 유지', JSON.stringify(env2.pageResults[2].pageSize) === '[100,200]');
  ck('페이지 번호 재부여', env2.pageResults.map(r => r.pageNum).join(',') === '1,2,3');
}

console.log('\n[4] 다른 문서면 조용히 포기(설정만 남김)');
{
  const { api } = mkEnv([page(0), page(1), page(7)], [], {});
  const snap = api.captureDocState();
  const { api: api2 } = mkEnv([page(0), page(1)], [], {});   // 7번 페이지가 없는 문서
  ck('없는 원본 인덱스 → false', api2.restoreDocState(snap) === false);
  ck('빈 스냅샷 → false', api2.restoreDocState({ order: [] }) === false);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
