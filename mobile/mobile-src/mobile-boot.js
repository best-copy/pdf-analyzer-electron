// ── 모바일 부트로더 ─────────────────────────────────────────────────────────
// app-core.js가 로드 시점에 getWorkerContent()를 '동기'로 호출하므로,
// pdf.js 워커 소스를 먼저 받아둔 뒤 앱 스크립트 3개를 순서대로 로드한다.
// (클래식 스크립트 전역 공유 구조 유지 — 로드 순서 core → process → ui 필수)
(async function () {
  'use strict';
  try {
    const r = await fetch('./libs/pdf.worker.min.js');
    window.__MOB_WORKER_TEXT = await r.text();
  } catch (e) {
    console.error('pdf.js 워커 프리로드 실패:', e);
    window.__MOB_WORKER_TEXT = '';
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('스크립트 로드 실패: ' + src));
      document.body.appendChild(s);
    });
  }

  try {
    await loadScript('./app-core.js');
    await loadScript('./app-process.js');
    await loadScript('./app-ui.js');
  } catch (e) {
    document.body.innerHTML = '<div style="padding:40px; color:#ff6b6b; font-family:sans-serif;">앱 로드 실패: ' + e.message + '</div>';
    return;
  }

  // ── 모바일 UI 보정 (앱 스크립트 로드 후) ────────────────────────────────
  // PC 전용 요소 숨김: 모바일 연동 서버 섹션(폰 자신), 내부 편집기 진입 버튼
  const hide = sel => document.querySelectorAll(sel).forEach(el => { el.style.display = 'none'; });
  const remoteChk = document.getElementById('remoteSrvChk');
  if (remoteChk) { const sec = remoteChk.closest('.sbp-section'); if (sec) sec.style.display = 'none'; }
  hide('[onclick*="openContentEditor"]');   // 내부 콘텐츠 편집기(별도 창) — PC 전용

  // PC 서버 연결 카드 주입 (mobile-bridge.js)
  if (window.__mobInitServerCard) window.__mobInitServerCard();
})();
