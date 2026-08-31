/**
 * 🔖 머리글·바닥글 문구 해석 — 워커(worker-assemble.js)와 렌더러가 **함께 쓰는 단일 원본**.
 * 여기 있는 함수는 순수 함수만 유지한다(DOM·앱 전역 참조 금지).
 * 워커: importScripts('./hf-core.js') · 렌더러: index.html의 <script src="hf-core.js">
 * ⚠ 복사본을 따로 만들지 말 것 — 편집기에 보이는 문구와 실제 인쇄물이 갈라진다.
 */
function formatPageNumber(style, page, total) {
  switch (style | 0) {
    case 0: return `${page}`;
    case 2: return `- ${page} -`;
    case 3: return `Page ${page}`;
    case 4: return `${page} 페이지`;
    case 1:
    default: return `${page} / ${total}`;
  }
}

function resolveHF(tpl, ctx) {
  // 로마자 페이지(ctx.roman — 목차·지정 앞붙이)는 번호 토큰이 i, ii…로 치환된다.
  // 번호 시작 페이지(hf.start) 이전의 일반 페이지는 ctx.page ≤ 0 — 번호 토큰만 비운다(다른 문구는 유지).
  return (tpl || '')
    .replace(/\{n\}/g, ctx.roman ? ctx.roman : (ctx.page > 0 ? formatPageNumber(ctx.pnumStyle, ctx.page, ctx.total) : ''))
    .replace(/\{page\}/g, ctx.roman ? ctx.roman : (ctx.page > 0 ? ctx.page : ''))
    .replace(/\{total\}/g, ctx.total)
    .replace(/\{date\}/g, ctx.date)
    .replace(/\{filename\}/g, ctx.filename);
}

// 이 페이지에 머리글·바닥글을 인쇄해야 하는지 (적용 범위)
//   all: 전체 / from: applyFrom쪽부터 끝까지 / pick: applyPages에 든 쪽만
//   (챕터 체크는 렌더러에서 페이지 번호로 펼친 뒤 applyPages로 들어온다)
function hfInScope(H, absPage) {
  const mode = (H && H.applyMode) || 'all';
  if (mode === 'from') return absPage >= Math.max(1, (H.applyFrom | 0) || 1);
  if (mode === 'pick') return Array.isArray(H.applyPages) && H.applyPages.indexOf(absPage) >= 0;
  return true;
}

// 번호 컨텍스트 — start(번호 시작 페이지)와 numFrom(그 쪽에 찍힐 첫 번호)을 함께 반영.
// ⚠ numFrom을 더한 뒤 '음수면 생략'에 기대면 안 된다(시작 번호가 크면 앞쪽에도 번호가 찍힌다).
function hfNumberCtx(H, absPage, totalAll) {
  const start = Math.max(1, (H.start | 0) || 1);
  const numFrom = Math.max(1, (H.numFrom | 0) || 1);
  return {
    page: absPage < start ? 0 : (absPage - start + numFrom),
    total: Math.max(1, totalAll - start + numFrom),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatPageNumber, resolveHF, hfInScope, hfNumberCtx };
}
