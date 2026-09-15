// 투명도 쪽 흑백 합성 그룹 — 저장 직전(savePdfDoc)에 앱·조립 워커·편집기·임포징 독립 도구가 함께 쓴다.
//
// 왜: 투명도(SMask·불투명도·혼합 모드·투명도 그룹 폼)는 '페이지 투명도 그룹'의 색공간에서 합성된다.
// 페이지에 /Group이 없으면 gs·프린터 RIP이 기본 출력 색공간에서 섞어, 내용이 전부 DeviceGray여도
// 겹친 부분이 C=M=Y+K 회색으로 나온다 → 프린터가 컬러로 센다(실파일 A1 포맥스: inkcov CMY 0.56,
// 페이지 그룹 DeviceGray를 달면 CMY 0·같은 양이 K로).
// 흑백변환 쪽만 고치면 안 된다 — 임포징·모아찍기가 embedPage로 쪽을 판에 올리면 새 판에는 그룹이 없어
// 같은 문제가 되살아나고, 폼에 그룹을 달아도 소용없다(실측). 그래서 **최종 페이지마다** 저장 직전에 본다.
//
// 언제 다나: ① 페이지 /Group이 없고 ② 투명도를 쓰고 ③ 그리는 색이 전부 무채색(회색·R=G=B·C=M=Y)일 때만.
//   · 투명도 없는 쪽에 그룹을 달면 Acrobat이 인쇄 때 괜히 평탄화한다 → ②
//   · 컬러가 한 점이라도 있으면 회색으로 합성돼 색이 사라진다 → ③ (모르는 색공간·RGB 사진도 '컬러'로 친다)
//   무채색끼리는 회색 공간에서 섞어도 화면 결과가 같다.
(function (root) {
  const EPS = 1.5 / 255;

  function create(PDFLib) {
    const Nm = n => PDFLib.PDFName.of(n);

    function tools(doc) {
      const C = doc.context;
      const look = v => { try { return v && v.objectNumber != null ? C.lookup(v) : v; } catch (e) { return null; } };
      const num = v => { v = look(v); return v == null ? NaN : +(v.numberValue ?? (typeof v.asNumber === 'function' ? v.asNumber() : NaN)); };
      const name = v => { v = look(v); return v && v.encodedName ? v.encodedName : ''; };
      const dictOf = o => o && (o.dict || (typeof o.get === 'function' && typeof o.entries === 'function' ? o : null));
      return { C, look, num, name, dictOf };
    }

    // ── ② 투명도 사용 여부 (사전만 본다 — 스트림을 풀지 않아 빠르다) ──────────────────
    function pageUsesTransparency(doc, pageNode) {
      const { look, num, name, dictOf } = tools(doc);
      const seen = new Set();
      const once = o => { if (!o || seen.has(o)) return false; seen.add(o); return true; };
      const gsTransparent = gs => {
        if (!gs || typeof gs.get !== 'function') return false;
        const sm = look(gs.get(Nm('SMask')));
        if (sm && sm.encodedName !== '/None') return true;
        const ca = num(gs.get(Nm('CA'))), fa = num(gs.get(Nm('ca')));
        if ((ca >= 0 && ca < 1) || (fa >= 0 && fa < 1)) return true;
        let bm = look(gs.get(Nm('BM')));
        if (bm && typeof bm.size === 'function') bm = look(bm.get(0));
        const b = bm && bm.encodedName;
        return !!(b && b !== '/Normal' && b !== '/Compatible');
      };
      const res = (r, depth) => {
        r = look(r);
        if (!r || typeof r.get !== 'function' || depth > 12 || !once(r)) return false;
        const eg = look(r.get(Nm('ExtGState')));
        if (eg && typeof eg.entries === 'function') for (const [, g] of eg.entries()) if (gsTransparent(look(g))) return true;
        for (const key of ['XObject', 'Pattern']) {
          const d = look(r.get(Nm(key)));
          if (!d || typeof d.entries !== 'function') continue;
          for (const [, ref] of d.entries()) if (obj(look(ref), depth + 1)) return true;
        }
        return false;
      };
      const obj = (o, depth) => {
        const dict = dictOf(o);
        if (!dict || !once(o)) return false;
        if (name(dict.get(Nm('Subtype'))) === '/Image') return !!(look(dict.get(Nm('SMask'))) || num(dict.get(Nm('SMaskInData'))) > 0);
        const grp = look(dict.get(Nm('Group')));
        if (grp && typeof grp.get === 'function' && name(grp.get(Nm('S'))) === '/Transparency') return true;
        return res(dict.get(Nm('Resources')), depth);
      };
      try {
        if (res(inheritedResources(doc, pageNode), 0)) return true;
        for (const ap of annotAppearances(doc, pageNode)) if (obj(ap, 1)) return true;
      } catch (e) {}
      return false;
    }

    function inheritedResources(doc, pageNode) {
      const { look } = tools(doc);
      let p = pageNode, r = null, hop = 0;
      while (p && !r && hop++ < 32) { r = p.get(Nm('Resources')); if (!r) p = look(p.get(Nm('Parent'))); }
      return look(r);
    }
    function annotAppearances(doc, pageNode) {
      const { look } = tools(doc);
      const out = [];
      const annots = look(pageNode.get(Nm('Annots')));
      if (!annots || typeof annots.size !== 'function') return out;
      for (let i = 0; i < annots.size(); i++) {
        const a = look(annots.get(i));
        if (!a || typeof a.get !== 'function') continue;
        const ap = look(a.get(Nm('AP')));
        const n = ap && typeof ap.get === 'function' ? look(ap.get(Nm('N'))) : null;
        if (!n) continue;
        if (n.dict) out.push(n);
        else if (typeof n.entries === 'function') for (const [, st] of n.entries()) { const s = look(st); if (s && s.dict) out.push(s); }
      }
      return out;
    }

    // ── ③ 그리는 색이 전부 무채색인가 ───────────────────────────────────────────────
    function pageIsNeutral(doc, pageNode) {
      const { look, num, name, dictOf } = tools(doc);
      const memo = new Map();                  // 스트림·리소스 객체 → 결과 (판마다 같은 폼을 다시 풀지 않게)

      const bytesOf = st => {
        try {
          if (typeof st.getUnencodedContents === 'function') return st.getUnencodedContents();   // pdf-lib이 만든 스트림
          if (st instanceof PDFLib.PDFRawStream) {
            const f = look(st.dict.get(Nm('Filter')));
            if (!f) return st.contents;
            // Flate 단독·예측자 없음이면 pako(네이티브에 가까운 속도) — pdf-lib 내장 inflate는 몇 배 느리다
            if (root.pako && f.encodedName && (f.encodedName === '/FlateDecode' || f.encodedName === '/Fl') && !st.dict.get(Nm('DecodeParms'))) {
              try { return root.pako.inflate(st.contents); } catch (e) {}
            }
            return PDFLib.decodePDFRawStream(st).decode();
          }
        } catch (e) {}
        return null;
      };
      const neutralVals = (vals, kind) => {
        if (kind === 'gray') return true;
        if (kind === 'rgb') return vals.length >= 3 && Math.abs(vals[0] - vals[1]) <= EPS && Math.abs(vals[1] - vals[2]) <= EPS;
        if (kind === 'cmyk') return vals.length >= 4 && Math.abs(vals[0] - vals[1]) <= EPS && Math.abs(vals[1] - vals[2]) <= EPS;
        return false;
      };
      // 색공간 → 'gray' | 'rgb' | 'cmyk' | 'pattern' | 'indexedN'(무채색 팔레트) | 'bad'
      const csKind = (v, res, depth = 0) => {
        v = look(v);
        if (!v || depth > 4) return 'bad';
        if (v.encodedName) {
          const n = v.encodedName;
          if (n === '/DeviceGray' || n === '/CalGray' || n === '/G') return 'gray';
          if (n === '/DeviceRGB' || n === '/CalRGB' || n === '/RGB') return 'rgb';
          if (n === '/DeviceCMYK' || n === '/CMYK') return 'cmyk';
          if (n === '/Pattern') return 'pattern';
          const d = res && look(res.get(Nm('ColorSpace')));
          const def = d && typeof d.get === 'function' ? d.get(Nm(n.slice(1))) : null;
          return def ? csKind(def, null, depth + 1) : 'bad';
        }
        if (typeof v.size !== 'function' || !v.size()) return 'bad';
        const fam = name(v.get(0));
        if (fam === '/CalGray') return 'gray';
        if (fam === '/CalRGB') return 'rgb';
        if (fam === '/Pattern') return 'pattern';
        if (fam === '/ICCBased') {
          const st = look(v.get(1)), N = st && st.dict ? num(st.dict.get(Nm('N'))) : NaN;
          return N === 1 ? 'gray' : N === 3 ? 'rgb' : N === 4 ? 'cmyk' : 'bad';
        }
        if (fam === '/Indexed' || fam === '/I') {
          const base = csKind(v.get(1), res, depth + 1);
          if (base === 'gray') return 'indexedN';
          const nc = base === 'rgb' ? 3 : base === 'cmyk' ? 4 : 0;
          if (!nc) return 'bad';
          const lk = look(v.get(3));
          const pal = lk && typeof lk.asBytes === 'function' ? lk.asBytes() : lk && lk.dict ? bytesOf(lk) : null;
          const hival = num(v.get(2));
          if (!pal || !(hival >= 0) || pal.length < (hival + 1) * nc) return 'bad';
          for (let i = 0; i <= hival; i++) {
            const o = i * nc, vals = [pal[o] / 255, pal[o + 1] / 255, pal[o + 2] / 255, (pal[o + 3] || 0) / 255];
            if (!neutralVals(vals, base)) return 'bad';
          }
          return 'indexedN';
        }
        return 'bad';   // Separation·DeviceN·Lab — 별색은 잉크이므로 무채색으로 치지 않는다
      };
      const imageNeutral = img => {
        const d = img.dict;
        const im = look(d.get(Nm('ImageMask')));
        if (im && (im === PDFLib.PDFBool.True || String(im) === 'true')) return true;
        const cs = d.get(Nm('ColorSpace'));
        if (!cs) return false;                           // JPX 등 스트림 안 색공간 — 모른다
        const k = csKind(cs, null);
        return k === 'gray' || k === 'indexedN';
      };
      const shadingNeutral = sh => {
        const d = dictOf(look(sh));
        if (!d) return false;
        const k = csKind(d.get(Nm('ColorSpace')), null);
        return k === 'gray';
      };
      const patternNeutral = (pat, vals, depth) => {
        pat = look(pat);
        const d = dictOf(pat);
        if (!d) return false;
        const pt = num(d.get(Nm('PatternType')));
        if (pt === 2) return shadingNeutral(d.get(Nm('Shading')));
        if (pt === 1) {
          if (num(d.get(Nm('PaintType'))) === 2 && vals.length > 1) return false;   // 무색 타일 + 기저 색 — 모른다
          return streamNeutral(pat, look(d.get(Nm('Resources'))), depth + 1);
        }
        return false;
      };

      // 콘텐츠 스트림 훑기 — 연산자 순서대로 색공간·색 값을 따라간다
      function streamNeutral(st, res, depth) {
        if (!st || depth > 12) return false;
        const key = st;
        if (memo.has(key)) return memo.get(key);
        memo.set(key, true);                            // 순환 참조는 '문제 없음'으로 끊는다(실제 판정은 첫 방문이 한다)
        const ok = scan(st, res, depth);
        memo.set(key, ok);
        return ok;
      }
      // 바이트 분류표 — 1 공백, 2 구분자
      const CLS = (() => { const t = new Uint8Array(256); [0, 9, 10, 12, 13, 32].forEach(c => { t[c] = 1; }); [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].forEach(c => { t[c] = 2; }); return t; })();
      const opKey = (a, b, c) => a | (b << 8) | (c << 16);
      const K = s => opKey(s.charCodeAt(0) || 0, s.charCodeAt(1) || 0, s.charCodeAt(2) || 0);
      const OP = { q: K('q'), Q: K('Q'), g: K('g'), G: K('G'), rg: K('rg'), RG: K('RG'), k: K('k'), Kk: K('K'), cs: K('cs'), CS: K('CS'),
        sc: K('sc'), scn: K('scn'), SC: K('SC'), SCN: K('SCN'), sh: K('sh'), Do: K('Do'), Tf: K('Tf'), BI: K('BI') };
      function scan(st, res, depth) {
        const bytes = bytesOf(st);
        if (!bytes) return false;
        const L = bytes.length;
        // 피연산자: 마지막 숫자 8개(원형)·연속 숫자 개수·마지막 이름 두 개(시작·끝 위치) — 토큰마다 문자열을 만들지 않는다
        const nb = new Float64Array(8); let nCount = 0;
        let nameS = -1, nameE = -1, prevS = -1, prevE = -1;
        const lastNums = n => { if (nCount < n) return null; const out = new Array(n); for (let k = 0; k < n; k++) out[k] = nb[(nCount - n + k) & 7]; return out; };
        const nameStr = (s, e) => { let r = ''; for (let k = s + 1; k < e; k++) r += String.fromCharCode(bytes[k]); return r; };
        let fill = 'gray', stroke = 'gray';
        const stack = [];
        const xobjs = res && look(res.get(Nm('XObject')));
        const pats = res && look(res.get(Nm('Pattern')));
        const shds = res && look(res.get(Nm('Shading')));
        const fonts = res && look(res.get(Nm('Font')));
        const reset = () => { nCount = 0; nameS = nameE = prevS = prevE = -1; };
        let i = 0;
        while (i < L) {
          const c = bytes[i], cl = CLS[c];
          if (cl === 1) { i++; continue; }
          if (cl === 2) {
            if (c === 37) { while (i < L && bytes[i] !== 10 && bytes[i] !== 13) i++; continue; }            // % 주석
            if (c === 40) {                                                                                  // (문자열)
              let dp = 1; i++;
              while (i < L && dp) { const b = bytes[i]; if (b === 92) i += 2; else { if (b === 40) dp++; else if (b === 41) dp--; i++; } }
              nCount = 0; continue;
            }
            if (c === 60 && bytes[i + 1] !== 60) { while (i < L && bytes[i] !== 62) i++; i++; nCount = 0; continue; }   // <16진>
            if (c === 47) {                                                                                  // /이름
              let j = i + 1; while (j < L && CLS[bytes[j]] === 0) j++;
              prevS = nameS; prevE = nameE; nameS = i; nameE = j; nCount = 0; i = j; continue;
            }
            i += (c === 60 || c === 62) ? 2 : 1;                                                             // << >> [ ] { }
            continue;
          }
          let j = i + 1; while (j < L && CLS[bytes[j]] === 0) j++;
          // 숫자?
          if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
            let v = 0, sign = 1, k = i, frac = 0, scale = 1, ok = true;
            if (bytes[k] === 45) { sign = -1; k++; } else if (bytes[k] === 43) k++;
            for (; k < j; k++) {
              const b = bytes[k];
              if (b >= 48 && b <= 57) { if (frac) { scale /= 10; v += (b - 48) * scale; } else v = v * 10 + (b - 48); }
              else if (b === 46 && !frac) frac = 1;
              else { ok = false; break; }
            }
            if (ok) { nb[nCount & 7] = sign * v; nCount++; i = j; continue; }
          }
          const len = j - i;
          const key = len <= 3 ? opKey(c, len > 1 ? bytes[i + 1] : 0, len > 2 ? bytes[i + 2] : 0) : -1;
          i = j;
          switch (key) {
            case OP.q: stack.push([fill, stroke]); break;
            case OP.Q: if (stack.length) [fill, stroke] = stack.pop(); break;
            case OP.g: fill = 'gray'; break;
            case OP.G: stroke = 'gray'; break;
            case OP.rg: case OP.RG: if (!neutralVals(lastNums(3) || [], 'rgb')) return false; if (key === OP.rg) fill = 'rgb'; else stroke = 'rgb'; break;
            case OP.k: case OP.Kk: if (!neutralVals(lastNums(4) || [], 'cmyk')) return false; if (key === OP.k) fill = 'cmyk'; else stroke = 'cmyk'; break;
            case OP.cs: case OP.CS: {
              const kd = nameS >= 0 ? csKind(Nm(nameStr(nameS, nameE)), res) : 'bad';
              if (key === OP.cs) fill = kd; else stroke = kd;
              break;
            }
            case OP.sc: case OP.scn: case OP.SC: case OP.SCN: {
              const kind = key === OP.sc || key === OP.scn ? fill : stroke;
              if (kind === 'pattern') {
                if (nameS < 0) return false;
                const vals = new Array(Math.min(nCount, 8)).fill(0);
                if (!pats || !patternNeutral(pats.get(Nm(nameStr(nameS, nameE))), vals, depth)) return false;
              } else if (kind !== 'indexedN' && kind !== 'gray') {
                const n = kind === 'rgb' ? 3 : kind === 'cmyk' ? 4 : 0;
                if (!n || !neutralVals(lastNums(n) || [], kind)) return false;
              }
              break;
            }
            case OP.sh:
              if (nameS < 0 || !shds || !shadingNeutral(shds.get(Nm(nameStr(nameS, nameE))))) return false;
              break;
            case OP.Do: {
              const x = nameS >= 0 && xobjs ? look(xobjs.get(Nm(nameStr(nameS, nameE)))) : null;
              if (!x || !x.dict) return false;
              const sub = name(x.dict.get(Nm('Subtype')));
              if (sub === '/Image') { if (!imageNeutral(x)) return false; }
              else if (sub === '/Form') { if (!streamNeutral(x, look(x.dict.get(Nm('Resources'))) || res, depth + 1)) return false; }
              else if (sub !== '/PS') return false;
              break;
            }
            case OP.Tf: {                                   // Type3 글꼴은 글리프 절차가 색을 칠할 수 있다
              const f = nameS >= 0 && fonts ? look(fonts.get(Nm(nameStr(nameS, nameE)))) : null;
              if (f && typeof f.get === 'function' && name(f.get(Nm('Subtype'))) === '/Type3') {
                const procs = look(f.get(Nm('CharProcs')));
                const fres = look(f.get(Nm('Resources'))) || res;
                if (procs && typeof procs.entries === 'function') for (const [, p] of procs.entries()) if (!streamNeutral(look(p), fres, depth + 1)) return false;
              }
              break;
            }
            case OP.BI: {                                   // 인라인 이미지 — 사전만 읽고 데이터는 건너뛴다
              let csTok = null, mask = false;
              const parts = [];
              while (i < L) {
                while (i < L && CLS[bytes[i]] === 1) i++;
                if (bytes[i] === 73 && bytes[i + 1] === 68 && (i + 2 >= L || CLS[bytes[i + 2]] === 1)) { i += 3; break; }   // ID
                let e = i + 1; while (e < L && CLS[bytes[e]] !== 1 && !(bytes[e] === 47 && e > i)) e++;
                let t = ''; for (let k = i; k < e; k++) t += String.fromCharCode(bytes[k]);
                parts.push(t); i = e;
                if (parts.length > 200) return false;
              }
              for (let p = 0; p + 1 < parts.length; p++) {
                if (parts[p] === '/CS' || parts[p] === '/ColorSpace') csTok = parts[p + 1];
                // 사전 안 Indexed 배열 '/CS [/I /G 1 <…>]' — 기저가 회색이면 무채색(흑백변환이 색상표를 이렇게 바꾼다)
                const arrAt = /^\/(CS|ColorSpace)\[$/.test(parts[p]) ? p + 1 : (/^\/(CS|ColorSpace)$/.test(parts[p]) && parts[p + 1] === '[') ? p + 2 : -1;
                if (arrAt > 0 && /^\/(I|Indexed)$/.test(parts[arrAt] || '') && /^\/(G|DeviceGray)$/.test(parts[arrAt + 1] || '')) csTok = '/DeviceGray';
                if ((parts[p] === '/IM' || parts[p] === '/ImageMask') && parts[p + 1] === 'true') mask = true;
              }
              if (!mask) {
                if (!csTok || !csTok.startsWith('/')) return false;
                const kd = csKind(Nm(csTok.slice(1)), res);
                if (kd !== 'gray' && kd !== 'indexedN') return false;
              }
              let found = -1;                                              // 첫 '공백 EI 공백'
              for (let k = i; k + 1 < L; k++) {
                if (bytes[k] === 69 && bytes[k + 1] === 73 && k > 0 && CLS[bytes[k - 1]] === 1 && (k + 2 >= L || CLS[bytes[k + 2]] === 1)) { found = k + 2; break; }
              }
              if (found < 0) return false;
              i = found;
              break;
            }
            default: break;
          }
          reset();
        }
        return true;
      }

      try {
        const res = inheritedResources(doc, pageNode);
        let contents = look(pageNode.get(Nm('Contents')));
        const list = !contents ? [] : typeof contents.size === 'function' ? contents.asArray().map(look) : [contents];
        if (list.length > 1) {                     // 여러 조각은 이어서 하나의 스트림처럼 읽는다
          const parts = list.map(bytesOf);
          if (parts.some(p => !p)) return false;
          const total = parts.reduce((s, p) => s + p.length + 1, 0);
          const joined = new Uint8Array(total); let o = 0;
          for (const p of parts) { joined.set(p, o); o += p.length; joined[o++] = 10; }
          if (!streamNeutral({ getUnencodedContents: () => joined }, res, 0)) return false;
        } else if (list.length === 1 && !streamNeutral(list[0], res, 0)) return false;
        for (const ap of annotAppearances(doc, pageNode)) if (!streamNeutral(ap, look(ap.dict.get(Nm('Resources'))), 1)) return false;
        return true;
      } catch (e) { return false; }
    }

    // ── 저장 직전 호출 ─────────────────────────────────────────────────────────────
    async function addGrayBlendGroups(doc) {
      let added = 0;
      try {
        if (!doc || typeof doc.getPages !== 'function') return 0;
        await doc.flush();                          // embedPage 폼·이미지를 문서에 넣어야 판 내용을 볼 수 있다
        for (const page of doc.getPages()) {
          const node = page.node;
          if (node.get(Nm('Group'))) continue;
          if (!pageUsesTransparency(doc, node)) continue;
          if (!pageIsNeutral(doc, node)) continue;
          node.set(Nm('Group'), doc.context.obj({ Type: 'Group', S: 'Transparency', CS: 'DeviceGray' }));
          added++;
        }
      } catch (e) {}
      return added;
    }

    return { pageUsesTransparency, pageIsNeutral, addGrayBlendGroups };
  }

  if (root.PDFLib) {                              // 창·워커: pdf-lib 스크립트를 먼저 싣는다
    const api = create(root.PDFLib);
    root.pageUsesTransparency = api.pageUsesTransparency;
    root.pageIsNeutral = api.pageIsNeutral;
    root.addGrayBlendGroups = api.addGrayBlendGroups;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
