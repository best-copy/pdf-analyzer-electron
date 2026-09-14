    // ── 사진 띠 이음매(흰 머리카락 줄) 메우기 — pdf.js 렌더 공용 ──
    // 앱(index.html)·내부 편집기(editor.html)·E-book 독립 도구(build-ebook-standalone.js가 통째로 넣는다)가
    // 모두 이 파일 하나를 쓴다. 복사하지 말 것(드리프트).
    //
    // 한글·오피스에서 변환한 PDF는 사진 한 장을 가로 띠 여러 개로 잘라 넣는 경우가 많다.
    // pdf.js는 띠마다 가장자리를 따로 그려서, 두 띠가 맞닿는 행이 덜 칠해지고
    // 그 틈으로 흰 바탕이 비쳐 **사진을 가로지르는 1px 흰 줄**이 구워진다
    // (실측: 사용자 시안 8쪽 39.3% 행, 589px — 원본 PDF 그림에는 없는 줄).
    // 픽셀만 보고 '가는 흰 줄'을 찾으면 굵은 글자 획 사이 틈·사진의 밝은 윤곽까지 메워 버린다
    // (실측: '총장' 글자 안 1px 틈, 넥타이 윤곽). 그래서 **pdf.js가 그림을 어디에 그렸는지**
    // (렌더하는 동안 drawImage가 그린 자리)로 이음매 위치를 정확히 알아낸 뒤 그 줄만 고친다.

    // 렌더하는 동안 캔버스의 drawImage를 가로채 **그림이 실제로 그려진 자리**(캔버스 px)를 모은다.
    // 예전에는 page.getOperatorList()로 따로 구했는데, 워커가 페이지를 한 번 더 해석해서 렌더 시간이
    // 93% 늘었다(실측 40쪽). 그림 묶음(inline group)·주석 속 그림도 놓쳤다. 가로채면 한 번에 끝난다.
    // (투명 그룹 안의 그림은 pdf.js가 따로 만든 캔버스에 그리므로 여기 안 잡힌다 — 보정을 안 할 뿐이다)
    //
    // 가로채기는 **캔버스마다 한 번만** 건다. 같은 캔버스에 렌더가 겹치면(크게 보기에서 쪽을 빨리
    // 넘길 때) 각자 따로 걸고 풀던 예전 방식은, 먼저 끝난 쪽이 뒤의 가로채기까지 지우거나
    // 끝난 가로채기를 영영 남겨 두었다. 지금은 살아 있는 기록들에 함께 넣고, 마지막이 끝날 때 푼다.
    const _seamTrack = new WeakMap();   // ctx → { orig, own, live: Set<rects> }
    function seamTrackImageRects(ctx) {
      let st = _seamTrack.get(ctx);
      if (!st) {
        st = { orig: ctx.drawImage, own: Object.prototype.hasOwnProperty.call(ctx, 'drawImage'), live: new Set() };
        const orig = st.orig, live = st.live;
        ctx.drawImage = function (img, ...a) {
          try {
            let dx, dy, dw, dh;
            if (a.length >= 8) { dx = a[4]; dy = a[5]; dw = a[6]; dh = a[7]; }
            else if (a.length >= 4) { dx = a[0]; dy = a[1]; dw = a[2]; dh = a[3]; }
            else if (a.length >= 2) { dx = a[0]; dy = a[1]; dw = img && img.width; dh = img && img.height; }
            if (dw && dh && live.size) {
              const m = this.getTransform();
              let xa, xb, ya, yb;
              if (Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6) {
                xa = m.a * dx + m.e; xb = m.a * (dx + dw) + m.e; ya = m.d * dy + m.f; yb = m.d * (dy + dh) + m.f;
              } else if (Math.abs(m.a) < 1e-6 && Math.abs(m.d) < 1e-6) {   // 90° 돌린 그림
                xa = m.c * dy + m.e; xb = m.c * (dy + dh) + m.e; ya = m.b * dx + m.f; yb = m.b * (dx + dw) + m.f;
              }   // 기울어진 그림은 이음매가 사선이라 다루지 않는다
              if (xa !== undefined) {
                const r = { x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: Math.min(ya, yb), y1: Math.max(ya, yb) };
                live.forEach(rs => rs.push(r));
              }
            }
          } catch (e) {}
          return orig.call(this, img, ...a);
        };
        _seamTrack.set(ctx, st);
      }
      const rects = [];
      st.live.add(rects);
      return {
        rects,
        stop() {
          st.live.delete(rects);
          if (st.live.size || _seamTrack.get(ctx) !== st) return;   // 아직 다른 렌더가 기록 중
          if (st.own) ctx.drawImage = st.orig; else delete ctx.drawImage;
          _seamTrack.delete(ctx);
        },
      };
    }

    // 두 그림이 맞닿은 경계 → 고칠 줄 목록 — 순수 함수 (노드 단독 검증: scripts/test/seam-repair.test.js).
    // 반환: { dir:'h', a, b, from, to } — 행 a~b(1~2행)를 열 from~to 구간에서 / 'v'는 가로세로 반대.
    // 한 사진을 자른 띠는 **좌우 끝(세로 이음매면 위아래 끝)이 같다**. 끝이 다른 두 그림이 우연히
    // 맞닿은 경우(표를 그림으로 넣은 옆 칸·흰 테두리가 있는 그림 등)는 의도한 경계일 수 있어 건드리지 않는다.
    function seamLines(rects, W, H) {
      const TOUCH = 1.0;   // 경계가 이만큼(px) 안이면 맞닿은 것으로 본다
      const ALIGN = 1.5;   // 같은 사진의 띠로 볼 끝 차이(px)
      const MINLEN = 8;    // 겹치는 길이가 이보다 짧으면 무시
      const out = [], seen = new Set();
      const push = (dir, e, from, to, lim, span) => {
        from = Math.max(0, Math.floor(from)); to = Math.min(span - 1, Math.ceil(to) - 1);
        if (to - from + 1 < MINLEN) return;
        // 경계 e가 걸친 행: 소수부가 있으면 그 행 하나, 거의 정수면 경계 양쪽 두 행 후보
        const f = e - Math.floor(e);
        let a, b;
        if (f > 0.05 && f < 0.95) { a = b = Math.floor(e); }
        else { const r = Math.round(e); a = r - 1; b = r; }
        a = Math.max(1, a); b = Math.min(lim - 2, b);
        if (b < a) return;
        const key = dir + a + ':' + b + ':' + from + ':' + to;
        if (seen.has(key)) return; seen.add(key);
        out.push({ dir, a, b, from, to });
      };
      for (let i = 0; i < rects.length; i++) for (let j = 0; j < rects.length; j++) {
        if (i === j) continue;
        const p = rects[i], q = rects[j];
        // p의 아래 변과 q의 위 변이 맞닿음 → 가로 이음매
        if (Math.abs(p.y1 - q.y0) < TOUCH && Math.abs(p.x0 - q.x0) <= ALIGN && Math.abs(p.x1 - q.x1) <= ALIGN) {
          const from = Math.max(p.x0, q.x0), to = Math.min(p.x1, q.x1);
          if (to > from) push('h', (p.y1 + q.y0) / 2, from, to, H, W);
        }
        // p의 오른 변과 q의 왼 변이 맞닿음 → 세로 이음매
        if (Math.abs(p.x1 - q.x0) < TOUCH && Math.abs(p.y0 - q.y0) <= ALIGN && Math.abs(p.y1 - q.y1) <= ALIGN) {
          const from = Math.max(p.y0, q.y0), to = Math.min(p.y1, q.y1);
          if (to > from) push('v', (p.x1 + q.x0) / 2, from, to, W, H);
        }
      }
      return out;
    }

    // 이음매 줄만 메운다 — 순수 함수. 바깥 두 이웃(줄 앞·뒤)을 잇는 직선 보간으로 채우되,
    // 실제로 **이웃보다 밝은** 픽셀만 고친다(틈이 없는 자리는 그대로). 반환: 고친 픽셀 수.
    function seamRepairPixels(px, W, H, lines) {
      const LIFT = 9;   // RGB 합 기준 — 이보다 밝아야 비친 틈으로 본다
      let fixed = 0;
      const row = W * 4;
      for (const L of lines) {
        const n = L.b - L.a + 1;
        for (let s = L.from; s <= L.to; s++) {
          const at = (r) => (L.dir === 'h' ? r * row + s * 4 : s * row + r * 4);
          const u = at(L.a - 1), w = at(L.b + 1);
          const su = px[u] + px[u + 1] + px[u + 2], sw = px[w] + px[w + 1] + px[w + 2];
          for (let r = L.a; r <= L.b; r++) {
            const i = at(r), sc = px[i] + px[i + 1] + px[i + 2];
            if (sc - Math.max(su, sw) <= LIFT) continue;
            const t = (r - L.a + 1) / (n + 1);
            for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.round(px[u + ch] * (1 - t) + px[w + ch] * t);
            fixed++;
          }
        }
      }
      return fixed;
    }

    // 캔버스에서 이음매 줄 **둘레만** 읽어 고친다. 페이지 전체를 getImageData로 읽으면 300DPI 큰 판형에서
    // 한 번에 180MB 가까이 잡아먹는다(8000×5657 RGBA). 줄마다 1~2행 + 앞뒤 이웃 한 행씩이면 충분하다.
    function seamRepairCanvas(ctx, lines) {
      let fixed = 0;
      for (const L of lines) {
        const n = L.b - L.a, h = L.dir === 'h';
        const x = h ? L.from : L.a - 1, y = h ? L.a - 1 : L.from;
        const w = h ? L.to - L.from + 1 : n + 3, hh = h ? n + 3 : L.to - L.from + 1;
        const id = ctx.getImageData(x, y, w, hh);
        const f = seamRepairPixels(id.data, w, hh, [{ dir: L.dir, a: 1, b: 1 + n, from: 0, to: (h ? w : hh) - 1 }]);
        if (f) { ctx.putImageData(id, x, y); fixed += f; }
      }
      return fixed;
    }

    // pdf.js로 한 쪽을 그리고 사진 띠 이음매의 흰 줄을 메운다 — 쪽을 **그림으로 굽는** 모든 경로가 쓴다
    // (E-book 쪽 그림·폰트 안전화 래스터·앱 미리보기·썸네일·내부 편집기). params는 page.render()에 주는 것 그대로.
    // 맞닿은 띠가 없는 쪽은 픽셀을 읽지도 않는다.
    async function renderPageNoSeams(page, params) {
      const ctx = params.canvasContext, tr = seamTrackImageRects(ctx);
      try { await page.render(params).promise; } finally { tr.stop(); }
      try {
        const lines = seamLines(tr.rects, ctx.canvas.width, ctx.canvas.height);
        if (lines.length) seamRepairCanvas(ctx, lines);
      } catch (e) { console.warn('이음매 보정 생략:', e && e.message); }
    }
