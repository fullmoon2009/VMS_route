// ==UserScript==
// @name         NaverMap Place Search
// @namespace    local
// @version      1.1.2
// @description  Draggable POI search overlay. Uses local proxy (127.0.0.1:8770/place) and FORCE-moves Naver map to selected result.
// @match        http://10.10.20.199:8190/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/fullmoon2009/VMS-route/main/tampermonkey/naverMapPlaceSearch.user.js
// @downloadURL  https://raw.githubusercontent.com/fullmoon2009/VMS-route/main/tampermonkey/naverMapPlaceSearch.user.js
// ==/UserScript==

(function () {
	'use strict';

	const OVERLAY_ID = '__naver_place_overlay__';
	const MAP_HOLDER_KEY = '__NAVER_MAP__';
	const POS_KEY = '__naver_place_overlay_pos__';

	const PROXY_BASE = 'http://127.0.0.1:8770';
	const PROXY_ENDPOINT = '/place';

	const DISPLAY_N = 7;
	const AUTO_PAN_FIRST = true;

	const FORCE_MS = 2500;
	const FORCE_INTERVAL = 60;

	const DEBUG_LOG = true;
	const DEBUG_COORD_TIMEOUT_MS = 700;

	function sleep(ms) {
		return new Promise(r => setTimeout(r, ms));
	}
	function log(...a) {
		if (DEBUG_LOG) console.log('[place-inject]', ...a);
	}
	function warn(...a) {
		console.warn('[place-inject]', ...a);
	}

	function looksLikeNaverMap(obj) {
		return (
			obj &&
			typeof obj.setCenter === 'function' &&
			typeof obj.panTo === 'function' &&
			typeof obj.getCenter === 'function' &&
			typeof obj.getZoom === 'function'
		);
	}

	function setCapturedMap(m, why) {
		if (!m || !looksLikeNaverMap(m)) return false;
		window[MAP_HOLDER_KEY] = m;
		log('map captured:', why);
		return true;
	}

	function getCapturedMap() {
		const m = window[MAP_HOLDER_KEY];
		return looksLikeNaverMap(m) ? m : null;
	}

	function installNaverSetterHook() {
		if (window.__NAVER_SETTER_HOOKED__) return;
		window.__NAVER_SETTER_HOOKED__ = true;

		let _naver = window.naver;

		Object.defineProperty(window, 'naver', {
			configurable: true,
			enumerable: true,
			get() {
				return _naver;
			},
			set(v) {
				_naver = v;
				tryHookMapConstructor('setter');
			},
		});

		if (_naver) tryHookMapConstructor('setter-initial');
	}

	function tryHookMapConstructor(tag) {
		const n = window.naver;
		if (!n || !n.maps || !n.maps.Map) return false;

		const OrigMap = n.maps.Map;
		if (OrigMap.__hooked_by_userscript__) return true;

		function WrappedMap(...args) {
			const inst = Reflect.construct(OrigMap, args, new.target);
			setCapturedMap(inst, `Map() construct (${tag})`);
			return inst;
		}

		WrappedMap.prototype = OrigMap.prototype;
		Object.setPrototypeOf(WrappedMap, OrigMap);

		for (const k of Object.getOwnPropertyNames(OrigMap)) {
			if (k === 'prototype') continue;
			try {
				Object.defineProperty(
					WrappedMap,
					k,
					Object.getOwnPropertyDescriptor(OrigMap, k),
				);
			} catch {}
		}

		WrappedMap.__hooked_by_userscript__ = true;
		n.maps.Map = WrappedMap;
		log('hooked naver.maps.Map constructor:', tag);
		return true;
	}

	function findMapViaVue() {
		const el = document.querySelector('#map');
		if (!el) return null;

		const comp3 = el.__vueParentComponent;
		if (comp3) {
			const found = deepFindMapInObject(comp3, 7);
			if (found) return found;
			if (comp3.proxy) {
				const found2 = deepFindMapInObject(comp3.proxy, 7);
				if (found2) return found2;
			}
		}

		const comp2 = el.__vue__;
		if (comp2) {
			const found3 = deepFindMapInObject(comp2, 7);
			if (found3) return found3;
		}

		let cur = el;
		for (let i = 0; i < 8 && cur; i++) {
			const c3 = cur.__vueParentComponent;
			if (c3) {
				const f = deepFindMapInObject(c3, 7);
				if (f) return f;
				if (c3.proxy) {
					const f2 = deepFindMapInObject(c3.proxy, 7);
					if (f2) return f2;
				}
			}
			const c2 = cur.__vue__;
			if (c2) {
				const f3 = deepFindMapInObject(c2, 7);
				if (f3) return f3;
			}
			cur = cur.parentElement;
		}

		return null;
	}

	function deepFindMapInObject(root, depthLimit) {
		const seen = new Set();

		function rec(obj, depth) {
			if (!obj || depth > depthLimit) return null;
			if (looksLikeNaverMap(obj)) return obj;
			if (typeof obj !== 'object' && typeof obj !== 'function') return null;
			if (seen.has(obj)) return null;
			seen.add(obj);

			if (Array.isArray(obj)) {
				for (const v of obj) {
					const r = rec(v, depth + 1);
					if (r) return r;
				}
				return null;
			}

			let keys;
			try {
				keys = Object.keys(obj);
			} catch {
				return null;
			}
			if (!keys) return null;

			const priority = [
				'map',
				'naverMap',
				'nMap',
				'nm',
				'mapObj',
				'mapInstance',
				'oMap',
				'm',
			];
			for (const k of priority) {
				if (k in obj) {
					const r = rec(obj[k], depth + 1);
					if (r) return r;
				}
			}

			for (let i = 0; i < keys.length && i < 300; i++) {
				const k = keys[i];
				let v;
				try {
					v = obj[k];
				} catch {
					continue;
				}
				const r = rec(v, depth + 1);
				if (r) return r;
			}

			return null;
		}

		return rec(root, 0);
	}

	async function ensureMapCaptured() {
		let m = getCapturedMap();
		if (m) return m;

		for (let i = 0; i < 220; i++) {
			if (window.naver?.maps) {
				tryHookMapConstructor('ensure');
				break;
			}
			await sleep(50);
		}

		for (let i = 0; i < 60; i++) {
			m = getCapturedMap();
			if (m) return m;

			const v = findMapViaVue();
			if (v && setCapturedMap(v, 'Vue fallback')) return v;

			await sleep(100);
		}

		return null;
	}

	function clamp(v, lo, hi) {
		return Math.max(lo, Math.min(hi, v));
	}

	function loadSavedPos() {
		try {
			const raw = localStorage.getItem(POS_KEY);
			if (!raw) return null;
			const obj = JSON.parse(raw);
			if (!obj || typeof obj.x !== 'number' || typeof obj.y !== 'number')
				return null;
			return obj;
		} catch {
			return null;
		}
	}

	function savePos(x, y) {
		try {
			localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
		} catch {}
	}

	function makeDraggable(wrap, handle) {
		let dragging = false;
		let startX = 0,
			startY = 0;
		let baseX = 0,
			baseY = 0;

		function getXY() {
			const x = parseFloat(wrap.style.left || '0') || 0;
			const y = parseFloat(wrap.style.top || '0') || 0;
			return { x, y };
		}

		function onDown(e) {
			if (
				e.target &&
				(e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON')
			)
				return;
			dragging = true;
			const pt = e.touches && e.touches[0] ? e.touches[0] : e;
			startX = pt.clientX;
			startY = pt.clientY;
			const cur = getXY();
			baseX = cur.x;
			baseY = cur.y;
			wrap.style.transition = 'none';
			e.preventDefault();
		}

		function onMove(e) {
			if (!dragging) return;
			const pt = e.touches && e.touches[0] ? e.touches[0] : e;
			const dx = pt.clientX - startX;
			const dy = pt.clientY - startY;

			const vw = Math.max(
				document.documentElement.clientWidth,
				window.innerWidth || 0,
			);
			const vh = Math.max(
				document.documentElement.clientHeight,
				window.innerHeight || 0,
			);

			const rect = wrap.getBoundingClientRect();
			const maxX = vw - rect.width;
			const maxY = vh - rect.height;

			const nx = clamp(baseX + dx, 0, maxX);
			const ny = clamp(baseY + dy, 0, maxY);

			wrap.style.left = `${nx}px`;
			wrap.style.top = `${ny}px`;
			wrap.style.right = 'auto';
			e.preventDefault();
		}

		function onUp() {
			if (!dragging) return;
			dragging = false;
			wrap.style.transition = '';
			const rect = wrap.getBoundingClientRect();
			savePos(rect.left, rect.top);
		}

		handle.addEventListener('mousedown', onDown, { passive: false });
		window.addEventListener('mousemove', onMove, { passive: false });
		window.addEventListener('mouseup', onUp, { passive: true });

		handle.addEventListener('touchstart', onDown, { passive: false });
		window.addEventListener('touchmove', onMove, { passive: false });
		window.addEventListener('touchend', onUp, { passive: true });
	}

	function ensureOverlayUI() {
		if (document.getElementById(OVERLAY_ID)) return;

		const wrap = document.createElement('div');
		wrap.id = OVERLAY_ID;

		const saved = loadSavedPos();
		wrap.style.cssText = `
      position: fixed;
      z-index: 999999;
      background: rgba(20,20,20,0.92);
      color: #fff;
      padding: 10px;
      border-radius: 10px;
      font: 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto;
      box-shadow: 0 6px 24px rgba(0,0,0,0.35);
      width: 380px;
      user-select: none;
    `;

		if (saved) {
			wrap.style.left = `${saved.x}px`;
			wrap.style.top = `${saved.y}px`;
			wrap.style.right = 'auto';
		} else {
			wrap.style.top = '12px';
			wrap.style.right = '12px';
		}

		wrap.innerHTML = `
      <div id="__hdr__" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;cursor:move;">
        <div style="font-weight:700;">장소 검색</div>
        <div style="display:flex; gap:6px;">
          <button id="__ping__" style="border:1px solid #444;background:#222;color:#fff;border-radius:8px;padding:4px 8px;cursor:pointer;">Ping</button>
          <button id="__reset__" style="border:1px solid #444;background:#222;color:#fff;border-radius:8px;padding:4px 8px;cursor:pointer;">Reset</button>
        </div>
      </div>

      <div style="display:flex; gap:6px; align-items:center;">
        <input id="__q__" placeholder="예: 통일로사거리 / 서울역 / 시청"
               style="flex:1; padding:8px; border-radius:8px; border:1px solid #444; outline:none; background:#111; color:#fff; user-select:text;">
        <button id="__go__" style="padding:8px 10px; border-radius:8px; border:1px solid #444; background:#222; color:#fff; cursor:pointer;">검색</button>
      </div>

      <div id="__msg__" style="margin-top:8px; opacity:0.9; word-break:break-word; user-select:text;"></div>

      <div id="__list__" style="
        margin-top:8px;
        max-height: 260px;
        overflow:auto;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 8px;
        padding: 6px;
        display:none;
      "></div>

      <div style="margin-top:8px; opacity:0.75; user-select:text;">
        proxy: <span style="opacity:0.9">${PROXY_BASE}${PROXY_ENDPOINT}</span><br>
      </div>
    `;

		document.addEventListener(
			'DOMContentLoaded',
			() => {
				document.body.appendChild(wrap);

				const hdr = document.getElementById('__hdr__');
				if (hdr) makeDraggable(wrap, hdr);

				document.getElementById('__reset__')?.addEventListener('click', () => {
					localStorage.removeItem(POS_KEY);
					wrap.style.left = 'auto';
					wrap.style.top = '12px';
					wrap.style.right = '12px';
					setMsg('위치 초기화됨');
				});

				document
					.getElementById('__ping__')
					?.addEventListener('click', async () => {
						setMsg('map 확보 중');
						const map = await ensureMapCaptured();
						if (!map) {
							setMsg('map 캡처 실패');
							return;
						}
						try {
							const c = map.getCenter();
							setMsg(
								`map OK (center: ${c.y.toFixed(6)}, ${c.x.toFixed(
									6,
								)} / zoom: ${map.getZoom()})`,
							);
						} catch {
							setMsg('map OK');
						}
					});

				bindUI();
				setMsg('준비됨, 검색어 입력 후 검색');
			},
			{ once: true },
		);
	}

	function setMsg(s) {
		const el = document.getElementById('__msg__');
		if (el) el.textContent = s || '';
	}

	function setListHTML(html) {
		const el = document.getElementById('__list__');
		if (!el) return;
		el.innerHTML = html;
		el.style.display = html ? 'block' : 'none';
	}

	async function proxyPlaceSearch(query) {
		const url = `${PROXY_BASE}${PROXY_ENDPOINT}?q=${encodeURIComponent(
			query,
		)}&display=${DISPLAY_N}`;
		const r = await fetch(url, { method: 'GET' });
		return await r.json();
	}

	function stripHtml(s) {
		return (s || '').replace(/<[^>]*>/g, '').trim();
	}

	let marker = null;

	function ensureMarker(map, latlng) {
		try {
			if (!marker) marker = new naver.maps.Marker({ position: latlng, map });
			else {
				marker.setPosition(latlng);
				marker.setMap(map);
			}
		} catch {}
	}

	function forceMoveMap(map, latlng, label) {
		log('forceMoveMap called:', label, latlng?.toString?.(), latlng);

		try {
			map.setCenter(latlng);
		} catch (e) {
			warn('setCenter err', e);
		}
		try {
			map.panTo(latlng);
		} catch (e) {
			warn('panTo err', e);
		}

		const start = Date.now();
		const t = setInterval(() => {
			try {
				map.setCenter(latlng);
			} catch {}
			try {
				map.panTo(latlng);
			} catch {}
			if (Date.now() - start > FORCE_MS) clearInterval(t);
		}, FORCE_INTERVAL);

		ensureMarker(map, latlng);
		setMsg(`✅ ${label || '이동'}`);
	}

	function mapxyToLatLng(mapx, mapy, cb) {
		const lng1 = mapx / 1e7;
		const lat1 = mapy / 1e7;

		if (
			Number.isFinite(lat1) &&
			Number.isFinite(lng1) &&
			Math.abs(lat1) <= 90 &&
			Math.abs(lng1) <= 180 &&
			!(Math.abs(lat1) < 0.0001 && Math.abs(lng1) < 0.0001)
		) {
			const ll = new naver.maps.LatLng(lat1, lng1);
			log('mapxyToLatLng: using WGS84*1e7', {
				mapx,
				mapy,
				lat: lat1,
				lng: lng1,
			});
			cb(ll);
			return;
		}

		if (
			!window.naver?.maps?.TransCoord ||
			!window.naver?.maps?.Point ||
			!window.naver?.maps?.LatLng
		) {
			warn('mapxyToLatLng: TransCoord not available, cannot fallback');
			cb(null);
			return;
		}

		let fired = false;
		try {
			const pt = new naver.maps.Point(mapx, mapy);
			log('mapxyToLatLng: fallback TM128 input:', mapx, mapy, pt);

			const ret = naver.maps.TransCoord.fromTM128ToLatLng(pt, function (v) {
				fired = true;
				log('mapxyToLatLng: TM128 cb fired:', v);

				if (v && typeof v.lat === 'function' && typeof v.lng === 'function') {
					cb(v);
					return;
				}
				if (v && typeof v.x === 'number' && typeof v.y === 'number') {
					cb(new naver.maps.LatLng(v.y, v.x));
					return;
				}
				cb(null);
			});

			if (
				ret &&
				typeof ret.lat === 'function' &&
				typeof ret.lng === 'function'
			) {
				fired = true;
				cb(ret);
				return;
			}
			if (ret && typeof ret.x === 'number' && typeof ret.y === 'number') {
				fired = true;
				cb(new naver.maps.LatLng(ret.y, ret.x));
				return;
			}

			setTimeout(() => {
				if (!fired)
					warn('mapxyToLatLng: TM128 callback not fired (SDK variant?)');
			}, DEBUG_COORD_TIMEOUT_MS);
		} catch (e) {
			warn('mapxyToLatLng: TM128 error:', e);
			cb(null);
		}
	}

	function renderResults(items, onPick) {
		if (!items || !items.length) {
			setListHTML('');
			return;
		}

		const rows = items
			.map((it, idx) => {
				const title = stripHtml(it.title) || '(no title)';
				const addr = (it.roadAddress || it.address || '').trim();
				const mx = it.mapx;
				const my = it.mapy;
				return `
        <div data-idx="${idx}" style="
          padding:8px;
          border-radius:8px;
          border:1px solid rgba(255,255,255,0.10);
          margin-bottom:6px;
          cursor:pointer;
          background: rgba(255,255,255,0.04);
        ">
          <div style="font-weight:700; user-select:text;">${title}</div>
          <div style="opacity:0.85; margin-top:3px; user-select:text;">${addr}</div>
          <div style="opacity:0.65; margin-top:3px; font-size:11px; user-select:text;">mapx/mapy: ${mx}, ${my}</div>
        </div>
      `;
			})
			.join('');

		setListHTML(rows);

		const listEl = document.getElementById('__list__');
		if (!listEl) return;

		listEl.onclick = e => {
			const box = e.target?.closest?.('[data-idx]');
			if (!box) return;
			const idx = parseInt(box.getAttribute('data-idx'), 10);
			if (!Number.isFinite(idx)) return;
			onPick(items[idx], idx);
		};
	}

	async function doSearchAndMove(query) {
		query = (query || '').trim();
		if (!query) return;

		setMsg('map 확보 중...');
		const map = await ensureMapCaptured();
		if (!map) {
			setMsg('map 인스턴스 캡처 실패 (iframe 가능성/접근 차단)');
			return;
		}

		setMsg('로컬 프록시로 장소 검색 중...');
		setListHTML('');

		let res;
		try {
			res = await proxyPlaceSearch(query);
		} catch (e) {
			setMsg('place proxy 호출 실패 (서버 실행/포트 확인)');
			return;
		}

		if (!res || res.ok !== true) {
			setMsg(`검색 실패: ${res?.error || 'unknown'} (프록시/키 설정 확인)`);
			return;
		}

		const items = res.items || [];
		if (!items.length) {
			setMsg('결과 없음');
			setListHTML('');
			return;
		}

		renderResults(items, (it, idx) => {
			const title =
				stripHtml(it.title) || it.roadAddress || it.address || query;
			const mapx = parseFloat(it.mapx);
			const mapy = parseFloat(it.mapy);

			if (!Number.isFinite(mapx) || !Number.isFinite(mapy)) {
				setMsg('좌표(mapx/mapy) 파싱 실패');
				return;
			}

			setMsg(`이동 중... (${idx + 1}/${items.length})`);
			mapxyToLatLng(mapx, mapy, latlng => {
				if (!latlng) {
					setMsg('좌표 변환 실패');
					return;
				}
				forceMoveMap(map, latlng, title);
			});
		});

		if (AUTO_PAN_FIRST) {
			const it = items[0];
			const title =
				stripHtml(it.title) || it.roadAddress || it.address || query;
			const mapx = parseFloat(it.mapx);
			const mapy = parseFloat(it.mapy);

			if (Number.isFinite(mapx) && Number.isFinite(mapy)) {
				setMsg('첫 결과로 이동 중');
				mapxyToLatLng(mapx, mapy, latlng => {
					if (!latlng) {
						setMsg('좌표 변환 실패');
						return;
					}
					forceMoveMap(map, latlng, title);
				});
			} else {
				setMsg(`${items.length}개 결과. 목록에서 클릭해 이동.`);
			}
		} else {
			setMsg(`${items.length}개 결과. 목록에서 클릭해 이동.`);
		}
	}

	function bindUI() {
		const q = document.getElementById('__q__');
		const btn = document.getElementById('__go__');
		if (!q || !btn) return;

		btn.addEventListener('click', () => doSearchAndMove(q.value));
		q.addEventListener('keydown', e => {
			if (e.key === 'Enter') doSearchAndMove(q.value);
		});
	}

	installNaverSetterHook();
	tryHookMapConstructor('boot');
	ensureOverlayUI();
})();
