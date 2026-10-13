// 주석 평탄화 — 쪽을 폼으로 옮겨 실을 때(임포징·모아찍기·크기 변환·표지) 앱·조립 워커·임포징 독립 도구가 함께 쓴다.
//
// 왜: pdf-lib embedPage(s)는 쪽의 **본문(Contents)만** 폼으로 옮기고 주석(/Annots)은 버린다. 아크로뱃·pdf.js는
// 주석을 그리므로 화면(썸네일)과 원본 인쇄에는 보이는데, 모아찍기 결과에서는 사라졌다. 실파일 '페이지 오류.pdfw'
// (2026-10-13): 184쪽 중 154쪽에 펜 메모·형광펜(Ink 14,433획) — 모아찍기에서 전부 사라졌고, 60쪽은 슬라이드
// 그림까지 도장(Stamp) 주석이라 칸이 통째로 비었다.
//
// 어떻게: 아크로뱃 인쇄와 같은 규칙 — '인쇄' 표시(F 비트 3 = 4)가 있고 숨김(F 비트 2 = 2)이 아닌 주석의
// 보통 모양(/AP /N, 상태가 여럿이면 /AS)을 규격(12.5.5)대로 Rect에 맞춰 그린다. 원래 쪽은 건드리지 않고,
// 같은 문서에 **쪽 노드 복사본**(본문 = q · 원래 본문 · Q · 주석들, /Annots 없음)을 만들어 그 노드를 싣는다.
// 원래 /Annots를 실어 가지 않으므로 결과에 쓰이지 않는 주석 객체도 따라오지 않는다.
(function (root) {
  function create(PDFLib) {
    const Nm = n => PDFLib.PDFName.of(n);
    const cache = new WeakMap();   // 원래 쪽 노드 → 실을 노드 (같은 쪽을 여러 번 실어도 한 번만 만든다)

    function numOf(ctx, v) {
      v = v && v.objectNumber != null ? ctx.lookup(v) : v;
      if (v == null) return NaN;
      if (typeof v.asNumber === 'function') return v.asNumber();
      return v.numberValue != null ? +v.numberValue : NaN;
    }
    function arrNums(ctx, v) {
      v = v && v.objectNumber != null ? ctx.lookup(v) : v;
      if (!v || typeof v.asArray !== 'function') return null;
      return v.asArray().map(x => numOf(ctx, x));
    }
    // 주석 하나 → { ref(보통 모양 스트림 참조), cm[6] } 또는 null(그릴 것 없음)
    function appearanceOf(ctx, an) {
      const st = an.get(Nm('Subtype'));
      const sub = st && st.encodedName ? st.encodedName : '';
      if (sub === '/Popup' || sub === '/Link') return null;
      const f = numOf(ctx, an.get(Nm('F'))) || 0;
      if (!(f & 4) || (f & 2)) return null;              // 인쇄 표시 없음 · 숨김 → 아크로뱃도 인쇄하지 않는다
      const ap = an.lookup(Nm('AP'));
      if (!ap || typeof ap.get !== 'function') return null;
      let nRef = ap.get(Nm('N'));
      let n = nRef && nRef.objectNumber != null ? ctx.lookup(nRef) : nRef;
      if (n && !n.dict && typeof n.get === 'function') {  // 상태별 모양 사전(확인란 등) → /AS로 고른다
        const as = an.get(Nm('AS'));
        nRef = as ? n.get(as) : null;
        n = nRef && nRef.objectNumber != null ? ctx.lookup(nRef) : null;
      }
      if (!n || !n.dict || !nRef || nRef.objectNumber == null) return null;
      const rect = arrNums(ctx, an.get(Nm('Rect')));
      const bbox = arrNums(ctx, n.dict.get(Nm('BBox')));
      if (!rect || rect.length < 4 || !bbox || bbox.length < 4 || rect.concat(bbox).some(x => !isFinite(x))) return null;
      const m = arrNums(ctx, n.dict.get(Nm('Matrix'))) || [1, 0, 0, 1, 0, 0];
      // 모양 BBox를 모양 Matrix로 옮긴 상자 → 주석 Rect로 맞추는 행렬 A (Do가 모양 Matrix는 스스로 적용한다)
      const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]
        .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const bx1 = Math.min(...pts.map(p => p[0])), bx2 = Math.max(...pts.map(p => p[0]));
      const by1 = Math.min(...pts.map(p => p[1])), by2 = Math.max(...pts.map(p => p[1]));
      const rx1 = Math.min(rect[0], rect[2]), rx2 = Math.max(rect[0], rect[2]);
      const ry1 = Math.min(rect[1], rect[3]), ry2 = Math.max(rect[1], rect[3]);
      if (bx2 - bx1 < 1e-6 || by2 - by1 < 1e-6 || rx2 - rx1 < 1e-6 || ry2 - ry1 < 1e-6) return null;
      const sx = (rx2 - rx1) / (bx2 - bx1), sy = (ry2 - ry1) / (by2 - by1);
      return { ref: nRef, cm: [sx, 0, 0, sy, rx1 - bx1 * sx, ry1 - by1 * sy] };
    }

    // 실을 노드 — 주석이 없으면 원래 노드 그대로. fresh: 캐시를 쓰지 않음(쪽을 고친 뒤 다시 실을 때)
    function annotFlatNode(page, fresh) {
      const node = page.node;
      if (!fresh && cache.has(node)) return cache.get(node);
      let out = node;
      try {
        const annots = node.lookup(Nm('Annots'));
        if (annots && typeof annots.size === 'function' && annots.size()) {
          const ctx = node.context;
          const draws = [];
          for (let i = 0; i < annots.size(); i++) {
            let an = null;
            try { an = annots.lookup(i); } catch (e) { an = null; }
            if (!an || typeof an.get !== 'function') continue;
            const a = appearanceOf(ctx, an);
            if (a) draws.push(a);
          }
          const ent = node.normalizedEntries();   // 물려받은 Resources·MediaBox까지 쪽에 내려 둔다
          const clone = node.clone(ctx);
          clone.delete(Nm('Annots'));
          if (draws.length) {
            const res = ent.Resources.clone(ctx);
            const xo0 = res.lookup(Nm('XObject'));
            const xo = xo0 && typeof xo0.clone === 'function' ? xo0.clone(ctx) : ctx.obj({});
            let ops = '';
            draws.forEach((d, k) => {
              let nm = 'AnF' + k;
              while (xo.get(Nm(nm))) nm += 'x';
              xo.set(Nm(nm), d.ref);
              ops += 'q ' + d.cm.map(v => +v.toFixed(5)).join(' ') + ' cm /' + nm + ' Do Q\n';
            });
            res.set(Nm('XObject'), xo);
            clone.set(Nm('Resources'), res);
            // 원래 본문이 그래픽 상태(cm 등)를 풀지 않고 끝나도 주석은 쪽 기본 좌표에 그려지게 q…Q로 감싼다
            const raw = node.get(Nm('Contents'));
            const parts = raw && typeof raw.asArray === 'function' ? raw.asArray() : (raw ? [raw] : []);
            const open = ctx.register(ctx.stream('q\n'));
            const close = ctx.register(ctx.stream('\nQ\n' + ops));
            clone.set(Nm('Contents'), ctx.obj([open, ...parts, close]));
          }
          out = clone;
        }
      } catch (e) { out = node; }   // 모르는 구조면 예전처럼 본문만
      cache.set(node, out);
      return out;
    }
    return { annotFlatNode };
  }

  if (root.PDFLib) {                              // 창·워커: pdf-lib 스크립트를 먼저 싣는다
    root.annotFlatNode = create(root.PDFLib).annotFlatNode;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
