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

/* ── 🔢 페이지 번호 (머리글·바닥글과 **독립된** 기능) ────────────────────────
 * 머리글에 얹힌 번호 기능은 그대로 두고(기존 프로파일 호환), 번호만 따로 켜고
 * 위치·서식·제외 페이지를 지정하는 별도 레이어. 여기도 순수 함수만 둔다.
 * ⚠ 번호는 **원본 페이지 기준으로 찍힌 뒤** 임포징(2up·중철)으로 조판된다.
 *   조판 순서가 바뀌면 시트 기준 번호가 되어 책이 엉킨다.
 */

// '1, 3-5, 8' → Set{1,3,4,5,8}. 공백·쉼표·다양한 대시(-, –, ~) 허용. 잘못된 조각은 무시.
function pnParseRanges(str) {
  const out = new Set();
  for (const part of String(str || '').split(/[,\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) { const t = a; a = b; b = t; }
      for (let i = a; i <= b && i - a < 10000; i++) out.add(i);
    } else if (/^\d+$/.test(part)) {
      out.add(parseInt(part, 10));
    }
  }
  return out;
}

// 이 페이지에 번호를 찍을지 — 시작 위치(P) 이전이거나 제외 목록에 있으면 안 찍는다
function pnInScope(P, absPage, excludeSet) {
  if (!P || !P.enabled) return false;
  if (absPage < Math.max(1, (P.start | 0) || 1)) return false;
  const ex = excludeSet || pnParseRanges(P.exclude);
  return !ex.has(absPage);
}

// 그 페이지에 찍힐 번호와 전체 쪽수 — 시작 위치·시작 번호 반영(hfNumberCtx와 같은 규약)
function pnNumberCtx(P, absPage, totalAll) {
  const start = Math.max(1, (P.start | 0) || 1);
  const numFrom = Math.max(1, (P.numFrom | 0) || 1);
  return {
    page: absPage < start ? 0 : (absPage - start + numFrom),
    total: Math.max(1, (totalAll | 0) - start + numFrom),
  };
}

// 번호 서식 — {page}=현재 페이지, {total}=전체 페이지. 그 밖의 글자는 그대로 찍힌다.
function pnFormat(fmt, page, total) {
  const t = (fmt == null || fmt === '') ? '{page}' : String(fmt);
  return t.replace(/\{page\}/g, page).replace(/\{total\}/g, total);
}

// 번호 배치 앵커 → 실제 정렬. 내각/외각은 **제본 기준**이라 홀·짝에서 좌우가 바뀐다.
//   외각(바깥) = 홀수쪽 오른쪽 · 짝수쪽 왼쪽   |   내각(안쪽·제본 쪽) = 그 반대
// pos: 'top-inner' | 'top-center' | 'top-outer' | 'bottom-inner' | 'bottom-center' | 'bottom-outer'
function pnAnchor(pos, evenPage) {
  const p = String(pos || 'bottom-center');
  const isHeader = p.indexOf('top') === 0;
  const side = p.split('-')[1] || 'center';
  let align = 'center';
  if (side === 'outer') align = evenPage ? 'left' : 'right';
  else if (side === 'inner') align = evenPage ? 'right' : 'left';
  return { isHeader, align, mirrored: side !== 'center' && evenPage };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatPageNumber, resolveHF, hfInScope, hfNumberCtx,
                     pnParseRanges, pnInScope, pnNumberCtx, pnFormat, pnAnchor };
}
