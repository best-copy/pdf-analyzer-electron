    // ── 실시간 미리보기 (편집 옵션 변경 시 디바운스 자동 갱신) ─────────────────
    let _livePvTimer = null, _liveRunning = false, _liveQueued = false;
    // 미리보기가 필요한 상태: 편집 레이아웃이 있거나, 흑백변환+선택이 있음
    function shouldPreview() {
      return !!originalPdfBytes && (hasAnyActiveLayout() || (processingOptions.bw && selectedPages.size > 0));
    }
    function previewVisible() {
      const s = document.getElementById('previewSection');
      return !!s && s.style.display !== 'none';
    }
    function scheduleLivePreview() {
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) return;
      if (!shouldPreview()) { if (document.body.classList.contains('edit-fullscreen')) showWorkspaceBasePreview(); else closePreview(); return; }
      // 자동 반영 꺼짐: 렌더하지 않고 '적용 필요' 상태로만 둔다(편집 조작 자체는 항상 즉시 반응).
      if (!liveAutoPreview) {
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
      _livePvTimer = setTimeout(runLivePreview, 120);
    }
    async function runLivePreview() {
      if (applying || _liveRunning) { _liveQueued = true; return; }
      if (!shouldPreview()) { if (document.body.classList.contains('edit-fullscreen')) showWorkspaceBasePreview(); else closePreview(); return; }
      _liveRunning = true;
      // 캐시가 히트하는 짧은 갱신에선 깜빡이지 않도록, 200ms 넘게 걸릴 때만 '처리중' 상태창 표시
      let loadingShown = false;
      const loadingTimer = setTimeout(() => { loadingShown = true; showLoading('편집 내용 반영 중...'); }, 200);
      try {
        const base = await buildBaseProcessed();
        let pdfBytes = base.bytes;
        const groups = computeLayoutGroups();
        if (groups.length) pdfBytes = await applyLayoutTransform(pdfBytes, groups, base.sig);
        processedPdfBytes = pdfBytes;
        processedFileName = defaultProcessedName();
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
      const srcDoc = await PDFLib.PDFDocument.load(originalPdfBytes.slice(0));
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
      return { bytes: await outDoc.save({ useObjectStreams: false, updateFieldAppearances: false }), stats };
    }
    // 다운로드용 최종 바이트 (용량 최적화 base + 레이아웃 변환)
    // 결과를 상태 시그니처로 캐시 — 적용 직후 백그라운드 프리웜(prewarmOptimizedOutput)이
    // 채워 두면 다운로드 버튼을 눌렀을 때 재생성 없이 즉시 저장된다.
    function optSignature() { return baseSignature() + '|' + JSON.stringify(editSettings); }
    // 같은 시그니처의 빌드가 이미 진행 중이면(예: 프리웜 도중 다운로드 클릭) 그 결과를
    // 공유한다. 늦게 합류한 쪽(다운로드)의 onProgress를 진행 중 빌드의 리스너에 등록해
    // 실제 진행률을 그대로 이어받는다 — '90%에서 멈춘 듯한' 구간이 사라진다.
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
        const base = await buildBaseOptimized(p => report(Math.round(p * 0.9)));
        let bytes = base.bytes;
        const groups = computeLayoutGroups();
        if (groups.length) {
          report(95);
          bytes = await applyLayoutTransform(bytes, groups);
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
      try { await buildOptimizedOutput(); }
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
        hideLoading();
      }
    }

    // ── 임포징 (제본용 조판): 중철(북클릿) / 정합(Cut & Stack) ─────────────────
    // 현재 편집·적용 상태(buildOptimizedOutput)를 소스로 제본용 시트 PDF를 생성한다.
    // 중철: 시트 k(바깥→안) 앞면 [N-2k | 2k+1], 뒷면 [2k+2 | N-2k-1] (좌철, 1-based)
    // 정합: 슬롯별 연속 구간(chunk) 배분 → 인쇄 후 재단해 묶음을 순서대로 겹치면 완성
    let _impMode = 'booklet';
    let _bkBind = 'left';
    let _cutN = 2;       // 정합 분할 수 (2 = 2-up, 4 = 2×2)
    let _cutSides = 2;   // 정합 인쇄면 (2 = 양면, 1 = 단면)

    function setImpMode(mode) {
      _impMode = mode;
      document.querySelectorAll('#impModeGroup .es-chip').forEach(b =>
        b.classList.toggle('active', b.dataset.imp === mode));
      const bk = mode === 'booklet', cs = mode === 'cutstack', rp = mode === 'repeat';
      const g = id => document.getElementById(id);
      if (g('impBookletRow')) g('impBookletRow').style.display = bk ? '' : 'none';
      if (g('impCutRow1'))    g('impCutRow1').style.display    = cs ? '' : 'none';
      if (g('impCutRow2'))    g('impCutRow2').style.display    = cs ? '' : 'none';
      if (g('impRepRow'))     g('impRepRow').style.display     = rp ? '' : 'none';
      if (g('bkCreepWrap'))   g('bkCreepWrap').style.display   = bk ? 'flex' : 'none';   // 밀림보정은 중철 전용
      if (g('impHint')) g('impHint').innerHTML = bk
        ? '현재 편집·적용 상태 그대로 <b>중철 제본용 2-up 시트</b>(앞/뒤 교대)로 재배열해 별도 PDF로 저장합니다. 페이지 수는 4의 배수가 되도록 빈 면이 채워집니다.<br>인쇄: <b>가로 용지 · 양면 · 짧은 쪽 넘김</b> → 반 접어 중철.'
        : cs
        ? '연속 구간을 칸별로 배분해 <b>인쇄 후 재단하면 묶음이 페이지 순서대로 겹쳐지는</b> 정합(Cut&amp;Stack) 시트를 생성합니다.<br>인쇄: 양면 시 <b>2분할=가로용지·짧은 쪽 넘김 / 4분할=세로용지·긴 쪽 넘김</b> → 재단 → 왼쪽(위) 묶음부터 차례로 겹치기.'
        : rp
        ? '명함·쿠폰·전단용 <b>같은 원고 반복 배치</b>. 각 페이지를 한 시트에 여러 벌 깔아 별도 PDF로 저장합니다.<br>배치를 비우면 <b>원고 실제 크기</b>로 최대 배치(용지 방향 자동 선택), 칸수를 지정하면 칸에 맞춰 확대/축소됩니다. 블리드·재단선과 함께 쓰세요.'
        : '한 시트에 같은 페이지 <b>2벌(오른쪽 벌 180° 회전)</b>을 양면으로 앉힙니다 — Quite Imposing의 <b>1 1* 2* 2</b> 방식.<br>인쇄: <b>가로 용지 · 양면 · 짧은 쪽 넘김</b> → 세로 재단 → 같은 문서 <b>2部</b> 완성.';
    }
    function setBookletBind(dir) {
      _bkBind = dir;
      document.querySelectorAll('#bkBindGroup .es-chip').forEach(b =>
        b.classList.toggle('active', b.dataset.bind === dir));
    }
    function setCutN(n) {
      _cutN = n;
      document.querySelectorAll('#cutNGroup .es-chip').forEach(b =>
        b.classList.toggle('active', +b.dataset.cutn === n));
    }
    function setCutSides(s) {
      _cutSides = s;
      document.querySelectorAll('#cutSidesGroup .es-chip').forEach(b =>
        b.classList.toggle('active', +b.dataset.sides === s));
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
      let html = '<option value="auto">자동 (원본 크기 기준)</option>';
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
    function addCustomPaper() {
      const name = (document.getElementById('cpName')?.value || '').trim();
      const w = parseFloat(document.getElementById('cpW')?.value);
      const h = parseFloat(document.getElementById('cpH')?.value);
      if (!name) { showError('용지 이름을 입력해 주세요.'); return; }
      if (!(w > 0) || !(h > 0)) { showError('용지 폭×높이(mm)를 입력해 주세요.'); return; }
      const list = loadCustomPapers().filter(p => p.name !== name);   // 같은 이름은 덮어쓰기
      list.push({ name, w, h });
      saveCustomPapers(list);
      populatePaperSelect('custom:' + name);
      document.getElementById('cpName').value = '';
      document.getElementById('cpW').value = ''; document.getElementById('cpH').value = '';
      showSuccess(`사용자 정의 용지 '${name}' (${w}×${h}mm)를 등록했습니다.`);
    }
    function deleteCustomPaper() {
      const sel = document.getElementById('bkPaper');
      if (!sel || !sel.value.startsWith('custom:')) { showError('삭제하려면 사용자 정의 용지를 먼저 선택하세요.'); return; }
      const name = sel.value.slice(7);
      saveCustomPapers(loadCustomPapers().filter(p => p.name !== name));
      populatePaperSelect('auto');
      showSuccess(`사용자 정의 용지 '${name}'를 삭제했습니다.`);
    }
    populatePaperSelect('auto');   // 초기 드롭다운 구성 (등록된 사용자 용지 복원)

    // 용지 선택값 → 시트 크기 [w,h](pt) 해석. orient: 'landscape'|'portrait' 강제.
    // 'auto'는 null 반환(빌더가 원본 크기로 계산).
    function resolveImpPaper(value, orient) {
      if (!value || value === 'auto') return null;
      let wpt, hpt;
      if (value.startsWith('custom:')) {
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
    async function embedAllPages(out, src, onProgress, extraRot) {
      const n0 = src.getPageCount();
      const embedded = [];
      for (let i = 0; i < n0; i++) {
        const pg = src.getPage(i);
        const { width: w, height: h } = pg.getSize();
        const rot = (((pg.getRotation().angle + (extraRot || 0)) % 360) + 360) % 360;
        let mtx, ew, eh;
        if (rot === 90)       { mtx = [0, -1, 1, 0, 0, w];  ew = h; eh = w; }
        else if (rot === 180) { mtx = [-1, 0, 0, -1, w, h]; ew = w; eh = h; }
        else if (rot === 270) { mtx = [0, 1, -1, 0, h, 0];  ew = h; eh = w; }
        else                  { mtx = undefined;            ew = w; eh = h; }
        embedded.push({ e: await out.embedPage(pg, undefined, mtx), w: ew, h: eh });
        if (onProgress && (i & 15) === 0) onProgress(Math.round(i / n0 * 40));
      }
      return embedded;
    }
    // 임포징 공용 용지 (가로 기준 [w, h])
    const IMP_PAPERS = { A4: [841.89, 595.28], A3: [1190.55, 841.89], B4: [1031.81, 728.50], B5: [728.50, 515.91] };

    // 임포징 공용: 재단선(트림 마크) — 트림 사각형 네 모서리 바깥에 짧은 선(갭 1mm, 길이 3mm)
    function drawCropMarks(page, x, y, w, h) {
      const MM = 72 / 25.4, gap = 1 * MM, len = 3 * MM;
      const black = PDFLib.rgb(0, 0, 0);
      const L = (x1, y1, x2, y2) =>
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.4, color: black });
      [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]]
        .forEach(([cx, cy, dx, dy]) => {
          L(cx + dx * gap, cy, cx + dx * (gap + len), cy);   // 모서리 바깥 가로선
          L(cx, cy + dy * gap, cx, cy + dy * (gap + len));   // 모서리 바깥 세로선
        });
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
      const gutterPt = (opts.gutter || 0) * MM;
      const creepPt  = (opts.creep  || 0) * MM;
      const mPt      = (opts.margin || 0) * MM;   // 시트 가장자리 여백
      const bPt      = (opts.bleed  || 0) * MM;   // 재단 여유(블리드, 면당)
      const slotW = (sw - 2 * mPt - gutterPt) / 2, slotH = sh - 2 * mPt;
      if (slotW <= 0 || slotH <= 0) throw new Error('여백·거터가 시트보다 큽니다.');

      // 한 칸 그리기 — shift: 책등(중앙) 쪽으로 콘텐츠 이동량(밀림 보정)
      // 반환: 트림(재단) 사각형 {x,y,w,h} (재단선용) 또는 null(빈 면)
      const drawSlot = (page, logical, side, shift) => {
        if (logical > n0) return null;   // 4의 배수 채움용 빈 면
        const { e, w, h } = embedded[logical - 1];
        const s = Math.min(slotW / w, slotH / h);
        const dw = w * s, dh = h * s;   // 트림 크기
        const x0 = side === 'L' ? mPt : mPt + slotW + gutterPt;
        const x = x0 + (slotW - dw) / 2 + (side === 'L' ? shift : -shift);
        const y = mPt + (slotH - dh) / 2;
        if (bPt > 0) {
          // 블리드: 트림보다 크게(면당 bPt) 확대해 중앙 정렬 — 재단 밀림 대비
          const k = Math.max((dw + 2 * bPt) / dw, (dh + 2 * bPt) / dh);
          const s2 = s * k;
          page.drawPage(e, { x: x + dw / 2 - w * s2 / 2, y: y + dh / 2 - h * s2 / 2, xScale: s2, yScale: s2 });
        } else {
          page.drawPage(e, { x, y, xScale: s, yScale: s });
        }
        return { x, y, w: dw, h: dh };
      };

      const order = bookletSheetOrder(n, opts.binding);
      order.forEach(({ front, back }, i) => {
        const shift = creepPt * i;   // 바깥 시트 0 → 안쪽으로 갈수록 책등 쪽 이동
        const fp = out.addPage([sw, sh]);
        const ft = [drawSlot(fp, front[0], 'L', shift), drawSlot(fp, front[1], 'R', shift)];
        const bp = out.addPage([sw, sh]);
        const bt = [drawSlot(bp, back[0], 'L', shift), drawSlot(bp, back[1], 'R', shift)];
        if (opts.crop) {   // 재단선은 페이지 위에 그린다
          ft.forEach(t => { if (t) drawCropMarks(fp, t.x, t.y, t.w, t.h); });
          bt.forEach(t => { if (t) drawCropMarks(bp, t.x, t.y, t.w, t.h); });
        }
        if (onProgress) onProgress(40 + Math.round((i + 1) / order.length * 55));
      });
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
      const MM = 72 / 25.4;
      const gutterPt = (opts.gutter || 0) * MM;
      const mPt      = (opts.margin || 0) * MM;
      const bPt      = (opts.bleed  || 0) * MM;
      const rows = nup / 2;
      const slotW = (sw - 2 * mPt - gutterPt) / 2;
      const slotH = (sh - 2 * mPt - (rows - 1) * gutterPt) / rows;
      if (slotW <= 0 || slotH <= 0) throw new Error('여백·거터가 시트보다 큽니다.');

      // 슬롯 s(0=좌상 → 좌→우, 상→하)에 논리 페이지 배치. 반환: 트림 사각형 또는 null
      const drawCell = (page, logical, s) => {
        if (logical > n0) return null;   // 패딩 빈 면
        const { e, w, h } = embedded[logical - 1];
        const sc = Math.min(slotW / w, slotH / h);
        const dw = w * sc, dh = h * sc;   // 트림 크기
        const col = s % 2, row = (s / 2) | 0;
        const x0 = mPt + col * (slotW + gutterPt);
        const y0 = sh - mPt - (row + 1) * slotH - row * gutterPt;
        const x = x0 + (slotW - dw) / 2, y = y0 + (slotH - dh) / 2;
        if (bPt > 0) {
          const k = Math.max((dw + 2 * bPt) / dw, (dh + 2 * bPt) / dh);
          const s2 = sc * k;
          page.drawPage(e, { x: x + dw / 2 - w * s2 / 2, y: y + dh / 2 - h * s2 / 2, xScale: s2, yScale: s2 });
        } else {
          page.drawPage(e, { x, y, xScale: sc, yScale: sc });
        }
        return { x, y, w: dw, h: dh };
      };

      const { sheets, n, chunk } = cutStackOrder(n0, nup, sides);
      sheets.forEach(({ front, back }, i) => {
        const fp = out.addPage([sw, sh]);
        const ft = front.map((pg, s) => drawCell(fp, pg, s));
        if (opts.crop) ft.forEach(t => { if (t) drawCropMarks(fp, t.x, t.y, t.w, t.h); });
        if (back) {
          const bp = out.addPage([sw, sh]);
          const bt = back.map((pg, s) => drawCell(bp, pg, s));
          if (opts.crop) bt.forEach(t => { if (t) drawCropMarks(bp, t.x, t.y, t.w, t.h); });
        }
        if (onProgress) onProgress(40 + Math.round((i + 1) / sheets.length * 55));
      });
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
      const gutterPt = (opts.gutter || 0) * MM;
      const mPt      = (opts.margin || 0) * MM;
      const bPt      = (opts.bleed  || 0) * MM;
      const baseSheet = opts.sheet || IMP_PAPERS.A4;
      const cands = [[baseSheet[0], baseSheet[1]], [baseSheet[1], baseSheet[0]]];   // 가로/세로 두 방향 시도
      const wantC = opts.cols | 0, wantR = opts.rows | 0;

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
        const { sw, sh, cols, rows, cellW, cellH, s } = best;
        const dw = w * s, dh = h * s;
        // 배치 블록 전체를 시트 중앙 정렬 (여백 안쪽 보장: blockW ≤ W)
        const blockW = cols * cellW + (cols - 1) * gutterPt;
        const blockH = rows * cellH + (rows - 1) * gutterPt;
        const ox = (sw - blockW) / 2, oy = (sh - blockH) / 2;
        const page = out.addPage([sw, sh]);
        const trims = [];
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const x = ox + c * (cellW + gutterPt) + (cellW - dw) / 2;
          const y = oy + (rows - 1 - r) * (cellH + gutterPt) + (cellH - dh) / 2;
          if (bPt > 0) {
            const k = Math.max((dw + 2 * bPt) / dw, (dh + 2 * bPt) / dh);
            const s2 = s * k;
            page.drawPage(e, { x: x + dw / 2 - w * s2 / 2, y: y + dh / 2 - h * s2 / 2, xScale: s2, yScale: s2 });
          } else {
            page.drawPage(e, { x, y, xScale: s, yScale: s });
          }
          trims.push({ x, y, w: dw, h: dh });
        }
        if (opts.crop) trims.forEach(t => drawCropMarks(page, t.x, t.y, t.w, t.h));
        total += cols * rows;
        if (!firstGrid) firstGrid = { cols, rows };
        if (onProgress) onProgress(40 + Math.round((pi + 1) / n0 * 55));
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
        const srcBytes = await buildOptimizedOutput(p => updateProgress(Math.round(p * 0.45)));
        showLoading('반복 배치 — Step&Repeat 시트 조립 중…');
        const paperVal = document.getElementById('bkPaper')?.value || 'auto';
        const opts = {
          sheet:  resolveImpPaper(paperVal, null),   // 방향은 빌더가 최적 선택 (auto=A4)
          gutter: parseFloat(document.getElementById('bkGutter')?.value) || 0,
          margin: parseFloat(document.getElementById('impMargin')?.value) || 0,
          bleed:  parseFloat(document.getElementById('impBleed')?.value) || 0,
          crop:   !!document.getElementById('impCrop')?.checked,
          cols:   parseInt(document.getElementById('repCols')?.value) || 0,
          rows:   parseInt(document.getElementById('repRows')?.value) || 0,
        };
        const res = await buildStepRepeatBytes(srcBytes, opts, p => updateProgress(45 + Math.round(p * 0.55)));
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        try { renderProcessedPreview(res.bytes); } catch (e) { console.warn('임포징 미리보기 실패:', e); }
        const base = (originalFileName || '문서').replace(/\.pdf$/i, '');
        const g = res.grid || { cols: 0, rows: 0 };
        const saved = await window.electronAPI.saveFile({
          defaultName: `${base}_반복${g.cols}x${g.rows}.pdf`, buffer: res.bytes });
        if (saved) {
          let msg = `📖 반복 배치(Step&Repeat) PDF 저장 완료 — 시트 ${res.sheets}장 · 시트당 ${g.cols}×${g.rows}=${g.cols * g.rows}벌 (총 ${res.total}벌)`
            + `\n결과가 화면에 표시 중입니다 — '✕ 원본 페이지 보기'로 복귀`;
          if (opts.bleed > 0 && opts.gutter < opts.bleed * 2)
            msg += `\n⚠ 블리드(${opts.bleed}mm)가 거터(${opts.gutter}mm)의 절반보다 큽니다 — 이웃과 겹칠 수 있으니 거터를 ${opts.bleed * 2}mm 이상으로 권장`;
          showSuccess(msg);
        }
      } catch (e) {
        console.error('반복 배치 생성 오류:', e);
        showError('반복 배치 생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; hideLoading(); progressBar.style.display = 'none';
      }
    }

    // ── 복제 2-up (양면 2부, Quite Imposing 'Shuffle 1 1* 2* 2' + 2up 방식) ────
    // 각 페이지를 한 시트에 2벌(오른쪽 벌은 180° 회전) 배치하고 양면으로 이어서,
    // 인쇄 후 세로로 재단하면 같은 문서가 2部 나온다(한 部는 180° — 돌리면 정방향).
    // 시트 s: 앞면 [p(2s+1) | p(2s+1)@180], 뒷면 [p(2s+2)@180 | p(2s+2)]
    function dup2upOrder(n0) {
      const n = Math.ceil(n0 / 2) * 2;
      const sheets = [];
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
      const MM = 72 / 25.4;
      const gutterPt = (opts.gutter || 0) * MM;
      const mPt      = (opts.margin || 0) * MM;
      const bPt      = (opts.bleed  || 0) * MM;
      const slotW = (sw - 2 * mPt - gutterPt) / 2, slotH = sh - 2 * mPt;
      if (slotW <= 0 || slotH <= 0) throw new Error('여백·거터가 시트보다 큽니다.');

      const drawCell = (page, cell, side) => {
        if (cell.p > n0) return null;   // 홀수 패딩 빈 면
        const { e, w, h } = (cell.r === 180 ? emb180 : emb0)[cell.p - 1];
        const s = Math.min(slotW / w, slotH / h);
        const dw = w * s, dh = h * s;
        const x0 = side === 'L' ? mPt : mPt + slotW + gutterPt;
        const x = x0 + (slotW - dw) / 2, y = mPt + (slotH - dh) / 2;
        if (bPt > 0) {
          const k = Math.max((dw + 2 * bPt) / dw, (dh + 2 * bPt) / dh);
          const s2 = s * k;
          page.drawPage(e, { x: x + dw / 2 - w * s2 / 2, y: y + dh / 2 - h * s2 / 2, xScale: s2, yScale: s2 });
        } else {
          page.drawPage(e, { x, y, xScale: s, yScale: s });
        }
        return { x, y, w: dw, h: dh };
      };

      const { sheets, n } = dup2upOrder(n0);
      sheets.forEach(({ front, back }, i) => {
        const fp = out.addPage([sw, sh]);
        const ft = [drawCell(fp, front[0], 'L'), drawCell(fp, front[1], 'R')];
        if (opts.crop) ft.forEach(t => { if (t) drawCropMarks(fp, t.x, t.y, t.w, t.h); });
        const bp = out.addPage([sw, sh]);
        const bt = [drawCell(bp, back[0], 'L'), drawCell(bp, back[1], 'R')];
        if (opts.crop) bt.forEach(t => { if (t) drawCropMarks(bp, t.x, t.y, t.w, t.h); });
        if (onProgress) onProgress(45 + Math.round((i + 1) / sheets.length * 50));
      });
      if (onProgress) onProgress(98);
      const bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
      return { bytes, n0, n, sheets: sheets.length };
    }

    async function generateDup2up() {
      if (_bkBusy) return;
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      _bkBusy = true;
      try {
        showLoading('복제 2-up — 최신 편집 상태 준비 중…');
        progressBar.style.display = 'block'; updateProgress(0);
        const srcBytes = await buildOptimizedOutput(p => updateProgress(Math.round(p * 0.45)));
        showLoading('복제 2-up — 양면 2부 시트 조립 중…');
        const paperVal = document.getElementById('bkPaper')?.value || 'auto';
        const opts = {
          paper:  paperVal,
          sheet:  resolveImpPaper(paperVal, 'landscape'),
          gutter: parseFloat(document.getElementById('bkGutter')?.value) || 0,
          margin: parseFloat(document.getElementById('impMargin')?.value) || 0,
          bleed:  parseFloat(document.getElementById('impBleed')?.value) || 0,
          crop:   !!document.getElementById('impCrop')?.checked,
        };
        const res = await buildDup2upBytes(srcBytes, opts, p => updateProgress(45 + Math.round(p * 0.55)));
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        // 결과를 화면에 바로 표시 (저장 다이얼로그 뒤에서 확인 가능)
        try { renderProcessedPreview(res.bytes); } catch (e) { console.warn('임포징 미리보기 실패:', e); }
        const base = (originalFileName || '문서').replace(/\.pdf$/i, '');
        const saved = await window.electronAPI.saveFile({ defaultName: `${base}_복제2부.pdf`, buffer: res.bytes });
        if (saved) {
          let msg = `📖 복제 2-up(양면 2부) PDF 저장 완료 — 시트 ${res.sheets}장 (양면 ${res.n}면, 본문 ${res.n0}쪽${res.n - res.n0 ? ` + 빈 면 ${res.n - res.n0}쪽` : ''})`
            + `\n인쇄: 가로 용지 · 양면 · '짧은 쪽 넘김' → 세로 재단 → 2部 완성 (오른쪽 部는 180° — 돌리면 정방향)`
            + `\n결과가 화면에 표시 중입니다 — '✕ 원본 페이지 보기'로 복귀`;
          if (opts.bleed > 0 && opts.gutter < opts.bleed * 2)
            msg += `\n⚠ 블리드(${opts.bleed}mm)가 거터(${opts.gutter}mm)의 절반보다 큽니다 — 거터를 ${opts.bleed * 2}mm 이상 권장`;
          showSuccess(msg);
        }
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
        const srcBytes = await buildOptimizedOutput(p => updateProgress(Math.round(p * 0.45)));
        showLoading('북클릿 임포징 — 중철 시트 조립 중…');
        const paperVal = document.getElementById('bkPaper')?.value || 'auto';
        const opts = {
          paper:   paperVal,
          sheet:   resolveImpPaper(paperVal, 'landscape'),   // 사용자 정의 용지 포함 해석 (중철=가로)
          gutter:  parseFloat(document.getElementById('bkGutter')?.value) || 0,
          creep:   parseFloat(document.getElementById('bkCreep')?.value) || 0,
          margin:  parseFloat(document.getElementById('impMargin')?.value) || 0,
          bleed:   parseFloat(document.getElementById('impBleed')?.value) || 0,
          crop:    !!document.getElementById('impCrop')?.checked,
          binding: _bkBind,
        };
        const res = await buildBookletBytes(srcBytes, opts, p => updateProgress(45 + Math.round(p * 0.55)));
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        try { renderProcessedPreview(res.bytes); } catch (e) { console.warn('임포징 미리보기 실패:', e); }
        const base = (originalFileName || '문서').replace(/\.pdf$/i, '');
        const saved = await window.electronAPI.saveFile({ defaultName: `${base}_중철북클릿.pdf`, buffer: res.bytes });
        if (saved) {
          let msg = `📖 북클릿 PDF 저장 완료 — 시트 ${res.sheets}장 (양면 ${res.n / 2}면, 본문 ${res.n0}쪽 + 빈 면 ${res.n - res.n0}쪽)`
            + `\n인쇄 설정: 가로 용지 · 양면 인쇄 · '짧은 쪽 넘김'(short-edge) → 반 접어 중철 제본`
            + `\n결과가 화면에 표시 중입니다 — '✕ 원본 페이지 보기'로 복귀`;
          if (opts.bleed > 0 && opts.gutter < opts.bleed * 2)
            msg += `\n⚠ 블리드(${opts.bleed}mm)가 거터(${opts.gutter}mm)의 절반보다 큽니다 — 이웃 페이지와 겹칠 수 있으니 거터를 ${opts.bleed * 2}mm 이상으로 권장`;
          showSuccess(msg);
        }
      } catch (e) {
        console.error('북클릿 생성 오류:', e);
        showError('북클릿 생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; hideLoading(); progressBar.style.display = 'none';
      }
    }

    async function generateCutStack() {
      if (_bkBusy) return;
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      _bkBusy = true;
      try {
        showLoading('정합 임포징 — 최신 편집 상태 준비 중…');
        progressBar.style.display = 'block'; updateProgress(0);
        const srcBytes = await buildOptimizedOutput(p => updateProgress(Math.round(p * 0.45)));
        showLoading('정합 임포징 — Cut&Stack 시트 조립 중…');
        const paperVal = document.getElementById('bkPaper')?.value || 'auto';
        const opts = {
          paper:  paperVal,
          sheet:  resolveImpPaper(paperVal, _cutN === 4 ? 'portrait' : 'landscape'),   // 4분할=세로
          gutter: parseFloat(document.getElementById('bkGutter')?.value) || 0,
          margin: parseFloat(document.getElementById('impMargin')?.value) || 0,
          bleed:  parseFloat(document.getElementById('impBleed')?.value) || 0,
          crop:   !!document.getElementById('impCrop')?.checked,
          nup:    _cutN,
          sides:  _cutSides,
        };
        const res = await buildCutStackBytes(srcBytes, opts, p => updateProgress(45 + Math.round(p * 0.55)));
        updateProgress(100); hideLoading(); progressBar.style.display = 'none';
        try { renderProcessedPreview(res.bytes); } catch (e) { console.warn('임포징 미리보기 실패:', e); }
        const base = (originalFileName || '문서').replace(/\.pdf$/i, '');
        const saved = await window.electronAPI.saveFile({
          defaultName: `${base}_정합${res.nup}업${res.sides === 2 ? '양면' : '단면'}.pdf`, buffer: res.bytes });
        if (saved) {
          const printHint = res.sides === 2
            ? (res.nup === 2 ? "양면 인쇄 · 가로 용지 · '짧은 쪽 넘김'" : "양면 인쇄 · 세로 용지 · '긴 쪽 넘김'")
            : '단면 인쇄';
          const stackHint = res.nup === 2 ? '왼쪽 묶음을 오른쪽 묶음 위에' : '좌상→우상→좌하→우하 순서로 위에서부터';
          let msg = `📖 정합(Cut&Stack) PDF 저장 완료 — 시트 ${res.sheets}장 · ${res.nup}분할 · 묶음당 ${res.chunk}쪽 (본문 ${res.n0}쪽 + 빈 면 ${res.n - res.n0}쪽)`
            + `\n인쇄: ${printHint} → 재단 → ${stackHint} 겹치면 페이지 순서 완성`
            + `\n결과가 화면에 표시 중입니다 — '✕ 원본 페이지 보기'로 복귀`;
          if (opts.bleed > 0 && opts.gutter < opts.bleed * 2)
            msg += `\n⚠ 블리드(${opts.bleed}mm)가 거터(${opts.gutter}mm)의 절반보다 큽니다 — 이웃 페이지와 겹칠 수 있으니 거터를 ${opts.bleed * 2}mm 이상으로 권장`;
          showSuccess(msg);
        }
      } catch (e) {
        console.error('정합 생성 오류:', e);
        showError('정합 생성 실패: ' + (e && e.message ? e.message : String(e)));
      } finally {
        _bkBusy = false; hideLoading(); progressBar.style.display = 'none';
      }
    }

    // 임포징 실행 — 모드에 따라 중철/정합/반복/복제 분기
    function generateImposition() {
      if (_impMode === 'cutstack') return generateCutStack();
      if (_impMode === 'repeat')   return generateStepRepeat();
      if (_impMode === 'dup')      return generateDup2up();
      return generateBooklet();
    }

    async function downloadProcessed() {
      if (!processedPdfBytes) { showError('먼저 \'✔ 적용\'을 눌러 수정사항을 적용하거나, 다운로드 버튼을 우클릭해 원본을 저장하세요.'); return; }
      try {
        applying = true; updateDownloadBtn();
        showLoading('다운로드용 PDF 최적화 중…');
        progressBar.style.display = 'block'; updateProgress(0);
        // 최종 파일은 용량 최적화 방식으로 새로 생성 (미리보기와 내용 동일)
        const finalBytes = await buildOptimizedOutput(p => updateProgress(p));
        applying = false; updateDownloadBtn();
        hideLoading(); progressBar.style.display = 'none';
        const saved = await window.electronAPI.saveFile({
          defaultName: processedFileName,
          buffer: finalBytes,
        });
        if (saved) { setDirty(false); showSuccess('PDF를 다운로드했습니다. (용량 최적화 적용)'); }
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
      pageResults.forEach((r, i) => { if (r) r.pageNum = i + 1; });
      selectedPages.clear();
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
      if (typeof previewVisible === 'function' && previewVisible()) scheduleLivePreview();
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

