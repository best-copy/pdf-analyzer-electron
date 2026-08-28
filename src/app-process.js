    // ── 긴 동기 루프 중 UI 양보 ────────────────────────────────────────────────
    // pdf-lib의 embedPage/drawPage는 await해도 마이크로태스크로만 풀려 이벤트 루프로 돌아가지
    // 않는다 → 수백 쪽 임포징에서 화면이 통째로 멈춘 것처럼 보인다. 40ms 넘게 붙들고 있었을
    // 때만 매크로태스크(setTimeout 0)로 한 번 양보해, 품질 손실 없이 프리즈만 없앤다.
    let _yieldAt = 0;
    function uiYield(ms) {
      const now = Date.now();
      if (now - _yieldAt < (ms || 40)) return Promise.resolve();
      _yieldAt = now;
      return new Promise(r => setTimeout(r));
    }

    // ── 실시간 미리보기 (편집 옵션 변경 시 디바운스 자동 갱신) ─────────────────
    let _livePvTimer = null, _liveRunning = false, _liveQueued = false;
    // 미리보기가 필요한 상태: 편집 레이아웃이 있거나, 흑백변환+선택이 있음
    function shouldPreview() {
      return !!originalPdfBytes && (hasAnyActiveLayout() || _impEnabled || _bleedEnabled || (processingOptions.bw && selectedPages.size > 0));
    }
    function previewVisible() {
      const s = document.getElementById('previewSection');
      return !!s && s.style.display !== 'none';
    }
    function scheduleLivePreview() {
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) return;
      // 기하 옵션(여백·제본여백)은 재조립을 기다리지 않고 오버레이로 즉시 선반영 (편집 모드 전용)
      if (typeof updateGeometryOverlays === 'function') updateGeometryOverlays();
      if (typeof updateEsGroupBadges === 'function') updateEsGroupBadges();   // 그룹 활성 배지 동기
      if (!shouldPreview()) { if (document.body.classList.contains('edit-fullscreen')) showWorkspaceBasePreview(); else closePreview(); return; }
      // 자동 반영 꺼짐: 렌더하지 않고 '적용 필요' 상태로만 둔다(편집 조작 자체는 항상 즉시 반응).
      // 단, 전체화면 편집 작업공간에서는 항상 자동 반영 — 편집 모드의 존재 이유가 실시간 확인이므로
      // 토글과 무관하게 켠다(큰 문서는 아래 표본 미리보기가 비용을 흡수).
      if (!liveAutoPreview && !document.body.classList.contains('edit-fullscreen')) {
        invalidateProcessed(); // 직전 결과 무효화 → '적용' 다시 눌러야 다운로드 가능
        const sec0 = document.getElementById('previewSection');
        const note0 = document.getElementById('previewNote');
        if (sec0 && sec0.style.display !== 'none' && note0) note0.textContent = "설정 변경됨 — '✔ 적용'을 눌러 반영";
        return;
      }
      // 편집 사이드바 설정만으로도 '수정사항'이 생긴 것 — 렌더 완료를 기다리지 않고
      // 메인/사이드바 '적용' 버튼을 편집창의 '편집 적용'과 즉시 같은 상태로 맞춘다.
      updateDownloadBtn();
      // 이미 결과가 보이는 중이면 작은 표시만(기존 화면은 그대로 유지 → 깜빡임 없음)
      const sec = document.getElementById('previewSection');
      const note = document.getElementById('previewNote');
      if (sec && sec.style.display !== 'none' && note) note.textContent = '갱신 중…';
      clearTimeout(_livePvTimer);
      // 슬라이더를 잡고 있는 동안(또는 숫자칸을 연타하는 동안)에는 갱신을 미룬다.
      // 중간 단계마다 전체 조립·렌더를 돌리면 손을 떼기 전까지 계속 밀린다 → 놓을 때 1회만.
      if (_uiInteracting) { _livePvPending = true; return; }
      // 임포징 포함 상태는 시트 재조립 비용이 커서(전체 페이지 의존) 디바운스를 늘린다.
      _livePvTimer = setTimeout(runLivePreview, _impEnabled ? 420 : 120);
    }
    // ── 조작 중 갱신 보류 ──────────────────────────────────────────────────────
    // 범위 슬라이더는 드래그하는 내내 input 이벤트를 쏟아낸다. 잡고 있는 동안에는 예약만
    // 해 두고, 놓는 순간 한 번만 반영한다(품질·결과는 동일, 중간 계산만 없앤다).
    let _uiInteracting = false, _livePvPending = false;
    function endUiInteraction() {
      if (!_uiInteracting) return;
      _uiInteracting = false;
      if (_livePvPending) { _livePvPending = false; scheduleLivePreview(); }
    }
    document.addEventListener('pointerdown', (e) => {
      const t = e.target;
      if (t && t.tagName === 'INPUT' && t.type === 'range') _uiInteracting = true;
    }, true);
    ['pointerup', 'pointercancel', 'blur'].forEach(ev =>
      document.addEventListener(ev, endUiInteraction, true));
    async function runLivePreview() {
      if (applying || _liveRunning) { _liveQueued = true; return; }
      if (!shouldPreview()) { if (document.body.classList.contains('edit-fullscreen')) showWorkspaceBasePreview(); else closePreview(); return; }
      _liveRunning = true;
      // 캐시가 히트하는 짧은 갱신에선 깜빡이지 않도록, 200ms 넘게 걸릴 때만 '처리중' 상태창 표시
      let loadingShown = false;
      const loadingTimer = setTimeout(() => { loadingShown = true; showLoading('편집 내용 반영 중...'); }, 200);
      // 조립을 시작하는 시점의 설정 지문 — 조립 도중 사용자가 값을 바꿨다면 결과 바이트는
      // 이미 낡은 것이므로 '저장하고 닫기'가 재사용하지 못하게 표식을 남기지 않는다.
      const sigAtStart = optSignature();
      try {
        const base = await buildBaseProcessed();
        let pdfBytes = base.bytes;
        const groups = computeLayoutGroups();
        // ── 편집 작업공간 표본 미리보기: 큰 문서는 보이는 페이지 주변만 재조립·렌더 ──
        // (다운로드용 결과가 아니므로 processedPdfBytes는 만들지 않는다 — '저장하고 닫기'가 전체 적용)
        if (wsSampleEligible(groups)) {
          await runWorkspaceSamplePreview(base, groups);
          invalidateProcessed();
          return;
        }
        wsResetSampleGrid();
        if (groups.length) pdfBytes = await applyLayoutTransform(pdfBytes, groups, base.sig);
        pdfBytes = await applyBleedStage(pdfBytes);   // ◲ 블리드 옵션 (임포징 앞)
        if (_impEnabled) pdfBytes = await buildImposedBytes(pdfBytes);
        processedPdfBytes = pdfBytes;
        directOutputBytes = null;   // 파이프라인 결과 — 다운로드는 재조립 경로 사용
        processedFileName = defaultProcessedName();
        // 이 결과가 어떤 설정으로 만들어졌는지 기록 — '💾 저장하고 닫기'가 같은 설정이면
        // 똑같은 파이프라인을 한 번 더 돌리지 않고 이 결과를 그대로 쓴다(임포징 재조립 생략).
        _processedSig = (optSignature() === sigAtStart) ? sigAtStart : null;
        setDirty(true);
        updateDownloadBtn();
        await renderProcessedPreview(pdfBytes, { live: true });
      } catch (e) {
        console.error('실시간 미리보기 오류:', e);
        const note = document.getElementById('previewNote');
        if (note) note.textContent = '⚠️ 미리보기 생성 실패 (콘솔 확인)';
      } finally {
        clearTimeout(loadingTimer);
        if (loadingShown) hideLoading();
        _liveRunning = false;
        if (_liveQueued) { _liveQueued = false; scheduleLivePreview(); }
      }
    }

    // ── 편집 작업공간 표본 미리보기 ──────────────────────────────────────────
    // 큰 문서에서 옵션을 바꿀 때마다 전체를 재조립하면 수 초씩 걸려 "실시간"이 아니게 된다.
    // 전체화면 편집 모드에서는 현재 보이는 페이지(중심 ±WS_SPAN)만 base에서 잘라 레이아웃
    // 변환·렌더하고, 나머지는 분석 썸네일을 흐리게 보여준다(스크롤하면 그 위치를 다시 표본으로).
    // 임포징 포함·N-up은 시트 구성이 전체 페이지에 의존하므로 표본 불가 → 기존 전체 경로.
    const WS_MAX = 20;                 // 한 번에 실시간 유지할 최대 페이지 수 (비용 상한)
    const WS_SAMPLE_MIN = 16;          // 이보다 적으면 그냥 전체 렌더가 더 낫다
    let _wsView = null;                // {from,to} 화면에 보이는 페이지 범위(±1 버퍼) — 스크롤이 갱신
    let _wsGrid = { n: -1, from: -1, to: -1, cells: null };
    let _wsSliceCache = { sig: null, doc: null };
    function wsSampleEligible(groups) {
      if (!document.body.classList.contains('edit-fullscreen')) return false;
      if (_impEnabled) return false;
      if (!groups || !groups.length) return false;
      if (groups.some(g => (g.es.nUp | 0) > 1)) return false;
      return pageResults.filter(Boolean).length >= WS_SAMPLE_MIN;
    }
    function wsResetSampleGrid() { _wsGrid = { n: -1, from: -1, to: -1, cells: null }; _wsView = null; }
    async function runWorkspaceSamplePreview(base, groups) {
      const valid = pageResults.filter(Boolean);
      const N = valid.length;
      // 실시간 창 = 화면에 보이는 페이지 범위(_wsView, 스크롤 추적) ±1 버퍼. 최대 WS_MAX로 상한.
      let from = _wsView ? Math.max(0, Math.min(N - 1, _wsView.from)) : 0;
      let to = _wsView ? Math.max(from, Math.min(N - 1, _wsView.to)) : Math.min(N - 1, 11);
      if (to - from + 1 > WS_MAX) {   // 상한 초과 시 가운데 기준으로 잘라냄
        const mid = (from + to) >> 1;
        from = Math.max(0, mid - (WS_MAX >> 1));
        to = Math.min(N - 1, from + WS_MAX - 1);
      }
      // base 파싱 캐시(sig 기준) → 표본만 복사한 소문서
      if (_wsSliceCache.sig !== base.sig || !_wsSliceCache.doc) {
        _wsSliceCache = { sig: base.sig, doc: await PDFLib.PDFDocument.load(base.bytes.slice(0)) };
      }
      const sub = await PDFLib.PDFDocument.create();
      const idxs = Array.from({ length: to - from + 1 }, (_, k) => from + k);
      (await sub.copyPages(_wsSliceCache.doc, idxs)).forEach(p => sub.addPage(p));
      const sampleBytes = new Uint8Array(await sub.save({ useObjectStreams: false, updateFieldAppearances: false }));
      // 그룹 마스크도 같은 창으로 슬라이스 — es는 그대로 공유(전역/챕터별 설정 유지)
      const sGroups = groups.map(g => ({ mask: g.mask.slice(from, to + 1), es: g.es })).filter(g => g.mask.some(Boolean));
      let bytes = sGroups.length
        ? await applyLayoutTransform(sampleBytes, sGroups, base.sig + '#ws' + from + '-' + to, { window: { from, to } })
        : sampleBytes;
      bytes = await applyBleedStage(bytes);   // ◲ 블리드 옵션 — 표본 창에도 동일 반영
      await renderWorkspaceSampleGrid(bytes, from, to, valid);
    }
    // 표본 그리드: [from,to]는 변환 결과 캔버스, 나머지는 분석 썸네일 플레이스홀더.
    // 페이지 수가 같으면 셀을 재사용(패치)해 큰 문서에서도 DOM 재구축 비용이 없다.
    async function renderWorkspaceSampleGrid(bytes, from, to, valid) {
      const grid = document.getElementById('previewGrid');
      const section = document.getElementById('previewSection');
      const note = document.getElementById('previewNote');
      if (!grid || !section) return;
      const N = valid.length;
      const myToken = ++previewRenderToken;
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      try {
        if (myToken !== previewRenderToken) return;
        // 그리드 골격 (재)구축 — 페이지 수가 달라졌거나 표본 모드 첫 진입일 때만
        if (_wsGrid.n !== N || !_wsGrid.cells || grid.dataset.wsSample !== '1') {
          const frag = document.createDocumentFragment();
          const cells = [];
          for (let i = 0; i < N; i++) {
            const cell = document.createElement('div');
            cell.className = 'pv-cell';
            const num = document.createElement('div'); num.className = 'pv-num'; num.textContent = i + 1;
            cell.appendChild(num);
            cell.addEventListener('click', () => {   // 회색 페이지 클릭 → 그 위치 주변을 실시간 창으로
              if (cell.classList.contains('pv-stale')) { _wsView = { from: Math.max(0, i - 3), to: i + 8 }; scheduleLivePreview(); }
            });
            // 우클릭 → 페이지 컨텍스트 메뉴 (회전·개별 보정 등 — 표본 셀 i = 문서 순서 인덱스)
            cell.addEventListener('contextmenu', e => {
              e.preventDefault(); e.stopPropagation();
              const r = pageResults.filter(Boolean)[i];
              const idx = r ? pageResults.indexOf(r) : -1;
              if (idx >= 0) { ctxTargetIdx = idx; showCtxMenu(e, idx); }
            });
            frag.appendChild(cell);
            cells.push(cell);
          }
          grid.replaceChildren(frag);
          grid.dataset.wsSample = '1';
          _wsGrid = { n: N, from: -1, to: -1, cells };
        }
        const cells = _wsGrid.cells;
        const setPlaceholder = i => {
          const cell = cells[i], r = valid[i];
          cell.classList.add('pv-stale');
          const old = cell.querySelector('canvas, img'); if (old) old.remove();
          delete cell.dataset.pw; delete cell.dataset.ph;   // 회색 셀은 오버레이 제외
          if (r && r.thumbnail) {
            const img = document.createElement('img');
            img.src = r.thumbnail; img.className = 'pv-canvas'; img.draggable = false;
            cell.insertBefore(img, cell.firstChild);
          } else {
            const ph = document.createElement('canvas');
            ph.className = 'pv-canvas'; ph.width = 170; ph.height = 240;
            cell.insertBefore(ph, cell.firstChild);
          }
        };
        // 이전 표본 창을 플레이스홀더로 되돌리고, 새 창을 렌더
        if (_wsGrid.from >= 0) {
          for (let i = _wsGrid.from; i <= _wsGrid.to; i++) {
            if (i < from || i > to) setPlaceholder(i);
          }
        } else {
          for (let i = 0; i < N; i++) if (i < from || i > to) setPlaceholder(i);
        }
        // 렌더 해상도: 썸네일 줌(--thumb-size)에 맞춰 키운다 — 확대해도 선명하게.
        // 펼침 모드는 표시 폭(560px × 펼침%)에 맞춘 고해상도로 렌더(화질).
        const spreadOn = grid.classList.contains('pv-spread');
        const spreadK = (typeof _spreadZoomPct !== 'undefined' ? _spreadZoomPct : 100) / 100;
        const zoomPx = (typeof THUMB_STEPS !== 'undefined' && typeof thumbStepIdx !== 'undefined') ? THUMB_STEPS[thumbStepIdx] : 160;
        const pxW = spreadOn
          ? Math.max(400, Math.round(560 * spreadK * 1.15))
          : Math.max(240, Math.round(zoomPx * 1.5));
        for (let i = from; i <= to; i++) {
          if (myToken !== previewRenderToken) return;
          const page = await pdf.getPage(i - from + 1);
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: pxW / vp1.width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          if (myToken !== previewRenderToken) return;
          canvas.className = 'pv-canvas';
          const cell = cells[i];
          cell.classList.remove('pv-stale');
          cell.dataset.pw = vp1.width; cell.dataset.ph = vp1.height;   // 기하 오버레이용 pt 크기
          const old = cell.querySelector('canvas, img'); if (old) old.remove();
          cell.insertBefore(canvas, cell.firstChild);
          page.cleanup();
        }
        _wsGrid.from = from; _wsGrid.to = to;
        if (typeof updateGeometryOverlays === 'function') updateGeometryOverlays();
        document.getElementById('previewCount').textContent = `(전체 ${N}페이지 · 표본 ${from + 1}~${to + 1}쪽 실시간)`;
        if (note) note.textContent = `표본 미리보기 — ${from + 1}~${to + 1}쪽만 실시간 반영 중. 회색 페이지는 스크롤하거나 클릭하면 그 위치가 반영됩니다. '💾 저장하고 닫기'에서 전체 적용.`;
        setAnalysisGridVisible(false);
        section.style.display = 'block';
      } finally { try { await pdf.destroy(); } catch (e) {} }
    }
    // 스크롤 추적 — 화면 상단에 보이는 페이지를 표본 중심으로 (디바운스)
    (function initWsScrollSampler() {
      const sec = document.getElementById('previewSection');
      if (!sec) return;
      let t = null;
      sec.addEventListener('scroll', () => {
        if (!document.body.classList.contains('edit-fullscreen') || _wsGrid.n < 0) return;
        clearTimeout(t);
        t = setTimeout(() => {
          if (_wsGrid.n < 0 || !_wsGrid.cells) return;
          // 화면(뷰포트)에 걸친 페이지 전부 + 위아래 1쪽 버퍼를 실시간 창으로
          const top = sec.scrollTop, bot = top + sec.clientHeight;
          let first = -1, last = -1;
          for (let i = 0; i < _wsGrid.cells.length; i++) {
            const c = _wsGrid.cells[i], ct = c.offsetTop, cb = ct + c.offsetHeight;
            if (cb > top && ct < bot) { if (first < 0) first = i; last = i; }
            else if (first >= 0 && ct >= bot) break;
          }
          if (first < 0) return;
          const from = Math.max(0, first - 1), to = Math.min(_wsGrid.n - 1, last + 1);
          if (from !== _wsGrid.from || to !== _wsGrid.to) { _wsView = { from, to }; scheduleLivePreview(); }
        }, 250);
      });
    })();

    // ── 적용된 결과 PDF 다운로드(저장) ───────────────────────────────────────
    // 다운로드 버튼 우클릭: 적용을 누르지 않아도 원본 PDF를 바로 저장
    async function downloadOriginal(ev) {
      if (ev) ev.preventDefault();
      if (!originalPdfBytes) { showError('다운로드할 PDF가 없습니다.'); return; }
      try {
        const name = (originalFileName || 'document') + '.pdf';
        const saved = await window.electronAPI.saveFile({ defaultName: name, buffer: originalPdfBytes });
        if (saved) { setDirty(false); showSuccess('원본 PDF를 다운로드했습니다.'); }
      } catch (err) {
        console.error('원본 다운로드 오류:', err);
        showError('다운로드 중 오류: ' + (err && err.message ? err.message : String(err)));
      }
    }

    // ── 용량 최적화 base 빌드 (다운로드 전용) ────────────────────────────────
    // 미리보기/적용은 페이지 캐시로 빠르게 처리하지만, 최종 파일은 여기서
    // 모든 페이지를 한 번에 copyPages(리소스 공유)하고 선택 페이지만 제자리 변환해
    // 파일 크기를 최소화한다. (변환은 이 순간 한 번만 수행)
    async function buildBaseOptimized(onProgress) {
      // base는 편집 옵션·임포징 옵션과 무관하다(페이지 순서·회전·흑백변환·내부편집만 반영).
      // 그래서 baseSignature()로 캐시해 두면 여백 1mm·거터 1mm 같은 조작에서 전 페이지
      // 재변환을 통째로 건너뛴다. 캐시 무효화는 clearProcessCaches 한 곳에서만.
      const cacheSig = baseSignature();
      if (_optBaseCache.sig === cacheSig && _optBaseCache.bytes) {
        if (onProgress) onProgress(100);
        return { bytes: _optBaseCache.bytes, stats: _optBaseCache.stats };
      }
      const srcDoc = await getSourceDoc();   // 공유 캐시(적용 경로와 같은 문서) — 반복 파싱 제거
      const outDoc = await PDFLib.PDFDocument.create();
      const valid  = pageResults.filter(Boolean);
      if (onProgress) onProgress(5);
      // 비편집 원본 페이지는 일괄 복사(리소스 공유), 내부편집 페이지는 편집된 단일페이지에서 개별 복사
      const isEdited = r => !r.isBlank && contentEdits.has(r.originalIdx);
      const plain = valid.filter(r => !r.isBlank && !isEdited(r));
      const allCopied = plain.length ? await outDoc.copyPages(srcDoc, plain.map(r => r.originalIdx)) : [];
      const origIdxToPage = new Map(plain.map((r, i) => [r.originalIdx, allCopied[i]]));
      const editMap = new Map();
      for (const r of valid) {
        if (!isEdited(r)) continue;
        const ed = await getEditedPageDoc(r.originalIdx);
        if (ed) { const [pg] = await outDoc.copyPages(ed, [0]); editMap.set(r.originalIdx, pg); }
      }
      for (const r of valid) {
        const page = r.isBlank ? outDoc.addPage(r.pageSize || [595.28, 841.89])
                   : isEdited(r) && editMap.has(r.originalIdx) ? outDoc.addPage(editMap.get(r.originalIdx))
                   : outDoc.addPage(origIdxToPage.get(r.originalIdx));
        if (r.rotation) {
          const ex = (page.getRotation && page.getRotation().angle) || 0;
          page.setRotation(PDFLib.degrees((ex + r.rotation) % 360));
        }
      }
      if (onProgress) onProgress(10);
      // 변환 대상 판정은 적용 파이프라인과 공유(isBwTarget) — 누락 불일치 방지.
      // 컬러 페이지(UI Dot Gain 적용)와 회색 판정 페이지(Dot Gain 0 강제)를 나눠
      // 두 단계로 순차 변환한다(같은 outDoc이라 문서 단위 오버라이드가 섞이면 안 됨).
      const toConvert = valid
        .map((r, i) => ({ r, pageNum: r.pageNum, idx: i }))
        .filter(({ r }) => isBwTarget(r));
      const SEM = Math.max(navigator.hardwareConcurrency || 4, 4);
      let sem = SEM; const q = [];
      const wait = () => sem > 0 ? (sem--, Promise.resolve()) : new Promise(r => q.push(r));
      const rel = () => { if (q.length) q.shift()(); else sem++; };
      let done = 0; const stats = { errors: 0, errPages: [], converted: toConvert.length };
      const runBatch = (batch, dgOverride) => Promise.all(batch.map(({ idx, pageNum }) => (async () => {
        await wait();
        try { await convertPageToGrayscaleVector(outDoc, idx, stats, dgOverride); }
        catch (e) { stats.errors++; stats.errPages.push(pageNum); console.error(`페이지 ${pageNum} 변환 오류:`, e); }
        finally { done++; if (onProgress) onProgress(10 + done / toConvert.length * 82); rel(); }
      })()));
      if (toConvert.length) {
        await runBatch(toConvert.filter(x => x.r.isColor), undefined);   // 컬러 → UI Dot Gain
        await runBatch(toConvert.filter(x => !x.r.isColor), 0);          // 회색 → Dot Gain 미적용
      }
      if (onProgress) onProgress(94);
      const outBytes = await outDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
      // 저장 도중 상태가 바뀌었으면(페이지 편집 등) 캐시하지 않는다 — 낡은 base가 남는 사고 방지
      if (baseSignature() === cacheSig) _optBaseCache = { sig: cacheSig, bytes: outBytes, stats };
      return { bytes: outBytes, stats };
    }
    // 다운로드용 최종 바이트 (용량 최적화 base + 레이아웃 변환)
    // 결과를 상태 시그니처로 캐시 — 적용 직후 백그라운드 프리웜(prewarmOptimizedOutput)이
    // 채워 두면 다운로드 버튼을 눌렀을 때 재생성 없이 즉시 저장된다.
    // 임포징 포함 상태를 캐시 시그니처에 반영 — 임포징 옵션이 바뀌면 최적화본 캐시가 무효화된다.
    // (currentImpOptions는 아래에서 선언되지만 런타임 호출이라 전방참조 OK)
    function impSignature() {
      if (!_impEnabled) return '';
      try { return '|imp:' + _impMode + JSON.stringify(currentImpOptions()); }
      catch (e) { return '|imp:' + _impMode; }
    }
    function optSignature() { return baseSignature() + '|' + JSON.stringify(editSettings) + impSignature() + bleedSig(); }
    // 같은 시그니처의 빌드가 이미 진행 중이면(예: 프리웜 도중 다운로드 클릭) 그 결과를
    // 공유한다. 늦게 합류한 쪽(다운로드)의 onProgress를 진행 중 빌드의 리스너에 등록해
    // 실제 진행률을 그대로 이어받는다 — '90%에서 멈춘 듯한' 구간이 사라진다.
    // 임포징 이전(조립+레이아웃) 최적화 바이트 — 임포징 생성기의 소스이자
    // buildOptimizedOutput의 전단계. 임포징을 여기 넣지 않으므로 생성기가 이 결과를
    // 소스로 삼아 한 번만 임포징한다(포함 모드에서의 이중 임포징 방지).
    async function buildOptimizedBase(onProgress) {
      const base = await buildBaseOptimized(p => onProgress && onProgress(Math.round(p * 0.9)));
      let bytes = base.bytes;
      const groups = computeLayoutGroups();
      // baseSig 필수: 없으면 _layoutCache 시그니처가 groups만으로 구성돼, base(회전·순서·흑백)가
      // 바뀐 뒤 같은 편집 설정으로 재다운로드할 때 이전 base의 결과를 그대로 돌려주는 낡은 캐시
      // 적중이 생긴다(가운데 정렬 측정값도 옛 base 기준). '#opt'로 미리보기(processed base)와 구분.
      if (groups.length) { if (onProgress) onProgress(95); bytes = await applyLayoutTransform(bytes, groups, baseSignature() + '#opt'); }
      if (onProgress) onProgress(100);
      return bytes;
    }
    let _optInflight = null; // { sig, promise, cbs:Set }
    async function buildOptimizedOutput(onProgress) {
      const sig = optSignature();
      if (_optCache.sig === sig && _optCache.bytes) { if (onProgress) onProgress(100); return _optCache.bytes; }
      if (_optInflight && _optInflight.sig === sig) {
        if (onProgress) _optInflight.cbs.add(onProgress);   // 진행률 실시간 합류
        const bytes = await _optInflight.promise;
        if (onProgress) onProgress(100);
        return bytes;
      }
      const cbs = new Set();
      if (onProgress) cbs.add(onProgress);
      const report = p => cbs.forEach(cb => { try { cb(p); } catch (e) {} });
      const promise = (async () => {
        let bytes = await buildOptimizedBase(p => report(_impEnabled ? Math.round(p * 0.85) : p));
        bytes = await applyBleedStage(bytes);   // ◲ 블리드 옵션 (임포징 앞) — 다운로드 경로에도 동일 적용
        // 임포징 포함 모드: 조립·레이아웃까지 마친 결과를 최종적으로 시트로 임포징한다.
        if (_impEnabled) {
          report(85);
          bytes = await buildImposedBytes(bytes, p => report(85 + Math.round(p * 0.15)));
        }
        report(100);
        // 생성 도중 상태가 바뀌었으면(페이지 편집 등) 캐시하지 않음
        if (optSignature() === sig) _optCache = { sig, bytes };
        return bytes;
      })();
      _optInflight = { sig, promise, cbs };
      try { return await promise; }
      finally { if (_optInflight && _optInflight.promise === promise) _optInflight = null; }
    }
    // 적용 완료 직후 유휴 시간에 다운로드용 최적화본을 미리 생성해 캐시에 채운다.
    let _optPrewarming = false;
    async function prewarmOptimizedOutput() {
      if (_optPrewarming || applying || !originalPdfBytes) return;
      const sig = optSignature();
      if (_optCache.sig === sig && _optCache.bytes) return;
      _optPrewarming = true;
      try {
        const bytes = await buildOptimizedOutput();
        // 폰트 출력 안전화가 켜져 있으면 gs 변환까지 여기서 미리 구워 캐시에 넣는다.
        // '적용'은 화면을 즉시 보여주고, 다운로드는 이 캐시를 그대로 저장한다(대기 0초).
        if (_outlineEnabled && optSignature() === sig) {
          await buildOutlinedBytes(bytes);
          if (_outlineRasterInfo && _outlineRasterInfo.count) {
            showSuccess(`🖼 폰트 완전 임베드 준비 완료 — 이 PC에 없는 폰트(${_outlineRasterInfo.fonts.join(', ')}) 사용 ${_outlineRasterInfo.count}쪽(${_outlineRasterInfo.pages.join(', ')}p)은 대체 임베드 대신 300DPI 이미지로 굳혔습니다.\n'⇩ 다운로드'를 누르면 이 결과가 그대로 저장됩니다 — 어디서 출력해도 화면과 동일.`);
          }
        }
      }
      catch (e) { console.warn('다운로드 최적화 프리웜 실패:', e); }
      finally { _optPrewarming = false; }
    }

    // ── 프린터 잉크 판정 (Ghostscript inkcov) ─────────────────────────────────
    // 화면(RGB) 판정과 달리 프린터 과금기는 CMY 잉크 사용으로 컬러를 센다.
    // 적용본(있으면)/원본을 gs inkcov로 돌려 '프린터가 셀 컬러 장수'를 예측해 보여준다.
    // 잉크 정규화 효과 검증에도 사용 — 정규화 적용본은 잉크 컬러가 실제 컬러 페이지만 남아야 정상.
    let _inkAnalyzing = false;
    async function analyzeInkCoverage() {
      if (_inkAnalyzing) return;
      const useProcessed = !!processedPdfBytes;
      const bytes = useProcessed ? processedPdfBytes : originalPdfBytes;
      if (!bytes) { showError('먼저 PDF를 열어 주세요.'); return; }
      _inkAnalyzing = true;
      setBtnBusy('inkBtn', true);
      let tmpPath = null;
      try {
        showLoading(`프린터 잉크 판정 중 — ${useProcessed ? '적용본' : '원본'}을 Ghostscript로 분석…`);
        const buf = bytes.slice ? bytes.slice(0) : bytes;
        tmpPath = window.electronAPI.writeTempFile(buf, 'pdf');
        const cov = await window.electronAPI.inkCoverage(tmpPath);
        // CMY 잉크가 조금이라도 쓰이면 프린터가 컬러로 셀 수 있는 페이지
        const EPS = 0.00005;
        const inkColorPages = [];
        cov.forEach((pg, i) => { if (pg.c > EPS || pg.m > EPS || pg.y > EPS) inkColorPages.push(i + 1); });
        const n = inkColorPages.length;
        const rgbColor = pageResults.filter(r => r && r.isColor && !r.isBlank).length;
        let msg = `🖨 프린터 기준(잉크) 컬러 ${n}장 / 흑백 ${cov.length - n}장 — 대상: ${useProcessed ? '적용본' : '원본'} ${cov.length}페이지`;
        msg += `\n화면(RGB) 판정 컬러는 ${rgbColor}장입니다.`;
        if (n > 0) msg += `\n잉크 컬러 페이지: ${formatRanges(inkColorPages)}`;
        if (!useProcessed && n > rgbColor) {
          msg += `\n▸ 차이 ${n - rgbColor}장은 리치블랙(CMYK 회색) 등 — '잉크 정규화'를 켜고 적용하면 흑백으로 정리됩니다.`;
        }
        if (useProcessed && processingOptions.inkNorm && n <= rgbColor) {
          msg += `\n▸ 잉크 정규화 정상 동작 — 프린터도 흑백 페이지를 흑백으로 과금합니다.`;
        }
        showSuccess(msg);
      } catch (e) {
        console.error('잉크 판정 오류:', e);
        showError('프린터 잉크 판정 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        if (tmpPath) { try { window.electronAPI.removeTempFile(tmpPath); } catch (e) {} }
        _inkAnalyzing = false;
        setBtnBusy('inkBtn', false);
        hideLoading();
      }
    }

    // ── 임포징 (제본용 조판): 중철(북클릿) / 정합(Cut & Stack) ─────────────────
    // 현재 편집·적용 상태(buildOptimizedOutput)를 소스로 제본용 시트 PDF를 생성한다.
    // 중철: 시트 k(바깥→안) 앞면 [N-2k | 2k+1], 뒷면 [2k+2 | N-2k-1] (좌철, 1-based)
    // 정합: 슬롯별 연속 구간(chunk) 배분 → 인쇄 후 재단해 묶음을 순서대로 겹치면 완성
    let _impMode = '';   // 기본: 임포징 방식 미선택 (사용자가 칩을 눌러 선택)
    let _bkBind = 'left';
    let _cutN = 2;       // 정합 분할 수 (2 = 2-up, 4 = 2×2)
    let _cutSides = 2;   // 정합 인쇄면 (2 = 양면, 1 = 단면)
    let _impEnabled = false;   // 임포징을 메인 '✔ 적용'·'⇩ 다운로드' 결과에 포함 (섹션 체크박스)
    let _impScale = 'orig';    // 슬롯 배치 크기: 'fit' = 칸에 맞춤 / 'orig' = 100% 원본(기본) / 'fixed' = 지정 배율
    // 재단선 스타일 — UI에서 읽음 (프로파일과 무관한 인쇄 보조 표식이라 항상 현재 값 사용)
    function _impCropStyle() {
      const g = id => document.getElementById(id);
      return {
        gap: parseFloat(g('impCropGap')?.value) || 1,
        len: parseFloat(g('impCropLen')?.value) || 3,
        th:  parseFloat(g('impCropTh')?.value) || 0.4,
        center: !!g('impCropCenter')?.checked,
      };
    }
    let _impProfile = null;    // 불러온 프로파일의 정규화 옵션(그대로 재현). UI를 만지면 null(→UI 기준).
    let _loadingProfile = false;

    // ── '📖 임포징 PDF 생성'은 1회용 ─────────────────────────────────────────
    // 같은 설정으로 다시 눌러도 결과가 같은데 매번 전체를 재조립해 시간을 버렸다.
    // 생성이 끝나면 버튼을 잠그고, 설정·문서·적용 상태가 바뀌면(invalidateProcessed 경유)
    // 자동으로 다시 열린다.
    let _impGenDone = false;
    function setImpGenDone(done) {
      _impGenDone = !!done;
      const b = document.getElementById('impGenBtn');
      if (!b) return;
      b.disabled = _impGenDone;
      b.textContent = _impGenDone ? '✅ 임포징 생성 완료 (설정을 바꾸면 다시 활성화)' : '📖 임포징 PDF 생성';
      b.title = _impGenDone
        ? '현재 설정으로 이미 생성했습니다. 임포징 옵션·페이지·흑백 선택을 바꾸면 다시 누를 수 있습니다.'
        : '현재 편집·적용 상태로 임포징 시트를 생성합니다.';
    }
    function impGenInvalidate() { if (_impGenDone) setImpGenDone(false); }


    // 임포징 포함 토글 — 켜면 적용·다운로드·실시간 미리보기가 임포징 시트를 최종 단계로 얹는다.
    // ('임포징 PDF 생성' 버튼을 누르면 자동으로 켜져 화면 결과와 메인 다운로드가 일치)
    function toggleImpEnabled(on) {
      const want = on === undefined ? !_impEnabled : !!on;
      // 방식 미선택 상태에서 포함을 켜려 하면 막고 안내 (기본은 미선택)
      if (want && !_impMode && !_impProfile) {
        _impEnabled = false;
        const chk0 = document.getElementById('impEnabled'); if (chk0) chk0.checked = false;
        showError('임포징 방식(중철·모아찍기·정합·반복·복제)을 먼저 선택하거나 프리셋을 불러오세요.');
        return;
      }
      _impEnabled = want;
      const chk = document.getElementById('impEnabled');
      if (chk && chk.checked !== _impEnabled) chk.checked = _impEnabled;
      invalidateProcessed();   // 직전 적용 결과 무효화 → 다시 적용해야 반영
      // 포함을 '켜는' 순간은 사용자가 명시적으로 요구한 행동이므로, 자동 반영(liveAutoPreview)이
      // 꺼져 있어도 전체화면 진입(enterEditWorkspace)과 똑같이 한 번은 강제로 그려 준다.
      // 이게 없으면 사이드바 상태에서는 화면이 그대로라 "임포징이 안 먹는다"로 보인다.
      // (이후 세부 옵션 변경은 기존 규칙대로 '적용 필요' 표시만 — 대용량 문서 재조립 비용 회피)
      if (want) runLivePreview();
      else scheduleLivePreview();
    }
    // 임포징 옵션 변경 — UI를 만지면 불러온 프로파일 재현을 해제(이후 UI 기준).
    // 포함 모드일 때 적용 결과 무효화 + 미리보기 갱신.
    function impSettingsChanged() {
      impGenInvalidate();                     // 설정이 바뀌면 '생성 완료' 잠금 해제
      if (_loadingProfile) return;            // 프로파일 불러오는 중 UI 세팅은 무시
      _impProfile = null;                     // 사용자가 손대면 UI 기준으로 전환
      if (typeof updateImpSheetReadout === 'function') updateImpSheetReadout();
      if (!_impEnabled) return;
      invalidateProcessed();
      scheduleLivePreview();
    }
    function setImpScale(mode) {
      _impScale = mode;
      document.querySelectorAll('#impScaleGroup .es-chip').forEach(b =>
        b.classList.toggle('active', b.dataset.scale === mode));
      impSettingsChanged();
    }

    function setImpMode(mode) {
      _impMode = mode;
      document.querySelectorAll('#impModeGroup .es-chip').forEach(b =>
        b.classList.toggle('active', b.dataset.imp === mode));
      const bk = mode === 'booklet', cs = mode === 'cutstack', rp = mode === 'repeat', nu = mode === 'nup';
      const g = id => document.getElementById(id);
      if (g('impBookletRow')) g('impBookletRow').style.display = bk ? '' : 'none';
      if (g('impBookletRow2')) g('impBookletRow2').style.display = bk ? '' : 'none';   // 표지 분리는 중철 전용
      if (g('impCutRow2'))    g('impCutRow2').style.display    = (cs || nu || mode === 'dup') ? '' : 'none';   // 단면/양면
      if (g('impGridRow'))    g('impGridRow').style.display    = (cs || nu) ? '' : 'none';   // 열×행 그리드
      if (g('impStackWrap'))  g('impStackWrap').style.display  = cs ? '' : 'none';   // 묶음번호는 정합 전용
      if (g('impRepRow'))     g('impRepRow').style.display     = rp ? '' : 'none';
      if (g('bkCreepWrap'))   g('bkCreepWrap').style.display   = bk ? 'flex' : 'none';   // 밀림보정은 중철 전용
      if (g('impHint')) g('impHint').innerHTML = bk
        ? '현재 편집·적용 상태 그대로 <b>중철 제본용 2-up 시트</b>(앞/뒤 교대)로 재배열합니다. 페이지 수는 4의 배수가 되도록 빈 면이 채워집니다.<br>인쇄: <b>가로 용지 · 양면 · 짧은 쪽 넘김</b> → 반 접어 중철. <b>📕 표지 분리</b>를 켜면 표지 시트(두꺼운 용지용)와 내지가 별도 PDF 2개로 저장됩니다.'
        : nu
        ? '<b>모아찍기(N-up)</b> — 연속 페이지를 한 시트에 <b>열×행</b> 그리드로 앉힙니다(슬라이드 유인물·대지 앉히기 등). 배치 크기(칸맞춤/100%/지정배율)·정렬·여백·거터·프레임을 조합하세요. 양면 선택 시 뒷면은 좌우 미러됩니다.'
        : cs
        ? '연속 구간을 칸별로 배분해 <b>인쇄 후 재단하면 묶음이 페이지 순서대로 겹쳐지는</b> 정합(Cut&amp;Stack) 시트를 <b>열×행</b> 그리드로 생성합니다.<br>인쇄 후 재단 → 왼쪽(위) 묶음부터 차례로 겹치기.'
        : rp
        ? '명함·쿠폰·전단용 <b>같은 원고 반복 배치</b>. 각 페이지를 한 시트에 여러 벌 깔아 별도 PDF로 저장합니다.<br>배치를 비우면 <b>원고 실제 크기</b>로 최대 배치(용지 방향 자동 선택), 칸수를 지정하면 칸에 맞춰 확대/축소됩니다.'
        : mode === 'dup'
        ? '한 시트에 같은 페이지 <b>2벌(오른쪽 벌 180° 회전)</b>을 양면으로 앉힙니다 — Quite Imposing의 <b>1 1* 2* 2</b> 방식.<br>인쇄: <b>가로 용지 · 양면 · 짧은 쪽 넘김</b> → 세로 재단 → 같은 문서 <b>2部</b> 완성.'
        : '임포징 방식을 <b>선택하지 않은 기본 상태</b>입니다. 위에서 방식(중철·모아찍기·정합·반복·복제)을 고르거나 프로파일을 불러오면 옵션이 나타납니다.';
      impSettingsChanged();
    }
    function setBookletBind(dir) {
      _bkBind = dir;
      document.querySelectorAll('#bkBindGroup .es-chip').forEach(b =>
        b.classList.toggle('active', b.dataset.bind === dir));
      impSettingsChanged();
    }
    function setCutN(n) {
      _cutN = n;
      document.querySelectorAll('#cutNGroup .es-chip').forEach(b =>
        b.classList.toggle('active', +b.dataset.cutn === n));
      impSettingsChanged();
    }
    function setCutSides(s) {
      _cutSides = s;
      document.querySelectorAll('#cutSidesGroup .es-chip').forEach(b =>
        b.classList.toggle('active', +b.dataset.sides === s));
      impSettingsChanged();
    }

    // ── 사용자 정의(비규격) 용지 레지스트리 (localStorage 'customPapers', mm) ──
    function loadCustomPapers() {
      try { const a = JSON.parse(localStorage.getItem('customPapers')); return Array.isArray(a) ? a : []; }
      catch (e) { return []; }
    }
    function saveCustomPapers(list) {
      try { localStorage.setItem('customPapers', JSON.stringify(list)); } catch (e) {}
    }
    // 용지 드롭다운 재구성 — 표준 용지 + '사용자 정의' 그룹. keep = 유지할 선택값
    function populatePaperSelect(keep) {
      const sel = document.getElementById('bkPaper');
      if (!sel) return;
      const cur = keep !== undefined ? keep : sel.value;
      let html = '<option value="auto">자동 (원본 크기 기준)</option>'
               + '<option value="__custom__">사용자 지정 (직접 W×H 입력)</option>';
      ['A4', 'A3', 'B4', 'B5'].forEach(k => { html += `<option value="${k}">${k}</option>`; });
      const customs = loadCustomPapers();
      if (customs.length) {
        html += '<optgroup label="사용자 정의">';
        customs.forEach(p => {
          const nm = String(p.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
          html += `<option value="custom:${nm}">${nm} (${p.w}×${p.h}mm)</option>`;
        });
        html += '</optgroup>';
      }
      sel.innerHTML = html;
      sel.value = cur && [...sel.options].some(o => o.value === cur) ? cur : 'auto';
    }
    // (사용자 정의 용지 등록은 임포징 섹션의 '사용자 지정' 직접입력 → saveImpCustomAsNamed로 통합)
    function deleteCustomPaper() {
      const sel = document.getElementById('bkPaper');
      if (!sel || !sel.value.startsWith('custom:')) { showError('삭제하려면 사용자 정의 용지를 먼저 선택하세요.'); return; }
      const name = sel.value.slice(7);
      saveCustomPapers(loadCustomPapers().filter(p => p.name !== name));
      populatePaperSelect('auto');
      showSuccess(`사용자 정의 용지 '${name}'를 삭제했습니다.`);
    }
    populatePaperSelect('auto');   // 초기 드롭다운 구성 (등록된 사용자 용지 복원)
    // 프로파일 시드(IMP_PROFILE_SEED const)는 파일 뒤쪽에 선언되므로 setTimeout으로 초기화 지연(TDZ 회피)
    setTimeout(() => {
      try { setImpMode(''); } catch (e) {}   // 기본: 방식 미선택(모든 모드행 숨김)
      try { populateImpProfiles(''); updateImpSheetReadout(); } catch (e) { console.warn('임포징 프로파일 초기화 실패:', e); }
    }, 0);

    // 용지 선택값 → 시트 크기 [w,h](pt) 해석. orient: 'landscape'|'portrait' 강제.
    // 'auto'는 null 반환(빌더가 원본 크기로 계산).
    function resolveImpPaper(value, orient) {
      if (!value || value === 'auto') return null;
      let wpt, hpt;
      if (value === '__custom__') {
        // 사용자 지정 직접 입력 (impCustomW × impCustomH mm)
        const w = parseFloat(document.getElementById('impCustomW')?.value);
        const h = parseFloat(document.getElementById('impCustomH')?.value);
        if (!(w > 0) || !(h > 0)) return null;
        wpt = w * 72 / 25.4; hpt = h * 72 / 25.4;
      } else if (value.startsWith('custom:')) {
        const p = loadCustomPapers().find(x => x.name === value.slice(7));
        if (!p) return null;
        wpt = p.w * 72 / 25.4; hpt = p.h * 72 / 25.4;
      } else {
        const base = IMP_PAPERS[value] || IMP_PAPERS.A4;   // IMP_PAPERS는 가로 기준
        wpt = base[0]; hpt = base[1];
      }
      if (orient === 'landscape' && hpt > wpt) [wpt, hpt] = [hpt, wpt];
      if (orient === 'portrait'  && wpt > hpt) [wpt, hpt] = [hpt, wpt];
      return [wpt, hpt];
    }

    // 중철 페이지 순서 계산 (순수 함수 — 검증 용이하게 분리)
    // n: 4의 배수로 패딩된 총 쪽수. 반환: 시트별 { front:[L,R], back:[L,R] } (1-based, n0 초과 = 빈 면)
    function bookletSheetOrder(n, binding) {
      const sheets = [];
      for (let i = 0; i < n / 4; i++) {
        let front = [n - 2 * i, 2 * i + 1];
        let back  = [2 * i + 2, n - 2 * i - 1];
        if (binding === 'right') { front = [front[1], front[0]]; back = [back[1], back[0]]; }
        sheets.push({ front, back });
      }
      return sheets;
    }

    // 임포징 공용: 원본 페이지 전체 임베드 — /Rotate는 embedPage가 무시하므로 변환행렬로 굽는다.
    // 행렬 유도: /Rotate 90(시계방향 표시) → 표시좌표 X=y, Y=w-x … 각도별 대응.
    // extraRot: 페이지 /Rotate에 더할 추가 회전(도) — 복제 2-up의 180° 벌 등에 사용.
    // 반환: [{ e, w, h }] (w/h = 회전 반영된 표시 크기)
    // Contents가 없거나 깨진(허상 참조) 페이지는 pdf-lib embedPage가
    // "Can't embed page with missing Contents"로 실패한다 — embedPage와 같은 판정
    // (normalizedEntries().Contents)으로 검사해서, 깨졌으면 Contents를 제거하고 보이지 않는
    // 사각형을 그려 새 콘텐츠 스트림을 만들어 준다(출력에는 아무것도 안 보임).
    function ensurePageContents(pg, force) {
      try {
        let broken = !!force;
        if (!broken) {
          try { broken = !pg.node.normalizedEntries().Contents; }
          catch (e) { broken = true; }
        }
        if (broken) {
          try { pg.node.delete(PDFLib.PDFName.of('Contents')); } catch (e) {}
          pg.drawRectangle({ x: 0, y: 0, width: 0.01, height: 0.01, opacity: 0, borderOpacity: 0 });
        }
      } catch (e) {}
    }
    // ✂ 원고가 이미 블리드를 품고 있으면(◲ 블리드 생성본·일러스트 아트보드 등) TrimBox가
    // MediaBox보다 작다. 재단선·프레임은 반드시 그 '트림' 사각형에 찍혀야 하므로(블리드 안쪽),
    // 표시 좌표 기준 사방 인셋(pt)을 구해 임베드 항목에 실어 둔다.
    // 회전(/Rotate)이 있으면 표시 방향에 맞춰 인셋도 같이 돌린다.
    //   90°: 좌→상·우→하·하→좌·상→우 / 180°: 좌↔우·상↔하 / 270°: 좌→하·우→상·하→우·상→좌
    function pageTrimInset(pg, w, h, rot) {
      let tb = null, mb = null;
      try { tb = pg.getTrimBox(); } catch (e) { return null; }
      if (!tb || !(tb.width > 0) || !(tb.height > 0)) return null;
      try { mb = pg.getMediaBox(); } catch (e) { mb = null; }
      const ox = mb ? (mb.x || 0) : 0, oy = mb ? (mb.y || 0) : 0;
      let l = tb.x - ox, b = tb.y - oy;
      let r = w - (l + tb.width), t = h - (b + tb.height);
      const eps = 0.05;
      if (l < -eps || b < -eps || r < -eps || t < -eps) return null;      // 미디어 밖으로 나간 비정상 트림
      if (l + r < eps && b + t < eps) return null;                        // 트림 = 미디어 → 인셋 없음
      if (tb.width < w * 0.5 || tb.height < h * 0.5) return null;         // 절반 이하는 재단여백이 아님 — 무시
      l = Math.max(0, l); b = Math.max(0, b); r = Math.max(0, r); t = Math.max(0, t);
      if (rot === 90)  return { l: b, r: t, b: r, t: l };
      if (rot === 180) return { l: r, r: l, b: t, t: b };
      if (rot === 270) return { l: t, r: b, b: l, t: r };
      return { l, r, b, t };
    }
    async function embedAllPages(out, src, onProgress, extraRot) {
      const n0 = src.getPageCount();
      const embedded = [];
      for (let i = 0; i < n0; i++) {
        const pg = src.getPage(i);
        ensurePageContents(pg);
        const { width: w, height: h } = pg.getSize();
        const rot = (((pg.getRotation().angle + (extraRot || 0)) % 360) + 360) % 360;
        let mtx, ew, eh;
        if (rot === 90)       { mtx = [0, -1, 1, 0, 0, w];  ew = h; eh = w; }
        else if (rot === 180) { mtx = [-1, 0, 0, -1, w, h]; ew = w; eh = h; }
        else if (rot === 270) { mtx = [0, 1, -1, 0, h, 0];  ew = h; eh = w; }
        else                  { mtx = undefined;            ew = w; eh = h; }
        let epg;
        try { epg = await out.embedPage(pg, undefined, mtx); }
        catch (err) { ensurePageContents(pg, true); epg = await out.embedPage(pg, undefined, mtx); }   // 강제 복구 후 1회 재시도
        embedded.push({ e: epg, w: ew, h: eh, trim: pageTrimInset(pg, w, h, rot) });
        if (onProgress && (i & 15) === 0) onProgress(Math.round(i / n0 * 40));
        await uiYield();   // 대용량 문서 임베드 중에도 화면이 멈추지 않게 주기적으로 양보
      }
      return embedded;
    }
    // ── ◲ 블리드 자동 생성 — 재단여백 없는 원고의 가장자리를 미러로 확장 ─────
    // 각 페이지를 (w+2b)×(h+2b) 새 페이지 중앙에 놓고, 상하좌우+모서리 8방향에
    // 미러(음수 스케일) 사본을 해당 스트립만 클립해 그린다. TrimBox=원본 영역.
    // 벡터 원본이 그대로 유지된다(래스터화 없음). 회전 페이지는 embedAllPages가 보정.
    // ◲ 블리드 옵션 상태 — 켜 두면 적용·다운로드·미리보기의 최종 단계(임포징 앞)에 항상 포함.
    // (예전 1회성 버튼은 다른 작업 시 invalidateProcessed로 결과가 사라져 "삭제된다"로 보였음)
    let _bleedEnabled = false;
    function _bleedOpts() {
      return {
        mm: Math.max(0.5, Math.min(20, parseFloat(document.getElementById('bleedGenMm')?.value) || 3)),
        crop: !!document.getElementById('bleedCrop')?.checked,
      };
    }
    function bleedSig() {
      if (!_bleedEnabled) return '';
      const o = _bleedOpts();
      return `::BL${o.mm}${o.crop ? 'c' : ''}`;
    }
    function setBleedEnabled(on) {
      _bleedEnabled = !!on;
      const chk = document.getElementById('bleedEnabled');
      if (chk && chk.checked !== _bleedEnabled) chk.checked = _bleedEnabled;
      if (typeof updateEsGroupBadges === 'function') updateEsGroupBadges();
      invalidateProcessed();
      scheduleLivePreview();
      if (_bleedEnabled) {
        const o = _bleedOpts();
        showSuccess(`◲ 블리드 생성 켜짐 — 사방 ${o.mm}mm 미러 확장${o.crop ? ' + 트림 재단선' : ''}이 '✔ 적용'과 '⇩ 다운로드'에 항상 포함됩니다.\n다른 편집을 해도 유지됩니다. 끄려면 체크를 해제하세요.`);
      }
    }
    function bleedSettingsChanged() {
      if (!_bleedEnabled) return;
      invalidateProcessed();
      scheduleLivePreview();
    }
    // 파이프라인 공용 블리드 단계 — 결과 캐시(입력 지문+옵션)로 라이브 미리보기 반복에 대비
    let _bleedCache = { sig: null, bytes: null };
    async function applyBleedStage(bytes, onProgress) {
      if (!_bleedEnabled) return bytes;
      const o = _bleedOpts();
      const sig = bytesFingerprint(bytes) + '|' + o.mm + '|' + o.crop;
      if (_bleedCache.sig === sig && _bleedCache.bytes) return _bleedCache.bytes;
      const res = await buildBleedBytes(bytes, o.mm, onProgress, { crop: o.crop });
      _bleedCache = { sig, bytes: res.bytes };
      return res.bytes;
    }
    async function buildBleedBytes(srcBytes, bleedMm, onProgress, opts) {
      const MM = 72 / 25.4, b = bleedMm * MM;
      const src = await PDFLib.PDFDocument.load(srcBytes.slice ? srcBytes.slice(0) : srcBytes);
      const out = await PDFLib.PDFDocument.create();
      const embedded = await embedAllPages(out, src, onProgress);
      const { pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath, PDFName } = PDFLib;
      const clipDraw = (pg, cx, cy, cw, ch, e, opts) => {
        pg.pushOperators(pushGraphicsState(), moveTo(cx, cy), lineTo(cx+cw, cy), lineTo(cx+cw, cy+ch), lineTo(cx, cy+ch), closePath(), clip(), endPath());
        pg.drawPage(e, opts);
        pg.pushOperators(popGraphicsState());
      };
      for (let i = 0; i < embedded.length; i++) {
        const { e, w, h } = embedded[i];
        const pg = out.addPage([w + 2*b, h + 2*b]);
        pg.drawPage(e, { x: b, y: b });                                             // 중앙 원본
        clipDraw(pg, 0,     b,     b, h, e, { x: b,       y: b,       xScale:-1 });               // 좌
        clipDraw(pg, b+w,   b,     b, h, e, { x: b+2*w,   y: b,       xScale:-1 });               // 우
        clipDraw(pg, b,     0,     w, b, e, { x: b,       y: b,       yScale:-1 });               // 하
        clipDraw(pg, b,     b+h,   w, b, e, { x: b,       y: b+2*h,   yScale:-1 });               // 상
        clipDraw(pg, 0,     0,     b, b, e, { x: b,       y: b,       xScale:-1, yScale:-1 });    // 좌하
        clipDraw(pg, b+w,   0,     b, b, e, { x: b+2*w,   y: b,       xScale:-1, yScale:-1 });    // 우하
        clipDraw(pg, 0,     b+h,   b, b, e, { x: b,       y: b+2*h,   xScale:-1, yScale:-1 });    // 좌상
        clipDraw(pg, b+w,   b+h,   b, b, e, { x: b+2*w,   y: b+2*h,   xScale:-1, yScale:-1 });    // 우상
        // 재단 정보 기록 — 임포징·출력기가 트림 위치를 알 수 있게
        pg.node.set(PDFName.of('TrimBox'),  out.context.obj([b, b, b+w, b+h]));
        pg.node.set(PDFName.of('BleedBox'), out.context.obj([0, 0, w+2*b, h+2*b]));
        // ✂ 재단선 — 트림 모서리에, 블리드 영역 안에 딱 맞게 (간격+길이 = 블리드 폭)
        if (opts && opts.crop) {
          const gap = Math.min(1, bleedMm * 0.25);
          drawCropMarks(pg, b, b, w, h, { gap, len: Math.max(1, bleedMm - gap), th: 0.4 });
        }
        if (onProgress && (i & 7) === 0) onProgress(40 + Math.round(i / embedded.length * 60));
        await uiYield();
      }
      return { bytes: await out.save({ useObjectStreams: false, updateFieldAppearances: false }), n: embedded.length };
    }
    async function generateBleed() {
      if (_bkBusy) return;
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      const mm = parseFloat(document.getElementById('bleedGenMm')?.value) || 3;
      if (mm < 0.5 || mm > 20) { showError('블리드 폭은 0.5~20mm 사이로 입력하세요.'); return; }
      _bkBusy = true;
      setBtnBusy('bleedGenBtn', true);
      try {
        showLoading('블리드 생성 — 최신 편집 상태 준비 중…');
        progressBar.style.display = 'block'; updateProgress(0);
        const srcBytes = await buildOptimizedBase(p => updateProgress(Math.round(p * 0.4)));
        showLoading(`블리드 생성 — 가장자리 미러 확장 중… (${mm}mm)`);
        const res = await buildBleedBytes(srcBytes, mm, p => updateProgress(Math.min(99, 40 + Math.round(p * 0.6))));
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        try { renderProcessedPreview(res.bytes); } catch (e) { console.warn('블리드 미리보기 실패:', e); }
        const base = effectiveBaseName();   // 챕터 삭제 후에는 남은 첫 챕터명
        processedPdfBytes = res.bytes;
        directOutputBytes = res.bytes;   // 외부 변환 결과 — 다운로드 시 재조립 없이 그대로 저장
        processedFileName = `${base}_블리드${mm}mm.pdf`;
        setDirty(true); updateDownloadBtn();
        showSuccess(`◲ 블리드 ${mm}mm 생성 완료 — ${res.n}쪽 (가장자리 미러 확장 · 트림박스 기록)`
          + `\n페이지가 사방 ${mm}mm씩 커졌습니다. 저장은 '⇩ 다운로드'`
          + `\n다음: 저장한 파일로 임포징(재단선 켜기) → 인쇄 → 트림선 따라 재단`);
      } catch (e) {
        console.error('블리드 생성 오류:', e);
        showError('블리드 생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; setBtnBusy('bleedGenBtn', false);
        hideLoading(); progressBar.style.display = 'none';
      }
    }

    // ── 📕 표지 만들기 — 선택 페이지 추출 / 무선제본 표지 스프레드 ─────────────
    // 책등폭(mm) — 순수 함수 (노드 단독 검증 가능).
    // 양면(duplex=기본): 종이 1장 = 2쪽 → 장수 = 쪽수÷2 올림 (= 용지두께를 쪽당 절반 적용)
    // 단면: 종이 1장 = 1쪽 → 장수 = 쪽수
    function coverSpineMm(bodyPages, thickMm, duplex) {
      const n = Math.max(0, bodyPages | 0);
      const sheets = duplex === false ? n : Math.ceil(n / 2);
      return Math.round(sheets * (thickMm || 0) * 100) / 100;
    }
    // 단일 페이지 임베드 — /Rotate를 변환행렬로 굽기 (embedAllPages와 동일 규약, 1페이지판)
    async function embedPageRot(out, src, idx) {
      const pg = src.getPage(idx);
      ensurePageContents(pg);   // 빈 페이지 embedPage 실패 방지
      const { width: w, height: h } = pg.getSize();
      const rot = (((pg.getRotation().angle || 0) % 360) + 360) % 360;
      let mtx, ew, eh;
      if (rot === 90)       { mtx = [0, -1, 1, 0, 0, w];  ew = h; eh = w; }
      else if (rot === 180) { mtx = [-1, 0, 0, -1, w, h]; ew = w; eh = h; }
      else if (rot === 270) { mtx = [0, 1, -1, 0, h, 0];  ew = h; eh = w; }
      else                  { mtx = undefined;            ew = w; eh = h; }
      return { e: await out.embedPage(pg, undefined, mtx), w: ew, h: eh };
    }
    // 캔버스 텍스트 → PNG 임베드 (책등 텍스트용 — 한글 포함, 시스템 글꼴로 그림)
    async function coverTextPng(out, text, sizePt) {
      const SS = 3, fpx = sizePt * SS;
      const c = document.createElement('canvas');
      const mctx = c.getContext('2d');
      mctx.font = `600 ${fpx}px "Malgun Gothic", "맑은 고딕", sans-serif`;
      const tw = Math.ceil(mctx.measureText(text).width);
      c.width = tw + fpx; c.height = Math.ceil(fpx * 1.35);
      const ctx = c.getContext('2d');
      ctx.font = `600 ${fpx}px "Malgun Gothic", "맑은 고딕", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#000';
      ctx.fillText(text, c.width / 2, c.height / 2);
      const bytes = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0));
      const png = await out.embedPng(bytes);
      return { png, w: c.width / SS, h: c.height / SS };
    }
    // 무선제본 표지 스프레드: [뒤표지 | 책등 | 앞표지] 한 판 + 블리드·재단선·오시선(접는선)
    // o: { frontIdx, backIdx(0-based), spineMm, bleedMm, crop, fold, spineText }
    async function buildCoverSpreadBytes(srcBytes, o) {
      const MM = 72 / 25.4;
      const src = await PDFLib.PDFDocument.load(srcBytes.slice ? srcBytes.slice(0) : srcBytes);
      const out = await PDFLib.PDFDocument.create();
      const front = await embedPageRot(out, src, o.frontIdx);
      const back  = await embedPageRot(out, src, o.backIdx);
      // 트림 = 사전설정 크기(mm) 지정 시 그 크기, 아니면 앞표지 크기
      const tw = o.trimWmm > 0 ? o.trimWmm * MM : front.w;
      const th = o.trimHmm > 0 ? o.trimHmm * MM : front.h;
      const sp = Math.max(0, o.spineMm || 0) * MM;
      const b  = Math.max(0, o.bleedMm || 0) * MM;
      const m  = (o.crop || o.fold || o.spineLabelText || o.creaseLabel) ? 6 * MM : 0;  // 재단선·오시선·수치 표시용 바깥 여백
      // 대지 지정: 트림 블록을 여백선 기준으로 배치 — 트림 왼쪽=좌여백선, 트림 아래=하여백선.
      // (제본기 급지 기준이 명확해지고, 누름선 값은 대지 좌측 모서리부터의 거리로 표기)
      const sheet = o.sheetWmm > 0 && o.sheetHmm > 0;
      const mg = o.sheetMgMm || { t: 0, b: 0, l: 0, r: 0 };
      let W, H, ox, oy;
      if (sheet) {
        W = o.sheetWmm * MM; H = o.sheetHmm * MM;
        ox = (mg.l || 0) * MM; oy = (mg.b || 0) * MM;
        const needW = (mg.l || 0) + (tw * 2 + sp) / MM + (mg.r || 0);
        const needH = (mg.b || 0) + th / MM + (mg.t || 0);
        if (needW > o.sheetWmm + 0.01 || needH > o.sheetHmm + 0.01)
          throw new Error(`대지가 작습니다 — 여백 포함 필요 크기 ${Math.ceil(needW)}×${Math.ceil(needH)}mm, 대지 ${o.sheetWmm}×${o.sheetHmm}mm. 대지를 키우거나 여백·표지 크기를 줄이세요.`);
      } else {
        W = tw * 2 + sp + 2 * b + 2 * m; H = th + 2 * b + 2 * m;
        ox = m + b; oy = m + b;
      }
      const page = out.addPage([W, H]);
      const { pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath, PDFName } = PDFLib;
      const clipDraw = (cx, cy, cw, ch, fn) => {
        page.pushOperators(pushGraphicsState(), moveTo(cx, cy), lineTo(cx + cw, cy), lineTo(cx + cw, cy + ch), lineTo(cx, cy + ch), closePath(), clip(), endPath());
        fn();
        page.pushOperators(popGraphicsState());
      };
      // 각 표지: 트림에 맞춤 → 블리드만큼 확대해 중앙 배치. 클립은 책등 중앙까지 —
      // 꽉 찬 표지 원고면 책등까지 자연스럽게 이어지고, 반대편 표지는 침범하지 않는다.
      const drawCover = (emb, trimX, clipX, clipW) => {
        const s0 = Math.min(tw / emb.w, th / emb.h);
        const k = b > 0 ? Math.max((tw + 2 * b) / tw, (th + 2 * b) / th) : 1;
        const s = s0 * k;
        const cx = trimX + tw / 2, cy = oy + th / 2;
        clipDraw(clipX, 0, clipW, H, () =>
          page.drawPage(emb.e, { x: cx - emb.w * s / 2, y: cy - emb.h * s / 2, xScale: s, yScale: s }));
      };
      const backX = ox, frontX = ox + tw + sp;                // 각 트림의 왼쪽 x
      const spineMid = ox + tw + sp / 2;
      drawCover(back,  backX,  0,        spineMid);
      drawCover(front, frontX, spineMid, W - spineMid);
      // 세네카(책등) 텍스트 — 세로(90° 시계방향, 위→아래로 읽힘), 책등폭·높이에 맞게 자동 축소.
      // 위치: 상단/중앙/하단 + 이동(mm, +아래). 크기: pt 지정(공간에 안 맞으면 자동 축소).
      if (o.spineText && o.spineText.trim() && sp > 2) {
        const im = await coverTextPng(out, o.spineText.trim(), Math.max(4, o.spineSizePt || 12));
        const fit = Math.min(1, (sp * 0.7) / im.h, (th * 0.85) / im.w);
        const iw = im.w * fit, ih = im.h * fit;
        const pad = 3 * MM;   // 상·하단 앵커 시 트림에서 띄우는 기본 간격
        let cy = oy + th / 2;
        if (o.spineTextPos === 'top')    cy = oy + th - iw / 2 - pad;
        else if (o.spineTextPos === 'bottom') cy = oy + iw / 2 + pad;
        cy -= (o.spineTextOffMm || 0) * MM;   // + = 아래로
        // rotate −90°: 앵커 기준 (u,v)→(v,−u) — 중심이 (spineMid, cy)에 오도록 앵커 역산
        page.drawImage(im.png, { x: spineMid - ih / 2, y: cy + iw / 2, width: iw, height: ih, rotate: PDFLib.degrees(-90) });
      }
      const trimAll = { x: ox, y: oy, w: tw * 2 + sp, h: th };
      if (o.crop) drawCropMarks(page, trimAll.x, trimAll.y, trimAll.w, trimAll.h, { gap: (o.bleedMm || 0) + 1, len: 4, th: 0.4, center: !!o.centerMarks });
      // 라벨 영역: 트림 위/아래에서 블리드를 뺀 순수 여백 폭 (자동 모드=m, 대지 모드=여백−블리드)
      const botZone = Math.max(0, oy - b);
      const topZone = Math.max(0, H - (oy + th) - b);
      // 책등두께 표시 — 위 여백(재단 영역 바깥)에 수치 인쇄 (작업자 확인용)
      if (o.spineLabelText && topZone > 4) {
        const im = await coverTextPng(out, o.spineLabelText, 8);
        const fit = Math.min(1, (topZone * 0.75) / im.h, (W * 0.5) / im.w);
        const iw = im.w * fit, ih = im.h * fit;
        page.drawImage(im.png, { x: spineMid - iw / 2, y: oy + th + b + (topZone - ih) / 2, width: iw, height: ih });
      }
      // 누름선 값 표기 — 하단 여백에 제본기 세팅용 4개 값.
      // [도랑, 책등 시작, 책등 끝, 도랑] = 기준점 + [W−도랑, W, W+책등, W+책등+도랑]
      // 기준점: 자동 대지=뒤표지 재단선(0, 표지가로 기준), 대지 지정=대지 좌측 모서리(좌여백 포함 — 급지 기준).
      // 오른쪽 절반=정방향, 왼쪽 절반=180° 뒤집힘 — 시트를 어느 방향으로 잡아도 읽히게(캡처 관행).
      if (o.creaseLabel && botZone > 4) {
        const MMv = 72 / 25.4;
        const twMm = Math.round(tw / MMv * 10) / 10, thMm = Math.round(th / MMv * 10) / 10;
        const spMm = Math.round(sp / MMv * 10) / 10, hg = Math.max(0, o.hingeMm || 0);
        const base = sheet ? Math.round(ox / MMv * 10) / 10 : 0;   // 대지 모드: 좌여백만큼 더해 급지 기준으로
        const r1 = v => Math.round(v * 10) / 10;
        const creases = [r1(base + twMm - hg), r1(base + twMm), r1(base + twMm + spMm), r1(base + twMm + spMm + hg)];
        const refName = sheet ? '대지좌측 기준' : '표지가로 기준';
        const label = `[책등 두께: ${spMm}mm]   [표지크기: ${twMm}mm x${thMm}mm]   |   [ ${refName} 누름선: ${creases.join('mm, ')}mm ]`;
        const im = await coverTextPng(out, label, 7);
        const fit = Math.min(1, (botZone * 0.7) / im.h, (tw * 0.9) / im.w);
        const iw = im.w * fit, ih = im.h * fit;
        const yMid = (botZone - ih) / 2;
        const cxFront = ox + tw + sp + tw / 2;      // 앞표지 아래 — 정방향
        page.drawImage(im.png, { x: cxFront - iw / 2, y: yMid, width: iw, height: ih });
        const cxBack = ox + tw / 2;                 // 뒤표지 아래 — 180° (반대 방향에서 읽기)
        page.drawImage(im.png, { x: cxBack + iw / 2, y: yMid + ih, width: iw, height: ih, rotate: PDFLib.degrees(180) });
      }
      if (o.fold && sp > 0) {
        // 오시선(접는선) — 책등 양쪽 경계 위·아래 여백에 짧은 선 (재단 후 접는 위치 표시)
        const black = PDFLib.rgb(0, 0, 0);
        const gap = ((o.bleedMm || 0) + 1) * MM, len = 4 * MM;
        [ox + tw, ox + tw + sp].forEach(fx => {
          page.drawLine({ start: { x: fx, y: trimAll.y - gap }, end: { x: fx, y: Math.max(0, trimAll.y - gap - len) }, thickness: 0.4, color: black, dashArray: [2, 2] });
          page.drawLine({ start: { x: fx, y: trimAll.y + th + gap }, end: { x: fx, y: Math.min(H, trimAll.y + th + gap + len) }, thickness: 0.4, color: black, dashArray: [2, 2] });
        });
      }
      // TrimBox 기록 — 출력기·후속 임포징이 재단 위치를 알 수 있게
      page.node.set(PDFName.of('TrimBox'), out.context.obj([trimAll.x, trimAll.y, trimAll.x + trimAll.w, trimAll.y + trimAll.h]));
      return out.save({ useObjectStreams: false, updateFieldAppearances: false });
    }
    // UI: 표지 모드 전환 + 책등폭 읽어주기
    function setCoverMode(m) {
      _coverMode = m;
      if (typeof activateChip === 'function') activateChip('covermode', m);
      const opts = document.getElementById('coverSpreadOpts');
      if (opts) opts.style.display = m === 'spread' ? '' : 'none';
      updateCoverSpineInfo();
    }
    let _coverMode = 'extract';
    // 외부 표지 파일 — { name, type:'pdf'|'png'|'jpg', bytes }. PDF·AI는 1쪽째를 사용,
    // PSD는 포토샵 변환 경유. 선택 후 프레임 조절 모달을 거친다(인디자인 사각 프레임 방식).
    let _coverFiles = { front: null, back: null };
    async function pickCoverFile(which) {
      try {
        const p = await window.electronAPI.openCoverFile();
        if (!p) return;
        const name = p.split(/[\\/]/).pop();
        const ext = (name.split('.').pop() || '').toLowerCase();
        let bytes, type;
        if (ext === 'psd') {
          showLoading('PSD → PDF 변환 중… (Photoshop 자동 실행)');
          const convPath = await window.electronAPI.convertAdobeToPdf(p);
          hideLoading();
          bytes = new Uint8Array(window.electronAPI.readFile(convPath));
          try { window.electronAPI.cleanupTempFile && window.electronAPI.cleanupTempFile(convPath); } catch (e) {}
          type = 'pdf';
        } else if (ext === 'ai') {
          // .ai: PDF 호환 저장본(%PDF 헤더)이면 그대로, 아니면 InDesign 경유 변환
          bytes = new Uint8Array(window.electronAPI.readFile(p));
          const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
          if (!isPdf) {
            showLoading('AI → PDF 변환 중…');
            const convPath = await window.electronAPI.convertAdobeToPdf(p);
            hideLoading();
            bytes = new Uint8Array(window.electronAPI.readFile(convPath));
            try { window.electronAPI.cleanupTempFile && window.electronAPI.cleanupTempFile(convPath); } catch (e) {}
          }
          type = 'pdf';
        } else {
          bytes = new Uint8Array(window.electronAPI.readFile(p));
          type = ext === 'pdf' ? 'pdf' : (ext === 'png' ? 'png' : 'jpg');
        }
        await openCoverFrameModal(which, { name, type, bytes });
      } catch (e) { hideLoading(); showError('표지 파일 읽기 실패: ' + (e && e.message ? e.message : e)); }
    }
    // ── 🖼 표지 프레임 조절 모달 (인디자인 사각 프레임 방식) ─────────────────
    // 프레임(mm) 안에서 내용을 드래그·배율로 배치 → 적용 시 프레임 크기의 1쪽 PDF로
    // 굽고 밖은 클립으로 제거. 상태 좌표계: 프레임 pt, 원점 좌상단(y 아래로).
    let _cf = null;   // { which, file, src(canvas), sw, sh(내용 pt), s, ox, oy, fwMm, fhMm }
    async function openCoverFrameModal(which, file) {
      // 내용 미리보기 소스 준비 (pdf.js 렌더 또는 이미지 디코드)
      let srcCanvas, sw, sh;
      if (file.type === 'pdf') {
        const pdf = await pdfjsLib.getDocument({ data: file.bytes.slice(0) }).promise;
        try {
          const page = await pdf.getPage(1);
          const vp1 = page.getViewport({ scale: 1 });
          sw = vp1.width; sh = vp1.height;
          const scale = Math.min(3, 1600 / Math.max(vp1.width, vp1.height));
          const vp = page.getViewport({ scale });
          srcCanvas = document.createElement('canvas');
          srcCanvas.width = Math.ceil(vp.width); srcCanvas.height = Math.ceil(vp.height);
          const ctx = srcCanvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, srcCanvas.width, srcCanvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          page.cleanup();
        } finally { try { await pdf.destroy(); } catch (e) {} }
      } else {
        const bmp = await createImageBitmap(new Blob([file.bytes]));
        sw = bmp.width; sh = bmp.height;   // 이미지: 1px = 1pt 규약 (임베드와 동일)
        srcCanvas = document.createElement('canvas');
        srcCanvas.width = bmp.width; srcCanvas.height = bmp.height;
        srcCanvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
      }
      const c = _coverInputs();
      const fwMm = c.sizeMm ? c.sizeMm[0] : 210, fhMm = c.sizeMm ? c.sizeMm[1] : 297;
      _cf = { which, file, src: srcCanvas, sw, sh, s: 1, ox: 0, oy: 0, fwMm, fhMm };
      document.getElementById('cfW').value = fwMm;
      document.getElementById('cfH').value = fhMm;
      document.getElementById('cfName').textContent = `— ${file.name} (${which === 'front' ? '앞' : '뒤'}표지)`;
      cfFit('cover');
      document.getElementById('coverFrameModal').style.display = 'block';
      _cfBindEvents();
    }
    const MM_PT = 72 / 25.4;
    function _cfFramePt() { return [(_cf.fwMm || 210) * MM_PT, (_cf.fhMm || 297) * MM_PT]; }
    // 캔버스 배치: 프레임을 중앙에, 주변 여백 30px — cv = 화면px/프레임pt
    function _cfView() {
      const cv0 = document.getElementById('cfCanvas');
      const [fw, fh] = _cfFramePt();
      const cv = Math.min((cv0.width - 60) / fw, (cv0.height - 60) / fh);
      return { el: cv0, cv, fx: (cv0.width - fw * cv) / 2, fy: (cv0.height - fh * cv) / 2, fw, fh };
    }
    function cfDraw() {
      if (!_cf) return;
      const { el, cv, fx, fy, fw, fh } = _cfView();
      const ctx = el.getContext('2d');
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.fillStyle = '#2c2c2e'; ctx.fillRect(0, 0, el.width, el.height);
      const x = fx + _cf.ox * cv, y = fy + _cf.oy * cv;
      const w = _cf.sw * _cf.s * cv, h = _cf.sh * _cf.s * cv;
      // 프레임 밖 내용 = 흐리게 (잘려나갈 부분 미리보기)
      ctx.globalAlpha = 0.28;
      ctx.drawImage(_cf.src, x, y, w, h);
      ctx.globalAlpha = 1;
      // 프레임 안 = 실제 결과
      ctx.save();
      ctx.beginPath(); ctx.rect(fx, fy, fw * cv, fh * cv); ctx.clip();
      ctx.fillStyle = '#fff'; ctx.fillRect(fx, fy, fw * cv, fh * cv);
      ctx.drawImage(_cf.src, x, y, w, h);
      ctx.restore();
      // 프레임 테두리
      ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2;
      ctx.strokeRect(fx, fy, fw * cv, fh * cv);
    }
    // 배율: 100% = '채우기'(cover) 배율 기준, 프레임 중심 고정 줌
    function _cfCoverScale() { const [fw, fh] = _cfFramePt(); return Math.max(fw / _cf.sw, fh / _cf.sh); }
    function cfScaleChanged(v) {
      if (!_cf) return;
      const pct = Math.max(20, Math.min(400, parseFloat(v) || 100));
      document.getElementById('cfScale').value = pct;
      document.getElementById('cfScaleNum').value = pct;
      const [fw, fh] = _cfFramePt();
      const sNew = _cfCoverScale() * pct / 100;
      // 프레임 중심에 있던 내용 지점 고정
      const cxc = (fw / 2 - _cf.ox) / _cf.s, cyc = (fh / 2 - _cf.oy) / _cf.s;
      _cf.s = sNew;
      _cf.ox = fw / 2 - cxc * sNew;
      _cf.oy = fh / 2 - cyc * sNew;
      cfDraw();
    }
    function cfFit(mode) {
      if (!_cf) return;
      const [fw, fh] = _cfFramePt();
      const s = mode === 'contain' ? Math.min(fw / _cf.sw, fh / _cf.sh) : _cfCoverScale();
      _cf.s = s;
      _cf.ox = (fw - _cf.sw * s) / 2;
      _cf.oy = (fh - _cf.sh * s) / 2;
      const pct = Math.round(s / _cfCoverScale() * 100);
      document.getElementById('cfScale').value = pct;
      document.getElementById('cfScaleNum').value = pct;
      cfDraw();
    }
    function cfFrameChanged() {
      if (!_cf) return;
      _cf.fwMm = Math.max(10, parseFloat(document.getElementById('cfW').value) || 210);
      _cf.fhMm = Math.max(10, parseFloat(document.getElementById('cfH').value) || 297);
      cfFit('cover');   // 프레임이 바뀌면 채우기로 재배치
    }
    let _cfEventsBound = false;
    function _cfBindEvents() {
      if (_cfEventsBound) { cfDraw(); return; }
      _cfEventsBound = true;
      const el = document.getElementById('cfCanvas');
      let drag = null;
      el.addEventListener('pointerdown', e => {
        drag = { x: e.offsetX, y: e.offsetY };
        el.setPointerCapture(e.pointerId);
        el.style.cursor = 'grabbing';
      });
      el.addEventListener('pointermove', e => {
        if (!drag || !_cf) return;
        const { cv } = _cfView();
        const sx = el.width / el.getBoundingClientRect().width;   // CSS 축소 보정
        _cf.ox += (e.offsetX - drag.x) * sx / cv;
        _cf.oy += (e.offsetY - drag.y) * sx / cv;
        drag = { x: e.offsetX, y: e.offsetY };
        cfDraw();
      });
      el.addEventListener('pointerup', e => { drag = null; el.style.cursor = 'grab'; try { el.releasePointerCapture(e.pointerId); } catch (x) {} });
      el.addEventListener('wheel', e => {   // 휠 = 배율 미세 조절
        e.preventDefault();
        const cur = parseFloat(document.getElementById('cfScaleNum').value) || 100;
        cfScaleChanged(cur + (e.deltaY < 0 ? 5 : -5));
      }, { passive: false });
    }
    function cfCancel() {
      _cf = null;
      document.getElementById('coverFrameModal').style.display = 'none';
    }
    function cfUseOriginal() {
      if (!_cf) return;
      _coverFiles[_cf.which] = _cf.file;
      const which = _cf.which;
      cfCancel();
      updateCoverFileInfo();
      showSuccess(`📂 ${which === 'front' ? '앞' : '뒤'}표지 파일 지정(원본 그대로): '📕 표지 PDF 생성' 시 사용됩니다.`);
    }
    async function cfApply() {
      if (!_cf) return;
      try {
        showLoading('프레임 적용 중…');
        const bytes = await buildFramedCoverPdf(_cf.file, _cf.fwMm, _cf.fhMm, _cf.s, _cf.ox, _cf.oy);
        _coverFiles[_cf.which] = { name: _cf.file.name + ' (프레임)', type: 'pdf', bytes };
        const which = _cf.which, fw = _cf.fwMm, fh = _cf.fhMm;
        cfCancel();
        updateCoverFileInfo();
        showSuccess(`🖼 ${which === 'front' ? '앞' : '뒤'}표지 프레임 적용 — ${fw}×${fh}mm, 프레임 밖 내용은 제거되었습니다.\n'📕 표지 PDF 생성' 시 이 결과가 사용됩니다.`);
      } catch (e) { showError('프레임 적용 실패: ' + (e && e.message ? e.message : e)); }
      finally { hideLoading(); }
    }
    // 프레임 결과 PDF — 프레임 크기의 1쪽, 내용은 배치(배율·이동)대로 그리고 밖은 클립 제거.
    // 벡터 유지: PDF/AI는 embedPage(회전 굽기), 이미지는 원본 해상도 그대로 임베드.
    async function buildFramedCoverPdf(file, fwMm, fhMm, s, ox, oy) {
      const fw = fwMm * MM_PT, fh = fhMm * MM_PT;
      const doc = await PDFLib.PDFDocument.create();
      const page = doc.addPage([fw, fh]);
      const { pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath } = PDFLib;
      page.pushOperators(pushGraphicsState(), moveTo(0, 0), lineTo(fw, 0), lineTo(fw, fh), lineTo(0, fh), closePath(), clip(), endPath());
      if (file.type === 'pdf') {
        const src = await PDFLib.PDFDocument.load(file.bytes.slice(0));
        const emb = await embedPageRot(doc, src, 0);
        page.drawPage(emb.e, { x: ox, y: fh - oy - emb.h * s, xScale: s, yScale: s });
      } else {
        const img = file.type === 'png' ? await doc.embedPng(file.bytes) : await doc.embedJpg(file.bytes);
        page.drawImage(img, { x: ox, y: fh - oy - img.height * s, width: img.width * s, height: img.height * s });
      }
      page.pushOperators(popGraphicsState());
      return new Uint8Array(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
    }
    function clearCoverFile(which) { _coverFiles[which] = null; updateCoverFileInfo(); }
    function updateCoverFileInfo() {
      const el = document.getElementById('coverFileInfo');
      if (!el) return;
      const mk = (w, f) => `📂 ${w === 'front' ? '앞' : '뒤'}표지: ${f.name} <button class="es-chip" style="padding:0 6px; flex:0 0 auto;" onclick="clearCoverFile('${w}')" title="파일 지정 해제">✕</button>`;
      const parts = [];
      if (_coverFiles.front) parts.push(mk('front', _coverFiles.front));
      if (_coverFiles.back) parts.push(mk('back', _coverFiles.back));
      el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
      el.style.display = parts.length ? '' : 'none';
    }
    // 외부 표지 파일을 문서 끝에 페이지로 추가 — 반환: 추가된 페이지 인덱스
    async function appendCoverFilePage(doc, f) {
      if (f.type === 'pdf') {
        const ext = await PDFLib.PDFDocument.load(f.bytes.slice(0));
        const [p] = await doc.copyPages(ext, [0]);
        doc.addPage(p);
      } else {
        const img = f.type === 'png' ? await doc.embedPng(f.bytes) : await doc.embedJpg(f.bytes);
        const pg = doc.addPage([img.width, img.height]);
        pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      return doc.getPageCount() - 1;
    }
    // 뒤표지 자동 생성 방식: 'none'=문서 페이지(또는 불러온 파일), 'ai'=AI 생성(키 없으면 로컬 구성)
    let _coverBackAuto = 'none';
    function setCoverBackAuto(m) {
      _coverBackAuto = m;
      if (typeof activateChip === 'function') activateChip('backauto', m);
      const back = document.getElementById('coverBack');
      if (back) { back.disabled = m !== 'none'; back.style.opacity = m !== 'none' ? '0.4' : ''; }
      const ai = document.getElementById('coverAiOpts');
      if (ai) ai.style.display = m === 'ai' ? '' : 'none';
      const keyEl = document.getElementById('coverAiKey');
      if (keyEl && !keyEl.value) keyEl.value = localStorage.getItem('aiImageApiKey') || '';
      updateCoverSpineInfo();
    }
    function saveCoverAiKey(v) {
      try { localStorage.setItem('aiImageApiKey', (v || '').trim()); } catch (e) {}
    }
    // AI 뒤표지 — 앞표지 주 색상 힌트 + 사용자 요청으로 프롬프트 구성 → 이미지 생성 API →
    // 페이지 크기에 cover-fit(비율 유지 확대·중앙 재단)으로 채운 페이지 추가. 반환: 페이지 인덱스.
    async function appendAiBackCover(doc, workBytes, frontIdx, apiKey) {
      const ab = await buildAutoBackCover(workBytes, frontIdx, 'color');   // 색 분석용 (캔버스 결과는 버림)
      const hex = '#' + ab.color.map(v => v.toString(16).padStart(2, '0')).join('');
      const userReq = (document.getElementById('coverAiPrompt')?.value || '').trim();
      const prompt = `무선제본 책의 뒤표지 배경 디자인. 앞표지의 주 색상 ${hex}(RGB ${ab.color.join(',')})와 자연스럽게 어울리는 차분하고 고급스러운 배경.`
        + ` 글자·로고·텍스트·바코드 없이 배경 요소만. 인쇄용 고품질, 세로 방향, 가장자리까지 꽉 찬 디자인.`
        + (userReq ? ` 추가 요청: ${userReq}` : '');
      const pngPath = await window.electronAPI.genCoverImage({ apiKey, prompt, size: '1024x1536' });
      let pngBytes;
      try { pngBytes = new Uint8Array(window.electronAPI.readFile(pngPath)); }
      finally { try { window.electronAPI.removeTempFile(pngPath); } catch (e) {} }
      const img = await doc.embedPng(pngBytes);
      const pg = doc.addPage([ab.w, ab.h]);
      const s = Math.max(ab.w / img.width, ab.h / img.height);   // cover-fit: 빈틈 없이 채우고 넘치는 쪽 재단
      pg.drawImage(img, { x: (ab.w - img.width * s) / 2, y: (ab.h - img.height * s) / 2, width: img.width * s, height: img.height * s });
      return doc.getPageCount() - 1;
    }
    // 세네카(책등) 텍스트 위치: 'top' | 'center' | 'bottom'
    let _coverSpinePos = 'center';
    function setCoverSpinePos(p) {
      _coverSpinePos = p;
      if (typeof activateChip === 'function') activateChip('spinepos', p);
    }
    // 대지(출력 용지) 사전설정 — [가로, 세로] mm (스프레드용 가로 방향)
    const COVER_SHEETS = { A3: [420, 297], SRA3: [450, 320], A2: [594, 420] };
    function onCoverSheetChange() {
      const g = id => document.getElementById(id);
      const v = g('coverSheetSel')?.value || '';
      const custom = v === 'custom';
      const on = v !== '';
      const cw = g('coverSheetCustom'), mg = g('coverSheetMargins');
      if (cw) cw.style.display = custom ? '' : 'none';
      if (mg) mg.style.display = on ? '' : 'none';
      if (COVER_SHEETS[v]) { g('coverSheetW').value = COVER_SHEETS[v][0]; g('coverSheetH').value = COVER_SHEETS[v][1]; }
    }
    // 표지 크기 사전설정 (트림 1쪽 기준, mm)
    const COVER_SIZES = { A5: [148, 210], A4: [210, 297], A3: [297, 420], B5: [182, 257] };
    function onCoverSizeChange() {
      const g = id => document.getElementById(id);
      const v = g('coverSizeSel')?.value;
      const wrap = g('coverCustomWrap');
      if (wrap) wrap.style.display = (v === 'custom') ? '' : 'none';
      if (COVER_SIZES[v]) { g('coverW').value = COVER_SIZES[v][0]; g('coverH').value = COVER_SIZES[v][1]; }
      updateCoverSpineInfo();
    }
    function coverRotateSize() {
      const g = id => document.getElementById(id);
      const w = g('coverW').value, h = g('coverH').value;
      g('coverW').value = h; g('coverH').value = w;
      if (g('coverSizeSel').value === 'orig') g('coverSizeSel').value = 'custom';   // 원본은 회전 개념 없음 → 직접 입력으로 전환
      if (g('coverSizeSel').value !== 'orig') {
        const wrap = g('coverCustomWrap'); if (wrap) wrap.style.display = '';
        g('coverSizeSel').value = 'custom';
      }
      updateCoverSpineInfo();
    }
    function _coverInputs() {
      const g = id => document.getElementById(id);
      const total = pageResults.filter(Boolean).length;
      const front = parseInt(g('coverFront')?.value) || 1;
      const back  = parseInt(g('coverBack')?.value) || total;
      const bodyRaw = parseInt(g('coverBodyPages')?.value);
      const body = bodyRaw > 0 ? bodyRaw : Math.max(0, total - 2);   // 비우면 표지 2쪽 뺀 나머지
      // 두께 기준은 항상 입력칸(수정 가능) — 지종 선택은 입력칸을 채우는 시작값
      let thick = parseFloat(g('coverThick')?.value);
      if (!(thick > 0)) thick = parseFloat(g('coverStock')?.value) || 0.1;
      const duplex = g('coverDuplex') ? !!g('coverDuplex').checked : true;   // 기본 양면(1장=2쪽)
      const adj = parseFloat(g('coverSpineAdj')?.value) || 0;        // 보정 두께 (제본 풀·부피 여유)
      const spineOverride = parseFloat(g('coverSpineMm')?.value);
      const spine = Math.max(0, Math.round(((spineOverride > 0 ? spineOverride : coverSpineMm(body, thick, duplex)) + adj) * 10) / 10);
      // 표지 크기: orig=null(앞표지 크기), 그 외 [w,h] mm
      const sizeSel = g('coverSizeSel')?.value || 'orig';
      const sizeMm = sizeSel === 'orig' ? null
        : [Math.max(10, parseFloat(g('coverW')?.value) || 210), Math.max(10, parseFloat(g('coverH')?.value) || 297)];
      return {
        front, back, body, thick, duplex, spine, adj, sizeMm,
        bleed: Math.max(0, parseFloat(g('coverBleed')?.value) || 0),
        crop: !!g('coverCrop')?.checked, fold: !!g('coverFold')?.checked,
        centerMarks: !!g('coverCenterMarks')?.checked,
        spineLabel: !!g('coverSpineLabel')?.checked,
        creaseLabel: !!g('coverCreaseLabel')?.checked,
        hinge: Math.max(0, parseFloat(g('coverHinge')?.value) || 0),
        spineText: g('coverSpineText')?.value || '',
        spineSize: Math.max(4, Math.min(72, parseFloat(g('coverSpineSize')?.value) || 12)),
        spinePos: _coverSpinePos,
        spineOff: parseFloat(g('coverSpineOff')?.value) || 0,
        // 대지: null=자동(내용 맞춤), [w,h]=지정 (여백 기준 배치)
        sheetMm: (g('coverSheetSel')?.value || '') === '' ? null
          : [Math.max(50, parseFloat(g('coverSheetW')?.value) || 450), Math.max(50, parseFloat(g('coverSheetH')?.value) || 320)],
        sheetMg: {
          t: Math.max(0, parseFloat(g('coverMgT')?.value) || 0),
          b: Math.max(0, parseFloat(g('coverMgB')?.value) || 0),
          l: Math.max(0, parseFloat(g('coverMgL')?.value) || 0),
          r: Math.max(0, parseFloat(g('coverMgR')?.value) || 0),
        },
        backAuto: _coverBackAuto,
      };
    }
    function updateCoverSpineInfo() {
      const el = document.getElementById('coverSpineInfo');
      if (!el) return;
      if (!pageResults.filter(Boolean).length) { el.textContent = ''; return; }
      const c = _coverInputs();
      el.textContent = `책등 ${c.spine}mm (내지 ${c.body}쪽 · ${c.duplex ? '양면(1장=2쪽)' : '단면(1장=1쪽)'} × ${c.thick}mm/장${c.adj ? ` + 보정 ${c.adj}mm` : ''})`;
    }
    // 앞표지를 참고해 뒤표지 자동 생성 — 가장자리 최빈색 단색('color') 또는 흐림 배경('blur').
    // 반환: { jpg, w, h(pt·뷰어 방향), color:[r,g,b] } — 호출자가 페이지로 추가한다.
    async function buildAutoBackCover(srcBytes, frontIdx, mode) {
      const pdf = await pdfjsLib.getDocument({ data: srcBytes.slice(0) }).promise;
      try {
        const page = await pdf.getPage(frontIdx + 1);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1400 / Math.max(vp1.width, vp1.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        page.cleanup();
        // 주 배경색 = 가장자리 6% 띠의 최빈색 (16단계 양자화 — 그라데이션도 대표색으로 수렴)
        const img = ctx.getImageData(0, 0, c.width, c.height).data;
        const bw = Math.max(2, Math.round(c.width * 0.06)), bh = Math.max(2, Math.round(c.height * 0.06));
        const hist = new Map();
        const q = v => Math.min(255, Math.round(v / 16) * 16);
        const scan = (x0, y0, x1, y1) => {
          for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
            const i = (y * c.width + x) * 4;
            hist.set(q(img[i]) + ',' + q(img[i + 1]) + ',' + q(img[i + 2]), (hist.get(q(img[i]) + ',' + q(img[i + 1]) + ',' + q(img[i + 2])) || 0) + 1);
          }
        };
        scan(0, 0, c.width, bh); scan(0, c.height - bh, c.width, c.height);
        scan(0, bh, bw, c.height - bh); scan(c.width - bw, bh, c.width, c.height - bh);
        let best = '255,255,255', bn = 0;
        hist.forEach((n, k) => { if (n > bn) { bn = n; best = k; } });
        const [r, gr, bl] = best.split(',').map(Number);
        // 뒤표지 캔버스 — 'ai' 자동 구성: 배경색 그라데이션(위 밝게·아래 어둡게) 위에
        // 앞표지 흐림 잔상을 은은히 깔고 하단에 어두운 톤 밴드로 마감 (오프라인 자동 디자인)
        const oc = document.createElement('canvas');
        oc.width = c.width; oc.height = c.height;
        const octx = oc.getContext('2d');
        const shade = f => `rgb(${Math.min(255, Math.round(r * f))},${Math.min(255, Math.round(gr * f))},${Math.min(255, Math.round(bl * f))})`;
        octx.fillStyle = `rgb(${r},${gr},${bl})`; octx.fillRect(0, 0, oc.width, oc.height);
        if (mode === 'ai') {
          const grad = octx.createLinearGradient(0, 0, 0, oc.height);
          grad.addColorStop(0, shade(1.08));
          grad.addColorStop(1, shade(0.88));
          octx.fillStyle = grad; octx.fillRect(0, 0, oc.width, oc.height);
          const k = 1.2;   // 살짝 확대해 흐림 가장자리 번짐을 화면 밖으로
          octx.filter = `blur(${Math.max(10, Math.round(c.width / 36))}px)`;
          octx.globalAlpha = 0.28;
          octx.drawImage(c, -(oc.width * (k - 1)) / 2, -(oc.height * (k - 1)) / 2, oc.width * k, oc.height * k);
          octx.filter = 'none'; octx.globalAlpha = 1;
          octx.fillStyle = `rgba(${r},${gr},${bl},0.35)`;   // 배경색 톤으로 정리
          octx.fillRect(0, 0, oc.width, oc.height);
          octx.fillStyle = shade(0.8);                      // 하단 마감 밴드
          octx.fillRect(0, Math.round(oc.height * 0.92), oc.width, Math.ceil(oc.height * 0.08));
        }
        const blob = await new Promise(rs => oc.toBlob(rs, 'image/jpeg', 0.92));
        return { jpg: new Uint8Array(await blob.arrayBuffer()), w: vp1.width, h: vp1.height, color: [r, gr, bl] };
      } finally { try { await pdf.destroy(); } catch (e) {} }
    }
    function onCoverStockChange() {
      // 지종 선택 → 두께 입력칸에 그 값을 채운다. 입력칸은 항상 보이고 직접 수정 가능
      // (실측 두께로 보정하는 실무 흐름 — 선택은 시작값일 뿐, 최종 기준은 입력칸).
      const v = parseFloat(document.getElementById('coverStock')?.value);
      const inp = document.getElementById('coverThick');
      if (inp && v > 0) inp.value = v;
      autoFillSpine();
    }
    // 본문 쪽수·지종·양면이 바뀌면 책등폭 입력칸을 자동 계산값으로 채운다 (직접 수정 가능)
    function autoFillSpine() {
      const g = id => document.getElementById(id);
      const total = pageResults.filter(Boolean).length;
      const bodyRaw = parseInt(g('coverBodyPages')?.value);
      const body = bodyRaw > 0 ? bodyRaw : Math.max(0, total - 2);
      let thick = parseFloat(g('coverThick')?.value);
      if (!(thick > 0)) thick = parseFloat(g('coverStock')?.value) || 0.1;
      const duplex = g('coverDuplex') ? !!g('coverDuplex').checked : true;
      const el = g('coverSpineMm');
      if (el) el.value = coverSpineMm(body, thick, duplex);
      updateCoverSpineInfo();
    }
    // ── 지종 목록 (이름·장당 두께 수정 가능, localStorage 'coverStocks') ─────
    const COVER_STOCK_DEFAULTS = [
      { n: '모조 70g', t: 0.09 }, { n: '모조 80g', t: 0.10 }, { n: '모조 100g', t: 0.11 }, { n: '모조 120g', t: 0.13 },
      { n: '아트/스노우 100g', t: 0.08 }, { n: '아트/스노우 120g', t: 0.10 }, { n: '아트/스노우 150g', t: 0.12 },
      { n: '아트/스노우 180g', t: 0.15 }, { n: '아트/스노우 200g', t: 0.17 },
    ];
    function coverStocks() {
      try {
        const j = JSON.parse(localStorage.getItem('coverStocks') || 'null');
        if (Array.isArray(j) && j.length) return j;
      } catch (e) {}
      return COVER_STOCK_DEFAULTS.map(s => ({ ...s }));
    }
    function saveCoverStocks(list) {
      try { localStorage.setItem('coverStocks', JSON.stringify(list)); } catch (e) {}
    }
    function populateCoverStockSel(keepIdx) {
      const sel = document.getElementById('coverStock');
      if (!sel) return;
      const list = coverStocks();
      const prev = keepIdx != null ? keepIdx : sel.selectedIndex;
      sel.innerHTML = list.map((s, i) => `<option value="${s.t}">${s.n} (${s.t}mm/장)</option>`).join('');
      sel.selectedIndex = Math.max(0, Math.min(list.length - 1, prev >= 0 ? prev : 1));
    }
    function toggleCoverStockMgmt() {
      const box = document.getElementById('coverStockMgmt');
      if (!box) return;
      const show = box.style.display === 'none';
      box.style.display = show ? '' : 'none';
      if (show) renderCoverStockRows();
    }
    function renderCoverStockRows() {
      const wrap = document.getElementById('coverStockRows');
      if (!wrap) return;
      const list = coverStocks();
      wrap.innerHTML = list.map((s, i) =>
        `<div class="es-row" style="margin-bottom:4px;">
          <input type="text" class="es-input" value="${String(s.n).replace(/"/g, '&quot;')}" style="flex:1;" oninput="coverStockEdit(${i},'n',this.value)">
          <input type="number" class="es-input" value="${s.t}" min="0.001" step="0.005" style="flex:0 0 70px;" oninput="coverStockEdit(${i},'t',this.value)">
          <span class="es-hint" style="margin:0;">mm</span>
          <button class="es-chip" style="flex:0 0 auto;" onclick="coverStockDel(${i})" title="삭제">🗑</button>
        </div>`).join('');
    }
    function coverStockEdit(i, k, v) {
      const list = coverStocks();
      if (!list[i]) return;
      if (k === 'n') list[i].n = v;
      else list[i].t = Math.max(0.001, parseFloat(v) || list[i].t);
      saveCoverStocks(list);
      populateCoverStockSel();
    }
    function coverStockAdd() {
      const list = coverStocks();
      list.push({ n: '새 지종', t: 0.10 });
      saveCoverStocks(list);
      renderCoverStockRows();
      populateCoverStockSel();
    }
    function coverStockDel(i) {
      const list = coverStocks();
      if (list.length <= 1) { showError('지종은 최소 1개 필요합니다.'); return; }
      list.splice(i, 1);
      saveCoverStocks(list);
      renderCoverStockRows();
      populateCoverStockSel();
    }
    function coverStockReset() {
      if (!confirm('지종 목록을 기본값으로 되돌릴까요? (수정·추가한 지종이 사라집니다)')) return;
      try { localStorage.removeItem('coverStocks'); } catch (e) {}
      renderCoverStockRows();
      populateCoverStockSel(1);
    }
    populateCoverStockSel(1);   // 부트 시 지종 목록 구성 (기본 = 모조 80g)
    // ── 표지 프리셋 (localStorage 'coverPresets') — 표지 만들기 값 전체 저장·적용 ──
    const COVER_PRESET_V = ['coverFront', 'coverBack', 'coverSizeSel', 'coverW', 'coverH', 'coverBodyPages',
      'coverStock', 'coverThick', 'coverSpineAdj', 'coverSpineMm', 'coverBleed', 'coverHinge',
      'coverSpineText', 'coverSpineSize', 'coverSpineOff', 'coverSheetSel', 'coverSheetW', 'coverSheetH',
      'coverMgT', 'coverMgB', 'coverMgL', 'coverMgR', 'coverAiPrompt'];
    const COVER_PRESET_C = ['coverDuplex', 'coverCrop', 'coverFold', 'coverCenterMarks', 'coverSpineLabel', 'coverCreaseLabel', 'coverEditPreview'];
    function coverPresets() {
      try { return JSON.parse(localStorage.getItem('coverPresets') || '{}') || {}; } catch (e) { return {}; }
    }
    function populateCoverPresetSel(selectName) {
      const sel = document.getElementById('coverPresetSel');
      if (!sel) return;
      const names = Object.keys(coverPresets()).sort();
      sel.innerHTML = '<option value="">— 프리셋 선택 —</option>' + names.map(n => `<option${n === selectName ? ' selected' : ''}>${n}</option>`).join('');
      // 핫폴더 프리셋 선택도 함께 갱신 (설정된 값 유지)
      const hf = document.getElementById('coverHfPreset');
      if (hf) {
        const cur = hf.value || (coverHfCfg().preset || '');
        hf.innerHTML = names.map(n => `<option${n === cur ? ' selected' : ''}>${n}</option>`).join('');
      }
    }
    // 표지 섹션 값 전체 스냅샷 — 표지 프리셋 저장과 '🕓 최근 작업 설정'이 공유한다
    function captureCoverState() {
      const g = id => document.getElementById(id);
      const data = { v: {}, c: {}, mode: _coverMode, backAuto: _coverBackAuto, spinePos: _coverSpinePos };
      COVER_PRESET_V.forEach(id => { if (g(id)) data.v[id] = g(id).value; });
      COVER_PRESET_C.forEach(id => { if (g(id)) data.c[id] = !!g(id).checked; });
      return data;
    }
    // 스냅샷 → 표지 UI 복원 (값 + 모드 칩 + 종속 행 표시). 프리셋 불러오기와 공용.
    function applyCoverState(data) {
      if (!data) return;
      const g = id => document.getElementById(id);
      COVER_PRESET_V.forEach(id => { if (g(id) && data.v && data.v[id] !== undefined) g(id).value = data.v[id]; });
      COVER_PRESET_C.forEach(id => { if (g(id) && data.c && data.c[id] !== undefined) g(id).checked = data.c[id]; });
      setCoverMode(data.mode || 'extract');
      setCoverBackAuto(data.backAuto || 'none');
      setCoverSpinePos(data.spinePos || 'center');
      // 표시 토글 동기 (값은 스냅샷 그대로 — onCover*Change는 값을 덮어쓰므로 직접)
      const szCustom = g('coverSizeSel')?.value === 'custom';
      if (g('coverCustomWrap')) g('coverCustomWrap').style.display = szCustom ? '' : 'none';
      const shSel = g('coverSheetSel')?.value || '';
      if (g('coverSheetCustom')) g('coverSheetCustom').style.display = shSel === 'custom' ? '' : 'none';
      if (g('coverSheetMargins')) g('coverSheetMargins').style.display = shSel !== '' ? '' : 'none';
      updateCoverSpineInfo();
    }
    function saveCoverPreset() {
      const cur = document.getElementById('coverPresetSel')?.value || '';
      const name = (prompt('표지 프리셋 이름 (같은 이름이 있으면 덮어쓰기)', cur) || '').trim();
      if (!name) return;
      const data = captureCoverState();
      const all = coverPresets();
      const overwrite = !!all[name];
      all[name] = data;
      try { localStorage.setItem('coverPresets', JSON.stringify(all)); } catch (e) {}
      populateCoverPresetSel(name);
      showSuccess(`📕 표지 프리셋 '${name}' ${overwrite ? '덮어쓰기' : '저장'} 완료 — 목록에서 선택하면 즉시 적용됩니다.`);
    }
    function loadCoverPreset() {
      const name = document.getElementById('coverPresetSel')?.value;
      if (!name) return;
      const data = coverPresets()[name];
      if (!data) return;
      applyCoverState(data);
      showSuccess(`📕 표지 프리셋 '${name}' 적용 완료 — '📕 표지 PDF 생성'을 누르면 이 설정으로 만듭니다.`);
    }
    function deleteCoverPreset() {
      const name = document.getElementById('coverPresetSel')?.value;
      if (!name) { showError('삭제할 프리셋을 선택하세요.'); return; }
      if (!confirm(`표지 프리셋 '${name}'을(를) 삭제할까요?`)) return;
      const all = coverPresets();
      delete all[name];
      try { localStorage.setItem('coverPresets', JSON.stringify(all)); } catch (e) {}
      populateCoverPresetSel();
      showSuccess(`표지 프리셋 '${name}' 삭제 완료.`);
    }
    populateCoverPresetSel();   // 부트 시 프리셋 목록 구성

    // ── 📂 표지 핫폴더 — 폴더에 파일이 들어오면 지정 프리셋으로 표지 자동 생성 ──
    // 본문\ = 본문 PDF(쪽수로 책등 자동 계산), 표지\ = 앞표지 원고(프리셋 책등폭 사용).
    // AI 뒤표지는 핫폴더에서 항상 로컬 구성으로 대체(무인 과금 방지). 결과·원본은 완료\로.
    function coverHfCfg() {
      try { return JSON.parse(localStorage.getItem('coverHotfolder') || '{}') || {}; } catch (e) { return {}; }
    }
    function coverHfSaveCfg(cfg) {
      try { localStorage.setItem('coverHotfolder', JSON.stringify(cfg)); } catch (e) {}
    }
    function coverHfUpdateInfo() {
      const cfg = coverHfCfg();
      const el = document.getElementById('coverHfInfo');
      const row = document.getElementById('coverHfPresetRow');
      if (row) row.style.display = cfg.on ? '' : 'none';
      if (!el) return;
      if (!cfg.on) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.innerHTML = `감시 중: <b>${cfg.dir || '(폴더 미지정)'}</b> — 본문\\에 PDF를 넣으면 쪽수로 책등폭을 계산하고, 표지\\에 표지 원고(PDF·AI·PSD·이미지)를 넣으면 프리셋 책등폭으로 스프레드를 만듭니다. 결과는 완료\\, 오류는 실패\\.`;
    }
    async function coverHfPickDir() {
      const dir = await window.electronAPI.pickFolder();
      if (!dir) return;
      const cfg = coverHfCfg();
      cfg.dir = dir;
      coverHfSaveCfg(cfg);
      if (cfg.on) await coverHfToggle(true);   // 감시 재시작
      coverHfUpdateInfo();
      showSuccess(`📂 핫폴더 위치 지정: ${dir}\n켜면 본문·표지·완료·실패 하위 폴더가 자동 생성됩니다.`);
    }
    async function coverHfToggle(on) {
      const cfg = coverHfCfg();
      const chk = document.getElementById('coverHfEnabled');
      if (on && !cfg.dir) {
        showError("먼저 '폴더…'로 핫폴더 위치를 지정하세요.");
        if (chk) chk.checked = false;
        return;
      }
      if (on && !Object.keys(coverPresets()).length) {
        showError("표지 프리셋이 없습니다 — 표지 설정 후 '＋ 저장'으로 프리셋을 먼저 만드세요.");
        if (chk) chk.checked = false;
        return;
      }
      if (on) {
        const r = await window.electronAPI.hotfolderStart(cfg.dir);
        if (!r || !r.ok) { showError('핫폴더 시작 실패: ' + ((r && r.error) || '')); if (chk) chk.checked = false; return; }
        cfg.on = true;
        cfg.preset = document.getElementById('coverHfPreset')?.value || cfg.preset || Object.keys(coverPresets()).sort()[0];
        coverHfSaveCfg(cfg);
        populateCoverPresetSel(document.getElementById('coverPresetSel')?.value);
        showSuccess(`📂 핫폴더 감시 시작 — ${cfg.dir}\n프리셋 '${cfg.preset}'로 자동 생성합니다. (앱 실행 중에만 동작)`);
      } else {
        await window.electronAPI.hotfolderStop();
        cfg.on = false;
        coverHfSaveCfg(cfg);
      }
      coverHfUpdateInfo();
    }
    function coverHfCfgChanged() {
      const cfg = coverHfCfg();
      cfg.preset = document.getElementById('coverHfPreset')?.value || '';
      coverHfSaveCfg(cfg);
    }
    // 프리셋 데이터(coverPresets 저장 형식) → 스프레드 옵션 (DOM을 건드리지 않는 순수 변환)
    function coverInputsFromPresetData(d, totalPages) {
      const v = id => (d && d.v ? d.v[id] : undefined);
      const cc = id => !!(d && d.c && d.c[id]);
      const has = id => d && d.c && (id in d.c);
      const front = parseInt(v('coverFront')) || 1;
      const back = parseInt(v('coverBack')) || totalPages || 1;
      const bodyRaw = parseInt(v('coverBodyPages'));
      const body = bodyRaw > 0 ? bodyRaw : Math.max(0, (totalPages || 2) - 2);
      let thick = parseFloat(v('coverThick'));
      if (!(thick > 0)) thick = parseFloat(v('coverStock')) || 0.1;
      const duplex = has('coverDuplex') ? cc('coverDuplex') : true;
      const adj = parseFloat(v('coverSpineAdj')) || 0;
      const ovr = parseFloat(v('coverSpineMm'));
      const spine = Math.max(0, Math.round(((ovr > 0 ? ovr : coverSpineMm(body, thick, duplex)) + adj) * 10) / 10);
      const sizeSel = v('coverSizeSel') || 'orig';
      const sheetSel = v('coverSheetSel') || '';
      return {
        front, back, body, thick, duplex, spine, adj,
        sizeMm: sizeSel === 'orig' ? null : [parseFloat(v('coverW')) || 210, parseFloat(v('coverH')) || 297],
        bleed: Math.max(0, parseFloat(v('coverBleed')) || 0),
        crop: cc('coverCrop'), fold: cc('coverFold'), centerMarks: cc('coverCenterMarks'),
        spineLabel: cc('coverSpineLabel'), creaseLabel: cc('coverCreaseLabel'),
        hinge: Math.max(0, parseFloat(v('coverHinge')) || 0),
        spineText: v('coverSpineText') || '', spineSize: parseFloat(v('coverSpineSize')) || 12,
        spinePos: (d && d.spinePos) || 'center', spineOff: parseFloat(v('coverSpineOff')) || 0,
        sheetMm: sheetSel === '' ? null : [parseFloat(v('coverSheetW')) || 450, parseFloat(v('coverSheetH')) || 320],
        sheetMg: { t: parseFloat(v('coverMgT')) || 0, b: parseFloat(v('coverMgB')) || 0, l: parseFloat(v('coverMgL')) || 0, r: parseFloat(v('coverMgR')) || 0 },
        backAuto: (d && d.backAuto) || 'none',
      };
    }
    // 핫폴더 잡 1건 처리 — 반환 {ok, outTmp, outName} 또는 {ok:false, errMsg}. finish는 호출자가.
    async function hotfolderProcess(job, presetData) {
      const base = (job.name || 'cover').replace(/\.[^.]+$/, '');
      const ext = (job.name.split('.').pop() || '').toLowerCase();
      let workDoc, fi, bi, total, c;
      if (job.kind === 'body') {
        if (!/^(pdf|ai)$/.test(ext)) throw new Error('본문 폴더에는 PDF(또는 PDF호환 AI)만 넣어 주세요.');
        const bytes = new Uint8Array(window.electronAPI.readFile(job.path));
        workDoc = await PDFLib.PDFDocument.load(bytes.slice(0));
        total = workDoc.getPageCount();
        c = coverInputsFromPresetData(presetData, total);
        fi = Math.min(Math.max(1, c.front), total) - 1;
        bi = Math.min(Math.max(1, c.back), total) - 1;
        if (c.backAuto !== 'none') {
          // 무인 처리 — AI 설정이어도 항상 로컬 자동 구성 (과금 방지)
          const ab = await buildAutoBackCover(bytes, fi, 'ai');
          const jpg = await workDoc.embedJpg(ab.jpg);
          const pg = workDoc.addPage([ab.w, ab.h]);
          pg.drawImage(jpg, { x: 0, y: 0, width: ab.w, height: ab.h });
          bi = workDoc.getPageCount() - 1;
        }
      } else {
        // 표지 원고: 파일을 앞표지로, 뒤표지는 로컬 자동 구성. 책등폭은 프리셋 값(입력값 또는 쪽수 계산).
        let fbytes = new Uint8Array(window.electronAPI.readFile(job.path));
        let ftype = ext === 'png' ? 'png' : (ext === 'jpg' || ext === 'jpeg') ? 'jpg' : 'pdf';
        if (ext === 'psd') {
          const convPath = await window.electronAPI.convertAdobeToPdf(job.path);
          fbytes = new Uint8Array(window.electronAPI.readFile(convPath));
          try { window.electronAPI.cleanupTempFile && window.electronAPI.cleanupTempFile(convPath); } catch (e) {}
          ftype = 'pdf';
        } else if (ext === 'ai') {
          const isPdf = fbytes[0] === 0x25 && fbytes[1] === 0x50 && fbytes[2] === 0x44 && fbytes[3] === 0x46;
          if (!isPdf) {
            const convPath = await window.electronAPI.convertAdobeToPdf(job.path);
            fbytes = new Uint8Array(window.electronAPI.readFile(convPath));
            try { window.electronAPI.cleanupTempFile && window.electronAPI.cleanupTempFile(convPath); } catch (e) {}
          }
          ftype = 'pdf';
        }
        workDoc = await PDFLib.PDFDocument.create();
        fi = await appendCoverFilePage(workDoc, { name: job.name, type: ftype, bytes: fbytes });
        c = coverInputsFromPresetData(presetData, 0);
        const front1 = new Uint8Array(await workDoc.save({ useObjectStreams: false, updateFieldAppearances: false }));
        const ab = await buildAutoBackCover(front1, fi, 'ai');   // 뒤표지 = 앞표지 기반 로컬 구성
        const jpg = await workDoc.embedJpg(ab.jpg);
        const pg = workDoc.addPage([ab.w, ab.h]);
        pg.drawImage(jpg, { x: 0, y: 0, width: ab.w, height: ab.h });
        bi = workDoc.getPageCount() - 1;
      }
      const workBytes = new Uint8Array(await workDoc.save({ useObjectStreams: false, updateFieldAppearances: false }));
      const outBytes = await buildCoverSpreadBytes(workBytes, {
        frontIdx: fi, backIdx: bi, spineMm: c.spine, bleedMm: c.bleed,
        crop: c.crop, fold: c.fold,
        spineText: c.spineText, spineSizePt: c.spineSize, spineTextPos: c.spinePos, spineTextOffMm: c.spineOff,
        trimWmm: c.sizeMm ? c.sizeMm[0] : 0, trimHmm: c.sizeMm ? c.sizeMm[1] : 0,
        centerMarks: c.centerMarks,
        spineLabelText: c.spineLabel ? `책등 ${c.spine}mm` : '',
        creaseLabel: c.creaseLabel, hingeMm: c.hinge,
        sheetWmm: c.sheetMm ? c.sheetMm[0] : 0, sheetHmm: c.sheetMm ? c.sheetMm[1] : 0,
        sheetMgMm: c.sheetMg,
      });
      return {
        ok: true,
        outTmp: window.electronAPI.writeTempFile(outBytes, 'pdf'),
        outName: `${base}_표지스프레드_책등${c.spine}mm.pdf`,
        spine: c.spine,
      };
    }
    // 잡 큐 — 직렬 처리 (변환·조립이 겹치지 않게)
    const _hfQueue = [];
    let _hfRunning = false;
    async function _hfPump() {
      if (_hfRunning) return;
      _hfRunning = true;
      while (_hfQueue.length) {
        const job = _hfQueue.shift();
        try {
          const cfg = coverHfCfg();
          const presetData = coverPresets()[cfg.preset];
          if (!presetData) throw new Error(`핫폴더 프리셋 '${cfg.preset}'이 없습니다`);
          const r = await hotfolderProcess(job, presetData);
          await window.electronAPI.hotfolderFinish({ srcPath: job.path, ok: true, outTmp: r.outTmp, outName: r.outName });
          showSuccess(`📂 핫폴더: ${job.name} → 표지 생성 완료 (책등 ${r.spine}mm) — 완료 폴더를 확인하세요.`);
        } catch (e) {
          console.error('핫폴더 처리 실패:', job, e);
          await window.electronAPI.hotfolderFinish({ srcPath: job.path, ok: false, errMsg: (e && e.message) || String(e) });
          showError(`📂 핫폴더 실패: ${job.name} — ${(e && e.message) || e} (실패 폴더로 이동)`);
        }
      }
      _hfRunning = false;
    }
    try {
      window.electronAPI.onHotfolderJob && window.electronAPI.onHotfolderJob(job => { _hfQueue.push(job); _hfPump(); });
    } catch (e) {}
    // 부트: 설정이 켜져 있으면 감시 자동 재개
    (function coverHfBoot() {
      const cfg = coverHfCfg();
      const chk = document.getElementById('coverHfEnabled');
      if (chk) chk.checked = !!cfg.on;
      if (cfg.on && cfg.dir) window.electronAPI.hotfolderStart(cfg.dir).then(r => { if (!r || !r.ok) { const c2 = coverHfCfg(); c2.on = false; coverHfSaveCfg(c2); if (chk) chk.checked = false; } coverHfUpdateInfo(); });
      else coverHfUpdateInfo();
    })();
    async function generateCover() {
      if (_bkBusy) return;
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      const c = _coverInputs();
      _bkBusy = true; setBtnBusy('coverGenBtn', true);
      try {
        showLoading('표지 만들기 — 최신 편집 상태 준비 중…');
        progressBar.style.display = 'block'; updateProgress(0);
        const srcBytes = await buildOptimizedBase(p => updateProgress(Math.round(p * 0.6)));
        const src = await PDFLib.PDFDocument.load(srcBytes.slice(0));
        const total = src.getPageCount();
        const fi = Math.min(Math.max(1, c.front), total) - 1;
        let bi = Math.min(Math.max(1, c.back), total) - 1;
        const base = effectiveBaseName();   // 챕터 삭제 후에는 남은 첫 챕터명
        // 외부 표지 파일(PDF 1쪽/이미지) 반영 — 문서 끝에 추가하고 그 페이지를 표지로 사용
        let workBytes = srcBytes, autoBackNote = '', fileNote = '';
        if (_coverFiles.front) {
          fi = await appendCoverFilePage(src, _coverFiles.front);
          fileNote += `\n📂 앞표지 파일: ${_coverFiles.front.name}`;
        }
        if (_coverFiles.back) {
          bi = await appendCoverFilePage(src, _coverFiles.back);
          fileNote += `\n📂 뒤표지 파일: ${_coverFiles.back.name}`;
        }
        if (_coverFiles.front || _coverFiles.back)
          workBytes = new Uint8Array(await src.save({ useObjectStreams: false, updateFieldAppearances: false }));
        // 뒤표지 자동 생성(🤖) — 앞표지(불러온 파일 포함)를 분석해 자동 구성 페이지를 추가.
        // 뒤표지 파일을 불러왔으면 파일이 우선.
        if (!_coverFiles.back && c.backAuto !== 'none') {
          const apiKey = (localStorage.getItem('aiImageApiKey') || '').trim();
          let aiDone = false;
          if (apiKey) {
            // AI 생성 — 실패(요금·네트워크·키 오류)해도 표지 생성 자체는 로컬 구성으로 계속
            try {
              showLoading('🤖 AI 뒤표지 생성 중 — 이미지 생성 API 호출 (수십 초)…');
              bi = await appendAiBackCover(src, workBytes, fi, apiKey);
              workBytes = new Uint8Array(await src.save({ useObjectStreams: false, updateFieldAppearances: false }));
              autoBackNote = '\n🤖 뒤표지 AI 생성 완료 (gpt-image-1 — 앞표지 색 분석 기반)';
              aiDone = true;
            } catch (e) {
              console.error('AI 뒤표지 생성 실패:', e);
              autoBackNote = `\n⚠ AI 생성 실패(${(e && e.message) || e}) — 로컬 자동 구성으로 대체했습니다.`;
            }
          } else {
            autoBackNote = '\nℹ API 키 미입력 — 로컬 자동 구성으로 만들었습니다. 키를 입력하면 AI가 생성합니다.';
          }
          if (!aiDone) {
            showLoading('뒤표지 자동 구성 중 — 앞표지 분석…');
            const ab = await buildAutoBackCover(workBytes, fi, 'ai');
            const jpg = await src.embedJpg(ab.jpg);
            const pg = src.addPage([ab.w, ab.h]);
            pg.drawImage(jpg, { x: 0, y: 0, width: ab.w, height: ab.h });
            workBytes = new Uint8Array(await src.save({ useObjectStreams: false, updateFieldAppearances: false }));
            bi = src.getPageCount() - 1;
            autoBackNote = `\n🎨 뒤표지 자동 구성(로컬) — 배경색 RGB ${ab.color.join(',')} 그라데이션` + autoBackNote;
          }
        }
        let bytes, name, note;
        if (_coverMode === 'spread') {
          showLoading('표지 만들기 — 무선제본 스프레드 조판 중…');
          updateProgress(75);
          bytes = await buildCoverSpreadBytes(workBytes, {
            frontIdx: fi, backIdx: bi, spineMm: c.spine, bleedMm: c.bleed,
            crop: c.crop, fold: c.fold,
            spineText: c.spineText, spineSizePt: c.spineSize, spineTextPos: c.spinePos, spineTextOffMm: c.spineOff,
            trimWmm: c.sizeMm ? c.sizeMm[0] : 0, trimHmm: c.sizeMm ? c.sizeMm[1] : 0,
            centerMarks: c.centerMarks,
            spineLabelText: c.spineLabel ? `책등 ${c.spine}mm` : '',
            creaseLabel: c.creaseLabel, hingeMm: c.hinge,
            sheetWmm: c.sheetMm ? c.sheetMm[0] : 0, sheetHmm: c.sheetMm ? c.sheetMm[1] : 0,
            sheetMgMm: c.sheetMg,
          });
          name = `${base}_표지스프레드_책등${c.spine}mm.pdf`;
          note = `📕 무선제본 표지 스프레드 생성 완료 — [뒤표지 ${c.backAuto !== 'none' ? '자동' : (bi + 1) + 'p'} | 책등 ${c.spine}mm | 앞표지 ${fi + 1}p]`
            + (c.sizeMm ? `\n표지 크기 ${c.sizeMm[0]}×${c.sizeMm[1]}mm` : '')
            + (c.sheetMm ? `\n대지 ${c.sheetMm[0]}×${c.sheetMm[1]}mm · 여백 상${c.sheetMg.t}/하${c.sheetMg.b}/좌${c.sheetMg.l}/우${c.sheetMg.r}mm — 트림은 좌·하 여백선 기준, 누름선 값은 대지 좌측 모서리 기준` : '')
            + `\n내지 ${c.body}쪽 · ${c.duplex ? '양면' : '단면'} × ${c.thick}mm/장${c.adj ? ` + 보정 ${c.adj}mm` : ''}${c.bleed ? ` · 블리드 ${c.bleed}mm` : ''}${c.crop ? ' · 재단선' : ''}${c.centerMarks ? ' · 중앙재단선' : ''}${c.fold ? ' · 오시선' : ''}${c.spineLabel ? ' · 책등두께 표시' : ''}`
            + fileNote + autoBackNote
            + `\n인쇄: 표지 용지(두꺼운 지종) 단면 → 재단선 따라 재단 → 오시(접선) 넣고 → 무선제본 감싸기`
            + `\n⚠ 실제 책등폭은 지종·부피에 따라 다르니 가제본으로 확인 후 보정(mm)을 조정하세요.`;
        } else {
          const workDoc = await PDFLib.PDFDocument.load(workBytes.slice(0));
          const out = await PDFLib.PDFDocument.create();
          const idxs = fi === bi ? [fi] : [fi, bi];
          (await out.copyPages(workDoc, idxs)).forEach(p => out.addPage(p));
          bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
          name = `${base}_표지.pdf`;
          note = `📕 표지 추출 완료 — ${idxs.length}쪽 (앞표지 ${fi + 1}p${fi === bi ? '' : ` · 뒤표지 ${c.backAuto !== 'none' ? '자동 생성' : (bi + 1) + 'p'}`})`
            + fileNote + autoBackNote
            + `\n표지 용지에 별도 인쇄하세요. 책등 포함 한 판이 필요하면 '무선제본 스프레드' 모드를 사용하세요.`;
        }
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        // 편집기 미리보기 옵션 ON → 저장 전에 편집기 창에서 확인·오브젝트 이동·텍스트 추가
        if (document.getElementById('coverEditPreview')?.checked) {
          await openCoverEditor(bytes, name, note);
          showSuccess('📕 표지가 생성되어 편집기 창이 열렸습니다.\n오브젝트 클릭=선택·드래그 이동, T=텍스트 삽입(속성의 회전° 90 = 세로 제목), I=이미지, R=도형.\n💾 저장하고 닫기를 누르면 저장 위치를 묻습니다.');
        } else {
          try { renderProcessedPreview(bytes); } catch (e) {}
          const saved = await window.electronAPI.saveFile({ defaultName: name, buffer: bytes });
          if (saved) showSuccess(note);
        }
      } catch (e) {
        console.error('표지 생성 오류:', e);
        showError('표지 생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; setBtnBusy('coverGenBtn', false);
        hideLoading(); progressBar.style.display = 'none';
      }
    }

    // ── 표지 편집기 세션 — 생성된 표지 PDF를 내부 편집기 창에서 미리보기·수정 ──
    // (오브젝트 이동·삭제, T=텍스트 삽입(회전° 90=세로 제목), 이미지·도형)
    // 저장 결과는 contentEdits가 아니라 여기서 받아 표지 파일로 저장한다.
    let _coverEditSession = null;   // { bytes, name, note }
    async function openCoverEditor(bytes, name, note) {
      const pdfPath = window.electronAPI.writeTempFile(bytes.slice ? bytes.slice(0) : bytes, 'pdf');
      const doc = await PDFLib.PDFDocument.load(bytes.slice ? bytes.slice(0) : bytes);
      const order = doc.getPageIndices().map(i => ({ originalIdx: i, num: i + 1 }));
      _coverEditSession = { bytes, name, note };
      await window.electronAPI.openEditor({ pdfPath, models: {}, startIdx: 0, order });
    }
    async function handleCoverEditorResult(result) {
      const ses = _coverEditSession;
      _coverEditSession = null;
      if (!ses) return;
      try {
        let outBytes = ses.bytes;
        const edits = result && result.edits;
        const editedCnt = edits ? Object.keys(edits).length : 0;
        if (editedCnt) {
          showLoading('표지 편집 반영 중…');
          const doc = await PDFLib.PDFDocument.load(ses.bytes.slice ? ses.bytes.slice(0) : ses.bytes);
          for (const k of Object.keys(edits)) {
            const idx = +k;
            let eb = null;
            try { eb = new Uint8Array(window.electronAPI.readFile(edits[k].bytesPath)); }
            catch (err) { console.error('표지 편집결과 읽기 실패:', err); }
            finally { try { window.electronAPI.removeTempFile(edits[k].bytesPath); } catch (x) {} }
            if (!eb || !(idx >= 0 && idx < doc.getPageCount())) continue;
            const ed = await PDFLib.PDFDocument.load(eb);
            const [np] = await doc.copyPages(ed, [0]);
            doc.removePage(idx);
            doc.insertPage(idx, np);
          }
          outBytes = new Uint8Array(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
          hideLoading();
        }
        try { renderProcessedPreview(outBytes); } catch (e) {}
        const saved = await window.electronAPI.saveFile({ defaultName: ses.name, buffer: outBytes });
        if (saved) showSuccess(ses.note + (editedCnt ? `\n🖊 편집기 수정 ${editedCnt}쪽 반영됨.` : ''));
      } catch (e) {
        console.error('표지 편집 반영 오류:', e);
        showError('표지 편집 반영 실패: ' + (e && e.message ? e.message : String(e)));
      } finally { hideLoading(); }
    }

    // ── ✒ 폰트 아웃라인화 — 체크 옵션 (편집 적용·다운로드의 최종 단계로 반영) ──
    // 즉시 실행 버튼이 아니라 옵션이므로 프리셋에 저장·복원된다.
    let _outlineEnabled = false;
    // 방식: 'outline'=곡선화(-dNoOutputFonts), 'embed'=폰트 완전 임베드(-dEmbedAllFonts, 비서브셋)
    // 기본값 = 'embed'(완전 임베드). 실측(한글 40쪽): 곡선화 2.6초·11MB vs 완전 임베드 0.3초·35KB —
    // 9배 빠르고 용량 증가가 없으며 텍스트 검색·수정도 유지된다. 곡선화는 명시 선택 시에만.
    let _outlineMode = localStorage.getItem('outlineMode') === 'outline' ? 'outline' : 'embed';
    function setOutlineMode(m) {
      _outlineMode = m === 'embed' ? 'embed' : 'outline';
      try { localStorage.setItem('outlineMode', _outlineMode); } catch (e) {}
      activateChip('olmode', _outlineMode);
      // 안전화는 다운로드 시점 처리 — 적용 결과(화면)는 그대로 두고 다음 저장부터 반영된다.
      if (_outlineEnabled) { outlineOnMessage(); setTimeout(prewarmOptimizedOutput, 400); }
    }
    function outlineOnMessage() {
      showSuccess(_outlineMode === 'embed'
        ? "🔤 폰트 완전 임베드 켜짐 — '⇩ 다운로드'로 저장되는 파일에 모든 폰트를 통째로 실어, 다른 PC·출력기에서도 동일하게 인쇄됩니다.\n텍스트 수정·검색은 유지됩니다. (적용 화면은 그대로 — 모양이 바뀌지 않는 처리라 저장 시점에 반영됩니다)"
        : "✒ 폰트 곡선화 켜짐 — '⇩ 다운로드'로 저장되는 파일의 모든 글자가 곡선으로 변환됩니다.\n⚠ 용량이 크게 늘고(수십~수백 배) 텍스트 수정·검색 불가 — 수정용 원본은 따로 보관하세요. 빠르고 용량 부담 없는 '폰트 완전 임베드'도 같은 안전 효과를 냅니다.");
    }
    function setOutlineEnabled(on) {
      _outlineEnabled = !!on;
      const chk = document.getElementById('esOutline');
      if (chk && chk.checked !== _outlineEnabled) chk.checked = _outlineEnabled;
      // 메인 '처리 옵션' 줄의 미러 버튼도 즉시 동기 (상태·표시 불일치로 인한 오인 방지)
      const mb = document.getElementById('opt-outline');
      if (mb) mb.classList.toggle('active', _outlineEnabled);
      if (typeof updateEsGroupBadges === 'function') updateEsGroupBadges();
      // 예전엔 invalidateProcessed()로 '적용 필요' 상태를 만들었지만, 안전화는 화면 모양을
      // 바꾸지 않고 저장 직전에만 반영되므로 적용 결과를 버릴 이유가 없다(대용량 재적용 방지).
      updateDownloadBtn();
      if (_outlineEnabled) { outlineOnMessage(); setTimeout(prewarmOptimizedOutput, 400); }
    }
    // bytes → gs 아웃라인 변환 바이트 (적용·다운로드 공용)
    // 속도 개선 2단: ① 같은 입력+옵션이면 캐시 재사용(적용→다운로드 재실행 0초)
    // ② gs는 단일 코어만 쓰므로, 페이지를 구간으로 쪼개 gs 여러 개를 병렬 실행 후 병합.
    // 용량 증가(글자→곡선 데이터)는 방식의 본질이며 병렬화와 무관. 병합은 pdf-lib
    // copyPages — 아웃라인 결과는 전부 곡선이라 재병합에 안전하다.
    let _outlineCache = { key: null, bytes: null, rasterInfo: null };
    let _outlineRasterInfo = null;   // 마지막 실행에서 이미지화된 페이지 정보 (성공 메시지용)
    async function buildOutlinedBytes(bytes, onProgress) {
      const flatten = !!document.getElementById('outlineFlatten')?.checked;
      const mode = _outlineMode;
      const key = bytesFingerprint(bytes) + '|' + (flatten ? 'f' : 'n') + '|' + mode;
      if (_outlineCache.key === key && _outlineCache.bytes) {
        _outlineRasterInfo = _outlineCache.rasterInfo || null;
        return _outlineCache.bytes;
      }
      _outlineRasterInfo = null;
      const gsOne = async (inBytes) => {
        let tmpPath = null, outPath = null;
        try {
          tmpPath = window.electronAPI.writeTempFile(inBytes, 'pdf');
          const res = await window.electronAPI.outlineFonts(tmpPath, { flatten, mode });
          outPath = typeof res === 'string' ? res : res.path;
          const b = new Uint8Array(window.electronAPI.readFile(outPath));
          return { bytes: b, log: typeof res === 'string' ? '' : (res.log || '') };
        } finally {
          if (tmpPath) { try { window.electronAPI.removeTempFile(tmpPath); } catch (e) {} }
          if (outPath) { try { window.electronAPI.removeTempFile(outPath); } catch (e) {} }
        }
      };
      let out, rasterInfo = null;
      try {
        // 완전 임베드 모드는 분할 병렬 금지 — 구간마다 전체 폰트가 통째로 실려
        // 병합 시 폰트가 구간 수만큼 중복돼 용량 이점이 사라진다. 곡선 변환이 없어
        // 단일 실행도 충분히 빠르다.
        if (mode === 'embed') {
          // 1차 실행 — gs 로그에서 '이 PC에도 없어 내장 대체폰트(%rom%)로 바뀐' 폰트 감지.
          // 대체 임베드는 글꼴이 달라져 사고 위험 → 그 폰트를 쓰는 페이지만 화면 그대로
          // 300DPI 이미지로 굳혀(이미지화) 어디서 출력해도 동일하게 만든다.
          const r1 = await gsOne(bytes);
          const missing = _gsSubstitutedFonts(r1.log);
          out = r1.bytes;
          if (missing.length) {
            const pageIdxs = await _pagesUsingFonts(bytes, missing);
            if (pageIdxs.length) {
              if (onProgress) onProgress(0.3);
              const rastered = await _rasterizePagesToImages(bytes, pageIdxs);
              if (onProgress) onProgress(0.7);
              out = (await gsOne(rastered)).bytes;   // 2차: 이미지화 반영본을 다시 완전 임베드
              rasterInfo = { count: pageIdxs.length, fonts: missing, pages: pageIdxs.map(i => i + 1) };
            }
          }
          if (out.byteLength < 400 * 1024 * 1024) _outlineCache = { key, bytes: out, rasterInfo };
          _outlineRasterInfo = rasterInfo;
          return out;
        }
        const src = await PDFLib.PDFDocument.load(bytes.slice(0));
        const N = src.getPageCount();
        // 구간 수 = 코어의 3/4 (상한 6, 구간당 최소 6쪽) — 코어를 다 잡으면 UI가 버벅인다
        const K = Math.max(1, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) * 0.75), Math.ceil(N / 6)));
        if (K < 2) {
          out = (await gsOne(bytes)).bytes;
        } else {
          // 분할은 직렬(같은 src 문서에 대한 pdf-lib 동시 접근 회피), gs 실행만 병렬
          const per = Math.ceil(N / K);
          const parts = [];
          for (let s = 0; s < N; s += per) {
            const idxs = Array.from({ length: Math.min(per, N - s) }, (_, j) => s + j);
            const sub = await PDFLib.PDFDocument.create();
            (await sub.copyPages(src, idxs)).forEach(p => sub.addPage(p));
            parts.push(new Uint8Array(await sub.save({ useObjectStreams: false })));
          }
          let done = 0;
          const outlinedChunks = await Promise.all(parts.map(pb => gsOne(pb).then(r => {
            done++;
            if (onProgress) onProgress(done / parts.length);
            return r.bytes;
          })));
          const merged = await PDFLib.PDFDocument.create();
          for (const cb of outlinedChunks) {
            const cd = await PDFLib.PDFDocument.load(cb);
            (await merged.copyPages(cd, cd.getPageIndices())).forEach(p => merged.addPage(p));
          }
          out = new Uint8Array(await merged.save({ useObjectStreams: true }));
        }
      } catch (e) {
        // gs 미설치 등 환경 문제는 그대로 알리고, 분할·병합 단계 오류만 단일 실행 폴백
        if (/Ghostscript/i.test((e && e.message) || '')) throw e;
        console.warn('아웃라인 병렬 처리 실패 — 단일 실행으로 폴백:', e);
        out = (await gsOne(bytes)).bytes;
      }
      // 초대형 결과(400MB+)는 캐시하지 않음 — 메모리 보호
      if (out.byteLength < 400 * 1024 * 1024) _outlineCache = { key, bytes: out, rasterInfo: null };
      return out;
    }

    // ── 완전 임베드 보조: 대체폰트 감지·페이지 매핑·이미지화 ─────────────────
    // gs 로그에서 내장 대체폰트(%rom%)로 로드된 폰트명 추출. 표준 14종(Helvetica 등)의
    // %rom% 대체(NimbusSans…)는 규격상 정확한 호환 폰트라 제외한다.
    function _gsSubstitutedFonts(log) {
      const STD14 = /^(Helvetica|Times|Courier|Symbol|ZapfDingbats|Arial|ArialMT|Arial-|TimesNewRoman|CourierNew)/i;
      const names = new Set();
      for (const line of String(log || '').split(/\r?\n/)) {
        let m = line.match(/Loading (?:CID)?[Ff]ont (.+?) \(or substitute\) from (.+)$/);
        if (m && /%rom%/.test(m[2]) && !STD14.test(m[1].trim())) names.add(m[1].trim());
        m = line.match(/Substituting font .+? for (.+?)\.?\s*$/i);
        if (m && !STD14.test(m[1].trim())) names.add(m[1].trim());
        m = line.match(/Could(?:n't| not) find (?:a )?(?:CID)?font ['"]?([\w+-]+)/i);
        if (m && !STD14.test(m[1].trim())) names.add(m[1].trim());
      }
      return [...names];
    }
    // 해당 폰트(BaseFont, 서브셋 접두사 제거 비교)를 리소스로 참조하는 페이지 인덱스 목록
    async function _pagesUsingFonts(bytes, fontNames) {
      const want = new Set(fontNames.map(n => n.replace(/^[A-Z]{6}\+/, '')));
      const doc = await PDFLib.PDFDocument.load(bytes.slice(0));
      const idxs = [];
      doc.getPages().forEach((pg, i) => {
        try {
          const res = pg.node.Resources();
          const fonts = res && res.lookup(PDFLib.PDFName.of('Font'));
          if (!fonts || !fonts.entries) return;
          for (const [, ref] of fonts.entries()) {
            const fd = doc.context.lookup(ref);
            const bf = fd && fd.lookup && fd.lookup(PDFLib.PDFName.of('BaseFont'));
            const name = bf && bf.decodeText ? bf.decodeText() : (bf ? String(bf).replace(/^\//, '') : '');
            if (name && want.has(name.replace(/^[A-Z]{6}\+/, ''))) { idxs.push(i); return; }
          }
        } catch (e) {}
      });
      return idxs;
    }
    // 지정 페이지를 pdf.js로 300DPI 렌더(화면 미리보기와 동일한 모습) → JPEG로 페이지 교체.
    // 회전은 렌더에 구워지므로 /Rotate 0 + 뷰어 방향 크기로 재설정, 부속 박스는 제거.
    async function _rasterizePagesToImages(bytes, pageIdxs) {
      const doc = await PDFLib.PDFDocument.load(bytes.slice(0));
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      try {
        for (const i of pageIdxs) {
          const page = await pdf.getPage(i + 1);
          const vp1 = page.getViewport({ scale: 1 });
          const scale = Math.min(300 / 72, 8000 / Math.max(vp1.width, vp1.height));
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          page.cleanup();
          const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
          const jpg = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
          const pg = doc.getPage(i);
          ['CropBox', 'TrimBox', 'BleedBox', 'ArtBox'].forEach(k => { try { pg.node.delete(PDFLib.PDFName.of(k)); } catch (e) {} });
          try { pg.node.delete(PDFLib.PDFName.of('Contents')); } catch (e) {}
          pg.node.set(PDFLib.PDFName.of('Resources'), doc.context.obj({}));
          pg.setRotation(PDFLib.degrees(0));
          pg.setMediaBox(0, 0, vp1.width, vp1.height);   // 원점 0 보장 (setSize는 기존 원점 유지)
          pg.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        }
      } finally { try { await pdf.destroy(); } catch (e) {} }
      return new Uint8Array(await doc.save({ useObjectStreams: false }));
    }

    // 임포징 공용 용지 (가로 기준 [w, h])
    const IMP_PAPERS = { A4: [841.89, 595.28], A3: [1190.55, 841.89], B4: [1031.81, 728.50], B5: [728.50, 515.91] };

    // 임포징 공용: 재단선(트림 마크) — 트림 사각형 네 모서리 바깥에 짧은 선(갭 1mm, 길이 3mm)
    function drawCropMarks(page, x, y, w, h, style) {
      // 스타일: UI(impCropGap·impCropLen·impCropTh·impCropCenter)에서 읽고, 독립 도구 등
      // _impCropStyle이 없는 환경에서는 기본값(간격1mm·길이3mm·0.4pt·중앙마크 없음).
      const s = style || (typeof _impCropStyle === 'function' ? _impCropStyle() : null) || {};
      const MM = 72 / 25.4;
      const gap = (s.gap != null ? s.gap : 1) * MM, len = (s.len != null ? s.len : 3) * MM;
      const th = s.th != null ? s.th : 0.4;
      const black = PDFLib.rgb(0, 0, 0);
      const L = (x1, y1, x2, y2) =>
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: th, color: black });
      [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]]
        .forEach(([cx, cy, dx, dy]) => {
          L(cx + dx * gap, cy, cx + dx * (gap + len), cy);   // 모서리 바깥 가로선
          L(cx, cy + dy * gap, cx, cy + dy * (gap + len));   // 모서리 바깥 세로선
        });
      if (s.center) {   // 중앙 마크 — 각 변 중점 바깥 (접지·정합 확인용)
        L(x + w/2, y - gap, x + w/2, y - gap - len);           // 하
        L(x + w/2, y + h + gap, x + w/2, y + h + gap + len);   // 상
        L(x - gap, y + h/2, x - gap - len, y + h/2);           // 좌
        L(x + w + gap, y + h/2, x + w + gap + len, y + h/2);   // 우
      }
    }

    // 임포징 공용: 슬롯 내 배치 계산 (순수 함수 — 노드 단독 검증 가능)
    // slot {x,y,w,h}(pt) · pg {w,h}(pt) · place { scale:'fit'(칸 맞춤)|'orig'(100% 원본),
    //   align: 수직(t/c/b)+수평(l/c/r) 2글자('cc'=중앙), offX/offY: 추가 이동 mm(+X=오른쪽, +Y=아래) }
    function placeInSlot(slot, pg, place) {
      const MM = 72 / 25.4;
      const p = place || {};
      const s = p.scale === 'orig' ? 1
              : p.scale === 'fixed' ? (p.fixedScale || 1)
              : Math.min(slot.w / pg.w, slot.h / pg.h);
      const dw = pg.w * s, dh = pg.h * s;
      const a = p.align || 'cc';
      const x = slot.x + (a[1] === 'l' ? 0 : a[1] === 'r' ? slot.w - dw : (slot.w - dw) / 2) + (p.offX || 0) * MM;
      const y = slot.y + (a[0] === 't' ? slot.h - dh : a[0] === 'b' ? 0 : (slot.h - dh) / 2) - (p.offY || 0) * MM;
      return { x, y, w: dw, h: dh, s };
    }
    // 임포징 공용: 슬롯에 페이지 그리기(배치 + 블리드) → 트림 사각형 {x,y,w,h} 반환.
    // shiftX: 배치 후 수평 이동(중철 밀림보정). 모든 임포징 빌더가 이 함수로 그린다.
    function drawPlaced(page, emb, slot, opts, shiftX) {
      const t = placeInSlot(slot, emb, opts.place);
      const x = t.x + (shiftX || 0), y = t.y;
      const bPt = (opts.bleed || 0) * 72 / 25.4;
      let dx = x, dy = y, ds = t.s;
      if (bPt > 0) {
        // 블리드: 트림보다 크게(면당 bPt) 확대해 중앙 정렬 — 재단 밀림 대비
        const k = Math.max((t.w + 2 * bPt) / t.w, (t.h + 2 * bPt) / t.h);
        ds = t.s * k;
        dx = x + t.w / 2 - emb.w * ds / 2;
        dy = y + t.h / 2 - emb.h * ds / 2;
      }
      page.drawPage(emb.e, { x: dx, y: dy, xScale: ds, yScale: ds });
      // 원고가 블리드를 품고 있으면(TrimBox < MediaBox) 재단선·프레임은 그 트림 위치에 —
      // 블리드까지 포함한 바깥 테두리에 찍히면 재단선이 블리드 밖으로 나가 재단 기준이 틀어진다.
      const tr = emb.trim;
      if (tr) return {
        x: dx + tr.l * ds, y: dy + tr.b * ds,
        w: (emb.w - tr.l - tr.r) * ds, h: (emb.h - tr.b - tr.t) * ds,
      };
      return { x, y, w: t.w, h: t.h };
    }
    // 임포징 공용: 여백(mm)을 pt 4방으로 해석. opts.margin이 숫자면 4방 동일, 객체면 {l,t,r,b}.
    function impMargins(opts) {
      const MM = 72 / 25.4, m = opts.margin;
      if (m && typeof m === 'object') return { l: (m.l || 0) * MM, t: (m.t || 0) * MM, r: (m.r || 0) * MM, b: (m.b || 0) * MM };
      const v = (m || 0) * MM; return { l: v, t: v, r: v, b: v };
    }
    // 임포징 공용: 칸 사이 간격(거터) — 수평/수직 개별(hgap/vgap) 우선, 없으면 gutter 공용.
    function impGaps(opts) {
      const MM = 72 / 25.4;
      const h = (opts.hgap != null ? opts.hgap : (opts.gutter || 0)) * MM;
      const v = (opts.vgap != null ? opts.vgap : (opts.gutter || 0)) * MM;
      return { h, v };
    }
    // 임포징 공용: 각 페이지 주위 얇은 테두리(프레임) — trim 사각형에 그림
    function drawFrame(page, t) {
      if (!t) return;
      page.drawRectangle({ x: t.x, y: t.y, width: t.w, height: t.h, borderColor: PDFLib.rgb(0, 0, 0), borderWidth: 0.3 });
    }
    // ── 임포징 공용: 슬러그(시트 작업정보) + 정합 묶음번호 ──────────────────────
    // opts.slug = { text: '파일명 · 날짜', fontBytes: TTF ArrayBuffer|null } — 한글은 fontBytes가
    // 있어야 인쇄되고(맑은 고딕 등), 없으면 ASCII만 남긴다(독립 도구 폴백).
    // opts.stackNum = true — 정합(cutstack) 앞면 각 묶음의 트림 바깥에 순서 번호 인쇄.
    async function prepSlug(out, opts) {
      if (!opts.slug && !opts.stackNum) return null;
      const ascii = await out.embedFont(PDFLib.StandardFonts.Helvetica);
      let font = null, unicode = false;
      if (opts.slug && opts.slug.fontBytes) {
        try {
          const fk = (typeof fontkit !== 'undefined') ? fontkit
                   : (typeof self !== 'undefined' && self.fontkit) ? self.fontkit : null;
          if (fk) {
            out.registerFontkit(fk);
            font = await out.embedFont(opts.slug.fontBytes, { subset: true });
            unicode = true;
          }
        } catch (e) { console.warn('슬러그 폰트 임베드 실패 — 기본 폰트로 대체:', e); }
      }
      return { font: font || ascii, ascii, unicode, enabled: !!opts.slug, base: opts.slug ? (opts.slug.text || '') : '' };
    }
    // 시트 하단 왼쪽에 한 줄: "파일명 · 날짜 · 시트 i/n 앞|뒤" (재단 여백 영역, 6.5pt)
    function drawSlug(page, slug, i, n, side) {
      if (!slug || !slug.enabled) return;
      const MM = 72 / 25.4;
      let text;
      if (slug.unicode) text = (slug.base ? slug.base + ' · ' : '') + `시트 ${i}/${n} ${side === 'B' ? '뒤' : '앞'}`;
      else {
        text = ((slug.base ? slug.base + ' · ' : '') + `sheet ${i}/${n} ${side === 'B' ? 'B' : 'F'}`)
          .replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
      }
      try { page.drawText(text, { x: 4 * MM, y: 1.2 * MM, size: 6.5, font: slug.font, color: PDFLib.rgb(0, 0, 0) }); } catch (e) {}
    }
    // 정합 묶음번호 — 흰 원+검정 번호를 트림 '왼쪽 바깥'에(공간 없으면 위 바깥 → 최후 트림 안 좌상단).
    // 재단선 밖이라 재단 시 잘려나감 — 전지 상태에서 묶음 겹치기 순서 안내용.
    function drawStackNum(page, t, num, font, sw, sh) {
      if (!t || !font) return;
      const MM = 72 / 25.4, r = 2 * MM;
      let cx = t.x - r - 0.8 * MM, cy = t.y + t.h - r;
      if (cx - r < 0.5 * MM) { cx = t.x + r; cy = t.y + t.h + r + 0.8 * MM; }        // 왼쪽 공간 없음 → 위 바깥
      if (cy + r > sh - 0.5 * MM || cy - r < 0.5 * MM) { cx = t.x + r + 0.8 * MM; cy = t.y + t.h - r - 0.8 * MM; } // 최후: 트림 안 좌상
      const s = String(num);
      try {
        page.drawCircle({ x: cx, y: cy, size: r, color: PDFLib.rgb(1, 1, 1), borderColor: PDFLib.rgb(0, 0, 0), borderWidth: 0.6 });
        const w = font.widthOfTextAtSize(s, 7);
        page.drawText(s, { x: cx - w / 2, y: cy - 2.4, size: 7, font, color: PDFLib.rgb(0, 0, 0) });
      } catch (e) {}
    }

    // ── 일반 N-up(모아찍기) 빌더 — 임의 열×행 그리드 ────────────────────────────
    // opts: across, down, sides(1|2), order('sequential'|'cutstack'), sheet[w,h]pt|null(auto),
    //   margin{l,t,r,b}|숫자, hgap/vgap|gutter, bleed, crop, frame, place{scale,align,...}.
    // sequential: 연속 페이지를 좌→우·상→하로 채움. cutstack: 슬롯별 연속 묶음(재단 후 겹치기).
    // 양면(sides=2): 뒷면은 열을 좌우 미러('짧은 쪽 넘김' 기준).
    async function buildNupBytes(srcBytes, opts, onProgress) {
      const src = await PDFLib.PDFDocument.load(srcBytes.slice ? srcBytes.slice(0) : srcBytes);
      const n0 = src.getPageCount();
      if (!n0) throw new Error('페이지가 없습니다.');
      const across = Math.max(1, opts.across | 0), down = Math.max(1, opts.down | 0);
      const per = across * down, sides = opts.sides === 2 ? 2 : 1;
      const out = await PDFLib.PDFDocument.create();
      const embedded = await embedAllPages(out, src, onProgress);

      // 시트 크기 — opts.sheet 우선, 없으면 원본 1페이지 기준 그리드 자동
      let sw, sh;
      if (opts.sheet) { [sw, sh] = opts.sheet; }
      else { sw = embedded[0].w * across; sh = embedded[0].h * down; }
      const mg = impMargins(opts), gp = impGaps(opts);
      const slotW = (sw - mg.l - mg.r - (across - 1) * gp.h) / across;
      const slotH = (sh - mg.t - mg.b - (down - 1) * gp.v) / down;
      if (slotW <= 0 || slotH <= 0) throw new Error('여백·거터가 시트보다 큽니다.');

      // 슬롯 s(0=좌상, 좌→우·상→하)의 사각형
      const slotRect = s => {
        const col = s % across, row = (s / across) | 0;
        return { x: mg.l + col * (slotW + gp.h), y: sh - mg.t - (row + 1) * slotH - row * gp.v, w: slotW, h: slotH };
      };
      const mirror = s => { const col = s % across, row = (s / across) | 0; return row * across + (across - 1 - col); };

      // 시트별 논리 페이지 배열 구성
      const sheetCnt = Math.ceil(n0 / (per * sides));
      const sheets = [];
      if (opts.order === 'cutstack') {
        const chunk = sheetCnt * sides;   // 슬롯당 연속 묶음 크기
        for (let i = 0; i < sheetCnt; i++) {
          const front = [], back = sides === 2 ? [] : null;
          for (let s = 0; s < per; s++) front.push(s * chunk + i * sides + 1);
          if (back) for (let s = 0; s < per; s++) back.push(mirror(s) * chunk + i * sides + 2);
          sheets.push({ front, back });
        }
      } else {   // sequential
        let pg = 1;
        for (let i = 0; i < sheetCnt; i++) {
          const front = []; for (let s = 0; s < per; s++) front.push(pg++);
          let back = null;
          if (sides === 2) { back = new Array(per); for (let s = 0; s < per; s++) back[mirror(s)] = pg++; }
          sheets.push({ front, back });
        }
      }

      const drawInto = (page, logical, s) => {
        if (!logical || logical > n0) return null;
        const t = drawPlaced(page, embedded[logical - 1], slotRect(s), opts);
        if (opts.frame) drawFrame(page, t);
        return t;
      };
      const slug = await prepSlug(out, opts);
      let sheetsMade = 0;
      for (let i = 0; i < sheets.length; i++) {
        const { front, back } = sheets[i];
        const fp = out.addPage([sw, sh]);
        const ft = front.map((lg, s) => drawInto(fp, lg, s));
        if (opts.crop) ft.forEach(t => { if (t) drawCropMarks(fp, t.x, t.y, t.w, t.h); });
        if (opts.stackNum && opts.order === 'cutstack' && slug)
          ft.forEach((t, s) => drawStackNum(fp, t, s + 1, slug.ascii, sw, sh));
        drawSlug(fp, slug, i + 1, sheets.length, 'F');
        sheetsMade++;
        if (back) {
          const bp = out.addPage([sw, sh]);
          const bt = back.map((lg, s) => drawInto(bp, lg, s));
          if (opts.crop) bt.forEach(t => { if (t) drawCropMarks(bp, t.x, t.y, t.w, t.h); });
          drawSlug(bp, slug, i + 1, sheets.length, 'B');
          sheetsMade++;
        }
        if (onProgress) onProgress(40 + Math.round((i + 1) / sheets.length * 55));
        await uiYield();
      }
      if (onProgress) onProgress(98);
      const bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
      return { bytes, n0, per, across, down, sides, sheets: sheetsMade };
    }

    async function buildBookletBytes(srcBytes, opts, onProgress) {
      const src = await PDFLib.PDFDocument.load(srcBytes.slice ? srcBytes.slice(0) : srcBytes);
      const n0 = src.getPageCount();
      if (!n0) throw new Error('페이지가 없습니다.');
      const n = Math.ceil(n0 / 4) * 4;
      const out = await PDFLib.PDFDocument.create();
      const embedded = await embedAllPages(out, src, onProgress);

      // 시트 크기 (가로 방향) — opts.sheet=[w,h]pt(사용자 정의 포함 해석값) 우선
      let sw, sh;
      if (opts.sheet)                { [sw, sh] = opts.sheet; }
      else if (!opts.paper || opts.paper === 'auto') { sw = embedded[0].w * 2; sh = embedded[0].h; }
      else                           { [sw, sh] = IMP_PAPERS[opts.paper] || IMP_PAPERS.A4; }
      const MM = 72 / 25.4;
      const creepPt  = (opts.creep  || 0) * MM;
      const mg = impMargins(opts), gp = impGaps(opts);
      const slotW = (sw - mg.l - mg.r - gp.h) / 2, slotH = sh - mg.t - mg.b;
      if (slotW <= 0 || slotH <= 0) throw new Error('여백·거터가 시트보다 큽니다.');

      // 한 칸 그리기 — shift: 책등(중앙) 쪽으로 콘텐츠 이동량(밀림 보정)
      // 반환: 트림(재단) 사각형 {x,y,w,h} (재단선용) 또는 null(빈 면)
      const drawSlot = (page, logical, side, shift) => {
        if (logical > n0) return null;   // 4의 배수 채움용 빈 면
        const x0 = side === 'L' ? mg.l : mg.l + slotW + gp.h;
        return drawPlaced(page, embedded[logical - 1], { x: x0, y: mg.b, w: slotW, h: slotH },
                          opts, side === 'L' ? shift : -shift);
      };

      const order = bookletSheetOrder(n, opts.binding);
      const slug = await prepSlug(out, opts);
      for (let i = 0; i < order.length; i++) {
        const { front, back } = order[i];
        const shift = creepPt * i;   // 바깥 시트 0 → 안쪽으로 갈수록 책등 쪽 이동
        const fp = out.addPage([sw, sh]);
        const ft = [drawSlot(fp, front[0], 'L', shift), drawSlot(fp, front[1], 'R', shift)];
        const bp = out.addPage([sw, sh]);
        const bt = [drawSlot(bp, back[0], 'L', shift), drawSlot(bp, back[1], 'R', shift)];
        if (opts.crop) {   // 재단선은 페이지 위에 그린다
          ft.forEach(t => { if (t) drawCropMarks(fp, t.x, t.y, t.w, t.h); });
          bt.forEach(t => { if (t) drawCropMarks(bp, t.x, t.y, t.w, t.h); });
        }
        drawSlug(fp, slug, i + 1, order.length, 'F');
        drawSlug(bp, slug, i + 1, order.length, 'B');
        if (onProgress) onProgress(40 + Math.round((i + 1) / order.length * 55));
        await uiYield();
      }
      if (onProgress) onProgress(98);
      const bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
      return { bytes, n0, n, sheets: n / 4 };
    }

    // ── 정합(Cut & Stack) 순서 계산 (순수 함수 — 검증 용이하게 분리) ──────────
    // n0: 원본 쪽수, nup: 분할 수(2|4), sides: 1(단면)|2(양면).
    // 슬롯 s의 묶음 = 연속 구간 [s*chunk+1 .. (s+1)*chunk] (chunk = 시트수×면수)
    // → 재단 후 묶음을 슬롯 순서(좌→우, 상→하)로 겹치면 전체가 페이지 순서.
    // 양면 뒷면은 열을 좌우 미러(2-up: [L,R]→[R,L] / 2×2: [TL,TR,BL,BR]→[TR,TL,BR,BL])
    // — 가로시트 '짧은 쪽 넘김'·세로시트 '긴 쪽 넘김'(둘 다 세로축 뒤집기) 기준.
    function cutStackOrder(n0, nup, sides) {
      const sheetCnt = Math.max(1, Math.ceil(n0 / (nup * sides)));
      const n = sheetCnt * nup * sides;
      const chunk = sheetCnt * sides;
      const mirror = nup === 2 ? [1, 0] : [1, 0, 3, 2];
      const sheets = [];
      for (let i = 0; i < sheetCnt; i++) {
        const front = [], back = sides === 2 ? [] : null;
        for (let s = 0; s < nup; s++) front.push(s * chunk + i * sides + 1);
        if (back) for (let s = 0; s < nup; s++) back.push(mirror[s] * chunk + i * sides + 2);
        sheets.push({ front, back });
      }
      return { sheets, n, chunk };
    }

    async function buildCutStackBytes(srcBytes, opts, onProgress) {
      const src = await PDFLib.PDFDocument.load(srcBytes.slice ? srcBytes.slice(0) : srcBytes);
      const n0 = src.getPageCount();
      if (!n0) throw new Error('페이지가 없습니다.');
      const nup = opts.nup === 4 ? 4 : 2, sides = opts.sides === 1 ? 1 : 2;
      const out = await PDFLib.PDFDocument.create();
      const embedded = await embedAllPages(out, src, onProgress);

      // 시트 크기 — 2분할: 가로(2×폭), 4분할(2×2): 원본 비율 2배. opts.sheet 우선(사용자 정의 해석값)
      let sw, sh;
      if (opts.sheet) {
        [sw, sh] = opts.sheet;
      } else if (!opts.paper || opts.paper === 'auto') {
        sw = embedded[0].w * 2;
        sh = nup === 4 ? embedded[0].h * 2 : embedded[0].h;
      } else {
        const [pw, ph] = IMP_PAPERS[opts.paper] || IMP_PAPERS.A4;
        if (nup === 4) { sw = ph; sh = pw; }   // 4분할은 세로 용지
        else           { sw = pw; sh = ph; }   // 2분할은 가로 용지
      }
      const rows = nup / 2;
      const mg = impMargins(opts), gp = impGaps(opts);
      const slotW = (sw - mg.l - mg.r - gp.h) / 2;
      const slotH = (sh - mg.t - mg.b - (rows - 1) * gp.v) / rows;
      if (slotW <= 0 || slotH <= 0) throw new Error('여백·거터가 시트보다 큽니다.');

      // 슬롯 s(0=좌상 → 좌→우, 상→하)에 논리 페이지 배치. 반환: 트림 사각형 또는 null
      const drawCell = (page, logical, s) => {
        if (logical > n0) return null;   // 패딩 빈 면
        const col = s % 2, row = (s / 2) | 0;
        const x0 = mg.l + col * (slotW + gp.h);
        const y0 = sh - mg.t - (row + 1) * slotH - row * gp.v;
        return drawPlaced(page, embedded[logical - 1], { x: x0, y: y0, w: slotW, h: slotH }, opts);
      };

      const { sheets, n, chunk } = cutStackOrder(n0, nup, sides);
      for (let i = 0; i < sheets.length; i++) {
        const { front, back } = sheets[i];
        const fp = out.addPage([sw, sh]);
        const ft = front.map((pg, s) => drawCell(fp, pg, s));
        if (opts.crop) ft.forEach(t => { if (t) drawCropMarks(fp, t.x, t.y, t.w, t.h); });
        if (back) {
          const bp = out.addPage([sw, sh]);
          const bt = back.map((pg, s) => drawCell(bp, pg, s));
          if (opts.crop) bt.forEach(t => { if (t) drawCropMarks(bp, t.x, t.y, t.w, t.h); });
        }
        if (onProgress) onProgress(40 + Math.round((i + 1) / sheets.length * 55));
        await uiYield();
      }
      if (onProgress) onProgress(98);
      const bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
      return { bytes, n0, n, chunk, sheets: sheets.length, nup, sides };
    }

    // ── 반복 배치(Step & Repeat) — 명함·쿠폰·전단 ────────────────────────────
    // 각 원고 페이지를 한 시트에 여러 벌 배치. cols/rows 미지정(0) 시 원고 '실제 크기'로
    // 자동 최대 배치 — 용지 가로/세로 방향 중 더 많이 들어가는 쪽을 자동 선택.
    // 지정 시 칸 크기에 맞춰 비율 유지 확대/축소(방향은 원고가 더 크게 들어가는 쪽).
    async function buildStepRepeatBytes(srcBytes, opts, onProgress) {
      const src = await PDFLib.PDFDocument.load(srcBytes.slice ? srcBytes.slice(0) : srcBytes);
      const n0 = src.getPageCount();
      if (!n0) throw new Error('페이지가 없습니다.');
      const out = await PDFLib.PDFDocument.create();
      const embedded = await embedAllPages(out, src, onProgress);
      const MM = 72 / 25.4;
      const _g = impGaps(opts), _m = impMargins(opts);
      const gutterPt = _g.h;
      const mPt      = Math.max(_m.l, _m.r, _m.t, _m.b);   // 반복 배치는 대칭 여백
      const baseSheet = opts.sheet || IMP_PAPERS.A4;
      const cands = [[baseSheet[0], baseSheet[1]], [baseSheet[1], baseSheet[0]]];   // 가로/세로 두 방향 시도
      const wantC = opts.cols | 0, wantR = opts.rows | 0;

      const slug = await prepSlug(out, opts);
      let total = 0, firstGrid = null;
      for (let pi = 0; pi < n0; pi++) {
        const { e, w, h } = embedded[pi];
        // 방향 후보별 배치 계산 → 자동: 벌 수 최대 / 지정: 원고 스케일 최대
        let best = null;
        for (const [sw, sh] of cands) {
          const W = sw - 2 * mPt, H = sh - 2 * mPt;
          if (wantC > 0 && wantR > 0) {
            const cellW = (W - (wantC - 1) * gutterPt) / wantC;
            const cellH = (H - (wantR - 1) * gutterPt) / wantR;
            if (cellW <= 0 || cellH <= 0) continue;
            const s = Math.min(cellW / w, cellH / h);
            if (!best || s > best.score) best = { sw, sh, cols: wantC, rows: wantR, cellW, cellH, s, score: s };
          } else {
            const cols = Math.floor((W + gutterPt) / (w + gutterPt));
            const rows = Math.floor((H + gutterPt) / (h + gutterPt));
            if (cols < 1 || rows < 1) continue;
            const score = cols * rows;
            if (!best || score > best.score) best = { sw, sh, cols, rows, cellW: w, cellH: h, s: 1, score };
          }
        }
        if (!best) {
          throw new Error(wantC > 0
            ? '칸 수가 너무 많거나 여백·거터가 커서 배치할 수 없습니다.'
            : `원고(${Math.round(w / MM)}×${Math.round(h / MM)}mm)가 용지보다 큽니다 — 더 큰 용지를 선택하세요.`);
        }
        const { sw, sh, cols, rows, cellW, cellH } = best;
        // 배치 블록 전체를 시트 중앙 정렬 (여백 안쪽 보장: blockW ≤ W)
        const blockW = cols * cellW + (cols - 1) * gutterPt;
        const blockH = rows * cellH + (rows - 1) * gutterPt;
        const ox = (sw - blockW) / 2, oy = (sh - blockH) / 2;
        const page = out.addPage([sw, sh]);
        const trims = [];
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const slot = { x: ox + c * (cellW + gutterPt), y: oy + (rows - 1 - r) * (cellH + gutterPt), w: cellW, h: cellH };
          trims.push(drawPlaced(page, embedded[pi], slot, opts));
        }
        if (opts.crop) trims.forEach(t => drawCropMarks(page, t.x, t.y, t.w, t.h));
        drawSlug(page, slug, pi + 1, n0, 'F');
        total += cols * rows;
        if (!firstGrid) firstGrid = { cols, rows };
        if (onProgress) onProgress(40 + Math.round((pi + 1) / n0 * 55));
        await uiYield();
      }
      if (onProgress) onProgress(98);
      const bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
      return { bytes, n0, total, grid: firstGrid, sheets: n0 };
    }

    async function generateStepRepeat() {
      if (_bkBusy) return;
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      _bkBusy = true;
      try {
        showLoading('반복 배치 — 최신 편집 상태 준비 중…');
        progressBar.style.display = 'block'; updateProgress(0);
        const srcBytes = await buildOptimizedBase(p => updateProgress(Math.round(p * 0.45)));
        showLoading('반복 배치 — Step&Repeat 시트 조립 중…');
        const opts = currentImpOptions();
        const res = await buildStepRepeatBytes(srcBytes, opts, p => updateProgress(45 + Math.round(p * 0.55)));
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        try { renderProcessedPreview(res.bytes); } catch (e) { console.warn('임포징 미리보기 실패:', e); }
        const base = effectiveBaseName();   // 챕터 삭제 후에는 남은 첫 챕터명
        const g = res.grid || { cols: 0, rows: 0 };
        const outName = `${base}_반복${g.cols}x${g.rows}.pdf`;
        adoptImposedResult(res.bytes, outName);
        let msg = `📖 반복 배치(Step&Repeat) 생성 완료 — 시트 ${res.sheets}장 · 시트당 ${g.cols}×${g.rows}=${g.cols * g.rows}벌 (총 ${res.total}벌)`
          + `\n화면에 결과가 표시됩니다 — 저장은 메인 창의 '⇩ 다운로드' 버튼으로 진행하세요(임포징 반영본).`;
        if (opts.bleed > 0 && opts.gutter < opts.bleed * 2)
          msg += `\n⚠ 블리드(${opts.bleed}mm)가 거터(${opts.gutter}mm)의 절반보다 큽니다 — 이웃과 겹칠 수 있으니 거터를 ${opts.bleed * 2}mm 이상으로 권장`;
        showSuccess(msg);
      } catch (e) {
        console.error('반복 배치 생성 오류:', e);
        showError('반복 배치 생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; hideLoading(); progressBar.style.display = 'none';
      }
    }

    // ── 복제 2-up (2부, Quite Imposing 'Shuffle 1 1* 2* 2' + 2up 방식) ──────────
    // 각 페이지를 한 시트에 2벌(오른쪽 벌은 180° 회전) 배치. 재단하면 같은 문서 2部.
    // 양면(sides=2): 앞뒤로 2쪽씩 태워 종이 절약 — 앞 [p(2s+1)|p(2s+1)@180], 뒤 [p(2s+2)@180|p(2s+2)].
    // 단면(sides=1): 한 페이지당 한 시트(앞면만) — [p(i)|p(i)@180], 뒷면 없음.
    function dup2upOrder(n0, sides) {
      const sheets = [];
      if (sides === 1) {
        for (let i = 1; i <= n0; i++)
          sheets.push({ front: [{ p: i, r: 0 }, { p: i, r: 180 }], back: null });
        return { sheets, n: n0 };
      }
      const n = Math.ceil(n0 / 2) * 2;
      for (let s = 0; s < n / 2; s++) {
        const f = 2 * s + 1, b = 2 * s + 2;
        sheets.push({
          front: [{ p: f, r: 0 }, { p: f, r: 180 }],
          back:  [{ p: b, r: 180 }, { p: b, r: 0 }],
        });
      }
      return { sheets, n };
    }

    async function buildDup2upBytes(srcBytes, opts, onProgress) {
      const src = await PDFLib.PDFDocument.load(srcBytes.slice ? srcBytes.slice(0) : srcBytes);
      const n0 = src.getPageCount();
      if (!n0) throw new Error('페이지가 없습니다.');
      const out = await PDFLib.PDFDocument.create();
      // 정방향 + 180° 두 벌 임베드 (회전은 변환행렬로 굽는다)
      const emb0   = await embedAllPages(out, src, p => onProgress && onProgress(Math.round(p / 2)), 0);
      const emb180 = await embedAllPages(out, src, p => onProgress && onProgress(20 + Math.round(p / 2)), 180);

      let sw, sh;
      if (opts.sheet)                { [sw, sh] = opts.sheet; }
      else if (!opts.paper || opts.paper === 'auto') { sw = emb0[0].w * 2; sh = emb0[0].h; }
      else                           { [sw, sh] = IMP_PAPERS[opts.paper] || IMP_PAPERS.A4; }
      const mg = impMargins(opts), gp = impGaps(opts);
      const slotW = (sw - mg.l - mg.r - gp.h) / 2, slotH = sh - mg.t - mg.b;
      if (slotW <= 0 || slotH <= 0) throw new Error('여백·거터가 시트보다 큽니다.');

      const drawCell = (page, cell, side) => {
        if (cell.p > n0) return null;   // 홀수 패딩 빈 면
        const emb = (cell.r === 180 ? emb180 : emb0)[cell.p - 1];
        const x0 = side === 'L' ? mg.l : mg.l + slotW + gp.h;
        return drawPlaced(page, emb, { x: x0, y: mg.b, w: slotW, h: slotH }, opts);
      };

      const sides = opts.sides === 1 ? 1 : 2;
      const { sheets, n } = dup2upOrder(n0, sides);
      const slug = await prepSlug(out, opts);
      for (let i = 0; i < sheets.length; i++) {
        const { front, back } = sheets[i];
        const fp = out.addPage([sw, sh]);
        const ft = [drawCell(fp, front[0], 'L'), drawCell(fp, front[1], 'R')];
        if (opts.crop) ft.forEach(t => { if (t) drawCropMarks(fp, t.x, t.y, t.w, t.h); });
        drawSlug(fp, slug, i + 1, sheets.length, 'F');
        if (back) {   // 단면은 뒷면 없음
          const bp = out.addPage([sw, sh]);
          const bt = [drawCell(bp, back[0], 'L'), drawCell(bp, back[1], 'R')];
          if (opts.crop) bt.forEach(t => { if (t) drawCropMarks(bp, t.x, t.y, t.w, t.h); });
          drawSlug(bp, slug, i + 1, sheets.length, 'B');
        }
        if (onProgress) onProgress(45 + Math.round((i + 1) / sheets.length * 50));
        await uiYield();
      }
      if (onProgress) onProgress(98);
      const bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
      return { bytes, n0, n, sheets: sheets.length, sides };
    }

    async function generateDup2up() {
      if (_bkBusy) return;
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      _bkBusy = true;
      try {
        showLoading('복제 2-up — 최신 편집 상태 준비 중…');
        progressBar.style.display = 'block'; updateProgress(0);
        const srcBytes = await buildOptimizedBase(p => updateProgress(Math.round(p * 0.45)));
        showLoading('복제 2-up — 양면 2부 시트 조립 중…');
        const opts = currentImpOptions();
        const res = await buildDup2upBytes(srcBytes, opts, p => updateProgress(45 + Math.round(p * 0.55)));
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        // 결과를 화면에 바로 표시 (저장 다이얼로그 뒤에서 확인 가능)
        try { renderProcessedPreview(res.bytes); } catch (e) { console.warn('임포징 미리보기 실패:', e); }
        const base = effectiveBaseName();   // 챕터 삭제 후에는 남은 첫 챕터명
        const single = res.sides === 1;
        const outName = `${base}_2up${single ? '단면' : '양면'}.pdf`;
        adoptImposedResult(res.bytes, outName);
        let msg = single
          ? `📖 복제 2-up(단면 2부) 생성 완료 — 시트 ${res.sheets}장 (페이지당 1시트, 본문 ${res.n0}쪽)`
            + `\n인쇄: 가로 용지 · 단면 → 세로 재단 → 2部 완성 (오른쪽 部는 180° — 돌리면 정방향)`
            + `\n화면에 결과가 표시됩니다 — 저장은 메인 창의 '⇩ 다운로드' 버튼으로 진행하세요(임포징 반영본).`
          : `📖 복제 2-up(양면 2부) 생성 완료 — 시트 ${res.sheets}장 (양면 ${res.n}면, 본문 ${res.n0}쪽${res.n - res.n0 ? ` + 빈 면 ${res.n - res.n0}쪽` : ''})`
            + `\n인쇄: 가로 용지 · 양면 · '짧은 쪽 넘김' → 세로 재단 → 2部 완성 (오른쪽 部는 180° — 돌리면 정방향)`
            + `\n화면에 결과가 표시됩니다 — 저장은 메인 창의 '⇩ 다운로드' 버튼으로 진행하세요(임포징 반영본).`;
        if (opts.bleed > 0 && opts.gutter < opts.bleed * 2)
          msg += `\n⚠ 블리드(${opts.bleed}mm)가 거터(${opts.gutter}mm)의 절반보다 큽니다 — 거터를 ${opts.bleed * 2}mm 이상 권장`;
        showSuccess(msg);
      } catch (e) {
        console.error('복제 2-up 생성 오류:', e);
        showError('복제 2-up 생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; hideLoading(); progressBar.style.display = 'none';
      }
    }

    let _bkBusy = false;
    async function generateBooklet() {
      if (_bkBusy) return;
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      _bkBusy = true;
      try {
        showLoading('북클릿 임포징 — 최신 편집 상태 준비 중…');
        progressBar.style.display = 'block'; updateProgress(0);
        // 소스 = 최종 출력 파이프라인 결과 → 흑백·잉크 정규화·머리글/쪽번호까지 반영된 상태로 임포징
        const srcBytes = await buildOptimizedBase(p => updateProgress(Math.round(p * 0.45)));
        showLoading('북클릿 임포징 — 중철 시트 조립 중…');
        const opts = currentImpOptions();
        const res = await buildBookletBytes(srcBytes, opts, p => updateProgress(45 + Math.round(p * 0.55)));
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        try { renderProcessedPreview(res.bytes); } catch (e) { console.warn('임포징 미리보기 실패:', e); }
        const base = effectiveBaseName();   // 챕터 삭제 후에는 남은 첫 챕터명
        // 표지 분리: 맨 바깥 시트(표지 4면)와 내지를 별도 PDF 두 개로 저장 (표지 = 두꺼운 용지)
        if (document.getElementById('bkCoverSplit')?.checked) {
          if (res.sheets < 2) {
            showError('표지 분리는 시트가 2장 이상(본문 5쪽 이상)일 때 가능합니다 — 지금은 전체가 표지 1시트입니다.');
            return;
          }
          await saveBookletCoverSplit(res, base, opts);
          return;
        }
        const outName = `${base}_중철북클릿.pdf`;
        adoptImposedResult(res.bytes, outName);
        let msg = `📖 북클릿(중철) 생성 완료 — 시트 ${res.sheets}장 (양면 ${res.n / 2}면, 본문 ${res.n0}쪽 + 빈 면 ${res.n - res.n0}쪽)`
          + `\n인쇄 설정: 가로 용지 · 양면 인쇄 · '짧은 쪽 넘김'(short-edge) → 반 접어 중철 제본`
          + `\n화면에 결과가 표시됩니다 — 저장은 메인 창의 '⇩ 다운로드' 버튼으로 진행하세요(임포징 반영본).`;
        if (opts.bleed > 0 && opts.gutter < opts.bleed * 2)
          msg += `\n⚠ 블리드(${opts.bleed}mm)가 거터(${opts.gutter}mm)의 절반보다 큽니다 — 이웃 페이지와 겹칠 수 있으니 거터를 ${opts.bleed * 2}mm 이상으로 권장`;
        showSuccess(msg);
      } catch (e) {
        console.error('북클릿 생성 오류:', e);
        showError('북클릿 생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; hideLoading(); progressBar.style.display = 'none';
      }
    }

    // ── 중철 표지 분리 저장 ─────────────────────────────────────────────────────
    // 북클릿 결과에서 맨 바깥 시트(= 출력 1~2면: 겉표지 [뒤표지|앞표지] / 안쪽 [표2|표3])를
    // 표지 PDF로, 나머지 시트를 내지 PDF로 나눠 각각 저장한다.
    // 표지는 두꺼운 용지에 1장 양면, 내지는 본문 용지에 인쇄한 뒤 내지를 표지로 감싸 중철.
    async function splitBookletCover(bytes) {
      const src = await PDFLib.PDFDocument.load(bytes.slice ? bytes.slice(0) : bytes);
      const total = src.getPageCount();   // 시트당 앞/뒤 2면
      const make = async idxs => {
        const d = await PDFLib.PDFDocument.create();
        (await d.copyPages(src, idxs)).forEach(p => d.addPage(p));
        return d.save({ useObjectStreams: false, updateFieldAppearances: false });
      };
      const cover = await make([0, 1]);
      const inner = await make(Array.from({ length: total - 2 }, (_, i) => i + 2));
      return { cover, inner };
    }
    async function saveBookletCoverSplit(res, base, opts) {
      showLoading('표지/내지 분리 중…');
      const { cover, inner } = await splitBookletCover(res.bytes);
      hideLoading();
      const savedCover = await window.electronAPI.saveFile({ defaultName: `${base}_중철_표지.pdf`, buffer: cover });
      const savedInner = await window.electronAPI.saveFile({ defaultName: `${base}_중철_내지.pdf`, buffer: inner });
      if (!savedCover && !savedInner) return;   // 둘 다 취소
      setImpGenDone(true);
      let msg = `📕 중철 표지 분리 저장 완료 — 표지 1시트(양면 2면: 겉면 [뒤표지|앞표지] / 안쪽 [표2|표3])`
        + ` + 내지 ${res.sheets - 1}시트 (본문 ${res.n0}쪽 + 빈 면 ${res.n - res.n0}쪽)`
        + `\n인쇄: 표지 = 두꺼운 표지 용지 1장 · 양면 · 짧은 쪽 넘김 / 내지 = 본문 용지 · 양면 · 짧은 쪽 넘김`
        + `\n제작: 내지를 반 접어 순서대로 겹치고 → 표지로 감싸 → 중철(스테이플) → 삼면 재단`;
      if (!savedCover) msg += `\n⚠ 표지 저장은 취소되었습니다 — 내지만 저장됨`;
      if (!savedInner) msg += `\n⚠ 내지 저장은 취소되었습니다 — 표지만 저장됨`;
      if (opts.creep > 0) msg += `\n밀림보정 ${opts.creep}mm/장이 내지 안쪽 시트에 반영되어 있습니다.`;
      if (opts.bleed > 0 && opts.gutter < opts.bleed * 2)
        msg += `\n⚠ 블리드(${opts.bleed}mm)가 거터(${opts.gutter}mm)의 절반보다 큽니다 — 거터를 ${opts.bleed * 2}mm 이상 권장`;
      showSuccess(msg);
    }

    // 모아찍기(nup)·정합(cutstack) 공통 생성 — buildNupBytes 사용(메인 파이프라인과 동일 빌더)
    async function generateNup() {
      if (_bkBusy) return;
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      _bkBusy = true;
      try {
        const opts = currentImpOptions();
        const isCut = opts.mode === 'cutstack';
        showLoading(`${isCut ? '정합(Cut&Stack)' : '모아찍기(N-up)'} — 최신 편집 상태 준비 중…`);
        progressBar.style.display = 'block'; updateProgress(0);
        const srcBytes = await buildOptimizedBase(p => updateProgress(Math.round(p * 0.45)));
        showLoading(`${isCut ? '정합' : '모아찍기'} — 시트 조립 중…`);
        const res = await buildNupBytes(srcBytes, opts, p => updateProgress(45 + Math.round(p * 0.55)));
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        try { renderProcessedPreview(res.bytes); } catch (e) { console.warn('임포징 미리보기 실패:', e); }
        const base = effectiveBaseName();   // 챕터 삭제 후에는 남은 첫 챕터명
        const grid = `${res.across}x${res.down}`;
        const outName = `${base}_${isCut ? '1up' : '모아찍기'}${grid}${res.sides === 2 ? '양면' : '단면'}.pdf`;
        adoptImposedResult(res.bytes, outName);
        let msg = `📖 ${isCut ? '정합(Cut&Stack)' : '모아찍기(N-up)'} 생성 완료 — 시트 ${res.sheets}장 · ${grid} 배치(칸당 ${res.per}쪽) · ${res.sides === 2 ? '양면' : '단면'} (본문 ${res.n0}쪽)`
          + (isCut ? `\n인쇄 → 재단 → 좌상 묶음부터 차례로 겹치면 페이지 순서 완성` : `\n연속 페이지가 좌→우·상→하로 배치됩니다`)
          + `\n화면에 결과가 표시됩니다 — 저장은 메인 창의 '⇩ 다운로드' 버튼으로 진행하세요(임포징 반영본).`;
        showSuccess(msg);
      } catch (e) {
        console.error('모아찍기/정합 생성 오류:', e);
        showError('생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; hideLoading(); progressBar.style.display = 'none';
      }
    }

    // ── 임포징 프로파일 시드 (Quite Imposing Plus 5 sequences.xml에서 추출한 71종) ──
    // 최초 실행 시 localStorage 'impProfiles'로 복사되며, 이후 사용자가 수정·삭제·추가한다.
    const IMP_PROFILE_SEED = [{"n":"A4_단면_2up_312-438_좌우끝단","m":"dup","sd":1,"ax":2,"dn":1,"sw":438,"sh":312,"ml":0,"mt":0,"mr":0,"mb":0,"hg":16,"vg":16,"sc":"fit","al":"cc","cr":1},{"n":"16:9_3슬1페_A4","m":"nup","ax":1,"dn":3,"sw":210,"sh":297,"ml":10,"mt":10,"mr":10,"mb":10,"sc":"fit","al":"cc","fr":1},{"n":"A4_양면_2up","m":"dup","sd":2,"ax":2,"dn":1,"sw":297,"sh":420,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"8K_양면_2up","m":"dup","sd":2,"ax":2,"dn":1,"sw":388,"sh":267,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"8K_단면_2up","m":"dup","sd":1,"ax":2,"dn":1,"sw":388,"sh":267,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"A4_단면_1up","m":"cutstack","sd":1,"ax":2,"dn":1,"sc":"fit","al":"cc"},{"n":"8K_양면_1up","m":"cutstack","sd":2,"ax":2,"dn":1,"sw":388,"sh":267,"sc":"fit","al":"cc"},{"n":"16k_2슬1페","m":"nup","ax":1,"dn":2,"sw":194,"sh":267,"ml":12,"mt":12,"mr":12,"mb":12,"sc":"fit","al":"cc","fr":1},{"n":"270-390_양면_1up_컷앤스택_중앙정렬","m":"cutstack","sd":2,"ax":2,"dn":1,"sc":"fit","al":"cc","pw":270,"ph":390},{"n":"A4_양면_중철_312-438","m":"booklet","sd":2,"mg":3,"sc":"fit","al":"cc","cr":1,"pw":438,"ph":312},{"n":"A4_단면_2up","m":"dup","sd":1,"ax":2,"dn":1,"sw":297,"sh":420,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"16:9_2슬1페_A4","m":"nup","ax":1,"dn":2,"sw":210,"sh":297,"ml":12,"mt":12,"mr":12,"mb":12,"hg":40,"vg":40,"sc":"fit","al":"cc","fr":1},{"n":"4:3_2슬1페_A4","m":"nup","ax":1,"dn":2,"sw":210,"sh":297,"ml":16,"mt":16,"mr":16,"mb":16,"sc":"fit","al":"cc","fr":1},{"n":"A4_양면_2up_312-438_중앙정렬","m":"dup","sd":2,"ax":2,"dn":1,"sw":438,"sh":312,"ml":4.5,"mt":4.5,"mr":4.5,"mb":4.5,"hg":8,"vg":8,"sc":"fit","al":"cc","cr":1},{"n":"A4_단면_2up_312-438_중앙정렬","m":"dup","sd":1,"ax":2,"dn":1,"sw":438,"sh":312,"ml":4.5,"mt":4.5,"mr":4.5,"mb":4.5,"hg":8,"vg":8,"sc":"fit","al":"cc","cr":1},{"n":"270-390_양면_2up_가운데 여백90(A5용 책자)","m":"dup","sd":2,"ax":2,"dn":1,"sw":270,"sh":390,"ml":0,"mt":0,"mr":0,"mb":0,"hg":90,"vg":90,"sc":"fit","al":"cc","cr":1},{"n":"양면_1up_컷앤스택_100%","m":"cutstack","sd":2,"ax":2,"dn":1,"sc":"fit","al":"cc"},{"n":"표지_앞뒤연결_Impose","m":"nup","ax":1,"dn":1,"sw":465,"sh":315,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc","cr":1},{"n":"270-390_양면_1up_컷앤스택","m":"cutstack","sd":2,"ax":2,"dn":1,"sw":390,"sh":270,"sc":"orig","al":"cc"},{"n":"8K_양면_3up","m":"cutstack","sd":2,"ax":3,"dn":1,"sw":388,"sh":267,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"270-390_양면_2up","m":"dup","sd":2,"ax":2,"dn":1,"sw":270,"sh":390,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"A4_확대100.5_블리드0.4_재단선_컷앤스택_311-438","m":"cutstack","sd":2,"ax":2,"dn":1,"sw":438,"sh":311,"bl":0.4,"cr":1,"sc":"fit","al":"cc","pw":218,"ph":312},{"n":"A4_확대100.5_블리드0.4_재단선_중철_311-438","m":"booklet","sd":2,"sw":438,"sh":311,"bl":0.4,"cr":1,"sc":"fit","al":"cc","pw":218,"ph":312},{"n":"270-390_단면_2up","m":"dup","sd":1,"ax":2,"dn":1,"sw":270,"sh":390,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"270-390_양면_2up_가운데 여백4","m":"dup","sd":2,"ax":2,"dn":1,"sw":270,"sh":390,"ml":0,"mt":0,"mr":0,"mb":0,"hg":4,"sc":"fit","al":"cc"},{"n":"230-315 to A4(center position)","m":"nup","ax":1,"dn":1,"sw":230,"sh":315,"ml":5,"mt":5,"mr":5,"mb":5,"sc":"fit","al":"cc","cr":1},{"n":"218-312_양면_1up_센터_컷앤스택_100%","m":"cutstack","sd":2,"ax":2,"dn":1,"sc":"fit","al":"cc","pw":218,"ph":312},{"n":"218-312_단면_2up_센터정렬","m":"dup","sd":1,"ax":2,"dn":1,"sw":438,"sh":312,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc","pw":218,"ph":312},{"n":"218-312_양면_2up_센터","m":"dup","sd":2,"ax":2,"dn":1,"sw":297,"sh":420,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc","pw":218,"ph":312},{"n":"A4_양면_2up_312-438_좌우끝단맞춤","m":"dup","sd":2,"ax":2,"dn":1,"sw":438,"sh":312,"ml":0,"mt":0,"mr":0,"mb":0,"hg":16,"vg":16,"sc":"fit","al":"cc"},{"n":"포스터_315-465","m":"nup","ax":1,"dn":1,"sw":315,"sh":465,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc","cr":1,"pw":305,"ph":455},{"n":"포스터_A1+(609-914)","m":"nup","ax":2,"dn":2,"sw":609,"sh":914,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc","cr":1,"pw":420,"ph":594},{"n":"A4_단면_2up_312-438","m":"dup","sd":1,"ax":2,"dn":1,"sw":438,"sh":312,"ml":0,"mt":0,"mr":0,"mb":0,"hg":18,"vg":18,"sc":"fit","al":"cc","cr":1},{"n":"A4_단면_1up_312-438","m":"cutstack","sd":1,"ax":2,"dn":1,"sw":438,"sh":312,"sc":"orig","al":"cc","cr":1},{"n":"포스터_A3_(315-465 센터)","m":"nup","ax":1,"dn":1,"sw":315,"sh":465,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc","cr":1,"pw":305,"ph":455},{"n":"270-390_양면_2up_가운데 여백8","m":"dup","sd":2,"ax":2,"dn":1,"sw":270,"sh":390,"ml":0,"mt":0,"mr":0,"mb":0,"hg":8,"vg":8,"sc":"fit","al":"cc"},{"n":"270-390_단면_2up_중앙여백8","m":"dup","sd":1,"ax":2,"dn":1,"sw":270,"sh":390,"ml":0,"mt":0,"mr":0,"mb":0,"hg":8,"vg":8,"sc":"fit","al":"cc"},{"n":"PEER OFF","m":"nup","sc":"fit","al":"cc"},{"n":"포스터_A2_430-610_센터_재단선","m":"nup","ax":1,"dn":1,"sw":430,"sh":610,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc","fr":1},{"n":"PEER PAGE","m":"nup","sc":"fit","al":"cc"},{"n":"미싱티켓","m":"cutstack","ax":3,"dn":4,"sw":315,"sh":468,"ml":3,"mt":9.5,"mr":3,"mb":9.5,"sc":"fit","al":"tl"},{"n":"미싱티켓_194-74","m":"cutstack","ax":2,"dn":4,"sw":315,"sh":390,"ml":3,"mt":9.5,"mr":3,"mb":9.5,"sc":"fit","al":"tl"},{"n":"미싱티켓_184-64","m":"cutstack","ax":2,"dn":4,"sw":315,"sh":390,"ml":2,"mt":2,"mr":2,"mb":2,"hg":2,"vg":2,"sc":"fit","al":"cc","cr":1},{"n":"A2_2up_914-608","m":"nup","ax":3,"dn":3,"sw":609,"sh":914,"ml":5,"mt":5,"mr":5,"mb":5,"hg":3,"vg":3,"sc":"fit","al":"cc","fr":1},{"n":"포스터_A1+(609-914)_A2 2up","m":"nup","ax":2,"dn":2,"sw":609,"sh":914,"ml":0,"mt":0,"mr":0,"mb":0,"hg":10,"vg":10,"sc":"fit","al":"cc","fr":1,"pw":420,"ph":594},{"n":"A4_양면_2up_311-438_좌우끝단맞춤","m":"dup","sd":2,"ax":2,"dn":1,"sw":438,"sh":311,"ml":0,"mt":0,"mr":0,"mb":0,"hg":16,"vg":16,"sc":"fit","al":"cc"},{"n":"90-75_양면_2up_대지_A4","m":"dup","sd":2,"ax":1,"dn":2,"sw":210,"sh":297,"ml":10,"mt":10,"mr":10,"mb":10,"hg":10,"vg":10,"sc":"fit","al":"cc"},{"n":"A5_양면_2up_대지_A4","m":"cutstack","sd":2,"ax":1,"dn":2,"sw":210,"sh":297,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"8K_양면_1up_Cut&Stack","m":"cutstack","sd":2,"ax":2,"dn":1,"sc":"fit","al":"cc"},{"n":"A5_양면_1up_Cut&Stack","m":"cutstack","sd":2,"ax":2,"dn":1,"sc":"fit","al":"cc"},{"n":"315-390_양면_2up 상하","m":"cutstack","sd":2,"ax":1,"dn":2,"sw":315,"sh":390,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"A4_양면_2up_315-465_좌우끝단맞춤","m":"dup","sd":2,"ax":2,"dn":1,"sw":465,"sh":315,"ml":0,"mt":0,"mr":0,"mb":0,"hg":41,"vg":41,"sc":"fit","al":"cc"},{"n":"270-390_양면_2up_가운데 여백26(B5좌우끝단)","m":"dup","sd":2,"ax":2,"dn":1,"sw":270,"sh":390,"ml":0,"mt":0,"mr":0,"mb":0,"hg":24,"vg":24,"sc":"fit","al":"cc"},{"n":"257-364(B4)_양면_2up","m":"dup","sd":2,"ax":2,"dn":1,"sw":257,"sh":364,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"16:9_2슬1페_A4_여백15","m":"nup","ax":1,"dn":2,"sw":210,"sh":297,"ml":15,"mt":0,"mr":15,"mb":0,"hg":40,"vg":40,"sc":"fit","al":"cc","fr":1},{"n":"16:9_2슬1페_A4_여백15_슬라이드 붙여서","m":"nup","ax":1,"dn":2,"sw":210,"sh":297,"ml":15,"mt":0,"mr":15,"mb":0,"sc":"fit","al":"cc","fr":1,"pw":152,"ph":210},{"n":"A4_3s-1p","m":"nup","ax":1,"dn":3,"sw":210,"sh":297,"ml":12,"mt":12,"mr":12,"mb":12,"sc":"fit","al":"cc","fr":1},{"n":"A4_2s-1p","m":"nup","ax":1,"dn":2,"sw":210,"sh":297,"ml":12,"mt":12,"mr":12,"mb":12,"sc":"fit","al":"cc","fr":1},{"n":"8K_단면_1up","m":"cutstack","sd":1,"ax":2,"dn":1,"sw":388,"sh":267,"sc":"orig","al":"cc"},{"n":"A4_양면_2up_315-465","m":"dup","sd":2,"ax":2,"dn":1,"sw":315,"sh":465,"ml":5,"mt":5,"mr":5,"mb":5,"sc":"fit","al":"cc","cr":1},{"n":"A4_단면_1up_315-465","m":"cutstack","sd":1,"ax":2,"dn":1,"sw":465,"sh":315,"sc":"orig","al":"cc","cr":1},{"n":"A4_4s-1p","m":"nup","ax":2,"dn":2,"sw":210,"sh":297,"ml":10,"mt":10,"mr":10,"mb":10,"hg":5,"vg":5,"sc":"fit","al":"cc","fr":1},{"n":"두페이지 붙이기","m":"nup","sc":"fit","al":"cc"},{"n":"앞뒤표지_Impose","m":"nup","ax":1,"dn":1,"sw":465,"sh":315,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc","cr":1},{"n":"A5양면_2up","m":"dup","sd":2,"ax":2,"dn":1,"sw":230,"sh":315,"ml":3,"mt":3,"mr":3,"mb":3,"hg":3,"vg":3,"sc":"fit","al":"cc","cr":1},{"n":"포스터_A1+_센터_테두리(604-851)","m":"nup","ax":1,"dn":1,"sw":604,"sh":851,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc","fr":1},{"n":"A4_여백없는 원고 여백 늘리기(축소후 센터 앉히기)","m":"nup","sc":"fit","al":"cc"},{"n":"A4_양면_2up_315-465_좌우끝단_4미리씩 여백줌","m":"dup","sd":2,"ax":2,"dn":1,"sw":465,"sh":315,"ml":0,"mt":0,"mr":0,"mb":0,"hg":33,"vg":33,"sc":"fit","al":"cc"},{"n":"A4_단면_2up_315-465_좌우끝단","m":"dup","sd":1,"ax":2,"dn":1,"sw":465,"sh":315,"ml":0,"mt":0,"mr":0,"mb":0,"hg":40,"vg":40,"sc":"fit","al":"cc","cr":1},{"n":"270-390_양면_2up_논문","m":"dup","sd":2,"ax":2,"dn":1,"sw":270,"sh":390,"ml":0,"mt":0,"mr":0,"mb":0,"sc":"fit","al":"cc"},{"n":"8K_양면_1up_Cut&Stack_A5원고 2판","m":"cutstack","sd":2,"ax":2,"dn":1,"sw":390,"sh":270,"sc":"orig","al":"cc","cr":1}];
    // ── 임포징 프로파일 저장소 (localStorage 'impProfiles') ──────────────────────
    // 최초 실행 시 IMP_PROFILE_SEED(첨부 sequences.xml에서 추출)로 초기화. 이후 CRUD.
    // QI 원본(qiplusmemory5.xml) 대조로 매핑을 바로잡은 이름들 — SimpleBooklet(Paginate=CutStacks)
    // 시퀀스가 중철(booklet)로 잘못 저장돼 있던 항목. 기존 localStorage에 옛 매핑이 남아 있으면
    // 1회에 한해 새 시드 값으로 교체한다(사용자가 추가한 다른 프로파일은 건드리지 않음).
    const IMP_QI_FIX_NAMES = ['A4_단면_1up', '8K_양면_1up', '270-390_양면_1up_컷앤스택_중앙정렬',
      '양면_1up_컷앤스택_100%', '270-390_양면_1up_컷앤스택',
      'A4_확대100.5_블리드0.4_재단선_컷앤스택_311-438', 'A4_확대100.5_블리드0.4_재단선_중철_311-438',
      '218-312_양면_1up_센터_컷앤스택_100%', 'A4_단면_1up_312-438', '8K_양면_1up_Cut&Stack',
      'A5_양면_1up_Cut&Stack', '8K_단면_1up', 'A4_단면_1up_315-465', '8K_양면_1up_Cut&Stack_A5원고 2판'];
    function migrateImpProfiles(list) {
      try {
        if (localStorage.getItem('impProfilesFixQI1')) return list;
        const byName = new Map(IMP_PROFILE_SEED.map(p => [p.n, p]));
        IMP_QI_FIX_NAMES.forEach(n => {
          const at = list.findIndex(x => x && x.n === n);
          if (at >= 0 && byName.has(n)) list[at] = Object.assign({}, byName.get(n));
        });
        localStorage.setItem('impProfiles', JSON.stringify(list));
        localStorage.setItem('impProfilesFixQI1', '1');
      } catch (e) {}
      return list;
    }
    function loadImpProfiles() {
      try { const a = JSON.parse(localStorage.getItem('impProfiles')); if (Array.isArray(a)) return migrateImpProfiles(a); } catch (e) {}
      const seed = IMP_PROFILE_SEED.map(p => Object.assign({}, p));
      try { localStorage.setItem('impProfiles', JSON.stringify(seed)); localStorage.setItem('impProfilesFixQI1', '1'); } catch (e) {}
      return seed;
    }
    function saveImpProfiles(list) { try { localStorage.setItem('impProfiles', JSON.stringify(list)); } catch (e) {} }
    // 시드 프로파일(p) → 빌더가 그대로 소비하는 정규화 옵션. 저장값은 mm, 시트는 pt로 변환.
    function profileToOpts(p) {
      const MM = 72 / 25.4;
      const margin = p.mg != null ? p.mg : { l: p.ml || 0, t: p.mt || 0, r: p.mr || 0, b: p.mb || 0 };
      return {
        mode: p.m, sides: p.sd,
        across: p.ax || 1, down: p.dn || 1,
        sheet: (p.sw && p.sh) ? [p.sw * MM, p.sh * MM] : null,
        margin, hgap: p.hg || 0, vgap: p.vg || 0, gutter: p.hg || 0,
        bleed: p.bl || 0, crop: !!p.cr, frame: !!p.fr,
        creep: 0, binding: p.bd === 'right' ? 'right' : 'left',
        order: p.m === 'cutstack' ? 'cutstack' : 'sequential',
        cols: p.ax || 0, rows: p.dn || 0,
        place: { scale: p.sc || 'fit', fixedScale: p.fx, align: p.al || 'cc', offX: p.ox || 0, offY: p.oy || 0 },
        paper: (p.sw && p.sh) ? `${p.sw}×${p.sh}mm` : 'auto',
        _profName: p.n,
      };
    }
    // 프로파일 드롭다운 채우기 (keep = 유지할 선택값)
    function populateImpProfiles(keep) {
      const sel = document.getElementById('impProfile');
      if (!sel) return;
      const cur = keep !== undefined ? keep : sel.value;
      const list = loadImpProfiles();
      sel.innerHTML = '<option value="">— 프로파일 선택 —</option>'
        + list.map((p, i) => `<option value="${i}">${String(p.n).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}</option>`).join('');
      if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
      if (typeof impProfileListVisible === 'function' && impProfileListVisible()) renderImpProfileList();
    }
    // 프로파일(p) → 임포징 UI 컨트롤 전부 반영 (모드·용지·그리드·여백·정렬 등).
    // 시트가 있으면 '사용자 지정'으로 W×H를 채워 편집·표시 가능하게 한다. (_loadingProfile 가드)
    function applyProfileToUI(p) {
      _loadingProfile = true;
      try {
        const g = id => document.getElementById(id);
        setImpMode(p.m);                       // 모드 칩 + 행 표시 갱신
        _impScale = p.sc || 'fit';
        document.querySelectorAll('#impScaleGroup .es-chip').forEach(b => b.classList.toggle('active', b.dataset.scale === _impScale));
        // 용지: 시트 크기가 있으면 '사용자 지정' 직접입력으로 펼쳐 편집 가능
        if (p.sw && p.sh) {
          if (g('bkPaper')) g('bkPaper').value = '__custom__';
          if (g('impCustomW')) g('impCustomW').value = p.sw;
          if (g('impCustomH')) g('impCustomH').value = p.sh;
          if (g('impCustomRow')) g('impCustomRow').style.display = '';
        } else {
          if (g('bkPaper')) g('bkPaper').value = 'auto';
          if (g('impCustomRow')) g('impCustomRow').style.display = 'none';
        }
        if (g('impAcross')) g('impAcross').value = p.ax || 1;
        if (g('impDown'))   g('impDown').value   = p.dn || 1;
        if (g('impAlign'))  g('impAlign').value  = p.al || 'cc';
        if (g('impOffX'))   g('impOffX').value   = p.ox || 0;
        if (g('impOffY'))   g('impOffY').value   = p.oy || 0;
        if (g('impFixed'))  g('impFixed').value  = p.fx != null ? (p.fx * 100).toFixed(1) : 100;
        if (g('impMargin')) g('impMargin').value = p.mg != null ? p.mg : (p.ml || 0);
        if (g('bkGutter'))  g('bkGutter').value  = p.hg || 0;
        if (g('impBleed'))  g('impBleed').value  = p.bl || 0;
        if (g('impCrop'))   g('impCrop').checked = !!p.cr;
        if (g('impFrame'))  g('impFrame').checked = !!p.fr;
        if (g('impSlug'))   g('impSlug').checked = !!p.sl;
        if (g('impStackNum')) g('impStackNum').checked = !!p.sn;
        if (p.sd) { _cutSides = p.sd; document.querySelectorAll('#cutSidesGroup .es-chip').forEach(b => b.classList.toggle('active', +b.dataset.sides === p.sd)); }
        if (p.m === 'booklet') { _bkBind = p.bd === 'right' ? 'right' : 'left'; document.querySelectorAll('#bkBindGroup .es-chip').forEach(b => b.classList.toggle('active', b.dataset.bind === _bkBind)); }
        updateImpSheetReadout();
      } finally { _loadingProfile = false; }
    }
    // 드롭다운에서 프로파일을 선택하는 즉시 자동 적용 (빈 '— 프로파일 선택 —'은 무시)
    function onImpProfileChange() {
      const sel = document.getElementById('impProfile');
      if (!sel || sel.value === '') return;
      loadImpProfile();
      if (typeof impProfileListVisible === 'function' && impProfileListVisible()) renderImpProfileList();   // 목록 하이라이트 동기화
    }
    // 프리셋 불러오기 — 정규화 옵션을 _impProfile에 담아 그대로 재현 + UI 반영, 임포징 포함 ON.
    function loadImpProfile() {
      const sel = document.getElementById('impProfile');
      const idx = sel && sel.value !== '' ? parseInt(sel.value) : -1;
      const list = loadImpProfiles();
      if (idx < 0 || !list[idx]) { showError('불러올 프리셋을 선택하세요.'); return; }
      const p = list[idx];
      applyProfileToUI(p);
      _impProfile = profileToOpts(p);          // 정확 재현 (UI를 만지기 전까지)
      // 프리셋은 '옵션만' 세팅한다 — 시트 재조립(편집 적용)은 사용자가
      // '📖 임포징 PDF 생성'이나 메인 '✔ 적용'을 눌러야 진행(자동 미리보기·재조립 안 함).
      _impEnabled = true;
      const chk = document.getElementById('impEnabled'); if (chk) chk.checked = true;
      invalidateProcessed();                   // '적용 필요' 표시만 (렌더 없음)
      showSuccess(`프리셋 '${p.n}' 불러옴 — 용지 ${_impProfile.paper}, ${p.m}${p.sd ? (p.sd === 2 ? ' 양면' : ' 단면') : ''}. 옵션만 적용됨 — '📖 임포징 PDF 생성' 또는 메인 '✔ 적용'을 눌러 반영하세요.`);
    }
    // 프리셋 수정 — 선택 프리셋의 내부 항목을 UI 컨트롤에 펼쳐 직접 편집.
    // 이름칸에 이름을 채워두고 _impProfile은 비워 UI 기준으로 전환(편집 후 '💾 저장'으로 반영).
    function impProfileEdit() {
      const sel = document.getElementById('impProfile');
      const idx = sel && sel.value !== '' ? parseInt(sel.value) : -1;
      const list = loadImpProfiles();
      if (idx < 0 || !list[idx]) { showError('수정할 프리셋을 목록에서 선택하세요.'); return; }
      const p = list[idx];
      applyProfileToUI(p);
      _impProfile = null;                      // UI 기준 편집 모드
      const nm = document.getElementById('impProfName'); if (nm) nm.value = p.n;
      // 옵션만 펼쳐 편집 상태로 둔다 — 시트 재조립은 '📖 임포징 PDF 생성'·'✔ 적용'에서만.
      _impEnabled = true;
      const chk = document.getElementById('impEnabled'); if (chk) chk.checked = true;
      invalidateProcessed();                   // '적용 필요' 표시만 (렌더 없음)
      showSuccess(`프리셋 '${p.n}' 편집 모드 — 모드·용지·그리드·여백·정렬 등을 아래에서 수정한 뒤 '💾 저장'을 누르면 같은 이름으로 덮어써집니다.`);
    }
    // ── 프리셋 내보내기 / 가져오기 (독립 임포징 도구와 JSON으로 동기화) ──────
    function impProfileExport() {
      const list = loadImpProfiles();
      if (!list.length) { showError('내보낼 프리셋이 없습니다.'); return; }
      const json = JSON.stringify(list, null, 2);
      (async () => {
        try {
          const saved = await window.electronAPI.saveFile({ defaultName: 'imposition-profiles.json', buffer: new TextEncoder().encode(json) });
          if (saved) showSuccess(`프리셋 ${list.length}개를 내보냈습니다 (imposition-profiles.json). 독립 임포징 도구(dist/임포징도구.html)의 '⬇ 가져오기'로 불러오면 동기화됩니다.`);
        } catch (e) { showError('내보내기 실패: ' + (e && e.message ? e.message : String(e))); }
      })();
    }
    function impProfileImportClick() {
      const inp = document.getElementById('impProfImportFile');
      if (inp) { inp.value = ''; inp.click(); }
    }
    // 가져온 프리셋 배열을 병합(같은 이름 덮어쓰기, 새 이름 추가)
    function impProfileImportFile(input) {
      const f = input && input.files && input.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const arr = JSON.parse(rd.result);
          if (!Array.isArray(arr)) throw new Error('프리셋 JSON(배열) 형식이 아닙니다.');
          const valid = arr.filter(p => p && typeof p.n === 'string' && typeof p.m === 'string');
          if (!valid.length) throw new Error('유효한 프리셋이 없습니다.');
          const list = loadImpProfiles();
          let added = 0, updated = 0;
          valid.forEach(p => {
            const at = list.findIndex(x => x.n === p.n);
            if (at >= 0) { list[at] = p; updated++; } else { list.push(p); added++; }
          });
          saveImpProfiles(list);
          populateImpProfiles('');
          if (typeof impProfileListVisible === 'function' && impProfileListVisible()) renderImpProfileList();
          showSuccess(`프리셋 가져오기 완료 — 추가 ${added}개 · 갱신 ${updated}개 (현재 총 ${list.length}개).`);
        } catch (e) { showError('가져오기 실패: ' + (e && e.message ? e.message : String(e))); }
      };
      rd.onerror = () => showError('파일을 읽지 못했습니다.');
      rd.readAsText(f);
    }
    // 현재 UI 설정 → 시드 객체 (저장용)
    function captureImpSeed(name) {
      const g = id => document.getElementById(id);
      const paperVal = g('bkPaper')?.value || 'auto';
      const sheet = resolveImpPaper(paperVal, null);
      const MM = 72 / 25.4;
      const s = { n: name, m: _impMode, sc: _impScale, al: g('impAlign')?.value || 'cc' };
      if (sheet) { s.sw = +(sheet[0] / MM).toFixed(1); s.sh = +(sheet[1] / MM).toFixed(1); }   // pt → mm
      const mg = parseFloat(g('impMargin')?.value) || 0; if (mg) s.mg = mg;
      const hg = parseFloat(g('bkGutter')?.value) || 0; if (hg) { s.hg = hg; s.vg = hg; }
      const bl = parseFloat(g('impBleed')?.value) || 0; if (bl) s.bl = bl;
      if (g('impCrop')?.checked) s.cr = 1;
      if (g('impFrame')?.checked) s.fr = 1;
      if (g('impSlug')?.checked) s.sl = 1;
      if (_impMode === 'cutstack' && g('impStackNum')?.checked) s.sn = 1;
      if (_impScale === 'fixed') s.fx = (parseFloat(g('impFixed')?.value) || 100) / 100;
      if (_impMode === 'nup' || _impMode === 'cutstack') { s.ax = parseInt(g('impAcross')?.value) || 1; s.dn = parseInt(g('impDown')?.value) || 1; }
      if (_impMode === 'nup' || _impMode === 'cutstack' || _impMode === 'dup' || _impMode === 'booklet') s.sd = _cutSides;
      const ox = parseFloat(g('impOffX')?.value) || 0; if (ox) s.ox = ox;
      const oy = parseFloat(g('impOffY')?.value) || 0; if (oy) s.oy = oy;
      if (_impMode === 'booklet' && _bkBind === 'right') s.bd = 'right';
      return s;
    }
    // 저장 — 이름칸 기준 업서트: 같은 이름이 있으면 덮어쓰기(수정), 없으면 신규 추가.
    function impProfileSave() {
      const name = (document.getElementById('impProfName')?.value || '').trim();
      if (!name) { showError('저장할 프리셋 이름을 입력하세요.'); return; }
      const list = loadImpProfiles();
      const at = list.findIndex(p => p.n === name);
      if (at >= 0) {
        if (!confirm(`같은 이름의 프리셋 '${name}'이(가) 있습니다 — 현재 설정으로 덮어쓸까요?`)) return;
        list[at] = captureImpSeed(name);
        saveImpProfiles(list); populateImpProfiles(String(at));
        showSuccess(`프리셋 '${name}'을(를) 현재 설정으로 수정(덮어쓰기)했습니다.`);
      } else {
        list.push(captureImpSeed(name));
        saveImpProfiles(list); populateImpProfiles(String(list.length - 1));
        showSuccess(`프리셋 '${name}'을(를) 새로 저장했습니다. 프리셋 목록에서 불러올 수 있습니다.`);
      }
    }
    // 프리셋 목록 순서 변경 — dir: -1(위로) / +1(아래로). 선택 유지.
    // ── 프리셋 목록 관리 (전체 목록을 한눈에 — 순서변경·이름변경·삭제·선택) ──────
    const _impModeLabel = m => ({ booklet: '중철', nup: '모아찍기', cutstack: '정합', repeat: '반복', dup: '복제2부' }[m] || m || '?');
    function impProfileListVisible() {
      const box = document.getElementById('impProfileList');
      return box && box.style.display !== 'none';
    }
    function toggleImpProfileList() {
      const box = document.getElementById('impProfileList');
      if (!box) return;
      const show = box.style.display === 'none' || !box.style.display;
      box.style.display = show ? '' : 'none';
      const btn = document.getElementById('impListToggleBtn');
      if (btn) btn.classList.toggle('active', show);
      if (show) renderImpProfileList();
    }
    function renderImpProfileList() {
      const box = document.getElementById('impProfileList');
      if (!box) return;
      const list = loadImpProfiles();
      const sel = document.getElementById('impProfile');
      const curIdx = sel && sel.value !== '' ? parseInt(sel.value) : -1;
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      box.innerHTML = list.length ? list.map((p, i) => {
        const size = (p.sw && p.sh) ? `${p.sw}×${p.sh}` : '자동';
        const meta = `${_impModeLabel(p.m)}${p.sd ? (p.sd === 2 ? '·양면' : '·단면') : ''} · ${size}`;
        return `<div class="imp-prof-row${i === curIdx ? ' sel' : ''}" data-idx="${i}" draggable="true">
          <span class="imp-prof-drag" title="드래그하여 순서 이동">⠿</span>
          <span class="imp-prof-ord">${i + 1}</span>
          <span class="imp-prof-name" title="클릭: 즉시 적용 · 더블클릭: 이름변경" onclick="impListSelect(${i})" ondblclick="impListRename(${i})">${esc(p.n)}</span>
          <span class="imp-prof-meta">${esc(meta)}</span>
          <button class="imp-prof-b" onclick="impListMove(${i},-1)" title="위로"${i === 0 ? ' disabled' : ''}>▲</button>
          <button class="imp-prof-b" onclick="impListMove(${i},1)" title="아래로"${i === list.length - 1 ? ' disabled' : ''}>▼</button>
          <button class="imp-prof-b" onclick="impListRename(${i})" title="이름 변경">✎</button>
          <button class="imp-prof-b" onclick="impListDelete(${i})" title="삭제">🗑</button>
        </div>`;
      }).join('') : '<div class="es-hint" style="padding:10px;">저장된 프리셋이 없습니다. 아래에서 설정 후 이름을 넣고 💾 저장하세요.</div>';
      _bindImpListDnD(box);
    }
    // ── 프리셋 목록 마우스 드래그 순서변경 (HTML5 DnD, 컨테이너 위임 1회 바인딩) ──
    let _impDragIdx = -1;
    function _bindImpListDnD(box) {
      if (!box || box._dndBound) return;
      box._dndBound = true;
      const clearMarks = () => box.querySelectorAll('.imp-prof-row').forEach(r => r.classList.remove('drop-above', 'drop-below', 'dragging'));
      box.addEventListener('dragstart', e => {
        const row = e.target.closest && e.target.closest('.imp-prof-row');
        if (!row) return;
        _impDragIdx = parseInt(row.dataset.idx);
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(_impDragIdx)); } catch (x) {}
        row.classList.add('dragging');
      });
      box.addEventListener('dragover', e => {
        const row = e.target.closest && e.target.closest('.imp-prof-row');
        if (!row || _impDragIdx < 0) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        box.querySelectorAll('.imp-prof-row').forEach(r => r.classList.remove('drop-above', 'drop-below'));
        row.classList.add(after ? 'drop-below' : 'drop-above');
      });
      box.addEventListener('drop', e => {
        const row = e.target.closest && e.target.closest('.imp-prof-row');
        if (!row || _impDragIdx < 0) { clearMarks(); return; }
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        let to = parseInt(row.dataset.idx) + (after ? 1 : 0);
        const from = _impDragIdx; _impDragIdx = -1;
        clearMarks();
        const listL = loadImpProfiles();
        if (from < 0 || from >= listL.length) return;
        const [item] = listL.splice(from, 1);
        if (to > from) to--;                    // 제거로 인덱스 앞당김 보정
        to = Math.max(0, Math.min(listL.length, to));
        if (to === from) { renderImpProfileList(); return; }
        listL.splice(to, 0, item);
        saveImpProfiles(listL);
        populateImpProfiles(String(to));
        renderImpProfileList();
      });
      box.addEventListener('dragend', () => { _impDragIdx = -1; clearMarks(); });
    }
    function impListSelect(i) {
      const sel = document.getElementById('impProfile');
      if (sel) sel.value = String(i);
      loadImpProfile();         // 목록 클릭 = 즉시 적용
      renderImpProfileList();   // 하이라이트 갱신
    }
    function impListMove(i, dir) {
      const list = loadImpProfiles();
      const to = i + dir;
      if (to < 0 || to >= list.length) return;
      const [item] = list.splice(i, 1);
      list.splice(to, 0, item);
      saveImpProfiles(list);
      populateImpProfiles(String(to));   // 드롭다운도 이동 항목으로 선택 유지
      renderImpProfileList();
    }
    function impListDelete(i) {
      const list = loadImpProfiles();
      if (!list[i]) return;
      const name = list[i].n;
      if (!confirm(`프리셋 '${name}'을(를) 삭제할까요?`)) return;
      list.splice(i, 1);
      saveImpProfiles(list);
      populateImpProfiles('');
      renderImpProfileList();
      showSuccess(`프리셋 '${name}'을(를) 삭제했습니다.`);
    }
    // 인라인 이름 변경 — 이름 칸을 입력창으로 바꿔 Enter/포커스아웃 시 저장, Esc 취소
    function impListRename(i) {
      const box = document.getElementById('impProfileList');
      if (!box) return;
      const row = box.querySelector(`.imp-prof-row[data-idx="${i}"]`);
      if (!row) return;
      const nameEl = row.querySelector('.imp-prof-name');
      if (!nameEl || row.querySelector('input')) return;
      const cur = (loadImpProfiles()[i] || {}).n || '';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = cur; inp.className = 'es-input';
      inp.style.cssText = 'flex:1; min-width:0; font-size:12px; padding:3px 6px;';
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const nn = inp.value.trim();
        const l = loadImpProfiles();
        if (nn && nn !== cur && l[i]) {
          if (l.some((q, qi) => qi !== i && q.n === nn)) { showError(`'${nn}' 이름이 이미 있습니다.`); }
          else { l[i].n = nn; saveImpProfiles(l); populateImpProfiles(String(i)); }
        }
        renderImpProfileList();
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { inp.blur(); }
        else if (e.key === 'Escape') { done = true; renderImpProfileList(); }
      });
      inp.addEventListener('blur', commit);
      nameEl.replaceWith(inp); inp.focus(); inp.select();
    }
    // 시트 크기 읽기 표시 (프로파일/용지 선택 반영)
    function updateImpSheetReadout() {
      const el = document.getElementById('impSheetReadout');
      if (!el) return;
      let sheet = _impProfile && _impProfile.sheet ? _impProfile.sheet : resolveImpPaper(document.getElementById('bkPaper')?.value || 'auto', null);
      const MM = 72 / 25.4;
      el.textContent = sheet ? `시트: ${Math.round(sheet[0] / MM)}×${Math.round(sheet[1] / MM)}mm` : '시트: 자동(원본 기준)';
    }
    // 용지 드롭다운 변경 — '사용자 지정' 선택 시 W×H 직접입력 행을 표시
    function onImpPaperChange() {
      const row = document.getElementById('impCustomRow');
      if (row) row.style.display = (document.getElementById('bkPaper')?.value === '__custom__') ? '' : 'none';
      impSettingsChanged();
    }
    // 사용자 지정 시트 크기를 이름 붙여 재사용 목록(customPapers)에 등록
    function saveImpCustomAsNamed() {
      const name = (document.getElementById('impCustomName')?.value || '').trim();
      const w = parseFloat(document.getElementById('impCustomW')?.value);
      const h = parseFloat(document.getElementById('impCustomH')?.value);
      if (!name) { showError('저장할 용지 이름을 입력하세요.'); return; }
      if (!(w > 0) || !(h > 0)) { showError('폭×높이(mm)를 입력하세요.'); return; }
      const list = loadCustomPapers().filter(p => p.name !== name);
      list.push({ name, w, h });
      saveCustomPapers(list);
      populatePaperSelect('custom:' + name);
      document.getElementById('impCustomName').value = '';
      const row = document.getElementById('impCustomRow'); if (row) row.style.display = 'none';
      updateImpSheetReadout(); impSettingsChanged();
      showSuccess(`사용자 정의 용지 '${name}' (${w}×${h}mm) 등록 — 용지 목록에서 재사용할 수 있습니다.`);
    }

    // 슬러그용 한글 폰트(맑은 고딕) 1회 로드 캐시 — 실패 시 null(ASCII 폴백)
    let _slugFontBytes;   // undefined = 미시도
    function getSlugFontBytes() {
      if (_slugFontBytes !== undefined) return _slugFontBytes;
      try { _slugFontBytes = window.electronAPI.readFile('C:\\Windows\\Fonts\\malgun.ttf'); }
      catch (e) { console.warn('슬러그 폰트(malgun.ttf) 로드 실패 — ASCII만 인쇄됩니다:', e); _slugFontBytes = null; }
      return _slugFontBytes;
    }
    // 슬러그 옵션 — "파일명 · YYYY-MM-DD" (시각은 시그니처 안정성을 위해 날짜까지만)
    function currentSlugOpt() {
      if (!document.getElementById('impSlug')?.checked) return null;
      const d = new Date(), p2 = v => String(v).padStart(2, '0');
      const name = effectiveBaseName();
      return { text: `${name} · ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, fontBytes: getSlugFontBytes() };
    }
    // 현재 임포징 UI 상태 → 빌더 옵션 (모드별). '임포징 PDF 생성' 버튼과 메인
    // 적용/다운로드 파이프라인이 반드시 이 함수를 공유한다 — 결과 불일치 방지.
    // 프로파일을 불러온 직후(UI 미수정)면 그 정규화 옵션을 그대로 재현한다.
    // 슬러그·묶음번호는 프로파일과 무관한 인쇄 보조 표식이라 항상 체크박스에서 읽는다.
    function currentImpOptions() {
      if (_impProfile) {
        const o = JSON.parse(JSON.stringify(_impProfile));
        o.slug = currentSlugOpt();
        o.stackNum = !!document.getElementById('impStackNum')?.checked;
        return o;
      }
      const g = id => document.getElementById(id);
      const paperVal = g('bkPaper')?.value || 'auto';
      const common = {
        mode:   _impMode,
        paper:  paperVal,
        gutter: parseFloat(g('bkGutter')?.value) || 0,
        margin: parseFloat(g('impMargin')?.value) || 0,
        bleed:  parseFloat(g('impBleed')?.value) || 0,
        crop:   !!g('impCrop')?.checked,
        frame:  !!g('impFrame')?.checked,
        slug:   currentSlugOpt(),
        stackNum: !!g('impStackNum')?.checked,
        place:  {
          scale: _impScale,
          fixedScale: _impScale === 'fixed' ? (parseFloat(g('impFixed')?.value) || 100) / 100 : undefined,
          align: g('impAlign')?.value || 'cc',
          offX:  parseFloat(g('impOffX')?.value) || 0,
          offY:  parseFloat(g('impOffY')?.value) || 0,
        },
      };
      const across = parseInt(g('impAcross')?.value) || 1, down = parseInt(g('impDown')?.value) || 1;
      // 표준 용지(A4 등)만 그리드 모양에 맞는 방향 자동 (가로칸>세로칸=가로, 그 외 세로).
      // 사용자 지정/등록 용지는 입력한 W×H 그대로 존중.
      const nupOrient = (paperVal === '__custom__' || paperVal.startsWith('custom:')) ? null
                      : (across > down ? 'landscape' : 'portrait');
      if (_impMode === 'nup')
        return Object.assign(common, { sheet: resolveImpPaper(paperVal, nupOrient), across, down, sides: _cutSides, order: 'sequential' });
      if (_impMode === 'cutstack')
        return Object.assign(common, { sheet: resolveImpPaper(paperVal, down > 1 ? 'portrait' : 'landscape'), across, down, sides: _cutSides, order: 'cutstack' });
      if (_impMode === 'repeat')
        return Object.assign(common, { sheet: resolveImpPaper(paperVal, null), cols: parseInt(g('repCols')?.value) || 0, rows: parseInt(g('repRows')?.value) || 0 });
      if (_impMode === 'dup')
        return Object.assign(common, { sheet: resolveImpPaper(paperVal, 'landscape'), sides: _cutSides });
      return Object.assign(common, { sheet: resolveImpPaper(paperVal, 'landscape'), creep: parseFloat(g('bkCreep')?.value) || 0, binding: _bkBind, sides: _cutSides });
    }
    // 저장 파일명에 붙일 임포징 명칭 — 시트 한 장에 들어가는 페이지 수 기준(1up·2up·N-up).
    // 임포징을 쓰지 않으면 '1up'(원고 그대로 한 장에 한 쪽). 프로파일을 불러온 상태도
    // currentImpOptions()가 정규화해 주므로 그대로 반영된다.
    function impNameTag() {
      if (typeof _impEnabled === 'undefined' || !_impEnabled) return '1up';
      let o = null;
      try { o = currentImpOptions(); } catch (e) {}
      const mode = (o && o.mode) || _impMode;
      const cell = (a, b) => Math.max(1, parseInt(a) || 1) * Math.max(1, parseInt(b) || 1);
      if (mode === 'booklet')  return '중철2up';
      if (mode === 'dup')      return '복제2up';
      if (mode === 'repeat') {
        const c = parseInt(o && o.cols) || 0, r = parseInt(o && o.rows) || 0;
        return (c > 0 && r > 0) ? `반복${c * r}up` : '반복배치';
      }
      if (mode === 'cutstack') return `정합${cell(o && o.across, o && o.down)}up`;
      if (mode === 'nup')      return `${cell(o && o.across, o && o.down)}up`;
      return '1up';
    }

    // 임포징 최종 단계 — srcBytes(적용/최적화 결과)를 현재 모드의 시트로 조립.
    // 적용(applyChanges)·다운로드(downloadProcessed)·실시간 미리보기가 공유한다.
    // 임포징 결과 캐시 — 소스 바이트 지문 + 임포징 옵션이 같으면 시트를 다시 조립하지 않는다.
    // (편집 모드에서 임포징 무관한 옵션을 만질 때마다 전체 재조립하던 딜레이 제거)
    let _impBytesCache = { sig: null, bytes: null };
    function clearImpCache() { _impBytesCache = { sig: null, bytes: null }; }
    async function buildImposedBytes(srcBytes, onProgress) {
      const opts = currentImpOptions();
      const u8 = srcBytes instanceof Uint8Array ? srcBytes : new Uint8Array(srcBytes);
      // 시그니처는 opts에서 직접 만든다 — impSignature()는 '임포징 포함'이 꺼져 있으면 빈 문자열을
      // 돌려주므로, 그걸 쓰면 옵션을 바꿔도 캐시가 적중하는 낡은 결과 버그가 생긴다.
      let sig;
      try { sig = bytesFingerprint(u8) + '|' + JSON.stringify(opts); }
      catch (e) { sig = null; }
      if (sig && _impBytesCache.sig === sig && _impBytesCache.bytes) { if (onProgress) onProgress(100); return _impBytesCache.bytes; }
      const build = opts.mode === 'nup' || opts.mode === 'cutstack' ? buildNupBytes
                  : opts.mode === 'repeat'   ? buildStepRepeatBytes
                  : opts.mode === 'dup'      ? buildDup2upBytes
                  : buildBookletBytes;
      const bytes = (await build(srcBytes, opts, onProgress)).bytes;
      _impBytesCache = sig ? { sig, bytes } : { sig: null, bytes: null };   // 시그니처를 못 만들면 캐시하지 않는다
      return bytes;
    }
    // 적용 완료 메시지용 임포징 설명
    function impositionNoteOf() {
      if (!_impEnabled) return '';
      if (_impProfile && _impProfile._profName) return ` · 임포징 프로파일: ${_impProfile._profName}`;
      const g = id => document.getElementById(id);
      const grid = `${parseInt(g('impAcross')?.value) || 1}x${parseInt(g('impDown')?.value) || 1}`;
      const name = _impMode === 'nup'      ? `모아찍기 ${grid}·${_cutSides === 2 ? '양면' : '단면'}`
                 : _impMode === 'cutstack' ? `정합 ${grid}·${_cutSides === 2 ? '양면' : '단면'}`
                 : _impMode === 'repeat'   ? '반복(Step&Repeat)'
                 : _impMode === 'dup'      ? '복제 2부'
                 : `중철(북클릿)·${_bkBind === 'right' ? '우철' : '좌철'}`;
      const paper = g('bkPaper')?.value || 'auto';
      const paperName = paper === 'auto' ? '자동 용지' : paper.startsWith('custom:') ? paper.slice(7) : paper;
      return ` · 임포징: ${name} · ${paperName}${_impScale === 'orig' ? ' · 100% 배치' : _impScale === 'fixed' ? ' · 지정배율' : ''}`;
    }
    // '임포징 PDF 생성' 결과를 메인 적용 상태로 채택 + 포함 모드 자동 ON —
    // 이후 메인 '⇩ 다운로드'도 같은 임포징 반영본을 저장한다(화면·파일 불일치 버그 방지).
    function adoptImposedResult(bytes, name) {
      if (!_impEnabled) {
        _impEnabled = true;
        const chk = document.getElementById('impEnabled');
        if (chk) chk.checked = true;
      }
      processedPdfBytes = bytes;
      directOutputBytes = null;   // 임포징은 파이프라인 포함(_impEnabled) — 재조립 경로와 일치
      processedFileName = name;
      setDirty(true);
      updateDownloadBtn();
      setImpGenDone(true);        // 같은 설정으로 다시 누르지 않도록 버튼 잠금
      // 🕓 임포징까지 반영된 현재 설정을 최근 작업으로 기록 (제본 설정 유실 방지)
      if (typeof recordWorkHistory === 'function') { try { recordWorkHistory(); } catch (e) {} }
    }

    // 임포징 실행 — 모드에 따라 모아찍기/정합/반복/복제/중철 분기 (화면 생성만; 저장은 메인 다운로드)
    async function generateImposition() {
      if (!_impMode) { showError('임포징 방식(중철·모아찍기·정합·반복·복제)을 먼저 선택하거나 프리셋을 불러오세요.'); return; }
      setBtnBusy('impGenBtn', true);
      try {
        if (_impMode === 'nup' || _impMode === 'cutstack') return await generateNup();
        if (_impMode === 'repeat')   return await generateStepRepeat();
        if (_impMode === 'dup')      return await generateDup2up();
        return await generateBooklet();
      } finally { setBtnBusy('impGenBtn', false); }
    }

    async function downloadProcessed() {
      if (!processedPdfBytes) { showError('먼저 \'✔ 적용\'을 눌러 수정사항을 적용하거나, 다운로드 버튼을 우클릭해 원본을 저장하세요.'); return; }
      // 외부 변환 결과(블리드 등)는 재조립하면 변환이 사라짐 — 그대로 저장
      if (directOutputBytes) {
        try {
          let bytes = directOutputBytes;
          // 폰트 출력 안전화는 저장 직전 단계 — 이 경로에도 동일하게 반영한다
          // (예전엔 이 분기가 안전화를 통째로 건너뛰어, 블리드 생성 후 저장하면 옵션이 무시됐다)
          if (_outlineEnabled) {
            showLoading(_outlineMode === 'embed' ? '폰트 완전 임베드 중… (Ghostscript)' : '폰트 → 곡선 변환 중… (Ghostscript 병렬 처리)');
            bytes = await buildOutlinedBytes(bytes);
            hideLoading();
          }
          const saved = await window.electronAPI.saveFile({ defaultName: processedFileName, buffer: bytes });
          if (saved) { setDirty(false); showSuccess('PDF를 저장했습니다. (변환 결과 그대로 — 재조립 없음)' + (_outlineEnabled ? (_outlineMode === 'embed' ? ' · 🔤 폰트 완전 임베드 반영' : ' · ✒ 폰트 곡선화 반영') : '')); }
        } catch (err) {
          console.error('다운로드 오류:', err);
          hideLoading();
          showError('다운로드 중 오류: ' + (err && err.message ? err.message : String(err)));
        }
        return;
      }
      try {
        applying = true; updateDownloadBtn();
        showLoading('다운로드용 PDF 최적화 중…');
        progressBar.style.display = 'block'; updateProgress(0);
        // 최종 파일은 용량 최적화 방식으로 새로 생성 (미리보기와 내용 동일)
        let finalBytes = await buildOptimizedOutput(p => updateProgress(p));
        finalBytes = await applyTocBookmarks(finalBytes);   // 목차 북마크 태그가 있으면 최종본에 적용
        if (_outlineEnabled) {   // 폰트 출력 안전화 ON — 저장 직전 최종 단계로 반영 (모양은 동일)
          // 적용 직후 프리웜이 이미 구워 뒀으면 캐시 적중으로 즉시 통과한다.
          showLoading(_outlineMode === 'embed'
            ? '폰트 완전 임베드 중… (Ghostscript)'
            : '폰트 → 곡선 변환 중… (Ghostscript 병렬 처리)');
          finalBytes = await buildOutlinedBytes(finalBytes, p => updateProgress(Math.round(p * 100)));
        }
        applying = false; updateDownloadBtn();
        hideLoading(); progressBar.style.display = 'none';
        const saved = await window.electronAPI.saveFile({
          defaultName: processedFileName,
          buffer: finalBytes,
        });
        if (saved) {
          setDirty(false);
          let m = 'PDF를 다운로드했습니다. (용량 최적화 적용)';
          if (_outlineEnabled) m += _outlineMode === 'embed' ? ' · 🔤 폰트 완전 임베드 반영' : ' · ✒ 폰트 곡선화 반영';
          if (_outlineEnabled && _outlineRasterInfo && _outlineRasterInfo.count)
            m += `\n🖼 이 PC에 없는 폰트(${_outlineRasterInfo.fonts.join(', ')}) 사용 ${_outlineRasterInfo.count}쪽(${_outlineRasterInfo.pages.join(', ')}p)은 300DPI 이미지로 굳혔습니다.`;
          showSuccess(m);
        }
      } catch (err) {
        console.error('다운로드 오류:', err);
        showError('다운로드 중 오류: ' + (err && err.message ? err.message : String(err)));
      } finally {
        applying = false;
        updateDownloadBtn();
        hideLoading();
        progressBar.style.display = 'none';
      }
    }

    // ── 여러 파일을 하나의 PDF로 합치기 ──────────────────────────────────────
    // 열려 있는 모든 탭의 원본 PDF(HWP/HWPX는 변환된 PDF)를 탭 순서대로 병합.
    // 병합본은 저장 다이얼로그로 바로 저장하고, 동시에 새 탭으로 열어 분석한다.
    function mergeAllTabs() {
      const ready = [...tabs.values()].filter(
        t => t.originalPdfBytes && t.pageResults.filter(Boolean).length
      );
      if (ready.length < 2) {
        showError('합치려면 분석이 끝난 파일이 2개 이상 필요합니다.');
        return;
      }
      openMergeDialog(ready);
    }

    // 합치기 전에 파일 순서를 조정할 수 있는 모달을 띄운다.
    function openMergeDialog(readyTabs) {
      const order = readyTabs.slice();
      const overlay = document.createElement('div');
      overlay.className = 'merge-overlay';
      overlay.innerHTML =
        '<div class="merge-modal">'
        + '<h3 class="merge-title">파일 합치기 순서</h3>'
        + '<p class="merge-sub">드래그하거나 ▲▼ 버튼으로 순서를 바꾼 뒤 합치기를 누르세요. 맨 위 파일명이 합본 이름의 기준이 됩니다.</p>'
        + '<ul class="merge-list" id="mergeList"></ul>'
        + '<div class="merge-actions"><button class="merge-cancel" id="mergeCancel">취소</button>'
        + '<button class="merge-confirm" id="mergeConfirm"><span class="ic">🔗</span> 합치기</button></div>'
        + '</div>';
      document.body.appendChild(overlay);
      const listEl = overlay.querySelector('#mergeList');
      let dragIdx = null;

      function renderList() {
        listEl.innerHTML = '';
        order.forEach((t, i) => {
          const li = document.createElement('li');
          li.className = 'merge-item';
          li.draggable = true;
          li.innerHTML =
            `<span class="merge-idx">${i + 1}</span>`
            + `<span class="merge-name" title="${t.fileName}">📄 ${t.fileName}</span>`
            + '<span class="merge-move">'
            + `<button class="merge-up" ${i === 0 ? 'disabled' : ''}>▲</button>`
            + `<button class="merge-down" ${i === order.length - 1 ? 'disabled' : ''}>▼</button>`
            + '</span>';
          li.querySelector('.merge-up').onclick = () => { if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; renderList(); } };
          li.querySelector('.merge-down').onclick = () => { if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; renderList(); } };
          li.ondragstart = (e) => { dragIdx = i; e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); };
          li.ondragend = () => { dragIdx = null; listEl.querySelectorAll('.merge-item').forEach(x => x.classList.remove('dragging','drag-over')); };
          li.ondragover = (e) => { if (dragIdx !== null && dragIdx !== i) { e.preventDefault(); li.classList.add('drag-over'); } };
          li.ondragleave = () => li.classList.remove('drag-over');
          li.ondrop = (e) => {
            e.preventDefault(); li.classList.remove('drag-over');
            if (dragIdx !== null && dragIdx !== i) { const [m] = order.splice(dragIdx, 1); order.splice(i, 0, m); renderList(); }
          };
          listEl.appendChild(li);
        });
      }
      renderList();

      const close = () => overlay.remove();
      overlay.querySelector('#mergeCancel').onclick = close;
      overlay.onclick = (e) => { if (e.target === overlay) close(); };
      overlay.querySelector('#mergeConfirm').onclick = () => { close(); performMerge(order); };
    }

    async function performMerge(ready) {
      try {
        hideError(); hideSuccess();
        showLoading(`${ready.length}개 파일을 하나로 합치는 중…`);
        progressBar.style.display = 'block'; updateProgress(0);

        // 원본 탭 데이터는 보존해야 하므로 복사본을 만들어 워커로 transfer한다.
        const buffers = ready.map(t => t.originalPdfBytes.slice(0));
        const { bytes: rawBytes, counts } = await assembleWorkerPool.run(
          'merge', { buffers }, buffers.map(b => b.buffer), (pct) => updateProgress(pct * 100)
        );
        const bytes = new Uint8Array(rawBytes);

        const chapters = [];           // 파일별 챕터 경계 {name, start(1-based), count}
        let startPage = 1;
        ready.forEach((t, i) => {
          chapters.push({ name: t.fileName, start: startPage, count: counts[i] });
          startPage += counts[i];
        });

        hideLoading(); progressBar.style.display = 'none';

        // 합본 파일명: 맨 위(첫 번째) 파일명 기준으로 확장자를 떼고 "_합본.pdf"를 붙인다.
        const baseName = ready[0].fileName.replace(/\.[^.]+$/, '');
        const mergedName = `${baseName}_합본.pdf`;

        // 즉시 저장하지 않는다 — 합본을 새 탭으로 열어 분석하고,
        // 모든 편집·적용을 마친 뒤 '⇩ 다운로드' 버튼으로 저장한다.
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const file = {
          name: mergedName, size: bytes.byteLength, type: 'application/pdf',
          arrayBuffer: () => Promise.resolve(ab.slice(0)),
        };
        const tab = createTab(file);
        tab.chapters = chapters;       // 분석 완료 후 페이지별 챕터 태깅에 사용
        activateTab(tab.id);
        analyzePDF(file, tab);
        setDirty(true);                // 아직 저장 전 — 종료 시 저장 확인이 뜨도록 표시

        showSuccess(`${ready.length}개 파일을 합쳤습니다. 편집·적용을 마친 뒤 '⇩ 다운로드'로 저장하세요.`);
      } catch (e) {
        hideLoading(); progressBar.style.display = 'none';
        showError('파일 합치기 오류: ' + (e && e.message ? e.message : String(e)));
      }
    }

    // ── 벡터 그레이스케일 변환 헬퍼 ─────────────────────────────────────────
    // PNG 예측 필터 복원 (Paeth)
    function paethPredictor(a, b, c) {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }

    // PNG predictor(10-15) 제거: 행마다 붙은 필터 바이트를 해석해 실제 픽셀 복원
    function removePNGPredictor(raw, w, ch) {
      const stride = w * ch;
      const h = Math.floor(raw.length / (stride + 1));
      if (h < 1 || raw.length !== h * (stride + 1)) return null;
      const out = new Uint8Array(h * stride);
      for (let y = 0; y < h; y++) {
        const ft = raw[y * (stride + 1)];
        const si = y * (stride + 1) + 1;
        const di = y * stride;
        const pi = di - stride;
        for (let x = 0; x < stride; x++) {
          const v = raw[si + x];
          const a = x >= ch ? out[di + x - ch] : 0;
          const b = y > 0   ? out[pi + x]      : 0;
          const c = y > 0 && x >= ch ? out[pi + x - ch] : 0;
          switch (ft) {
            case 1: out[di + x] = (v + a) & 0xff; break;
            case 2: out[di + x] = (v + b) & 0xff; break;
            case 3: out[di + x] = (v + ((a + b) >> 1)) & 0xff; break;
            case 4: out[di + x] = (v + paethPredictor(a, b, c)) & 0xff; break;
            default: out[di + x] = v; break;
          }
        }
      }
      return out;
    }

    // 흑백 픽셀에 PNG Sub 예측 필터 적용 (FlateDecode 압축률 향상)
    // Sub 필터: 각 바이트에서 왼쪽 바이트를 뺀 차분값 저장 → 평활·단색 이미지 압축률 대폭 향상
    function applyPNGPredictorGray(raw, w, h) {
      const out = new Uint8Array(h * (w + 1));
      for (let y = 0; y < h; y++) {
        out[y * (w + 1)] = 1; // filter type 1 = Sub
        for (let x = 0; x < w; x++) {
          const a = x > 0 ? raw[y * w + x - 1] : 0;
          out[y * (w + 1) + 1 + x] = (raw[y * w + x] - a) & 0xff;
        }
      }
      return out;
    }

    // ── 관대한 inflate: /Length 손상으로 잘린 스트림 부분 복구 ──────────────────
    // 일부 DTP PDF는 /Length가 실제보다 짧게 기록되어 pako.inflate가 undefined 반환
    // (Acrobat·PDF.js는 부분 디코딩으로 정상 표시) → 스트리밍 모드로 가능한 만큼 복구
    function inflateLenient(data, expectedLen, fillValue) {
      try {
        const r = pako.inflate(data);
        if (r && r.length) return r;
      } catch(e) {}
      try {
        const chunks = [];
        const inf = new pako.Inflate();
        inf.onData = (c) => chunks.push(c);
        inf.onEnd = () => {};
        inf.push(data, true);
        const total = chunks.reduce((s, c) => s + c.length, 0);
        if (!total) return null;
        const outLen = expectedLen != null ? Math.max(total, expectedLen) : total;
        const out = new Uint8Array(outLen);
        if (fillValue) out.fill(fillValue, 0);
        let off = 0;
        for (const ch of chunks) { out.set(ch, off); off += ch.length; }
        if (fillValue && off < outLen) out.fill(fillValue, off);
        return out;
      } catch(e) { return null; }
    }

    // ── 이미지 딕셔너리 공용 헬퍼 ────────────────────────────────────────────────
    function imgFilterNameOf(pdfDoc, dict) {
      const Nm = n => PDFLib.PDFName.of(n);
      let f = dict.get(Nm('Filter'));
      if (!f) return '';
      try { if (f.objectNumber != null) f = pdfDoc.context.lookup(f); } catch(e) {}
      if (f && f.encodedName) return f.encodedName;
      if (f && typeof f.size === 'function' && f.size() === 1) {
        try { const e = pdfDoc.context.lookup(f.get(0)) ?? f.get(0); return e?.encodedName || ''; } catch(e) {}
      }
      return f && typeof f.size === 'function' ? '[multi]' : '';
    }
    function imgPredictorOf(pdfDoc, dict) {
      const Nm = n => PDFLib.PDFName.of(n);
      let p = 1;
      const dpRef = dict.get(Nm('DecodeParms')) || dict.get(Nm('DP'));
      if (!dpRef) return 1;
      try {
        let dp = pdfDoc.context.lookup(dpRef) ?? dpRef;
        if (dp && typeof dp.size === 'function' && dp.size() > 0) dp = pdfDoc.context.lookup(dp.get(0)) ?? dp.get(0);
        if (dp && typeof dp.get === 'function') {
          const pObj = dp.get(Nm('Predictor'));
          if (pObj) p = +(pObj.numberValue ?? pObj.asNumber?.() ?? 1);
        }
      } catch(e) {}
      return p;
    }

    // ── PDF 함수 평가기 — Type 2(지수)/0(샘플)/3(스티칭) → f(t)=출력배열, 미지원 null ──
    function buildPdfFnEvaluator(pdfDoc, fnObjRaw, depth = 0) {
      if (depth > 4) return null;
      const Nm = n => PDFLib.PDFName.of(n);
      const lkf = (v) => { try { const r = pdfDoc.context.lookup(v); return r !== undefined ? r : v; } catch(e) { return v; } };
      const fnObj = lkf(fnObjRaw);
      const fGet = fnObj && (fnObj.get ? fnObj.get.bind(fnObj) : fnObj.dict?.get?.bind(fnObj.dict));
      if (!fGet) return null;
      const num = (v) => { const o = lkf(v); const n = o?.numberValue ?? o?.asNumber?.(); return n != null ? +n : null; };
      const arr = (ref) => {
        const a = lkf(ref);
        if (!a || typeof a.size !== 'function') return null;
        const out = [];
        for (let i = 0; i < a.size(); i++) { const n = num(a.get(i)); out.push(n != null ? n : 0); }
        return out;
      };
      const ft = num(fGet(Nm('FunctionType')));
      if (ft === 2) {
        const c0 = arr(fGet(Nm('C0'))) || [0];
        const c1 = arr(fGet(Nm('C1'))) || [1];
        const N = num(fGet(Nm('N'))) ?? 1;
        return (t) => c0.map((v, i) => v + Math.pow(t, N) * ((c1[i] ?? 1) - v));
      }
      if (ft === 0) {
        const fd = fnObj.dict;
        if (!fd || !fnObj.contents) return null;
        const range = arr(fd.get(Nm('Range')));
        const sizeA = arr(fd.get(Nm('Size')));
        const bps = num(fd.get(Nm('BitsPerSample')));
        if (!range || !sizeA || sizeA.length !== 1 || ![1,2,4,8,16,32].includes(bps)) return null;
        const nOut = range.length / 2;
        const fname = imgFilterNameOf(pdfDoc, fd);
        let raw = fnObj.contents;
        if (fname === '/FlateDecode' || fname === '/Fl') raw = inflateLenient(raw, null);
        else if (fname !== '') return null;
        const total = sizeA[0];
        if (!raw || raw.length * 8 < total * nOut * bps) return null;
        const maxS = Math.pow(2, bps) - 1;
        const decode = arr(fd.get(Nm('Decode'))) || range;
        const samples = [];
        let rp = 0;
        const rd = () => { let v = 0; for (let k = 0; k < bps; k++) { v = v*2 + ((raw[rp>>3] >> (7-(rp&7))) & 1); rp++; } return v; };
        for (let si = 0; si < total; si++) {
          const tuple = [];
          for (let ci = 0; ci < nOut; ci++) {
            const r = rd();
            tuple.push(decode[ci*2] + (r / maxS) * (decode[ci*2+1] - decode[ci*2]));
          }
          samples.push(tuple);
        }
        const domain = arr(fd.get(Nm('Domain'))) || [0, 1];
        const encode = arr(fd.get(Nm('Encode'))) || [0, total - 1];
        return (t) => {
          const tc = Math.max(domain[0], Math.min(domain[1], t));
          let e = encode[0] + (tc - domain[0]) * (encode[1] - encode[0]) / ((domain[1] - domain[0]) || 1);
          e = Math.max(0, Math.min(total - 1, e));
          const i0 = Math.floor(e), i1 = Math.min(total - 1, i0 + 1), fr = e - i0;
          return samples[i0].map((v, ci) => v + fr * (samples[i1][ci] - v));
        };
      }
      if (ft === 3) {
        const fnsA = lkf(fGet(Nm('Functions')));
        if (!fnsA || typeof fnsA.size !== 'function') return null;
        const subs = [];
        for (let i = 0; i < fnsA.size(); i++) {
          const ev = buildPdfFnEvaluator(pdfDoc, fnsA.get(i), depth + 1);
          if (!ev) return null;
          subs.push(ev);
        }
        const bounds = arr(fGet(Nm('Bounds'))) || [];
        const domain = arr(fGet(Nm('Domain'))) || [0, 1];
        const encode = arr(fGet(Nm('Encode'))) || [];
        return (t) => {
          const tc = Math.max(domain[0], Math.min(domain[1], t));
          let k = 0;
          while (k < bounds.length && tc >= bounds[k]) k++;
          const lo = k === 0 ? domain[0] : bounds[k-1];
          const hi = k === bounds.length ? domain[1] : bounds[k];
          const e0 = encode.length > k*2 ? encode[k*2] : 0;
          const e1 = encode.length > k*2+1 ? encode[k*2+1] : 1;
          return subs[k](e0 + (tc - lo) * (e1 - e0) / ((hi - lo) || 1));
        };
      }
      return null;
    }

    // ── 색공간 배열 → 채널 수/종류 (이미지 변환용 공용) ──────────────────────────
    function imgResolveCSKind(pdfDoc, cs) {
      const Nm = n => PDFLib.PDFName.of(n);
      const lkf = (v) => { try { const r = pdfDoc.context.lookup(v); return r !== undefined ? r : v; } catch(e) { return v; } };
      const o = lkf(cs);
      if (!o) return null;
      const name = o.encodedName || '';
      if (name === '/DeviceCMYK' || name === '/CalCMYK') return 'cmyk';
      if (name === '/DeviceRGB' || name === '/CalRGB') return 'rgb';
      if (name === '/DeviceGray' || name === '/CalGray') return 'gray';
      if (typeof o.size === 'function' && o.size() > 0) {
        const f = lkf(o.get(0))?.encodedName || '';
        if (f === '/ICCBased' && o.size() > 1) {
          const st = lkf(o.get(1));
          const nObj = st?.dict?.get?.(Nm('N'));
          const n = nObj ? +(nObj.numberValue ?? nObj.asNumber?.() ?? 0) : 0;
          return n === 4 ? 'cmyk' : n === 3 ? 'rgb' : n === 1 ? 'gray' : null;
        }
        if (f === '/CalRGB' || f === '/DeviceRGB') return 'rgb';
        if (f === '/CalGray' || f === '/DeviceGray') return 'gray';
        if (f === '/DeviceCMYK') return 'cmyk';
      }
      return null;
    }
    function imgGrayOfBytes(kind, b0, b1, b2, b3) {
      if (kind === 'cmyk') {
        const C = b0/255, M = b1/255, Y = b2/255, K = b3/255;
        return Math.round(255 * Math.max(0, Math.min(1, 0.299*(1-C)*(1-K) + 0.587*(1-M)*(1-K) + 0.114*(1-Y)*(1-K))));
      }
      if (kind === 'rgb') return Math.round(Math.max(0, Math.min(255, 0.299*b0 + 0.587*b1 + 0.114*b2)));
      return b0;
    }

    // ── Indexed 이미지: 팔레트만 그레이로 교체 (픽셀 무수정) ─────────────────────
    // 픽셀 스트림이 /Length 손상으로 잘려 있어도 안전 + inflate/deflate 생략으로 고속
    function convertIndexedImagePalette(pdfDoc, img, csArr) {
      try {
        const Nm = n => PDFLib.PDFName.of(n);
        const lkf = (v) => { try { const r = pdfDoc.context.lookup(v); return r !== undefined ? r : v; } catch(e) { return v; } };
        const kind = imgResolveCSKind(pdfDoc, csArr.get(1));
        if (!kind) return false;
        const hivalO = lkf(csArr.get(2));
        const hival = hivalO != null ? +(hivalO.numberValue ?? hivalO.asNumber?.() ?? 255) : 255;
        if (!(hival >= 0 && hival <= 255)) return false;
        const nCh = kind === 'cmyk' ? 4 : kind === 'rgb' ? 3 : 1;
        // 팔레트 바이트 추출 (PDFString/HexString 또는 스트림, Flate 압축 가능)
        const luRaw = csArr.get(3);
        const lu = lkf(luRaw);
        let pal = null;
        if (lu && lu.contents) {
          const fname = lu.dict ? imgFilterNameOf(pdfDoc, lu.dict) : '';
          if (fname === '/FlateDecode' || fname === '/Fl') pal = inflateLenient(lu.contents, (hival + 1) * nCh);
          else if (fname === '') pal = lu.contents;
        } else if (lu && lu.asBytes) pal = lu.asBytes();
        else if (luRaw && luRaw.asBytes) pal = luRaw.asBytes();
        if (!pal) return false;
        // 그레이 팔레트 생성 → [/Indexed /DeviceGray hival <hex>]
        let hex = '';
        for (let i = 0; i <= hival; i++) {
          const off = i * nCh;
          const g = imgGrayOfBytes(kind, pal[off] ?? 0, pal[off+1] ?? 0, pal[off+2] ?? 0, pal[off+3] ?? 0);
          hex += g.toString(16).padStart(2, '0');
        }
        const newCS = pdfDoc.context.obj([
          Nm('Indexed'), Nm('DeviceGray'), PDFLib.PDFNumber.of(hival), PDFLib.PDFHexString.of(hex),
        ]);
        img.dict.set(Nm('ColorSpace'), newCS);
        return true;
      } catch(e) { console.warn('Indexed 팔레트 변환 실패:', e); return false; }
    }

    // ── Separation/DeviceN 틴트 → 그레이 LUT(256) ───────────────────────────────
    function buildTintGrayLUT(pdfDoc, csArr) {
      try {
        const sz = csArr.size();
        const altKind = imgResolveCSKind(pdfDoc, csArr.get(2));
        const ev = sz > 3 ? buildPdfFnEvaluator(pdfDoc, csArr.get(3)) : null;
        const lut = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
          const t = i / 255;
          let g;
          if (ev && altKind) {
            const ch = ev(t);
            if (altKind === 'cmyk' && ch.length >= 4)
              g = 0.299*(1-ch[0])*(1-ch[3]) + 0.587*(1-ch[1])*(1-ch[3]) + 0.114*(1-ch[2])*(1-ch[3]);
            else if (altKind === 'rgb' && ch.length >= 3)
              g = 0.299*ch[0] + 0.587*ch[1] + 0.114*ch[2];
            else if (altKind === 'gray' && ch.length >= 1)
              g = ch[0];
            else g = 1 - t;
          } else g = 1 - t;  // 함수 평가 불가 — 잉크량 반전 근사
          lut[i] = Math.round(Math.max(0, Math.min(1, g)) * 255);
        }
        return lut;
      } catch(e) { return null; }
    }

    // ── Separation 1채널 이미지 → DeviceGray ───────────────────────────────────
    // 1순위: 픽셀을 LUT로 직접 변환 / 2순위(스트림 손상 등): 색공간만 그레이 버전으로 교체
    async function convertSeparationImage(pdfDoc, img, csArr) {
      try {
        const Nm = n => PDFLib.PDFName.of(n);
        const lut = buildTintGrayLUT(pdfDoc, csArr);
        if (!lut) return;
        // 이미지 Decode 배열([1 0] 반전 등)을 LUT에 합성
        let lutF = lut;
        try {
          const decA = pdfDoc.context.lookup(img.dict.get(Nm('Decode')));
          if (decA && typeof decA.size === 'function' && decA.size() >= 2) {
            const dv = (i) => { const o = pdfDoc.context.lookup(decA.get(i)) ?? decA.get(i); return +(o.numberValue ?? o.asNumber?.() ?? (i === 0 ? 0 : 1)); };
            const d0 = dv(0), d1 = dv(1);
            if (d0 !== 0 || d1 !== 1) {
              lutF = new Uint8Array(256);
              for (let s = 0; s < 256; s++) {
                const t = d0 + (s / 255) * (d1 - d0);
                lutF[s] = lut[Math.round(Math.max(0, Math.min(1, t)) * 255)];
              }
            }
          }
        } catch(e) {}

        const gn = (k, dflt) => { const o = img.dict.get(Nm(k)); return o ? +(o.numberValue ?? o.asNumber?.() ?? dflt) : dflt; };
        const w = gn('Width', 0), h = gn('Height', 0), bpcV = gn('BitsPerComponent', 8);
        const fname = imgFilterNameOf(pdfDoc, img.dict);

        // DCT(JPEG) — 워커에 LUT 전달 (1채널 JPEG의 픽셀값 = 틴트 t)
        if (fname === '/DCTDecode' || fname === '/DCT') {
          await convertJpegXObjectToGrayscale(pdfDoc, img, lutF);
          return;
        }

        // 픽셀 직접 변환 (무필터 또는 FlateDecode, 8bpc)
        let tBytes = null;
        if (bpcV === 8 && w > 0 && h > 0) {
          if (fname === '') {
            tBytes = img.contents;
          } else if (fname === '/FlateDecode' || fname === '/Fl') {
            tBytes = inflateLenient(img.contents, h * (imgPredictorOf(pdfDoc, img.dict) >= 10 ? w + 1 : w));
            if (tBytes) {
              const predictor = imgPredictorOf(pdfDoc, img.dict);
              if (predictor >= 10) {
                const d = removePNGPredictor(tBytes, w, 1);
                tBytes = (d && d.length >= w * h) ? d : null;
              } else if (tBytes.length < w * h) tBytes = null;
            }
          }
        }
        if (tBytes) {
          const gray = new Uint8Array(w * h);
          for (let i = 0; i < w * h; i++) gray[i] = lutF[tBytes[i] ?? 0];
          const _dg = ctxDotGain(pdfDoc);
          if (_dg) {
            for (let i = 0; i < gray.length; i++) {
              const v = gray[i] / 255;
              let out;
              if (_dg === 25) out = Math.sqrt(v);
              else { const disc = 0.04+3.2*v; const d = (1.8-Math.sqrt(disc<0?0:disc))/1.6; out = 1-Math.max(0,Math.min(1,d)); }
              gray[i] = Math.round(Math.max(0, Math.min(255, out * 255)));
            }
          }
          const predicted = applyPNGPredictorGray(gray, w, h);
          const compressed = pako.deflate(predicted, { level: 1 });
          img.contents = compressed;
          img.dict.set(Nm('Filter'),           Nm('FlateDecode'));
          img.dict.set(Nm('ColorSpace'),       Nm('DeviceGray'));
          img.dict.set(Nm('BitsPerComponent'), PDFLib.PDFNumber.of(8));
          img.dict.set(Nm('Length'),           PDFLib.PDFNumber.of(compressed.length));
          img.dict.set(Nm('DecodeParms'), pdfDoc.context.obj({
            Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: w }));
          img.dict.delete(Nm('Mask')); img.dict.delete(Nm('ImageMask'));
          img.dict.delete(Nm('Intent')); img.dict.delete(Nm('Alternates'));
          img.dict.delete(Nm('Decode')); img.dict.delete(Nm('Matte')); img.dict.delete(Nm('SMaskInData'));
          fixSMaskMatte(pdfDoc, img);
          return;
        }

        // 폴백: 색공간만 교체 — [/Separation name /DeviceGray 샘플함수(LUT)]
        // 픽셀 무수정이라 손상 스트림도 렌더링 동작 보존
        const lutDeflated = pako.deflate(lutF, { level: 1 });
        const fnDict = pdfDoc.context.obj({
          FunctionType: 0, Domain: [0, 1], Range: [0, 1],
          Size: [256], BitsPerSample: 8, Filter: 'FlateDecode', Length: lutDeflated.length,
        });
        const fnStream = PDFLib.PDFRawStream.of(fnDict, lutDeflated);
        const fnRef = pdfDoc.context.register(fnStream);
        const sepName = csArr.size() > 1 ? csArr.get(1) : Nm('All');
        img.dict.set(Nm('ColorSpace'), pdfDoc.context.obj([Nm('Separation'), sepName, Nm('DeviceGray'), fnRef]));
      } catch(e) { console.warn('Separation 이미지 변환 실패:', e); }
    }

    // Latin-1 인코딩으로 바이너리 안전하게 처리 (청크 fromCharCode — O(n), 정확한 1:1 왕복)
    // 주의: TextDecoder('latin1')은 windows-1252라서 0x80~0x9F 바이트가 손상됨 — 사용 금지
    function decodeLatin1(bytes) {
      const CHUNK = 0x8000;
      if (bytes.length <= CHUNK) return String.fromCharCode.apply(null, bytes);
      const parts = [];
      for (let i = 0; i < bytes.length; i += CHUNK)
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
      return parts.join('');
    }
    function encodeLatin1(str) {
      const b = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
      return b;
    }

    // applyOps용 정규식 pre-compile (매 호출 new RegExp 생성 방지 — 속도 최적화)
    const _MS_NB = '(-?\\d*\\.?\\d+)', _MS_WS = '\\s+', _MS_TL = '(?=[\\s\\r\\n]|$)';
    const _MS_RE_rg   = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}rg${_MS_TL}`, 'gm');
    const _MS_RE_RG   = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}RG${_MS_TL}`, 'gm');
    const _MS_RE_k    = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}k${_MS_TL}`, 'gm');
    const _MS_RE_K    = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}K${_MS_TL}`, 'gm');
    const _MS_RE_SCN4 = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}SCN${_MS_TL}`, 'gm');
    const _MS_RE_scn4 = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}scn${_MS_TL}`, 'gm');
    const _MS_RE_SC4  = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}SC${_MS_TL}`, 'gm');
    const _MS_RE_sc4  = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}sc${_MS_TL}`, 'gm');
    const _MS_RE_SCN3 = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}SCN${_MS_TL}`, 'gm');
    const _MS_RE_scn3 = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}scn${_MS_TL}`, 'gm');
    const _MS_RE_SC3  = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}SC${_MS_TL}`, 'gm');
    const _MS_RE_sc3  = new RegExp(`${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}${_MS_NB}${_MS_WS}sc${_MS_TL}`, 'gm');
    const _MS_RE_SCN1 = new RegExp(`${_MS_NB}${_MS_WS}SCN${_MS_TL}`, 'gm');
    const _MS_RE_scn1 = new RegExp(`${_MS_NB}${_MS_WS}scn${_MS_TL}`, 'gm');
    const _MS_RE_SC1  = new RegExp(`${_MS_NB}${_MS_WS}SC${_MS_TL}`, 'gm');
    const _MS_RE_sc1  = new RegExp(`${_MS_NB}${_MS_WS}sc${_MS_TL}`, 'gm');

    // PDF 콘텐츠 스트림의 색상 연산자를 그레이스케일로 치환
    function grayifyStream(bytes) {
      const s = decodeLatin1(bytes);
      const lum = (r, g, b) => (0.2126*+r + 0.7152*+g + 0.0722*+b).toFixed(4);
      const lumCmyk = (c, m, y, k) => {
        const R=(1-+c)*(1-+k), G=(1-+m)*(1-+k), B=(1-+y)*(1-+k);
        return (0.2126*R + 0.7152*G + 0.0722*B).toFixed(4);
      };

      // 색상 연산자 치환 함수 (세그먼트 단위 적용)
      const applyOps = seg => {
        // ── rg/RG (RGB) ──
        seg = seg.replace(_MS_RE_rg, (_, r, g, b) => `${lum(r,g,b)} g`);
        seg = seg.replace(_MS_RE_RG, (_, r, g, b) => `${lum(r,g,b)} G`);
        // ── k/K (CMYK) ──
        seg = seg.replace(_MS_RE_k, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
        seg = seg.replace(_MS_RE_K, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
        // ── sc/SC/scn/SCN (명명된 색공간·Separation·DeviceN) ──
        // 처리 순서: 4인수 → 3인수 → 1인수 (다인수 패턴 먼저)
        // 4인수 CMYK 계열
        seg = seg.replace(_MS_RE_SCN4, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
        seg = seg.replace(_MS_RE_scn4, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
        seg = seg.replace(_MS_RE_SC4,  (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
        seg = seg.replace(_MS_RE_sc4,  (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
        // 3인수 RGB 계열
        seg = seg.replace(_MS_RE_SCN3, (_, r, g, b) => `${lum(r,g,b)} G`);
        seg = seg.replace(_MS_RE_scn3, (_, r, g, b) => `${lum(r,g,b)} g`);
        seg = seg.replace(_MS_RE_SC3,  (_, r, g, b) => `${lum(r,g,b)} G`);
        seg = seg.replace(_MS_RE_sc3,  (_, r, g, b) => `${lum(r,g,b)} g`);
        // 1인수 Separation 계열 (tint 1=어둠·0=밝음 → 반전하여 그레이)
        seg = seg.replace(_MS_RE_SCN1, (_, t) => `${(1 - +t).toFixed(4)} G`);
        seg = seg.replace(_MS_RE_scn1, (_, t) => `${(1 - +t).toFixed(4)} g`);
        seg = seg.replace(_MS_RE_SC1,  (_, t) => `${(1 - +t).toFixed(4)} G`);
        seg = seg.replace(_MS_RE_sc1,  (_, t) => `${(1 - +t).toFixed(4)} g`);
        // ── /name cs, /name CS 제거 (색공간 지정 연산자 — 이미 위에서 색값 치환 완료) ──
        seg = seg.replace(/\/\w+\s+cs(?=[\s\r\n]|$)/gm, '');
        seg = seg.replace(/\/\w+\s+CS(?=[\s\r\n]|$)/gm, '');
        return seg;
      };

      // PDF 문자열 리터럴 (...)과 헥스 문자열 <...> 내부는 색상 연산자 치환 대상에서 제외
      // — 바이너리 글리프 ID나 임의 바이트가 패턴과 오인식되어 스트림이 깨지는 것을 방지
      let result = '';
      let i = 0, segStart = 0;

      while (i < s.length) {
        const ch = s[i];

        if (ch === '(') {
          // 이전 일반 구간에 색상 연산자 치환 적용
          result += applyOps(s.slice(segStart, i));
          // 괄호 문자열 통째로 복사 (중첩 괄호 + 백슬래시 이스케이프 처리)
          let depth = 1, j = i + 1;
          while (j < s.length && depth > 0) {
            if (s[j] === '\\') { j += 2; continue; }   // 이스케이프 건너뜀
            if (s[j] === '(') depth++;
            else if (s[j] === ')') depth--;
            j++;
          }
          result += s.slice(i, j);
          i = j; segStart = i;

        } else if (ch === '<' && (i + 1 >= s.length || s[i + 1] !== '<')) {
          // 헥스 문자열 <...> (딕셔너리 << 는 제외)
          const end = s.indexOf('>', i + 1);
          if (end >= 0) {
            result += applyOps(s.slice(segStart, i));
            result += s.slice(i, end + 1);
            i = end + 1; segStart = i;
          } else {
            i++;
          }

        } else {
          i++;
        }
      }
      // 마지막 구간 처리
      result += applyOps(s.slice(segStart));

      return encodeLatin1(result);
    }

    // 전역 dotGain 취득 (UI 드롭다운)
    function getDotGain() {
      const sel = document.getElementById('dotGainSelect');
      return sel ? (parseInt(sel.value) || 0) : 0;
    }
    // 문서(pdfDoc) 단위 dotGain 오버라이드 — 이미 회색으로 판정된 페이지(잉크 정규화 대상)에
    // Dot Gain 보정을 걸면 밝기가 변하므로 그런 변환은 0으로 강제한다. 전역 변수가 아니라
    // WeakMap(문서별)이라 병렬 변환(프리웜 + 적용 동시 진행)에서도 서로 간섭하지 않는다.
    const _dotGainCtx = new WeakMap();
    function ctxDotGain(doc) {
      const o = _dotGainCtx.get(doc);
      return o !== undefined ? o : getDotGain();
    }

    async function convertPageToGrayscaleVector(pdfDoc, pageIdx, stats, dgOverride) {
      if (dgOverride !== undefined) _dotGainCtx.set(pdfDoc, dgOverride);
      const page = pdfDoc.getPage(pageIdx);
      const node = page.node;
      const Nm   = n => PDFLib.PDFName.of(n);
      const dotGain = ctxDotGain(pdfDoc);

      // Filter 이름 해석 — PDFName("/FlateDecode") 또는 배열([/FlateDecode]) 양쪽 대응
      const resolveFilterName = (filterVal) => {
        if (!filterVal) return '';
        if (filterVal.encodedName) return filterVal.encodedName;
        // 배열 형태: [/FlateDecode] → 첫 번째 요소 이름 반환
        if (typeof filterVal.size === 'function' && filterVal.size() === 1) {
          try {
            const f = pdfDoc.context.lookup(filterVal.get(0));
            return f && f.encodedName ? f.encodedName : '';
          } catch(e) {}
        }
        return '';
      };

      // Separation 색공간별 그레이 변환 맵 (페이지 리소스에서 빌드)
      // { '/CsName': { altName, N, c0:[...], c1:[...] } }
      let csGrayMap = {};

      // 콘텐츠 스트림 색상 연산자 변환 (Worker 오프로드)
      const processContentStream = async (streamObj) => {
        if (!streamObj || !streamObj.contents) return;
        const filter = streamObj.dict.get(Nm('Filter'));
        let wasCompressed = false;
        if (filter) {
          const fn = resolveFilterName(filter);
          if (fn === '/FlateDecode' || fn === '/Fl') wasCompressed = true;
          else return;
        }
        try {
          const buf = streamObj.contents.buffer.slice(
            streamObj.contents.byteOffset,
            streamObj.contents.byteOffset + streamObj.contents.byteLength
          );
          const result = await grayWorkerPool.run(
            'stream-grayify',
            { bytes: buf, wasCompressed, csGrayMap, dotGain },
            [buf]
          );
          const out = new Uint8Array(result.bytes, 0, result.length);
          streamObj.contents = out;
          try { streamObj.dict.set(Nm('Length'), PDFLib.PDFNumber.of(out.length)); } catch(e) {}
        } catch(e) { console.warn('stream-grayify 실패:', e); }
      };

      // Resources 딕셔너리 취득 — 페이지 자체에 없으면 부모 Pages 노드까지 상속 탐색
      const findResDict = (dictNode) => {
        if (!dictNode) return null;
        let res = dictNode.get(Nm('Resources'));
        if (res) return pdfDoc.context.lookup(res);
        // 부모 체인 탐색 (다른 페이지 크기 등 상속 구조 대응)
        let parent = dictNode.get(Nm('Parent'));
        while (parent) {
          try {
            const pNode = pdfDoc.context.lookup(parent);
            if (!pNode) break;
            res = pNode.get(Nm('Resources'));
            if (res) return pdfDoc.context.lookup(res);
            parent = pNode.get(Nm('Parent'));
          } catch(e) { break; }
        }
        return null;
      };

      // XObject 리소스 재귀 처리
      // — Form XObject 중첩 이미지까지 모두 변환
      // — depth 제한으로 순환 참조 방지, processedObjs Set으로 중복 처리 방지
      const processedObjs = new Set();
      const processXObjects = async (resDict, depth = 0) => {
        if (!resDict || depth > 6) return;
        const xRef = resDict.get(Nm('XObject'));
        if (!xRef) return;
        const xDict = pdfDoc.context.lookup(xRef);
        if (!xDict || typeof xDict.entries !== 'function') return;

        // 순차 await 대신 병렬 처리 (속도 최적화 — 이미지 여러 장이 동시에 변환됨)
        const xobjTasks = [];
        for (const [, ref] of xDict.entries()) {
          // 이미 처리한 XObject 중복 건너뜀
          const refKey = ref && ref.objectNumber != null
            ? `${ref.objectNumber}_${ref.generationNumber ?? 0}` : null;
          if (refKey) {
            if (processedObjs.has(refKey)) continue;
            processedObjs.add(refKey);
          }

          const xobj = pdfDoc.context.lookup(ref);
          if (!xobj || !xobj.dict) continue;
          const sub = xobj.dict.get(Nm('Subtype'));
          const sn  = sub ? (sub.encodedName || '') : '';

          if (sn === '/Image') {
            xobjTasks.push(convertXObjectImageToGrayscale(pdfDoc, xobj, resDict));
          } else if (sn === '/Form') {
            xobjTasks.push((async () => {
              // Form 콘텐츠 스트림 변환
              await processContentStream(xobj);
              // Transparency Group인 경우 Group/CS → DeviceGray
              // (합성 시 기준 색공간이 남아 있으면 레이어 겹침에서 칼라 잔류)
              try {
                const grpRef = xobj.dict.get(Nm('Group'));
                if (grpRef) {
                  const grp = pdfDoc.context.lookup(grpRef);
                  if (grp && grp.set) grp.set(Nm('CS'), Nm('DeviceGray'));
                }
              } catch(e) {}
              // Form 자신의 Resources도 재귀 처리 (중첩 이미지 대응)
              const formResRef = xobj.dict.get(Nm('Resources'));
              if (formResRef) {
                const formRes = pdfDoc.context.lookup(formResRef);
                await processXObjects(formRes, depth + 1);
                processShading(formRes);
                await processPatterns(formRes, depth + 1);
              }
            })());
          }
        }
        if (xobjTasks.length > 0) await Promise.all(xobjTasks);
      };

      // ── Shading 그라데이션 처리 ─────────────────────────────────────────────────
      // sh 연산자·Shading Pattern으로 참조되는 Shading 리소스를 DeviceGray로 변환
      // Type 1-3 (function-based): ColorSpace + Function 변환
      // Type 4-7 (mesh): 정점 비트스트림의 색상 성분을 직접 그레이로 재작성

      // 숫자/배열 조회 헬퍼 (간접 참조 해결 포함)
      const _shNum = (v) => {
        if (v == null) return null;
        const o = pdfDoc.context.lookup(v) ?? v;
        const n = o.numberValue ?? o.asNumber?.();
        return n != null ? +n : null;
      };
      const _shArr = (ref) => {
        if (!ref) return null;
        const arr = pdfDoc.context.lookup(ref) ?? ref;
        if (!arr || typeof arr.size !== 'function') return null;
        const out = [];
        for (let i = 0; i < arr.size(); i++) {
          const n = _shNum(arr.get(i));
          out.push(n != null ? n : 0);
        }
        return out;
      };
      // ColorSpace → 채널 수/종류 해석 (DeviceRGB/CMYK/Gray, CalRGB/Gray, ICCBased N)
      const _shResolveCS = (csRef) => {
        try {
          if (!csRef) return null;
          const cs = pdfDoc.context.lookup(csRef) ?? csRef;
          const name = cs.encodedName;
          if (name === '/DeviceRGB' || name === '/CalRGB') return { n: 3, kind: 'rgb' };
          if (name === '/DeviceCMYK') return { n: 4, kind: 'cmyk' };
          if (name === '/DeviceGray' || name === '/CalGray') return { n: 1, kind: 'gray' };
          if (typeof cs.size === 'function' && cs.size() > 0) {
            const first = pdfDoc.context.lookup(cs.get(0)) ?? cs.get(0);
            const fn = first?.encodedName || '';
            if (fn === '/ICCBased' && cs.size() > 1) {
              const st = pdfDoc.context.lookup(cs.get(1));
              const n = _shNum(st?.dict?.get?.(Nm('N')) ?? st?.get?.(Nm('N')));
              if (n === 3) return { n: 3, kind: 'rgb' };
              if (n === 4) return { n: 4, kind: 'cmyk' };
              if (n === 1) return { n: 1, kind: 'gray' };
            }
            if (fn === '/CalRGB') return { n: 3, kind: 'rgb' };
            if (fn === '/CalGray') return { n: 1, kind: 'gray' };
            if (fn === '/DeviceRGB') return { n: 3, kind: 'rgb' };
            if (fn === '/DeviceCMYK') return { n: 4, kind: 'cmyk' };
          }
        } catch(e) {}
        return null;
      };
      const _shGrayOf = (comps, kind) => {
        let g;
        if (kind === 'cmyk' && comps.length >= 4) {
          const [c, m, y, k] = comps;
          g = 0.299*(1-c)*(1-k) + 0.587*(1-m)*(1-k) + 0.114*(1-y)*(1-k);
        } else if (comps.length >= 3) {
          g = 0.299*comps[0] + 0.587*comps[1] + 0.114*comps[2];
        } else g = comps[0] ?? 0;
        return Math.max(0, Math.min(1, g));
      };

      // FunctionType 0 (샘플 함수) 출력 → 그레이 변환. dryRun=true면 변환 가능 여부만 검사
      const convertSampledFunc = (fn, dryRun) => {
        try {
          const fd = fn && fn.dict;
          if (!fd || !fn.contents) return false;
          const range = _shArr(fd.get(Nm('Range')));
          if (!range || range.length < 2) return false;
          const nOut = range.length / 2;
          if (nOut === 1) return true;            // 이미 1채널 출력
          if (nOut !== 3 && nOut !== 4) return false;
          const kind = nOut === 4 ? 'cmyk' : 'rgb';
          const bps = _shNum(fd.get(Nm('BitsPerSample')));
          if (![1,2,4,8,16,32].includes(bps)) return false;
          const sizeArr = _shArr(fd.get(Nm('Size')));
          if (!sizeArr || !sizeArr.length) return false;
          const total = sizeArr.reduce((a, b) => a * b, 1);
          if (!total || total > 4e6) return false;
          const filt = fd.get(Nm('Filter'));
          let wasComp = false;
          if (filt) {
            const f = resolveFilterName(filt);
            if (f !== '/FlateDecode' && f !== '/Fl') return false;
            if (fd.get(Nm('DecodeParms')) || fd.get(Nm('DP'))) return false;
            wasComp = true;
          }
          let raw = fn.contents;
          if (wasComp) { try { raw = pako.inflate(raw); } catch(e) { return false; } }
          if (raw.length * 8 < total * nOut * bps) return false;
          if (dryRun) return true;

          const decode = _shArr(fd.get(Nm('Decode'))) || range;  // 기본값 = Range
          const maxS = Math.pow(2, bps) - 1;
          // 비트 리더/라이터 (MSB-first 연속 패킹)
          let rp = 0;
          const rd = () => {
            let v = 0;
            for (let k = 0; k < bps; k++) { v = v * 2 + ((raw[rp >> 3] >> (7 - (rp & 7))) & 1); rp++; }
            return v;
          };
          const out = []; let ob = 0, obn = 0;
          const wr = (v) => {
            for (let k = bps - 1; k >= 0; k--) {
              ob = (ob << 1) | (Math.floor(v / Math.pow(2, k)) % 2); obn++;
              if (obn === 8) { out.push(ob); ob = 0; obn = 0; }
            }
          };
          const comps = new Array(nOut);
          for (let si = 0; si < total; si++) {
            for (let ci = 0; ci < nOut; ci++) {
              const r = rd();
              comps[ci] = decode[ci*2] + (r / maxS) * (decode[ci*2 + 1] - decode[ci*2]);
            }
            wr(Math.round(_shGrayOf(comps, kind) * maxS));
          }
          if (obn > 0) { out.push((ob << (8 - obn)) & 0xff); }
          let newBytes = new Uint8Array(out);
          if (wasComp) newBytes = pako.deflate(newBytes, { level: 1 });
          fn.contents = newBytes;
          fd.set(Nm('Length'), PDFLib.PDFNumber.of(newBytes.length));
          fd.set(Nm('Range'), pdfDoc.context.obj([0, 1]));
          try { fd.delete(Nm('Decode')); } catch(e) {}
          return true;
        } catch(e) { return false; }
      };

      // Function이 그레이로 변환 가능한지 사전 검사 (변환 도중 실패로 인한 반파 상태 방지)
      const _shFuncConvertible = (funcObj, depth = 0) => {
        if (!funcObj || depth > 4) return false;
        const fGet = funcObj.get ? funcObj.get.bind(funcObj) : funcObj.dict?.get?.bind(funcObj.dict);
        if (!fGet) return false;
        const ft = _shNum(fGet(Nm('FunctionType')));
        if (ft === 2) return true;
        if (ft === 0) return convertSampledFunc(funcObj, true);
        if (ft === 3) {
          const fns = pdfDoc.context.lookup(fGet(Nm('Functions')));
          if (!fns || typeof fns.size !== 'function') return false;
          for (let i = 0; i < fns.size(); i++)
            if (!_shFuncConvertible(pdfDoc.context.lookup(fns.get(i)), depth + 1)) return false;
          return true;
        }
        return false;  // Type 4 (PostScript) 등 — 미지원
      };

      const convertShadingFunc = (funcObj) => {
        const fGet = funcObj && (funcObj.get ? funcObj.get.bind(funcObj) : funcObj.dict?.get?.bind(funcObj.dict));
        if (!fGet) return;
        try {
          const ftObj = fGet(Nm('FunctionType'));
          const ft = ftObj != null ? +(ftObj.numberValue ?? ftObj.asNumber?.() ?? -1) : -1;
          if (ft === 0) { convertSampledFunc(funcObj, false); return; }
          if (ft === 2) {
            // Type 2 지수함수: C0/C1 → 그레이 값으로 교체
            const getColorArr = (key) => {
              const ref = funcObj.get(Nm(key));
              if (!ref) return null;
              const arr = pdfDoc.context.lookup(ref);
              if (!arr || typeof arr.size !== 'function') {
                const n = ref.numberValue ?? ref.asNumber?.();
                return n != null ? [+n] : null;
              }
              return Array.from({ length: arr.size() }, (_, i) => {
                const v = pdfDoc.context.lookup(arr.get(i));
                return v != null ? +(v.numberValue ?? v.asNumber?.() ?? 0) : 0;
              });
            };
            const c0 = getColorArr('C0') || [0];
            const c1 = getColorArr('C1') || [1];
            const toGray = (ch) => {
              if (ch.length >= 4) {
                const [c, m, y, k] = ch;
                return 0.299*(1-c)*(1-k) + 0.587*(1-m)*(1-k) + 0.114*(1-y)*(1-k);
              } else if (ch.length >= 3) {
                return 0.299*ch[0] + 0.587*ch[1] + 0.114*ch[2];
              }
              return ch[0];
            };
            const g0 = Math.max(0, Math.min(1, toGray(c0)));
            const g1 = Math.max(0, Math.min(1, toGray(c1)));
            funcObj.set(Nm('C0'), pdfDoc.context.obj([g0]));
            funcObj.set(Nm('C1'), pdfDoc.context.obj([g1]));
            try { funcObj.set(Nm('Range'), pdfDoc.context.obj([0, 1])); } catch(e) {}
          } else if (ft === 3) {
            // Type 3 stitching: 하위 함수 배열 재귀 처리
            const fnsRef = funcObj.get(Nm('Functions'));
            if (!fnsRef) return;
            const fns = pdfDoc.context.lookup(fnsRef);
            if (!fns || typeof fns.size !== 'function') return;
            for (let i = 0; i < fns.size(); i++) {
              try { convertShadingFunc(pdfDoc.context.lookup(fns.get(i))); } catch(e) {}
            }
          }
        } catch(e) {}
      };

      // ── Type 4-7 mesh shading: 정점 비트스트림의 색상 성분을 그레이로 재작성 ──
      // 스트림 구조 (PDF 32000 §8.7.4.5.5~8):
      //   Type 4: [flag][x][y][c1..cn]  — 정점마다 바이트 경계 패딩
      //   Type 5: [x][y][c1..cn]        — 연속 패킹 (VerticesPerRow 단위)
      //   Type 6: [flag][12 or 8 점][4 or 2 색]  — 패치마다 바이트 경계 패딩
      //   Type 7: [flag][16 or 12 점][4 or 2 색] — 패치마다 바이트 경계 패딩
      const convertMeshShading = (shd, stype, csInfo) => {
        try {
          const dict = shd.dict;
          if (!dict || !shd.contents || !csInfo || csInfo.n < 1) return;
          if (csInfo.n === 1) { dict.set(Nm('ColorSpace'), Nm('DeviceGray')); return; }
          const bpc  = _shNum(dict.get(Nm('BitsPerCoordinate')));
          const bpcm = _shNum(dict.get(Nm('BitsPerComponent')));
          const bpf  = stype === 5 ? 0 : _shNum(dict.get(Nm('BitsPerFlag')));
          if (!bpc || !bpcm || (stype !== 5 && !bpf)) return;
          if (bpc > 32 || bpcm > 16) return;
          const dec = _shArr(dict.get(Nm('Decode')));
          if (!dec || dec.length < 4 + csInfo.n * 2) return;

          // 압축 해제 (FlateDecode만, predictor 없을 때만 — 그 외 안전 통과)
          let raw = shd.contents;
          let wasComp = false;
          const filt = dict.get(Nm('Filter'));
          if (filt) {
            const f = resolveFilterName(filt);
            if (f !== '/FlateDecode' && f !== '/Fl') return;
            if (dict.get(Nm('DecodeParms')) || dict.get(Nm('DP'))) return;
            try { raw = pako.inflate(raw); } catch(e) { return; }
            wasComp = true;
          }

          // 비트 리더/라이터 (MSB-first)
          const totalBits = raw.length * 8;
          let rp = 0;
          const rd = (n) => {
            let v = 0;
            for (let k = 0; k < n; k++) { v = v * 2 + ((raw[rp >> 3] >> (7 - (rp & 7))) & 1); rp++; }
            return v;
          };
          const out = []; let ob = 0, obn = 0;
          const wr = (v, n) => {
            for (let k = n - 1; k >= 0; k--) {
              ob = (ob << 1) | (Math.floor(v / Math.pow(2, k)) % 2); obn++;
              if (obn === 8) { out.push(ob & 0xff); ob = 0; obn = 0; }
            }
          };
          const cp = (n) => wr(rd(n), n);                       // 그대로 복사
          const alignR = () => { rp = (rp + 7) & ~7; };
          const alignW = () => { if (obn > 0) { out.push((ob << (8 - obn)) & 0xff); ob = 0; obn = 0; } };

          const maxC = Math.pow(2, bpcm) - 1;
          const comps = new Array(csInfo.n);
          const grayComp = () => {                              // n개 색상 성분 → 그레이 1개
            for (let ci = 0; ci < csInfo.n; ci++) {
              const r = rd(bpcm);
              comps[ci] = dec[4 + ci*2] + (r / maxC) * (dec[4 + ci*2 + 1] - dec[4 + ci*2]);
            }
            wr(Math.round(_shGrayOf(comps, csInfo.kind) * maxC), bpcm);
          };

          if (stype === 4) {
            const recBits = bpf + 2*bpc + csInfo.n*bpcm;
            while (rp + recBits <= totalBits) {
              cp(bpf); cp(bpc); cp(bpc);
              grayComp();
              alignR(); alignW();
            }
          } else if (stype === 5) {
            const recBits = 2*bpc + csInfo.n*bpcm;
            while (rp + recBits <= totalBits) {
              cp(bpc); cp(bpc);
              grayComp();
            }
          } else {  // 6 (Coons), 7 (tensor)
            const npts0 = stype === 7 ? 16 : 12, nptsN = stype === 7 ? 12 : 8;
            while (rp + bpf <= totalBits) {
              const save = rp;
              const flag = rd(bpf);
              const npts = flag === 0 ? npts0 : nptsN;
              const ncol = flag === 0 ? 4 : 2;
              if (flag > 3 || rp + npts*2*bpc + ncol*csInfo.n*bpcm > totalBits) { rp = save; break; }
              wr(flag, bpf);
              for (let p = 0; p < npts * 2; p++) cp(bpc);
              for (let c = 0; c < ncol; c++) grayComp();
              alignR(); alignW();
            }
          }
          alignW();

          // 스트림 거의 전체를 소비하지 못했다면 구조 해석 실패 — 원본 유지
          if (totalBits - rp > 128) return;

          let newBytes = new Uint8Array(out);
          if (wasComp) newBytes = pako.deflate(newBytes, { level: 1 });
          shd.contents = newBytes;
          dict.set(Nm('Length'), PDFLib.PDFNumber.of(newBytes.length));
          dict.set(Nm('Decode'), pdfDoc.context.obj(dec.slice(0, 4).concat([0, 1])));
          dict.set(Nm('ColorSpace'), Nm('DeviceGray'));
        } catch(e) {}
      };

      // Shading 1개 변환 (sh 연산자 리소스·Shading Pattern 공용)
      const convertOneShading = (shd) => {
        try {
          const sDict = shd && (shd.dict || (shd.get ? shd : null));
          if (!sDict || !sDict.get) return;
          const stype = _shNum(sDict.get(Nm('ShadingType'))) || 0;
          if (stype < 1 || stype > 7) return;
          const csInfo = _shResolveCS(sDict.get(Nm('ColorSpace')));   // CS 변경 전에 해석
          const funcRef = sDict.get(Nm('Function'));
          const funcObj = funcRef ? pdfDoc.context.lookup(funcRef) : null;
          // Function 배열(1-out 함수 n개)은 단일 그레이 함수로 합성 불가 — 안전 통과
          if (funcObj && typeof funcObj.size === 'function') return;

          if (funcObj) {
            // 정점/도메인 데이터는 t값 그대로 — 함수 출력만 그레이로
            if (!_shFuncConvertible(funcObj)) return;   // 변환 불가 함수 — 렌더링 보존 우선
            convertShadingFunc(funcObj);
            sDict.set(Nm('ColorSpace'), Nm('DeviceGray'));
          } else if (stype >= 4 && stype <= 7) {
            convertMeshShading(shd, stype, csInfo);
          } else {
            sDict.set(Nm('ColorSpace'), Nm('DeviceGray'));
          }

          // Background [c1..cn] → [gray]
          if (csInfo && csInfo.n > 1) {
            const bg = _shArr(sDict.get(Nm('Background')));
            if (bg && bg.length >= csInfo.n)
              sDict.set(Nm('Background'), pdfDoc.context.obj([_shGrayOf(bg, csInfo.kind)]));
          }
        } catch(e) {}
      };

      const processShading = (resDict) => {
        if (!resDict) return;
        try {
          const shRef = resDict.get(Nm('Shading'));
          if (!shRef) return;
          const shDict = pdfDoc.context.lookup(shRef);
          if (!shDict || typeof shDict.entries !== 'function') return;
          for (const [, shdRef] of shDict.entries()) {
            try {
              // 공유 객체 중복 변환 방지 (mesh 재작성·함수 변환은 2회 적용 시 왜곡)
              const refKey = shdRef && shdRef.objectNumber != null
                ? `${shdRef.objectNumber}_${shdRef.generationNumber ?? 0}` : null;
              if (refKey) {
                if (processedObjs.has(refKey)) continue;
                processedObjs.add(refKey);
              }
              convertOneShading(pdfDoc.context.lookup(shdRef));
            } catch(e) {}
          }
        } catch(e) {}
      };

      // ExtGState의 SMask Form XObject 처리
      // gs 연산자로 참조되는 그래픽스 상태의 SMask는 별도 Form XObject(투명 마스크 그룹) 포함
      // → 변환하지 않으면 투명도 합성(레이어 겹침) 시 칼라 잔류
      const processExtGState = async (resDict, depth = 0) => {
        if (!resDict || depth > 6) return;
        const egRef = resDict.get(Nm('ExtGState'));
        if (!egRef) return;
        const egDict = pdfDoc.context.lookup(egRef);
        if (!egDict || typeof egDict.entries !== 'function') return;
        // 순차 await 대신 병렬 처리 (속도 최적화)
        const egTasks = [];
        for (const [, gsRef] of egDict.entries()) {
          try {
            const gs = pdfDoc.context.lookup(gsRef);
            if (!gs || !gs.get) continue;
            const smRef = gs.get(Nm('SMask'));
            if (!smRef || smRef.encodedName === '/None') continue;
            const sm = pdfDoc.context.lookup(smRef);
            if (!sm || !sm.get) continue;
            const gRef = sm.get(Nm('G'));
            if (!gRef) continue;
            const refKey = gRef.objectNumber != null
              ? `${gRef.objectNumber}_${gRef.generationNumber ?? 0}` : null;
            if (refKey && processedObjs.has(refKey)) continue;
            if (refKey) processedObjs.add(refKey);
            const gForm = pdfDoc.context.lookup(gRef);
            if (!gForm || !gForm.dict) continue;
            // SMask 투명도 그룹 색공간 → DeviceGray
            // + 배경색 /BC도 새 색공간(DeviceGray, 1채널)에 맞춰 변환.
            //   그대로 두면 옛 RGB/CMYK 채널수(3~4)와 불일치 → GS "Group /BC differs
            //   in number of components" / Acrobat "이 페이지에 오류가 있습니다".
            try {
              const grpRef = gForm.dict.get(Nm('Group'));
              if (grpRef) {
                const grp = pdfDoc.context.lookup(grpRef);
                if (grp && grp.set) grp.set(Nm('CS'), Nm('DeviceGray'));
              }
              const bc = sm.get(Nm('BC'));
              if (bc && typeof bc.size === 'function') {
                const bn = bc.size();
                const bnum = (i) => {
                  const o = pdfDoc.context.lookup(bc.get(i)) ?? bc.get(i);
                  return +(o.numberValue ?? o.asNumber?.() ?? 0);
                };
                let bgray;
                if (bn === 4) { const c=bnum(0),m=bnum(1),y=bnum(2),k=bnum(3);
                  bgray = 0.299*(1-c)*(1-k) + 0.587*(1-m)*(1-k) + 0.114*(1-y)*(1-k); }
                else if (bn >= 3) { bgray = 0.299*bnum(0) + 0.587*bnum(1) + 0.114*bnum(2); }
                else { bgray = bnum(0); }
                bgray = Math.max(0, Math.min(1, bgray));
                sm.set(Nm('BC'), pdfDoc.context.obj([PDFLib.PDFNumber.of(bgray)]));
              }
            } catch(e) {}
            egTasks.push((async () => {
              try {
                // SMask Form 콘텐츠 스트림 변환
                await processContentStream(gForm);
                // SMask Form 내부 리소스 재귀 처리
                const fResRef = gForm.dict.get(Nm('Resources'));
                if (fResRef) {
                  const fRes = pdfDoc.context.lookup(fResRef);
                  await processXObjects(fRes, depth + 1);
                  await processExtGState(fRes, depth + 1);
                  processShading(fRes);
                  await processPatterns(fRes, depth + 1);
                }
              } catch(e) {}
            })());
          } catch(e) {}
        }
        if (egTasks.length > 0) await Promise.all(egTasks);
      };

      // ── Pattern 리소스 처리 ─────────────────────────────────────────────────
      // scn/SCN의 /P0 등으로 호출되는 패턴은 자체 색상 정의를 갖고 있어 별도 변환 필요
      //   PatternType 2 (Shading Pattern): 내부 Shading을 그레이 변환 ← 그라데이션 채우기의 주 경로
      //   PatternType 1 (Tiling Pattern): 자체 콘텐츠 스트림 + Resources 재귀 변환
      const processPatterns = async (resDict, depth = 0) => {
        if (!resDict || depth > 6) return;
        const patRef = resDict.get(Nm('Pattern'));
        if (!patRef) return;
        const patDict = pdfDoc.context.lookup(patRef);
        if (!patDict || typeof patDict.entries !== 'function') return;
        const patTasks = [];
        for (const [, pRef] of patDict.entries()) {
          try {
            const refKey = pRef && pRef.objectNumber != null
              ? `${pRef.objectNumber}_${pRef.generationNumber ?? 0}` : null;
            if (refKey) {
              if (processedObjs.has(refKey)) continue;
              processedObjs.add(refKey);
            }
            const pat = pdfDoc.context.lookup(pRef);
            if (!pat) continue;
            const pGet = pat.get ? pat.get.bind(pat) : pat.dict?.get?.bind(pat.dict);
            if (!pGet) continue;
            const ptype = _shNum(pGet(Nm('PatternType'))) || 0;
            if (ptype === 2) {
              // Shading Pattern — Shading 항목만 변환 (딕셔너리형)
              const shdRef = pGet(Nm('Shading'));
              if (shdRef) {
                const sKey = shdRef.objectNumber != null
                  ? `${shdRef.objectNumber}_${shdRef.generationNumber ?? 0}` : null;
                if (sKey && processedObjs.has(sKey)) continue;
                if (sKey) processedObjs.add(sKey);
                convertOneShading(pdfDoc.context.lookup(shdRef) ?? shdRef);
              }
            } else if (ptype === 1 && pat.dict && pat.contents) {
              // Tiling Pattern — 콘텐츠 스트림(색상 연산자) + 내부 리소스 변환
              patTasks.push((async () => {
                try {
                  await processContentStream(pat);
                  const rRef = pat.dict.get(Nm('Resources'));
                  if (rRef) {
                    const r = pdfDoc.context.lookup(rRef);
                    await processXObjects(r, depth + 1);
                    await processExtGState(r, depth + 1);
                    processShading(r);
                    await processPatterns(r, depth + 1);
                  }
                } catch(e) {}
              })());
            }
          } catch(e) {}
        }
        if (patTasks.length > 0) await Promise.all(patTasks);
      };

      // ── 주석(/Annots) 처리 ──────────────────────────────────────────────────
      // 스탬프·서명·도형·하이라이트·양식필드 등 주석은 페이지 콘텐츠/리소스가 아니라
      // 주석 딕셔너리의 외형 스트림(AP /N,/D,/R = Form XObject)으로 인쇄된다. 여기를 변환하지
      // 않으면 컬러 주석이 색 잉크로 남는다. 색 배열(/C 테두리·/IC 내부·MK /BG,/BC)도 그레이화.
      const grayColorArray = (d, key) => {
        try {
          const ref = d.get(Nm(key));
          if (!ref) return;
          const arr = pdfDoc.context.lookup(ref);
          if (!arr || typeof arr.size !== 'function') return;
          const n = arr.size();
          if (n < 3) return;   // 0=색없음(투명) · 1=이미 그레이
          const num = i => { const o = pdfDoc.context.lookup(arr.get(i)) ?? arr.get(i); return +(o.numberValue ?? o.asNumber?.() ?? 0); };
          let g;
          if (n === 4) { const c=num(0),m=num(1),y=num(2),k=num(3); g = 0.299*(1-c)*(1-k)+0.587*(1-m)*(1-k)+0.114*(1-y)*(1-k); }
          else { g = 0.299*num(0)+0.587*num(1)+0.114*num(2); }
          d.set(Nm(key), pdfDoc.context.obj([Math.max(0, Math.min(1, g))]));
        } catch(e) {}
      };
      const processAnnots = async () => {
        try {
          const annotsRef = node.get(Nm('Annots'));
          if (!annotsRef) return;
          const annots = pdfDoc.context.lookup(annotsRef);
          if (!annots || typeof annots.size !== 'function') return;
          const tasks = [];
          for (let i = 0; i < annots.size(); i++) {
            try {
              const an = pdfDoc.context.lookup(annots.get(i));
              if (!an || !an.get) continue;
              grayColorArray(an, 'C'); grayColorArray(an, 'IC');
              try { const mkRef = an.get(Nm('MK')); if (mkRef) { const mk = pdfDoc.context.lookup(mkRef); if (mk && mk.get) { grayColorArray(mk, 'BG'); grayColorArray(mk, 'BC'); } } } catch(e) {}
              const apRef = an.get(Nm('AP'));
              if (!apRef) continue;
              const ap = pdfDoc.context.lookup(apRef);
              if (!ap || !ap.get) continue;
              for (const key of ['N', 'D', 'R']) {
                const sRef = ap.get(Nm(key));
                if (!sRef) continue;
                const sObj = pdfDoc.context.lookup(sRef);
                if (!sObj) continue;
                // 스트림이면 그대로, 상태별 외형 딕셔너리(체크박스 등)면 각 항목 수집
                const forms = [];
                if (sObj.dict && sObj.contents) forms.push(sObj);
                else if (typeof sObj.entries === 'function') {
                  for (const [, stRef] of sObj.entries()) { try { const st = pdfDoc.context.lookup(stRef); if (st && st.dict && st.contents) forms.push(st); } catch(e) {} }
                }
                for (const form of forms) {
                  const rk = form.contents && form.dict && form.dict.get ? null : null; // dedup by ref below
                  tasks.push((async () => {
                    try {
                      await processContentStream(form);
                      try { const grpRef = form.dict.get(Nm('Group')); if (grpRef) { const grp = pdfDoc.context.lookup(grpRef); if (grp && grp.set) grp.set(Nm('CS'), Nm('DeviceGray')); } } catch(e) {}
                      const rRef = form.dict.get(Nm('Resources'));
                      if (rRef) {
                        const r = pdfDoc.context.lookup(rRef);
                        await processXObjects(r, 1); await processExtGState(r, 1); processShading(r); await processPatterns(r, 1);
                      }
                    } catch(e) {}
                  })());
                }
              }
            } catch(e) {}
          }
          if (tasks.length) await Promise.all(tasks);
        } catch(e) {}
      };

      // 페이지 Resources 취득 + csGrayMap 빌드 (①보다 먼저 실행해야 함)
      const resDict = findResDict(node);
      if (resDict) {
        try {
          const csResRef = resDict.get(Nm('ColorSpace'));
          if (csResRef) {
            const csResDict = pdfDoc.context.lookup(csResRef);
            if (csResDict && typeof csResDict.entries === 'function') {
              for (const [csNameObj, csValRef] of csResDict.entries()) {
                try {
                  const csName = typeof csNameObj === 'string' ? csNameObj
                    : (csNameObj.encodedName || String(csNameObj));
                  const csArr = pdfDoc.context.lookup(csValRef);
                  // Pattern 색공간: cs/CS 연산자 제거 금지 표시
                  if (csArr && typeof csArr.size === 'function') {
                    const csType0 = (pdfDoc.context.lookup(csArr.get(0)))?.encodedName || '';
                    if (csType0 === '/Pattern') { csGrayMap[csName] = { type: 'Pattern' }; continue; }
                  } else if (csArr && csArr.encodedName === '/Pattern') {
                    csGrayMap[csName] = { type: 'Pattern' }; continue;
                  }
                  if (!csArr || typeof csArr.size !== 'function' || csArr.size() < 4) continue;
                  const csType = (pdfDoc.context.lookup(csArr.get(0)))?.encodedName || '';
                  if (csType !== '/Separation') continue;
                  // altSpaceName (index 2)
                  const altObj = pdfDoc.context.lookup(csArr.get(2));
                  const altName = altObj?.encodedName || '';
                  // tintTransform function (index 3)
                  const funcRef = csArr.get(3);
                  const funcObj = pdfDoc.context.lookup(funcRef);
                  if (!funcObj?.get) continue;
                  const ftObj = funcObj.get(Nm('FunctionType'));
                  const ft = ftObj != null ? +(ftObj.numberValue ?? ftObj.asNumber?.() ?? -1) : -1;
                  if (ft !== 2) continue; // Type 2 (exponential) 만 처리
                  const nObj = funcObj.get(Nm('N'));
                  const N = nObj != null ? +(nObj.numberValue ?? nObj.asNumber?.() ?? 1) : 1;
                  const getNumArr = key => {
                    const ref = funcObj.get(Nm(key));
                    if (!ref) return null;
                    const arr = pdfDoc.context.lookup(ref);
                    if (!arr || typeof arr.size !== 'function') return null;
                    return Array.from({ length: arr.size() }, (_, i) => {
                      const v = pdfDoc.context.lookup(arr.get(i));
                      return v != null ? +(v.numberValue ?? v.asNumber?.() ?? 0) : 0;
                    });
                  };
                  const c0 = getNumArr('C0');
                  const c1 = getNumArr('C1');
                  if (c0 && c1 && c0.length === c1.length) {
                    csGrayMap[csName] = { altName, N, c0, c1 };
                  }
                } catch(e) { /* 개별 색공간 파싱 실패는 무시 */ }
              }
            }
          }
        } catch(e) {}
      }

      // ① 페이지 콘텐츠 스트림 변환
      const contentsVal = node.get(Nm('Contents'));
      if (contentsVal) {
        const contentsObj = pdfDoc.context.lookup(contentsVal);
        if (contentsObj && typeof contentsObj.size === 'function') {
          const streamPromises = [];
          for (let i = 0; i < contentsObj.size(); i++)
            streamPromises.push(processContentStream(pdfDoc.context.lookup(contentsObj.get(i))));
          await Promise.all(streamPromises);
        } else {
          await processContentStream(contentsObj);
        }
      }

      // ② XObject 리소스 처리 (Resources 상속 탐색 + Form XObject 재귀 포함)
      await processXObjects(resDict);

      // ② ExtGState SMask Form XObject 처리 (레이어 합성 투명도)
      await processExtGState(resDict);

      // ② Shading 그라데이션 처리 (sh 연산자 참조 리소스)
      processShading(resDict);

      // ② Pattern 처리 (Shading Pattern 그라데이션 채우기 + Tiling Pattern)
      await processPatterns(resDict);

      // ② 페이지 자체의 투명도 그룹 색공간 → DeviceGray
      try {
        const pageGrpRef = node.get(Nm('Group'));
        if (pageGrpRef) {
          const pageGrp = pdfDoc.context.lookup(pageGrpRef);
          if (pageGrp && pageGrp.set) pageGrp.set(Nm('CS'), Nm('DeviceGray'));
        }
      } catch(e) {}

      // ② 주석(/Annots) 외형 스트림·색 배열 그레이화 (컬러 스탬프·서명·양식필드 잔류 방지)
      await processAnnots();

      // ③ 명명된 색공간 리소스 정리
      // Separation /All DeviceCMYK 등 비-그레이 색공간을 Resources.ColorSpace에서 제거
      // → 프린터 RIP이 리소스 딕셔너리를 스캔해서 칼라로 오인식하는 것을 방지
      if (resDict) {
        try {
          const csResRef = resDict.get(Nm('ColorSpace'));
          if (csResRef) {
            const csResDict = pdfDoc.context.lookup(csResRef);
            if (csResDict && typeof csResDict.entries === 'function') {
              // 변환 후에도 XObject가 여전히 참조 중인 색공간은 보존
              // (변환 실패한 이미지의 색공간을 지우면 Acrobat 렌더링 오류 발생)
              const stillUsedCSNames = new Set();
              try {
                const xRef2 = resDict.get(Nm('XObject'));
                if (xRef2) {
                  const xDict2 = pdfDoc.context.lookup(xRef2);
                  if (xDict2 && typeof xDict2.entries === 'function') {
                    for (const [, xObjRef2] of xDict2.entries()) {
                      try {
                        const xobj2 = pdfDoc.context.lookup(xObjRef2);
                        if (!xobj2 || !xobj2.dict) continue;
                        let cs2 = xobj2.dict.get(Nm('ColorSpace'));
                        if (!cs2) continue;
                        if (cs2.objectNumber != null) cs2 = pdfDoc.context.lookup(cs2);
                        if (cs2 && cs2.encodedName) stillUsedCSNames.add(cs2.encodedName.replace(/^\//, ''));
                      } catch(e2) {}
                    }
                  }
                }
              } catch(e2) {}

              const toDelete = [];
              for (const [csName, csValRef] of csResDict.entries()) {
                // 아직 XObject에서 참조 중이면 보존
                const keyStr = typeof csName === 'string' ? csName
                  : (csName.encodedName || '').replace(/^\//, '');
                if (stillUsedCSNames.has(keyStr)) continue;
                try {
                  const csObj = pdfDoc.context.lookup(csValRef);
                  const firstName = csObj && typeof csObj.size === 'function'
                    ? (pdfDoc.context.lookup(csObj.get(0))?.encodedName || '')
                    : (csObj?.encodedName || '');
                  // DeviceGray / CalGray / Pattern 색공간은 보존
                  if (firstName !== '/DeviceGray' && firstName !== '/CalGray' && firstName !== '/Pattern') {
                    toDelete.push(csName);
                  }
                } catch(e) { toDelete.push(csName); }
              }
              for (const csName of toDelete) csResDict.delete(csName);
            }
          }
        } catch(e) {}
      }
    }

    async function convertXObjectImageToGrayscale(pdfDoc, img, resDict) {
      if (!img || !img.dict || !img.contents) return;
      const Nm = n => PDFLib.PDFName.of(n);

      // ColorSpace 해석 (간접 참조 + 명명된 색공간 해결)
      let csCheck = img.dict.get(Nm('ColorSpace'));
      if (csCheck && csCheck.objectNumber != null) {
        try { csCheck = pdfDoc.context.lookup(csCheck); } catch(e) {}
      }
      // 명명된 색공간 (예: /Cs1) → Resources.ColorSpace에서 실제 정의로 해결
      if (csCheck && csCheck.encodedName && resDict &&
          !['/DeviceGray','/DeviceRGB','/DeviceCMYK','/CalGray','/CalRGB'].includes(csCheck.encodedName)) {
        try {
          const csResDict = pdfDoc.context.lookup(resDict.get(Nm('ColorSpace')));
          if (csResDict) {
            const realRef = csResDict.get(Nm(csCheck.encodedName.replace(/^\//, '')));
            if (realRef) {
              const resolved = pdfDoc.context.lookup(realRef);
              if (resolved) csCheck = resolved;
            }
          }
        } catch(e) {}
      }
      const csnCheck = csCheck ? (csCheck.encodedName || '') : '';
      // 이미 흑백이면 건너뜀
      if (csnCheck === '/DeviceGray' || csnCheck === '/CalGray') return;
      // ImageMask는 색상 없음 — 건너뜀
      try {
        const im = img.dict.get(Nm('ImageMask'));
        if (im && (im === PDFLib.PDFBool.True || im.asBoolean?.() === true || String(im) === 'true')) return;
      } catch(e) {}

      // ── 색공간 우선 라우팅 (필터와 무관하게 처리 가능한 유형) ──
      if (csCheck && typeof csCheck.size === 'function' && csCheck.size() > 0) {
        let first = null;
        try { first = pdfDoc.context.lookup(csCheck.get(0)) ?? csCheck.get(0); } catch(e) {}
        const firstName = first && first.encodedName ? first.encodedName : '';
        if (firstName === '/Indexed') {
          // 팔레트만 교체 — 픽셀 무수정 (손상 스트림 안전, 고속)
          convertIndexedImagePalette(pdfDoc, img, csCheck);
          return;
        }
        if (firstName === '/Separation') {
          await convertSeparationImage(pdfDoc, img, csCheck);
          return;
        }
      }

      // Filter 취득 — PDFName 또는 배열([/FlateDecode]) 모두 처리
      const fn = imgFilterNameOf(pdfDoc, img.dict);
      if (fn === '[multi]') return;  // 멀티 필터는 건너뜀

      if (fn === '/DCTDecode' || fn === '/DCT')
        await convertJpegXObjectToGrayscale(pdfDoc, img);
      else if (fn === '/FlateDecode' || fn === '/Fl')
        await convertFlateXObjectToGrayscale(pdfDoc, img, resDict, false);
      else if (fn === '/JPXDecode')
        await convertJpxXObjectToGrayscale(pdfDoc, img);
      else if (fn === '')
        // 비압축(Filter 없음) RGB/CMYK 이미지 — raw 모드로 변환
        await convertFlateXObjectToGrayscale(pdfDoc, img, resDict, true);
    }

    // 부모 이미지가 흑백 변환된 후, 그 SMask의 /Matte(언프리멀티플라이 배경색)도
    // 부모의 새 색공간(DeviceGray, 1채널)에 맞춰 갱신해야 함.
    // 그대로 두면 옛 RGB/CMYK 채널 수(3~4개)와 불일치해 Acrobat이
    // "Acrobat이 페이지를 제대로 표시하지 못할 수 있습니다" 오류를 내고 이미지가 사라짐.
    function fixSMaskMatte(pdfDoc, img) {
      try {
        const Nm = n => PDFLib.PDFName.of(n);
        const smaskRef = img.dict.get(Nm('SMask'));
        if (!smaskRef) return;
        const smaskObj = pdfDoc.context.lookup(smaskRef);
        if (!smaskObj || !smaskObj.dict) return;
        const matte = smaskObj.dict.get(Nm('Matte'));
        if (!matte || typeof matte.size !== 'function') return;
        const n = matte.size();
        const num = (i) => {
          const o = pdfDoc.context.lookup(matte.get(i)) ?? matte.get(i);
          return +(o.numberValue ?? o.asNumber?.() ?? 0);
        };
        let r = 0, g = 0, b = 0;
        if (n >= 4) { const c = num(0), m = num(1), y = num(2), k = num(3); r = (1-c)*(1-k); g = (1-m)*(1-k); b = (1-y)*(1-k); }
        else if (n === 3) { r = num(0); g = num(1); b = num(2); }
        else if (n === 1) { r = g = b = num(0); }
        const gray = Math.max(0, Math.min(1, 0.299*r + 0.587*g + 0.114*b));
        // ★ /Matte 성분 수는 '부모 이미지'의 색공간과 일치해야 한다 (Acrobat 오류 방지).
        //   흑백 변환 후 부모 색공간이 DeviceGray(1)일 수도, JPEG 재인코딩으로 DeviceRGB(3)일 수도 있음.
        const csName = img.dict.get(Nm('ColorSpace'));
        const csn = csName && csName.encodedName;
        const comps = csn === '/DeviceRGB' ? 3 : csn === '/DeviceCMYK' ? 4 : 1;
        let arr;
        if (comps === 3) arr = [gray, gray, gray];
        else if (comps === 4) arr = [0, 0, 0, 1 - gray]; // 중성 회색 = K only
        else arr = [gray];
        smaskObj.dict.set(Nm('Matte'), pdfDoc.context.obj(arr.map(v => PDFLib.PDFNumber.of(v))));
      } catch(e) {}
    }

    async function convertJpegXObjectToGrayscale(pdfDoc, img, tintLUT = null) {
      try {
        const jpegBuf = img.contents.buffer.slice(
          img.contents.byteOffset,
          img.contents.byteOffset + img.contents.byteLength
        );
        // tintLUT: Separation 이미지의 틴트→그레이 변환표 (1채널 JPEG 픽셀값 = 틴트 t)
        const lutBuf = tintLUT ? tintLUT.buffer.slice(tintLUT.byteOffset, tintLUT.byteOffset + tintLUT.byteLength) : null;
        const res = await grayWorkerPool.run(
          'jpeg2gray',
          { jpegBytes: jpegBuf, dotGain: ctxDotGain(pdfDoc), lut: lutBuf },
          lutBuf ? [jpegBuf, lutBuf] : [jpegBuf]
        );
        const { w, h } = res;
        const Nm = n => PDFLib.PDFName.of(n);
        if (res.jpeg) {
          // ★ 흑백을 JPEG(DCTDecode)로 유지 → 용량 최소화. 중성 회색(R=G=B) RGB.
          const jbytes = new Uint8Array(res.jpeg);
          img.contents = jbytes;
          img.dict.set(Nm('Length'),           PDFLib.PDFNumber.of(jbytes.length));
          img.dict.set(Nm('Filter'),           Nm('DCTDecode'));
          img.dict.set(Nm('ColorSpace'),       Nm('DeviceRGB'));
          img.dict.set(Nm('BitsPerComponent'), PDFLib.PDFNumber.of(8));
          img.dict.set(Nm('Width'),            PDFLib.PDFNumber.of(w));
          img.dict.set(Nm('Height'),           PDFLib.PDFNumber.of(h));
          img.dict.delete(Nm('DecodeParms'));  // DCTDecode에는 predictor 없음
        } else {
          // 폴백: FlateDecode + DeviceGray
          const compressed = new Uint8Array(res.deflated);
          img.contents = compressed;
          img.dict.set(Nm('Length'),           PDFLib.PDFNumber.of(compressed.length));
          img.dict.set(Nm('Filter'),           Nm('FlateDecode'));
          img.dict.set(Nm('ColorSpace'),       Nm('DeviceGray'));
          img.dict.set(Nm('BitsPerComponent'), PDFLib.PDFNumber.of(8));
          img.dict.set(Nm('Width'),            PDFLib.PDFNumber.of(w));
          img.dict.set(Nm('Height'),           PDFLib.PDFNumber.of(h));
          img.dict.set(Nm('DecodeParms'), pdfDoc.context.obj({
            Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: w,
          }));
        }
        img.dict.delete(Nm('Mask'));
        img.dict.delete(Nm('ImageMask'));
        img.dict.delete(Nm('Intent'));
        img.dict.delete(Nm('Alternates'));
        img.dict.delete(Nm('Decode'));       // RGB/CMYK Decode 배열 제거 (채널 수 불일치 방지)
        img.dict.delete(Nm('Matte'));
        img.dict.delete(Nm('SMaskInData'));
        fixSMaskMatte(pdfDoc, img);
      } catch(e) { console.warn('JPEG 그레이스케일 변환 실패:', e); }
    }

    async function convertJpxXObjectToGrayscale(pdfDoc, img) {
      // JPEG 2000 (JPXDecode): canvas 방식으로 디코딩 시도
      // Chromium/Electron은 JPEG 2000을 기본 지원하지 않아 실패할 수 있음 → 그 경우 건너뜀
      try {
        const Nm = n => PDFLib.PDFName.of(n);
        const wO = img.dict.get(Nm('Width')), hO = img.dict.get(Nm('Height'));
        const w = wO ? (wO.numberValue ?? wO.asNumber?.() ?? 0) : 0;
        const h = hO ? (hO.numberValue ?? hO.asNumber?.() ?? 0) : 0;

        const blob = new Blob([img.contents], { type: 'image/jp2' });
        const url  = URL.createObjectURL(blob);
        const { grayBytes, iw, ih } = await new Promise((res, rej) => {
          const timeout = setTimeout(() => { URL.revokeObjectURL(url); rej(new Error('timeout')); }, 4000);
          const el = new Image();
          el.onload = () => {
            clearTimeout(timeout); URL.revokeObjectURL(url);
            const cw = el.naturalWidth || w, ch = el.naturalHeight || h;
            if (!cw || !ch) { rej(new Error('invalid size')); return; }
            const c = document.createElement('canvas');
            c.width = cw; c.height = ch;
            const ctx = c.getContext('2d'); ctx.drawImage(el, 0, 0);
            const d = ctx.getImageData(0, 0, cw, ch).data;
            const gb = new Uint8Array(cw * ch);
            for (let i = 0; i < gb.length; i++)
              gb[i] = Math.round(0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2]);
            res({ grayBytes: gb, iw: cw, ih: ch });
          };
          el.onerror = () => { clearTimeout(timeout); URL.revokeObjectURL(url); rej(new Error('JPX decode failed')); };
          el.src = url;
        });

        // Dot Gain 보정 적용 (main thread — worker 미사용)
        const _dg = ctxDotGain(pdfDoc);
        if (_dg) {
          for (let i = 0; i < grayBytes.length; i++) {
            const v = grayBytes[i] / 255;
            let out;
            if (_dg === 25) out = Math.sqrt(v);
            else { const disc = 0.04+3.2*v; const d=(1.8-Math.sqrt(disc<0?0:disc))/1.6; out=1-Math.max(0,Math.min(1,d)); }
            grayBytes[i] = Math.round(Math.max(0, Math.min(255, out * 255)));
          }
        }

        const predicted  = applyPNGPredictorGray(grayBytes, iw, ih);
        const compressed = pako.deflate(predicted, { level: 1 });
        img.contents = compressed;
        img.dict.set(Nm('Filter'),           Nm('FlateDecode'));
        img.dict.set(Nm('ColorSpace'),       Nm('DeviceGray'));
        img.dict.set(Nm('BitsPerComponent'), PDFLib.PDFNumber.of(8));
        img.dict.set(Nm('Width'),            PDFLib.PDFNumber.of(iw));
        img.dict.set(Nm('Height'),           PDFLib.PDFNumber.of(ih));
        img.dict.set(Nm('Length'),           PDFLib.PDFNumber.of(compressed.length));
        img.dict.set(Nm('DecodeParms'), pdfDoc.context.obj({
          Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: iw,
        }));
        img.dict.delete(Nm('Mask'));
        img.dict.delete(Nm('ImageMask'));
        img.dict.delete(Nm('Intent'));
        img.dict.delete(Nm('Alternates'));
        img.dict.delete(Nm('Decode'));
        img.dict.delete(Nm('Matte'));
        img.dict.delete(Nm('SMaskInData'));
        fixSMaskMatte(pdfDoc, img);
      } catch(e) {
        console.warn('JPX 흑백변환 실패 (Chromium 미지원):', e);
      }
    }

    async function convertFlateXObjectToGrayscale(pdfDoc, img, resDict, isRaw = false) {
      try {
        const Nm  = n => PDFLib.PDFName.of(n);

        // DecodeParms에서 Predictor 값 읽기 (Indexed 블록에서도 필요하므로 최상단에 배치)
        // PowerPoint PDF는 Filter/DecodeParms를 배열로 저장하는 경우가 있음: [<< Predictor 15 ... >>]
        let predictor = 1;
        const dpRef = img.dict.get(Nm('DecodeParms'));
        if (dpRef) {
          try {
            let dp = pdfDoc.context.lookup(dpRef);
            if (dp && typeof dp.size === 'function' && dp.size() > 0) {
              dp = pdfDoc.context.lookup(dp.get(0));
            }
            if (dp && typeof dp.get === 'function') {
              const pObj = dp.get(Nm('Predictor'));
              if (pObj) predictor = +(pObj.numberValue ?? pObj.asNumber?.() ?? 1);
            }
          } catch(e) {}
        }

        // ColorSpace 취득 및 해석 (간접 참조 · 배열 형태 대응)
        let csObj = img.dict.get(Nm('ColorSpace'));
        if (!csObj) return;
        // 간접 참조(PDFRef)라면 실제 객체로 해결
        if (csObj.objectNumber != null) {
          try { csObj = pdfDoc.context.lookup(csObj); } catch(e) { return; }
        }

        // 명명된 색공간 (예: /Cs1, /Cs2) → Resources.ColorSpace에서 실제 정의로 해결
        // InDesign 등 전문 DTP 도구가 생성하는 PDF에서 흔히 사용됨
        if (csObj.encodedName && resDict &&
            !['/DeviceGray','/DeviceRGB','/DeviceCMYK','/CalGray','/CalRGB'].includes(csObj.encodedName)) {
          try {
            const csResRef = resDict.get(Nm('ColorSpace'));
            if (csResRef) {
              const csResDict = pdfDoc.context.lookup(csResRef);
              if (csResDict) {
                const csKey = Nm(csObj.encodedName.replace(/^\//, ''));
                const realRef = csResDict.get(csKey);
                if (realRef) {
                  const resolved = pdfDoc.context.lookup(realRef);
                  if (resolved) csObj = resolved; // 실제 색공간 배열/딕셔너리로 교체
                }
              }
            }
          } catch(e) {}
        }
        // 배열 형태 [/ICCBased ref] / [/CalRGB dict] / [/Indexed base hival lookup] 처리
        let csn = '';
        if (typeof csObj.size === 'function') {
          try {
            const first = pdfDoc.context.lookup(csObj.get(0));
            const fn = first && first.encodedName ? first.encodedName : '';
            if (fn === '/CalRGB' || fn === '/DeviceRGB') {
              csn = '/DeviceRGB';
            } else if (fn === '/DeviceCMYK' || fn === '/CalCMYK') {
              csn = '/DeviceCMYK';
            } else if (fn === '/ICCBased') {
              const iccStream = pdfDoc.context.lookup(csObj.get(1));
              if (iccStream && iccStream.dict) {
                const nObj = iccStream.dict.get(Nm('N'));
                const nVal = nObj ? +(nObj.numberValue ?? nObj.asNumber?.() ?? 0) : 0;
                if (nVal === 3) csn = '/ICCBased-RGB';
                else if (nVal === 4) csn = '/DeviceCMYK';
              }
            } else if (fn === '/Indexed') {
              // Indexed는 convertXObjectImageToGrayscale에서 팔레트 교체로 우선 처리됨
              // (여기 도달 = 명명된 CS 해석 후 발견된 경우) — 동일하게 팔레트 교체
              convertIndexedImagePalette(pdfDoc, img, csObj);
              return;
            } else if (fn === '/Separation') {
              await convertSeparationImage(pdfDoc, img, csObj);
              return;
            }
          } catch(e) {}
        } else {
          csn = csObj.encodedName || '';
        }
        const isICCRGB = csn === '/ICCBased-RGB';
        const isCMYK   = csn === '/DeviceCMYK';
        if (!isICCRGB && !isCMYK && csn !== '/DeviceRGB') return;
        const channels = isCMYK ? 4 : 3;

        const bpcObj = img.dict.get(Nm('BitsPerComponent'));
        const bpcV = bpcObj ? (bpcObj.numberValue ?? bpcObj.asNumber?.() ?? 8) : 8;
        if (bpcV !== 8) return;
        const wO = img.dict.get(Nm('Width')),  hO = img.dict.get(Nm('Height'));
        const w  = wO ? (wO.numberValue ?? wO.asNumber?.() ?? 0) : 0;
        const h  = hO ? (hO.numberValue ?? hO.asNumber?.() ?? 0) : 0;
        if (!w || !h) return;

        const compBuf = img.contents.buffer.slice(
          img.contents.byteOffset,
          img.contents.byteOffset + img.contents.byteLength
        );

        // ICCBased RGB: PNG+iCCP 경로 → OffscreenCanvas ICC 보정 (색상 정확도 향상)
        if (isICCRGB) {
          try {
            // ICC 프로파일 바이트 추출 (FlateDecode 압축 해제 포함)
            let iccBuf = null;
            try {
              const iccStreamObj = pdfDoc.context.lookup(csObj.get(1));
              if (iccStreamObj && iccStreamObj.contents) {
                let iccRaw = iccStreamObj.contents;
                const iccFilt = iccStreamObj.dict?.get(Nm('Filter'));
                if (iccFilt) {
                  const iccFn = iccFilt.encodedName || '';
                  if (iccFn === '/FlateDecode' || iccFn === '/Fl') {
                    try { iccRaw = pako.inflate(iccRaw); } catch(e) {}
                  }
                }
                iccBuf = iccRaw.buffer.slice(iccRaw.byteOffset, iccRaw.byteOffset + iccRaw.byteLength);
              }
            } catch(e) {}

            const transferables = [compBuf];
            if (iccBuf) transferables.push(iccBuf);
            const result = await grayWorkerPool.run(
              'icc-flate2gray',
              { compressed: compBuf, w, h, channels, predictor, iccBytes: iccBuf || null, dotGain: ctxDotGain(pdfDoc), raw: isRaw },
              transferables
            );
            const deflated = new Uint8Array(result.deflated);
            const dp = pdfDoc.context.obj({ Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: result.w });
            img.contents = deflated;
            img.dict.set(Nm('Filter'),           Nm('FlateDecode'));
            img.dict.set(Nm('ColorSpace'),       Nm('DeviceGray'));
            img.dict.set(Nm('BitsPerComponent'), PDFLib.PDFNumber.of(8));
            img.dict.set(Nm('Width'),            PDFLib.PDFNumber.of(result.w));
            img.dict.set(Nm('Height'),           PDFLib.PDFNumber.of(result.h));
            img.dict.set(Nm('Length'),           PDFLib.PDFNumber.of(deflated.length));
            img.dict.set(Nm('DecodeParms'),      dp);
            img.dict.delete(Nm('Mask')); img.dict.delete(Nm('ImageMask'));
            img.dict.delete(Nm('Intent')); img.dict.delete(Nm('Alternates'));
            img.dict.delete(Nm('Decode')); img.dict.delete(Nm('Matte')); img.dict.delete(Nm('SMaskInData'));
            fixSMaskMatte(pdfDoc, img);
          } catch(e) { console.warn('ICCBased 이미지 변환 실패:', e); }
          return;
        }

        const result = await grayWorkerPool.run(
          'flate2gray',
          { compressed: compBuf, w, h, channels, predictor, dotGain: ctxDotGain(pdfDoc), raw: isRaw },
          [compBuf]
        );
        const deflated = new Uint8Array(result.deflated);
        const dp = pdfDoc.context.obj({ Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: w });
        img.contents = deflated;
        img.dict.set(Nm('Filter'),           Nm('FlateDecode'));   // 배열 형태 [/FlateDecode] → 이름으로 정규화
        img.dict.set(Nm('ColorSpace'),       Nm('DeviceGray'));
        img.dict.set(Nm('BitsPerComponent'), PDFLib.PDFNumber.of(8));
        img.dict.set(Nm('Width'),            PDFLib.PDFNumber.of(w));
        img.dict.set(Nm('Height'),           PDFLib.PDFNumber.of(h));
        img.dict.set(Nm('Length'),           PDFLib.PDFNumber.of(deflated.length));
        img.dict.set(Nm('DecodeParms'),      dp);
        img.dict.delete(Nm('Mask'));
        img.dict.delete(Nm('ImageMask'));
        img.dict.delete(Nm('Intent'));
        img.dict.delete(Nm('Alternates'));
        img.dict.delete(Nm('Decode'));
        img.dict.delete(Nm('Matte'));
        img.dict.delete(Nm('SMaskInData'));
        fixSMaskMatte(pdfDoc, img);
      } catch(e) { console.warn('Flate 이미지 변환 실패:', e); }
    }

    // ── 유틸리티 ─────────────────────────────────────────────────────────────
    function formatRanges(pages) {
      if (!pages || !pages.length) return '-';
      const sorted = [...pages].sort((a, b) => a - b);
      const ranges = [];
      let start = sorted[0], end = sorted[0];
      for (let i = 1; i <= sorted.length; i++) {
        if (sorted[i] === end + 1) { end = sorted[i]; }
        else { ranges.push(start === end ? `${start}` : `${start}-${end}`); start = sorted[i]; end = sorted[i]; }
      }
      return ranges.join(', ');
    }

    function updateProgress(pct) {
      const v = Math.max(0, Math.min(100, pct || 0));
      progressFill.style.width = v + '%';
      const bf = document.getElementById('loadingBarFill');
      const pc = document.getElementById('loadingPct');
      if (bf) bf.style.width = v + '%';
      if (pc) pc.textContent = Math.round(v) + '%';
      // 진행률 트래킹이 시작되면 토스트에 진행바를 노출
      if (loading.style.display !== 'none') loading.classList.add('has-progress');
    }

    function toKoreanAmount(n) {
      n = Math.floor(n);
      if (n === 0) return '영';
      const ones = ['','일','이','삼','사','오','육','칠','팔','구'];
      const posNames = ['','십','백','천'];
      const unitNames = ['','만','억','조'];
      let result = '', unitIdx = 0;
      while (n > 0) {
        const chunk = n % 10000;
        if (chunk > 0) {
          let chunkStr = '';
          const d = [chunk%10, Math.floor(chunk/10)%10, Math.floor(chunk/100)%10, Math.floor(chunk/1000)];
          for (let i = 3; i >= 0; i--) { if (d[i] > 0) chunkStr += ones[d[i]] + posNames[i]; }
          result = chunkStr + unitNames[unitIdx] + result;
        }
        n = Math.floor(n / 10000); unitIdx++;
      }
      return result;
    }
    function fmtKorean(n) {
      return `일금 ${toKoreanAmount(Math.floor(n))}원정(￦${Math.floor(n).toLocaleString('ko-KR')})`;
    }

    // 품목 합계(VAT포함) = 수량 × 단가 × 부수 × (1 − 할인율%)
    function itemTotal(item) {
      const base = item.qty * item.price * (item.copies || 1);
      const disc = Math.max(0, Math.min(100, item.discount || 0));
      return Math.round(base * (1 - disc / 100));
    }

    // ── 견적서 ───────────────────────────────────────────────────────────────
    // DOM에 의존하지 않는 견적 품목 생성 — 비활성(백그라운드) 탭의 분석이 끝났을 때도
    // 해당 탭의 quoteItems를 채워둘 수 있어, 나중에 그 탭으로 전환해도 견적서가 보인다.
    // 기본 단가 (localStorage에 저장 → 적용 버튼으로 갱신, 다음 견적부터 반영)
    const DEFAULT_PRICES_FALLBACK = { color: 200, bw: 60, binding: 2500 };
    function getDefaultPrices() {
      try {
        const saved = JSON.parse(localStorage.getItem('quoteDefaultPrices'));
        if (saved && typeof saved === 'object') {
          return {
            color:   Number.isFinite(+saved.color)   ? +saved.color   : DEFAULT_PRICES_FALLBACK.color,
            bw:      Number.isFinite(+saved.bw)      ? +saved.bw      : DEFAULT_PRICES_FALLBACK.bw,
            binding: Number.isFinite(+saved.binding) ? +saved.binding : DEFAULT_PRICES_FALLBACK.binding,
          };
        }
      } catch (e) {}
      return { ...DEFAULT_PRICES_FALLBACK };
    }
    function loadDefaultPricesUI() {
      const dp = getDefaultPrices();
      const c = document.getElementById('dp-color');   if (c) c.value = dp.color;
      const b = document.getElementById('dp-bw');      if (b) b.value = dp.bw;
      const g = document.getElementById('dp-binding'); if (g) g.value = dp.binding;
    }
    function applyDefaultPrices() {
      const dp = {
        color:   Math.max(0, parseInt(document.getElementById('dp-color').value)   || 0),
        bw:      Math.max(0, parseInt(document.getElementById('dp-bw').value)      || 0),
        binding: Math.max(0, parseInt(document.getElementById('dp-binding').value) || 0),
      };
      try { localStorage.setItem('quoteDefaultPrices', JSON.stringify(dp)); } catch (e) {}
      loadDefaultPricesUI();
      // 현재 견적에도 즉시 반영 — 기본 품목(컬러인쇄·흑백인쇄·제본비) 단가 갱신
      const priceByName = { '컬러인쇄': dp.color, '흑백인쇄': dp.bw, '제본비': dp.binding };
      quoteItems.forEach(item => {
        if (Object.prototype.hasOwnProperty.call(priceByName, item.name)) item.price = priceByName[item.name];
      });
      if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).quoteItems = quoteItems;
      renderQuoteTable();
      showSuccess('기본 단가가 저장됐습니다. 현재 견적에 즉시 반영했고, 다음 견적부터도 적용됩니다.');
    }

    function buildQuoteItems(colorCount, bwCount) {
      const dp = getDefaultPrices();
      const items = [];
      if (colorCount > 0) items.push({ name: '컬러인쇄', spec: '', qty: colorCount, price: dp.color, copies: 1, discount: 0 });
      if (bwCount > 0)    items.push({ name: '흑백인쇄',  spec: '', qty: bwCount,   price: dp.bw,  copies: 1, discount: 0 });
      items.push({ name: '제본비', spec: '', qty: 1, price: dp.binding, copies: 1, discount: 0 });
      return items;
    }

    function initQuoteSection(colorCount, bwCount) {
      quoteItems.length = 0;
      document.getElementById('q-customer').value = '';
      document.getElementById('q-date').value = new Date().toISOString().split('T')[0];
      quoteItems.push(...buildQuoteItems(colorCount, bwCount));
      loadDefaultPricesUI();
      renderQuoteTable();
      document.getElementById('quoteSection').style.display = 'block';
    }

    // 견적서의 컬러/흑백 인쇄 수량만 갱신 (고객명·단가·기타 항목은 보존).
    // 항목이 없으면 새로 만든다. (편집 적용 결과 새로고침 시 사용)
    function updateQuoteCounts(colorCount, bwCount) {
      const ci = quoteItems.find(it => it.name === '컬러인쇄');
      const bi = quoteItems.find(it => it.name === '흑백인쇄');
      if (!ci && !bi) { initQuoteSection(colorCount, bwCount); return; }
      const dp = getDefaultPrices();
      const copies = (quoteItems[0] && quoteItems[0].copies) || 1;
      if (ci) ci.qty = colorCount;
      else if (colorCount > 0) quoteItems.unshift({ name: '컬러인쇄', spec: '', qty: colorCount, price: dp.color, copies, discount: 0 });
      if (bi) bi.qty = bwCount;
      else if (bwCount > 0) {
        const at = quoteItems.findIndex(it => it.name === '컬러인쇄');
        quoteItems.splice(at >= 0 ? at + 1 : 0, 0, { name: '흑백인쇄', spec: '', qty: bwCount, price: dp.bw, copies, discount: 0 });
      }
      if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).quoteItems = quoteItems;
      renderQuoteTable();
      document.getElementById('quoteSection').style.display = 'block';
    }

    function renderQuoteTable() {
      const tbody = document.getElementById('quoteItemBody');
      tbody.innerHTML = '';
      quoteItems.forEach((item, idx) => {
        const total  = itemTotal(item);
        const supply = Math.round(total / 1.1);
        const vat    = total - supply;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><input type="text" value="${item.name}" onchange="quoteItems[${idx}].name=this.value"></td>
          <td><input type="text" value="${item.spec||''}" placeholder="규격" onchange="quoteItems[${idx}].spec=this.value"></td>
          <td><input type="number" value="${item.qty}" min="0" onchange="quoteItems[${idx}].qty=+this.value;recalcQuote()"></td>
          <td><input type="number" value="${item.price}" min="0" onchange="quoteItems[${idx}].price=+this.value;recalcQuote()"></td>
          <td><input type="number" value="${item.copies||1}" min="1" style="text-align:right;" onchange="syncCopies(this.value)"></td>
          <td><input type="number" value="${item.discount||0}" min="0" max="100" step="0.1" style="text-align:right;" onchange="quoteItems[${idx}].discount=Math.max(0,Math.min(100,+this.value||0));recalcQuote()"></td>
          <td class="q-readonly q-col-hide" id="supply-${idx}">${supply.toLocaleString()}원</td>
          <td class="q-readonly q-col-hide" id="vat-${idx}">${vat.toLocaleString()}원</td>
          <td class="q-total-cell" id="total-${idx}">${total.toLocaleString()}원</td>
          <td><button class="q-del-btn" onclick="removeQuoteItem(${idx})">✕</button></td>
        `;
        tbody.appendChild(tr);
      });
      recalcQuote();
    }

    function syncCopies(val) {
      const n = Math.max(1, parseInt(val) || 1);
      quoteItems.forEach(item => item.copies = n);
      renderQuoteTable();
    }

    function addQuoteItem() {
      const copies = quoteItems.length > 0 ? (quoteItems[0].copies || 1) : 1;
      quoteItems.push({ name: '품목', spec: '', qty: 1, price: 0, copies, discount: 0 });
      renderQuoteTable();
    }

    function removeQuoteItem(idx) { quoteItems.splice(idx, 1); renderQuoteTable(); }
    function removeEmptyItems() {
      quoteItems = quoteItems.filter(item => item.name.trim() || item.qty > 0);
      // sync back to active tab
      if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).quoteItems = quoteItems;
      renderQuoteTable();
    }

    function recalcQuote() {
      let supplySum = 0, vatSum = 0, totalSum = 0;
      quoteItems.forEach((item, idx) => {
        const total  = itemTotal(item);
        const supply = Math.round(total / 1.1);
        const vat    = total - supply;
        supplySum += supply; vatSum += vat; totalSum += total;
        const se = document.getElementById(`supply-${idx}`);
        const ve = document.getElementById(`vat-${idx}`);
        const te = document.getElementById(`total-${idx}`);
        if (se) se.textContent = supply.toLocaleString() + '원';
        if (ve) ve.textContent = vat.toLocaleString() + '원';
        if (te) te.textContent = total.toLocaleString() + '원';
      });
      document.getElementById('supplyTotal').textContent  = supplySum.toLocaleString() + '원';
      document.getElementById('vatTotal').textContent     = vatSum.toLocaleString() + '원';
      document.getElementById('grandTotal').textContent   = totalSum.toLocaleString() + '원';
      document.getElementById('koreanAmount').textContent = fmtKorean(totalSum);
    }

    // ── 견적서 인쇄 ──────────────────────────────────────────────────────────
    // ── 견적서 PDF 저장 ──────────────────────────────────────────────────────
    async function saveQuotePDF() {
      if (!quoteItems.length) { alert('견적 품목이 없습니다.'); return; }
      const html = buildQuoteHTML(true); // forPrint=true → print 스크립트 제외
      let pdfBuffer;
      try {
        pdfBuffer = await window.electronAPI.printToPDF(html);
      } catch(e) {
        alert('PDF 변환 오류: ' + e.message); return;
      }
      // 체험판 만료·미인증이면 메인이 null을 돌려준다(안내 다이얼로그는 메인이 이미 띄움)
      if (!pdfBuffer) return;
      const customer = (document.getElementById('q-customer').value || '견적서').replace(/[\\/:*?"<>|]/g, '_');
      const date = (document.getElementById('q-date').value || '').replace(/-/g, '');
      const defaultName = `견적서_${customer}_${date}.pdf`;
      // IPC 직렬화 방식에 따라 Buffer가 {type:'Buffer',data:[...]} 형태로 올 수 있음
      const raw = (pdfBuffer instanceof Uint8Array)
        ? pdfBuffer
        : new Uint8Array(pdfBuffer?.data ?? Object.values(pdfBuffer));
      const saved = await window.electronAPI.saveFile({ defaultName, buffer: raw });
      if (saved) showSuccess('견적서 PDF가 저장됐습니다.');
    }

    // 견적서 HTML 빌드 (인쇄 · PDF 저장 공용)
    function buildQuoteHTML(forPrint = false) {
      const customer = document.getElementById('q-customer').value || '(고객명)';
      const date     = document.getElementById('q-date').value;
      let supplySum = 0, vatSum = 0, totalSum = 0;
      const rows = quoteItems.map(item => {
        const copies = item.copies || 1;
        const disc   = Math.max(0, Math.min(100, item.discount || 0));
        const total  = itemTotal(item);
        const supply = Math.round(total / 1.1);
        const vat    = total - supply;
        supplySum += supply; vatSum += vat; totalSum += total;
        return `<tr>
          <td>${item.name}</td>
          <td style="text-align:center">${item.spec||''}</td>
          <td style="text-align:right">${item.qty.toLocaleString()}</td>
          <td style="text-align:right">${item.price.toLocaleString()}</td>
          <td style="text-align:right">${copies.toLocaleString()}</td>
          <td style="text-align:right">${disc ? disc + '%' : '-'}</td>
          <td style="text-align:right">${supply.toLocaleString()}</td>
          <td style="text-align:right">${vat.toLocaleString()}</td>
          <td style="text-align:right;font-weight:700">${total.toLocaleString()}</td>
        </tr>`;
      }).join('');
      const printScript = forPrint ? '' : `<script>window.onload=function(){window.print()}<\/script>`;
      return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>견적서</title>
        <style>
          body{font-family:'Malgun Gothic',sans-serif;padding:20mm;font-size:9.5pt;color:#111}
          h1{text-align:center;font-size:22pt;letter-spacing:.4em;margin-bottom:16px}
          .meta{display:flex;justify-content:space-between;font-size:9pt;margin-bottom:10px}
          p{margin-bottom:8px;font-size:9pt}
          table{width:100%;border-collapse:collapse}
          th{background:#f0f0f0;padding:7px 8px;border:1px solid #888;font-size:8.5pt;text-align:center}
          th:first-child{text-align:left}
          td{padding:6px 8px;border:1px solid #ccc;font-size:8.5pt}
          .tt{width:260px;margin:14px 0 0 auto;border-collapse:collapse}
          .tt td{padding:6px 10px;border:1px solid #ccc;font-size:9pt}
          .tt .tl{background:#f5f5f5;font-weight:600;text-align:right}
          .tt .tv{text-align:right;font-weight:600}
          .tt .gr td{background:#dbeafe;color:#1e3a8a;font-weight:700}
          .tt .kr td{background:#fff8db;color:#1d1d1f;font-weight:700;text-align:center;border-top:2px solid #ffd60a;font-size:9.5pt}
          @media print{body{padding:15mm}}
        </style></head><body>
        <h1>견 적 서</h1>
        <div class="meta"><div><strong>고객명:</strong> ${customer}</div><div><strong>견적일:</strong> ${date}</div></div>
        <p>아래와 같이 견적합니다.</p>
        <table>
          <thead><tr>
            <th>품목명</th><th style="width:9%">규격</th>
            <th style="width:8%">수량</th><th style="width:10%">단가</th>
            <th style="width:7%">부수</th><th style="width:7%">할인율</th>
            <th style="width:10%">공급가</th><th style="width:9%">부가세</th>
            <th style="width:11%">합계(VAT포함)</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <table class="tt">
          <tr><td class="tl">공급가 합계</td><td class="tv">${supplySum.toLocaleString()}원</td></tr>
          <tr><td class="tl">부가세 합계</td><td class="tv">${vatSum.toLocaleString()}원</td></tr>
          <tr class="gr"><td class="tl">최종 합계(VAT포함)</td><td class="tv">${totalSum.toLocaleString()}원</td></tr>
          <tr class="kr"><td colspan="2">${fmtKorean(totalSum)}</td></tr>
        </table>
        ${printScript}
      </body></html>`;
    }

    function printQuote() {
      if (!quoteItems.length) { alert('견적 품목이 없습니다.'); return; }
      const html = buildQuoteHTML(false); // forPrint=false → window.print() 스크립트 포함
      const win = window.open('', '_blank');
      win.document.write(html);
      win.document.close();
    }

    // ── 🖨 가상 프린터 설치 — 어떤 앱에서든 '인쇄'로 이 앱에 문서 전달 ────────
    async function setupVirtualPrinter() {
      if (!confirm("가상 프린터 'PDF Editor'를 설치합니다.\n관리자 권한 창(UAC)이 뜨면 '예'를 눌러주세요.\n\n설치 후: 아크로뱃·한글 등 어떤 프로그램에서든\n인쇄 → 프린터 'PDF Editor' 선택 → 인쇄하면 이 앱으로 문서가 들어옵니다.\n(인쇄 대화상자에서 페이지 범위를 지정하면 그 페이지만 전달됩니다)")) return;
      showLoading("가상 프린터 설치 중… (UAC 승인 필요)");
      try {
        const r = await window.electronAPI.setupPrinter();
        hideLoading();
        if (r && r.ok) {
          showSuccess("🖨 가상 프린터 'PDF Editor' 설치 완료\n다른 프로그램에서 인쇄 → 'PDF Editor' 선택 → 인쇄하면 이 앱이 자동으로 문서를 엽니다.\n페이지 범위 인쇄로 필요한 쪽만 보낼 수 있습니다.");
          const b = document.getElementById('printerSetupBtn');
          if (b) b.style.display = 'none';   // 설치 완료 — 1회성 버튼 숨김
        }
        else showError("프린터 설치가 확인되지 않았습니다 — UAC 창에서 '예'를 눌렀는지 확인 후 다시 시도하세요.");
      } catch (e) {
        hideLoading();
        showError('프린터 설치 오류: ' + (e && e.message ? e.message : String(e)));
      }
    }

    // ── 📑 목차 생성 — 선택 페이지=장 시작, 제목 자동 인식 → 목차 페이지·북마크 ──
    // 제목 인식: 페이지 상단 45% 영역에서 가장 큰 글자 라인(동일 y 병합)을 제목으로 추정.
    async function extractPageTitle(originalIdx) {
      const page = await globalPdfDoc.getPage(originalIdx + 1);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]);
        if (fh < 6) continue;
        items.push({ str: it.str.trim(), x: tx[4], y: tx[5], h: fh });
      }
      if (!items.length) return '';
      const top = items.filter(i => i.y < vp.height * 0.45);
      const pool = top.length ? top : items;
      const maxH = Math.max(...pool.map(i => i.h));
      const cand = pool.filter(i => i.h >= maxH * 0.88).sort((a, b) => a.y - b.y || a.x - b.x);
      const line = [];
      for (const c of cand) { if (!line.length || Math.abs(c.y - line[0].y) < maxH * 0.8) line.push(c); }
      line.sort((a, b) => a.x - b.x);
      return line.map(l => l.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    }
    let _tocEntries = [];
    async function openTocDialog() {
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      const sel = [...selectedPages].sort((a, b) => a - b);
      if (!sel.length) { showError('썸네일에서 목차로 지정할 페이지(각 장의 시작 페이지)를 먼저 선택하세요.'); return; }
      setBtnBusy('tocBtn', true);
      showLoading('페이지 제목 인식 중…');
      _tocEntries = [];
      try {
        for (const pn of sel) {
          const r = pageResults.find(x => x && x.pageNum === pn);
          if (!r || r.isBlank || r.isTocPage) continue;   // 빈 페이지·목차 페이지 자신은 제외
          let title = '';
          try { title = await extractPageTitle(r.originalIdx); } catch (e) {}
          // ref: pageResults 엔트리 객체 참조 — 목차 재생성으로 번호가 밀려도 안정적으로 추적
          _tocEntries.push({ pageNum: pn, title: title || `${pn}쪽`, ref: r });
        }
        if (!_tocEntries.length) { showError('목차로 지정할 수 있는 페이지가 없습니다 (빈 페이지·목차 페이지 제외).'); return; }
      } finally { hideLoading(); setBtnBusy('tocBtn', false); }
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      document.getElementById('tocRows').innerHTML = _tocEntries.map((en, i) =>
        `<tr><td style="padding:5px; border:1px solid #e8e8ed; text-align:center;">${en.pageNum}</td>
         <td style="padding:3px; border:1px solid #e8e8ed;"><input type="text" value="${esc(en.title)}" data-toc-i="${i}" style="width:100%; border:1px solid #d2d2d7; border-radius:5px; padding:5px 7px; box-sizing:border-box; font-family:inherit;"></td></tr>`).join('');
      document.getElementById('tocModal').style.display = 'block';
    }
    // 목차 페이지를 doc '끝에' 그려 붙인다 (원본 페이지 인덱스를 보존하기 위해 append —
    // 표시 위치는 pageResults 순서가 결정하므로 엔트리를 맨 앞에 끼우면 맨 앞에 보인다).
    // entries[].displayNum = 목차에 인쇄할 쪽 번호(이미 목차 분량이 보정된 값).
    async function appendTocPages(doc, entries, title, fontBytes) {
      let font = null;
      if (fontBytes) {
        const fk = (typeof fontkit !== 'undefined') ? fontkit : (typeof self !== 'undefined' && self.fontkit) ? self.fontkit : null;
        if (fk) { doc.registerFontkit(fk); font = await doc.embedFont(fontBytes.slice ? new Uint8Array(fontBytes.slice(0)) : fontBytes, { subset: true }); }
      }
      if (!font) font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const { width: W, height: H } = doc.getPage(0).getSize();
      const mTop = 90, mBot = 60, mSide = Math.max(50, W * 0.12), lineH = 26, titleSize = 24, entrySize = 12;
      const perPage = Math.max(1, Math.floor((H - mTop - mBot - 40) / lineH));
      const tocPageCount = Math.ceil(entries.length / perPage);
      for (let p = 0; p < tocPageCount; p++) {
        const pg = doc.addPage([W, H]);
        if (p === 0) {
          const t = title || '목  차';
          const tw = font.widthOfTextAtSize(t, titleSize);
          pg.drawText(t, { x: (W - tw) / 2, y: H - mTop, size: titleSize, font, color: PDFLib.rgb(0.11, 0.11, 0.12) });
        }
        const slice = entries.slice(p * perPage, (p + 1) * perPage);
        slice.forEach((en, i) => {
          const y = H - mTop - 40 - i * lineH;
          const numStr = String(en.displayNum);
          const numW = font.widthOfTextAtSize(numStr, entrySize);
          let t = en.title;
          while (t.length > 4 && font.widthOfTextAtSize(t, entrySize) > W - mSide * 2 - numW - 30) t = t.slice(0, -1);
          const titleW = font.widthOfTextAtSize(t, entrySize);
          pg.drawText(t, { x: mSide, y, size: entrySize, font, color: PDFLib.rgb(0.11, 0.11, 0.12) });
          // 점선 리더: 실제 '.' 글리프 폭으로 개수를 계산하고 쪽 번호 직전(dotEnd)에 오른쪽
          // 정렬로 채운다 — 이전엔 점당 2.2pt 가짜 간격으로 세어 중간에 끊겼음(항목이 길수록 심함).
          const dotStart = mSide + titleW + 6, dotEnd = W - mSide - numW - 6;
          const dotAdv = font.widthOfTextAtSize('.', entrySize);
          const nDots = Math.max(0, Math.floor((dotEnd - dotStart) / dotAdv));
          if (nDots > 0) pg.drawText('.'.repeat(nDots),
            { x: dotEnd - nDots * dotAdv, y, size: entrySize, font, color: PDFLib.rgb(0.6, 0.6, 0.62) });
          pg.drawText(numStr, { x: W - mSide - numW, y, size: entrySize, font, color: PDFLib.rgb(0.11, 0.11, 0.12) });
        });
      }
      return { tocPageCount, perPage };
    }
    // 다운로드 최종본에 목차 북마크 적용 — pageResults의 tocTitle 태그 기반이라
    // 이후 페이지 재배열·삭제에도 대상이 따라간다. 임포징 포함이면 의미 없어 생략.
    async function applyTocBookmarks(bytes) {
      try {
        const valid = pageResults.filter(Boolean);
        const marks = valid.map((r, i) => ({ i, t: r.tocTitle })).filter(x => x.t);
        if (!marks.length || _impEnabled) return bytes;
        const doc = await PDFLib.PDFDocument.load(bytes.slice ? bytes.slice(0) : bytes);
        if (doc.getPageCount() !== valid.length) return bytes;   // 페이지 수 불일치 — 안전 중단
        const PDFName = PDFLib.PDFName, ctx = doc.context;
        const outlineRef = ctx.nextRef();
        const itemRefs = marks.map(() => ctx.nextRef());
        marks.forEach((mk, i) => {
          const d = ctx.obj({
            Title: PDFLib.PDFHexString.fromText(mk.t),
            Parent: outlineRef,
            Dest: [doc.getPage(mk.i).ref, PDFName.of('XYZ'), null, null, null],
          });
          if (i > 0) d.set(PDFName.of('Prev'), itemRefs[i - 1]);
          if (i < marks.length - 1) d.set(PDFName.of('Next'), itemRefs[i + 1]);
          ctx.assign(itemRefs[i], d);
        });
        ctx.assign(outlineRef, ctx.obj({
          Type: PDFName.of('Outlines'),
          First: itemRefs[0], Last: itemRefs[itemRefs.length - 1], Count: marks.length,
        }));
        doc.catalog.set(PDFName.of('Outlines'), outlineRef);
        doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
        return await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
      } catch (e) { console.warn('북마크 적용 실패(파일은 정상 저장):', e); return bytes; }
    }
    async function generateToc() {
      if (_bkBusy) return;
      // 모달 입력값 수거
      document.querySelectorAll('#tocRows input[data-toc-i]').forEach(inp => {
        const i = parseInt(inp.dataset.tocI);
        if (_tocEntries[i]) _tocEntries[i].title = inp.value.trim() || `${_tocEntries[i].pageNum}쪽`;
      });
      const insertPage = document.getElementById('tocInsertPage').checked;
      const bookmarks = document.getElementById('tocBookmarks').checked;
      if (!insertPage && !bookmarks) { showError('목차 페이지 삽입과 PDF 북마크 중 하나 이상을 선택하세요.'); return; }
      document.getElementById('tocModal').style.display = 'none';
      _bkBusy = true;
      setBtnBusy('tocBtn', true);
      try {
        showLoading('목차 페이지 생성 중…');
        progressBar.style.display = 'block'; updateProgress(10);

        // 1) 기존 목차 페이지 제거(재생성 = 교체) + 북마크 태그 초기화
        for (let i = pageResults.length - 1; i >= 0; i--) {
          const r = pageResults[i];
          if (r && r.isTocPage) {
            if (r.thumbnail && r.thumbnail.startsWith && r.thumbnail.startsWith('blob:')) { try { URL.revokeObjectURL(r.thumbnail); } catch (e) {} }
            pageResults.splice(i, 1);
          } else if (r && r.tocTitle) delete r.tocTitle;
        }
        rebuildPageNums();
        // 엔트리 대상은 객체 참조(ref)로 추적 — 제거·재번호 후의 실제 pageNum 사용
        const live = _tocEntries.filter(en => en.ref && pageResults.includes(en.ref));
        if (!live.length) { showError('목차 대상 페이지를 찾지 못했습니다 — 다시 선택해 주세요.'); return; }
        // 북마크 태그 (다운로드 시 최종본에 적용 — 재배열·삭제에도 따라감)
        if (bookmarks) live.forEach(en => { en.ref.tocTitle = en.title; });

        // 2) 목차 페이지를 '원본 문서 끝'에 그려 붙임 (기존 originalIdx 전부 보존)
        let tocPageCount = 0, baseCount = 0, mergedBytes = null;
        if (insertPage) {
          updateProgress(30);
          const srcDoc = await PDFLib.PDFDocument.load(originalPdfBytes.slice(0));
          baseCount = srcDoc.getPageCount();
          // 인쇄될 쪽 번호 — 기준(tocNumMode)에 따라:
          //   real     = 실제 페이지 위치(목차 분량 포함, 종전 방식)
          //   afterToc = 목차 다음 본문 첫 페이지가 1 (목차·표지류가 번호에서 빠짐)
          //   custom   = 지정 페이지(현재 썸네일 번호 기준)가 1 — 그 앞 항목은 실제 위치로 표기
          const { height: H0 } = srcDoc.getPage(0).getSize();
          const perPage = Math.max(1, Math.floor((H0 - 90 - 60 - 40) / 26));
          const cnt = Math.ceil(live.length / perPage);
          const numMode = document.getElementById('tocNumMode')?.value || 'real';
          const numStart = Math.max(1, parseInt(document.getElementById('tocNumStart')?.value) || 1);
          const entries = live.map(en => {
            const phys = en.ref.pageNum + cnt;
            let dn = phys;
            if (numMode === 'afterToc') dn = en.ref.pageNum;
            else if (numMode === 'custom') { const v = en.ref.pageNum - numStart + 1; dn = v > 0 ? v : phys; }
            return { title: en.title, displayNum: dn };
          });
          const res = await appendTocPages(srcDoc, entries, document.getElementById('tocTitle').value.trim() || '목  차', getSlugFontBytes());
          tocPageCount = res.tocPageCount;
          mergedBytes = await srcDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
        }
        updateProgress(60);

        // 3) 탭 상태 갱신 — 목차 페이지를 '실제 페이지'로 맨 앞에 삽입
        if (insertPage && mergedBytes) {
          originalPdfBytes = mergedBytes;
          const tab = tabs.get(activeTabId);
          if (tab) { tab.originalPdfBytes = mergedBytes; tab.fileSize = mergedBytes.byteLength; }
          const newPdf = await pdfjsLib.getDocument({ data: mergedBytes.slice(0) }).promise;
          try { if (globalPdfDoc) globalPdfDoc.destroy(); } catch (e) {}
          globalPdfDoc = newPdf;
          if (tab) tab.pdfDoc = newPdf;
          // 목차 페이지 썸네일 생성 + 엔트리 삽입 (빈 페이지 엔트리와 동일 형태)
          const newEntries = [];
          for (let k = 0; k < tocPageCount; k++) {
            const page = await newPdf.getPage(baseCount + k + 1);
            const res = await analyzePageColor(page);
            const thumb = res && res.thumbPromise ? await res.thumbPromise : null;
            newEntries.push({
              pageNum: 0, originalIdx: baseCount + k,
              isColor: false, isBlank: false, isTocPage: true, rotation: 0,
              thumbnail: thumb, thumbW: res && res.thumbW, thumbH: res && res.thumbH,
              chapter: (pageResults[0] && pageResults[0].chapter) || '',
            });
          }
          pageResults.unshift(...newEntries);
          rebuildPageNums();
          syncTabPageResults();
          clearProcessCaches();     // 원본 바이트 교체 — 흑백·베이스 캐시 전부 무효
          invalidateProcessed();
          // 화면 반영: refreshResults는 카운트만 갱신하므로 그리드를 직접 재렌더해야
          // 목차 페이지가 원본 보기(썸네일)에 나타난다. 미리보기가 열려 있으면 닫는다.
          try { closePreview(); } catch (e) {}
          renderAllPages(pageResults);
          totalPagesEl.textContent = pageResults.filter(Boolean).length;
          refreshResults();
        }
        // 4) '본문에도 쪽 번호 인쇄' — 머리글/바닥글 번호 시작 페이지를 같은 기준으로 자동 설정.
        //    (기준 앞 페이지(목차·표지류)는 {n}·{page}가 생략되어 번호 없이 인쇄됨)
        const numModeSel = document.getElementById('tocNumMode')?.value || 'real';
        let hfNote = '';
        if (document.getElementById('tocSyncHf')?.checked && numModeSel !== 'real' && editSettings) {
          const nStart = Math.max(1, parseInt(document.getElementById('tocNumStart')?.value) || 1);
          const startPhys = numModeSel === 'afterToc' ? tocPageCount + 1 : nStart + tocPageCount;
          const hf = editSettings.hf;
          hf.start = startPhys;
          if (!hf.enabled || (typeof hfAnyContent === 'function' ? !hfAnyContent(hf) : ![hf.hL, hf.hC, hf.hR, hf.fL, hf.fC, hf.fR].some(s => s && s.trim()))) {
            hf.enabled = true;
            { const nk = hf.alt ? 'fR' : 'fC'; if (!hf[nk] || !hf[nk].trim()) hf[nk] = '{n}'; }   // 교대 시 책 바깥쪽
          }
          if (typeof syncEditUI === 'function') syncEditUI();
          invalidateProcessed();
          hfNote = `\n쪽 번호: ${startPhys}번째 페이지가 1페이지 — 머리글/바닥글에 설정됨 ('✔ 적용' 또는 '⇩ 다운로드' 시 인쇄, ✏ 편집 모드에서 위치·형식 조정 가능)`;
        }
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        showSuccess(`📑 목차 생성 완료 — 항목 ${live.length}개`
          + (insertPage ? ` · 목차 페이지 ${tocPageCount}쪽이 문서 맨 앞에 '실제 페이지'로 삽입됨` : '')
          + (bookmarks ? ` · 북마크는 다운로드 시 최종 파일에 적용` : '')
          + hfNote
          + `\n목차 페이지도 일반 페이지처럼 편집됩니다 — 내용 수정: 우클릭 → 🖊 내부 내용 편집`
          + `\n항목을 바꾸려면 페이지 다시 선택 → 📑 목차 생성 (기존 목차가 교체됩니다)`);
      } catch (e) {
        console.error('목차 생성 오류:', e);
        showError('목차 생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; setBtnBusy('tocBtn', false);
        hideLoading(); progressBar.style.display = 'none';
      }
    }

    // ── 🧪 프리플라이트 (출력 적합성 검사) ────────────────────────────────────
    // 인쇄 사고 예방 점검: 폰트 미임베드·저해상도 이미지·블리드 정보·RGB 이미지·
    // 페이지 크기 혼재·주석/폼. 결과는 #preflightModal에 경고/주의/정보로 표시.
    function _pfFmtPages(arr) {
      const a = [...arr].sort((x, y) => x - y);
      const out = [];
      for (let i = 0; i < a.length; i++) {
        let j = i;
        while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
        out.push(j > i ? `${a[i]}-${a[j]}` : String(a[i]));
        i = j;
        if (out.length >= 8 && i < a.length - 1) { out.push(`외 ${a.length - i - 1}쪽`); break; }
      }
      return out.join(', ') + '쪽';
    }
    async function runPreflight() {
      if (!originalPdfBytes) { showError('먼저 PDF를 열어 주세요.'); return; }
      setBtnBusy('pfMainBtn', true); setBtnBusy('sbPfBtn', true);
      showLoading('프리플라이트 검사 중…');
      progressBar.style.display = 'block'; updateProgress(0);
      const errs = [], warns = [], infos = [];
      try {
        const doc = await PDFLib.PDFDocument.load(originalPdfBytes.slice(0), { ignoreEncryption: true, updateMetadata: false });
        const ctx = doc.context, PDFName = PDFLib.PDFName;
        const n = doc.getPageCount();

        // 1) 페이지 크기 혼재 + 블리드/트림 박스
        const sizes = new Map(); const noBleed = [];
        doc.getPages().forEach((pg, i) => {
          const { width, height } = pg.getSize();
          const key = `${Math.round(width / 72 * 25.4)}×${Math.round(height / 72 * 25.4)}`;
          if (!sizes.has(key)) sizes.set(key, []);
          sizes.get(key).push(i + 1);
          const has = b => { try { return !!pg.node.get(PDFName.of(b)); } catch (e) { return false; } };
          if (!has('TrimBox') && !has('BleedBox')) noBleed.push(i + 1);
        });
        if (sizes.size > 1)
          warns.push(`페이지 크기 혼재 — ${[...sizes.entries()].map(([k, v]) => `${k}mm(${v.length}쪽)`).join(' · ')} — 임포징·양면 인쇄 시 주의`);
        if (noBleed.length === n) infos.push(`블리드/트림 박스 정보 없음 — 가장자리까지 인쇄물이 닿는 원고면 '블리드 자동 생성'을 사용하세요.`);
        else if (noBleed.length) infos.push(`일부 페이지(${_pfFmtPages(noBleed)})에 블리드/트림 박스 없음`);

        // 2) 폰트 임베드 (Type0은 DescendantFonts 쪽 디스크립터 확인)
        const notEmb = new Map();
        doc.getPages().forEach((pg, i) => {
          try {
            const res = ctx.lookup(pg.node.get(PDFName.of('Resources')));
            const fd = res ? ctx.lookup(res.get(PDFName.of('Font'))) : null;
            if (!fd || !fd.entries) return;
            for (const [, v] of fd.entries()) {
              const f = ctx.lookup(v); if (!f || !f.get) continue;
              let desc = ctx.lookup(f.get(PDFName.of('FontDescriptor')));
              if (!desc) {
                const dfs = ctx.lookup(f.get(PDFName.of('DescendantFonts')));
                if (dfs && dfs.size && dfs.size() > 0) {
                  const df = ctx.lookup(dfs.get(0));
                  desc = df ? ctx.lookup(df.get(PDFName.of('FontDescriptor'))) : null;
                }
              }
              const emb = desc && ['FontFile', 'FontFile2', 'FontFile3'].some(x => desc.get(PDFName.of(x)));
              if (!emb) {
                const bn = f.get(PDFName.of('BaseFont'));
                const nm = bn ? String(bn).replace(/^\//, '').replace(/^[A-Z]{6}\+/, '') : '(이름없음)';
                if (!notEmb.has(nm)) notEmb.set(nm, new Set());
                notEmb.get(nm).add(i + 1);
              }
            }
          } catch (e) {}
        });
        if (notEmb.size)
          errs.push(`폰트 미임베드 ${notEmb.size}종 — ${[...notEmb.entries()].slice(0, 6).map(([nm, ps]) => `${nm}(${_pfFmtPages(ps)})`).join(', ')}${notEmb.size > 6 ? ' 외' : ''} → 다른 PC에서 글꼴이 바뀔 수 있음. '✒ 폰트 아웃라인화' 권장`);

        // 3) RGB 이미지 (XObject ColorSpace — ICCBased는 성분 수로 판정)
        const rgbPages = new Set();
        doc.getPages().forEach((pg, i) => {
          try {
            const res = ctx.lookup(pg.node.get(PDFName.of('Resources')));
            const xo = res ? ctx.lookup(res.get(PDFName.of('XObject'))) : null;
            if (!xo || !xo.entries) return;
            for (const [, v] of xo.entries()) {
              const x = ctx.lookup(v); if (!x || !x.dict) continue;
              if (String(x.dict.get(PDFName.of('Subtype')) || '') !== '/Image') continue;
              let cs = ctx.lookup(x.dict.get(PDFName.of('ColorSpace')));
              let name = String(cs || '');
              if (cs instanceof PDFLib.PDFArray && cs.size() > 0) {
                const c0 = String(ctx.lookup(cs.get(0)) || '');
                if (c0 === '/ICCBased') {
                  const st = ctx.lookup(cs.get(1));
                  const nc = st && st.dict ? Number(String(st.dict.get(PDFName.of('N')) || '')) : 0;
                  name = nc === 3 ? '/DeviceRGB' : (nc === 4 ? '/DeviceCMYK' : c0);
                } else name = c0;
              }
              if (name === '/DeviceRGB') rgbPages.add(i + 1);
            }
          } catch (e) {}
        });
        if (rgbPages.size)
          infos.push(`RGB 이미지 사용 — ${_pfFmtPages(rgbPages)} · 인쇄 시 CMYK 변환으로 색이 달라질 수 있음 (흑백 원고는 '🖨 잉크 정규화'로 해결)`);

        // 4) 주석/폼 (인쇄 시 표시되지 않을 수 있는 개체)
        try {
          const acro = ctx.lookup(doc.catalog.get(PDFName.of('AcroForm')));
          if (acro) infos.push(`입력 폼(AcroForm) 존재 — 입력값이 인쇄에 표시되지 않을 수 있음`);
        } catch (e) {}
        const annotPages = [];
        doc.getPages().forEach((pg, i) => {
          try {
            const an = ctx.lookup(pg.node.get(PDFName.of('Annots')));
            if (an && an.size && an.size() > 0) annotPages.push(i + 1);
          } catch (e) {}
        });
        if (annotPages.length) infos.push(`주석·링크 개체 — ${_pfFmtPages(annotPages)} (인쇄에 나오지 않을 수 있음)`);

        // 4-1) 보안 설정 (암호화)
        if (doc.isEncrypted) warns.push(`보안(암호화) 설정된 PDF — 일부 출력기·RIP에서 인쇄가 거부될 수 있음`);

        // 4-2) 페이지 회전값 (/Rotate) — 임포징·양면 시 주의
        const rotPages = [];
        doc.getPages().forEach((pg, i) => {
          try { if ((pg.getRotation().angle % 360) !== 0) rotPages.push(i + 1); } catch (e) {}
        });
        if (rotPages.length && rotPages.length < n)
          infos.push(`페이지 회전값 혼재 — ${_pfFmtPages(rotPages)}에 /Rotate 설정 (임포징은 자동 보정하나 원본 방향 확인 권장)`);

        // 4-3) 별색(Separation/DeviceN) — 디지털 인쇄면 CMYK로 근사 변환됨
        const spotNames = new Map();   // 이름 → 페이지들
        doc.getPages().forEach((pg, i) => {
          try {
            const res = ctx.lookup(pg.node.get(PDFName.of('Resources')));
            const csd = res ? ctx.lookup(res.get(PDFName.of('ColorSpace'))) : null;
            if (!csd || !csd.entries) return;
            for (const [, v] of csd.entries()) {
              const cs = ctx.lookup(v);
              if (!(cs instanceof PDFLib.PDFArray) || cs.size() < 2) continue;
              const kind = String(ctx.lookup(cs.get(0)) || '');
              if (kind !== '/Separation' && kind !== '/DeviceN') continue;
              let nm = kind === '/Separation' ? String(ctx.lookup(cs.get(1)) || '').replace(/^\//, '') : 'DeviceN';
              if (nm === 'All' || nm === 'None') continue;
              if (!spotNames.has(nm)) spotNames.set(nm, new Set());
              spotNames.get(nm).add(i + 1);
            }
          } catch (e) {}
        });
        if (spotNames.size)
          warns.push(`별색(스팟컬러) 사용 ${spotNames.size}종 — ${[...spotNames.entries()].slice(0, 5).map(([nm, ps]) => `${nm}(${_pfFmtPages(ps)})`).join(', ')}${spotNames.size > 5 ? ' 외' : ''} · 디지털 인쇄에서는 CMYK 근사색으로 출력됨`);

        // 4-4) 투명도 (ExtGState 불투명도<1·SMask / 페이지 투명 그룹) — 구형 RIP 평탄화 이슈
        const transPages = new Set();
        doc.getPages().forEach((pg, i) => {
          try {
            const grp = ctx.lookup(pg.node.get(PDFName.of('Group')));
            if (grp && String(grp.get(PDFName.of('S')) || '') === '/Transparency') { transPages.add(i + 1); return; }
            const res = ctx.lookup(pg.node.get(PDFName.of('Resources')));
            const egs = res ? ctx.lookup(res.get(PDFName.of('ExtGState'))) : null;
            if (!egs || !egs.entries) return;
            for (const [, v] of egs.entries()) {
              const gd = ctx.lookup(v); if (!gd || !gd.get) continue;
              const ca = gd.get(PDFName.of('ca')), CA = gd.get(PDFName.of('CA'));
              const sm = gd.get(PDFName.of('SMask'));
              const lt1 = x => x != null && parseFloat(String(x)) < 1;
              if (lt1(ca) || lt1(CA) || (sm && String(sm) !== '/None')) { transPages.add(i + 1); break; }
            }
          } catch (e) {}
        });
        if (transPages.size)
          infos.push(`투명도 효과 사용 — ${_pfFmtPages(transPages)} · 구형 출력기(RIP)에서는 평탄화로 색·경계가 달라질 수 있음`);

        // 4-5) 헤어라인 (0.25pt 미만 선폭) — 인쇄 시 끊기거나 사라질 수 있음
        const hairPages = [];
        doc.getPages().forEach((pg, i) => {
          try {
            const c = ctx.lookup(pg.node.get(PDFName.of('Contents')));
            const streams = [];
            if (c instanceof PDFLib.PDFArray) { for (let k = 0; k < c.size(); k++) streams.push(ctx.lookup(c.get(k))); }
            else if (c) streams.push(c);
            let txt = '';
            for (const st of streams) {
              let by; try { by = PDFLib.decodePDFRawStream(st).decode(); } catch (e) { by = st.contents || new Uint8Array(0); }
              if (by.length > 4 * 1024 * 1024) return;   // 과대 스트림은 생략 (성능)
              for (let k = 0; k < by.length; k++) txt += String.fromCharCode(by[k]);
            }
            for (const m of txt.matchAll(/(?:^|[^\d.])(\d*\.?\d+)\s+w(?![\w])/g)) {
              const v = parseFloat(m[1]);
              if (v > 0 && v < 0.25) { hairPages.push(i + 1); break; }
            }
          } catch (e) {}
        });
        if (hairPages.length)
          warns.push(`헤어라인(0.25pt 미만 선) — ${_pfFmtPages(hairPages)} · 인쇄 시 선이 끊기거나 안 보일 수 있음 (0.25pt 이상 권장)`);

        // 5) 이미지 실효 해상도 (pdf.js 연산자 + CTM 추적 — 배치 크기 대비 원본 픽셀)
        if (globalPdfDoc) {
          const OPS = pdfjsLib.OPS, U = pdfjsLib.Util;
          const low = [], edgeTextPages = [];
          const m3 = 3 * 72 / 25.4;   // 안전여백 3mm (pt)
          const lim = Math.min(n, globalPdfDoc.numPages);
          for (let i = 1; i <= lim; i++) {
            try {
              const page = await globalPdfDoc.getPage(i);
              // 텍스트 안전여백: 재단 가장자리 3mm 이내에 글자가 있으면 잘릴 위험
              try {
                const tc = await page.getTextContent();
                const vb = page.view;   // [x0, y0, x1, y1]
                for (const it of tc.items) {
                  if (!it.str || !it.str.trim()) continue;
                  const tr = it.transform;
                  const th = Math.hypot(tr[2], tr[3]) || Math.hypot(tr[0], tr[1]) || 0;
                  const x = tr[4], y = tr[5], w = it.width || 0;
                  if (x < vb[0] + m3 || x + w > vb[2] - m3 || y < vb[1] + m3 || y + th > vb[3] - m3) {
                    edgeTextPages.push(i); break;
                  }
                }
              } catch (e) {}
              const opl = await page.getOperatorList();
              let m = [1, 0, 0, 1, 0, 0]; const st = []; let minDpi = Infinity;
              for (let k = 0; k < opl.fnArray.length; k++) {
                const fn = opl.fnArray[k], a = opl.argsArray[k];
                if (fn === OPS.save) st.push(m.slice());
                else if (fn === OPS.restore) m = st.pop() || [1, 0, 0, 1, 0, 0];
                else if (fn === OPS.transform) m = U.transform(m, a);
                else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
                  let img = null; try { img = page.objs.get(a[0]); } catch (e) {}
                  if (!img || !img.width) continue;
                  const dispW = Math.hypot(m[0], m[1]), dispH = Math.hypot(m[2], m[3]);   // pt
                  if (dispW < 6 || dispH < 6) continue;   // 아이콘급 미세 배치 제외
                  const dpi = Math.min(img.width / (dispW / 72), img.height / (dispH / 72));
                  if (dpi < minDpi) minDpi = dpi;
                }
              }
              if (minDpi < 150) low.push({ p: i, dpi: Math.max(1, Math.round(minDpi)) });
              page.cleanup();
            } catch (e) {}
            updateProgress(Math.round(i / lim * 100));
          }
          if (low.length)
            warns.push(`저해상도 이미지 — ${low.slice(0, 8).map(x => `${x.p}쪽 ${x.dpi}dpi`).join(', ')}${low.length > 8 ? ` 외 ${low.length - 8}쪽` : ''} · 인쇄 권장 300dpi, 150dpi 미만은 흐릿하게 출력됨`);
          if (edgeTextPages.length)
            warns.push(`재단 위험 텍스트 — ${_pfFmtPages(edgeTextPages)} · 글자가 가장자리 3mm 안전여백 이내에 있어 재단 시 잘릴 수 있음`);
        }
      } catch (e) {
        console.error('프리플라이트 오류:', e);
        hideLoading(); progressBar.style.display = 'none';
        setBtnBusy('pfMainBtn', false); setBtnBusy('sbPfBtn', false);
        showError('프리플라이트 검사 실패: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      hideLoading(); progressBar.style.display = 'none';
      setBtnBusy('pfMainBtn', false); setBtnBusy('sbPfBtn', false);
      const sec = (icon, title, arr, color) => arr.length
        ? `<div style="margin-bottom:14px;"><div style="font-weight:700; color:${color}; margin-bottom:4px;">${icon} ${title} ${arr.length}건</div>${arr.map(t => `<div style="margin:3px 0 3px 10px;">· ${t}</div>`).join('')}</div>` : '';
      const body = document.getElementById('preflightBody');
      body.innerHTML = (!errs.length && !warns.length && !infos.length)
        ? `<div style="font-size:15px;">✅ <b>발견된 문제 없음</b> — 출력에 적합한 원고입니다.</div>`
        : sec('✖', '경고 (출력 사고 위험)', errs, '#c62828')
          + sec('⚠', '주의', warns, '#b26a00')
          + sec('ℹ', '정보', infos, '#48484a')
          + `<div style="color:#8e8e93; font-size:12px; border-top:1px solid #e5e5ea; padding-top:8px;">경고 항목은 인쇄 전 해결을 권장합니다. 검사 대상: 원본 문서(편집·적용 전)</div>`;
      document.getElementById('preflightModal').style.display = 'block';
    }

    // ── 페이지 삭제 · 빈 페이지 삽입 ────────────────────────────────────────
    function blankThumbnail() {
      const c = document.createElement('canvas');
      c.width = 120; c.height = 170;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 120, 170);
      ctx.strokeStyle = '#dee2e6';
      ctx.lineWidth = 1;
      ctx.strokeRect(1, 1, 118, 168);
      ctx.fillStyle = '#ced4da';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('빈 페이지', 60, 90);
      return c.toDataURL('image/jpeg', 0.8);
    }

    function rebuildPageNums() {
      // 흑백 선택(selectedPages)은 pageNum 기반이라 번호를 다시 매기면 어긋난다.
      // 예전엔 통째로 clear()했는데, 그러면 빈 페이지 삽입·삭제·이동만 해도 흑백변환
      // 선택이 전부 풀려 컬러/흑백 집계가 원래대로 리셋됐다 → 새 번호로 재매핑해 유지.
      // (삭제된 페이지의 선택은 자연 소멸, 복제본은 원본과 함께 선택 유지)
      const newSel = new Set();
      pageResults.forEach((r, i) => {
        if (!r) return;
        if (selectedPages.has(r.pageNum)) newSel.add(i + 1);
        r.pageNum = i + 1;
      });
      selectedPages.clear();
      newSel.forEach(n => selectedPages.add(n));
      updateSelectedCount();
    }

    function syncTabPageResults() {
      if (!activeTabId || !tabs.has(activeTabId)) return;
      const tab = tabs.get(activeTabId);
      tab.pageResults = pageResults;
      tab.colorCount = pageResults.filter(r => r && r.isColor && !r.isBlank).length;
      tab.bwCount    = pageResults.filter(r => r && (!r.isColor || r.isBlank)).length;
    }

    function rerenderPages() {
      setTimeout(initSidebarObserver, 150);
      const results = pageResults.filter(Boolean);
      const total = results.length;
      const colorList = results.filter(r => r.isColor && !r.isBlank).map(r => r.pageNum);
      const grayList  = results.filter(r => !r.isColor || r.isBlank).map(r => r.pageNum);
      totalPagesEl.textContent     = total;
      colorPagesEl.textContent     = colorList.length;
      grayscalePagesEl.textContent = grayList.length;
      colorPercentEl.textContent   = Math.round(colorList.length / Math.max(1, total) * 100) + '%';
      rangeSummary.innerHTML = `<strong>컬러 페이지:</strong> ${formatRanges(colorList)}<br><strong>흑백 페이지:</strong> ${formatRanges(grayList)}`;
      renderAllPages(pageResults);
      if (activeTabId && tabs.has(activeTabId)) updateFileInfo(tabs.get(activeTabId));
    }

    function setPageEdited() {
      pageEdited = true;
      if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).pageEdited = true;
      invalidateProcessed();
      if (typeof previewVisible === 'function' && previewVisible()) {
        // 미리보기가 자동 갱신되지 않는 상태(편집 모드 밖 + 자동 반영 꺼짐)라면, 화면에는 방금
        // 무효화된 옛 결과가 그대로 남아 회전·삭제 같은 편집이 "먹지 않는" 것처럼 보인다.
        // 이때는 미리보기를 닫아 실제 썸네일 그리드로 돌아가 편집 결과가 바로 보이게 한다.
        const autoRefresh = document.body.classList.contains('edit-fullscreen') || liveAutoPreview;
        if (autoRefresh) scheduleLivePreview();
        else if (typeof closePreview === 'function') closePreview();
      }
    }

    function updateUndoBtn() {
      const u = document.getElementById('undoBtn');
      const r = document.getElementById('redoBtn');
      if (u) u.style.display = undoStack.length > 0 ? '' : 'none';
      if (r) r.style.display = redoStack.length > 0 ? '' : 'none';
    }

    // ── 실행취소 / 다시실행 히스토리 (페이지 순서·회전·삽입·삭제 모두 지원) ──
    // 스냅샷 = 현재 페이지 객체 배열(참조)의 순서 + 각 페이지 회전값
    function snapshotPages() {
      return {
        order: pageResults.slice(),
        rot:   pageResults.map(r => (r ? (r.rotation || 0) : 0)),
      };
    }

    function syncHistoryToTab() {
      if (activeTabId && tabs.has(activeTabId)) {
        const t = tabs.get(activeTabId);
        t.undoStack = undoStack;
        t.redoStack = redoStack;
      }
    }

    // 변경을 가하기 직전에 호출 — 현재 상태를 실행취소 스택에 저장하고 다시실행 스택을 비움
    function pushHistory() {
      undoStack.push(snapshotPages());
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack.length = 0;
      syncHistoryToTab();
      setDirty(true); // 페이지 편집 발생 → 저장 안 한 상태
    }

    function restoreSnapshot(snap) {
      pageResults.length = 0;
      snap.order.forEach(o => pageResults.push(o));
      snap.order.forEach((o, i) => { if (o) o.rotation = snap.rot[i]; });
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
    }

    function undoEdit() {
      if (!undoStack.length) return;
      redoStack.push(snapshotPages());
      restoreSnapshot(undoStack.pop());
      syncHistoryToTab();
      setPageEdited();
      updateUndoBtn();
    }

    function redoEdit() {
      if (!redoStack.length) return;
      undoStack.push(snapshotPages());
      restoreSnapshot(redoStack.pop());
      syncHistoryToTab();
      setPageEdited();
      updateUndoBtn();
    }

    function deletePage(idx) {
      pushHistory();
      pageResults.splice(idx, 1);
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
      setPageEdited();
      updateUndoBtn();
    }

    // ── 챕터(합본 파일 구분) 단위 조작 ──────────────────────────────────────────
    // 화면의 챕터 구분선과 동일한 규칙으로 연속된 페이지 묶음(run)을 계산한다.
    // renderAllPages와 같게: r.chapter가 있고 직전 챕터와 다르면 새 run 시작,
    // 그 외(챕터 없는 빈 페이지 등)는 현재 run에 이어붙인다. run.idxs는 pageResults 인덱스.
    function chapterRuns() {
      const runs = [];
      let prev = null, cur = null;
      pageResults.forEach((r, i) => {
        if (!r) return;
        if (r.chapter && r.chapter !== prev) {
          cur = { name: r.chapter, idxs: [i] };
          runs.push(cur);
          prev = r.chapter;
        } else if (cur) {
          cur.idxs.push(i);
        }
      });
      return runs;
    }

    // 챕터 삭제 — 그 챕터에 속한 모든 페이지 제거 (run 시작 인덱스로 식별)
    function deleteChapterAt(startIdx) {
      hideCtxMenu();
      const runs = chapterRuns();
      const run = runs.find(r => r.idxs[0] === startIdx);
      if (!run) return;
      if (runs.length <= 1) { showError('마지막 남은 챕터는 삭제할 수 없습니다.'); return; }
      if (!confirm(`'${run.name}' 챕터의 ${run.idxs.length}개 페이지를 모두 삭제할까요?`)) return;
      pushHistory();
      [...run.idxs].sort((a, b) => b - a).forEach(i => pageResults.splice(i, 1));
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
      setPageEdited();
      updateUndoBtn();
      showSuccess(`'${run.name}' 챕터(${run.idxs.length}페이지)를 삭제했습니다.`);
    }

    // 챕터 위치 이동 — 인접한 챕터와 통째로 자리 교환 (dir: -1 위 / +1 아래)
    function moveChapterRun(startIdx, dir) {
      hideCtxMenu();
      const runs = chapterRuns();
      const pos = runs.findIndex(r => r.idxs[0] === startIdx);
      if (pos < 0) return;
      const other = pos + dir;
      if (other < 0 || other >= runs.length) return;
      pushHistory();
      const first = Math.min(pos, other), second = Math.max(pos, other);
      const r1 = runs[first], r2 = runs[second];
      const s = r1.idxs[0];
      const e = r2.idxs[r2.idxs.length - 1];
      const block1 = pageResults.slice(r1.idxs[0], r1.idxs[r1.idxs.length - 1] + 1);
      const block2 = pageResults.slice(r2.idxs[0], r2.idxs[r2.idxs.length - 1] + 1);
      // 인접 run이라 [s..e] 구간은 block1+block2로 정확히 덮인다 → 순서만 뒤집어 재배치
      pageResults.splice(s, e - s + 1, ...block2, ...block1);
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
      setPageEdited();
      updateUndoBtn();
    }

    // 커스텀 텍스트 입력 대화상자 (Electron은 window.prompt 미지원 → 직접 구현)
    function promptText(message, defaultValue) {
      return new Promise(resolve => {
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:100060;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;color:#1d1d1f;min-width:320px;max-width:90vw;padding:20px 22px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.4);';
        const msg = document.createElement('div');
        msg.style.cssText = 'font-size:0.9em;white-space:pre-line;margin-bottom:12px;line-height:1.5;';
        msg.textContent = message;
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = defaultValue || '';
        inp.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d2d2d7;border-radius:8px;font-size:0.9em;';
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;';
        const cancel = document.createElement('button'); cancel.textContent = '취소';
        cancel.style.cssText = 'padding:8px 16px;border:1px solid #d2d2d7;background:#fff;border-radius:8px;cursor:pointer;font-size:0.85em;';
        const ok = document.createElement('button'); ok.textContent = '확인';
        ok.style.cssText = 'padding:8px 16px;border:none;background:#48484a;color:#fff;border-radius:8px;cursor:pointer;font-size:0.85em;font-weight:600;';
        btns.append(cancel, ok);
        box.append(msg, inp, btns); ov.append(box); document.body.appendChild(ov);
        const done = (v) => { ov.remove(); resolve(v); };
        cancel.onclick = () => done(null);
        ok.onclick = () => done(inp.value);
        ov.onclick = (e) => { if (e.target === ov) done(null); };
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); done(inp.value); }
          else if (e.key === 'Escape') { e.preventDefault(); done(null); }
        });
        setTimeout(() => { inp.focus(); inp.select(); }, 30);
      });
    }

    // 선택(우클릭)한 페이지부터 새 챕터로 나누기 — 그 페이지가 새 챕터의 시작이 된다.
    // · 현재 챕터 안이면: 그 페이지~챕터 끝을 새 이름으로 분리 (챕터를 둘로 쪼갬)
    // · 챕터가 전혀 없는 문서면: 앞부분은 원본 파일명, 이 페이지부터는 새 이름 (두 챕터 생성)
    async function splitChapterAt(idx) {
      hideCtxMenu();
      const r = pageResults[idx];
      if (!r) return;
      const runs = chapterRuns();
      const run = runs.find(x => x.idxs.includes(idx));
      if (run && run.idxs[0] === idx) {
        showError('이미 이 페이지에서 챕터가 시작됩니다.');
        return;
      }
      // 나눌 구간의 끝 인덱스 계산
      let segEnd = pageResults.length - 1;
      if (run) {
        segEnd = run.idxs[run.idxs.length - 1];
      } else {
        for (let i = idx + 1; i < pageResults.length; i++) {
          if (pageResults[i] && pageResults[i].chapter) { segEnd = i - 1; break; }
        }
      }
      const baseName = run ? run.name
        : ((activeTabId && tabs.has(activeTabId) && tabs.get(activeTabId).fileName) || originalFileName || '문서');
      const defName = run ? `${run.name} (2)` : `${baseName.replace(/\.[^.]+$/, '')} (2)`;
      const input = await promptText('이 페이지부터 새 챕터로 나눕니다.\n새 챕터 이름:', defName);
      if (input == null) return;   // 취소
      const newName = input.trim() || defName;
      pushHistory();
      // 챕터가 전혀 없던 문서면 앞부분(0~idx-1)을 원본 파일명 챕터로 태깅해 헤더가 생기게 한다.
      if (runs.length === 0 && idx > 0) {
        for (let i = 0; i < idx; i++) if (pageResults[i]) pageResults[i].chapter = baseName;
      }
      for (let i = idx; i <= segEnd; i++) if (pageResults[i]) pageResults[i].chapter = newName;
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
      setPageEdited();
      updateUndoBtn();
      showSuccess(`'${newName}' 챕터로 나눴습니다.`);
    }

    // 페이지 복제 — 대상이 선택된 페이지에 포함되면 선택 전체를, 아니면 그 페이지 하나만 바로 뒤에 복제
    function duplicatePage(idx) {
      const r = pageResults[idx];
      if (!r) return;
      pushHistory();
      const targets = (selectedPages.size > 1 && selectedPages.has(r.pageNum))
        ? pageResults.map((p, i) => ({ p, i })).filter(x => x.p && selectedPages.has(x.p.pageNum))
        : [{ p: r, i: idx }];
      // 뒤에서부터 삽입해 앞쪽 인덱스가 밀리지 않게
      for (let k = targets.length - 1; k >= 0; k--) {
        pageResults.splice(targets[k].i + 1, 0, { ...targets[k].p });
      }
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
      setPageEdited();
      updateUndoBtn();
      showSuccess(`${targets.length}개 페이지를 복제했습니다.`);
    }

    // ── 페이지 클립보드 (Ctrl+C 복사 · Ctrl+X 잘라내기 · Ctrl+V 붙여넣기) ──
    // 클론만 보관 — undo 스냅샷과 객체 참조가 얽히지 않게 하고, 여러 번 붙여넣기 허용
    let pageClipboard = [];
    function clipTargets() {
      // 선택된 페이지 우선(문서 순서), 선택이 없으면 마우스가 올라간 페이지
      if (selectedPages.size) {
        return pageResults.map((p, i) => ({ p, i })).filter(x => x.p && selectedPages.has(x.p.pageNum));
      }
      if (ctxTargetIdx >= 0 && pageResults[ctxTargetIdx]) return [{ p: pageResults[ctxTargetIdx], i: ctxTargetIdx }];
      return [];
    }
    function copyPagesToClipboard() {
      const t = clipTargets();
      if (!t.length) { showError('복사할 페이지를 클릭해 선택하거나 마우스를 올려주세요.'); return; }
      pageClipboard = t.map(x => ({ ...x.p }));
      showSuccess(`${t.length}개 페이지 복사됨 — 원하는 페이지에 마우스를 올리고 Ctrl+V로 그 뒤에 붙여넣기`);
    }
    function cutPagesToClipboard() {
      const t = clipTargets();
      if (!t.length) { showError('잘라낼 페이지를 클릭해 선택하거나 마우스를 올려주세요.'); return; }
      if (t.length >= pageResults.filter(Boolean).length) { showError('모든 페이지를 잘라낼 수는 없습니다.'); return; }
      pageClipboard = t.map(x => ({ ...x.p }));
      pushHistory();
      const idxSet = new Set(t.map(x => x.i));
      for (let i = pageResults.length - 1; i >= 0; i--) if (idxSet.has(i)) pageResults.splice(i, 1);
      ctxTargetIdx = -1;   // 삭제로 인덱스가 밀려 무효
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
      setPageEdited();
      updateUndoBtn();
      showSuccess(`${t.length}개 페이지 잘라냄 — 원하는 페이지에 마우스를 올리고 Ctrl+V로 그 뒤에 붙여넣기`);
    }
    function pastePagesFromClipboard() {
      if (!pageClipboard.length) { showError('붙여넣을 페이지가 없습니다 — 먼저 Ctrl+C(복사) 또는 Ctrl+X(잘라내기) 하세요.'); return; }
      pushHistory();
      const atEnd = !(ctxTargetIdx >= 0 && ctxTargetIdx < pageResults.length);
      const at = atEnd ? pageResults.length : ctxTargetIdx + 1;
      pageResults.splice(at, 0, ...pageClipboard.map(c => ({ ...c })));
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
      setPageEdited();
      updateUndoBtn();
      showSuccess(`${pageClipboard.length}개 페이지를 ${atEnd ? '맨 뒤에' : (at + 1) + '번 위치에'} 붙여넣었습니다.`);
    }

    function insertBlankPage(afterIdx) {
      // afterIdx = -1 이면 맨 앞에 삽입
      pushHistory();
      const tab = activeTabId ? tabs.get(activeTabId) : null;
      const pageSize = (tab && tab.defaultPageSize) ? tab.defaultPageSize : [595.28, 841.89];
      const blank = {
        pageNum: 0, originalIdx: null,
        isColor: false, isBlank: true, rotation: 0,
        thumbnail: blankThumbnail(), pageSize,
      };
      pageResults.splice(afterIdx + 1, 0, blank);
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
      setPageEdited();
      updateUndoBtn();
    }

    function renderAllPages(results) {
      pagesGrid.innerHTML = '';
      const chTotal = chapterRuns().length;   // 챕터(파일 구분) 총 개수 — 이동 버튼 끝단 비활성화용
      let prevChapter = null, chapterNo = 0;
      results.forEach((r, idx) => {
        if (!r) return;
        if (r.chapter && r.chapter !== prevChapter) {
          chapterNo++;
          pagesGrid.appendChild(makeChapterDivider(chapterNo, r.chapter, chapterRunLength(results, idx, r.chapter), idx, chTotal));
          prevChapter = r.chapter;
        }
        pagesGrid.appendChild(renderPageItem(r, idx));
      });
      renderSidebar(results);
      if (typeof markSpreadFirst === 'function') markSpreadFirst();   // 📖 펼침 모드 첫 페이지 표식
    }

    // 합본 그리드용 파일 구분 헤더(전체 열 너비 차지) — 위/아래 이동·삭제 버튼 포함
    // no=1based 순번, startIdx=이 챕터 첫 페이지의 pageResults 인덱스, total=챕터 총수
    function makeChapterDivider(no, name, pageCount, startIdx, total) {
      const d = document.createElement('div');
      d.className = 'chapter-divider';
      const badge = document.createElement('span'); badge.className = 'chapter-badge'; badge.textContent = '파일 ' + no;
      const nm = document.createElement('span'); nm.className = 'chapter-name'; nm.textContent = '📄 ' + name;
      const pg = document.createElement('span'); pg.className = 'chapter-pages'; pg.textContent = pageCount + '페이지';
      const actions = document.createElement('span'); actions.className = 'chapter-actions';
      const mkBtn = (cls, html, title, disabled, fn) => {
        const b = document.createElement('button');
        b.className = 'ch-btn' + (cls ? ' ' + cls : '');
        b.innerHTML = html; b.title = title; b.disabled = !!disabled;
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        return b;
      };
      actions.append(
        mkBtn('', '▲', '이 챕터를 위로 이동', no <= 1,     () => moveChapterRun(startIdx, -1)),
        mkBtn('', '▼', '이 챕터를 아래로 이동', no >= total, () => moveChapterRun(startIdx, +1)),
        mkBtn('ch-del', '🗑', '이 챕터 전체 삭제', total <= 1, () => deleteChapterAt(startIdx)),
      );
      d.append(badge, nm, pg, actions);
      return d;
    }

    // idx에서 시작해 같은 챕터가 연속되는 페이지 수 (널 항목은 건너뜀, 다른 챕터에서 중단)
    function chapterRunLength(results, startIdx, chapter) {
      let n = 0;
      for (let j = startIdx; j < results.length; j++) {
        const p = results[j];
        if (!p) continue;
        if (p.chapter === chapter) n++; else break;
      }
      return n;
    }


    // ── 📖 E-book 시안 (고객 확인용 단일 HTML) ─────────────────────────────────
    // 아래 <EBOOK-CORE> 구간은 **순수 함수·상수만** 둔다(DOM·앱 전역 참조 금지).
    // scripts/build-ebook-standalone.js가 이 구간을 그대로 떼어 독립 HTML 도구로 굽는다.
    // 여기에 앱 전역을 참조하는 코드를 넣으면 독립 도구가 조용히 깨진다.
    // <EBOOK-CORE>

    // 스프레드(펼침면) 구성 — 0-based 페이지 인덱스, null은 빈 면.
    // coverSingle: 표지를 단독으로 세워 실제 책과 짝을 맞춘다.
    // bind='right'(우철)면 펼침면 안의 좌우를 뒤집는다.
    function ebookSpreads(n, coverSingle, bind) {
      const out = [];
      if (n <= 0) return out;
      let i = 0;
      if (coverSingle) { out.push([null, 0]); i = 1; }
      for (; i < n; i += 2) out.push([i, i + 1 < n ? i + 1 : null]);
      return bind === 'right' ? out.map(s => [s[1], s[0]]) : out;
    }

    const EBOOK_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#161618;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕",sans-serif;overflow:hidden}
.bar{position:fixed;top:0;left:0;right:0;height:52px;background:#000;display:flex;align-items:center;gap:12px;padding:0 16px;z-index:20;border-bottom:1px solid #333}
.bar .t{font-weight:700;font-size:0.95em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:26vw}
.bar .spec{font-size:0.78em;color:#9a9a9e;white-space:nowrap}
.bar .sp{flex:1}
.b{border:none;border-radius:7px;padding:7px 12px;font-size:0.8em;font-weight:700;cursor:pointer;background:#2c2c2e;color:#f5f5f7;white-space:nowrap}
.b:hover{background:#3a3a3c}
.b.on{background:#ffd60a;color:#1d1d1f}
/* ── 왼쪽 페이지 목록 — 한 줄에 펼침면(두 쪽) ── */
.rail{position:fixed;top:52px;bottom:56px;left:0;width:206px;background:#101012;border-right:1px solid #2c2c2e;overflow-y:scroll;padding:10px 8px 20px;z-index:15;display:none}
.railon .rail{display:block}
.rail::-webkit-scrollbar{width:9px}
.rail::-webkit-scrollbar-thumb{background:#3a3a3c;border-radius:5px}
.ri{display:flex;gap:2px;margin-bottom:9px;cursor:pointer;border:2px solid transparent;border-radius:4px;padding:1px}
.rp{position:relative;flex:1 1 0;min-width:0;background:#fff;box-shadow:0 3px 10px rgba(0,0,0,.5)}
.rp.empty{background:rgba(255,255,255,.05);box-shadow:none}
.rp img{display:block;width:100%;height:auto}
.ri:hover{border-color:#5a5a5e}
.ri.on{border-color:#ffd60a}
.rp .rn{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.62);color:#f5f5f7;font-size:10px;text-align:center;padding:2px 0;font-weight:700}
/* 책상 위에 책을 올려 둔 느낌 — 가운데가 밝고 가장자리로 갈수록 어두워진다.
   무대는 넘김 중에 스크롤바가 생겼다 사라지며 화면이 좌우로 떨리지 않도록 고정한다
   (맞춤 배율이라 항상 화면 안에 들어온다). 실제 크기 모드에서만 스크롤을 허용하고,
   그때도 scrollbar-gutter로 자리를 미리 비워 두어 흔들리지 않게 한다.
   touch-action:none — 손가락으로 페이지를 끌 때 화면이 같이 스크롤되지 않게. */
.stage{position:fixed;top:52px;bottom:56px;left:0;right:0;display:flex;align-items:center;justify-content:center;padding:26px;overflow:hidden;touch-action:none;background:radial-gradient(ellipse at 50% 40%,#2b2b30 0%,#161618 62%,#0d0d0f 100%)}
.realsize .stage{overflow:auto;scrollbar-gutter:stable both-edges}
.railon .stage{left:206px}
.dragging,.dragging .pg{cursor:grabbing}
.spread{position:relative;display:flex;align-items:flex-start;perspective:2600px}
.pg{position:relative;background:#fff;flex:none;box-shadow:0 14px 34px rgba(0,0,0,.5)}
.pg img{display:block;width:100%;height:100%;object-fit:contain;background:#fff;-webkit-user-drag:none;user-select:none}
.pg.blank{background:rgba(255,255,255,.04);box-shadow:none}
.pg .no{position:absolute;bottom:-22px;left:0;right:0;text-align:center;font-size:0.72em;color:#8e8e93}
.trim{position:absolute;border:1px dashed rgba(255,70,70,.9);pointer-events:none}
.wm{position:absolute;inset:0;pointer-events:none;background-repeat:repeat;opacity:.15}
/* ── 책 느낌(body.paper) ── 색을 정확히 봐야 할 때는 툴바에서 끌 수 있다 ── */
.paper .spread{filter:drop-shadow(0 22px 28px rgba(0,0,0,.55))}
.paper .pg{box-shadow:none}
.paper .pg.l{border-radius:3px 0 0 3px}
.paper .pg.r{border-radius:0 3px 3px 0}
.gut{position:absolute;top:0;bottom:0;pointer-events:none;display:none}
.paper .gut{display:block}
/* ── 넘어가는 낱장 ──
   한 장을 세로로 여러 조각(.st)으로 자르고 경첩처럼 이어 붙였다. 책등 쪽 조각이 주 회전을
   맡고 바깥으로 갈수록 조금씩 더 돌아, 넘기는 동안 종이가 활처럼 휘었다가 다시 펴진다.
   조각마다 앞면(.sfc)과 뒷면(.sbc)이 있고, 그림은 배경 이미지를 조각 폭만큼 밀어 붙인다. */
.leaf{position:absolute;transform-style:preserve-3d;z-index:9;pointer-events:none}
.st{position:absolute;top:0;transform-style:preserve-3d;will-change:transform}
.sfc{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;background:#fff no-repeat;overflow:hidden}
.sbc{transform:rotateY(180deg)}
.stsh,.stgu{position:absolute;inset:0;pointer-events:none;will-change:opacity}
.stwm{position:absolute;inset:0;background-repeat:repeat;opacity:.15;pointer-events:none}
.nav{position:fixed;top:52px;bottom:56px;left:0;width:15%;cursor:pointer;z-index:10;opacity:0;transition:opacity .15s;display:flex;align-items:center;justify-content:center;font-size:2.4em;color:#fff;touch-action:none}
.nav:hover{opacity:.8;background:linear-gradient(90deg,rgba(0,0,0,.45),transparent)}
.railon .nav{left:206px}
.nav.r{left:auto;right:0}
.railon .nav.r{left:auto}
.nav.r:hover{background:linear-gradient(270deg,rgba(0,0,0,.45),transparent)}
.foot{position:fixed;bottom:0;left:0;right:0;height:56px;background:#000;border-top:1px solid #333;display:flex;align-items:center;gap:12px;padding:0 16px;z-index:20}
.foot input[type=range]{flex:1;accent-color:#ffd60a}
.foot .n{font-size:0.8em;color:#c7c7cc;min-width:104px;text-align:center}
.jump{width:64px;background:#1c1c1e;color:#f5f5f7;border:1px solid #3a3a3c;border-radius:6px;padding:6px 8px;font-size:0.8em;text-align:center}
.jlbl{font-size:0.76em;color:#8e8e93;white-space:nowrap}
.note{font-size:0.72em;color:#8e8e93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34vw}
/* 🔍 확대 보기 — 핀치(손가락 두 개)·휠로 키우고 끌어서 옮긴다. 화면 밖으로 밀려나 못 보는
   영역이 없도록 위치를 항상 화면 안으로 되돌린다(zClamp). */
.zoomv{position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:40;display:none;overflow:hidden;touch-action:none}
.zimg{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform;user-select:none;-webkit-user-drag:none}
.zx{position:absolute;top:10px;right:12px;z-index:2;width:42px;height:42px;border-radius:21px;
  background:rgba(255,255,255,.16);color:#fff;font-size:19px;font-weight:700;display:flex;
  align-items:center;justify-content:center;cursor:pointer;user-select:none}
.zx:hover{background:rgba(255,255,255,.28)}
.zhint{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:2;background:rgba(0,0,0,.62);
  color:#f5f5f7;font-size:12px;font-weight:600;padding:7px 13px;border-radius:16px;pointer-events:none;
  white-space:nowrap;max-width:94vw;overflow:hidden;text-overflow:ellipsis;transition:opacity .4s}
/* 손가락으로 잡고 끄는 안내 — 처음 한 번만 보여 주고 사라진다 */
.hint{position:fixed;left:50%;bottom:74px;transform:translateX(-50%);z-index:25;max-width:94vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:rgba(0,0,0,.72);
  color:#f5f5f7;font-size:0.78em;font-weight:600;padding:8px 14px;border-radius:20px;pointer-events:none;transition:opacity .5s}
/* ── 작은 화면(휴대폰) ── */
@media (max-width:760px){
  .bar{height:46px;gap:7px;padding:0 9px}
  .bar .spec,.note{display:none}
  .bar .t{max-width:34vw;font-size:0.85em}
  .b{padding:6px 8px;font-size:0.72em}
  .stage,.nav,.rail{top:46px}
  .stage{padding:10px}
  .rail{width:132px;padding:7px 5px 16px}
  .railon .stage,.railon .nav{left:132px}
  .foot{gap:8px;padding:0 9px}
  .foot .n{min-width:78px;font-size:0.74em}
  .jump{width:56px}
  .nav{width:22%}
}
/* ── 📱 모바일용으로 만든 시안(body.mob) — 화면을 최대한 책에 내준다 ── */
.mob .stage{padding:6px}
.mob .pg .no{display:none}
.paper .pg.s{border-radius:3px}
/* 몰입 보기 — 가로로 눕히고 잠시 두면 막대가 숨어 책만 남는다(화면을 누르면 다시 나옴) */
.bar,.foot{transition:transform .25s,opacity .25s}
.mob.immersive .bar{transform:translateY(-100%);opacity:0;pointer-events:none}
.mob.immersive .foot{transform:translateY(100%);opacity:0;pointer-events:none}
.mob.immersive .stage,.mob.immersive .nav{top:0;bottom:0}
.mob.immersive .rail{display:none}
/* 가로로 눕힌 휴대폰처럼 높이가 낮을 때는 위아래 막대도 줄인다 */
@media (max-height:560px){
  .hint{display:none}
  .mob .bar{height:40px}
  .mob .foot{height:44px}
  .mob .stage,.mob .nav,.mob .rail{top:40px;bottom:44px}
  .mob .hint{bottom:56px}
  .mob .foot .n{min-width:70px}
}
@media print{body{background:#fff}.bar,.foot,.nav,.rail,.hint{display:none}.stage{left:0}.paper .spread{filter:none}}
`;

    // 뷰어 스크립트 — 이 문자열은 템플릿 리터럴 안으로 들어가지 않지만,
    // 편집 사고를 막기 위해 백틱과 달러중괄호를 쓰지 않는다.
    const EBOOK_JS = [
      '(function(){',
      'var D=window.__PROOF__, S=D.spreads, V="book", i=0, real=false, paper=true, rail=true, anim=0;',
      'var stage=document.getElementById("stage"), rng=document.getElementById("rng"), lbl=document.getElementById("lbl");',
      'var railEl=document.getElementById("rail"), jump=document.getElementById("jump"), jlbl=document.getElementById("jlbl");',
      '// localStorage는 data:·일부 브라우저의 file:에서 접근 자체가 예외를 던진다 —',
      '// 감싸지 않으면 뷰어 스크립트가 첫 줄에서 죽어 화면이 통째로 빈다.',
      'var MM=3.7795;',
      'try{ MM=Number(localStorage.getItem("proofMM")||0)||3.7795; }catch(e){}',
      'var RTL=(D.meta.bind==="right");',
      'var NARROW=(window.innerWidth||9999)<760;   // 휴대폰 폭',
      'rail=!(NARROW||D.meta.target==="mobile");   // 좁은 화면·모바일용은 책이 우선 — 목록은 버튼으로 펼친다',
      'try{ paper=(localStorage.getItem("proofPaper")!=="0");',
      '  var rv=localStorage.getItem("proofRail"); if(rv!==null)rail=(rv!=="0"); }catch(e){}',
      '// 넘김 연출 값 — 조각 수, 자동 넘김 시간, 휘는 정도(도)',
      '// BEND = 휨의 최대 비율(바깥 끝 각도 대비). 0.7이면 가운데에서 약 65도쯤 휜다.',
      'var STRIPS=18, TURN_MS=1300, BEND=0.7;',
      '// 보는 기기 — mobile로 만든 시안은 가로일 때 두 쪽을 화면 가득, 세로일 때 한 쪽씩 보여 준다.',
      'var TG=(D.meta.target==="mobile")?"mobile":"web", MOB=(TG==="mobile"), single=false;',
      'function imgs(){return V==="book"?D.book:D.sheets;}',
      'function views(){',
      '  if(V!=="book")return D.sheets.map(function(_,k){return [k,null];});',
      '  return single?D.book.map(function(_,k){return [k];}):S;',
      '}',
      '// 지금 보고 있는 대표 쪽 — 한 쪽 보기와 펼침 보기를 오갈 때 자리를 잃지 않게 한다',
      'function curPage(){ var sp=views()[i]||[]; return (sp[0]!=null)?sp[0]:(sp[1]!=null?sp[1]:0); }',
      'function fit(sp){',
      '  // 빈 면(표지 맞은편 등)도 화면에서는 한 쪽 자리를 차지한다 — 폭 계산에서 빼면',
      '  // 배율이 두 배로 잡혀 좁은 화면에서 책이 화면 밖으로 잘린다.',
      '  var list=imgs(), book=(V==="book"), f=list[0];',
      '  var rw=f?f.w:600, rh=f?f.h:800, w=0, h=0;',
      '  sp.forEach(function(p){ var im=(p==null)?null:list[p];',
      '    if(im){ w+=im.w; h=Math.max(h,im.h); }',
      '    else if(book){ w+=rw; h=Math.max(h,rh); } });',
      '  if(!w){ w=rw*(book?2:1); h=rh; }',
      '  // 뷰포트 크기를 못 얻는 환경(0×0 미리보기·인쇄 스냅샷)에서 음수 배율이 나오면',
      '  // 페이지 상자가 0으로 찌그러져 화면이 빈 것처럼 보인다 → 최소 배율을 보장한다.',
      '  var px=MOB?18:70, py=MOB?16:56;   // 모바일은 여백을 줄여 화면을 꽉 채운다',
      '  var sc=Math.min((stage.clientWidth-px)/w,(stage.clientHeight-py)/h);',
      '  return (isFinite(sc)&&sc>0.02)?sc:1;',
      '}',
      'function viewOfPage(p){ var Ls=views();',
      '  for(var k=0;k<Ls.length;k++){ if(Ls[k][0]===p||Ls[k][1]===p) return k; } return -1; }',
      '// 왼쪽 목록 — 화면과 똑같이 펼침면(두 쪽)을 한 줄에. 아무 쪽이나 누르면 그 펼침면으로.',
      'function buildRail(){',
      '  if(!railEl)return;',
      '  var list=imgs(), Ls=views(); railEl.innerHTML="";',
      '  Ls.forEach(function(sp,k){',
      '    var row=document.createElement("div"); row.className="ri"; row.setAttribute("data-v",String(k));',
      '    sp.forEach(function(p){',
      '      var im=(p==null)?null:list[p];',
      '      if(!im&&V!=="book")return;',
      '      var cell=document.createElement("div"); cell.className="rp"+(im?"":" empty");',
      '      if(im){ var g=new Image(); g.src=im.u; g.loading="lazy"; g.alt=""; cell.appendChild(g);',
      '        var n=document.createElement("div"); n.className="rn";',
      '        n.textContent=(V==="book")?((p+1)+" 쪽"):((p+1)+" 시트"); cell.appendChild(n); }',
      '      else if(list[0]){',
      '        // 빈 면(표지 맞은편)의 높이는 옆 칸과 같아야 한다. 퍼센트 padding은 칸이 아니라',
      '        // **줄 전체 폭**을 기준으로 잡혀 두 배로 길어졌다(표지 줄만 아래에 흰 여백이 생김).',
      '        cell.style.aspectRatio=list[0].w+" / "+list[0].h;',
      '      }',
      '      row.appendChild(cell);',
      '    });',
      '    row.onclick=function(){ if(k!==i)go(k-i); };',
      '    railEl.appendChild(row);',
      '  });',
      '  markRail();',
      '}',
      'function markRail(){',
      '  if(!railEl)return;',
      '  var kids=railEl.children, cur=null;',
      '  for(var k=0;k<kids.length;k++){',
      '    var on=(+kids[k].getAttribute("data-v")===i);',
      '    kids[k].classList.toggle("on",on);',
      '    if(on)cur=kids[k];',
      '  }',
      '  if(cur&&cur.scrollIntoView){',
      '    var rt=railEl.getBoundingClientRect(), ft=cur.getBoundingClientRect();',
      '    if(ft.top<rt.top||ft.bottom>rt.bottom)cur.scrollIntoView({block:"nearest"});',
      '  }',
      '}',
      '// 펼침면 그리기 — 넘기는 동안에는 「지금 쪽 + 드러날 쪽」을 섞은 짝을 그린다.',
      '// (목적지 펼침면을 통째로 깔면, 넘기기 시작하는 순간 반대쪽 페이지가 툭 바뀌어 보인다)',
      'function drawSpread(sp){',
      '  var list=imgs(), sc=fit(sp), book=(V==="book");',
      '  var d=document.createElement("div"); d.className="spread";',
      '  sp.forEach(function(p,k){',
      '    var im=(p==null)?null:list[p];',
      '    if((!book||single)&&!im)return;',
      '    var box=document.createElement("div"); box.className="pg "+(single?"s":(k?"r":"l"))+(im?"":" blank");',
      '    var refW=im?im.w:(list[0]?list[0].w:600), refH=im?im.h:(list[0]?list[0].h:800);',
      '    var W,H;',
      '    if(real&&D.meta.mm){ W=D.meta.mm[0]*MM; H=D.meta.mm[1]*MM; }',
      '    else { W=refW*sc; H=refH*sc; }',
      '    box.style.width=W+"px"; box.style.height=H+"px";',
      '    if(im){ var g=new Image(); g.src=im.u; g.draggable=false; box.appendChild(g); }',
      '    if(im&&D.opts.wm){ var wm=document.createElement("div"); wm.className="wm"; wm.style.backgroundImage="url(\\""+D.opts.wm+"\\")"; box.appendChild(wm); }',
      '    if(im&&D.opts.trimPct>0){ var t=document.createElement("div"); t.className="trim"; var q=D.opts.trimPct;',
      '      t.style.left=(W*q)+"px"; t.style.top=(H*q)+"px"; t.style.width=(W*(1-2*q))+"px"; t.style.height=(H*(1-2*q))+"px";',
      '      box.appendChild(t); }',
      '    if(book&&!single){ var gu=document.createElement("div"); gu.className="gut"; gu.style.width="7%";',
      '      if(k){ gu.style.left="0"; gu.style.background="linear-gradient(to left,rgba(0,0,0,0),rgba(0,0,0,.30))"; }',
      '      else { gu.style.right="0"; gu.style.background="linear-gradient(to right,rgba(0,0,0,0),rgba(0,0,0,.30))"; }',
      '      box.appendChild(gu); }',
      '    if(im){ var no=document.createElement("div"); no.className="no";',
      '      no.textContent=book?((p+1)+" 쪽"):((p+1)+" 번째 시트");',
      '      box.appendChild(no);',
      '      // 모바일 가로 보기에서는 눌러도 확대하지 않는다 — 넘기려고 짚었을 뿐인데',
      '      // 화면이 커져 버려 불편하다. (누르면 숨었던 막대만 돌아온다)',
      '      var noZoom=(MOB&&!single);',
      '      box.style.cursor=noZoom?"default":"zoom-in";',
      '      box.onclick=function(){ if(dragMoved||noZoom)return; zoom(im); }; }',
      '    d.appendChild(box);',
      '  });',
      '  stage.innerHTML=""; stage.appendChild(d);',
      '  return d;',
      '}',
      'function render(){',
      '  var Ls=views(); if(i<0)i=0; if(i>=Ls.length)i=Ls.length-1;',
      '  drawSpread(Ls[i]||[]);',
      '  rng.max=String(Math.max(0,Ls.length-1)); rng.value=String(i);',
      '  lbl.textContent=(i+1)+" / "+Ls.length+(V!=="book"?" 시트":(single?" 쪽":" 펼침"));',
      '  markRail();',
      '}',
      '// 조각 한 면 — 이미지에서 자기 몫(slice)만 보이도록 배경을 밀어 붙인다.',
      '// 뒷면(back)은 rotateY(180deg)이라 조각 안에서 좌우가 뒤집히는데, 낱장 전체가 다시',
      '// 뒤집히면서 상쇄되므로 slice 번호만 반대편에서 세면 그림이 정확히 맞는다.',
      'function grad(a,b,rev){',
      '  return "linear-gradient(90deg,rgba(0,0,0,"+(rev?b:a)+"),rgba(0,0,0,"+(rev?a:b)+"))";',
      '}',
      'function stripFace(im,slice,W,H,w,back,u0,u1,rev){',
      '  var d=document.createElement("div"); d.className="sfc"+(back?" sbc":"");',
      '  if(im){ d.style.backgroundImage="url(\\""+im.u+"\\")";',
      '    d.style.backgroundSize=W+"px "+H+"px";',
      '    d.style.backgroundPosition=(-slice*w)+"px 0"; }',
      '  if(im&&D.opts.wm){ var wm=document.createElement("div"); wm.className="stwm";',
      '    wm.style.backgroundImage="url(\\""+D.opts.wm+"\\")";',
      '    wm.style.backgroundPosition=(-slice*w)+"px 0"; d.appendChild(wm); }',
      '  // 그늘 모양(조각을 가로지르는 농도 변화)은 여기서 한 번만 굽는다 —',
      '  // 프레임마다는 투명도만 바꿔 CSS 재파싱 없이 부드럽게 흐른다.',
      '  var sh=document.createElement("div"); sh.className="stsh";',
      '  sh.style.background=grad(0.26+0.74*u0,0.26+0.74*u1,rev); sh.style.opacity="0";',
      '  d.appendChild(sh);',
      '  var gu=null, g0=gutAt(u0), g1=gutAt(u1);',
      '  if(g0>0||g1>0){   // 책등 그늘은 안쪽 조각에만 필요하다',
      '    gu=document.createElement("div"); gu.className="stgu";',
      '    gu.style.background=grad(g0,g1,rev); gu.style.opacity="0";',
      '    d.appendChild(gu);',
      '  }',
      '  return {el:d, sh:sh, gu:gu};',
      '}',
      '// 낱장 만들기 — 경첩으로 이어진 조각 사슬(부모의 끝에 자식이 붙는다)',
      'function buildLeaf(r,fi,bi,hingeLeft,list){',
      '  var lf=document.createElement("div"); lf.className="leaf";',
      '  lf.style.left=r.l+"px"; lf.style.top=r.t+"px"; lf.style.width=r.w+"px"; lf.style.height=r.h+"px";',
      '  var W=r.w, H=r.h, w=W/STRIPS, ov=0.8;   // ov = 조각 이음매가 벌어져 보이지 않게 겹치는 폭',
      '  var fim=(fi==null)?null:list[fi], bim=(bi==null)?null:list[bi];',
      '  var parent=lf, strips=[];',
      '  for(var k=0;k<STRIPS;k++){',
      '    var st=document.createElement("div"); st.className="st";',
      '    st.style.width=(w+ov)+"px"; st.style.height=H+"px";',
      '    st.style.transformOrigin=(hingeLeft?"left":"right")+" center";',
      '    st.style.left=(k===0?(hingeLeft?0:(W-w-ov)):(hingeLeft?w:-w))+"px";',
      '    var u0=k/STRIPS, u1=(k+1)/STRIPS;',
      '    var f=stripFace(fim,(hingeLeft?k:(STRIPS-1-k)),W,H,w,false,u0,u1,!hingeLeft);',
      '    var b=stripFace(bim,(hingeLeft?(STRIPS-1-k):k),W,H,w,true,u0,u1,hingeLeft);',
      '    st.appendChild(f.el); st.appendChild(b.el);',
      '    parent.appendChild(st); parent=st;',
      '    strips.push({el:st, fs:f.sh, bs:b.sh, fg:f.gu, bg:b.gu});',
      '  }',
      '  return {el:lf, strips:strips};',
      '}',
      '// 진행도 p(0~1)에 맞춰 낱장의 자세를 잡는다 — 시간으로 굴리든(자동), 손으로 끌든(드래그) 같은 함수.',
      '// 책등 조각이 주 회전을 맡고 바깥 조각일수록 조금씩 더 돌아 종이가 활처럼 휜다.',
      '// 책등 그늘은 넘어가는 낱장에도 이어져야 한다. 아래 펼침면에만 그리면 낱장이 지나가는',
      '// 동안 가운데 음영이 사라졌다 다시 나타나 눈에 거슬린다. 낱장이 책등에서 들릴수록',
      '// 앞면의 그늘은 옅어지고(1-p), 반대편에 내려앉는 뒷면의 그늘은 짙어진다(p) — 그래서',
      '// 시작·끝 순간의 농도가 아래 페이지와 정확히 같아 이어짐이 끊기지 않는다.',
      'var GUTS=0.30;',
      'function gutAt(u){ return Math.max(0,1-u/0.09); }   // 책등에서 페이지 폭의 9%까지',
      '// 휨은 **책 안쪽(책등 쪽)에 몰아준다** — 실제로 책장을 넘기면 바깥은 거의 평평한 채로',
      '// 제본 근처가 크게 휜다. 바깥쪽에 몰면 종이가 스스로 말려 붙어 사라진 것처럼 보였다.',
      '// 가중치는 제곱으로 감소(∝(n-k)^2) — 선형보다 책등 쪽에 훨씬 더 몰린다.',
      'function poseLeaf(T,p){',
      '  var st=T.leaf.strips, n=st.length;',
      '  var pp=Math.max(0,Math.min(1,p));',
      '  // 휨 곡선(요청 기준점): 50%에서 100도로 가장 크게 휘고, 65%에서 80도를 지난 뒤',
      '  // 80%부터 빠르게 펴져 착지 직전에는 평평하다(넘기고 난 다음 동작이 과하지 않게).',
      '  // 바깥쪽 끝은 0→180도로만 나아간다(E). 되돌아오는 구간이 없어야 튕기는 느낌이 없다.',
      '  // 휨은 그 각도의 **비율**로 준다 — 잘라 낼 필요가 없어(항상 c<E) 기울기가 꺾이지 않고,',
      '  // 시작·끝에서 저절로 0이 되어 억지로 휘었다 갑자기 펴지는 구간이 생기지 않는다.',
      '  var E=180*p;',
      '  var c=E*BEND*Math.pow(Math.sin(Math.PI*pp),1.6);',
      '  var m=E-c;               // 책등 쪽은 휜 만큼 뒤에 남는다',
      '  // 조각별 분배 — 얇은 종이는 한곳이 접히지 않고 전체가 고르게 휜다(완만한 원호).',
      '  // 다만 휨의 중심은 **책등 쪽**에 둔다: u에 0.45 지수를 줘 최대 지점을 u=0.22 근처로 당기고,',
      '  // 바닥값 0.35로 나머지 부분도 조금씩 휘게 해 접힌 자국이 생기지 않게 한다.',
      '  var W=[], S=0;',
      '  for(var q=1;q<n;q++){ W[q]=0.35+0.65*Math.sin(Math.PI*Math.pow(q/n,0.45)); S+=W[q]; }',
      '  if(!(S>0))S=1;',

      '  var fb=0.34*p, bb=0.30*(1-p);',
      '  var gf=GUTS*(1-p), gb=GUTS*p;',
      '  for(var k=0;k<n;k++){',
      '    var s=st[k];',
      '    var a=(k===0)?m:(c*W[k]/S);',
      '    s.el.style.transform="rotateY("+(T.sign*a)+"deg)";',
      '    s.fs.style.opacity=fb; s.bs.style.opacity=bb;',
      '    if(s.fg)s.fg.style.opacity=gf;',
      '    if(s.bg)s.bg.style.opacity=gb;',
      '  }',
      '}',
      '// 속도 곡선 — 사인 이징만 쓰면 가운데가 평균의 1.57배까지 빨라져 "천천히 시작하다가',
      '// 중간에 확 넘어가는" 느낌이 난다. 직선과 반반 섞어 가운데 속도를 1.29배로 낮췄다',
      '// (시작·끝은 여전히 부드럽고, 전체적으로 고르게 흐른다).',
      'function ease(x){ var t=Math.max(0,Math.min(1,x));',
      '  return 0.5*t + 0.5*(0.5-0.5*Math.cos(Math.PI*t)); }',
      '// 넘김 시작 — 아래에는 「지금 쪽 + 드러날 쪽」을 깔고, 그 위에 낱장 한 장을 얹는다.',
      '// d>0이면 다음, d<0이면 이전. 만들지 못하면 null.',
      'function beginTurn(d){',
      '  var Ls=views(), n=i+d;',
      '  if(!d||n<0||n>=Ls.length)return null;',
      '  var from=Ls[i]||[], to=Ls[n]||[], list=imgs();',
      '  var leafR=(RTL?(d<0):(d>0));            // 넘어가는 쪽이 화면 오른쪽 면인가',
      '  var mixed=single?[to[0]]:(leafR?[from[0],to[1]]:[to[0],from[1]]);',
      '  var sp=drawSpread(mixed);',
      '  var box=single?sp.children[0]:sp.children[leafR?1:0];',
      '  if(!box)return null;',
      '  var r={l:box.offsetLeft,t:box.offsetTop,w:box.offsetWidth,h:box.offsetHeight};',
      '  if(!r.w)return null;',
      '  var leaf=buildLeaf(r,(single?from[0]:from[leafR?1:0]),(single?to[0]:to[leafR?0:1]),leafR,list);',
      '  sp.appendChild(leaf.el);',
      '  var T={leaf:leaf,sign:(leafR?-1:1),leafR:leafR,n:n,w:r.w};',
      '  poseLeaf(T,0);',
      '  return T;',
      '}',
      '// 낱장을 p0에서 p1까지 굴린 뒤 마무리 — 끝까지 넘겼으면 그 펼침면으로 확정, 아니면 원래대로.',
      'function settle(T,p0,p1,ms){',
      '  anim=1; var t0=0;',
      '  function frame(now){',
      '    if(!t0)t0=now;',
      '    var t=Math.min(1,(now-t0)/Math.max(60,ms));',
      '    poseLeaf(T,p0+(p1-p0)*ease(t));',
      '    if(t<1){ requestAnimationFrame(frame); return; }',
      '    if(p1>=1)i=T.n;',
      '    anim=0; render();',
      '  }',
      '  requestAnimationFrame(frame);',
      '}',
      'function go(d){',
      '  var Ls=views(), n=i+d; if(!d||n<0||n>=Ls.length||anim||drag)return;',
      '  // 책 느낌을 끈 상태에서는 연출 없이 곧바로 교체한다 — 흐려졌다 나타나는 처리가',
      '  // 깜박임처럼 보여 눈이 피로했다.',
      '  if(V!=="book"||!paper){ i=n; render(); return; }',
      '  var T=beginTurn(d); if(!T){ i=n; render(); return; }',
      '  settle(T,0,1,TURN_MS);',
      '}',
      '// ── 손으로 잡고 끄는 넘김 (마우스 좌클릭 드래그 · 모바일 터치) ─────────────',
      '// 페이지를 잡아 끄는 동안 낱장이 손끝을 그대로 따라오고, 놓으면 그 지점에서',
      '// 이어서 넘어가거나(많이 끌었거나 빠르게 튕겼으면) 제자리로 돌아간다.',
      'var drag=null, dragMoved=false, navTap=false;',
      'function inUI(t){ while(t&&t!==document.body){',
      '  if(t.classList&&(t.classList.contains("bar")||t.classList.contains("foot")||',
      '     t.classList.contains("rail")||t.classList.contains("zoomv")))return true;',
      '  t=t.parentNode; } return false; }',
      'function dragProgress(x){',
      '  var dx=x-drag.x0;',
      '  var p=(drag.T?(drag.T.leafR?-dx:dx):(drag.dir>0?-dx:dx))/drag.w;',
      '  return Math.max(0,Math.min(1,p));',
      '}',
      'document.addEventListener("pointerdown",function(e){',
      '  if(e.button!==0||anim||drag||inUI(e.target))return;',
      '  if(zImg)return;   // 확대 보기 중에는 페이지를 끌지 않는다 (style.display는 처음에 빈 값이라 쓰면 안 된다)',
      '  var sp=stage.firstChild; if(!sp)return;',
      '  var b=sp.getBoundingClientRect(); if(!b.width)return;',
      '  // 어느 쪽을 잡았는지로 방향 결정 — 오른쪽 면을 잡으면 다음, 왼쪽 면을 잡으면 이전',
      '  var grabR=(e.clientX>=b.left+b.width/2);',
      '  var d=grabR?(RTL?-1:1):(RTL?1:-1);',
      '  var Ls=views(), n=i+d; if(n<0||n>=Ls.length)return;',
      '  dragMoved=false;',
      '  var onNav=!!(e.target&&e.target.classList&&e.target.classList.contains("nav"));',
      '  drag={x0:e.clientX,y0:e.clientY,t0:Date.now(),dir:d,T:null,w:b.width/2,p:0,id:e.pointerId,nav:onNav};',
      '  if(V==="book"&&paper){ drag.T=beginTurn(d); if(drag.T)drag.w=drag.T.w; }',
      '  document.body.classList.add("dragging");',
      '},true);',
      'document.addEventListener("pointermove",function(e){',
      '  if(!drag||e.pointerId!==drag.id)return;',
      '  if(!dragMoved&&Math.abs(e.clientX-drag.x0)<5&&Math.abs(e.clientY-drag.y0)<5)return;',
      '  dragMoved=true; hideHint();',
      '  drag.p=dragProgress(e.clientX);',
      '  if(drag.T)poseLeaf(drag.T,drag.p);',
      '  e.preventDefault();',
      '});',
      'function endDrag(e){',
      '  if(!drag||(e&&e.pointerId!==undefined&&e.pointerId!==drag.id))return;',
      '  var T=drag.T, p=drag.p, ms=Math.max(1,Date.now()-drag.t0);',
      '  var flick=(Math.abs((e?e.clientX:drag.x0)-drag.x0)/ms)>0.55;   // 빠르게 튕겼는가',
      '  var done=dragMoved?(p>0.32||(flick&&p>0.06)):!!drag.nav;   // 넘김 표시를 톡 누르면 그대로 넘긴다',
      '  if(!dragMoved&&drag.nav){ navTap=true; setTimeout(function(){ navTap=false; },400); }',
      '  var dir=drag.dir, n=i+dir;',
      '  document.body.classList.remove("dragging");',
      '  drag=null;',
      '  if(T){ settle(T,p,done?1:0,done?(1-p)*TURN_MS*0.8:p*TURN_MS*0.7); }',
      '  else if(done&&n>=0&&n<views().length){ i=n; render(); }',
      '  if(!dragMoved){ immersive(false); armImmersive(); }   // 톡 누르면 막대 복귀',
      '  else armImmersive();',
      '  setTimeout(function(){ dragMoved=false; },0);   // 끌고 나서 놓을 때 확대가 열리지 않게',
      '}',
      'document.addEventListener("pointerup",endDrag);',
      'document.addEventListener("pointercancel",endDrag);',
      'function goPage(v){',
      '  var list=imgs(); v=Math.round(v);',
      '  if(!v||v<1||v>list.length)return false;',
      '  var k=viewOfPage(v-1); if(k<0)return false;',
      '  if(k!==i)go(k-i);',
      '  return true;',
      '}',
      '// ── 🔍 확대 보기 ─────────────────────────────────────────────────────',
      '// 처음에는 한 쪽 전체가 화면에 다 들어오고(못 보는 구석이 없다), 거기서',
      '// 손가락 두 개(핀치)·휠·두 번 두드리기로 키운 뒤 끌어서 원하는 곳을 본다.',
      'var zv=document.getElementById("zoomv");',
      'var zImg=null, zIm=null, zS=1, zMin=1, zMax=8, zX=0, zY=0;',
      'function zApply(){ if(zImg)zImg.style.transform="translate("+zX+"px,"+zY+"px) scale("+zS+")"; }',
      'function zClamp(){',
      '  var vw=zv.clientWidth, vh=zv.clientHeight, w=zIm.w*zS, h=zIm.h*zS;',
      '  zX=(w<=vw)?(vw-w)/2:Math.min(0,Math.max(vw-w,zX));',
      '  zY=(h<=vh)?(vh-h)/2:Math.min(0,Math.max(vh-h,zY));',
      '}',
      'function zFit(){',
      '  var vw=zv.clientWidth, vh=zv.clientHeight;',
      '  zMin=Math.min((vw-16)/zIm.w,(vh-16)/zIm.h); if(!(zMin>0))zMin=1;',
      '  zMax=zMin*10; zS=zMin; zClamp(); zApply();',
      '}',
      'function zZoomAt(cx,cy,ns){',
      '  ns=Math.max(zMin,Math.min(zMax,ns));',
      '  var k=ns/zS; zX=cx-(cx-zX)*k; zY=cy-(cy-zY)*k; zS=ns; zClamp(); zApply();',
      '}',
      'function zoom(im){',
      '  zIm=im; zv.innerHTML="";',
      '  zImg=new Image(); zImg.className="zimg"; zImg.src=im.u; zImg.draggable=false;',
      '  zImg.style.width=im.w+"px"; zImg.style.height=im.h+"px";',
      '  zv.appendChild(zImg);',
      '  var x=document.createElement("div"); x.className="zx"; x.textContent="✕";',
      '  x.onclick=function(e){ e.stopPropagation(); zClose(); }; zv.appendChild(x);',
      '  var hn=document.createElement("div"); hn.className="zhint";',
      '  hn.textContent="손가락 두 개로 벌리면 확대 · 끌어서 이동 · 두 번 두드리면 원래대로 · ✕ 닫기";',
      '  zv.appendChild(hn); setTimeout(function(){ hn.style.opacity="0"; },3500);',
      '  zv.style.display="block"; zFit();',
      '}',
      'function zClose(){ zv.style.display="none"; zv.innerHTML=""; zImg=null; zIm=null; }',
      'var zpts={}, zN=0, zLastD=0, zMoved=false;',
      'zv.addEventListener("pointerdown",function(e){',
      '  if(!zImg)return;',
      '  zpts[e.pointerId]={x:e.clientX,y:e.clientY}; zN++; zLastD=0; zMoved=false;',
      '  if(zv.setPointerCapture){ try{ zv.setPointerCapture(e.pointerId); }catch(err){} }',
      '  e.preventDefault();',
      '});',
      'zv.addEventListener("pointermove",function(e){',
      '  if(!zImg||!zpts[e.pointerId])return;',
      '  var ids=Object.keys(zpts), r=zv.getBoundingClientRect();',
      '  if(ids.length===1){',
      '    var p=zpts[e.pointerId], dx=e.clientX-p.x, dy=e.clientY-p.y;',
      '    if(Math.abs(dx)>3||Math.abs(dy)>3)zMoved=true;',
      '    zX+=dx; zY+=dy; p.x=e.clientX; p.y=e.clientY; zClamp(); zApply();',
      '  } else {',
      '    zpts[e.pointerId].x=e.clientX; zpts[e.pointerId].y=e.clientY; zMoved=true;',
      '    var a=zpts[ids[0]], b=zpts[ids[1]];',
      '    var d=Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y));',
      '    var mx=(a.x+b.x)/2-r.left, my=(a.y+b.y)/2-r.top;',
      '    if(zLastD>0&&d>0)zZoomAt(mx,my,zS*(d/zLastD));',
      '    zLastD=d;',
      '  }',
      '  e.preventDefault();',
      '});',
      'function zEnd(e){',
      '  if(!zpts[e.pointerId])return;',
      '  delete zpts[e.pointerId]; zLastD=0;',
      '  // 확대하지 않은 상태에서 그냥 톡 누르면 닫는다(끌었을 때는 닫지 않는다)',
      '  if(!Object.keys(zpts).length&&!zMoved&&zS<=zMin*1.02)zClose();',
      '}',
      'zv.addEventListener("pointerup",zEnd);',
      'zv.addEventListener("pointercancel",zEnd);',
      'zv.addEventListener("wheel",function(e){',
      '  if(!zImg)return; e.preventDefault();',
      '  var r=zv.getBoundingClientRect();',
      '  zZoomAt(e.clientX-r.left,e.clientY-r.top,zS*(e.deltaY<0?1.18:1/1.18));',
      '},{passive:false});',
      'zv.addEventListener("dblclick",function(e){',
      '  if(!zImg)return; var r=zv.getBoundingClientRect();',
      '  if(zS>zMin*1.05)zFit(); else zZoomAt(e.clientX-r.left,e.clientY-r.top,zMin*3);',
      '});',
      'window.addEventListener("resize",function(){ if(zImg)zFit(); });',
      '// 넘김 표시 클릭 — 포인터로 이미 처리했으면(navTap) 두 번 넘어가지 않게 건너뛴다',
      'document.getElementById("prev").onclick=function(){ if(!dragMoved&&!navTap)go(RTL?1:-1); };',
      'document.getElementById("next").onclick=function(){ if(!dragMoved&&!navTap)go(RTL?-1:1); };',
      'rng.oninput=function(){ var n=+this.value; if(n!==i){ if(anim){i=n;render();} else go(n-i); } };',
      'if(jump){ jump.onkeydown=function(e){ if(e.key==="Enter"){ if(!goPage(+this.value))this.select(); } };',
      '  jump.onchange=function(){ goPage(+this.value); }; }',
      'var jb=document.getElementById("jumpBtn");',
      'if(jb) jb.onclick=function(){ if(jump&&!goPage(+jump.value))jump.select(); };',
      'document.onkeydown=function(e){',
      '  if(e.target&&e.target.tagName==="INPUT")return;',
      '  if(e.key==="ArrowLeft")go(RTL?1:-1);',
      '  else if(e.key==="ArrowRight")go(RTL?-1:1);',
      '  else if(e.key==="Home"){ i=0; render(); }',
      '  else if(e.key==="End"){ i=views().length-1; render(); }',
      '  else if(e.key==="Escape")zClose(); };',
      '// 가로↔세로가 바뀌면 한 쪽 보기/펼침 보기를 갈아탄다 — 보던 쪽은 유지.',
      'function updateMode(){',
      '  document.body.classList.toggle("mob",MOB);',
      '  var want=(MOB&&V==="book"&&window.innerHeight>window.innerWidth);',
      '  if(want===single)return false;',
      '  var p0=curPage();',
      '  single=want;',
      '  document.body.classList.toggle("single",single);',
      '  var k=viewOfPage(p0); i=(k<0?0:k);',
      '  buildRail();',
      '  return true;',
      '}',
      '// 가로로 눕힌 휴대폰에서 2.5초간 손을 떼면 막대를 감춘다 — 두 쪽이 화면을 거의 가득 채운다.',
      'var IMM=false, immT=null;',
      'function immersive(on){',
      '  if(!MOB||on===IMM)return;',
      '  IMM=on; document.body.classList.toggle("immersive",on);',
      '  if(!drag&&!anim)render();',
      '}',
      'function armImmersive(){',
      '  if(!MOB)return;',
      '  clearTimeout(immT);',
      '  if(window.innerHeight>560){ immersive(false); return; }   // 세로일 때는 그대로 둔다',
      '  immT=setTimeout(function(){ immersive(true); },2500);',
      '}',
      'window.addEventListener("resize",function(){ if(drag||anim)return; updateMode(); render(); armImmersive(); });',
      'window.addEventListener("orientationchange",function(){ setTimeout(function(){ if(drag||anim)return; updateMode(); render(); },120); });',
      'var tbk=document.getElementById("tabBook"), tsh=document.getElementById("tabSheet");',
      'function setView(v){ V=v; i=0; buildRail(); render();',
      '  if(jump){ jump.value=""; jump.max=String(imgs().length); }',
      '  if(jlbl) jlbl.textContent=(v==="book"?"쪽":"시트")+" 이동"; }',
      'if(tsh) tsh.onclick=function(){ if(V==="sheet")return;',
      '  tsh.classList.add("on"); tbk.classList.remove("on"); setView("sheet"); };',
      'if(tbk) tbk.onclick=function(){ if(V==="book")return;',
      '  tbk.classList.add("on"); if(tsh)tsh.classList.remove("on"); setView("book"); };',
      'var rb=document.getElementById("realBtn"), cal=document.getElementById("calib");',
      'if(rb) rb.onclick=function(){ real=!real; rb.classList.toggle("on",real);',
      '  document.body.classList.toggle("realsize",real);   // 이때만 무대 스크롤 허용',
      '  cal.style.display=real?"":"none"; render(); };',
      'if(cal){ cal.value=String(MM); cal.oninput=function(){ MM=+this.value;',
      '  try{localStorage.setItem("proofMM",String(MM));}catch(e){} if(real)render(); }; }',
      '// 전체화면 — 휴대폰 가로 보기에서 특히 유용하다(브라우저 주소창까지 사라진다).',
      'var fsb=document.getElementById("fsBtn");',
      'if(fsb){',
      '  var root=document.documentElement;',
      '  var canFs=!!(root.requestFullscreen||root.webkitRequestFullscreen);',
      '  if(!canFs)fsb.style.display="none";',
      '  else{',
      '    fsb.onclick=function(){',
      '      try{',
      '        if(document.fullscreenElement||document.webkitFullscreenElement){',
      '          (document.exitFullscreen||document.webkitExitFullscreen).call(document);',
      '        } else {',
      '          (root.requestFullscreen||root.webkitRequestFullscreen).call(root);',
      '        }',
      '      }catch(e){}',
      '    };',
      '    var syncFs=function(){',
      '      var on=!!(document.fullscreenElement||document.webkitFullscreenElement);',
      '      fsb.classList.toggle("on",on);',
      '      fsb.textContent=on?"⛶ 전체화면 해제":"⛶ 전체화면";',
      '      setTimeout(function(){ if(!drag&&!anim){ updateMode(); render(); armImmersive(); } },80);',
      '    };',
      '    document.addEventListener("fullscreenchange",syncFs);',
      '    document.addEventListener("webkitfullscreenchange",syncFs);',
      '  }',
      '}',
      'var pb=document.getElementById("paperBtn");',
      'document.body.classList.toggle("paper",paper);',
      'if(pb){ pb.classList.toggle("on",paper);',
      '  pb.onclick=function(){ paper=!paper; pb.classList.toggle("on",paper);',
      '    document.body.classList.toggle("paper",paper);',
      '    try{localStorage.setItem("proofPaper",paper?"1":"0");}catch(e){} render(); }; }',
      'var rlb=document.getElementById("railBtn");',
      'document.body.classList.toggle("railon",rail);',
      'if(rlb){ rlb.classList.toggle("on",rail);',
      '  rlb.onclick=function(){ rail=!rail; rlb.classList.toggle("on",rail);',
      '    document.body.classList.toggle("railon",rail);',
      '    try{localStorage.setItem("proofRail",rail?"1":"0");}catch(e){} render(); }; }',
      '// 처음 열었을 때 한 번만 조작 안내 (한 번 넘기면 사라지고, 다시 열어도 안 나온다)',
      'var hintEl=null;',
      'function hideHint(){ if(!hintEl)return; hintEl.style.opacity="0";',
      '  var h=hintEl; hintEl=null; setTimeout(function(){ if(h.parentNode)h.parentNode.removeChild(h); },600);',
      '  try{localStorage.setItem("proofHint","1");}catch(e){} }',
      'try{ if(localStorage.getItem("proofHint")!=="1"){',
      '  hintEl=document.createElement("div"); hintEl.className="hint";',
      '  hintEl.textContent="페이지를 잡고 끌어 보세요 — 종이처럼 넘어갑니다 (좌우 클릭·←/→ 키도 가능)";',
      '  document.body.appendChild(hintEl);',
      '  setTimeout(hideHint,7000);',
      '} }catch(e){}',
      'if(jump) jump.max=String(imgs().length);',
      'updateMode();',
      'buildRail();',
      'render();',
      'armImmersive();',
      '})();',
    ].join('\n');

    // 워터마크(반복 대각선 글자)를 SVG data URI로 — 외부 리소스 없이 자체 완결
    function ebookWatermarkUri(text) {
      const t = String(text || '시안').replace(/[<>&"']/g, '');
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">'
        + '<text x="120" y="92" font-size="30" font-family="sans-serif" fill="#000"'
        + ' text-anchor="middle" transform="rotate(-24 120 92)">' + t + '</text></svg>';
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }

    // 시안 HTML 조립 — 이미지까지 전부 인라인된 단일 파일을 문자열로 돌려준다.
    //   data = { title, meta:{ mm:[w,h], spec, date, by, bind }, book:[{u,w,h}],
    //            sheets:[{u,w,h}], opts:{ watermark, wmText, trimPct, coverSingle } }
    function buildEbookProofHtml(data) {
      const esc = s => String(s == null ? '' : s)
        .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const book = data.book || [];
      const sheets = data.sheets || [];
      const meta = data.meta || {};
      const opts = data.opts || {};
      const payload = {
        book, sheets,
        spreads: ebookSpreads(book.length, opts.coverSingle !== false, meta.bind),
        meta: { mm: meta.mm || null, bind: meta.bind || 'left', target: meta.target === 'mobile' ? 'mobile' : 'web' },
        opts: { wm: opts.watermark ? ebookWatermarkUri(opts.wmText) : '', trimPct: +opts.trimPct || 0 },
      };
      const hasSheets = sheets.length > 0;
      // 닫는 스크립트 태그가 문자열 안에 있으면 브라우저가 거기서 스크립트를 끊는다 → 반드시 이스케이프
      // (이 주석에도 그 태그를 그대로 쓰면 안 된다 — 독립 도구로 구울 때 같은 사고가 난다)
      const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
      return '<!DOCTYPE html>\n<html lang="ko"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>' + esc(data.title || '출력 시안') + '</title><style>' + EBOOK_CSS + '</style></head><body>'
        + '<div class="bar">'
        +   '<span class="t">' + esc(data.title || '출력 시안') + '</span>'
        +   '<span class="spec">' + esc(meta.spec || '') + '</span>'
        +   '<span class="sp"></span>'
        +   '<button class="b on" id="tabBook">책 넘김</button>'
        +   (hasSheets ? '<button class="b" id="tabSheet">인쇄 대수</button>' : '')
        +   '<button class="b on" id="railBtn" title="왼쪽 페이지 목록 보이기/숨기기">📑 페이지 목록</button>'
        +   '<button class="b on" id="paperBtn" title="종이·책등 그늘·두께 등 책 느낌 효과 — 색을 정확히 볼 때는 끄세요">📕 책 느낌</button>'
        +   '<button class="b" id="fsBtn" title="전체화면으로 보기 (휴대폰은 가로로 눕히면 화면 가득)">⛶ 전체화면</button>'
        +   '<button class="b" id="realBtn" title="모니터에서 실제 인쇄 크기로 봅니다">실제 크기</button>'
        +   '<input type="range" id="calib" min="2.5" max="6" step="0.02"'
        +   ' style="display:none;width:110px" title="자로 잰 길이와 맞도록 조절하세요">'
        + '</div>'
        + '<div class="nav" id="prev">‹</div><div class="nav r" id="next">›</div>'
        + '<div class="rail" id="rail"></div>'
        + '<div class="stage" id="stage"></div>'
        + '<div class="foot">'
        +   '<span class="n" id="lbl"></span>'
        +   '<input type="range" id="rng" min="0" value="0">'
        +   '<span class="jlbl" id="jlbl">쪽 이동</span>'
        +   '<input type="number" class="jump" id="jump" min="1" placeholder="번호" title="쪽 번호를 넣고 Enter — 그 쪽이 있는 펼침면으로 바로 이동합니다">'
        +   '<button class="b" id="jumpBtn">이동</button>'
        +   '<span class="note">' + esc(meta.date || '') + (meta.by ? ' · ' + esc(meta.by) : '')
        +   ' · 화면 색상은 참고용이며 실제 인쇄색과 다를 수 있습니다</span>'
        + '</div>'
        + '<div class="zoomv" id="zoomv"></div>'
        + '<scr' + 'ipt>window.__PROOF__=' + json + ';</scr' + 'ipt>'
        + '<scr' + 'ipt>' + EBOOK_JS + '</scr' + 'ipt>'
        + '</body></html>';
    }
    // </EBOOK-CORE>

    // ── E-book 시안 생성 (앱 연결부) ───────────────────────────────────────────
    // 위 코어는 순수 함수, 여기부터는 앱 상태·DOM·pdf.js를 쓰는 연결부다.
    // 기본값 = 고화질·좌철·부가 표시 없음(워터마크·인쇄대수·재단선). 필요할 때만 켠다.
    let _ebOpts = { dpi: 200, wm: false, sheets: false, bind: 'left', trim: false, target: 'web' };

    function setEbDpi(v) {
      _ebOpts.dpi = v;
      document.querySelectorAll('[data-ebdpi]').forEach(b =>
        b.classList.toggle('active', +b.dataset.ebdpi === v));
      updateEbNote();
    }
    // 보는 기기 — web: PC 기준(목록 펼친 채 시작) / mobile: 휴대폰 기준(가로=두 쪽 가득, 세로=한 쪽씩)
    function setEbTarget(v) {
      _ebOpts.target = v;
      document.querySelectorAll('[data-ebtarget]').forEach(b =>
        b.classList.toggle('active', b.dataset.ebtarget === v));
    }
    function setEbBind(v) {
      _ebOpts.bind = v;
      document.querySelectorAll('[data-ebbind]').forEach(b =>
        b.classList.toggle('active', b.dataset.ebbind === v));
    }
    // 예상 용량 — 실측 계수(A4 기준 페이지당 대략 dpi²에 비례)로 어림한다. 과장 없이 보수적으로.
    function updateEbNote() {
      const el = document.getElementById('ebNote');
      if (!el) return;
      const n = (typeof pageResults !== 'undefined' ? pageResults : []).filter(Boolean).length;
      if (!n) { el.textContent = '문서를 열면 예상 용량이 표시됩니다.'; return; }
      const perPageKb = Math.round(120 * Math.pow(_ebOpts.dpi / 150, 2));
      const mb = (n * perPageKb) / 1024;
      el.textContent = `${n}쪽 · 예상 용량 약 ${mb < 1 ? Math.round(mb * 1024) + 'KB' : mb.toFixed(1) + 'MB'}`
        + (mb > 20 ? ' — 메일 첨부 한도를 넘을 수 있습니다(화질을 낮추세요)' : '');
    }

    // PDF 바이트 → 페이지별 JPEG data URI 배열
    async function ebookRenderPages(bytes, dpi, onProgress) {
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const out = [];
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      try {
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: dpi / 72 });
          canvas.width = Math.max(1, Math.round(vp.width));
          canvas.height = Math.max(1, Math.round(vp.height));
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          out.push({ u: canvas.toDataURL('image/jpeg', 0.82), w: canvas.width, h: canvas.height });
          page.cleanup();
          if (onProgress) onProgress(Math.round(i / pdf.numPages * 100));
          await uiYield(60);   // 수십 쪽에서도 화면이 멈추지 않게
        }
        // 첫 페이지 실제 치수(mm) — 시안의 '실제 크기' 보기와 사양 표기에 쓴다
        const p1 = await pdf.getPage(1);
        const v1 = p1.getViewport({ scale: 1 });
        const mm = [Math.round(v1.width * 25.4 / 72), Math.round(v1.height * 25.4 / 72)];
        p1.cleanup();
        return { pages: out, mm };
      } finally {
        try { await pdf.destroy(); } catch (e) {}
        canvas.width = canvas.height = 0;
      }
    }

    async function generateEbookProof() {
      if (!originalPdfBytes) { showError('먼저 PDF를 열어주세요.'); return; }
      const btn = document.getElementById('ebGenBtn');
      if (btn) btn.disabled = true;
      showLoading('📖 E-book 시안 만드는 중…');
      try {
        // 책 넘김용 = 임포징 직전 최종 결과(다운로드본과 동일 경로) — 고객이 받을 완성물 그대로
        updateProgress(5);
        let bookBytes = await buildOptimizedBase(p => updateProgress(Math.round(p * 0.25)));
        bookBytes = await applyBleedStage(bookBytes);
        updateProgress(28);

        const dpi = _ebOpts.dpi;
        const book = await ebookRenderPages(bookBytes, dpi, p => updateProgress(28 + Math.round(p * 0.42)));

        // 인쇄 대수(임포징 시트) — 임포징이 설정돼 있을 때만
        let sheets = { pages: [] };
        const wantSheets = _ebOpts.sheets && _impEnabled;
        if (wantSheets) {
          const sheetBytes = await buildImposedBytes(bookBytes, p => updateProgress(70 + Math.round(p * 0.08)));
          sheets = await ebookRenderPages(sheetBytes, Math.min(dpi, 120),
            p => updateProgress(78 + Math.round(p * 0.16)));
        }
        updateProgress(95);

        // 블리드가 있으면 재단선 위치(트림)를 비율로 넘긴다 — 시안에 '여기까지 잘림' 안내선
        const bleedMm = _bleedEnabled ? (+_bleedOpts().mm || 0) : 0;
        const trimPct = (_ebOpts.trim && bleedMm > 0 && book.mm[0]) ? (bleedMm / book.mm[0]) : 0;

        const rawName = (activeTabId && tabs.has(activeTabId) && tabs.get(activeTabId).fileName)
                        || originalFileName || '문서';
        const base = rawName.replace(/\.[^.]+$/, '');
        const specBits = [`${book.mm[0]}×${book.mm[1]}mm`, `${book.pages.length}쪽`];
        if (wantSheets) specBits.push(`인쇄 ${sheets.pages.length}시트`);
        if (bleedMm > 0) specBits.push(`블리드 ${bleedMm}mm`);

        const html = buildEbookProofHtml({
          title: base + ' 출력 시안',
          meta: {
            mm: book.mm, bind: _ebOpts.bind, spec: specBits.join(' · '), target: _ebOpts.target,
            date: new Date().toLocaleDateString('ko-KR'), by: '일청기획',
          },
          book: book.pages,
          sheets: sheets.pages,
          opts: { watermark: _ebOpts.wm, wmText: '시안', trimPct, coverSingle: true },
        });

        updateProgress(100);
        hideLoading();
        const buf = new TextEncoder().encode(html);
        const saved = await window.electronAPI.saveFile({
          defaultName: `${base}_시안.html`, buffer: buf, kind: 'html',
        });
        if (!saved) return;
        const mb = (buf.length / 1048576).toFixed(1);
        showSuccess(`📖 E-book 시안 생성 완료 — ${book.pages.length}쪽`
          + (wantSheets ? ` + 인쇄 대수 ${sheets.pages.length}시트` : '')
          + ` · ${mb}MB\n`
          + `파일 하나로 끝나므로 그대로 메일·카톡에 첨부하면 됩니다 — 고객은 더블클릭만 하면 브라우저에서 열립니다.\n`
          + `→ 넘기기: 페이지를 잡고 끌면(휴대폰은 손가락으로) 종이처럼 넘어갑니다 · 화면 좌우 클릭·←/→ 키도 가능\n→ 페이지를 누르면 확대 · [📑 페이지 목록]에서 바로 이동하거나 아래 '쪽 이동'에 번호를 넣고 Enter\n→ [실제 크기]로 인쇄 크기 확인 · 색을 정확히 볼 때는 [📕 책 느낌]을 끄세요`
          + (_ebOpts.target === 'mobile'
              ? `\n📱 모바일용으로 만들었습니다 — 폰을 눕히면 두 쪽이 화면 가득(잠시 두면 위아래 막대가 숨습니다), 세우면 한 쪽씩 크게 보입니다.`
              : `\n💻 일반 웹용입니다 — 폰에서 볼 고객이 많으면 '📱 모바일용'으로 다시 만들어 보내세요.`));
      } catch (e) {
        hideLoading();
        showError('시안 생성 실패: ' + (e && e.message ? e.message : e));
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    // ── 💼 작업 파일(.pdfw) — 상황 그대로 저장하고 그대로 다시 여는 컨테이너 ──
    // 아래 <WORKFILE-CORE> 구간은 **순수 함수만** 둔다(DOM·앱 전역 참조 금지) — 노드에서 단독 검증한다.
    //
    // 파일 배치
    //   'PDFEDITWORK1\n'  14바이트 매직
    //   u32LE             매니페스트(JSON, utf8) 길이
    //   JSON              { v, savedAt, doc, state, entries:[{ k, name, len }] }
    //   블롭들            entries 순서대로 이어붙임 (원본 PDF·내부편집 결과 등)
    // ZIP을 쓰지 않는 이유: PDF는 이미 압축돼 있어 이득이 없고, 의존성 없이 한 파일로 끝나는 편이
    // 깨졌을 때 진단하기도 쉽다(앞 14바이트만 보면 우리 파일인지 안다).
    // <WORKFILE-CORE>
    const WORK_MAGIC = 'PDFEDITWORK1\n';

    function packWorkFile(manifest, blobs) {
      const enc = new TextEncoder();
      const list = (blobs || []).map(b => (b instanceof Uint8Array ? b : new Uint8Array(b)));
      const man = Object.assign({}, manifest);
      man.entries = (man.entries || []).map((e, i) => Object.assign({}, e, { len: list[i] ? list[i].length : 0 }));
      if (man.entries.length !== list.length) throw new Error('entries와 blobs 개수가 다릅니다.');
      const magic = enc.encode(WORK_MAGIC);
      const json = enc.encode(JSON.stringify(man));
      let total = magic.length + 4 + json.length;
      list.forEach(b => { total += b.length; });
      const out = new Uint8Array(total);
      let p = 0;
      out.set(magic, p); p += magic.length;
      new DataView(out.buffer).setUint32(p, json.length, true); p += 4;
      out.set(json, p); p += json.length;
      list.forEach(b => { out.set(b, p); p += b.length; });
      return out;
    }

    function unpackWorkFile(bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const dec = new TextDecoder();
      const magic = WORK_MAGIC;
      if (u8.length < magic.length + 4 || dec.decode(u8.slice(0, magic.length)) !== magic) {
        throw new Error('이 앱의 작업 파일(.pdfw)이 아닙니다.');
      }
      let p = magic.length;
      const jsonLen = new DataView(u8.buffer, u8.byteOffset).getUint32(p, true); p += 4;
      if (jsonLen <= 0 || p + jsonLen > u8.length) throw new Error('작업 파일이 손상되었습니다(정보 영역).');
      let man;
      try { man = JSON.parse(dec.decode(u8.slice(p, p + jsonLen))); }
      catch (e) { throw new Error('작업 파일이 손상되었습니다(정보 해석 실패).'); }
      p += jsonLen;
      const blobs = [];
      for (const e of (man.entries || [])) {
        const len = +e.len || 0;
        if (p + len > u8.length) throw new Error('작업 파일이 손상되었습니다(내용이 잘렸습니다).');
        blobs.push(u8.slice(p, p + len));
        p += len;
      }
      return { manifest: man, blobs };
    }

    // 저장 시각·구성 요약 — 열기 전에 무엇이 들었는지 사람에게 보여주기 위한 한 줄
    function describeWorkFile(man) {
      if (!man) return '';
      const d = man.doc || {};
      const bits = [d.name || '문서'];
      if (d.pages) bits.push(d.pages + '쪽');
      const edits = (man.entries || []).filter(e => e.k === 'edit').length;
      if (edits) bits.push('내부편집 ' + edits + '쪽');
      if (man.savedAt) bits.push(new Date(man.savedAt).toLocaleString('ko-KR'));
      return bits.join(' · ');
    }
    // </WORKFILE-CORE>

    // ── 작업 파일 저장/열기 (앱 연결부) ────────────────────────────────────────
    // 저장 = 원본 PDF + 설정(편집·처리·임포징·블리드·표지) + 문서 상태(순서·회전·빈페이지·
    //        흑백확정·선택·개별보정) + 내부편집 결과 + 견적 항목을 한 파일에.
    // 열기 = 그 PDF를 평소 경로대로 분석한 뒤 위 상태를 그대로 되씌운다.
    function workFileBaseName() {
      const raw = (activeTabId && tabs.has(activeTabId) && tabs.get(activeTabId).fileName)
                  || originalFileName || '문서';
      return raw.replace(/\.[^.]+$/, '');
    }

    // 파일 쓰기와 분리 — 저장 다이얼로그 없이 바이트만 만들 수 있어야 검증이 가능하다.
    function buildWorkFileBytes() {
        const entries = [], blobs = [];
        entries.push({ k: 'pdf', name: workFileBaseName() + '.pdf' });
        blobs.push(new Uint8Array(originalPdfBytes));

        // 페이지 내부편집 결과(편집된 단일페이지 PDF)도 함께 — 이게 빠지면 열었을 때 편집이 사라진다
        const edits = [];
        if (typeof contentEdits !== 'undefined' && contentEdits && contentEdits.size) {
          contentEdits.forEach((v, oi) => {
            if (!v || !v.bytes) return;
            edits.push({ oi, model: v.model || [], rev: v.rev || 0 });
            entries.push({ k: 'edit', name: 'edit_' + oi });
            blobs.push(new Uint8Array(v.bytes));
          });
        }

        // 🔑 최종 적용 결과 PDF 자체를 담는다 — 다시 열 때 파이프라인을 다시 돌리지 않고
        // 저장된 그 결과를 그대로 화면에 띄우고 바로 다운로드할 수 있게 하기 위함.
        // (설정만 담고 열 때 재계산하면 큰 원고에서 수십 초를 다시 기다려야 했다)
        if (processedPdfBytes) {
          entries.push({ k: 'result', name: (processedFileName || workFileBaseName() + '.pdf') });
          blobs.push(new Uint8Array(processedPdfBytes));
        }
        // 블리드·아웃라인처럼 '그대로 저장해야 하는' 외부 변환 결과가 있으면 그것도 함께
        if (processedPdfBytes && typeof directOutputBytes !== 'undefined' && directOutputBytes) {
          entries.push({ k: 'direct', name: 'direct.pdf' });
          blobs.push(new Uint8Array(directOutputBytes));
        }

        const manifest = {
          v: 1,
          savedAt: Date.now(),
          doc: {
            name: workFileBaseName(),
            file: (activeTabId && tabs.has(activeTabId) && tabs.get(activeTabId).fileName) || '',
            pages: pageResults.filter(Boolean).length,
            size: originalPdfBytes.byteLength,
          },
          state: {
            // 설정은 프로파일·최근작업과 같은 스냅샷을 쓴다(한 곳만 고치면 셋 다 따라오게)
            data: JSON.parse(JSON.stringify(
              Object.assign(presetFromSettings(activeLayoutSettings()), captureExtraPreset()))),
            // editSettings 통째 — 챕터별 설정(byChapter)·적용범위(scope)·개별보정까지 그대로
            editSettings: editSettings ? JSON.parse(JSON.stringify(editSettings)) : null,
            docState: captureDocState(),
            quote: (typeof quoteItems !== 'undefined' && quoteItems) ? JSON.parse(JSON.stringify(quoteItems)) : [],
            edits,
            // 저장 시점에 '✔ 적용'까지 마친 상태였는지 + 그때의 저장 파일명.
            // 적용본 자체(entries의 k:'result')가 함께 들어 있어 열 때 그대로 보여준다.
            // (구버전 작업 파일은 적용본 없이 이 표식만 있다 → 그 경우에만 다시 적용해 복원)
            applied: !!processedPdfBytes,
            resultName: processedPdfBytes ? (processedFileName || '') : '',
          },
          entries,
        };

        return { bytes: packWorkFile(manifest, blobs), manifest, edits: edits.length };
    }

    async function saveWorkFile() {
      if (!originalPdfBytes) { showError('먼저 PDF를 열어주세요 — 저장할 작업이 없습니다.'); return; }
      try {
        const { bytes, manifest, edits } = buildWorkFileBytes();
        const saved = await window.electronAPI.saveFile({
          defaultName: workFileBaseName() + '.pdfw', buffer: bytes, kind: 'pdfw',
        });
        if (!saved) return;
        const others = [...tabs.values()].filter(t => t.id !== activeTabId && isTabReady(t)).length;
        showSuccess(`💼 작업 저장 완료 — ${manifest.doc.pages}쪽 · ${(bytes.length / 1048576).toFixed(1)}MB`
          + (edits ? ` · 내부편집 ${edits}쪽 포함` : '')
          + (manifest.state.applied ? ' · 적용본 포함' : '')
          + `\n이 파일을 더블클릭하면 지금 이 상태 그대로 다시 열립니다 (원본 PDF가 안에 들어 있어 다른 PC로 옮겨도 됩니다).`
          + (others ? `\n※ 다른 탭 ${others}개는 담기지 않습니다 — 탭마다 따로 저장하세요.` : ''));
      } catch (e) {
        showError('작업 저장 실패: ' + (e && e.message ? e.message : e));
      }
    }

    // 작업 파일로 여는 중 표시 — 분석 완료 후 뜨는 '지난 작업 기록' 안내를 억제한다
    let _openingWorkFile = false;
    // 작업 파일 열기 — 바이트를 받아 새 탭으로 분석한 뒤 상태를 되씌운다.
    async function openWorkFileBytes(bytes, srcLabel) {
      let un;
      try { un = unpackWorkFile(bytes); }
      catch (e) { showError((e && e.message) || '작업 파일을 읽을 수 없습니다.'); return false; }
      const { manifest, blobs } = un;
      const pdfAt = (manifest.entries || []).findIndex(e => e.k === 'pdf');
      if (pdfAt < 0 || !blobs[pdfAt]) { showError('작업 파일 안에 원본 PDF가 없습니다.'); return false; }

      hideError(); hideSuccess();
      showLoading('💼 작업 파일을 여는 중…');
      _openingWorkFile = true;
      try {
        const pdfBytes = blobs[pdfAt];
        const fake = {
          name: (manifest.doc && manifest.doc.file) || ((manifest.doc && manifest.doc.name) || '문서') + '.pdf',
          size: pdfBytes.length, type: 'application/pdf',
          arrayBuffer: () => Promise.resolve(pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.length)),
        };
        // 반드시 새 탭으로 — startLoad를 쓰면 열려 있는 문서에 '챕터'로 합쳐져 버린다
        const tab = createTab(fake);
        activateTab(tab.id);
        await analyzePDF(fake, tab);
        if (!isTabReady(tab)) { hideLoading(); showError('작업 파일의 PDF를 분석하지 못했습니다.'); return false; }

        const st = manifest.state || {};
        // 1) 설정(편집·처리·임포징·블리드·표지) — 프로파일 적용과 같은 경로
        if (st.data) applyPresetData(JSON.parse(JSON.stringify(st.data)));
        // 2) editSettings 통째 되씌우기 — 챕터별 설정·적용범위·개별보정까지 복원
        if (st.editSettings && editSettings) {
          Object.keys(editSettings).forEach(k => { delete editSettings[k]; });
          Object.assign(editSettings, JSON.parse(JSON.stringify(st.editSettings)));
          tab.editSettings = editSettings;
        }
        // 3) 내부편집 결과 복원 (썸네일·캐시는 아래 refresh에서 다시 만들어진다)
        let editN = 0;
        if (st.edits && st.edits.length) {
          const editBlobs = [];
          (manifest.entries || []).forEach((e, i) => { if (e.k === 'edit') editBlobs.push(blobs[i]); });
          st.edits.forEach((e, i) => {
            if (!editBlobs[i]) return;
            contentEdits.set(e.oi, { model: e.model || [], bytes: editBlobs[i], rev: e.rev || 0 });
            editN++;
          });
          tab.contentEdits = contentEdits;
        }
        // 4) 문서 상태(순서·회전·빈페이지·흑백확정·선택·개별보정)
        const full = st.docState ? restoreDocState(st.docState) : false;
        // 5) 견적 항목
        if (st.quote && typeof quoteItems !== 'undefined') {
          quoteItems.length = 0;
          st.quote.forEach(q => quoteItems.push(q));
        }
        if (typeof syncEditUI === 'function') syncEditUI();
        if (typeof clearProcessCaches === 'function') clearProcessCaches();
        if (typeof rerenderPages === 'function') rerenderPages();
        if (typeof syncSidebarPanel === 'function') syncSidebarPanel();
        // 아래에서 곧바로 전체 적용을 돌릴 상태면 실시간 미리보기는 예약하지 않는다(이중 조립 방지)
        if (!st.applied && typeof scheduleLivePreview === 'function') scheduleLivePreview();

        hideLoading();
        const restoreMsg = `💼 작업을 이어서 엽니다 — ${describeWorkFile(manifest)}`
          + `\n설정·페이지 순서·회전·선택${editN ? ' · 내부편집 ' + editN + '쪽' : ''}까지 저장 시점 그대로 복원했습니다.`
          + (full ? '' : '\n※ 페이지 상태 일부는 복원하지 못했습니다(문서가 바뀐 것으로 보입니다) — 설정만 적용했습니다.');
        // 저장 당시 '✔ 적용'까지 마친 작업이면 여기서 같은 파이프라인을 그대로 다시 돌린다.
        // 작업 파일의 존재 이유가 "그 시점 그대로"인데, 설정만 복원하고 멈추면 사용자가
        // 매번 '✔ 적용'을 다시 눌러야 해서 새로 여는 것과 다를 바가 없었다.
        const resAt = (manifest.entries || []).findIndex(e => e.k === 'result');
        const dirAt = (manifest.entries || []).findIndex(e => e.k === 'direct');
        if (resAt >= 0 && blobs[resAt]) {
          // 저장된 적용본을 그대로 — 재계산 없음. 화면·다운로드 모두 저장 시점 그대로다.
          processedPdfBytes = blobs[resAt];
          processedFileName = st.resultName || defaultProcessedName();
          directOutputBytes = (dirAt >= 0 && blobs[dirAt]) ? blobs[dirAt] : null;
          _processedSig = (typeof optSignature === 'function') ? optSignature() : null;
          setDirty(true);
          updateDownloadBtn();
          await renderProcessedPreview(processedPdfBytes, { live: false });
          showSuccess(restoreMsg
            + `\n✔ 마지막으로 적용한 결과 그대로 열었습니다 — 바로 '⇩ 다운로드'로 저장하면 됩니다.`);
          // 다운로드용 최적화본은 유휴 시간에 미리 구워 둔다(저장 버튼 대기 0초)
          setTimeout(() => { if (typeof prewarmOptimizedOutput === 'function') prewarmOptimizedOutput(); }, 800);
        } else if (st.applied) {
          // 구버전 작업 파일 — 적용본이 안 들어 있으므로 같은 설정으로 한 번 만들어 준다
          showSuccess(restoreMsg + '\n⏳ 저장 시점의 적용 결과를 다시 만드는 중… (구버전 작업 파일)');
          try { await applyChanges(); }
          catch (e) { console.warn('작업 파일 자동 적용 실패:', e); }
          showSuccess(restoreMsg
            + `\n✔ 저장 시점의 적용 결과까지 복원했습니다 — 바로 '⇩ 다운로드'로 저장하면 됩니다.`);
        } else {
          showSuccess(restoreMsg);
        }
        return true;
      } catch (e) {
        hideLoading();
        showError('작업 파일 열기 실패: ' + (e && e.message ? e.message : e));
        return false;
      } finally {
        // 분석 완료 알림(600ms 지연)이 지나간 뒤에 풀어야 복원 안내가 덮이지 않는다
        setTimeout(() => { _openingWorkFile = false; }, 1500);
      }
    }

    // 경로에서 열기 (더블클릭·드래그·최근 파일)
    async function openWorkFilePath(p) {
      try {
        const buf = window.electronAPI.readFile(p);
        return await openWorkFileBytes(new Uint8Array(buf), p);
      } catch (e) {
        showError('작업 파일을 읽을 수 없습니다: ' + (e && e.message ? e.message : e));
        return false;
      }
    }

    // 사이드바 [📂 작업 열기] — 파일 다이얼로그
    async function pickWorkFile() {
      const picked = await window.electronAPI.openFile({ kind: 'pdfw' });
      if (!picked || !picked.length) return;
      await openWorkFilePath(picked[0].path || picked[0]);
    }

    // ── 📐 가로 페이지 자동 세로 맞춤 ──────────────────────────────────────────
    // 세로 원고에 가로 원고가 섞여 있으면 임포징·인쇄에서 한 장만 눕게 된다.
    // 아크로뱃에서 일일이 돌려 저장할 필요 없이, 앱이 방향이 다른 페이지만 90° 돌려 맞춘다.
    // 회전은 기존 페이지별 회전(r.rotation)을 그대로 쓰므로 미리보기·적용·다운로드·임포징에
    // 자동으로 함께 반영되고, Ctrl+Z로 되돌릴 수 있다.
    const AUTO_ORIENT_KEY = 'autoOrientPages';
    function autoOrientCfg() {
      try {
        const c = JSON.parse(localStorage.getItem(AUTO_ORIENT_KEY) || '{}');
        return { on: c.on !== false, dir: c.dir === 'right' ? 'right' : 'left' };   // 기본: 켜짐 · 왼쪽 90°
      } catch (e) { return { on: true, dir: 'left' }; }
    }
    function saveAutoOrientCfg(c) {
      try { localStorage.setItem(AUTO_ORIENT_KEY, JSON.stringify(c)); } catch (e) {}
    }
    function setAutoOrient(on) {
      const c = autoOrientCfg(); c.on = !!on; saveAutoOrientCfg(c); syncAutoOrientUI();
    }
    function setAutoOrientDir(dir) {
      const c = autoOrientCfg(); c.dir = dir === 'right' ? 'right' : 'left'; saveAutoOrientCfg(c); syncAutoOrientUI();
    }
    function syncAutoOrientUI() {
      const c = autoOrientCfg();
      const chk = document.getElementById('esAutoOrient');
      if (chk && chk.checked !== c.on) chk.checked = c.on;
      document.querySelectorAll('[data-aodir]').forEach(b =>
        b.classList.toggle('active', b.dataset.aodir === c.dir));
      const info = document.getElementById('esAutoOrientInfo');
      if (!info) return;
      if (!pageResults.filter(Boolean).length) { info.textContent = '문서를 열면 방향이 다른 페이지를 알려줍니다.'; return; }
      const s = countMisorientedPages();
      info.textContent = !s.base ? '페이지 방향을 판단할 수 없습니다.'
        : s.n ? `대부분 ${s.base === 'portrait' ? '세로' : '가로'}인데 방향이 다른 페이지가 ${s.n}쪽 있습니다.`
              : `모든 페이지가 ${s.base === 'portrait' ? '세로' : '가로'}로 방향이 같습니다.`;
    }

    // 화면에 보이는 방향(원본 /Rotate + 앱에서 건 회전까지 반영)
    function pageDisplayOrient(r) {
      if (!r) return null;
      let w, h;
      if (r.isBlank) { const s = r.pageSize || [595.28, 841.89]; w = s[0]; h = s[1]; }
      else if (r.pageWpt) { w = r.pageWpt; h = r.pageHpt; }        // pdf.js 뷰포트 = /Rotate 반영 크기
      else if (r.thumbW) { w = r.thumbW; h = r.thumbH; }           // 폴백: 썸네일 픽셀
      else return null;
      const rot = ((((r.rotation || 0) % 360) + 360) % 360);
      if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
      if (w > h * 1.02) return 'landscape';
      if (h > w * 1.02) return 'portrait';
      return 'square';                                             // 정사각형에 가까우면 건드리지 않는다
    }
    // 문서의 다수 방향 — 이걸 기준으로 소수 페이지만 돌린다
    function docMajorOrient(list) {
      let p = 0, l = 0;
      (list || []).forEach(r => {
        const o = pageDisplayOrient(r);
        if (o === 'portrait') p++; else if (o === 'landscape') l++;
      });
      if (!p && !l) return null;
      return l > p ? 'landscape' : 'portrait';                     // 동수면 세로 기준
    }
    // 방향이 다른 페이지 수 (안내·버튼 활성화용)
    function countMisorientedPages() {
      const valid = pageResults.filter(Boolean);
      const base = docMajorOrient(valid);
      if (!base) return { base: null, n: 0, total: valid.length };
      let n = 0;
      valid.forEach(r => { const o = pageDisplayOrient(r); if (o && o !== 'square' && o !== base) n++; });
      return { base, n, total: valid.length };
    }

    // 실제 적용 — silent=true면 안내 문구를 띄우지 않는다(문서 열 때 자동 실행용은 따로 안내)
    function autoOrientPages(dir, silent) {
      const valid = pageResults.filter(Boolean);
      if (!valid.length) { if (!silent) showError('먼저 PDF를 열어주세요.'); return { n: 0 }; }
      const { base, n } = countMisorientedPages();
      if (!base || !n) {
        if (!silent) showSuccess('모든 페이지 방향이 이미 같습니다 — 돌릴 페이지가 없습니다.');
        return { n: 0, base };
      }
      const d = (dir || autoOrientCfg().dir) === 'right' ? 90 : 270;   // 왼쪽 90° = 270(시계 기준)
      if (typeof pushHistory === 'function') pushHistory();
      const targets = [];
      valid.forEach(r => {
        const o = pageDisplayOrient(r);
        if (!o || o === 'square' || o === base) return;
        r.rotation = ((((r.rotation || 0) + d) % 360) + 360) % 360;
        targets.push(r.pageNum);
      });
      if (typeof renderAllPages === 'function') renderAllPages(pageResults);
      if (typeof renderSidebar === 'function') renderSidebar(pageResults);
      if (typeof setPageEdited === 'function') setPageEdited();
      else { pageEdited = true; processedPdfBytes = null; }
      if (typeof updateDownloadBtn === 'function') updateDownloadBtn();
      if (typeof updateUndoBtn === 'function') updateUndoBtn();
      if (typeof syncAutoOrientUI === 'function') syncAutoOrientUI();
      const dirName = d === 270 ? '왼쪽' : '오른쪽';
      if (!silent) {
        showSuccess(`📐 ${targets.length}쪽을 ${dirName} 90° 회전해 ${base === 'portrait' ? '세로' : '가로'}로 맞췄습니다`
          + ` — ${targets.slice(0, 12).join(', ')}${targets.length > 12 ? ' …' : ''}쪽\n`
          + `이제 임포징·인쇄에서 다른 페이지와 같은 방향으로 나옵니다. (되돌리기 Ctrl+Z)`);
      }
      scheduleLivePreview();
      return { n: targets.length, base, pages: targets, dir: dirName };
    }

    // 문서 분석이 끝났을 때 자동 실행 (설정이 켜져 있고, 방향이 섞여 있을 때만)
    function maybeAutoOrientAfterAnalyze() {
      try {
        // 작업 파일(.pdfw)로 복원하는 중이면 저장된 회전을 존중한다 — 끼어들지 않는다
        if (typeof _openingWorkFile !== 'undefined' && _openingWorkFile) return;
        const cfg = autoOrientCfg();
        const info = countMisorientedPages();
        syncAutoOrientUI();
        if (!info.n) return;
        if (!cfg.on) {
          showSuccess(`📐 방향이 다른 페이지 ${info.n}쪽이 있습니다`
            + ` (${info.base === 'portrait' ? '대부분 세로인데 가로' : '대부분 가로인데 세로'} 페이지).\n`
            + `✏ 편집 → '📐 가로 페이지 자동 세로 맞춤'을 누르면 한 번에 맞춥니다.`);
          return;
        }
        const r = autoOrientPages(cfg.dir, true);
        if (r.n) {
          showSuccess(`📐 방향이 다른 ${r.n}쪽을 ${r.dir} 90° 회전해 자동으로 맞췄습니다`
            + ` (${r.pages.slice(0, 12).join(', ')}${r.pages.length > 12 ? ' …' : ''}쪽).\n`
            + `임포징·인쇄에서 다른 페이지와 같은 방향으로 나옵니다. 되돌리려면 Ctrl+Z,`
            + ` 이 자동 기능을 끄려면 ✏ 편집 → '📐 자동 세로 맞춤' 체크를 해제하세요.`);
        }
      } catch (e) { console.warn('자동 방향 맞춤 실패:', e); }
    }
