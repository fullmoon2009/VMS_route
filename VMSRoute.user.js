// ==UserScript==
// @name         VMS Route Search
// @namespace    https://github.com/fullmoon2009/VMS_route/vms
// @version      1.5
// @match        http://10.10.20.199:8008/facilitiesProperty/vms/ifsc*
// @updateURL    https://raw.githubusercontent.com/fullmoon2009/VMS_route/main/tampermonkey/VMSRoute.user.js
// @downloadURL  https://raw.githubusercontent.com/fullmoon2009/VMS_route/main/tampermonkey/VMSRoute.user.js
// ==/UserScript==


(() => {
	const ADD_PATH = '/fac/property/vmsIfsc/add';
	const UPDATE_PATH = '/fac/property/vmsIfsc/update';
	const UPDATE_URL = 'http://10.10.20.199:8008/fac/property/vmsIfsc/update';

	const ROUTE_API = 'http://127.0.0.1:8766/route';
	const POS_KEY = 'VMS_UI_POS_ROUTE_V3';

	const EDIT_BTN_SEL = 'button.mti';
	const SAVE_BTN_SEL = 'button.save';

	const COMMON_HEADERS = {
		accept: '*/*',
		'content-type': 'application/json; charset=UTF-8',
		'x-custom-header': 'foobar',
	};

	const REUSE_LS_KEY = 'VMS_REUSE_CACHE_V1';
	const CACHE_MAX = 2000;

	const KEY_START_NM = 'dsplStrtNodeNm';
	const KEY_END_NM = 'dsplEndNodeNm';
	const KEY_VMS_ID = 'vmsIfscId';

	const state = {
		enabled: true,
		endLinkId: '',
		delayMs: 200,
		maxVisits: 2000000,
		lastKey: '',
		lastAt: 0,
		dedupeMs: 1500,

		reuseEnabled: true,
		reuseUndirected: false,

		protectManualExpanded: true,
	};

	let reuseCache = new Map();

	function log(...a) {
		console.log('[vms-route]', ...a);
	}

	function loadReuseCache() {
		try {
			const raw = localStorage.getItem(REUSE_LS_KEY);
			if (!raw) return;
			const obj = JSON.parse(raw);
			if (!obj || typeof obj !== 'object') return;
			reuseCache = new Map(Object.entries(obj));
		} catch (e) {
			console.warn('[vms-route] cache load failed', e);
			reuseCache = new Map();
		}
	}

	function persistReuseCache() {
		try {
			const obj = Object.fromEntries(reuseCache.entries());
			localStorage.setItem(REUSE_LS_KEY, JSON.stringify(obj));
		} catch (e) {
			console.warn('[vms-route] cache save failed', e);
		}
	}

	loadReuseCache();

	function el(tag, attrs = {}, children = []) {
		const e = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (k === 'style') Object.assign(e.style, v);
			else if (k.startsWith('on') && typeof v === 'function')
				e.addEventListener(k.slice(2), v);
			else if (k === 'checked') e.checked = !!v;
			else if (k === 'value') e.value = v;
			else e.setAttribute(k, v);
		}
		for (const c of children)
			e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
		return e;
	}

	function toast(msg) {
		const t = el(
			'div',
			{
				style: {
					position: 'fixed',
					right: '16px',
					bottom: '16px',
					zIndex: 999999,
					background: '#111',
					color: '#fff',
					padding: '10px 12px',
					borderRadius: '10px',
					boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
					fontSize: '12px',
					maxWidth: '560px',
					whiteSpace: 'pre-wrap',
				},
			},
			[msg],
		);
		document.body.appendChild(t);
		setTimeout(() => t.remove(), 3500);
	}

	function makeDraggablePersist(panel, handle, key = POS_KEY) {
		try {
			const saved = JSON.parse(localStorage.getItem(key) || 'null');
			if (
				saved &&
				typeof saved.left === 'number' &&
				typeof saved.top === 'number'
			) {
				panel.style.left = saved.left + 'px';
				panel.style.top = saved.top + 'px';
				panel.style.right = 'auto';
				panel.style.bottom = 'auto';
			}
		} catch {}

		panel.style.right = 'auto';
		panel.style.bottom = 'auto';
		if (!panel.style.left) panel.style.left = panel.offsetLeft + 'px';
		if (!panel.style.top) panel.style.top = panel.offsetTop + 'px';

		let dragging = false;
		let startX = 0,
			startY = 0,
			startLeft = 0,
			startTop = 0;

		handle.style.cursor = 'move';
		handle.style.userSelect = 'none';

		handle.addEventListener('mousedown', e => {
			dragging = true;
			startX = e.clientX;
			startY = e.clientY;
			startLeft = parseInt(panel.style.left, 10) || 0;
			startTop = parseInt(panel.style.top, 10) || 0;
			e.preventDefault();
		});

		window.addEventListener('mousemove', e => {
			if (!dragging) return;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			const newLeft = Math.max(
				0,
				Math.min(window.innerWidth - panel.offsetWidth, startLeft + dx),
			);
			const newTop = Math.max(
				0,
				Math.min(window.innerHeight - panel.offsetHeight, startTop + dy),
			);
			panel.style.left = newLeft + 'px';
			panel.style.top = newTop + 'px';
		});

		window.addEventListener('mouseup', () => {
			if (!dragging) return;
			dragging = false;
			try {
				localStorage.setItem(
					key,
					JSON.stringify({
						left: parseInt(panel.style.left, 10) || 0,
						top: parseInt(panel.style.top, 10) || 0,
					}),
				);
			} catch {}
		});
	}

	function safeInt(x) {
		const n = Number(x);
		return Number.isFinite(n) ? Math.trunc(n) : null;
	}

	function extractStartLinkId(base) {
		const arr = base?.vmsLinkIfscDtos;
		if (!Array.isArray(arr) || arr.length === 0) return null;
		return safeInt(arr[0]?.ifscId);
	}

	function extractVmsIfscId(base) {
		const id = base?.vmsIfscId;
		if (id === undefined || id === null || id === '') return null;
		return String(id);
	}

	function buildLinkDtos(vmsIfscId, path) {
		return path.map((ifscId, i) => ({
			vmsIfscId: String(vmsIfscId),
			ifscId: Number(ifscId),
			ord: i + 1,
		}));
	}

	async function fetchRoute(startLinkId, endLinkId) {
		const res = await fetch(ROUTE_API, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				start_link_id: String(startLinkId),
				end_link_id: String(endLinkId),
				max_visits: state.maxVisits,
			}),
		});
		const data = await res.json().catch(() => null);
		if (!data) throw new Error('route api invalid response');
		if (!data.ok) throw new Error(data.error || 'route api failed');
		return data.path;
	}

	function normName(s) {
		return String(s ?? '')
			.trim()
			.replace(/\s+/g, ' ')
			.toLowerCase();
	}

	function makeSEKey(payload) {
		const s = payload?.[KEY_START_NM];
		const e = payload?.[KEY_END_NM];
		if (!s || !e) return null;

		const A = normName(s);
		const B = normName(e);
		if (!state.reuseUndirected) return `${A}|${B}`;
		return [A, B].sort().join('|');
	}

	function isExpandedPayload(payload) {
		const n = Array.isArray(payload?.vmsLinkIfscDtos)
			? payload.vmsLinkIfscDtos.length
			: 0;
		return n >= 2;
	}

	function prunePayloadForCache(payload) {
		return payload;
	}

	function cacheReusePayload(payload, tag) {
		const key = makeSEKey(payload);
		if (!key) return;

		if (!isExpandedPayload(payload)) return;

		if (reuseCache.size >= CACHE_MAX) {
			reuseCache.clear();
		}

		const cloned = structuredClone(prunePayloadForCache(payload));
		reuseCache.set(key, cloned);
		persistReuseCache();
	}

	function rewriteAllVmsIds(obj, newVmsIfscId) {
		const seen = new Set();
		const stack = [obj];
		while (stack.length) {
			const cur = stack.pop();
			if (!cur || (typeof cur !== 'object' && typeof cur !== 'function'))
				continue;
			if (seen.has(cur)) continue;
			seen.add(cur);

			if (Object.prototype.hasOwnProperty.call(cur, KEY_VMS_ID)) {
				cur[KEY_VMS_ID] = String(newVmsIfscId);
			}

			if (Array.isArray(cur)) {
				for (const v of cur) stack.push(v);
				continue;
			}

			for (const k of Object.keys(cur)) {
				try {
					stack.push(cur[k]);
				} catch {}
			}
		}
	}

	async function postUpdatePayload(payload, successMsg) {
		const res = await fetch(UPDATE_URL, {
			method: 'POST',
			headers: COMMON_HEADERS,
			body: JSON.stringify(payload),
			credentials: 'include',
		});
		const txt = await res.text();
		if (res.ok) toast(successMsg || '✅ update 성공');
		else toast(`update 실패 (${res.status})\n${txt.slice(0, 240)}`);
		return res.ok;
	}

	async function postUpdateWithRouteOrReuse(basePayload, triggerTag) {
		if (!state.enabled) return;

		const vmsIfscId = extractVmsIfscId(basePayload);
		if (!vmsIfscId) {
			toast('payload에 vmsIfscId 없음');
			return;
		}

		const seKey = makeSEKey(basePayload);

		if (state.reuseEnabled && seKey && reuseCache.has(seKey)) {
			try {
				const src = structuredClone(reuseCache.get(seKey));
				rewriteAllVmsIds(src, vmsIfscId);

				if (Array.isArray(src.vmsLinkIfscDtos)) {
					src.vmsLinkIfscDtos.forEach((x, i) => {
						if (x && typeof x === 'object') {
							x.vmsIfscId = String(vmsIfscId);
							x.ord = i + 1;
						}
					});
				}

				toast(
					`중복 구간 → 경로 재사용 update\nkey=${seKey}\nlinks=${
						src?.vmsLinkIfscDtos?.length ?? '?'
					}\n전송 중...`,
				);
				const ok = await postUpdatePayload(src, '중복 재사용 update 성공');

				if (ok) cacheReusePayload(src, 'reuse-expanded');
				return;
			} catch (e) {
				toast(
					'중복 재사용 실패 → route로 fallback\n' + (e?.message || String(e)),
				);
			}
		}

		const start = extractStartLinkId(basePayload);
		if (start === null) {
			toast('payload에서 시작 링크(ifscId) 추출 실패');
			return;
		}

		const end = safeInt(state.endLinkId);
		if (end === null) {
			toast('end 링크ID 입력 후 설정 적용 필요');
			return;
		}

		const key = `${vmsIfscId}:${start}->${end}:${triggerTag}`;
		const now = Date.now();
		if (state.lastKey === key && now - state.lastAt < state.dedupeMs) return;
		state.lastKey = key;
		state.lastAt = now;

		const run = async () => {
			try {
				toast(`경로 계산 중...\nstart=${start}, end=${end}`);
				const path = await fetchRoute(start, end);
				toast(`경로 계산 완료: ${path.length} links\nupdate 전송 중...`);

				const payload = structuredClone(basePayload);
				payload.vmsIfscId = String(vmsIfscId);
				payload.vmsLinkIfscDtos = buildLinkDtos(vmsIfscId, path);

				if (basePayload?.[KEY_START_NM])
					payload[KEY_START_NM] = basePayload[KEY_START_NM];
				if (basePayload?.[KEY_END_NM])
					payload[KEY_END_NM] = basePayload[KEY_END_NM];

				if (Array.isArray(payload.vmsIfscCmtrGradDtos)) {
					payload.vmsIfscCmtrGradDtos.forEach(x => {
						if (x && typeof x === 'object') x.vmsIfscId = String(vmsIfscId);
					});
				}

				const ok = await postUpdatePayload(payload, 'expand update 성공');
				if (ok) cacheReusePayload(payload, 'route-expanded');
			} catch (e) {
				toast('자동 처리 실패:\n' + (e?.message || String(e)));
			}
		};

		if (state.delayMs > 0) setTimeout(run, state.delayMs);
		else run();
	}

	function findEditButton() {
		const btns = Array.from(document.querySelectorAll(EDIT_BTN_SEL));
		const b = btns.find(x => (x.textContent || '').trim() === '편집') || null;
		return b;
	}

	function clickEditIfExists() {
		const b = findEditButton();
		if (b) b.click();
		return !!b;
	}

	function clickSave() {
		const b = document.querySelector(SAVE_BTN_SEL);
		if (!b) return false;
		b.click();
		return true;
	}

	const panel = el('div', {
		style: {
			position: 'fixed',
			top: '12px',
			right: '12px',
			zIndex: 999999,
			width: '400px',
			background: '#fff',
			border: '1px solid #ddd',
			borderRadius: '12px',
			boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
			overflow: 'hidden',
			fontSize: '12px',
			color: '#111',
		},
	});

	const handleBar = el('div', {
		style: {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'space-between',
			gap: '10px',
			padding: '10px 12px',
			background: '#111',
			color: '#fff',
		},
	});

	const title = el('div', { style: { fontWeight: '700' } }, [
		'VMS route→update (+reuse,persist)',
	]);
	const rightArea = el('div', {
		style: { display: 'flex', alignItems: 'center', gap: '10px' },
	});

	const enabledChk = el('input', { type: 'checkbox', checked: true });
	const enabledLabel = el(
		'label',
		{
			style: {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				cursor: 'pointer',
			},
		},
		[enabledChk, el('span', { style: { fontSize: '11px' } }, ['ON'])],
	);

	const reuseChk = el('input', { type: 'checkbox', checked: true });
	const reuseLabel = el(
		'label',
		{
			style: {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				cursor: 'pointer',
			},
		},
		[reuseChk, el('span', { style: { fontSize: '11px' } }, ['REUSE'])],
	);

	const protectChk = el('input', { type: 'checkbox', checked: true });
	const protectLabel = el(
		'label',
		{
			style: {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				cursor: 'pointer',
			},
		},
		[protectChk, el('span', { style: { fontSize: '11px' } }, ['MANUAL>'])],
	);

	const closeBtn = el(
		'button',
		{
			style: {
				border: 'none',
				background: 'rgba(255,255,255,0.12)',
				color: '#fff',
				borderRadius: '8px',
				padding: '4px 8px',
				cursor: 'pointer',
				fontSize: '12px',
				lineHeight: '16px',
			},
			onclick: () => panel.remove(),
		},
		['×'],
	);

	rightArea.appendChild(enabledLabel);
	rightArea.appendChild(reuseLabel);
	rightArea.appendChild(protectLabel);
	rightArea.appendChild(closeBtn);
	handleBar.appendChild(title);
	handleBar.appendChild(rightArea);

	const body = el('div', { style: { padding: '10px 12px' } });

	const hint = el(
		'div',
		{ style: { color: '#555', lineHeight: '1.35', whiteSpace: 'pre-wrap' } },
		[
			//"저장(add/update) XHR 캡쳐 → (수동 확장 저장이면) 캐시 갱신만 하고 자동 덮어쓰기 중지\n" +
			//"(중복이면) 기존 경로 재사용 update, 없으면 route 서버로 경로 계산 → update 전송\n\n" +
			//"중복 키: dsplStrtNodeNm|dsplEndNodeNm\n" +
			//"캐시: localStorage에 저장(새로고침 유지)\n" +
			//" 캐시는 '확장 payload(links>=2)'만 저장/갱신 (1개 링크 선택 payload는 캐시 오염 방지)"
		],
	);

	const endInput = el('input', {
		type: 'number',
		placeholder: 'end link ifscId (예: 2000000900) [route fallback용]',
		style: {
			width: '100%',
			padding: '8px',
			marginTop: '8px',
			border: '1px solid #ddd',
			borderRadius: '10px',
		},
	});

	const delayRow = el(
		'div',
		{
			style: {
				display: 'flex',
				gap: '8px',
				alignItems: 'center',
				marginTop: '8px',
			},
		},
		[],
	);
	const delayInput = el('input', {
		type: 'number',
		value: '200',
		min: '0',
		style: {
			flex: '1',
			padding: '8px',
			border: '1px solid #ddd',
			borderRadius: '10px',
		},
	});
	delayRow.appendChild(
		el('div', { style: { color: '#666', width: '120px' } }, ['지연(ms)']),
	);
	delayRow.appendChild(delayInput);

	const applyBtn = el(
		'button',
		{
			style: {
				marginTop: '10px',
				width: '100%',
				padding: '9px',
				borderRadius: '10px',
				border: '1px solid #ddd',
				background: '#f7f7f7',
				cursor: 'pointer',
				fontWeight: '600',
			},
			onclick: () => {
				state.enabled = enabledChk.checked;
				state.reuseEnabled = reuseChk.checked;
				state.protectManualExpanded = protectChk.checked;
				state.endLinkId = endInput.value;
				state.delayMs = Math.max(0, Number(delayInput.value) || 0);
				toast(
					`설정됨\n` +
						`auto: ${state.enabled ? 'ON' : 'OFF'}\n` +
						`reuse: ${state.reuseEnabled ? 'ON' : 'OFF'}\n` +
						`manual-protect: ${state.protectManualExpanded ? 'ON' : 'OFF'}\n` +
						`end(route): ${state.endLinkId || '(미설정)'}\n` +
						`delay: ${state.delayMs}ms\n` +
						`cache: ${reuseCache.size}`,
				);
			},
		},
		['설정 적용'],
	);

	const runBtn = el(
		'button',
		{
			style: {
				marginTop: '8px',
				width: '100%',
				padding: '9px',
				borderRadius: '10px',
				border: '1px solid #111',
				background: '#111',
				color: '#fff',
				cursor: 'pointer',
				fontWeight: '700',
			},
			onclick: () => {
				const end = safeInt(state.endLinkId);
				if (end === null) {
					toast('end 링크ID 입력/적용 필요');
					return;
				}
				clickEditIfExists();
				setTimeout(() => {
					const ok = clickSave();
					if (!ok) toast('저장 버튼이 없음');
				}, 80);
			},
		},
		['자동 실행 (편집→저장)'],
	);

	const cacheInfo = el(
		'div',
		{ style: { marginTop: '8px', color: '#666', fontSize: '11px' } },
		[`cache(size): ${reuseCache.size} (persist key: ${REUSE_LS_KEY})`],
	);

	const clearCacheBtn = el(
		'button',
		{
			style: {
				marginTop: '6px',
				width: '100%',
				padding: '8px',
				borderRadius: '10px',
				border: '1px solid #c33',
				background: '#fff',
				color: '#c33',
				cursor: 'pointer',
				fontWeight: '700',
			},
			onclick: () => {
				reuseCache.clear();
				try {
					localStorage.removeItem(REUSE_LS_KEY);
				} catch {}
				toast('중복 루트 캐시 초기화');
				cacheInfo.textContent = `cache(size): ${reuseCache.size} (persist key: ${REUSE_LS_KEY})`;
			},
		},
		['중복 캐시 초기화'],
	);

	enabledChk.addEventListener('change', () => {
		state.enabled = enabledChk.checked;
	});
	reuseChk.addEventListener('change', () => {
		state.reuseEnabled = reuseChk.checked;
	});
	protectChk.addEventListener('change', () => {
		state.protectManualExpanded = protectChk.checked;
	});

	body.appendChild(hint);
	body.appendChild(endInput);
	body.appendChild(delayRow);
	body.appendChild(applyBtn);
	body.appendChild(runBtn);
	body.appendChild(cacheInfo);
	body.appendChild(clearCacheBtn);

	panel.appendChild(handleBar);
	panel.appendChild(body);
	document.body.appendChild(panel);
	makeDraggablePersist(panel, handleBar);

	const origOpen = XMLHttpRequest.prototype.open;
	const origSend = XMLHttpRequest.prototype.send;

	XMLHttpRequest.prototype.open = function (method, url, ...rest) {
		this.___vms_url = url;
		this.___vms_method = method;
		return origOpen.call(this, method, url, ...rest);
	};

	XMLHttpRequest.prototype.send = function (body) {
		const url = String(this.___vms_url || '');
		const isAdd = url.includes(ADD_PATH);
		const isUpdate = url.includes(UPDATE_PATH);

		let captured = null;
		let triggerTag = '';
		if (
			state.enabled &&
			(isAdd || isUpdate) &&
			body &&
			typeof body === 'string'
		) {
			try {
				captured = JSON.parse(body);
				triggerTag = isAdd ? 'add' : 'update';
			} catch {
				captured = null;
			}
		}

		if (captured) {
			const xhr = this;
			xhr.addEventListener('load', () => {
				try {
					if (xhr.status >= 200 && xhr.status < 300) {
						if (state.protectManualExpanded && isExpandedPayload(captured)) {
							cacheReusePayload(captured, 'manual-expanded');
							toast(
								`수동 확장 저장\nlinks=${captured.vmsLinkIfscDtos.length}\n캐시 갱신`,
							);
						} else {
							postUpdateWithRouteOrReuse(captured, triggerTag);
						}

						cacheInfo.textContent = `cache(size): ${reuseCache.size} (persist key: ${REUSE_LS_KEY})`;
					}
				} catch (e) {
					toast('자동 처리 오류:\n' + (e?.message || String(e)));
				}
			});
		}

		return origSend.call(this, body);
	};

	toast(
		'캐시 경로는 payload의 링크 수가 2 이상일 때\n' +
			'수동으로 링크 수 2 이상의 경로를 저장 시 캐시 경로 수동 갱신\n' +
			'중복이면 기존 경로 재사용, 없으면 루트 계산\n' +
			`cache(size)=${reuseCache.size}`,
	);

	window.__VMS_REUSE_CACHE__ = reuseCache;
})();
// ==UserScript==
// @name         New Userscript
// @namespace    http://tampermonkey.net/
// @version      2026-01-23
// @description  try to take over the world!
// @author       You
// @match        https://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function () {
	'use strict';

	// Your code here...
})();


