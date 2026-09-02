    // ── PDF.js 워커 설정 (asar 패키지 내부에서도 동작하는 blob URL 방식) ──────
    // Web Worker는 asar 경로를 직접 로드할 수 없으므로
    // preload의 fs.readFileSync로 읽어 Blob URL로 변환해 사용
    try {
      const workerContent = window.electronAPI.getWorkerContent();
      const blob = new Blob([workerContent], { type: 'application/javascript' });
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    } catch(e) {
      console.error('PDF.js 워커 로드 실패:', e);
    }

    // ── 공유 DOM ─────────────────────────────────────────────────────────────
    const fileInfo         = document.getElementById('fileInfo');
    const progressBar      = document.getElementById('progressBar');
    const progressFill     = document.getElementById('progressFill');
    const loading          = document.getElementById('loading');
    const loadingMsg       = document.getElementById('loadingMsg');
    const errorEl          = document.getElementById('error');
    const successEl        = document.getElementById('success');
    const tabBar           = document.getElementById('tabBar');
    const mainTabBar       = document.getElementById('mainTabBar');
    const tabBars          = [tabBar, mainTabBar];
    const resultsSection   = document.getElementById('resultsSection');
    const pagesGrid        = document.getElementById('pagesGrid');
    const rangeSummary     = document.getElementById('rangeSummary');
    const selectedCountEl  = document.getElementById('selectedCount');
    const totalPagesEl     = document.getElementById('totalPages');
    const colorPagesEl     = document.getElementById('colorPages');
    const grayscalePagesEl = document.getElementById('grayscalePages');
    const colorPercentEl   = document.getElementById('colorPercentage');

    // ── 현재 탭의 상태를 가리키는 전역 앨리어스 ─────────────────────────────
    let originalPdfBytes   = null;
    let originalFileName   = '';
    let globalPdfDoc       = null;
    let pageResults        = [];
    let selectedPages      = new Set();
    let originalThumbnails = new Map();
    let quoteItems         = [];
    let pageEdited         = false;
    let liveAutoPreview    = localStorage.getItem('liveAutoPreview') === '1'; // 편집 중 자동 반영 (기본 OFF)
    let undoStack          = []; // 실행취소 히스토리 (페이지 상태 스냅샷)
    let redoStack          = []; // 다시실행 히스토리
    const HISTORY_LIMIT    = 1000; // 보관 스냅샷 최대 개수 (사실상 무제한)
    let processedPdfBytes  = null; // '적용'으로 생성된 결과 PDF (다운로드 대기)
    let processedFileName  = '';
    // processedPdfBytes를 만든 시점의 파이프라인 시그니처(optSignature). 편집 모드의
    // 실시간 미리보기도 '적용'과 완전히 같은 파이프라인으로 결과 바이트를 만들므로,
    // 이 값이 지금 설정과 같으면 '저장하고 닫기'가 전체 재조립을 건너뛰고 그 결과를 쓴다.
    let _processedSig      = null;
    // 아웃라인·블리드 등 외부 변환 결과를 '그대로' 저장해야 하는 경우의 바이트.
    // 세팅되어 있으면 다운로드가 파이프라인 재조립(buildOptimizedOutput)을 건너뛴다 —
    // 재조립하면 gs 아웃라인 등 파이프라인 밖 변환이 사라지는 화면·파일 불일치가 생김.
    let directOutputBytes  = null;
    let applying           = false; // 적용(수정) 진행 중 여부
    // inkNorm(잉크 정규화): 분석기가 '흑백'으로 판정한 페이지도 DeviceGray 색공간으로 강제
    // 변환한다. 화면은 흑백처럼 보여도 내부가 RGB/CMYK 회색(리치블랙)이면 프린터 과금기가
    // 컬러로 카운트하는 문제의 해결책 — 시각적 변화 없이 색공간만 그레이로 통일.
    const processingOptions = { bw: false, inkNorm: true };   // 잉크 정규화는 기본 켬
    let editSettings       = null; // 현재 탭의 편집 설정(크기·회전·조판·테두리) 앨리어스
    let contentEdits       = new Map(); // 현재 탭의 페이지 내부편집: originalIdx → { model, bytes, rev }

    // 저장 안 한 작업 여부를 main에 보고 (종료 전 확인용)
    let _isDirty = false;
    // setDirty(true, { auto: true }) = 사용자가 바꾼 것이 아니라 화면이 스스로 다시 그린 것
    // (작업 파일 복원, 실시간 미리보기 재조립). 이미 작업 파일로 저장해 둔 상태라면 이런 자동 갱신은
    // '저장 안 한 작업'으로 세지 않는다 — 작업 파일을 열자마자 닫을 때 저장 확인이 뜨던 원인.
    // 사용자의 편집(회전·삭제·적용·옵션 변경 등)은 auto 없이 부르므로 언제나 그대로 기록된다.
    function setDirty(v, opts) {
      v = !!v;
      const t = (activeTabId && tabs.get(activeTabId)) || null;
      if (v && opts && opts.auto && t && t.workSaved) return;   // 저장해 둔 상태의 자동 갱신 — 무시
      // 무엇이든 바뀌면 '작업 파일로 저장해 둔 상태'가 아니게 된다 — 다시 저장을 물어야 한다
      if (v && t) t.workSaved = false;
      if (v !== _isDirty) {
        _isDirty = v;
        try { window.electronAPI.setUnsaved && window.electronAPI.setUnsaved(v); } catch (e) {}
      }
      reportDocState();
    }
    // 지금 상태를 작업 파일(.pdfw)로 저장해 두었음을 표시 — 닫을 때 다시 묻지 않는다.
    // (작업 파일을 열었을 때도 같다 — 그 파일이 곧 지금 상태다)
    function markWorkSaved() {
      const t = (activeTabId && tabs.get(activeTabId)) || null;
      if (t) t.workSaved = true;
      setDirty(false);
      reportDocState();
    }

    // 닫을 때 저장을 물어야 하는지 + 지금 작업 파일(.pdfw) 이름을 main에 보고.
    // 물어야 하는 경우 = 분석이 끝난 문서가 있는데 그 상태를 아직 작업 파일로 저장하지 않았을 때.
    // 편집을 하나도 안 했어도(불러오기만 했어도) 묻는다 — 그냥 꺼지면 분석 결과와 설정이 사라지므로.
    // 반대로 '💼 작업 저장'을 눌러 저장해 둔 뒤라면 묻지 않는다(저장했는데 또 묻는 것은 잘못).
    let _docStateSig = '';
    function reportDocState() {
      let open = false, name = '';
      try {
        open = [...tabs.values()].some(t => isTabReady(t) && !t.workSaved);
        const t = (activeTabId && tabs.get(activeTabId)) || null;
        if (t && t.workPath) name = String(t.workPath).split(/[\\/]/).pop();
      } catch (e) {}
      const sig = (open ? '1' : '0') + '|' + name;
      if (sig === _docStateSig) return;
      _docStateSig = sig;
      try { window.electronAPI.setDocOpen && window.electronAPI.setDocOpen(open, name); } catch (e) {}
    }

    // 편집 설정 기본값 팩토리 — 탭마다 독립 보관
    function newEditSettings() {
      return {
        scope:   { mode: 'all', from: 1, to: 1, chapter: '' },
        scaling: { mode: 'none', paper: 'A4', orient: 'auto', customW: 210, customH: 297, fitMargins: true, percent: 100 },
        margins: { enabled: false, top: 10, bottom: 10, left: 10, right: 10 }, // mm — enabled일 때만 적용
        nUp: 1,
        gutter: 0,        // 조판 칸 사이 간격 (mm)
        border: 'none',
        // 기울기 보정 — auto: 페이지별 자동 감지, manual: angle(° , + = 시계방향) 일괄
        deskew: { enabled: false, mode: 'auto', angle: 0 },
        // 내용 가운데 정렬 — mode: page(페이지별)|uniform(문서 평균 일괄), axis: both|h|v, ignore: 가장자리 무시 %
        center: { enabled: false, mode: 'page', axis: 'both', ignore: 3 },
        // 제본여백 — size(mm), side: left|right|top, method: scale(축소)|shift(밀기), alt: 홀짝 교대(양면)
        bind: { enabled: false, size: 10, side: 'left', method: 'scale', alt: true },
        // 머리글/바닥글 — 좌/중/우 6칸, 자리표시자 {page}{total}{date}{filename}{n}
        hf: { enabled: false, hL: '', hC: '', hR: '', fL: '', fC: '', fR: '',
              // 홀·짝 전용 칸 — 값이 하나라도 있으면 그쪽 페이지는 전용 칸으로 인쇄(공통 칸 대신),
              // 모두 비어 있으면 공통(hL~fR)으로 폴백. o*=홀수쪽, e*=짝수쪽.
              oHL: '', oHC: '', oHR: '', oFL: '', oFC: '', oFR: '',
              eHL: '', eHC: '', eHR: '', eFL: '', eFC: '', eFR: '',
              size: 9, color: '#333333', margin: 10, pnumStyle: 1, alt: false,   // alt = 짝수쪽 좌우 교대(책 바깥쪽)
              start: 1,   // 번호 시작 페이지 — 이 출력 페이지부터 번호를 매긴다(앞 페이지는 번호 생략)
              numFrom: 1, // 그 시작 페이지에 찍힐 첫 번호 — 5면 5,6,7…(앞권에서 이어지는 책)
              // 적용 범위 — all: 전체 / from: applyFrom쪽부터 끝까지 / pick: 체크한 페이지·챕터만
              applyMode: 'all', applyFrom: 1, applyPages: [], applyChapters: [],
              offX: 0, offY: 0,   // 위치 미세조절 mm (+X=오른쪽, +Y=아래) — 머리글·바닥글 전체 이동
              font: 'C:\\Windows\\Fonts\\malgun.ttf' },
        // 워터마크
        wm: { enabled: false, text: '', size: 48, color: '#cccccc',
              opacity: 30, angle: 45, mode: 'center' },
        // 합본 문서의 챕터별 개별 설정 — 적용 범위를 '챕터'로 두고 편집하면 여기에 저장되어
        // 전역(위) 설정과 별개로 그 챕터에만 적용된다. { [챕터명]: {scaling,margins,nUp,gutter,border,hf,wm} }
        byChapter: {},
      };
    }

    // ── PDF 저장 옵션 (pdf-lib) ────────────────────────────────────────────────
    // pdf-lib은 저장 중 objectsPerTick개마다 setTimeout(…,0)으로 이벤트 루프에 양보한다.
    // 기본값 50은 이 앱처럼 객체가 많은 문서에서 재앙이다 — 실측(2403쪽·간접객체 13,553개):
    // 실제 직렬화는 126ms인데 tick 대기만 9.6초였다(브라우저가 중첩 setTimeout을 최소 4ms로
    // 조이고 큰 버퍼 GC까지 겹쳐 tick 하나당 25~36ms). **결과 바이트는 tick 수와 무관하게 동일**하다.
    // → 문서 크기를 보고 '한 번 멈춤이 SAVE_CHUNK_MS를 넘지 않을 만큼'만 나눈다.
    //   작은 문서는 아예 쉬지 않고(가장 빠름), 아주 큰 문서만 몇 번 쉬어 간다.
    const SAVE_CHUNK_MS = 200;      // 한 번에 멈춰도 괜찮은 시간
    const SAVE_OBJS_PER_MS = 108;   // 실측 직렬화 속도 (13,553객체 / 126ms)
    function pdfSaveOpts(doc, extra) {
      let n = 0;
      try { n = (doc && doc.context && doc.context.indirectObjects) ? doc.context.indirectObjects.size : 0; } catch (e) {}
      const total = 2 * n;          // pdf-lib은 크기 계산·직렬화로 객체를 두 번 훑는다
      const budget = SAVE_CHUNK_MS * SAVE_OBJS_PER_MS;
      const ticks = Math.floor(total / budget);            // 이 문서에 필요한 쉼 횟수(작으면 0)
      const per = ticks > 0 ? Math.ceil(total / (ticks + 1)) : total + 1;
      return Object.assign({ useObjectStreams: false, updateFieldAppearances: false,
                             objectsPerTick: Math.max(1000, per) }, extra || {});
    }
    function savePdfDoc(doc, extra) { return doc.save(pdfSaveOpts(doc, extra)); }

    // ── 멀티코어 Worker Pool ──────────────────────────────────────────────────
    class WorkerPool {
      // 워커는 **처음 일이 들어올 때** 만든다. 예전에는 생성자에서 코어 수만큼 한꺼번에
      // 만들어, 문서를 열기도 전에 16+16개가 떠 있었다. 조립 워커는 하나가
      // pdf-lib+fontkit(약 1.28MB)을 importScripts 하므로 그 자체로 무거웠다.
      constructor(scriptPath, numWorkers) {
        this.pending = new Map();
        this.nextId = 0;
        this.freeWorkers = [];
        this.jobQueue = [];
        this.maxWorkers = Math.max(1, numWorkers);
        this.workerUrl = new URL(scriptPath, window.location.href).href;
        this.workers = [];   // 실제로 만들어진 워커 (필요한 만큼만 늘어난다)
      }
      _spawn() {
        const w = new Worker(this.workerUrl);
        w.onmessage = (e) => this._onResult(w, e.data);
        w.onerror   = (e) => {
          const job = w.__currentJob;
          if (job) { this.pending.get(job.id)?.reject(new Error(e.message)); this.pending.delete(job.id); }
          w.__currentJob = null;
          this.freeWorkers.push(w);
          this._flush();
        };
        this.workers.push(w);
        return w;
      }
      run(type, payload, transferable = [], onProgress = null) {
        return new Promise((resolve, reject) => {
          const id = this.nextId++;
          this.jobQueue.push({ id, type, payload, transferable, resolve, reject, onProgress });
          this._flush();
        });
      }
      _flush() {
        while (this.jobQueue.length > 0) {
          let worker = this.freeWorkers.pop();
          if (!worker) {
            if (this.workers.length >= this.maxWorkers) break;   // 상한까지 다 쓰는 중 — 큐에서 대기
            worker = this._spawn();
          }
          this._dispatch(worker, this.jobQueue.shift());
        }
      }
      _dispatch(worker, job) {
        this.pending.set(job.id, { resolve: job.resolve, reject: job.reject, onProgress: job.onProgress });
        worker.__currentJob = job;
        worker.postMessage({ id: job.id, type: job.type, payload: job.payload }, job.transferable);
      }
      _onResult(worker, data) {
        const p = this.pending.get(data.id);
        if (!p) return;
        if (data.progress !== undefined) { p.onProgress?.(data.progress); return; }
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.result);
        this.pending.delete(data.id);
        worker.__currentJob = null;
        this.freeWorkers.push(worker);
        this._flush();
      }
    }
    const CORES = Math.max(navigator.hardwareConcurrency || 4, 2);
    // 상한만 정해 둘 뿐, 실제 워커는 첫 작업이 들어올 때 하나씩 만들어진다(지연 생성).
    const grayWorkerPool = new WorkerPool('./worker-gray.js', CORES);
    const assembleWorkerPool = new WorkerPool('./worker-assemble.js', CORES);

    // ── 탭 관리 ──────────────────────────────────────────────────────────────
    const tabs = new Map(); // id → tabState
    let activeTabId = null;

    function newTabState(file) {
      return {
        id: 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        fileName: file.name,
        originalFileName: file.name.replace(/\.(pdf|hwpx?|docx?|xlsx?|pptx?|psd|indd|ai)$/i, ''),
        originalPdfBytes: null,
        pdfDoc: null,
        pageResults: [],
        selectedPages: new Set(),
        originalThumbnails: new Map(),
        quoteItems: [],
        processingOptions: { bw: false, inkNorm: true },
        status: 'loading',
        errorMsg: '',
        colorCount: 0,
        bwCount: 0,
        progress: 0,
        defaultPageSize: null,
        pageEdited: false,
        undoStack: [],
        redoStack: [],
        fileSize: file.size || 0,
        editSettings: newEditSettings(),
        contentEdits: new Map(), // 페이지 내부편집(내부 텍스트·요소): originalIdx → { model, bytes, rev }
      };
    }

    // PDF 페이지 크기(pt) → 표준 용지명 판별 (mm 기준, 오차 허용)
    function detectPaperName(wmm, hmm) {
      const std = [
        ['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['A6', 105, 148],
        ['B4', 250, 353], ['B5', 176, 250], ['B6', 125, 176],
        ['Letter', 216, 279], ['Legal', 216, 356], ['Tabloid', 279, 432],
      ];
      const tol = 3; // ±3mm
      for (const [name, a, b] of std) {
        if ((Math.abs(wmm - a) <= tol && Math.abs(hmm - b) <= tol) ||
            (Math.abs(wmm - b) <= tol && Math.abs(hmm - a) <= tol)) return name;
      }
      return null;
    }

    // 페이지의 실제 크기(pt) 추출 — 빈 페이지는 pageSize, 분석된 페이지는 pageWpt/pageHpt
    function pagePtSize(r) {
      if (!r) return null;
      if (r.isBlank && r.pageSize) return [r.pageSize[0], r.pageSize[1]];
      if (r.pageWpt) return [r.pageWpt, r.pageHpt];
      return null;
    }

    // pt 크기 → { key, text } (표준 용지명·방향 포함)
    function sizeLabel(wpt, hpt) {
      const wmm = wpt * 25.4 / 72, hmm = hpt * 25.4 / 72;
      const w = Math.round(wmm), h = Math.round(hmm);
      const name = detectPaperName(wmm, hmm);
      const orient = wmm > hmm ? '가로' : '세로';
      return {
        key: `${w}x${h}`,
        text: `${w} × ${h} mm` + (name ? ` (${name}·${orient})` : ` (${orient})`),
      };
    }

    // 업로드 문서 정보(파일명·페이지 크기·페이지수)를 상단에 표시
    // 페이지 크기가 다르면 "혼합 — 크기별 페이지 범위" 로 표기
    function updateFileInfo(tab) {
      if (!tab) return;
      const results = tab.pageResults ? tab.pageResults.filter(Boolean) : [];
      const pages = results.length;

      // 크기별 그룹화 (key → { text, nums[] })
      const groups = new Map();
      results.forEach(r => {
        const sz = pagePtSize(r);
        if (!sz) return;
        const lbl = sizeLabel(sz[0], sz[1]);
        if (!groups.has(lbl.key)) groups.set(lbl.key, { text: lbl.text, nums: [] });
        groups.get(lbl.key).nums.push(r.pageNum);
      });

      let sizeStr = '';
      if (groups.size === 0 && tab.defaultPageSize) {
        // 분석 전: 1페이지 크기로 임시 표시
        sizeStr = `📐 ${sizeLabel(tab.defaultPageSize[0], tab.defaultPageSize[1]).text}`;
      } else if (groups.size === 1) {
        sizeStr = `📐 ${[...groups.values()][0].text}`;
      } else if (groups.size > 1) {
        const parts = [...groups.values()]
          .sort((a, b) => b.nums.length - a.nums.length)
          .map(g => `${g.text} ${formatRanges(g.nums)}p`);
        sizeStr = `📐 혼합 — ${parts.join(' · ')}`;
      }

      const html = `<strong>${tab.fileName}</strong>`
        + (sizeStr ? ` — ${sizeStr}` : '')
        + (pages ? ` · 📄 ${pages}페이지` : '');
      fileInfo.innerHTML = html;
      // 크기·내용이 바뀔 때만 3초간 표시 후 자동 숨김 (페이지 편집 영역을 가리지 않도록)
      showFileInfoTransient(html);
    }

    // 문서 크기 배너: 내용 변동 시에만 3초 노출 후 자동 숨김
    let _fileInfoTimer = null, _fileInfoLast = '';
    function showFileInfoTransient(html) {
      if (html === _fileInfoLast && fileInfo.style.display === 'none') return; // 동일 내용 재노출 안 함
      _fileInfoLast = html;
      fileInfo.style.display = 'block';
      fileInfo.style.transition = 'opacity 0.4s';
      fileInfo.style.opacity = '1';
      clearTimeout(_fileInfoTimer);
      _fileInfoTimer = setTimeout(() => {
        fileInfo.style.opacity = '0';
        setTimeout(() => { if (fileInfo.style.opacity === '0') fileInfo.style.display = 'none'; }, 450);
      }, 3000);
    }

    function createTab(file) {
      const state = newTabState(file);
      tabs.set(state.id, state);
      if (tabs.size >= 2) tabBars.forEach(b => b.style.display = 'flex');
      renderTabBar();
      syncMainTabBarOffset();
      return state;
    }

    function activateTab(id) {
      if (!tabs.has(id)) return;
      // 현재 탭의 processingOptions 저장
      if (activeTabId && tabs.has(activeTabId)) {
        Object.assign(tabs.get(activeTabId).processingOptions, processingOptions);
      }
      activeTabId = id;
      const tab = tabs.get(id);

      // 전역 앨리어스를 새 탭의 상태 객체로 교체
      originalPdfBytes   = tab.originalPdfBytes;
      originalFileName   = tab.originalFileName;
      globalPdfDoc       = tab.pdfDoc;
      pageResults        = tab.pageResults;
      selectedPages      = tab.selectedPages;
      originalThumbnails = tab.originalThumbnails;
      quoteItems         = tab.quoteItems;
      Object.assign(processingOptions, tab.processingOptions);
      pageEdited         = tab.pageEdited;
      undoStack          = tab.undoStack;
      redoStack          = tab.redoStack;
      if (!tab.editSettings) tab.editSettings = newEditSettings();
      editSettings       = tab.editSettings;
      if (!tab.contentEdits) tab.contentEdits = new Map();
      contentEdits       = tab.contentEdits;
      // 탭 전환 시 이전 탭의 '적용' 결과는 무효화 (다운로드 비활성)
      processedPdfBytes  = null;
      processedFileName  = '';
      if (typeof closePreview === 'function') closePreview();
      if (typeof clearProcessCaches === 'function') clearProcessCaches();

      hideError(); hideSuccess();

      if (tab.status === 'ready') {
        hideLoading(); progressBar.style.display = 'none';
        resultsSection.style.display = 'block';
        renderTabUI(tab);
      } else if (tab.status === 'loading') {
        resultsSection.style.display = 'none';
        showLoading('PDF를 분석하고 있습니다...');
        progressBar.style.display = 'block';
        updateProgress(tab.progress);
      } else if (tab.status === 'error') {
        resultsSection.style.display = 'none';
        hideLoading(); progressBar.style.display = 'none';
        showError(tab.errorMsg);
      } else {
        resultsSection.style.display = 'none';
        hideLoading(); progressBar.style.display = 'none';
      }
      renderTabBar();
    }

    // 닫는 탭의 썸네일 objectURL 해제 (메모리 누수 방지; blob: URL만 대상, data:는 무시)
    function revokeThumbnails(results) {
      if (!results) return;
      results.forEach(r => {
        if (r && typeof r.thumbnail === 'string' && r.thumbnail.startsWith('blob:')) {
          try { URL.revokeObjectURL(r.thumbnail); } catch {}
        }
      });
    }

    function closeTab(id) {
      const closing = tabs.get(id);
      if (closing) revokeThumbnails(closing.pageResults);
      tabs.delete(id);
      if (activeTabId === id) {
        const remaining = [...tabs.keys()];
        if (remaining.length > 0) {
          activateTab(remaining[remaining.length - 1]);
        } else {
          activeTabId = null;
          resultsSection.style.display = 'none';
          setThumbZoomWidgetVisible(false);
          showSidebar(false);
          hideLoading(); progressBar.style.display = 'none';
          hideError(); hideSuccess();
          originalPdfBytes = null; originalFileName = '';
          pageResults = []; selectedPages = new Set();
          originalThumbnails = new Map(); quoteItems = [];
        }
      }
      if (tabs.size < 2) tabBars.forEach(b => b.style.display = 'none');
      renderTabBar();
      syncMainTabBarOffset();
    }

    let dragTabId = null;
    // 탭 순서 변경: srcId 탭을 targetId 탭 앞으로 이동시켜 Map을 재구성
    function moveTabBefore(srcId, targetId) {
      if (srcId === targetId) return;
      const ids = [...tabs.keys()].filter(id => id !== srcId);
      const idx = ids.indexOf(targetId);
      if (idx < 0) return;
      ids.splice(idx, 0, srcId);
      const entries = ids.map(id => [id, tabs.get(id)]);
      tabs.clear();
      entries.forEach(([id, st]) => tabs.set(id, st));
      renderTabBar();
    }

    // #mainTabBar(상단 고정)가 표시될 때 그 높이만큼 .sticky-panel을 밀어내려
    // 두 sticky 요소가 스크롤 시 서로 겹치지 않게 한다.
    function syncMainTabBarOffset() {
      requestAnimationFrame(() => {
        const h = mainTabBar.style.display === 'flex' ? mainTabBar.getBoundingClientRect().height : 0;
        document.documentElement.style.setProperty('--maintabbar-h', h + 'px');
      });
    }

    // 사이드바(#tabBar)·메인(#mainTabBar) 두 곳에 동일한 탭 목록을 렌더링한다.
    // 사이드바를 닫아도 메인 쪽 탭 바는 항상 보이도록 동시에 표시한다.
    function renderTabBar() {
      reportDocState();   // 탭 생성·전환·닫기·분석 완료가 모두 이 함수를 지난다
      tabBars.forEach(container => {
        container.innerHTML = '';
        tabs.forEach((state, id) => {
          const tab = document.createElement('div');
          tab.className = 'tab-item' + (id === activeTabId ? ' active' : '');
          const icon = state.status === 'loading' ? '⏳ ' : state.status === 'error' ? '❌ ' : '📄 ';
          const short = state.fileName.length > 22 ? state.fileName.slice(0, 20) + '…' : state.fileName;
          tab.title = state.fileName;
          tab.draggable = true;
          tab.innerHTML = `<span class="tab-name">${icon}${short}</span><button class="tab-close" onclick="event.stopPropagation();closeTab('${id}')">✕</button>`;
          tab.onclick = () => activateTab(id);
          // 마우스 드래그로 탭 순서 변경
          tab.ondragstart = (e) => { dragTabId = id; e.dataTransfer.effectAllowed = 'move'; tab.classList.add('dragging'); };
          tab.ondragend = () => { dragTabId = null; container.querySelectorAll('.tab-item').forEach(t => t.classList.remove('dragging','drag-over')); };
          tab.ondragover = (e) => { if (dragTabId && dragTabId !== id) { e.preventDefault(); tab.classList.add('drag-over'); } };
          tab.ondragleave = () => tab.classList.remove('drag-over');
          tab.ondrop = (e) => { e.preventDefault(); tab.classList.remove('drag-over'); if (dragTabId) moveTabBefore(dragTabId, id); };
          container.appendChild(tab);
        });
        // 2개 이상 열려 있으면 '파일 합치기' 버튼 표시
        if (tabs.size >= 2) {
          const mb = document.createElement('button');
          mb.className = 'tab-merge-btn';
          mb.innerHTML = '<span class="ic">🔗</span> 파일 합치기';
          mb.title = '열려 있는 모든 파일을 하나의 PDF로 합쳐 저장합니다';
          mb.onclick = mergeAllTabs;
          container.appendChild(mb);
        }
      });
    }

    function renderTabUI(tab) {
      setThumbZoomWidgetVisible(true);
      showSidebar(true);
      const total = tab.pageResults.length;
      totalPagesEl.textContent     = total;
      colorPagesEl.textContent     = tab.colorCount;
      grayscalePagesEl.textContent = tab.bwCount;
      colorPercentEl.textContent   = Math.round(tab.colorCount / Math.max(1, total) * 100) + '%';

      const colorList = tab.pageResults.filter(p => p && p.isColor).map(p => p.pageNum);
      const grayList  = tab.pageResults.filter(p => p && !p.isColor).map(p => p.pageNum);
      rangeSummary.innerHTML = `<strong>컬러 페이지:</strong> ${formatRanges(colorList)}<br><strong>흑백 페이지:</strong> ${formatRanges(grayList)}` + rgbGrayWarningHtml();

      renderAllPages(tab.pageResults);

      // 처리 옵션 버튼 상태 복원
      Object.keys(processingOptions).forEach(k => {
        const btn = document.getElementById('opt-' + k);
        if (btn) btn.classList.toggle('active', processingOptions[k]);
      });
      updateDownloadBtn();
      updateFileInfo(tab);

      updateSelectedCount();

      if (tab.quoteItems.length > 0) {
        document.getElementById('q-customer').value = tab._customer || '';
        document.getElementById('q-date').value = tab._date || new Date().toISOString().split('T')[0];
        renderQuoteTable();
        document.getElementById('quoteSection').style.display = 'block';
      } else {
        document.getElementById('quoteSection').style.display = 'none';
      }
    }

    // ── 파일 핸들링 ──────────────────────────────────────────────────────────
    const HWP_RE    = /\.hwpx?$/i;                  // 한글 (한컴오피스 COM)
    const OFFICE_RE = /\.(docx?|xlsx?|pptx?)$/i;    // MS Office (Word·Excel·PowerPoint COM)
    const ADOBE_RE  = /\.(psd|indd)$/i;            // Photoshop·InDesign (Adobe COM)
    const AI_RE     = /\.ai$/i;                    // Illustrator (PDF 호환본은 직접, 아니면 COM)
    const IMG_RE    = /\.(png|jpe?g|gif|bmp|webp|tiff?|avif)$/i;   // 이미지 — 앱 없이 렌더러에서 1쪽 PDF로
    const CONVERT_RE = /\.(hwpx?|docx?|xlsx?|pptx?|psd|indd|ai|png|jpe?g|gif|bmp|webp|tiff?|avif)$/i; // PDF 변환이 필요한 모든 확장자

    // ── 🖼 이미지 → 1쪽 PDF ──────────────────────────────────────────────────
    // 외부 앱 없이 렌더러에서 처리한다. PNG/JPEG는 원본 스트림을 그대로 임베드(무손실·용량 유지),
    // 그 외(GIF·BMP·WEBP·AVIF)는 Chromium 디코더로 읽어 PNG로 재인코딩한다.
    // 페이지 크기는 '실제 인쇄 크기' — 파일에 기록된 해상도(PNG pHYs / JPEG JFIF density)를 읽어
    // px→pt로 환산한다. 기록이 없으면 긴 변 1000px 이상은 스캔·인쇄 원고로 보고 300DPI,
    // 그 미만(화면 캡처 등)은 96DPI로 가정. 결과가 10~1500mm를 벗어나면 비율 유지로 보정한다.
    function pngDpi(u8) {
      if (!(u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47)) return null;
      let p = 8;
      while (p + 12 <= u8.length) {
        const len = ((u8[p] << 24) | (u8[p+1] << 16) | (u8[p+2] << 8) | u8[p+3]) >>> 0;
        const type = String.fromCharCode(u8[p+4], u8[p+5], u8[p+6], u8[p+7]);
        if (type === 'pHYs' && len >= 9) {
          const d = p + 8;
          const x = ((u8[d] << 24) | (u8[d+1] << 16) | (u8[d+2] << 8) | u8[d+3]) >>> 0;
          const y = ((u8[d+4] << 24) | (u8[d+5] << 16) | (u8[d+6] << 8) | u8[d+7]) >>> 0;
          // unit 1 = 미터당 픽셀 → DPI. unit 0(단위 없음)은 가로세로 비율일 뿐이라 쓰지 않는다.
          if (u8[d+8] === 1 && x > 0 && y > 0) return { x: x * 0.0254, y: y * 0.0254 };
          return null;
        }
        if (type === 'IDAT' || type === 'IEND') return null;
        p += 12 + len;
      }
      return null;
    }
    function jpegDpi(u8) {
      if (!(u8[0] === 0xFF && u8[1] === 0xD8)) return null;
      let p = 2;
      while (p + 4 <= u8.length) {
        if (u8[p] !== 0xFF) { p++; continue; }
        const m = u8[p+1];
        if (m === 0xFF) { p++; continue; }                       // 패딩 바이트
        if (m === 0x01 || (m >= 0xD0 && m <= 0xD9)) { p += 2; continue; }
        const len = (u8[p+2] << 8) | u8[p+3];
        if (len < 2) return null;
        if (m === 0xDA) return null;                             // 스캔 데이터 시작 = 헤더 끝
        if (m === 0xE0 && len >= 14
            && u8[p+4] === 0x4A && u8[p+5] === 0x46 && u8[p+6] === 0x49 && u8[p+7] === 0x46 && u8[p+8] === 0x00) {
          const unit = u8[p+11];
          const xd = (u8[p+12] << 8) | u8[p+13], yd = (u8[p+14] << 8) | u8[p+15];
          if (xd > 0 && yd > 0) {
            if (unit === 1) return { x: xd, y: yd };                 // dots/inch
            if (unit === 2) return { x: xd * 2.54, y: yd * 2.54 };   // dots/cm
          }
          return null;
        }
        p += 2 + len;
      }
      return null;
    }
    // PNG·JPEG 이외 포맷 — 브라우저 디코더로 읽어 PNG 바이트로 재인코딩
    async function reencodeImageToPng(u8, name) {
      let bmp;
      try { bmp = await createImageBitmap(new Blob([u8])); }
      catch (e) { throw new Error(`'${name}' 이미지를 읽을 수 없습니다 — 지원하지 않는 형식이거나 파일이 손상되었습니다.`); }
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
      if (!blob) throw new Error(`'${name}' 이미지를 PNG로 변환하지 못했습니다.`);
      return new Uint8Array(await blob.arrayBuffer());
    }
    async function imageToPdfBytes(ab, name) {
      const u8 = ab instanceof Uint8Array ? ab : new Uint8Array(ab);
      const doc = await PDFLib.PDFDocument.create();
      const isPng = u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47;
      const isJpg = u8[0] === 0xFF && u8[1] === 0xD8;
      let img, dpi = null;
      if (isPng)      { img = await doc.embedPng(u8); dpi = pngDpi(u8); }
      else if (isJpg) { img = await doc.embedJpg(u8); dpi = jpegDpi(u8); }
      else            { img = await doc.embedPng(await reencodeImageToPng(u8, name)); }
      const fb = Math.max(img.width, img.height) >= 1000 ? 300 : 96;
      const dx = dpi && dpi.x > 1 ? dpi.x : fb;
      const dy = dpi && dpi.y > 1 ? dpi.y : fb;
      let pw = img.width * 72 / dx, ph = img.height * 72 / dy;
      const MINPT = 10 * 72 / 25.4, MAXPT = 1500 * 72 / 25.4;
      const s = Math.max(pw, ph) > MAXPT ? MAXPT / Math.max(pw, ph)
              : Math.min(pw, ph) < MINPT ? MINPT / Math.min(pw, ph) : 1;
      pw *= s; ph *= s;
      const page = doc.addPage([pw, ph]);
      page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
      // 다른 변환 경로(readFile)와 같은 ArrayBuffer로 반환 — 이후 파이프라인이 동일하게 다룬다
      const out = await savePdfDoc(doc);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }

    // ── 최근 파일 (localStorage, 최대 8개) ──────────────────────────────────
    function loadRecentFiles() {
      try { return JSON.parse(localStorage.getItem('recentFiles')) || []; } catch (e) { return []; }
    }
    function addRecentFile(it) {
      if (!it || !it.path) return;
      try {
        let list = loadRecentFiles().filter(r => r.path !== it.path);
        list.unshift({ name: it.name, path: it.path, ts: Date.now() });
        localStorage.setItem('recentFiles', JSON.stringify(list.slice(0, 8)));
        renderRecentFiles();
      } catch (e) {}
    }
    function removeRecentFile(p) {
      try {
        localStorage.setItem('recentFiles', JSON.stringify(loadRecentFiles().filter(r => r.path !== p)));
        renderRecentFiles();
      } catch (e) {}
    }
    function clearRecentFiles() {
      if (!loadRecentFiles().length) return;
      if (!confirm('최근 파일 기록을 모두 삭제할까요?')) return;
      try { localStorage.removeItem('recentFiles'); } catch (e) {}
      renderRecentFiles();
    }
    function renderRecentFiles() {
      const box = document.getElementById('recentFiles');
      if (!box) return;
      const list = loadRecentFiles();
      box.innerHTML = '';
      if (!list.length) { box.style.display = 'none'; return; }
      box.style.display = 'flex';
      const lbl = document.createElement('span'); lbl.className = 'recent-label'; lbl.textContent = '🕘 최근 파일:';
      box.appendChild(lbl);
      list.forEach(r => {
        // 칩(파일명 클릭=열기) + × 삭제 버튼
        const item = document.createElement('span');
        item.className = 'recent-item'; item.title = r.path;
        const chip = document.createElement('button');
        chip.className = 'recent-chip'; chip.textContent = r.name;
        chip.onclick = (e) => { e.stopPropagation(); openRecentFile(r); };
        const del = document.createElement('button');
        del.className = 'recent-del'; del.textContent = '×'; del.title = '이 항목을 최근 목록에서 삭제';
        del.onclick = (e) => { e.stopPropagation(); removeRecentFile(r.path); };
        item.appendChild(chip); item.appendChild(del);
        box.appendChild(item);
      });
      // 전체 삭제
      const clear = document.createElement('button');
      clear.className = 'recent-clear'; clear.textContent = '🗑 기록 전체삭제'; clear.title = '최근 파일 기록을 모두 삭제';
      clear.onclick = (e) => { e.stopPropagation(); clearRecentFiles(); };
      box.appendChild(clear);
    }
    async function openRecentFile(r) {
      hideError(); hideSuccess();
      try {
        if (CONVERT_RE.test(r.name)) showLoading('문서를 PDF로 변환하고 있습니다…');
        const files = await prepareFiles([{ name: r.name, path: r.path }]);
        hideLoading();
        if (files.length) startLoad(files);
        else removeRecentFile(r.path);   // 변환/읽기 실패(파일 삭제·이동 등) → 목록에서 제거
      } catch (e) {
        hideLoading(); removeRecentFile(r.path);
        showError('최근 파일 열기 실패: ' + (e && e.message ? e.message : String(e)));
      }
    }

    // ── 가져오기 실패 재시도 ─────────────────────────────────────────────────
    // prepareFiles가 항목별 실패를 여기에 모으고, 에러 배너에 '다시 시도' 버튼을 붙인다.
    let _failedImports = [];
    function showImportFailures() {
      if (!_failedImports.length) return;
      const names = _failedImports.map(f => f.name).join(', ');
      const reason = _failedImports[0].reason || '';
      errorEl.innerHTML = '';
      const txt = document.createElement('span');
      txt.textContent = `${_failedImports.length}개 파일 변환/읽기 실패: ${names}` + (reason ? `\n${reason}` : '');
      const btn = document.createElement('button');
      btn.className = 'retry-import-btn';
      btn.textContent = '↻ 다시 시도';
      btn.onclick = retryFailedImports;
      errorEl.append(txt, btn);
      errorEl.style.display = 'block';
      successEl.style.display = 'none';
    }
    async function retryFailedImports() {
      if (!_failedImports.length) return;
      const items = _failedImports.map(f => ({ name: f.name, path: f.path }));
      _failedImports = [];
      hideError();
      try {
        showLoading('실패한 파일을 다시 변환하는 중…');
        const files = await prepareFiles(items);
        hideLoading();
        if (files.length) startLoad(files);
      } catch (e) {
        hideLoading();
        showError('다시 시도 실패: ' + (e && e.message ? e.message : String(e)));
      }
    }

    // 경로 기반 입력({name, path})을 File-like 객체로 변환.
    // HWP/HWPX=한글 COM, MS Office=Office COM, Photoshop/InDesign=Adobe COM으로 PDF 변환.
    // Illustrator .ai는 PDF 호환 저장본이면 그 자체가 PDF라 앱 실행 없이 직접 사용한다.
    // (변환 계열은 모두 단일 인스턴스라 순차 변환)
    // 한 파일이 실패해도 전체가 중단되지 않는다 — 실패 항목은 _failedImports에 모아
    // '다시 시도' 버튼을 노출하고, 성공한 파일들만 반환한다.
    // 저장 다이얼로그의 기본 폴더를 '문서를 연 폴더'로 (main의 _lastSaveDir)
    function reportSaveDir(filePath) {
      try {
        const s = String(filePath);
        const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
        const dir = cut > 0 ? s.slice(0, cut) : '';
        if (dir && window.electronAPI.setSaveDir) window.electronAPI.setSaveDir(dir);
      } catch (e) { }
    }

    async function prepareFiles(items) {
      const out = [];
      const failed = [];
      for (const it of items) {
        try {
          let pdfPath = null;
          let directBytes = null;   // 이미 읽어둔 PDF 바이트 재사용(.ai PDF 호환본)
          if (IMG_RE.test(it.name)) {
            // 🖼 이미지 — 외부 앱 없이 렌더러에서 1쪽 PDF로 (원본 해상도·실제 인쇄 크기 유지)
            showLoading(`${it.name} → PDF로 변환 중… (이미지)`);
            directBytes = await imageToPdfBytes(window.electronAPI.readFile(it.path), it.name);
          } else if (HWP_RE.test(it.name)) {
            showLoading(`${it.name} → PDF로 변환 중…`);
            pdfPath = await window.electronAPI.convertHwpToPdf(it.path);
          } else if (OFFICE_RE.test(it.name)) {
            showLoading(`${it.name} → PDF로 변환 중…`);
            pdfPath = await window.electronAPI.convertOfficeToPdf(it.path);
          } else if (ADOBE_RE.test(it.name)) {
            showLoading(`${it.name} → PDF로 변환 중… (Adobe 앱 실행, 수십 초 걸릴 수 있어요)`);
            pdfPath = await window.electronAPI.convertAdobeToPdf(it.path);
          } else if (AI_RE.test(it.name)) {
            // Illustrator .ai: PDF 호환 저장본(%PDF로 시작)이면 그대로 PDF로 사용
            const ab = window.electronAPI.readFile(it.path);
            const h = new Uint8Array(ab.slice(0, 5));
            const isPdf = h[0]===0x25 && h[1]===0x50 && h[2]===0x44 && h[3]===0x46; // "%PDF"
            if (isPdf) {
              directBytes = ab;
            } else {
              showLoading(`${it.name} → PDF로 변환 중… (Illustrator 실행)`);
              pdfPath = await window.electronAPI.convertAdobeToPdf(it.path);
            }
          }
          const readPath = pdfPath || it.path;
          const tmpToClean = pdfPath; // 변환으로 생성된 임시 PDF만 정리 대상
          out.push({
            name: it.name,                       // 원본 이름(확장자 포함) 유지 — 표시·저장명에 사용
            size: 0,
            type: 'application/pdf',
            arrayBuffer: () => Promise.resolve(directBytes || window.electronAPI.readFile(readPath))
              .then(buf => {
                // 메모리로 읽어들였으니 변환 임시 PDF는 즉시 삭제 (디스크 누적 방지)
                if (tmpToClean && window.electronAPI.cleanupTempFile) {
                  try { window.electronAPI.cleanupTempFile(tmpToClean); } catch (e) {}
                }
                return buf;
              }),
          });
          if (it.path) { addRecentFile(it); reportSaveDir(it.path); }   // 최근 목록 + 저장 기본 폴더
        } catch (e) {
          console.error('파일 준비 실패:', it.name, e);
          failed.push({ name: it.name, path: it.path, reason: (e && e.message) || String(e) });
        }
      }
      if (failed.length) { _failedImports = failed; showImportFailures(); }
      return out;
    }

    async function openFilesDialog() {
      try {
        const result = await window.electronAPI.openFile();
        if (!result || !result.length) return;
        hideError(); hideSuccess();
        // 2개 이상이면 순서 지정 화면을 먼저 — 순서를 정하고 하나로 합쳐 열 수 있다
        if (result.length > 1) { showOpenOrderDialog(result); return; }
        const needConvert = result.some(r => CONVERT_RE.test(r.name));
        if (needConvert) showLoading('문서를 PDF로 변환하고 있습니다…');
        // preload의 readFile()로 파일을 직접 읽어 File-like 객체 생성
        // (IPC로 대용량 바이너리를 전달하지 않아 빠르고 안정적)
        const fakeFiles = await prepareFiles(result);
        if (needConvert) hideLoading();
        if (fakeFiles.length) startLoad(fakeFiles);
      } catch(e) {
        hideLoading();
        showError('파일 열기 오류: ' + (e && e.message ? e.message : String(e)));
        console.error('openFilesDialog 오류:', e);
      }
    }

    // ── 외부에서 넘어온 문서 열기 (실행 인자 · 목차 검증기 '이어서 작업') ────
    // 다이얼로그 경로와 같은 파이프라인(prepareFiles → startLoad)을 탄다.
    async function openExternalItems(items, opts) {
      try {
        hideError(); hideSuccess();
        // 💼 작업 파일은 변환 파이프라인을 타지 않는다 — 안에 든 PDF와 상태를 직접 복원한다
        const work = items.filter(r => /\.pdfw$/i.test(r.name || r.path || ''));
        if (work.length) {
          for (const w of work) await openWorkFilePath(w.path);
          items = items.filter(r => !/\.pdfw$/i.test(r.name || r.path || ''));
          if (!items.length) return;
        }
        const needConvert = items.some(r => CONVERT_RE.test(r.name));
        if (needConvert) showLoading('문서를 PDF로 변환하고 있습니다…');
        const fakeFiles = await prepareFiles(items);
        if (needConvert) hideLoading();
        if (!fakeFiles.length) return;
        // 순서 지정에서 '하나로 합쳐 열기'를 고르면 파일별 챕터를 유지한 합본으로 연다
        if (opts && opts.merge && fakeFiles.length > 1) { await openMergedAsChapters(fakeFiles); return; }
        startLoad(fakeFiles);
      } catch (e) {
        hideLoading();
        showError('외부 파일 열기 오류: ' + (e && e.message ? e.message : String(e)));
      }
    }
    if (window.electronAPI.onExternalOpen) {
      window.electronAPI.onExternalOpen(async (items) => {
        if (!items || !items.length) return;
        // 여러 문서를 '보내기'로 받으면 순서 지정 다이얼로그를 먼저 — 정한 순서대로
        // 챕터로 이어져 한 문서로 열린다 (탐색기의 전달 순서는 신뢰할 수 없음)
        if (items.length > 1) { showOpenOrderDialog(items); return; }
        await openExternalItems(items);
      });
    }

    // ── 📚 여러 문서 열 순서 지정 (보내기·다중 전달용) ──────────────────────
    let _orderItems = [];
    function showOpenOrderDialog(items) {
      _orderItems = items.slice();
      _orderSel = -1;
      renderOrderRows();
      restoreOrderPanelSize();
      document.getElementById('orderModal').style.display = 'block';
    }
    // 창 크기(가로·세로 각각)는 사용자가 늘린 대로 기억한다 — 화면보다 커도 그대로 복원
    const ORD_MIN_W = 380, ORD_MIN_H = 300, ORD_MAX = 8000;
    function restoreOrderPanelSize() {
      const el = document.getElementById('orderPanel');
      if (!el) return;
      try {
        const sz = JSON.parse(localStorage.getItem('orderPanelSize') || 'null');
        if (sz && sz.w >= ORD_MIN_W && sz.h >= ORD_MIN_H) {
          el.style.width = Math.min(sz.w, ORD_MAX) + 'px';
          el.style.height = Math.min(sz.h, ORD_MAX) + 'px';
        }
      } catch (e) { }
      bindOrderResize(el);
    }
    function saveOrderPanelSize(el) {
      try { localStorage.setItem('orderPanelSize', JSON.stringify({ w: el.offsetWidth, h: el.offsetHeight })); } catch (e) { }
    }
    // 우측 가장자리(가로) · 하단 가장자리(세로) · 우하단 모서리(동시)를 끌어 크기 조절.
    // CSS resize는 모서리에서만 잡히므로 직접 구현한다. 화면보다 크게도 늘릴 수 있고,
    // 그때는 모달 오버레이(overflow:auto)가 스크롤된다.
    function bindOrderResize(el) {
      if (!el || el._gripBound) return;
      el._gripBound = true;
      let mode = '', sx = 0, sy = 0, sw = 0, sh = 0;
      const onMove = e => {
        if (!mode) return;
        if (mode !== 'b') el.style.width = Math.max(ORD_MIN_W, Math.min(ORD_MAX, sw + (e.clientX - sx))) + 'px';
        if (mode !== 'r') el.style.height = Math.max(ORD_MIN_H, Math.min(ORD_MAX, sh + (e.clientY - sy))) + 'px';
      };
      const onUp = () => {
        if (!mode) return;
        mode = '';
        el.classList.remove('resizing');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        saveOrderPanelSize(el);
      };
      el.querySelectorAll('.ord-grip').forEach(g => {
        g.addEventListener('pointerdown', e => {
          e.preventDefault();
          mode = g.dataset.grip; sx = e.clientX; sy = e.clientY;
          sw = el.offsetWidth; sh = el.offsetHeight;
          el.classList.add('resizing');
          document.addEventListener('pointermove', onMove);
          document.addEventListener('pointerup', onUp);
        });
        // 더블클릭 = 기본 크기로 되돌리기
        g.addEventListener('dblclick', () => {
          el.style.width = '560px';
          el.style.height = Math.round(window.innerHeight * 0.66) + 'px';
          saveOrderPanelSize(el);
        });
      });
    }
    let _orderSel = -1;                       // 선택된 파일(옮길 대상) — 통합 ▲▼의 기준
    function renderOrderRows() {
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      document.getElementById('orderRows').innerHTML = _orderItems.map((it, i) => `
        <div class="ord-row${i === _orderSel ? ' sel' : ''}" draggable="true" data-i="${i}" onclick="selectOrderRow(${i})">
          <span class="ord-num">${i + 1}</span>
          <span class="ord-name" title="${esc(it.path || '')}">${esc(it.name)}</span>
        </div>`).join('');
      syncOrderToolbar();
    }
    function syncOrderToolbar() {
      const has = _orderSel >= 0 && _orderSel < _orderItems.length;
      const info = document.getElementById('ordSelInfo');
      if (info) info.textContent = has
        ? `${_orderSel + 1}번 · ${_orderItems[_orderSel].name}`
        : '옮길 파일을 선택하세요';
      if (info) info.classList.toggle('on', has);
      const dis = (id, off) => { const b = document.getElementById(id); if (b) b.disabled = off; };
      dis('ordTop', !has || _orderSel === 0);
      dis('ordUp', !has || _orderSel === 0);
      dis('ordDown', !has || _orderSel === _orderItems.length - 1);
      dis('ordBottom', !has || _orderSel === _orderItems.length - 1);
    }
    function selectOrderRow(i) {
      _orderSel = (_orderSel === i) ? -1 : i;   // 다시 누르면 선택 해제
      document.querySelectorAll('#orderRows .ord-row').forEach((r, k) => r.classList.toggle('sel', k === _orderSel));
      syncOrderToolbar();
    }
    // 선택된 파일을 d칸 이동 (±999 = 맨 위/맨 아래). 연속 클릭으로 몇 칸이든 자유 이동.
    function moveOrderSel(d) {
      if (_orderSel < 0) return;
      const to = Math.max(0, Math.min(_orderItems.length - 1, _orderSel + d));
      if (to === _orderSel) return;
      const it = _orderItems.splice(_orderSel, 1)[0];
      _orderItems.splice(to, 0, it);
      _orderSel = to;                            // 선택은 파일을 따라간다
      renderOrderRows();
      const row = document.querySelector(`#orderRows .ord-row[data-i="${to}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
    // 옛 호출부 호환 (i번째를 d칸)
    function moveOrderItem(i, d) { _orderSel = i; moveOrderSel(d); }
    function sortOrderItems() {
      const cur = _orderSel >= 0 ? _orderItems[_orderSel] : null;
      _orderItems.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }));
      _orderSel = cur ? _orderItems.indexOf(cur) : -1;
      renderOrderRows();
    }
    function confirmOpenOrder(merge) {
      document.getElementById('orderModal').style.display = 'none';
      openExternalItems(_orderItems.slice(), { merge: !!merge });
    }
    // 마우스 드래그로 자유 이동 — 행 사이(중점 기준)에 끼워 넣는다. 컨테이너 위임 1회 바인딩.
    (function bindOrderDnD() {
      const box = document.getElementById('orderRows');
      if (!box) return;
      let from = -1;
      const clearMarks = () => box.querySelectorAll('.ord-row').forEach(r => r.classList.remove('drop-before', 'drop-after'));
      // 커서 위치가 들어갈 자리(0..length)
      const dropIndex = e => {
        const rows = [...box.querySelectorAll('.ord-row')];
        for (let k = 0; k < rows.length; k++) {
          const b = rows[k].getBoundingClientRect();
          if (e.clientY < b.top + b.height / 2) return k;
        }
        return rows.length;
      };
      box.addEventListener('dragstart', e => {
        const r = e.target.closest('.ord-row'); if (!r) return;
        from = +r.dataset.i; _orderSel = from;
        r.classList.add('dragging'); syncOrderToolbar();
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(from)); } catch (_) { }
      });
      box.addEventListener('dragover', e => {
        if (from < 0) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const at = dropIndex(e);
        const rows = [...box.querySelectorAll('.ord-row')];
        clearMarks();
        if (at < rows.length) rows[at].classList.add('drop-before');
        else if (rows.length) rows[rows.length - 1].classList.add('drop-after');
      });
      box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) clearMarks(); });
      box.addEventListener('drop', e => {
        e.preventDefault();
        if (from < 0) return;
        let at = dropIndex(e);
        if (at > from) at--;                     // 자기 자신을 빼낸 뒤의 인덱스
        clearMarks();
        if (at !== from) {
          const it = _orderItems.splice(from, 1)[0];
          _orderItems.splice(at, 0, it);
          _orderSel = at;
        }
        from = -1;
        renderOrderRows();
      });
      box.addEventListener('dragend', () => { from = -1; clearMarks(); box.querySelectorAll('.dragging').forEach(r => r.classList.remove('dragging')); });
    })();
    // 키보드: ↑↓ 선택 이동, Ctrl+↑↓/Home/End 로 실제 이동
    document.addEventListener('keydown', e => {
      const m = document.getElementById('orderModal');
      if (!m || m.style.display === 'none' || !_orderItems.length) return;
      const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (step) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) moveOrderSel(step);
        else { _orderSel = Math.max(0, Math.min(_orderItems.length - 1, (_orderSel < 0 ? (step > 0 ? -1 : _orderItems.length) : _orderSel) + step)); renderOrderRows(); const r = document.querySelector(`#orderRows .ord-row[data-i="${_orderSel}"]`); if (r) r.scrollIntoView({ block: 'nearest' }); }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault(); moveOrderSel(e.key === 'Home' ? -999 : 999);
      } else if (e.key === 'Escape') { m.style.display = 'none'; }
    });

    // 분석이 끝나 챕터로 합칠 수 있는 상태인지
    function isTabReady(t) {
      return t && t.status === 'ready' && t.originalPdfBytes && t.pageResults.filter(Boolean).length;
    }

    function startLoad(files) {
      // 이미 분석이 끝난 문서가 있으면, 새 파일을 별도 탭이 아니라 그 문서에 챕터로 추가
      // (활성 탭 우선, 없으면 분석이 끝난 첫 탭을 기준으로 합본)
      const baseTab = isTabReady(tabs.get(activeTabId))
        ? tabs.get(activeTabId)
        : [...tabs.values()].find(isTabReady);
      if (baseTab) {
        appendImportedFiles(files, baseTab);
        return;
      }

      clearTimeout(_fileInfoTimer);
      fileInfo.style.display = 'block';
      fileInfo.style.opacity = '1';
      fileInfo.innerHTML = files.length > 1
        ? `<strong>${files.length}개 파일</strong> 동시 분석 중`
        : `<strong>${files[0].name}</strong> — 분석 중…`;

      const firstTab = createTab(files[0]);
      activateTab(firstTab.id);
      analyzePDF(files[0], firstTab);

      for (let i = 1; i < files.length; i++) {
        const tab = createTab(files[i]);
        analyzePDF(files[i], tab);
      }
    }

    // ── 📚 여러 파일을 정한 순서대로 한 문서(챕터 분리)로 합쳐 열기 ──────────
    // 파일마다 chapters 항목({name,start,count})을 남겨, 열린 뒤에도 어디까지가
    // 어느 파일인지 구분되고 다운로드하면 하나의 PDF로 저장된다.
    async function openMergedAsChapters(files) {
      try {
        hideError(); hideSuccess();
        showLoading(`${files.length}개 파일을 하나의 문서로 합치는 중…`);
        const mergedDoc = await PDFLib.PDFDocument.create();
        const chapters = [];
        let startPage = 1;
        for (const f of files) {
          const ab = await f.arrayBuffer();
          const src = await PDFLib.PDFDocument.load(ab.slice(0));
          const idx = src.getPageIndices();
          const copied = await mergedDoc.copyPages(src, idx);
          copied.forEach(pg => mergedDoc.addPage(pg));
          chapters.push({ name: f.name, start: startPage, count: idx.length });
          startPage += idx.length;
          await uiYield();
        }
        const bytes = await savePdfDoc(mergedDoc, { useObjectStreams: true, updateFieldAppearances: true });
        hideLoading();
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const file = {
          name: `${files[0].name.replace(/.[^.]+$/, '')}_합본.pdf`,
          size: bytes.byteLength, type: 'application/pdf',
          arrayBuffer: () => Promise.resolve(buf.slice(0)),
        };
        const tab = createTab(file);
        tab.chapters = chapters;
        activateTab(tab.id);
        await analyzePDF(file, tab);
        showSuccess(`${files.length}개 파일을 정한 순서대로 한 문서로 합쳤습니다 (총 ${startPage - 1}쪽 · 파일별 챕터 유지).
이어서 편집·흑백변환·임포징을 하고, 다운로드하면 하나의 PDF로 저장됩니다.`);
      } catch (e) {
        hideLoading();
        showError('합쳐 열기 오류: ' + (e && e.message ? e.message : String(e)));
        console.error('openMergedAsChapters 오류:', e);
      }
    }

    // ── 기존 분석본에 새 파일을 챕터로 이어붙이기 ────────────────────────────
    // 활성 분석본(baseTab)의 페이지(기존 챕터 보존)에 새로 가져온 파일들을 차례로
    // 챕터로 추가해 하나의 PDF로 합치고, 그 합본을 다시 분석한다.
    // 결과는 단일 탭이므로 다운로드 버튼으로 하나의 파일로 저장할 수 있다.
    // 기존 문서에 파일을 이어붙이는 중 — 이때는 '자동 세로 맞춤'이 끼어들면 안 된다.
    // base에는 사용자가 직접 돌려 둔 페이지가 이미 구워져 있어, 자동 맞춤이 그걸 되돌린다.
    let _appendingDocs = false;
    async function appendImportedFiles(newFiles, baseTab) {
      try {
        _appendingDocs = true;
        hideError(); hideSuccess();
        showLoading(`기존 분석본에 ${newFiles.length}개 파일을 챕터로 추가하는 중…`);

        const mergedDoc = await PDFLib.PDFDocument.create();
        const chapters  = [];          // 파일별 챕터 경계 {name, start(1-based), count}

        // 1) 기준 문서(베이스) 페이지 복사
        // ⚠ 원본 바이트(originalPdfBytes)를 쓰면 안 된다 — 지운 페이지가 되살아나고 순서·회전·
        //   빈 페이지·내부편집이 전부 사라진다(가상 프린터로 문서를 받을 때 실제로 그랬다).
        //   활성 탭이면 '지금 화면 그대로'를 굽고(흑백은 굽지 않는다), 아니면 원본으로 폴백한다.
        const useCurrent = baseTab.id === activeTabId && pageResults.filter(Boolean).length > 0
                           && typeof buildBaseOptimized === 'function';
        let baseBytes;
        if (useCurrent) {
          try { baseBytes = (await buildBaseOptimized(null, { skipBw: true })).bytes; }
          catch (e) { console.warn('현재 상태 base 생성 실패 — 원본으로 대체:', e); }
        }
        if (!baseBytes) baseBytes = baseTab.originalPdfBytes;
        const baseSrc    = await PDFLib.PDFDocument.load(baseBytes.slice(0));
        const baseIdx    = baseSrc.getPageIndices();
        const baseCopied = await mergedDoc.copyPages(baseSrc, baseIdx);
        baseCopied.forEach(p => mergedDoc.addPage(p));
        // 챕터 경계도 '지금 페이지' 기준으로 다시 잡는다 — 원본 기준 경계는 삭제 후 어긋난다
        const curChapters = useCurrent ? chapterRunsOf(pageResults.filter(Boolean), baseTab.fileName) : null;
        if (curChapters && curChapters.length) {
          curChapters.forEach(ch => chapters.push(ch));
        } else if (baseTab.chapters && baseTab.chapters.length) {
          baseTab.chapters.forEach(ch => chapters.push({ ...ch }));
        } else {
          chapters.push({ name: baseTab.fileName, start: 1, count: baseIdx.length });
        }
        let startPage = baseIdx.length + 1;

        // 2) 새로 가져온 파일들을 차례로 챕터로 추가
        for (const f of newFiles) {
          const ab     = await f.arrayBuffer();
          const src    = await PDFLib.PDFDocument.load(ab.slice(0));
          const idx    = src.getPageIndices();
          const copied = await mergedDoc.copyPages(src, idx);
          copied.forEach(p => mergedDoc.addPage(p));
          chapters.push({ name: f.name, start: startPage, count: idx.length });
          startPage += idx.length;
        }

        const bytes = await savePdfDoc(mergedDoc, { useObjectStreams: true, updateFieldAppearances: true });
        hideLoading();

        // 합본 파일명: 이미 합본이면 그 이름 유지, 아니면 베이스명 기준 "_합본.pdf"
        const mergedName = /_합본\.pdf$/i.test(baseTab.fileName)
          ? baseTab.fileName
          : `${baseTab.fileName.replace(/\.[^.]+$/, '')}_합본.pdf`;

        const buf  = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const file = {
          name: mergedName, size: bytes.byteLength, type: 'application/pdf',
          arrayBuffer: () => Promise.resolve(buf.slice(0)),
        };

        // 합본을 새 탭으로 열어 분석하고, 흡수된 베이스 탭은 닫는다
        const tab = createTab(file);
        tab.chapters = chapters;       // 분석 완료 후 페이지별 챕터 태깅에 사용
        activateTab(tab.id);
        closeTab(baseTab.id);
        await analyzePDF(file, tab);
        setTimeout(() => { _appendingDocs = false; }, 1500);   // 자동 방향 맞춤(400ms 지연) 통과 후 해제

        showSuccess(`${newFiles.length}개 파일을 챕터로 추가했습니다. 다운로드 버튼으로 하나의 PDF로 저장할 수 있습니다.`);
      } catch (e) {
        hideLoading();
        _appendingDocs = false;
        showError('파일 추가 중 오류: ' + (e && e.message ? e.message : String(e)));
        console.error('appendImportedFiles 오류:', e);
      }
    }

    // 지금 페이지 목록에서 챕터 경계를 다시 계산 — [{name, start(1-based), count}]
    // 챕터 표시가 없는 문서는 전체를 파일명 한 챕터로 본다.
    function chapterRunsOf(valid, fallbackName) {
      const runs = [];
      valid.forEach((r, i) => {
        const name = r.chapter || fallbackName || '문서';
        const last = runs[runs.length - 1];
        if (last && last.name === name) last.count++;
        else runs.push({ name, start: i + 1, count: 1 });
      });
      return runs;
    }

    // ── 💾 분석 캐시 (작업 파일 .pdfw에 실려 재분석을 없앤다) ─────────────────
    // 페이지당 분석 산출물은 {isColor, 크기, 썸네일 JPEG}뿐이라 전부 저장할 수 있다.
    // 저장할 땐 썸네일을 폭 THUMB_CACHE_W로 줄여 담고(파일 증가 최소화), 크게 볼 때만
    // 그 페이지를 원해상도로 다시 렌더한다(upgradeThumb).
    //
    // ⚠ ANALYSIS_CACHE_V는 **판정 규칙이나 썸네일 산출 규칙이 바뀌면 반드시 올린다**.
    //   안 올리면 옛 판정이 되살아나 컬러 장수(=프린터 과금)가 틀린다.
    const ANALYSIS_CACHE_V = 1;
    const THUMB_CACHE_W = 300;          // 저장용 썸네일 폭(px)
    const THUMB_CACHE_Q = 0.72;

    // 현재 탭의 분석 결과 → { meta, blob(썸네일 JPEG 이어붙임) }
    async function captureAnalysisCache(tabState) {
      const rs = (tabState && tabState.pageResults) || [];
      if (!rs.length || !tabState.originalPdfBytes) return null;
      // 원본 페이지(originalIdx) 기준으로 담는다 — 순서 변경·빈 페이지는 docState가 따로 복원한다
      const byIdx = new Map();
      rs.forEach(r => { if (r && !r.isBlank && r.originalIdx != null && !byIdx.has(r.originalIdx)) byIdx.set(r.originalIdx, r); });
      const idxs = [...byIdx.keys()].sort((a, b) => a - b);
      if (!idxs.length) return null;
      const pages = [], parts = [];
      for (const oi of idxs) {
        const r = byIdx.get(oi);
        let jpeg = null;
        try { jpeg = await shrinkThumbToJpeg(r.thumbnail, THUMB_CACHE_W, THUMB_CACHE_Q); } catch (e) { jpeg = null; }
        pages.push({
          oi, isColor: !!r.isColor,
          w: r.thumbW || 0, h: r.thumbH || 0,
          pw: r.pageWpt || 0, ph: r.pageHpt || 0,
          tlen: jpeg ? jpeg.length : 0,
        });
        if (jpeg) parts.push(jpeg);
      }
      let total = 0; parts.forEach(p => { total += p.length; });
      const blob = new Uint8Array(total);
      let p = 0; parts.forEach(b => { blob.set(b, p); p += b.length; });
      return {
        meta: { v: ANALYSIS_CACHE_V, pdfLen: tabState.originalPdfBytes.byteLength,
                thumbW: THUMB_CACHE_W, defaultPageSize: tabState.defaultPageSize || null, pages },
        blob,
      };
    }

    // blob URL 썸네일 → 축소 JPEG 바이트
    async function shrinkThumbToJpeg(src, maxW, q) {
      if (!src) return null;
      const blob = await (await fetch(src)).blob();
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxW / bmp.width);
      const cw = Math.max(1, Math.round(bmp.width * scale));
      const ch = Math.max(1, Math.round(bmp.height * scale));
      const cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      cv.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
      try { bmp.close(); } catch (e) { }
      const out = await new Promise(res => cv.toBlob(res, 'image/jpeg', q));
      if (!out) return null;
      return new Uint8Array(await out.arrayBuffer());
    }

    // 저장된 캐시를 이 PDF에 쓸 수 있는지 — 판정 규칙(v)과 원본 바이트 길이가 같아야 한다.
    // 쪽수는 여기서 따지지 않는다: 저장 당시 페이지를 지웠다면 캐시가 원본 일부만 담기는데,
    // 그때 통째로 버리면 "재저장해도 계속 재분석"이 된다 → 빠진 쪽만 따로 분석한다.
    function analysisCacheUsable(meta, pdfLen, numPages) {
      if (!meta || meta.v !== ANALYSIS_CACHE_V || meta.pdfLen !== pdfLen) return false;
      if (!Array.isArray(meta.pages) || !meta.pages.length) return false;
      const seen = new Set();
      return meta.pages.every(p => {
        if (!p || !(p.oi >= 0) || p.oi >= numPages || seen.has(p.oi)) return false;
        seen.add(p.oi); return true;
      });
    }

    // 캐시 → 원본 인덱스별 pageResults 항목 (썸네일은 blob URL로 복원). 렌더 0회.
    // 캐시에 없는 원본 페이지는 자리를 null로 남긴다(호출부에서 그 쪽만 분석한다).
    function pageResultsFromCache(meta, blob, numPages) {
      const total = numPages || meta.pages.length;
      const arr = new Array(total).fill(null);
      let off = 0;
      meta.pages.forEach(p => {
        let thumb = null;
        if (p.tlen > 0) {
          const part = blob.slice(off, off + p.tlen);
          try { thumb = URL.createObjectURL(new Blob([part], { type: 'image/jpeg' })); } catch (e) { }
        }
        off += p.tlen || 0;
        if (p.oi < total) {
          arr[p.oi] = { pageNum: p.oi + 1, originalIdx: p.oi, isColor: !!p.isColor, thumbnail: thumb,
                        thumbW: p.w, thumbH: p.h, pageWpt: p.pw, pageHpt: p.ph, thumbLow: !!thumb };
        }
      });
      return arr;
    }

    // 지금 줌 단계에서 썸네일 한 장이 화면에서 차지하는 실제 픽셀 수.
    // (THUMB_STEPS·thumbStepIdx는 아래에서 선언되지만, 이 함수는 분석이 시작된 뒤에 불린다)
    function thumbDisplayPx() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const css = (typeof THUMB_STEPS !== 'undefined' && THUMB_STEPS[thumbStepIdx]) || 160;
      return Math.round(Math.max(120, css) * dpr);
    }
    // 지금 줌에서 흐리게 보이는(=더 크게 구워야 하는) 페이지가 하나라도 있는가
    function anyThumbTooSmall() {
      const px = thumbDisplayPx();
      return (pageResults || []).some(r => r && r.thumbLow && (!r.thumbW || r.thumbW < px * 0.95));
    }

    // 크게 볼 때만 그 페이지를 원해상도로 다시 렌더해 썸네일을 교체한다(저해상 캐시 보정).
    // 같은 페이지를 두 번 굽지 않도록 진행 중 플래그를 둔다.
    const _thumbUpgrading = new Set();
    async function upgradeThumb(originalIdx) {
      const r = (pageResults || []).find(x => x && x.originalIdx === originalIdx && x.thumbLow);
      if (!r || _thumbUpgrading.has(originalIdx) || !globalPdfDoc) return false;
      _thumbUpgrading.add(originalIdx);
      try {
        const page = await globalPdfDoc.getPage(originalIdx + 1);
        const res = await analyzePageColor(page, { full: true });
        const t = await res.thumbPromise;
        if (t) {
          if (r.thumbnail && r.thumbnail.startsWith('blob:')) { try { URL.revokeObjectURL(r.thumbnail); } catch (e) { } }
          r.thumbnail = t; r.thumbW = res.thumbW; r.thumbH = res.thumbH; r.thumbLow = false;
          const el = document.querySelector(`[data-page="${r.pageNum}"]`);
          const img = el && el.querySelector('.page-thumbnail');
          if (img) img.src = t;
        }
        return !!t;
      } catch (e) { return false; }
      finally { _thumbUpgrading.delete(originalIdx); }
    }
    // 화면에 보이는 저해상 썸네일만 순차 보정 — 줌이 캐시 폭을 넘겼을 때만 돈다.
    let _thumbUpgQueued = false;
    function scheduleThumbUpgrade() {
      if (_thumbUpgQueued) return;
      _thumbUpgQueued = true;
      setTimeout(async () => {
        _thumbUpgQueued = false;
        if (!anyThumbTooSmall()) return;
        const needPx = thumbDisplayPx();
        const els = [...document.querySelectorAll('#pagesGrid [data-page], #previewGrid [data-page]')];
        const vis = els.filter(el => {
          const b = el.getBoundingClientRect();
          return b.bottom > -200 && b.top < window.innerHeight + 200;
        }).map(el => +el.dataset.page);
        for (const pn of vis) {
          const r = (pageResults || []).find(x => x && x.pageNum === pn && x.thumbLow);
          if (r && (!r.thumbW || r.thumbW < needPx * 0.95)) await upgradeThumb(r.originalIdx);
        }
      }, 250);
    }
    // 줌이 저장 폭을 넘어서면(=흐릿하게 보이기 시작하면) 그때부터 보이는 페이지를 원해상도로
    window.addEventListener('scroll', () => { scheduleThumbUpgrade(); }, true);

    // 합본 탭이면 각 페이지에 원본 파일명(챕터) 태깅 — 그리드·사이드바 구분,
    // 그리고 '방향 자동 맞춤'의 기준 그룹으로 쓰인다(합본에서 남의 원고를 눕히지 않도록).
    function tagChapters(tabState) {
      if (!tabState || !tabState.chapters || !tabState.chapters.length) return;
      tabState.chapters.forEach(ch => {
        for (let i = ch.start - 1; i < ch.start - 1 + ch.count; i++) {
          if (tabState.pageResults[i]) tabState.pageResults[i].chapter = ch.name;
        }
      });
    }

    // ── ⚠ '화면은 흑백인데 색공간이 컬러'인 원고 감지 ─────────────────────────
    // 눈으로도 분석기로도 흑백인데 프린터가 컬러로 세는 가장 흔한 원인: 회색을 DeviceGray가
    // 아니라 RGB/CMYK 값으로 칠한 원고(예: '0.2 0.2 0.2 rg'). 기기는 RGB→CMYK 변환에서
    // 미세한 C·M·Y를 만들어 그 페이지를 컬러로 과금한다. 잉크 정규화(기본 켬)로 적용해
    // 저장하면 DeviceGray('0.2 g')로 바뀌어 해결되므로, 원본을 그대로 보내지 않도록 알린다.
    // 원본 바이트의 Flate 스트림만 훑어 색 지정 연산자(rg/RG/k/K)를 찾는다 — 한 개만 찾으면 중단.
    const _COLOROP_RE = /(?<![\w\/.#-])(?:[\d.]+\s+){3}(rg|RG)(?=[\s\]\/<>()]|$)|(?<![\w\/.#-])(?:[\d.]+\s+){4}(k|K)(?=[\s\]\/<>()]|$)/;
    function docPaintsInColorSpace(bytes, budgetMs) {
      try {
        if (!bytes || !bytes.length || bytes.length > 96 * 1024 * 1024) return false;
        if (typeof pako === 'undefined') return false;
        const t0 = Date.now();
        const dec = new TextDecoder('latin1');
        const hay = dec.decode(bytes);
        let i = 0, scanned = 0;
        for (;;) {
          const s = hay.indexOf('stream', i);
          if (s < 0) break;
          let b = s + 6;
          if (hay.charCodeAt(b) === 13) b++;
          if (hay.charCodeAt(b) === 10) b++;
          const e = hay.indexOf('endstream', b);
          if (e < 0) break;
          i = e + 9;
          if (e - b < 8 || e - b > 8 * 1024 * 1024) continue;
          // 스트림 끝의 개행을 빼고 넘긴다 — 그대로 넣으면 pako가 통째로 실패한다(node zlib는 통과)
          let e2 = e;
          while (e2 > b && (bytes[e2 - 1] === 10 || bytes[e2 - 1] === 13)) e2--;
          let out = null;
          try { out = pako.inflate(bytes.subarray(b, e2)); } catch (err) { out = null; }
          // /Length 손상 등으로 실패하면 앱의 관대한 해제기로 한 번 더 (있을 때만)
          if ((!out || !out.length) && typeof inflateLenient === 'function') {
            try { out = inflateLenient(bytes.subarray(b, e2)); } catch (err) { out = null; }
          }
          // 압축이 안 된 스트림(일부 생성기·pdf-lib 기본)은 그대로 읽는다
          const txt = (out && out.length) ? dec.decode(out) : hay.slice(b, e);
          if (txt && _COLOROP_RE.test(txt)) return true;
          if (++scanned > 2000) break;
          if ((Date.now() - t0) > (budgetMs || 1500)) break;   // 큰 문서에서 분석을 붙잡지 않는다
        }
      } catch (e) { console.warn('색공간 훑기 실패(무시):', e); }
      return false;
    }
    // 분석 결과 안내에 덧붙일 경고 (해당 없으면 빈 문자열)
    const RGB_GRAY_MSG = '⚠ 화면은 흑백이지만 회색을 RGB/CMYK 값으로 칠한 원고입니다 — 이 파일을 그대로 보내면 프린터가 컬러 장수로 셉니다.';
    const RGB_GRAY_FIX = "'✔ 적용'(잉크 정규화 켠 상태)으로 저장한 파일을 보내면 DeviceGray로 바뀌어 프린터도 흑백으로 셉니다.";
    function rgbGrayWarning(tabState) {
      try {
        if (!tabState || tabState.colorCount) return '';           // 컬러 페이지가 이미 있으면 안내 불필요
        if (!docPaintsInColorSpace(tabState.originalPdfBytes)) return '';
        return '\n' + RGB_GRAY_MSG + '\n   ' + RGB_GRAY_FIX;
      } catch (e) { return ''; }
    }
    // ⚠ 잉크 정규화를 끈 채 저장하면 '흑백' 페이지가 RGB/CMYK로 칠해진 채 나간다 —
    // 프린터는 그 쪽들도 컬러로 셈한다(실제로 흑백 10쪽이 컬러로 과금된 적 있음).
    // 반환값 = 그렇게 나갈 흑백 페이지 수 (0이면 문제 없음).
    function inkNormRiskCount() {
      try {
        if (processingOptions.inkNorm) return 0;                    // 켜져 있으면 DeviceGray로 나간다
        if (!originalPdfBytes || !pageResults) return 0;
        const bw = pageResults.filter(r => r && !r.isColor).length;
        if (!bw) return 0;
        if (_rgbGrayCache.bytes !== originalPdfBytes) {
          _rgbGrayCache = { bytes: originalPdfBytes, val: docPaintsInColorSpace(originalPdfBytes) };
        }
        return _rgbGrayCache.val ? bw : 0;
      } catch (e) { return 0; }
    }
    function inkNormRiskNote() {
      const n = inkNormRiskCount();
      if (!n) return '';
      return `\n⚠ 잉크 정규화가 꺼져 있습니다 — 흑백 ${n}쪽이 RGB/CMYK 색으로 칠해진 채 저장되어`
           + ` 프린터가 컬러로 셉니다. ⛭ 잉크 정규화를 켜고 '✔ 적용'을 다시 누르세요.`;
    }

    // 분석 결과 패널에 남기는 경고 — 토스트는 다른 안내(지난 작업 기록 등)에 덮이기 때문.
    // 스트림을 훑는 비용이 있어 같은 문서에서는 한 번만 판정하고 캐시한다.
    let _rgbGrayCache = { bytes: null, val: false };
    function rgbGrayWarningHtml() {
      try {
        if (!originalPdfBytes || !pageResults) return '';
        if (pageResults.filter(r => r && r.isColor).length) return '';   // 이미 컬러 페이지가 있으면 불필요
        if (_rgbGrayCache.bytes !== originalPdfBytes) {
          _rgbGrayCache = { bytes: originalPdfBytes, val: docPaintsInColorSpace(originalPdfBytes) };
        }
        if (!_rgbGrayCache.val) return '';
        return '<br><span class="rgb-gray-warn">' + RGB_GRAY_MSG + '<br>' + RGB_GRAY_FIX + '</span>';
      } catch (e) { return ''; }
    }
    // ── PDF 분석 (병렬, 탭별 독립 실행) ──────────────────────────────────────
    // opts.cache = { meta, blob } 이면 페이지 렌더를 통째로 건너뛰고 캐시를 되씌운다.
    async function analyzePDF(file, tabState, opts) {
      const isActive = () => activeTabId === tabState.id;

      try {
        const arrayBuffer = await file.arrayBuffer();
        tabState.originalPdfBytes = new Uint8Array(arrayBuffer.slice(0));
        tabState.fileSize = arrayBuffer.byteLength;
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        tabState.pdfDoc = pdf;
        if (isActive()) { originalPdfBytes = tabState.originalPdfBytes; globalPdfDoc = pdf; }

        // 빈 페이지 삽입·문서 크기 표시에 사용할 1페이지 크기 저장 (pt 단위)
        try {
          const fp = await pdf.getPage(1);
          const vp = fp.getViewport({ scale: 1 });
          tabState.defaultPageSize = [vp.width, vp.height];
        } catch(e) {}
        if (isActive()) updateFileInfo(tabState); // 실제 페이지 크기 표시

        const totalPages = pdf.numPages;
        // 인덱스 순서 보장을 위해 배열 미리 확장
        while (tabState.pageResults.length < totalPages) tabState.pageResults.push(null);

        let colorCount = 0, bwCount = 0, done = 0;

        // 💾 작업 파일에 실린 분석 캐시가 이 PDF와 정확히 맞으면 페이지 렌더를 통째로 건너뛴다.
        // (버전·바이트길이·쪽수가 하나라도 다르면 아래 정상 분석으로 내려간다)
        const cache = opts && opts.cache;
        if (cache && analysisCacheUsable(cache.meta, tabState.originalPdfBytes.byteLength, totalPages)) {
          const rs = pageResultsFromCache(cache.meta, cache.blob, totalPages);
          // 캐시에 없는 쪽(저장 당시 지웠던 페이지 등)만 지금 분석해 메운다
          const missing = [];
          rs.forEach((r, i) => { if (!r) missing.push(i); });
          if (missing.length) {
            if (isActive()) updateProgress(0);
            let mdone = 0;
            const MC = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 4));
            let mi = 0;
            await Promise.all(Array.from({ length: MC }, async () => {
              while (mi < missing.length) {
                const i = missing[mi++];
                try {
                  const page = await pdf.getPage(i + 1);
                  const res = await analyzePageColor(page);
                  const t = await res.thumbPromise;
                  rs[i] = { pageNum: i + 1, originalIdx: i, isColor: res.isColor, thumbnail: t,
                            thumbW: res.thumbW, thumbH: res.thumbH, thumbLow: !!res.low,
                            pageWpt: res.pageWpt, pageHpt: res.pageHpt };
                } catch (e) {
                  rs[i] = { pageNum: i + 1, originalIdx: i, isColor: false, thumbnail: null };
                }
                if (isActive()) updateProgress(Math.round(++mdone / missing.length * 100));
              }
            }));
          }
          tabState.pageResults = rs;
          tabState.analysisCacheMissing = missing.length;
          tagChapters(tabState);
          rs.forEach(r => { if (r.isColor) colorCount++; else bwCount++; });
          tabState.colorCount = colorCount;
          tabState.bwCount = bwCount;
          tabState.status = 'ready';
          tabState.progress = 100;
          tabState.analysisFromCache = true;   // 안내 문구·구버전 재저장 제안 판단용
          if (isActive()) {
            pageResults = tabState.pageResults;
            displayResults(totalPages, colorCount, bwCount, tabState.pageResults);
          } else {
            tabState.quoteItems.push(...buildQuoteItems(colorCount, bwCount));
          }
          if (isActive()) { hideLoading(); progressBar.style.display = 'none'; }
          renderTabBar();
          return;
        }

        // 페이지당 분석 동시 처리 — pdf.js 워커는 '문서당 1개'라 한 문서로는 렌더가
        // 직렬화된다(동시성만 올려도 실병렬 X). 같은 바이트로 보조 문서를 2~3개 더
        // 열면 각자 워커를 가져 페이지 렌더가 실제로 병렬화된다(코어 활용 극대화).
        // 메모리 보호: 대용량 파일(>96MB)이나 짧은 문서(<8p)는 보조 문서 생략.
        // 모바일(WebView)은 메모리가 훨씬 빡빡 — 보조 문서 상한 32MB·동시성 4로 제한.
        const isMobile = !!window.__MOBILE__;
        const CONCURRENCY = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, isMobile ? 4 : 8));
        const extraDocs = [];
        const auxLimit = (isMobile ? 32 : 96) * 1024 * 1024;
        if (totalPages >= 8 && tabState.originalPdfBytes.byteLength < auxLimit) {
          const want = Math.min(3, Math.max(0, Math.floor(CONCURRENCY / 2) - 1));
          for (let e = 0; e < want; e++) {
            try {
              extraDocs.push(await pdfjsLib.getDocument({ data: tabState.originalPdfBytes.slice(0) }).promise);
            } catch (err) { break; }
          }
        }
        const docs = [pdf, ...extraDocs];
        let qi = 0;
        const thumbJobs = [];   // 썸네일 JPEG 인코딩은 렌더와 병행 — 마지막에 일괄 대기
        const tasks = Array.from({ length: totalPages }, (_, i) => async (doc) => {
          const pn   = i + 1;
          const page = await doc.getPage(pn);
          const res  = await analyzePageColor(page);
          const entry = { pageNum: pn, originalIdx: pn - 1, isColor: res.isColor, thumbnail: null,
                          thumbW: res.thumbW, thumbH: res.thumbH, thumbLow: !!res.low,
                          pageWpt: res.pageWpt, pageHpt: res.pageHpt };
          tabState.pageResults[i] = entry;
          thumbJobs.push(res.thumbPromise.then(t => { entry.thumbnail = t; }));
          if (res.isColor) colorCount++; else bwCount++;
          tabState.progress = Math.round(++done / totalPages * 100);
          if (isActive()) updateProgress(tabState.progress);
        });
        // 워커 wi는 docs[wi % docs.length] 문서 담당 — 문서별 부하 균등 분산
        const runWorker = async (wi) => {
          const doc = docs[wi % docs.length];
          while (qi < tasks.length) await tasks[qi++](doc);
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, (_, wi) => runWorker(wi)));
        await Promise.all(thumbJobs);   // 남은 썸네일 인코딩 완료 대기
        // 보조 문서 즉시 해제 (메인 pdf만 상주)
        for (const d of extraDocs) { try { await d.destroy(); } catch (e) {} }

        tabState.colorCount = colorCount;
        tabState.bwCount    = bwCount;
        tabState.status     = 'ready';

        tagChapters(tabState);

        if (isActive()) {
          pageResults = tabState.pageResults;
          displayResults(totalPages, colorCount, bwCount, tabState.pageResults);
          showSuccess('PDF 분석이 완료되었습니다!' + rgbGrayWarning(tabState));
        } else {
          // 비활성(백그라운드) 탭: DOM은 그대로 두고 quoteItems만 채워, 나중에 이 탭으로
          // 전환했을 때 renderTabUI가 견적서를 바로 표시할 수 있게 한다.
          tabState.quoteItems.push(...buildQuoteItems(colorCount, bwCount));
        }

      } catch (err) {
        tabState.status   = 'error';
        tabState.errorMsg = err.message || String(err);
        if (isActive()) { hideLoading(); progressBar.style.display = 'none'; showError('PDF 분석 중 오류: ' + tabState.errorMsg); }
      } finally {
        if (isActive()) { hideLoading(); progressBar.style.display = 'none'; }
        renderTabBar();
      }
    }

    // ── 썸네일 JPEG 인코딩 동시 상한 ────────────────────────────────────────
    // toBlob은 브라우저가 알아서 백그라운드에서 굽지만, **끝날 때까지 원본 캔버스가
    // 메모리에 살아 있다**(A4 한 장 ≈ 1.3MB). 상한이 없으면 2000장 넘게 쌓여
    // GC 압박으로 뒤쪽 페이지가 점점 느려진다(실측: 인코딩 대기가 장당 1.1초까지 밀림).
    // 자리가 없으면 렌더 레인이 여기서 잠깐 쉰다 — 총 시간은 그대로, 메모리만 평평해진다.
    const THUMB_MAX = Math.max(4, Math.min((navigator.hardwareConcurrency || 4) * 2, 32));
    let _thumbBusy = 0;
    const _thumbWait = [];
    function thumbSlot() {
      if (_thumbBusy < THUMB_MAX) { _thumbBusy++; return Promise.resolve(); }
      return new Promise(res => _thumbWait.push(res));
    }
    function thumbRelease() {
      const next = _thumbWait.shift();
      if (next) next();      // 자리를 기다리던 쪽에 그대로 넘긴다 (_thumbBusy 유지)
      else _thumbBusy--;
    }

    async function analyzePageColor(page, opts) {
      try {
        // 페이지 실제 크기(pt) — 표시 스케일 산출 + 혼합문서 크기 판별에 사용
        const vp1 = page.getViewport({ scale: 1 });
        // 썸네일 화질: 화면 DPI(Windows 125~200% 배율 등)와 표시폭에 맞춰
        // '딱 필요한 만큼만' 렌더한다. (DPI 영향은 1.5까지만 반영해 폭주 차단)
        // ⚠ 해상도는 컬러/흑백 판정에 영향을 준다 — 작게 그리면 작은 컬러 요소가 사라진다.
        //    그래서 저해상 경로는 아래에서 **전 픽셀을 훑는다**(sampleStep=1).
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        // ⚡ 2단계 썸네일: 예전에는 모든 쪽을 **최대 줌 화질**(480px)로 미리 구웠다.
        // 실제로 최대 줌까지 키우는 쪽은 몇 장뿐인데 수천 쪽을 그 화질로 굽느라 분석
        // 시간의 상당 부분을 썼다(실측 2403쪽·87MB: 23.7초 → 19.8초).
        // 이제 **지금 줌에서 화면에 보이는 크기**로만 굽고, 더 키우면 그때 보이는 쪽만
        // 원해상도로 다시 굽는다(upgradeThumb). 눈에 보이는 화질은 그대로다.
        // opts.full = 처음부터 최대 화질 (확대 보정·썸네일 재생성 경로)
        const full = !!(opts && opts.full);
        const fullScale = Math.max(0.5, Math.min((480 * dpr) / vp1.width, 0.8));
        let rScale = fullScale;
        // ⚠ 하한 = 원해상도의 75%. 더 줄이면 **이미지가 많은 원고에서 오히려 느려진다**
        // — 큰 그림을 많이 축소할 때 브라우저가 더 비싼 리샘플링 경로를 탄다
        // (실측 436쪽·98MB 법령: 240px 97초 vs 358px 84초 = 원해상도와 동일).
        if (!full) rScale = Math.max(fullScale * 0.75, Math.min(thumbDisplayPx() / vp1.width, fullScale));
        const vp = page.getViewport({ scale: rScale });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width  = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        // 색상 분석
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        // pdf.js 워커 쪽 페이지 리소스 즉시 해제 — 대형 문서에서 워커 메모리 누적으로
        // 뒤 페이지 렌더가 점점 느려지는 것을 방지 (캔버스 픽셀은 이미 복사됨)
        try { page.cleanup(); } catch (e) {}
        const totalPixels = data.length >> 2;
        // 컬러 판정은 '중성이 아닌 픽셀이 하나라도 있으면 컬러'다. 썸네일을 작게 굽게 되면서
        // 픽셀 수가 줄었으므로, 성긴 표본(15k)을 쓰면 작은 컬러 요소(로고·도장 한 점)를
        // 놓칠 수 있다(실측: 2403쪽에서 컬러 1929 → 1927쪽으로 2쪽 어긋남 = 과금 오차).
        // → 저해상 렌더에서는 **모든 픽셀을 훑는다**. 픽셀이 적어 비용이 오히려 작다.
        const sampleStep  = full ? Math.max(1, totalPixels / 15000 | 0) : 1;
        let gray = 0;
        for (let i = 0; i < data.length; i += sampleStep * 4) {
          const r = data[i], g = data[i+1], b = data[i+2];
          if (Math.abs(r-g) <= 1 && Math.abs(g-b) <= 1 && Math.abs(r-b) <= 1) gray++;
        }
        const sampled = Math.ceil(totalPixels / sampleStep);
        const isColor = gray / sampled < 0.999999;

        // 썸네일: 같은 캔버스에서 비동기 인코딩(toBlob)→objectURL.
        // 완료를 여기서 기다리지 않고 promise로 반환 — 인코딩이 도는 동안 같은 워커
        // 레인이 다음 페이지 렌더를 시작할 수 있어 렌더·인코딩이 겹쳐 진행된다.
        await thumbSlot();
        const thumbPromise = new Promise(res => {
          canvas.toBlob(b => { thumbRelease(); res(b ? URL.createObjectURL(b) : null); }, 'image/jpeg', 0.85);
        });
        // vp1(실제 페이지 크기 pt)은 위에서 산출함. thumbW/H는 캔버스 실제 픽셀.
        return { isColor, thumbPromise, thumbW: canvas.width, thumbH: canvas.height,
                 // low = 더 크게 볼 때 다시 구울 여지가 있다(원해상도보다 작게 구웠다)
                 low: rScale < fullScale - 0.001,
                 pageWpt: vp1.width, pageHpt: vp1.height };
      } catch {
        return { isColor: false, thumbPromise: Promise.resolve(null) };
      }
    }

    function displayResults(totalPages, colorCount, grayscaleCount, results) {
      totalPagesEl.textContent     = totalPages;
      colorPagesEl.textContent     = colorCount;
      grayscalePagesEl.textContent = grayscaleCount;
      colorPercentEl.textContent   = Math.round((colorCount / totalPages) * 100) + '%';

      renderAllPages(results);

      const colorList = results.filter(p => p && p.isColor).map(p => p.pageNum);
      const grayList  = results.filter(p => p && !p.isColor).map(p => p.pageNum);
      rangeSummary.innerHTML = `<strong>컬러 페이지:</strong> ${formatRanges(colorList)}<br><strong>흑백 페이지:</strong> ${formatRanges(grayList)}` + rgbGrayWarningHtml();

      resultsSection.style.display = 'block';
      setThumbZoomWidgetVisible(true);
      showSidebar(true);
      applyThumbFontStep(thumbStepIdx);
      setTimeout(initSidebarObserver, 200);
      updateSelectedCount();
      initQuoteSection(colorCount, grayscaleCount);
      updateDownloadBtn();
      if (activeTabId && tabs.has(activeTabId)) updateFileInfo(tabs.get(activeTabId));
      // 분석 완료 → 유휴 시간에 잉크 정규화 변환을 미리 수행(적용 즉시화)
      setTimeout(() => { if (typeof prewarmInkNorm === 'function') prewarmInkNorm(); }, 1200);
      // 🕓 같은 문서의 지난 작업이 기록되어 있으면 안내 (분석 성공 메시지 뒤에 표시되게 지연)
      // 📐 방향이 다른 페이지(세로 원고 속 가로 원고) 자동 맞춤 — 안내보다 먼저 처리한다
      setTimeout(() => { if (typeof maybeAutoOrientAfterAnalyze === 'function') maybeAutoOrientAfterAnalyze(); }, 400);
      setTimeout(() => { if (typeof notifyWorkHistory === 'function') notifyWorkHistory(); }, 600);
    }

    // ── 썸네일 흑백 표시 — CSS filter (GPU 가속, 픽셀 연산 없음) ─────────────
    function convertImgToGrayscale(img) {
      if (img) img.style.filter = 'grayscale(1)';
    }

    function applyGrayscaleToEl(el, pageNum, sbEl) {
      // 흑백 미리보기는 '⬛ 흑백변환' 옵션이 켜져 있을 때만 — 옵션이 꺼져 있으면
      // 선택은 회전·복제·목차 지정용이므로 썸네일 색을 건드리지 않는다(선택 테두리만).
      if (!processingOptions.bw) return;
      const img = el.querySelector('.page-thumbnail');
      if (img) img.style.filter = 'grayscale(1)';
      const span = el.querySelector('.page-type-inline');
      if (span && !span.dataset.orig) span.dataset.orig = span.textContent;
      if (span) span.textContent = '흑백';
      // 사이드바 동기 (sbEl 미전달 시 DOM 탐색)
      const sb = sbEl ?? sidebar.querySelector(`[data-sb-page="${pageNum}"]`);
      if (sb) { const sbImg = sb.querySelector('img'); if (sbImg) sbImg.style.filter = 'grayscale(1)'; }
    }
    // 흑백변환 옵션 토글 시 현재 선택 페이지들의 흑백 미리보기를 일괄 갱신
    function syncSelectionVisuals() {
      selectedPages.forEach(pn => {
        const el = document.querySelector(`[data-page="${pn}"]`);
        if (!el) return;
        if (processingOptions.bw) applyGrayscaleToEl(el, pn);
        else restoreThumbnailEl(el, pn);
      });
    }

    function restoreThumbnailEl(el, pageNum, sbEl) {
      // 적용 확정된 흑백 페이지는 선택 여부와 무관하게 회색 표시 유지
      const rr = pageResults.find(x => x && x.pageNum === pageNum);
      if (rr && rr.appliedBw) return;
      const img = el.querySelector('.page-thumbnail');
      if (img) img.style.filter = '';
      const span = el.querySelector('.page-type-inline');
      if (span && span.dataset.orig) { span.textContent = span.dataset.orig; delete span.dataset.orig; }
      // 사이드바 동기
      const sb = sbEl ?? sidebar.querySelector(`[data-sb-page="${pageNum}"]`);
      if (sb) { const sbImg = sb.querySelector('img'); if (sbImg) sbImg.style.filter = ''; }
    }

    // ── 페이지 선택 ──────────────────────────────────────────────────────────
    let lastClickedIdx = null; // Shift+클릭 범위 기준점

    function selectPageEl(pageNum, element, sbEl) {
      selectedPages.add(pageNum);
      element.classList.add('selected');
      const sb = sbEl ?? sidebar.querySelector(`[data-sb-page="${pageNum}"]`);
      applyGrayscaleToEl(element, pageNum, sb);
      if (sb) sb.classList.add('sb-selected');
    }
    function deselectPageEl(pageNum, element, sbEl) {
      selectedPages.delete(pageNum);
      element.classList.remove('selected');
      const sb = sbEl ?? sidebar.querySelector(`[data-sb-page="${pageNum}"]`);
      restoreThumbnailEl(element, pageNum, sb);
      if (sb) sb.classList.remove('sb-selected');
    }

    function togglePageSelection(pageNum, element, event) {
      const visiblePages = pageResults.filter(Boolean);
      const idx = visiblePages.findIndex(r => r.pageNum === pageNum);

      if (event && event.shiftKey && lastClickedIdx !== null) {
        // Shift+클릭: lastClickedIdx ~ idx 범위 모두 선택
        const from = Math.min(lastClickedIdx, idx);
        const to   = Math.max(lastClickedIdx, idx);
        for (let i = from; i <= to; i++) {
          const r = visiblePages[i];
          if (!r) continue;
          const el = document.querySelector(`[data-page="${r.pageNum}"]`);
          if (el) selectPageEl(r.pageNum, el);
        }
      } else if (event && event.ctrlKey) {
        // Ctrl+클릭: 개별 토글
        if (selectedPages.has(pageNum)) deselectPageEl(pageNum, element);
        else selectPageEl(pageNum, element);
        lastClickedIdx = idx;
      } else {
        // 일반 클릭: 기존 토글
        if (selectedPages.has(pageNum)) deselectPageEl(pageNum, element);
        else selectPageEl(pageNum, element);
        lastClickedIdx = idx;
      }
      updateSelectedCount();
    }

    // 요소 Map 한 번에 수집 → 루프 내 querySelector 제거 (O(n²) → O(n))
    function buildElMaps() {
      const pageElMap = new Map(), sbElMap = new Map();
      document.querySelectorAll('.page-item[data-page]')
        .forEach(el => pageElMap.set(+el.dataset.page, el));
      sidebar.querySelectorAll('[data-sb-page]')
        .forEach(el => sbElMap.set(+el.dataset.sbPage, el));
      return { pageElMap, sbElMap };
    }

    function selectAllColor() {
      deselectAll();
      const { pageElMap, sbElMap } = buildElMaps();
      pageResults.forEach(r => {
        if (!r || !r.isColor) return;
        const el = pageElMap.get(r.pageNum);
        if (el) selectPageEl(r.pageNum, el, sbElMap.get(r.pageNum));
      });
      updateSelectedCount();
    }

    function selectAll() {
      const { pageElMap, sbElMap } = buildElMaps();
      pageResults.forEach(r => {
        if (!r || selectedPages.has(r.pageNum)) return;
        const el = pageElMap.get(r.pageNum);
        if (el) selectPageEl(r.pageNum, el, sbElMap.get(r.pageNum));
      });
      updateSelectedCount();
    }

    function deselectAll() {
      if (!selectedPages.size) return;   // 이미 비어 있으면 아무 것도 무효화하지 않음
      const isCommitted = pn => { const r = pageResults.find(x => x && x.pageNum === pn); return !!(r && r.appliedBw); };
      selectedPages.clear();
      document.querySelectorAll('.page-item.selected').forEach(el => {
        el.classList.remove('selected');
        if (isCommitted(parseInt(el.dataset.page, 10))) return;   // 확정 흑백은 회색 유지
        const img = el.querySelector('.page-thumbnail');
        if (img) img.style.filter = '';
        const span = el.querySelector('.page-type-inline');
        if (span && span.dataset.orig) { span.textContent = span.dataset.orig; delete span.dataset.orig; }
      });
      sidebar.querySelectorAll('.sb-item.sb-selected').forEach(el => {
        el.classList.remove('sb-selected');
        if (isCommitted(parseInt(el.dataset.sbPage, 10))) return;
        const sbImg = el.querySelector('img');
        if (sbImg) sbImg.style.filter = '';
      });
      updateSelectedCount();
    }
    // 적용 확정 후 선택만 조용히 해제 — 결과(processedPdfBytes)·캐시·회색 표시는 유지
    function commitClearSelection() {
      selectedPages.clear();
      document.querySelectorAll('.page-item.selected').forEach(el => el.classList.remove('selected'));
      sidebar.querySelectorAll('.sb-item.sb-selected').forEach(el => el.classList.remove('sb-selected'));
      selectedCountEl.textContent = '0개 선택됨';
      syncSidebarPanel();
      if (typeof refreshPreviewMarks === 'function') refreshPreviewMarks();
    }

    function updateSelectedCount() {
      const count = selectedPages.size;
      selectedCountEl.textContent = `${count}개 선택됨`;
      invalidateProcessed();
      // 선택한 페이지의 흑백변환을 미리 구워 둔다 — '적용'에서 기다리는 시간을 없앤다
      if (processingOptions.bw && count > 0) scheduleBwPrewarm();
      syncSidebarPanel();
      if (typeof refreshPreviewMarks === 'function') refreshPreviewMarks();
      // 미리보기가 켜져 있으면 선택 변경을 실제 흑백변환으로 즉시 반영(캐시로 빠름)
      if (typeof previewVisible === 'function' && previewVisible()) scheduleLivePreview();
    }

    function refreshResults() {
      if (!pageResults.length) return;
      // 편집 적용 결과가 표시 중이면 결과 PDF를 다시 분석해 컬러/흑백 수 + 견적서 갱신
      const pv = document.getElementById('previewSection');
      if (pv && pv.style.display !== 'none' && processedPdfBytes) {
        renderProcessedPreview(processedPdfBytes, { live: false }).then(() => {
          const c = parseInt(colorPagesEl.textContent) || 0;
          const g = parseInt(grayscalePagesEl.textContent) || 0;
          updateQuoteCounts(c, g);
        });
        return;
      }
      let newColor = 0, newGray = 0;
      const colorPages = [], grayPages = [];
      pageResults.forEach(r => {
        if (!r) return;
        // 선택 페이지를 흑백으로 세는 것은 '흑백변환' 옵션이 켜진 경우만
        if (r.isColor && !r.appliedBw && !(processingOptions.bw && selectedPages.has(r.pageNum))) { newColor++; colorPages.push(r.pageNum); }
        else { newGray++; grayPages.push(r.pageNum); }
      });
      colorPagesEl.textContent = newColor;
      grayscalePagesEl.textContent = newGray;
      colorPercentEl.textContent = Math.round(newColor / pageResults.filter(Boolean).length * 100) + '%';
      rangeSummary.innerHTML = `<strong>컬러 페이지:</strong> ${formatRanges(colorPages)}<br><strong>흑백 페이지:</strong> ${formatRanges(grayPages)}` + rgbGrayWarningHtml();
      initQuoteSection(newColor, newGray);
      syncSidebarPanel();
    }

    // ── 썸네일 크기 조절 ─────────────────────────────────────────────────────
    // 50% ~ 300%, 10% 단위 (기준 100% = 160px)
    const THUMB_BASE  = 160;
    const THUMB_STEPS = Array.from({ length: 26 }, (_, i) => Math.round(THUMB_BASE * (50 + i * 10) / 100));
    // [80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 272, 288, 304, 320, 336, 352, 368, 384, 400, 416, 432, 448, 464, 480]
    let thumbStepIdx = 5; // 100% (index 5: 50+5*10=100%)

    function thumbFontStep(idx) {
      if (idx <= 2)  return 1;
      if (idx <= 4)  return 2;
      if (idx <= 6)  return 3;
      if (idx <= 9)  return 4;
      if (idx <= 12) return 5;
      if (idx <= 16) return 6;
      if (idx <= 20) return 7;
      return 8;
    }
    function applyThumbFontStep(idx) {
      const grid = document.getElementById('pagesGrid');
      for (let i = 1; i <= 8; i++) grid.classList.remove('thumb-fs-' + i);
      grid.classList.add('thumb-fs-' + thumbFontStep(idx));
    }

    function changeThumbZoom(dir) {
      // 📖 펼침 모드에서는 줌 조작이 '펼침 크기(%)'를 조절한다 (50~200%, 10% 단계)
      const pgSpread = document.getElementById('previewGrid');
      if (pgSpread && pgSpread.classList.contains('pv-spread') && typeof changeSpreadZoom === 'function') {
        changeSpreadZoom(dir);
        return;
      }
      const next = thumbStepIdx + dir;
      if (next < 0 || next >= THUMB_STEPS.length) return;
      thumbStepIdx = next;
      const px  = THUMB_STEPS[thumbStepIdx];
      const pct = 50 + thumbStepIdx * 10;
      document.getElementById('pagesGrid').style.setProperty('--thumb-size', px + 'px');
      // 편집 작업공간·적용 결과 미리보기 그리드도 같은 줌을 공유
      const pvGrid = document.getElementById('previewGrid');
      if (pvGrid) pvGrid.style.setProperty('--thumb-size', px + 'px');
      document.getElementById('zoomPct').textContent = pct + '%';
      document.getElementById('zoomOutBtn').disabled = thumbStepIdx === 0;
      document.getElementById('zoomInBtn').disabled  = thumbStepIdx === THUMB_STEPS.length - 1;
      applyThumbFontStep(thumbStepIdx);
      // 지금 줌에서 흐리게 보이는 쪽(분석 때 작게 구운 쪽·작업 파일의 저해상 썸네일)을
      // 화면에 보이는 것부터 원해상도로 교체한다.
      if (dir > 0) scheduleThumbUpgrade();
      // 편집 모드 표본 미리보기: 줌 배율에 맞는 해상도로 다시 렌더 + 보이는 범위 재계산(스크롤 핸들러)
      if (document.body.classList.contains('edit-fullscreen') && typeof scheduleLivePreview === 'function') scheduleLivePreview();
    }

    function setThumbZoomWidgetVisible(visible) {
      document.getElementById('thumbZoomWidget').style.display = visible ? 'flex' : 'none';
    }

    // ── 단축키 ───────────────────────────────────────────────────────────────
    // Ctrl 조합: [ 축소 / ] 확대 / Z 실행취소 / Y·Shift+Z 다시실행
    document.addEventListener('keydown', e => {
      if (!e.ctrlKey) return;
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
      const hasTextSel = (window.getSelection() + '').length > 0;
      if (e.key === '[' || e.key === 'BracketLeft')  { e.preventDefault(); changeThumbZoom(-1); }
      else if (e.key === ']' || e.key === 'BracketRight') { e.preventDefault(); changeThumbZoom(+1); }
      else if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) { e.preventDefault(); redoEdit(); }
      else if (e.key === 'z' || e.key === 'Z')        { e.preventDefault(); undoEdit(); }
      else if (e.key === 'y' || e.key === 'Y')        { e.preventDefault(); redoEdit(); }
      // 페이지 클립보드 — 입력창 포커스·텍스트 선택 중엔 브라우저 기본 복사/붙여넣기 우선
      else if ((e.key === 'c' || e.key === 'C') && !inField && !hasTextSel && pageResults.length) { e.preventDefault(); copyPagesToClipboard(); }
      else if ((e.key === 'x' || e.key === 'X') && !inField && !hasTextSel && pageResults.length) { e.preventDefault(); cutPagesToClipboard(); }
      else if ((e.key === 'v' || e.key === 'V') && !inField && pageResults.length)                { e.preventDefault(); pastePagesFromClipboard(); }
    });

    // ── ⟳ 앱 강제 새로고침 (Force Reload) ────────────────────────────────────
    // 화면·상태가 꼬였을 때 앱을 껐다 켜지 않고 렌더러를 캐시 무시로 다시 읽는다.
    // 열려 있던 문서·편집 내용은 사라지므로 반드시 확인을 받는다.
    async function forceReloadApp() {
      const hasWork = !!(originalPdfBytes && pageResults.filter(Boolean).length);
      const msg = hasWork
        ? '앱을 새로고침할까요?\n\n열려 있는 문서와 적용하지 않은 편집 내용이 모두 사라집니다.\n(저장하려면 취소 후 ⇩ 다운로드로 저장하세요)'
        : '앱을 새로고침할까요? (화면·상태를 처음으로 되돌립니다)';
      if (!confirm(msg)) return;
      try {
        if (window.electronAPI && window.electronAPI.setUnsaved) window.electronAPI.setUnsaved(false);
        if (window.electronAPI && window.electronAPI.forceReload) await window.electronAPI.forceReload();
        else location.reload();
      } catch (e) { location.reload(); }
    }

    if (window.electronAPI && window.electronAPI.onReloadRequest) {
      window.electronAPI.onReloadRequest(() => forceReloadApp());
    }

    // F5: 결과 새로고침 / Ctrl+Shift+R: 앱 강제 새로고침
    // (입력창 포커스 여부와 무관하게 동작 — 브라우저 기본 새로고침은 차단)
    document.addEventListener('keydown', e => {
      if ((e.key === 'r' || e.key === 'R' || e.key === 'F5') && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        forceReloadApp();
        return;
      }
      if (e.key === 'F5' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        refreshResults();
      }
    });

    // 단일 키: W / R / L / B / C (입력창 포커스 시 무시)
    document.addEventListener('keydown', e => {
      // Esc: 크게 보기 → 편집 작업공간 순으로 닫기 (입력창 포커스 중에도 동작)
      if (e.key === 'Escape' && typeof pvvVisible === 'function' && pvvVisible()) {
        e.preventDefault(); closePageView(); return;
      }
      if (e.key === 'Escape' && document.body.classList.contains('edit-fullscreen')) {
        e.preventDefault(); exitEditWorkspace(false); return;
      }
      // 크게 보기가 열려 있는 동안은 뷰어 전용 키만 — 뒤의 편집 단축키(삭제·회전 등)는 막는다
      if (typeof pvvVisible === 'function' && pvvVisible()) {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        if (e.key === 'ArrowLeft')  { e.preventDefault(); pvvNav(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); pvvNav(1); }
        else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); pvvToggleBw(); }
        else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); closePageView(); }
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      if (!pageResults.length) return;
      switch (e.key) {
        case 'v': case 'V': e.preventDefault(); pvvOpen(ctxTargetIdx >= 0 ? ctxTargetIdx : null); break;
        case 't': case 'T': e.preventDefault(); openContentEditor(ctxTargetIdx >= 0 ? ctxTargetIdx : null); break;
        case 'w': case 'W': e.preventDefault(); ctxInsertBlank();  break;
        case 'd': case 'D': e.preventDefault(); ctxDuplicatePage(); break;
        case 'r': case 'R': e.preventDefault(); ctxRotate(90);     break;
        case 'l': case 'L': e.preventDefault(); ctxRotate(-90);    break;
        case 'b': case 'B': e.preventDefault(); ctxApplyBW();      break;
        case 'c': case 'C':      e.preventDefault(); ctxClearBW();      break;
        case 's': case 'S':      e.preventDefault(); showSidebar(!sbVisible); break;
        case 'e': case 'E':      e.preventDefault(); toggleEditSidebar(); break;
        case 'Delete':           e.preventDefault(); ctxDeletePage();   break;
      }
    });

    // ── 컨텍스트 메뉴 ────────────────────────────────────────────────────────
    let ctxTargetIdx = -1;   // 우클릭·마우스오버된 썸네일의 pageResults 인덱스
    const ctxMenu = document.getElementById('pageCtxMenu');

    function showCtxMenu(e, idx) {
      ctxTargetIdx = idx;
      const menuW = 220, menuH = 340;
      let x = e.clientX, y = e.clientY;
      if (x + menuW > window.innerWidth)  x = window.innerWidth  - menuW - 6;
      if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 6;
      ctxMenu.style.left    = x + 'px';
      ctxMenu.style.top     = y + 'px';
      ctxMenu.style.display = 'block';
    }
    function hideCtxMenu() { ctxMenu.style.display = 'none'; }

    document.addEventListener('click',       hideCtxMenu);
    document.addEventListener('contextmenu', e => { if (!e.target.closest('.page-item')) hideCtxMenu(); });
    document.addEventListener('keydown',     e => { if (e.key === 'Escape') hideCtxMenu(); });

    // 컨텍스트 메뉴 액션 (ctxTargetIdx 또는 마우스오버 썸네일 기준)
    // 🔍 크게 보기 — 컬러/흑백을 눈으로 판별 (app-ui.js의 pvvOpen)
    function ctxPageView() {
      hideCtxMenu();
      if (typeof pvvOpen === 'function') pvvOpen(ctxTargetIdx);
    }
    function ctxInsertBlank() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      insertBlankPage(ctxTargetIdx);
    }
    function ctxRotate(deg) {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      rotatePage(ctxTargetIdx, deg);
    }
    function ctxApplyBW() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      const r = pageResults[ctxTargetIdx];
      if (!r) return;
      const el = document.querySelector(`[data-page="${r.pageNum}"]`);
      if (el && !el.classList.contains('selected')) selectPageEl(r.pageNum, el);
      updateSelectedCount();
    }
    function ctxClearBW() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      const r = pageResults[ctxTargetIdx];
      if (!r) return;
      const el = document.querySelector(`[data-page="${r.pageNum}"]`);
      if (el && el.classList.contains('selected')) deselectPageEl(r.pageNum, el);
      updateSelectedCount();
    }
    function ctxDeletePage() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      deletePage(ctxTargetIdx);
    }
    function ctxDuplicatePage() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      duplicatePage(ctxTargetIdx);
    }
    function ctxSplitChapter() {
      const idx = ctxTargetIdx;
      hideCtxMenu();
      if (idx < 0) return;
      splitChapterAt(idx);
    }
    function ctxCopyPages()  { hideCtxMenu(); copyPagesToClipboard(); }
    function ctxCutPages()   { hideCtxMenu(); cutPagesToClipboard(); }
    function ctxPastePages() { hideCtxMenu(); pastePagesFromClipboard(); }
    function ctxEditContent() {
      const idx = ctxTargetIdx;
      hideCtxMenu();
      openContentEditor(idx);
    }

    // ── 페이지 내부 편집기(별도 창) ──────────────────────────────────────────
    // 원본 PDF는 임시파일로 넘기고(대용량 IPC 손상 방지) 편집기는 fs로 직접 읽는다.
    async function openContentEditor(startDisplayIdx) {
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('편집할 PDF가 없습니다.'); return; }
      // 표지 편집기 세션이 (편집기 취소 등으로) 남아 있으면 폐기 — 결과 오라우팅 방지
      if (typeof _coverEditSession !== 'undefined') _coverEditSession = null;
      try {
        const buf = originalPdfBytes.slice ? originalPdfBytes.slice(0) : originalPdfBytes;
        const pdfPath = window.electronAPI.writeTempFile(buf, 'pdf');
        // 표시순서(빈 페이지 제외) — 편집기 왼쪽 페이지목록·번호용
        const order = pageResults.filter(r => r && !r.isBlank).map(r => ({ originalIdx: r.originalIdx, num: r.pageNum }));
        if (!order.length) { showError('편집 가능한 원본 페이지가 없습니다.'); return; }
        // 기존 편집 모델 전달(재편집)
        const modelsObj = {};
        contentEdits.forEach((v, k) => { modelsObj[k] = v.model || []; });
        // 시작 페이지 originalIdx
        let startIdx = order[0].originalIdx;
        const sr = (startDisplayIdx != null) ? pageResults[startDisplayIdx] : null;
        if (sr && !sr.isBlank) startIdx = sr.originalIdx;
        // 🔖 이 문서의 머리글·바닥글이 페이지마다 어떻게 찍힐지 함께 넘긴다 —
        // 편집기에서 그 페이지의 문구를 눈으로 확인하고 고칠 수 있게(수정분은 페이지별 덮어쓰기).
        const hfPages = {};
        if (typeof hfForPage === 'function') {
          order.forEach(o => {
            const info = hfForPage(o.num);
            if (info) hfPages[o.originalIdx] = info;
          });
        }
        await window.electronAPI.openEditor({ pdfPath, models: modelsObj, startIdx, order, hfPages });
      } catch (e) {
        console.error('편집기 열기 실패:', e);
        showError('내부 편집기 열기 실패: ' + (e.message || e));
      }
    }

    // 편집기 저장 결과 반영: contentEdits 병합 → 캐시 무효 → 썸네일 재생성 → 화면 반영
    async function applyEditorResult(result) {
      if (!result) return;
      const { edits, removed, hfOverrides } = result;
      const changed = [];
      // 🔖 편집기에서 고친 '이 페이지의 머리글·바닥글' — 페이지별 덮어쓰기로 저장.
      // (페이지 콘텐츠가 아니라 설정이므로 contentEdits와 별개로 반영한다)
      let hfN = 0;
      if (hfOverrides && typeof setHfPageOverride === 'function') {
        Object.keys(hfOverrides).forEach(pn => { setHfPageOverride(+pn, hfOverrides[pn]); hfN++; });
        if (hfN) {
          if (typeof syncEditUI === 'function') syncEditUI();
          if (typeof invalidateProcessed === 'function') invalidateProcessed();
          if (typeof scheduleLivePreview === 'function') scheduleLivePreview();
          showSuccess(`머리글·바닥글을 ${hfN}개 페이지에서 고쳤습니다 — 그 페이지만 고친 문구로 인쇄됩니다.`);
        }
      }
      try {
        showLoading('내부 편집 반영 중…');
        if (edits) {
          for (const k of Object.keys(edits)) {
            const idx = +k, e = edits[k] || {};
            let bytes = null;
            try { bytes = new Uint8Array(window.electronAPI.readFile(e.bytesPath)); }
            catch (err) { console.error('편집결과 읽기 실패:', err); }
            finally { try { window.electronAPI.removeTempFile(e.bytesPath); } catch (x) {} }
            if (!bytes) continue;
            const prev = contentEdits.get(idx);
            contentEdits.set(idx, { model: e.model || [], bytes, rev: (prev ? prev.rev : 0) + 1 });
            changed.push(idx);
          }
        }
        if (removed && removed.length) {
          removed.forEach(idx => { if (contentEdits.has(idx)) { contentEdits.delete(idx); changed.push(idx); } });
        }
        if (!changed.length) { hideLoading(); return; }
        clearProcessCaches();                 // base·bw·편집doc·미리보기 캐시 전부 무효화
        await regenEditedThumbs([...new Set(changed)]);
        setDirty(true);
        refreshResults();                     // 그리드·사이드바 썸네일 갱신
        updateDownloadBtn();
        if (previewVisible() || shouldPreview()) scheduleLivePreview(); else invalidateProcessed();
        showSuccess(`내부 편집을 반영했습니다 (${new Set(changed).size}개 페이지). '✔ 적용' 후 '⇩ 다운로드'로 저장하세요.`);
      } catch (e) {
        console.error('편집 반영 오류:', e);
        showError('내부 편집 반영 오류: ' + (e.message || e));
      } finally { hideLoading(); }
    }

    // 편집/삭제된 페이지의 썸네일을 편집본(또는 원본)으로 다시 렌더
    async function regenEditedThumbs(indices) {
      for (const idx of indices) {
        const r = pageResults.find(x => x && !x.isBlank && x.originalIdx === idx);
        if (!r) continue;
        const ed = contentEdits.get(idx);
        let pdf = null;
        try {
          const data = ed ? ed.bytes.slice(0) : originalPdfBytes.slice(0);
          pdf = await pdfjsLib.getDocument({ data }).promise;
          const page = await pdf.getPage(ed ? 1 : idx + 1);
          const res = await analyzePageColor(page);
          const thumb = res && res.thumbPromise ? await res.thumbPromise : null;
          if (thumb) {
            if (r.thumbnail && typeof r.thumbnail === 'string' && r.thumbnail.startsWith('blob:'))
              { try { URL.revokeObjectURL(r.thumbnail); } catch (x) {} }
            r.thumbnail = thumb; r.thumbW = res.thumbW; r.thumbH = res.thumbH; r.isColor = res.isColor;
            r.thumbLow = !!res.low;
          }
        } catch (e) { console.error('썸네일 재생성 실패:', e); }
        finally { if (pdf) { try { pdf.destroy(); } catch (x) {} } }
      }
    }

    // 편집기 → 메인: 저장 결과 수신 등록 (1회)
    // 표지 편집기 세션(_coverEditSession)이 열려 있으면 결과를 표지 저장 흐름으로 라우팅.
    try {
      window.electronAPI.onEditorResult && window.electronAPI.onEditorResult(res => {
        if (typeof _coverEditSession !== 'undefined' && _coverEditSession && typeof handleCoverEditorResult === 'function') {
          handleCoverEditorResult(res);
          return;
        }
        applyEditorResult(res);
      });
    } catch (e) {}

    function jumpToPage() {
      const input = document.getElementById('jumpPageInput');
      const num = parseInt(input.value);
      const total = pageResults.filter(Boolean).length;
      if (!num || num < 1 || num > total) {
        input.style.borderColor = '#dc3545';
        setTimeout(() => { input.style.borderColor = ''; }, 1000);
        return;
      }
      const el = document.querySelector(`[data-page="${num}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('page-jump-highlight');
      void el.offsetWidth;
      el.classList.add('page-jump-highlight');
      setTimeout(() => el.classList.remove('page-jump-highlight'), 1300);
    }

    // ── 처리 옵션 / 버튼 상태 ────────────────────────────────────────────────
    // 임포징 포함 여부를 app-core에서 안전하게 읽는다. _impEnabled는 뒤에 로드되는
    // app-process.js의 최상위 let이라 이 파일 실행 시점엔 TDZ — typeof도 던지므로 try로 감싼다.
    function impIncluded() {
      try { return !!_impEnabled; } catch (e) { return false; }
    }
    // 적용 버튼: 수정사항(흑백옵션·페이지편집·페이지선택)이 있으면 활성화
    // 다운로드 버튼: '적용'으로 결과가 만들어진 뒤에만 활성화, 적용 진행 중엔 비활성화
    function updateDownloadBtn() {
      const anyActive = Object.values(processingOptions).some(v => v);
      // 편집 사이드바(크기·N-up·테두리·머리글바닥글·워터마크, 챕터별 개별 설정 포함)만
      // 설정한 경우도 '수정사항'으로 인정해야 메인/사이드바의 '적용' 버튼이 편집창의
      // '편집 적용'과 같은 조건으로 활성화된다.
      // 임포징 포함(_impEnabled)도 단독으로 '수정사항' — 빠져 있으면 임포징만 켠 상태에서
      // 메인/사이드바 '적용'이 비활성이라 전체화면으로 펼쳐야만 반영되는 비대칭이 생긴다.
      const outlineOn = (typeof _outlineEnabled !== 'undefined') && _outlineEnabled;   // ✒ 아웃라인 옵션도 단독 수정사항
      const hasMod    = !!originalPdfBytes && (anyActive || pageEdited || selectedPages.size > 0 || hasAnyActiveLayout() || hasContentEdits() || impIncluded() || outlineOn);
      const applyBtn    = document.getElementById('applyBtn');
      const downloadBtn = document.getElementById('downloadBtn');
      // 적용 결과가 이미 최신이면(processedPdfBytes 존재 — 어떤 수정이든 생기면
      // invalidateProcessed()가 null로 비움) 다시 적용할 필요가 없으므로 비활성화.
      const upToDate  = !!processedPdfBytes;
      if (applyBtn)    applyBtn.disabled    = applying || !hasMod || upToDate;
      // 다운로드: PDF가 열려 있으면 클릭 가능(우클릭→원본 저장). 적용 전이면 흐리게 표시.
      if (downloadBtn) {
        downloadBtn.disabled = applying || !originalPdfBytes;
        downloadBtn.classList.toggle('btn-dim', !processedPdfBytes);
      }
      const clearBtn = document.getElementById('clearOptsBtn');
      if (clearBtn) clearBtn.style.display = anyActive ? '' : 'none';
      // 편집 패널 적용/다운로드 버튼
      const esApply = document.getElementById('esApplyBtn');
      const esDownload = document.getElementById('esDownloadBtn');
      if (esApply) esApply.disabled = applying || !originalPdfBytes || upToDate;
      if (esDownload) esDownload.disabled = applying || !processedPdfBytes;
      // '적용 필요' 강조 — 자동 반영(liveAutoPreview)이 꺼져 있으면 설정을 바꿔도 화면이
      // 그대로라 반영이 안 된 것으로 오해하기 쉽다. 미리보기가 떠 있지 않아도 보이도록
      // 적용 버튼 자체에 표시한다.
      // 단, 버튼 활성 조건(hasMod)을 그대로 쓰면 안 된다 — inkNorm이 기본 ON이라 PDF를
      // 열자마자 hasMod가 참이 되어, 사용자가 아무것도 건드리지 않았는데 계속 깜빡인다.
      // 강조는 '사용자가 실제로 바꾼 것'이 있을 때만: 기본값과 달라진 옵션 + 실제 편집.
      const optsChanged = processingOptions.bw || processingOptions.inkNorm !== true;
      const userMod = !!originalPdfBytes && (optsChanged || pageEdited || selectedPages.size > 0
                      || hasAnyActiveLayout() || hasContentEdits() || impIncluded());
      const needsApply = userMod && !upToDate && !applying;
      ['applyBtn', 'sb-applyBtn', 'esApplyBtn'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.classList.toggle('needs-apply', needsApply && !b.disabled);
      });
      syncSidebarPanel();
    }

    // 새 수정이 생기면 직전 '적용' 결과는 무효화 (다시 적용해야 다운로드 가능)
    // 장시간 작업 버튼 진행효과 — 실행 중 노란 스윕 + 클릭 잠금 (style.css .btn-busy)
    function setBtnBusy(id, on) {
      const b = document.getElementById(id);
      if (b) b.classList.toggle('btn-busy', !!on);
    }
    // 적용 버튼 3형제(메인·좌측 사이드바·편집 패널)를 한꺼번에 진행 표시
    function setApplyBusy(on) {
      ['applyBtn', 'sb-applyBtn', 'esApplyBtn'].forEach(id => setBtnBusy(id, on));
    }

    function invalidateProcessed() {
      if (!applying) {
        processedPdfBytes = null; processedFileName = ''; directOutputBytes = null;
        _processedSig = null;
      }
      // 수정이 생겼으니 '📖 임포징 PDF 생성' 1회 잠금도 해제 (다시 생성 가능)
      if (typeof impGenInvalidate === 'function') impGenInvalidate();
      updateDownloadBtn();
    }

    function toggleOption(key) {
      processingOptions[key] = !processingOptions[key];
      document.getElementById(`opt-${key}`).classList.toggle('active', processingOptions[key]);
      // 사이드바 미러 버튼도 즉시 동기 — 상태·표시 불일치로 인한 오인 방지
      const sb = document.getElementById(`sb-opt-${key}`);
      if (sb) sb.classList.toggle('active', processingOptions[key]);
      if (key === 'bw') {
        // 옵션을 끄면 확정(appliedBw)도 함께 해제 — 흑백변환을 되돌리는 유일한 명시적 방법
        if (!processingOptions.bw) {
          pageResults.forEach(r => {
            if (!r || !r.appliedBw) return;
            delete r.appliedBw;
            const el = document.querySelector(`[data-page="${r.pageNum}"]`);
            if (el) restoreThumbnailEl(el, r.pageNum);
          });
        }
        syncSelectionVisuals();
        if (typeof refreshResults === 'function') refreshResults();
      }
      invalidateProcessed();
      if (typeof previewVisible === 'function' && previewVisible()) scheduleLivePreview();
      // 잉크 정규화를 끄는 것은 '프린터가 컬러로 셀 수 있는 상태'로 되돌리는 것 — 바로 알린다
      if (key === 'inkNorm' && !processingOptions.inkNorm) {
        showSuccess('⛭ 잉크 정규화를 껐습니다 — 흑백으로 보이는 페이지도 원고의 색공간(RGB/CMYK) 그대로 나갑니다.'
          + '\n프린터가 그 페이지를 컬러 장수로 셀 수 있습니다. 특별한 이유가 없으면 켜 두세요(새 문서를 열면 다시 켜집니다).');
      }
      // 잉크 정규화·흑백변환을 켜면 유휴 시간에 미리 변환 시작 (적용 대기시간 제거)
      if (processingOptions[key]) scheduleBwPrewarm(300);
    }

    // '✖ 해제' — 잉크 정규화는 기본값(켬)으로 되돌린다. 예전엔 이것까지 함께 꺼져서,
    // 해제 한 번에 흑백 페이지가 RGB인 채로 나가 프린터가 컬러로 세는 일이 생겼다.
    function clearOptions() {
      Object.keys(processingOptions).forEach(k => {
        processingOptions[k] = (k === 'inkNorm');      // 잉크 정규화만 기본 ON 유지
        const btn = document.getElementById('opt-' + k);
        if (btn) btn.classList.toggle('active', processingOptions[k]);
        const sb = document.getElementById('sb-opt-' + k);
        if (sb) sb.classList.toggle('active', processingOptions[k]);
      });
      invalidateProcessed();
    }



    // ── base(순서·회전·흑백) 빌드 — 결과를 시그니처로 캐시 (실시간 미리보기 재사용) ──
    let _baseCache = { sig: null, bytes: null, stats: null };
    // 페이지 단위 흑백변환 캐시: originalIdx → 변환된 단일페이지 PDFDocument.
    // 선택이 바뀌어도 '새로 선택된 페이지'만 변환하므로 재적용이 매우 빠르다.
    let _bwCache = new Map();
    // 페이지 내부편집 소스 캐시: originalIdx → 편집이 구워진 단일페이지 PDFDocument.
    // contentEdits[idx].bytes(편집된 단일페이지 PDF)를 1회 load해 재사용한다.
    let _editDocCache = new Map();
    // 페이지 편집 버전(캐시 무효화·시그니처용) — 편집이 없으면 0.
    function editRev(idx) { const e = contentEdits && contentEdits.get(idx); return e ? (e.rev || 0) : 0; }
    // 편집된 단일페이지 PDFDocument를 load해 캐시에서 반환(편집 없으면 null).
    async function getEditedPageDoc(idx) {
      const e = contentEdits && contentEdits.get(idx);
      if (!e || !e.bytes) return null;
      const cached = _editDocCache.get(idx);
      if (cached && cached.rev === (e.rev || 0)) return cached.doc;
      const doc = await PDFLib.PDFDocument.load(e.bytes.slice ? e.bytes.slice(0) : e.bytes);
      _editDocCache.set(idx, { rev: e.rev || 0, doc });
      return doc;
    }
    // 레이아웃 변환(N-up·규격화·테두리·머리글바닥글·워터마크) 결과 캐시 — 실시간 미리보기가
    // 이미 계산한 결과를 '적용' 버튼이 그대로 재사용해 중복 워커 실행(딜레이)을 없앤다.
    let _layoutCache = { sig: null, bytes: null };
    // 조립된 base 문서 캐시(회전 제외한 순서+흑백 기준). 회전만 바뀌면 이 문서를 그대로
    // 재사용해 각 페이지 /Rotate만 다시 세팅→재저장한다(load·copyPages·흑백조립 생략).
    // pages[i] = { page(PDFPage), baseAngle(원본 /Rotate) } — baseAngle 기준이라 회전이
    // 누적되지 않고 항상 (원본각+요청각)으로 idempotent하게 반영된다.
    let _baseAssembled = null; // { key, outDoc, pages:[{page,baseAngle}], stats, validCount }
    // 다운로드용 최적화본 캐시 (buildOptimizedOutput 결과; 프리웜으로 미리 채움)
    let _optCache = { sig: null, bytes: null };
    // 다운로드용 base(페이지 복사 + 흑백/잉크 변환) 캐시 — 키는 baseSignature()(순서·회전·
    // 흑백선택·내부편집 rev). 편집 옵션이나 임포징 옵션만 바꿨을 때는 base가 그대로인데도
    // 매번 전 페이지를 다시 변환하고 있었다(64쪽 사진 원고에서 4.5초 CPU를 반복).
    let _optBaseCache = { sig: null, bytes: null, stats: null };
    function clearProcessCaches() {
      _baseCache = { sig: null, bytes: null, stats: null };
      _bwCache = new Map();
      _editDocCache = new Map();
      _layoutCache = { sig: null, bytes: null };
      _baseAssembled = null;
      _pvPageCache = new Map();
      _optCache = { sig: null, bytes: null };
      _optBaseCache = { sig: null, bytes: null, stats: null };
      _srcDocCache = { bytes: null, promise: null };
      if (typeof clearImpCache === 'function') clearImpCache();
      releasePreviewDoc();
    }
    // 회전을 뺀 base 키(페이지 순서 + 흑백선택). 회전만 바뀌면 이 키가 동일 → 조립본 재사용.
    function baseOrderBwKey() {
      const valid = pageResults.filter(Boolean);
      const order = valid.map(r => (r.isBlank ? 'b' + (r.pageSize || []).join('x') : r.originalIdx) + (r.isBlank ? '' : '@' + editRev(r.originalIdx))).join('|');
      const bw = bwSigPages(valid);
      return order + '#' + bw + (processingOptions.inkNorm ? '#ink' : '');
    }
    function baseSignature() {
      const valid = pageResults.filter(Boolean);
      const order = valid.map(r => `${r.isBlank ? 'b' + (r.pageSize || []).join('x') : r.originalIdx + '@' + editRev(r.originalIdx)}:${r.rotation || 0}`).join('|');
      const bw = bwSigPages(valid);
      return order + '#' + bw + (processingOptions.inkNorm ? '#ink' : '');
    }
    // 시그니처용 흑백 대상 페이지 목록 — 확정(appliedBw) + 현재 선택(bw 옵션 시) 합집합
    function bwSigPages(valid) {
      const nums = valid
        .filter(r => r.appliedBw || (processingOptions.bw && selectedPages.has(r.pageNum)))
        .map(r => r.pageNum);
      return nums.sort((a, b) => a - b).join(',');
    }
    // ── 흑백(DeviceGray) 변환 대상 판정 — 적용(buildBaseProcessed)과 다운로드
    // (buildBaseOptimized) 두 파이프라인이 반드시 이 함수를 공유한다.
    // (한쪽에만 조건이 빠져 다운로드본에서 잉크 정규화가 누락됐던 버그의 재발 방지)
    function isBwTarget(r) {
      if (!r || r.isBlank) return false;
      if (r.appliedBw) return true;   // '✔ 적용'으로 확정된 흑백 — 선택과 무관하게 유지
      if (processingOptions.bw && selectedPages.size > 0 && selectedPages.has(r.pageNum)) return true;
      return !!processingOptions.inkNorm && !r.isColor;
    }

    // ── 원본 PDF의 pdf-lib 문서 공유 캐시 ────────────────────────────────────
    // '적용' 한 번에 PDFDocument.load(originalPdfBytes)가 세 번(흑백변환·조립·다운로드 base)
    // 일어나 큰 원고에서는 파싱만 반복해 수 초를 잡아먹었다. copyPages는 소스를 수정하지 않고
    // (변환은 언제나 복사본 위에서 한다) 원본 바이트는 문서가 바뀌기 전까지 불변이므로 하나를
    // 공유해도 안전하다. 바이트 객체가 바뀌면(다른 탭·새 문서) 자동으로 다시 로드된다.
    let _srcDocCache = { bytes: null, promise: null };
    function getSourceDoc() {
      if (_srcDocCache.bytes !== originalPdfBytes || !_srcDocCache.promise) {
        const p = PDFLib.PDFDocument.load(originalPdfBytes.slice(0));
        // 실패한 promise가 캐시에 눌러앉지 않게 정리
        p.catch(() => { if (_srcDocCache.promise === p) _srcDocCache = { bytes: null, promise: null }; });
        _srcDocCache = { bytes: originalPdfBytes, promise: p };
      }
      return _srcDocCache.promise;
    }

    // 필요한 흑백 페이지들을 캐시에 채움(없는 것만 병렬 변환). srcDoc는 공유 캐시에서.
    async function ensureBwConverted(indices, stats, onProgress) {
      const todo = indices.filter(i => !_bwCache.has(i));
      if (!todo.length) { if (onProgress) onProgress(92); return; }
      // 회색 판정 페이지는 Dot Gain 보정을 걸지 않는다(0 강제) — 이미 회색인 페이지의
      // 밝기가 변하는 부작용 방지. 컬러 페이지만 UI에서 선택한 Dot Gain을 적용.
      const colorOf = new Map(pageResults.filter(r => r && !r.isBlank).map(r => [r.originalIdx, !!r.isColor]));
      const src = await getSourceDoc();
      // 1) 대상 페이지를 **한 문서(batch)로 한 번에** 복사한다.
      //    예전에는 페이지마다 독립 문서를 만들어 복사했다 → 여러 쪽이 같은 이미지·폰트를 쓰면
      //    그 리소스가 쪽 수만큼 복제되고, 같은 이미지를 쪽 수만큼 다시 디코드·그레이화·재인코드했다
      //    (사진 카탈로그에서 흑백변환·잉크정규화가 유난히 느렸던 진짜 이유).
      //    한 문서에 모으면 리소스가 공유되므로 공용 이미지는 딱 한 번만 변환된다 —
      //    이미 DeviceGray가 된 XObject는 두 번째 페이지에서 그대로 건너뛰기 때문.
      //    (다운로드 경로 buildBaseOptimized가 예전부터 쓰던 방식과 같다)
      const batch = await PDFLib.PDFDocument.create();
      const pageAt = new Map();                        // originalIdx → batch 안 페이지 인덱스
      const edited = todo.filter(i => contentEdits && contentEdits.has(i));
      const plain  = todo.filter(i => !(contentEdits && contentEdits.has(i)));
      if (plain.length) {
        const copied = await batch.copyPages(src, plain);
        copied.forEach((pg, k) => { batch.addPage(pg); pageAt.set(plain[k], batch.getPageCount() - 1); });
      }
      // 내부편집이 있는 페이지는 원본 대신 '편집된 단일페이지'를 소스로 삼아 흑백 변환한다.
      for (const idx of edited) {
        const editedDoc = await getEditedPageDoc(idx);
        const [pg] = editedDoc ? await batch.copyPages(editedDoc, [0]) : await batch.copyPages(src, [idx]);
        batch.addPage(pg);
        pageAt.set(idx, batch.getPageCount() - 1);
      }
      // 2) 변환은 CPU 코어 수만큼 병렬. 단, Dot Gain 오버라이드는 문서 단위(WeakMap)라
      //    컬러 페이지(UI 설정 적용)와 회색 판정 페이지(0 강제)를 순서대로 나눠 돌린다.
      const SEM = Math.max(navigator.hardwareConcurrency || 4, 4);
      let sem = SEM; const q = [];
      const wait = () => sem > 0 ? (sem--, Promise.resolve()) : new Promise(r => q.push(r));
      const rel = () => { if (q.length) q.shift()(); else sem++; };
      let done = 0;
      const runBatch = (list, dgOverride) => Promise.all(list.map(idx => (async () => {
        await wait();
        try {
          try { await convertPageToGrayscaleVector(batch, pageAt.get(idx), stats, dgOverride); }
          catch (e) { if (stats) { stats.errors++; stats.errPages.push(idx + 1); } console.error(`페이지 ${idx + 1} 변환 오류:`, e); }
        } finally { done++; if (onProgress) onProgress(10 + done / todo.length * 80); rel(); }
      })()));
      await runBatch(todo.filter(i => colorOf.get(i)), undefined);   // 컬러 → UI Dot Gain
      await runBatch(todo.filter(i => !colorOf.get(i)), 0);          // 회색 → Dot Gain 미적용
      // 3) 캐시에는 '어느 문서의 몇 번째 페이지인지'를 담는다(문서는 여러 페이지가 공유)
      for (const idx of todo) {
        _bwCache.set(idx, { doc: batch, idx: pageAt.get(idx) });
        // 캐시 상한(FIFO) — 변환된 페이지가 계속 상주하므로 초대형 문서에서 메모리가
        // 무한히 늘지 않게 오래된 항목부터 해제(재요청 시 다시 변환됨)
        if (_bwCache.size > 800) { const k = _bwCache.keys().next().value; _bwCache.delete(k); }
      }
    }
    // ── 흑백·잉크 정규화 프리웜 ─────────────────────────────────────────────
    // 분석이 끝나면(그리고 흑백 선택이 바뀌면) 유휴 시간에 변환 대상 페이지들을 미리
    // _bwCache로 변환해 두어 '적용'을 눌렀을 때 변환 없이 즉시 조립되게 한다.
    // 대상 판정은 isBwTarget 하나로 통일 — 잉크 정규화 페이지뿐 아니라 사용자가 고른
    // 흑백변환 페이지도 미리 굽는다(예전엔 선택 페이지는 '적용'을 누른 뒤에야 변환됐다).
    // 탭이 바뀌면 결과는 폐기.
    let _inkPrewarmPromise = null;
    function prewarmInkNorm() {
      if (_inkPrewarmPromise || applying) return;
      if (!originalPdfBytes) return;
      const idxs = pageResults.filter(r => r && !r.isBlank && isBwTarget(r))
                              .map(r => r.originalIdx)
                              .filter(i => i != null && !_bwCache.has(i));
      if (!idxs.length) return;
      const tabAtStart = activeTabId;
      _inkPrewarmPromise = (async () => {
        try { await ensureBwConverted(idxs, null, null); }
        catch (e) { console.warn('흑백·잉크 정규화 프리웜 실패:', e); }
        finally {
          _inkPrewarmPromise = null;
          // 프리웜 도중 탭이 바뀌었으면 엉뚱한 문서의 캐시가 섞였을 수 있음 → 전체 폐기
          if (activeTabId !== tabAtStart) clearProcessCaches();
          // 이어서 다운로드용 최적화본도 미리 생성 — '적용' 전에 다운로드해도 즉시 저장
          else setTimeout(() => { if (typeof prewarmOptimizedOutput === 'function') prewarmOptimizedOutput(); }, 500);
        }
      })();
    }

    // 흑백 선택·옵션이 바뀌면 잠깐 기다렸다가(연속 클릭 흡수) 프리웜을 다시 돌린다.
    // 이미 변환된 페이지는 캐시 적중으로 건너뛰므로 추가 선택분만 구워진다.
    let _bwPrewarmTimer = null;
    function scheduleBwPrewarm(delay) {
      clearTimeout(_bwPrewarmTimer);
      _bwPrewarmTimer = setTimeout(() => { try { prewarmInkNorm(); } catch (e) {} }, delay || 700);
    }

    async function buildBaseProcessed(onProgress) {
      const sig = baseSignature();
      if (_baseCache.sig === sig && _baseCache.bytes) return _baseCache;
      // 잉크 정규화 프리웜이 돌고 있으면 완료를 기다렸다가 캐시를 재사용(중복 변환 방지)
      if (_inkPrewarmPromise) { if (onProgress) onProgress(8); await _inkPrewarmPromise; }
      const valid = pageResults.filter(Boolean);
      // ── 회전 전용 빠른 경로 ──
      // 순서·흑백이 그대로고 회전만 바뀐 경우: 이미 조립된 outDoc을 재사용해 각 페이지
      // /Rotate만 다시 세팅하고 재저장한다(무거운 load·copyPages·흑백조립 전부 생략).
      const key = baseOrderBwKey();
      if (_baseAssembled && _baseAssembled.key === key && _baseAssembled.pages.length === valid.length) {
        const asm = _baseAssembled;
        if (onProgress) onProgress(20);
        for (let i = 0; i < valid.length; i++) {
          const r = valid[i], { page, baseAngle } = asm.pages[i];
          page.setRotation(PDFLib.degrees((((baseAngle + (r.rotation || 0)) % 360) + 360) % 360));
        }
        if (onProgress) onProgress(80);
        const bytes = await savePdfDoc(asm.outDoc);
        _baseCache = { sig, bytes, stats: asm.stats, validCount: valid.length };
        if (onProgress) onProgress(94);
        return _baseCache;
      }
      const isBw = isBwTarget;   // 변환 대상 판정은 다운로드 파이프라인과 공유
      const stats = { errors: 0, errPages: [], converted: 0 };
      if (onProgress) onProgress(5);
      // 흑백 대상 페이지 미리 변환(캐시 미스만 변환)
      const bwIdx = valid.filter(isBw).map(r => r.originalIdx);
      stats.converted = bwIdx.length;
      if (bwIdx.length) await ensureBwConverted(bwIdx, stats, onProgress);

      const srcDoc = await getSourceDoc();
      const outDoc = await PDFLib.PDFDocument.create();
      // 비변환·비편집 원본 페이지는 일괄 copyPages로 리소스 공유 (파일 크기 최소화)
      const isEdited = r => !r.isBlank && contentEdits.has(r.originalIdx);
      const origPages = valid.filter(r => !r.isBlank && !isBw(r) && !isEdited(r));
      const origCopied = origPages.length ? await outDoc.copyPages(srcDoc, origPages.map(r => r.originalIdx)) : [];
      const origMap = new Map(origPages.map((r, i) => [r.originalIdx, origCopied[i]]));
      // 내부편집 페이지(흑백 아님)는 편집된 단일페이지 doc에서 개별 복사
      const editMap = new Map();
      for (const r of valid) {
        if (r.isBlank || isBw(r) || !isEdited(r)) continue;
        const ed = await getEditedPageDoc(r.originalIdx);
        if (ed) { const [pg] = await outDoc.copyPages(ed, [0]); editMap.set(r.originalIdx, pg); }
      }
      // 변환 페이지는 캐시된 변환 문서에서 복사 (흑백 소스는 편집본이 있으면 편집본).
      // 같은 변환 문서에서 온 페이지들은 한 번의 copyPages로 함께 가져온다 — 페이지마다
      // 따로 부르면 공용 이미지·폰트가 페이지 수만큼 복제돼 결과 파일이 부풀었다.
      const bwMap = new Map();
      const byConvDoc = new Map();
      for (const r of valid) {
        if (!isBw(r) || bwMap.has(r.originalIdx)) continue;
        const conv = _bwCache.get(r.originalIdx);
        if (!conv) continue;
        bwMap.set(r.originalIdx, null);                     // 자리 예약(같은 원본 중복 방지)
        let g = byConvDoc.get(conv.doc);
        if (!g) { g = []; byConvDoc.set(conv.doc, g); }
        g.push({ oi: r.originalIdx, idx: conv.idx });
      }
      for (const [doc, list] of byConvDoc) {
        const pgs = await outDoc.copyPages(doc, list.map(x => x.idx));
        pgs.forEach((pg, k) => bwMap.set(list[k].oi, pg));
      }
      // 순서대로 조립 + 회전 (baseAngle=원본 /Rotate를 기록해 두면 이후 회전만 바뀔 때
      // outDoc을 재사용해 setRotation→재저장만으로 처리 가능)
      const asmPages = [];
      for (const r of valid) {
        let page;
        if (r.isBlank) page = outDoc.addPage(r.pageSize || [595.28, 841.89]);
        else if (isBw(r) && bwMap.get(r.originalIdx)) page = outDoc.addPage(bwMap.get(r.originalIdx));
        else if (isEdited(r) && editMap.has(r.originalIdx)) page = outDoc.addPage(editMap.get(r.originalIdx));
        else page = outDoc.addPage(origMap.get(r.originalIdx));
        const baseAngle = (page.getRotation && page.getRotation().angle) || 0;
        if (r.rotation) {
          page.setRotation(PDFLib.degrees((((baseAngle + r.rotation) % 360) + 360) % 360));
        }
        asmPages.push({ page, baseAngle });
      }
      if (onProgress) onProgress(94);
      const bytes = await savePdfDoc(outDoc);
      _baseAssembled = { key, outDoc, pages: asmPages, stats, validCount: valid.length };
      _baseCache = { sig, bytes, stats, validCount: valid.length };
      return _baseCache;
    }

    function describeLayoutParts(es) {
      const parts = [];
      if (es.scaling.mode === 'standard') parts.push(`${es.scaling.paper} 규격화`);
      else if (es.scaling.mode === 'custom') parts.push(`${es.scaling.customW}×${es.scaling.customH}mm`);
      else if (es.scaling.mode === 'percent') parts.push(`배율 ${es.scaling.percent || 100}%`);
      if ((es.nUp | 0) > 1) parts.push(`${es.nUp}-up 조판${es.gutter ? `(거터 ${es.gutter}mm)` : ''}`);
      if (es.deskew && es.deskew.enabled) parts.push(es.deskew.mode === 'manual' ? `기울기 ${es.deskew.angle}°` : '기울기 자동보정');
      if (es.center && es.center.enabled) parts.push(es.center.mode === 'uniform' ? '가운데 정렬(일괄)' : '가운데 정렬');
      const paN = es.pageAdjust ? Object.keys(es.pageAdjust).length : 0;
      if (paN) parts.push(`개별 보정 ${paN}쪽`);
      if (es.bind && es.bind.enabled) parts.push(`제본여백 ${es.bind.size}mm`);
      if (es.border !== 'none') parts.push('테두리');
      if (es.hf && es.hf.enabled) parts.push('머리글/바닥글' + (((es.hf.start | 0) > 1) ? `(번호 ${es.hf.start}p=1)` : ''));
      if (es.wm && es.wm.enabled && es.wm.text.trim()) parts.push('워터마크');
      return parts;
    }
    // 전역 설정 + 챕터별 개별 설정을 모두 반영해 적용 결과 메시지에 쓸 설명을 만든다.
    function layoutNoteOf() {
      if (!editSettings) return '';
      const notes = [];
      if (hasActiveLayout(editSettings)) notes.push(describeLayoutParts(editSettings).join(', '));
      const byChapter = editSettings.byChapter || {};
      Object.keys(byChapter).forEach(name => {
        if (hasActiveLayout(byChapter[name])) notes.push(`[${name}] ${describeLayoutParts(byChapter[name]).join(', ')}`);
      });
      return notes.length ? ` · 레이아웃: ${notes.join(' / ')}` : '';
    }
    // 저장 기본 파일명 = 원본 파일명 + 임포징 명칭(1up·2up·N-up…).
    // (예전엔 '_수정_20260807_101530'처럼 타임스탬프가 붙어 원본과 무관한 이름처럼 보였다 —
    //  인쇄 실무에서는 '문서_2up.pdf'처럼 조판 방식이 파일명에 드러나는 편이 훨씬 유용하다.)
    // 저장 파일명의 기준 이름 — 원본 파일명. 단, 챕터(병합 파일)가 있는데 원본 이름의
    // 챕터가 삭제되어 더 이상 없으면(예: 두 챕터 중 첫 챕터 삭제) 남아 있는 첫 챕터명을 쓴다.
    function effectiveBaseName() {
      const base = (originalFileName || '문서').replace(/\.pdf$/i, '');
      const names = [];
      pageResults.forEach(r => { if (r && r.chapter && !names.includes(r.chapter)) names.push(r.chapter); });
      if (!names.length || names.includes(base)) return base;
      return names[0];
    }
    function defaultProcessedName() {
      const base = effectiveBaseName();
      const tag = (typeof impNameTag === 'function') ? impNameTag() : '1up';
      const includeAmt = document.getElementById('includeAmountChk')?.checked;
      const totalSum = includeAmt ? quoteItems.reduce((s, it) => s + itemTotal(it), 0) : 0;
      const amountStr = (includeAmt && totalSum > 0) ? `_${totalSum}원` : '';
      return `${base}_${tag}${amountStr}.pdf`;
    }

    // ── 흑백 PDF / 편집 적용 (명시적 '적용' 버튼) ─────────────────────────────
    async function applyChanges() {
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) return;
      const appliedBwCnt = pageResults.filter(r => r && r.appliedBw).length;
      // 흑백변환만 켜고 아무 페이지도 고르지 않은 경우에만 거절한다. 임포징·블리드·편집처럼
      // 다른 수정이 있으면 그대로 진행 — 예전엔 여기서 반환해 "임포징을 켰는데 적용이 안 되고
      // 임포징 전 화면이 그대로 남는" 증상이 났다.
      const otherMod = hasAnyActiveLayout() || hasContentEdits() || impIncluded()
                     || (typeof _bleedEnabled !== 'undefined' && _bleedEnabled);
      if (processingOptions.bw && !selectedPages.size && !appliedBwCnt && !otherMod) { showError('흑백변환할 페이지를 선택해 주세요.'); return; }
      try {
        applying = true;
        processedPdfBytes = null; processedFileName = ''; directOutputBytes = null;
        // 적용 중에는 버튼이 전부 비활성이라 "눌러도 안 먹는다"로 보였다 —
        // 적용 버튼에 진행 스윕을 걸어 '지금 만드는 중'임이 버튼 자체에서 보이게 한다.
        setApplyBusy(true);
        updateDownloadBtn();
        const bwMode = processingOptions.bw && (selectedPages.size > 0 || appliedBwCnt > 0);
        const inkCnt = processingOptions.inkNorm ? pageResults.filter(r => r && !r.isBlank && !r.isColor).length : 0;
        showLoading(bwMode ? `벡터 흑백변환 중 — 선택 ${selectedPages.size}페이지${inkCnt ? ` + 잉크 정규화 ${inkCnt}페이지` : ''}`
                  : inkCnt ? `잉크 정규화 중 — 흑백 판정 ${inkCnt}페이지를 DeviceGray로 변환`
                  : 'PDF 생성 중...');
        progressBar.style.display = 'block'; updateProgress(0);

        const sigAtStart = (typeof optSignature === 'function') ? optSignature() : null;   // 조립 중 설정이 바뀌면 재사용 표식을 남기지 않는다
        const base = await buildBaseProcessed(p => updateProgress(typeof _impEnabled !== 'undefined' && _impEnabled ? Math.round(p * 0.85) : p));
        let pdfBytes = base.bytes;
        const groups = computeLayoutGroups();
        // 📄 파일(챕터)별 임포징이면 조판 단계부터 파일마다 따로 돌린다 —
        // 모아찍기처럼 조판이 쪽 수를 바꾸는 경우에도 한 칸에 두 파일이 섞이지 않는다.
        const perAll = (typeof tryPerChapterPipeline === 'function')
          ? await tryPerChapterPipeline(pdfBytes, groups, base.sig, p => updateProgress(82 + Math.round(p * 0.18)))
          : null;
        if (perAll) {
          pdfBytes = perAll;
        } else {
        if (groups.length) {
          updateProgress((typeof _impEnabled !== 'undefined' && _impEnabled) ? 82 : 96);
          pdfBytes = await applyLayoutTransform(pdfBytes, groups, base.sig);
        }
        // ◲ 블리드 옵션 — 켜져 있으면 항상 포함 (임포징 앞, 다운로드 경로와 동일 순서)
        if (typeof _bleedEnabled !== 'undefined' && _bleedEnabled) {
          showLoading('블리드 생성 중 — 가장자리 미러 확장…');
          pdfBytes = await applyBleedStage(pdfBytes);
        }
        // 임포징 포함 모드: 조립·레이아웃 결과를 시트로 임포징 (메인 다운로드와 동일 경로)
        if (typeof _impEnabled !== 'undefined' && _impEnabled) {
          updateProgress(88);
          pdfBytes = await buildImposedBytes(pdfBytes, p => updateProgress(88 + Math.round(p * 0.12)));
        }
        }
        // 폰트 출력 안전화(곡선화·완전 임베드)는 '적용' 단계에서 하지 않는다.
        // gs 변환은 모양을 전혀 바꾸지 않으면서(벡터 무손실) 시간이 오래 걸려(한글 40쪽 곡선화 2.6초,
        // 200쪽이면 십수 초), 여기서 돌리면 그동안 화면이 이전 상태(임포징 전)로 멈춰 보였다.
        // → 화면은 조판 결과로 즉시 갱신하고, 안전화는 적용 직후 백그라운드 프리웜
        //   (prewarmOptimizedOutput)이 미리 구워 두었다가 '⇩ 다운로드'가 그 캐시를 저장한다.
        const outlineOn = (typeof _outlineEnabled !== 'undefined' && _outlineEnabled);
        const layoutNote = layoutNoteOf()
          + (typeof _bleedEnabled !== 'undefined' && _bleedEnabled ? ` · ◲ 블리드 ${_bleedOpts().mm}mm${_bleedOpts().crop ? '+재단선' : ''}` : '')
          + (typeof impositionNoteOf === 'function' ? impositionNoteOf() : '')
          + (outlineOn ? (typeof _outlineMode !== 'undefined' && _outlineMode === 'embed'
              ? ' · 🔤 폰트 완전 임베드(다운로드 시 반영)'
              : ' · ✒ 폰트 곡선화(다운로드 시 반영)') : '');

        processedPdfBytes = pdfBytes;
        processedFileName = defaultProcessedName();
        _processedSig = (sigAtStart && optSignature() === sigAtStart) ? sigAtStart : null;
        setDirty(true);
        updateProgress(100);
        renderProcessedPreview(pdfBytes);

        // 흑백변환 확정(commit): 선택 페이지에 appliedBw 표식 → 이후 선택 해제·재선택과
        // 무관하게 변환이 유지된다. 선택은 자동 해제(결과·캐시는 그대로).
        let committed = 0;
        if (processingOptions.bw && selectedPages.size) {
          pageResults.forEach(r => { if (r && !r.isBlank && selectedPages.has(r.pageNum) && !r.appliedBw) { r.appliedBw = true; committed++; } });
          commitClearSelection();
        }

        const conv = base.stats || { converted: 0, errors: 0, errPages: [] };
        let msg = conv.converted > 0
          ? `적용 완료! ${conv.converted}페이지 흑백 변환됨${layoutNote} — '⇩ 다운로드'를 눌러 저장하세요.`
          : `적용 완료! 편집된 PDF(${base.validCount}페이지)${layoutNote} — '⇩ 다운로드'를 눌러 저장하세요.`;
        if (conv.errors > 0)
          msg += `\n⚠️ 주의: ${conv.errors}개 페이지(${conv.errPages.join(', ')})에서 일부 이미지 변환 실패 — 해당 페이지는 부분적으로 칼라가 남아있을 수 있습니다.`;
        if (committed > 0)
          msg += `\n✅ 흑백변환 확정 — 선택은 자동 해제되었고 변환은 유지됩니다. 되돌리려면 ⬛ 흑백변환 체크를 끄세요.`;
        msg += inkNormRiskNote();
        showSuccess(msg);
        // 🕓 적용 시점의 설정을 최근 작업으로 기록 — 1분 주기 스냅샷만 믿으면
        // "적용하고 바로 껐을 때" 임포징·블리드·표지 설정이 통째로 빠진 기록이 남는다.
        if (typeof recordWorkHistory === 'function') { try { recordWorkHistory(); } catch (e) {} }
        // 적용 완료 → 유휴 시간에 다운로드용 최적화본을 미리 생성(다운로드 즉시 저장)
        setTimeout(prewarmOptimizedOutput, 400);
      } catch (err) {
        console.error('편집 적용 오류:', err);
        processedPdfBytes = null; processedFileName = '';
        showError('처리 중 오류: ' + (err && err.message ? err.message : String(err)));
      } finally {
        applying = false;
        setApplyBusy(false);
        updateDownloadBtn();
        hideLoading();
        progressBar.style.display = 'none';
      }
    }

