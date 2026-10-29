/**
 * ✒ 벡터화(윤곽 따기) Web Worker — imagetracer로 색마다 윤곽을 따서 결과(tracedata)를 돌려준다.
 * 입력: { rgba: ArrayBuffer(캔버스 RGBA, 넘겨받음), w, h, opts }
 *   opts.colors: 색 수(0 = 자동 · 2 = 흑백 — 오츠 문턱값으로 먼저 이진화 · 그 밖은 img-enhance quantizeRgba로 색을 먼저 줄인다) · opts.smooth: 매끄럽게(0.5~4, 클수록 곡선 단순)
 *   opts.speck: 잡티 없애기(이 길이(px) 미만 윤곽은 버림) · opts.blur: 흐림 반경(0~5, 색 경계 들쭉날쭉 정리)
 * 결과: { td: tracedata, ms }  (td = imagetracer imagedataToTracedata 반환값 그대로 — 화면에서 PDF·SVG로)
 */
importScripts('./libs/imagetracer.js', './libs/img-enhance.js');

self.onmessage = function (e) {
  const { id, rgba, w, h, opts } = e.data || {};
  try {
    const t0 = Date.now();
    let data = new Uint8ClampedArray(rgba);
    const o = opts || {};
    const want = o.colors | 0;
    let pal = null, colors;
    if (want === 2) { data = self.ImgEnhance.binarizeRgba(data, o.thr).data; colors = 2; }
    else {   // 대표색을 먼저 고르고 경계 띠는 이웃 색 중에서 — imagetracer는 그 색을 그대로 쓴다(pal + 한 번 배정)
      const q = self.ImgEnhance.quantizeRgba(data, w, h, want > 2 ? Math.min(64, want) : 0);
      data = q.data; pal = q.pal; colors = q.pal.length;
    }
    const smooth = o.smooth > 0 ? o.smooth : 1;
    const td = self.ImageTracer.imagedataToTracedata({ width: w, height: h, data }, {
      pal: pal || undefined,
      numberofcolors: colors,
      colorsampling: 0,                         // 2색: 흑·백 회색 팔레트
      colorquantcycles: 1,
      mincolorratio: 0,
      pathomit: o.speck >= 0 ? o.speck : 8,
      ltres: smooth, qtres: smooth,
      rightangleenhance: o.corners !== false,
      blurradius: 0,
      blurdelta: 64,
      layering: 0,
    });
    self.postMessage({ id, td, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
