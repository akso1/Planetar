import { BrowserWindow as e, Menu as t, Notification as n, Tray as r, app as i, dialog as a, ipcMain as o, nativeImage as s, safeStorage as c, session as l, shell as ee } from "electron";
import te from "node:fs/promises";
import u from "node:path";
import { fileURLToPath as d } from "node:url";
import f from "node:fs";
//#region electron/gifSearch.ts
var p = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
function m(e) {
	let t = process.env[e];
	return t && t.trim() ? t.trim() : void 0;
}
async function h(e) {
	let t = m("VITE_TENOR_API_KEY") || m("TENOR_API_KEY");
	if (!t) return [];
	let n = e.trim() || "funny", r = `https://g.tenor.com/v1/search?q=${encodeURIComponent(n)}&key=${encodeURIComponent(t)}&client_key=matrix_macos&limit=24&media_filter=minimal`, i = await fetch(r, { headers: { "User-Agent": p } });
	if (!i.ok) throw Error(`Tenor HTTP ${i.status}`);
	return ((await i.json()).results || []).map((e) => {
		let t = e.media?.[0], n = t?.nanogif || t?.tinygif || t?.gif, r = t?.gif || t?.tinygif || t?.nanogif;
		return {
			id: `tenor_${e.id}`,
			title: e.title || "GIF",
			previewUrl: n?.url || "",
			url: r?.url || n?.url || "",
			w: r?.dims?.[0],
			h: r?.dims?.[1],
			source: "tenor"
		};
	}).filter((e) => e.previewUrl && e.url);
}
async function g(e) {
	let t = m("VITE_GIPHY_API_KEY") || m("GIPHY_API_KEY");
	if (!t) return [];
	let n = e.trim() || "funny", r = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(t)}&q=${encodeURIComponent(n)}&limit=24&rating=pg-13`, i = await fetch(r, { headers: { "User-Agent": p } });
	if (!i.ok) throw Error(`Giphy HTTP ${i.status}`);
	return ((await i.json()).data || []).map((e) => {
		let t = e.images?.fixed_width_small?.url || e.images?.preview_gif?.url || e.images?.downsized?.url || "", n = e.images?.downsized?.url || e.images?.original?.url || t, r = Number(e.images?.downsized?.width || e.images?.original?.width), i = Number(e.images?.downsized?.height || e.images?.original?.height);
		return {
			id: `giphy_${e.id}`,
			title: e.title || "GIF",
			previewUrl: t,
			url: n,
			w: Number.isFinite(r) ? r : void 0,
			h: Number.isFinite(i) ? i : void 0,
			source: "giphy"
		};
	}).filter((e) => e.previewUrl && e.url);
}
function _(e) {
	let t = e.toLowerCase();
	return t.includes(".gif") || t.includes("media.tenor.com") || t.includes("giphy.com") || t.includes("media.giphy.com") || t.includes("/gif");
}
async function ne(e) {
	let t = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(e)}`, { headers: {
		"User-Agent": p,
		Accept: "text/html"
	} });
	if (!t.ok) throw Error(`DDG HTML HTTP ${t.status}`);
	let n = await t.text(), r = n.match(/vqd=["']([\d-]+)["']/) || n.match(/vqd=([\d-]+)/);
	if (!r?.[1]) throw Error("DDG vqd not found");
	return r[1];
}
async function re(e) {
	let t = e.trim() || "funny", n = /\bgif\b/i.test(t) ? t : `${t} gif`, r = await ne(n), i = new URL("https://duckduckgo.com/i.js");
	i.searchParams.set("l", "us-en"), i.searchParams.set("o", "json"), i.searchParams.set("q", n), i.searchParams.set("vqd", r), i.searchParams.set("f", ",,,,type:gif,,"), i.searchParams.set("p", "1");
	let a = await fetch(i.toString(), { headers: {
		"User-Agent": p,
		Referer: "https://duckduckgo.com/",
		Accept: "application/json"
	} });
	if (!a.ok) throw Error(`DDG i.js HTTP ${a.status}`);
	let o = await a.json(), s = [];
	for (let e of o.results || []) {
		let t = e.image || "", n = e.thumbnail || t;
		if (t && !(!_(t) && !_(n)) && (s.push({
			id: `ddg_${s.length}_${Buffer.from(t).toString("base64url").slice(0, 16)}`,
			title: e.title || "GIF",
			previewUrl: n || t,
			url: t,
			w: typeof e.width == "number" ? e.width : void 0,
			h: typeof e.height == "number" ? e.height : void 0,
			source: "ddg"
		}), s.length >= 24)) break;
	}
	if (!s.length) for (let e of (o.results || []).slice(0, 24)) {
		let t = e.image || "";
		t && s.push({
			id: `ddg_${s.length}_${Buffer.from(t).toString("base64url").slice(0, 16)}`,
			title: e.title || "GIF",
			previewUrl: e.thumbnail || t,
			url: t,
			w: typeof e.width == "number" ? e.width : void 0,
			h: typeof e.height == "number" ? e.height : void 0,
			source: "ddg"
		});
	}
	return s;
}
async function ie(e) {
	let t = [];
	for (let [n, r] of [["tenor", h], ["giphy", g]]) try {
		let t = await r(e);
		if (t.length) return {
			results: t,
			error: null
		};
	} catch (e) {
		console.warn(`[gif] ${n} failed`, e), t.push(n);
	}
	try {
		let t = await re(e);
		return t.length ? {
			results: t,
			error: null
		} : {
			results: [],
			error: "По запросу ничего не найдено"
		};
	} catch (e) {
		return console.warn("[gif] ddg failed", e), {
			results: [],
			error: "Не удалось загрузить GIF. Проверьте сеть." + (t.length ? ` (также: ${t.join(", ")})` : "")
		};
	}
}
//#endregion
//#region electron/sessionStore.ts
function v() {
	return u.join(i.getPath("userData"), "matrix-session.enc");
}
function y() {
	return u.join(i.getPath("userData"), "matrix-session.json");
}
function b() {
	let e = y();
	try {
		f.existsSync(e) && (f.unlinkSync(e), console.warn("[sessionStore] removed legacy plaintext matrix-session.json"));
	} catch (e) {
		console.warn("[sessionStore] failed to scrub plaintext session:", e);
	}
}
function x(e) {
	return !!(e?.baseUrl && e?.userId && e?.accessToken && e?.deviceId);
}
function ae() {
	b();
	try {
		if (!c.isEncryptionAvailable()) return console.warn("[sessionStore] safeStorage unavailable — refusing plaintext session"), null;
		let e = v();
		if (!f.existsSync(e)) return null;
		let t = f.readFileSync(e), n = c.decryptString(t), r = JSON.parse(n);
		return x(r) ? r : null;
	} catch (e) {
		console.warn("[sessionStore] read failed:", e);
	}
	return null;
}
function oe(e) {
	if (b(), !c.isEncryptionAvailable()) return console.error("[sessionStore] safeStorage unavailable — refuse to persist access token"), {
		ok: !1,
		reason: "safe-storage-unavailable"
	};
	try {
		let t = JSON.stringify(e), n = c.encryptString(t);
		return f.writeFileSync(v(), n, { mode: 384 }), b(), { ok: !0 };
	} catch (e) {
		return console.warn("[sessionStore] write failed:", e), {
			ok: !1,
			reason: e instanceof Error ? e.message : String(e)
		};
	}
}
function S() {
	for (let e of [v(), y()]) try {
		f.unlinkSync(e);
	} catch {}
}
//#endregion
//#region electron/secretStorageKeyStore.ts
function C() {
	return u.join(i.getPath("userData"), "secret-storage-keys");
}
function w(e) {
	return e.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function T(e, t) {
	return u.join(C(), `${w(e)}__${w(t)}.enc`);
}
function E(e, t) {
	return u.join(C(), `${w(e)}__${w(t)}.json`);
}
function se() {
	let e = C();
	f.existsSync(e) || f.mkdirSync(e, {
		recursive: !0,
		mode: 448
	});
}
function ce(e, t) {
	if (!e || !t) return null;
	try {
		let n = T(e, t);
		if (f.existsSync(n) && c.isEncryptionAvailable()) {
			let r = f.readFileSync(n), i = c.decryptString(r), a = JSON.parse(i);
			return a?.userId === e && a?.deviceId === t && a?.keyId && a?.privateKeyBase64 ? a : null;
		}
		let r = E(e, t);
		if (f.existsSync(r)) {
			let n = f.readFileSync(r, "utf8"), i = JSON.parse(n);
			if (i?.userId === e && i?.deviceId === t && i?.keyId && i?.privateKeyBase64) return i;
		}
	} catch (e) {
		console.warn("[secretStorageKeyStore] read failed:", e);
	}
	return null;
}
function le(e) {
	try {
		if (!e?.userId || !e?.deviceId || !e?.keyId || !e?.privateKeyBase64) return {
			ok: !1,
			reason: "invalid-payload"
		};
		se();
		let t = JSON.stringify(e);
		if (c.isEncryptionAvailable()) {
			let n = c.encryptString(t);
			f.writeFileSync(T(e.userId, e.deviceId), n, { mode: 384 });
			try {
				f.unlinkSync(E(e.userId, e.deviceId));
			} catch {}
			return { ok: !0 };
		}
		return f.writeFileSync(E(e.userId, e.deviceId), t, {
			encoding: "utf8",
			mode: 384
		}), {
			ok: !0,
			reason: "plain-fallback"
		};
	} catch (e) {
		return console.warn("[secretStorageKeyStore] write failed:", e), {
			ok: !1,
			reason: e instanceof Error ? e.message : String(e)
		};
	}
}
function ue(e, t) {
	if (!(!e || !t)) for (let n of [T(e, t), E(e, t)]) try {
		f.unlinkSync(n);
	} catch {}
}
function D() {
	let e = C();
	if (f.existsSync(e)) try {
		for (let t of f.readdirSync(e)) try {
			f.unlinkSync(u.join(e, t));
		} catch {}
	} catch (e) {
		console.warn("[secretStorageKeyStore] clearAll failed:", e);
	}
}
//#endregion
//#region electron/main.ts
var O = u.dirname(d(import.meta.url)), k = process.env.VITE_DEV_SERVER_URL, A = "Planetar", j = "app.planetar.desktop";
i.setName(A), i.isPackaged && i.setAppUserModelId(j), i.requestSingleInstanceLock() || (i.quit(), process.exit(0));
var M = null, N = null, P = !1, F = null, I = !0, L = !1;
function R(t, n) {
	let r = t instanceof Error ? t : Error(String(t)), i = {
		title: n === "rejection" ? "Сбой фоновой задачи (main)" : "Сбой системного процесса",
		summary: "Ошибка в Electron main process. Окно приложения постарались сохранить.",
		detail: r.message,
		stack: r.stack
	};
	try {
		for (let t of e.getAllWindows()) if (!t.isDestroyed()) try {
			t.webContents.send("main-error", i);
		} catch (e) {
			console.error("[main-error] IPC send failed", e);
		}
	} catch (e) {
		console.error("[main-error] broadcast failed", e);
	}
}
function z() {
	process.on("uncaughtException", (e) => {
		console.error("[main uncaughtException]", e), R(e, "exception");
	}), process.on("unhandledRejection", (e) => {
		console.error("[main unhandledRejection]", e), R(e, "rejection");
	});
}
z();
function B() {
	if (!M || M.isDestroyed()) {
		q();
		return;
	}
	M.isMinimized() && M.restore(), M.show(), M.focus();
}
function V() {
	L = !0, i.quit();
}
function H(...e) {
	return u.join(O, ...e);
}
function U() {
	let e = H("icon.png"), t = s.createFromPath(e);
	return t.isEmpty() ? void 0 : t;
}
function de(e) {
	if (typeof e != "string") return null;
	let t = e.trim();
	if (!t) return null;
	let n;
	try {
		n = new URL(t);
	} catch {
		return null;
	}
	return n.username || n.password ? null : n.protocol === "https:" || n.protocol === "mailto:" ? n.toString() : null;
}
async function W(e) {
	let t = de(e);
	if (!t) return console.warn("[openExternal] blocked unsafe URL:", e), {
		ok: !1,
		reason: "blocked-url"
	};
	try {
		return await ee.openExternal(t), { ok: !0 };
	} catch (e) {
		return console.warn("[openExternal] failed:", e), {
			ok: !1,
			reason: e instanceof Error ? e.message : "open-failed"
		};
	}
}
function G(e) {
	let t;
	try {
		t = new URL(e);
	} catch {
		return !1;
	}
	if (k) try {
		let e = new URL(k);
		return t.origin === e.origin;
	} catch {
		return !1;
	}
	if (t.protocol !== "file:") return !1;
	try {
		let e = u.resolve(u.join(O, "..")), n = u.resolve(d(t.href));
		return n === e || n.startsWith(e + u.sep);
	} catch {
		return !1;
	}
}
function fe(e) {
	e.webContents.setWindowOpenHandler(({ url: e }) => (W(e), { action: "deny" })), e.webContents.on("will-navigate", (e, t) => {
		G(t) || (e.preventDefault(), W(t));
	}), e.webContents.on("will-redirect", (e, t) => {
		G(t) || (e.preventDefault(), W(t));
	});
}
function pe() {
	return t.buildFromTemplate([
		{
			label: "Показать",
			click: () => B()
		},
		{ type: "separator" },
		{
			label: "Выйти",
			click: () => V()
		}
	]);
}
function K() {
	if (F && !F.isDestroyed()) return;
	let e = ["trayTemplate@2x.png", "trayTemplate.png"], t = s.createEmpty();
	for (let n of e) {
		let e = H(n);
		if (t = s.createFromPath(e), !t.isEmpty()) break;
	}
	t.isEmpty() && (t = s.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6aAAAAAElFTkSuQmCC")), process.platform === "darwin" && t.setTemplateImage(!0), F = new r(t), F.setToolTip(A), F.setContextMenu(pe()), F.on("click", () => B()), F.on("double-click", () => B());
}
function q() {
	if (!P) {
		P = !0;
		try {
			let t = U();
			M = new e({
				width: 1200,
				height: 800,
				frame: !1,
				...process.platform === "darwin" ? {
					titleBarStyle: "hidden",
					trafficLightPosition: {
						x: 16,
						y: 16
					},
					transparent: !0,
					backgroundColor: "#00000000",
					visualEffectState: "active"
				} : {
					backgroundColor: "#070b14",
					autoHideMenuBar: !0
				},
				...t ? { icon: t } : {},
				webPreferences: {
					preload: u.join(O, "preload.cjs"),
					nodeIntegration: !1,
					contextIsolation: !0,
					sandbox: !0,
					partition: "persist:matrix-macos-client"
				}
			}), process.platform === "darwin" && t && i.dock && i.dock.setIcon(t), M.setTitle(A), fe(M);
			let n = () => {
				!M || M.isDestroyed() || M.webContents.send("window-maximized", M.isMaximized());
			};
			M.on("maximize", n), M.on("unmaximize", n), k ? (M.loadURL(k), M.webContents.openDevTools()) : M.loadFile(u.join(O, "..", "dist", "index.html")), M.webContents.on("render-process-gone", (e, t) => {
				R(/* @__PURE__ */ Error(`Renderer crashed: ${t.reason} (exit ${t.exitCode})`), "exception"), M && !M.isDestroyed() && M.destroy(), M = null;
			}), M.on("close", (e) => {
				!L && I && (e.preventDefault(), M?.hide(), K());
			}), M.on("closed", () => {
				M = null;
			});
		} finally {
			P = !1;
		}
	}
}
function me(e) {
	try {
		return new URL(e).searchParams.get("loginToken");
	} catch {
		let t = e.match(/[?&]loginToken=([^&]+)/);
		return t ? decodeURIComponent(t[1]) : null;
	}
}
o.handle("session-get", () => ae()), o.handle("session-set", (e, t) => {
	if (!t || typeof t.baseUrl != "string" || typeof t.userId != "string" || typeof t.accessToken != "string" || typeof t.deviceId != "string") return {
		ok: !1,
		reason: "invalid-credentials"
	};
	try {
		let e = new URL(t.baseUrl);
		if (e.protocol !== "https:" && e.protocol !== "http:") return {
			ok: !1,
			reason: "invalid-baseUrl"
		};
	} catch {
		return {
			ok: !1,
			reason: "invalid-baseUrl"
		};
	}
	return oe(t);
}), o.handle("session-clear", () => {
	S(), D();
}), o.handle("secret-storage-key-get", (e, t) => !t || typeof t.userId != "string" || typeof t.deviceId != "string" ? null : ce(t.userId, t.deviceId)), o.handle("secret-storage-key-set", (e, t) => le(t)), o.handle("secret-storage-key-clear", (e, t) => {
	if (t && typeof t.userId == "string" && typeof t.deviceId == "string") {
		ue(t.userId, t.deviceId);
		return;
	}
	D();
}), o.handle("open-external", async (e, t) => W(t)), o.handle("open-element-call", async (t, n) => {
	if (typeof n != "string") return {
		ok: !1,
		reason: "Некорректный URL Element Call"
	};
	let r;
	try {
		r = new URL(n);
	} catch {
		return {
			ok: !1,
			reason: "Некорректный URL Element Call"
		};
	}
	if (r.protocol !== "https:" || r.hostname !== "call.element.io") return {
		ok: !1,
		reason: "Некорректный URL Element Call"
	};
	let i = r.toString(), a = (e) => {
		try {
			let t = new URL(e);
			return t.protocol === "https:" && t.hostname === "call.element.io";
		} catch {
			return !1;
		}
	}, o = (e) => {
		e.webContents.setWindowOpenHandler(({ url: e }) => a(e) ? { action: "allow" } : (W(e), { action: "deny" })), e.webContents.on("will-navigate", (e, t) => {
			a(t) || (e.preventDefault(), W(t));
		});
	}, s = () => {
		N = null, M && !M.isDestroyed() && M.webContents.send("element-call-closed");
	};
	try {
		let t = U();
		return N && !N.isDestroyed() ? (o(N), N.focus(), await N.loadURL(i), { ok: !0 }) : (N = new e({
			width: 1080,
			height: 720,
			minWidth: 720,
			minHeight: 480,
			title: `${A} Call`,
			backgroundColor: "#0b141a",
			...t ? { icon: t } : {},
			parent: M ?? void 0,
			webPreferences: {
				nodeIntegration: !1,
				contextIsolation: !0,
				sandbox: !0,
				partition: "persist:planetar-element-call"
			}
		}), N.setTitle(`${A} Call`), o(N), N.on("closed", s), await N.loadURL(i), { ok: !0 });
	} catch (e) {
		return console.error("[element-call] open failed", e), {
			ok: !1,
			reason: e instanceof Error ? e.message : "Не удалось открыть окно Element Call"
		};
	}
}), o.handle("element-call-is-open", () => !!(N && !N.isDestroyed())), o.handle("clear-element-call-session", async () => {
	try {
		N && !N.isDestroyed() && N.close(), N = null;
		let e = l.fromPartition("persist:planetar-element-call");
		return await e.clearStorageData(), await e.clearCache(), { ok: !0 };
	} catch (e) {
		return console.warn("[element-call] clear session failed", e), {
			ok: !1,
			reason: e instanceof Error ? e.message : "clear failed"
		};
	}
}), o.handle("save-text-file", async (e, t) => {
	let n = typeof t?.content == "string" ? t.content : "", r = typeof t?.defaultPath == "string" && t.defaultPath.trim() ? t.defaultPath.trim() : `matrix-error-report-${Date.now()}.txt`, i = await a.showSaveDialog(M ?? void 0, {
		title: "Сохранить отчёт",
		defaultPath: r,
		filters: [{
			name: "Text",
			extensions: ["txt"]
		}, {
			name: "All Files",
			extensions: ["*"]
		}]
	});
	return i.canceled || !i.filePath ? {
		ok: !1,
		canceled: !0
	} : (await te.writeFile(i.filePath, n, "utf8"), {
		ok: !0,
		path: i.filePath
	});
}), o.handle("search-gifs", async (e, t) => ie(typeof t == "string" ? t : "")), o.handle("set-dock-badge", (e, t) => {
	if (process.platform !== "darwin" || !i.dock) return;
	let n = typeof t == "number" ? t : Number(t);
	if (!Number.isFinite(n) || n <= 0) {
		i.dock.setBadge("");
		return;
	}
	i.dock.setBadge(n > 99 ? "99+" : String(Math.floor(n)));
}), o.handle("is-window-focused", () => !!M && !M.isDestroyed() && M.isFocused()), o.handle("get-platform", () => process.platform), o.handle("perform-haptic", () => {
	try {
		return { ok: !0 };
	} catch {
		return { ok: !1 };
	}
}), o.handle("window-minimize", () => !M || M.isDestroyed() ? { ok: !1 } : (M.minimize(), { ok: !0 })), o.handle("window-maximize-toggle", () => !M || M.isDestroyed() ? {
	ok: !1,
	maximized: !1
} : (M.isMaximized() ? M.unmaximize() : M.maximize(), {
	ok: !0,
	maximized: M.isMaximized()
})), o.handle("window-close", () => !M || M.isDestroyed() ? { ok: !1 } : (M.close(), { ok: !0 })), o.handle("window-is-maximized", () => !!M && !M.isDestroyed() && M.isMaximized()), o.handle("set-minimize-to-tray", (e, t) => (I = !!t, I && K(), { ok: !0 })), o.handle("get-minimize-to-tray", () => I), o.handle("show-app-window", () => (B(), { ok: !0 }));
var J = "dark", Y = null, X = !1;
function he() {
	return Y || (J === "light" ? "#eef1f5" : "#09090b");
}
function Z() {
	if (!M || M.isDestroyed()) return;
	let e = J === "light", t = he();
	process.platform === "darwin" ? X ? (M.setVibrancy("under-window"), M.setBackgroundColor("#00000000")) : (M.setVibrancy(null), M.setBackgroundColor(t)) : M.setBackgroundColor(e ? t : Y ?? "#070b14");
}
o.handle("set-window-appearance", (e, t, n) => {
	if (!M || M.isDestroyed()) return { ok: !1 };
	J = t === "light" ? "light" : "dark", Y = typeof n == "string" && /^#[0-9a-fA-F]{6}$/.test(n) ? n : null;
	try {
		Z();
	} catch (e) {
		return console.warn("[set-window-appearance]", e), { ok: !1 };
	}
	return { ok: !0 };
}), o.handle("set-vibrancy", (e, t) => {
	if (!M || M.isDestroyed()) return { ok: !1 };
	X = !!t, process.platform !== "darwin" && (X = !1);
	try {
		Z();
	} catch (e) {
		return console.warn("[set-vibrancy]", e), { ok: !1 };
	}
	return {
		ok: !0,
		enabled: X
	};
});
var Q = /* @__PURE__ */ new Set();
function ge(e) {
	let t = e && typeof e == "object" ? e : {};
	return {
		title: typeof t.title == "string" && t.title.trim() ? t.title.trim().slice(0, 120) : "Новое сообщение",
		body: typeof t.body == "string" ? t.body.slice(0, 240) : "",
		roomId: typeof t.roomId == "string" && t.roomId.length < 256 ? t.roomId : void 0,
		eventId: typeof t.eventId == "string" && t.eventId.length < 256 ? t.eventId : void 0
	};
}
function $(e) {
	if (!n.isSupported()) return {
		ok: !1,
		reason: "unsupported"
	};
	let { title: t, body: r, roomId: a, eventId: o } = ge(e);
	try {
		let e = U(), s = new n({
			title: t,
			body: r,
			silent: !1,
			...process.platform !== "darwin" && e && !e.isEmpty() ? { icon: e } : {}
		});
		Q.add(s);
		let c = () => {
			Q.delete(s);
		};
		return s.on("close", c), s.on("failed", c), s.on("click", () => {
			try {
				M && !M.isDestroyed() && (M.isMinimized() && M.restore(), M.show(), M.focus(), a && M.webContents.send("notification-clicked", {
					roomId: a,
					eventId: o
				}));
			} finally {
				c();
			}
		}), s.show(), process.platform === "darwin" && i.dock && i.dock.bounce("informational"), { ok: !0 };
	} catch (e) {
		return {
			ok: !1,
			reason: e instanceof Error ? e.message : String(e)
		};
	}
}
o.handle("show-notification", (e, t) => {
	let n = $(t);
	return n.ok ? { ok: !0 } : {
		ok: !1,
		reason: n.reason
	};
}), o.on("show-native-notification", (e, t) => {
	$(t);
}), o.handle("sso-login", async (t, n, r) => new Promise((t, i) => {
	let a = new e({
		width: 560,
		height: 720,
		parent: M ?? void 0,
		modal: !1,
		show: !0,
		title: "Sign in",
		backgroundColor: "#0e1621",
		webPreferences: {
			nodeIntegration: !1,
			contextIsolation: !0,
			sandbox: !0
		}
	}), o = !1, s = (e, n) => {
		o || (o = !0, a.isDestroyed() || a.close(), e ? t(e) : i(n ?? /* @__PURE__ */ Error("SSO cancelled")));
	}, c = (e) => {
		if (r && !e.startsWith(r) && !e.includes("loginToken=")) return !1;
		let t = me(e);
		return t ? (s(t), !0) : !1;
	};
	a.webContents.on("will-redirect", (e, t) => {
		c(t) && e.preventDefault();
	}), a.webContents.on("will-navigate", (e, t) => {
		c(t) && e.preventDefault();
	}), a.webContents.on("did-navigate", (e, t) => {
		c(t);
	}), a.on("closed", () => {
		o || s(null, /* @__PURE__ */ Error("SSO window closed"));
	}), a.loadURL(n).catch((e) => {
		s(null, e instanceof Error ? e : Error(String(e)));
	});
})), i.whenReady().then(() => {
	i.isPackaged && i.setAppUserModelId(j), process.platform === "darwin" && i.setAboutPanelOptions({
		applicationName: A,
		applicationVersion: i.getVersion()
	});
	let e = (e) => e === "media" || e === "mediaKeySystem" || e === "display-capture" || e === "clipboard-sanitized-write" || e === "clipboard-read", t = (e) => {
		try {
			let t = new URL(e);
			return t.protocol === "file:" || t.hostname === "localhost" || t.hostname === "127.0.0.1";
		} catch {
			return !1;
		}
	}, n = (e) => {
		try {
			let t = new URL(e);
			return t.protocol === "https:" && t.hostname === "call.element.io";
		} catch {
			return !1;
		}
	}, r = (r, i) => {
		r.setPermissionRequestHandler((r, a, o, s) => {
			if (!e(a)) {
				o(!1);
				return;
			}
			let c = (s && "requestingUrl" in s ? String(s.requestingUrl || "") : "") || r.getURL();
			o(i === "element-call" ? n(c) : t(c));
		}), r.setPermissionCheckHandler((r, a, o) => e(a) ? i === "element-call" ? n(o || "") : t(o || "") : !1);
	};
	r(l.defaultSession, "app");
	try {
		r(l.fromPartition("persist:matrix-macos-client"), "app"), r(l.fromPartition("persist:planetar-element-call"), "element-call");
	} catch (e) {
		console.warn("[permissions] partition setup failed", e);
	}
	q(), K(), i.on("second-instance", () => {
		B();
	});
}), i.on("before-quit", () => {
	L = !0;
}), i.on("window-all-closed", () => {
	!I && process.platform !== "darwin" && i.quit();
}), i.on("activate", () => {
	e.getAllWindows().length === 0 ? q() : B();
});
//#endregion
export {};
