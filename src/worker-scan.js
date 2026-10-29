/**
 * 🧹 스캔 정리 판정 Web Worker — 화면 스레드는 쪽 그림만 그리고, 회색 바꾸기·판정(scanAnalyze)은 여기서.
 * 입력: { rgba: ArrayBuffer(캔버스 RGBA, 넘겨받음), w, h, dpi } → 결과: scanAnalyze 반환값 그대로.
 * 앱과 같은 libs/scan-clean.js를 쓰므로 판정 결과는 화면 스레드에서 돌릴 때와 같다.
 */
importScripts('./libs/scan-clean.js');

self.onmessage = function (e) {
  const { id, payload } = e.data || {};
  try {
    const { rgba, w, h, dpi } = payload;
    const id4 = new Uint8Array(rgba);
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (id4[j] * 77 + id4[j + 1] * 150 + id4[j + 2] * 29) >> 8;
    const res = self.scanAnalyze(g, w, h, { dpi });
    self.postMessage({ id, result: res });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
