# business-mgmt 세션에 요청할 일 — PDF 편집기 견적 받기(version 2)

> 작성: 2026-10-25 (pdf-analyzer-electron 세션). business-mgmt 코드는 이 세션에서 고치지 않았다.

## 배경
PDF 편집기(pdf-analyzer)의 견적서를 **거래관리 견적서와 같은 구조**로 바꿨다(품목 + 단가산출내역 그룹 → 품목 단가 연결).
📤 거래관리로 보내기는 이제 거래관리 견적서 **저장 형식 그대로** 보낸다(`version: 2`).

그런데 거래관리 `app.js` `importPdfQuote(p)`는 지금 **품목만** 채우고 단가산출내역은 빈 행 하나로 비운다.
→ 아래처럼 고치면 받은 그대로 견적서 작성 창이 채워진다.

## 받는 데이터 (`~/.ilcheong/quote-inbox/*.json`, `source: 'pdf-analyzer'`)
```js
{
  source: 'pdf-analyzer', version: 2, sentAt, customerName, date, title, memo,
  workNotes: '...',                       // 작업내역
  items: [{ name, spec, qty, price, taxRate, calcLinkId, isDiscount? }],   // 할인 행: isDiscount + 음수 price
  calcRows: [ { isGroup: true, content, price: 0, pages: 0, linkItemId }, { content, price, pages }, ... ],
  calcHeaders: { content, price, pages, total },
  calcTables: [],                         // 표 형식 산출표 — 아직 보내지 않음
  expectedTotal, pages: { total, color, gray }, fileName,
}
```
- 그룹 행의 `linkItemId`는 같은 묶음 안 품목의 `calcLinkId`와 같다(연결 → 그룹 소계가 그 품목 단가).
- 보낸 단가는 이미 그룹 소계와 같아서, 거래관리가 열면서 `updateCalcTotal()`로 다시 적용해도 금액이 바뀌지 않는다.
- version 1(옛 PDF 편집기)은 `items`만 있고 `calcLinkId`·`calcRows`가 없다 — 지금 동작 그대로 두면 된다.

## 고칠 곳 (business-mgmt `app.js` `importPdfQuote`)
1. 품목: `makeItemRow`에 `calcLinkId`·`isDiscount`도 넘긴다(지금은 name·spec·qty·price·taxRate만).
   ```js
   p.items.forEach(it => tbody.appendChild(makeItemRow({
     name: it.name || '', spec: it.spec || '', qty: Number(it.qty) || 0, price: Number(it.price) || 0,
     taxRate: it.taxRate == null ? 0.1 : it.taxRate,
     calcLinkId: it.calcLinkId || undefined, isDiscount: it.isDiscount === true,
   }, 'quote-items-tbody')));
   ```
2. 머리글: `p.calcHeaders`가 있으면 `calc-header-*` 네 칸에 넣는다(없으면 지금 기본값).
3. 단가산출내역: `p.calcRows`가 있으면 **품목 행을 다 만든 뒤에**(연결 드롭다운 옵션이 품목 목록에서 만들어지므로)
   `(p.calcRows.length ? p.calcRows : [{}]).forEach(r => calcTbody.appendChild(makeCalcRow(r)))` → `updateCalcTotal()`.
4. 작업내역: `quote-work-notes`에 `p.workNotes || ''`.
5. 산출표: `renderCalcTables(p.calcTables || [])`.
6. 안내 띠(`showPdfQuoteBanner`)는 그대로.

## 확인 방법
- PDF 편집기에서 분석 → 견적서(단가산출 그룹 2개 + 개별 품목 + 할인 행) → 📤 거래관리로 보내기
  → 거래관리 견적서 작성 창: 품목·할인 행·단가산출 그룹(품목 연결 드롭다운 선택됨)·머리글·비고·작업내역이 그대로, 최종 합계 = PDF 편집기 합계.
- 옛 형식(version 1, items만)도 지금처럼 열리는지.
