import { BrowserWindow as e, Notification as t, app as n, dialog as r, ipcMain as i, shell as a } from "electron";
import o from "node:fs/promises";
import s from "node:path";
import { fileURLToPath as c } from "node:url";
//#region electron/gifSearch.ts
var l = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
function u(e) {
	let t = process.env[e];
	return t && t.trim() ? t.trim() : void 0;
}
async function d(e) {
	let t = u("VITE_TENOR_API_KEY") || u("TENOR_API_KEY");
	if (!t) return [];
	let n = e.trim() || "funny", r = `https://g.tenor.com/v1/search?q=${encodeURIComponent(n)}&key=${encodeURIComponent(t)}&client_key=matrix_macos&limit=24&media_filter=minimal`, i = await fetch(r, { headers: { "User-Agent": l } });
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
async function f(e) {
	let t = u("VITE_GIPHY_API_KEY") || u("GIPHY_API_KEY");
	if (!t) return [];
	let n = e.trim() || "funny", r = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(t)}&q=${encodeURIComponent(n)}&limit=24&rating=pg-13`, i = await fetch(r, { headers: { "User-Agent": l } });
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
function p(e) {
	let t = e.toLowerCase();
	return t.includes(".gif") || t.includes("media.tenor.com") || t.includes("giphy.com") || t.includes("media.giphy.com") || t.includes("/gif");
}
async function m(e) {
	let t = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(e)}`, { headers: {
		"User-Agent": l,
		Accept: "text/html"
	} });
	if (!t.ok) throw Error(`DDG HTML HTTP ${t.status}`);
	let n = await t.text(), r = n.match(/vqd=["']([\d-]+)["']/) || n.match(/vqd=([\d-]+)/);
	if (!r?.[1]) throw Error("DDG vqd not found");
	return r[1];
}
async function h(e) {
	let t = e.trim() || "funny", n = /\bgif\b/i.test(t) ? t : `${t} gif`, r = await m(n), i = new URL("https://duckduckgo.com/i.js");
	i.searchParams.set("l", "us-en"), i.searchParams.set("o", "json"), i.searchParams.set("q", n), i.searchParams.set("vqd", r), i.searchParams.set("f", ",,,,type:gif,,"), i.searchParams.set("p", "1");
	let a = await fetch(i.toString(), { headers: {
		"User-Agent": l,
		Referer: "https://duckduckgo.com/",
		Accept: "application/json"
	} });
	if (!a.ok) throw Error(`DDG i.js HTTP ${a.status}`);
	let o = await a.json(), s = [];
	for (let e of o.results || []) {
		let t = e.image || "", n = e.thumbnail || t;
		if (t && !(!p(t) && !p(n)) && (s.push({
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
async function g(e) {
	let t = [];
	for (let [n, r] of [["tenor", d], ["giphy", f]]) try {
		let t = await r(e);
		if (t.length) return {
			results: t,
			error: null
		};
	} catch (e) {
		console.warn(`[gif] ${n} failed`, e), t.push(n);
	}
	try {
		let t = await h(e);
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
//#region electron/main.ts
var _ = s.dirname(c(import.meta.url)), v = process.env.VITE_DEV_SERVER_URL, y = null, b = !1;
function x(t, n) {
	let r = t instanceof Error ? t : Error(String(t)), i = {
		title: n === "rejection" ? "Сбой фоновой задачи (main)" : "Сбой системного процесса",
		summary: "Ошибка в Electron main process. Окно приложения постарались сохранить.",
		detail: r.message,
		stack: r.stack
	};
	for (let t of e.getAllWindows()) t.isDestroyed() || t.webContents.send("main-error", i);
}
function S() {
	if (!b) {
		b = !0;
		try {
			y = new e({
				width: 1200,
				height: 800,
				frame: !1,
				titleBarStyle: "hidden",
				trafficLightPosition: {
					x: 16,
					y: 16
				},
				vibrancy: "under-window",
				backgroundColor: "#00000000",
				webPreferences: {
					preload: s.join(_, "preload.js"),
					nodeIntegration: !0,
					contextIsolation: !1,
					partition: "persist:matrix-macos-client"
				}
			}), v ? (y.loadURL(v), y.webContents.openDevTools()) : y.loadFile(s.join(_, "..", "dist", "index.html")), y.webContents.on("render-process-gone", (e, t) => {
				x(/* @__PURE__ */ Error(`Renderer crashed: ${t.reason} (exit ${t.exitCode})`), "exception"), y && !y.isDestroyed() && y.destroy(), y = null;
			}), y.on("closed", () => {
				y = null;
			});
		} finally {
			b = !1;
		}
	}
}
function C(e) {
	try {
		return new URL(e).searchParams.get("loginToken");
	} catch {
		let t = e.match(/[?&]loginToken=([^&]+)/);
		return t ? decodeURIComponent(t[1]) : null;
	}
}
i.handle("open-external", async (e, t) => {
	await a.openExternal(t);
}), i.handle("save-text-file", async (e, t) => {
	let n = typeof t?.content == "string" ? t.content : "", i = typeof t?.defaultPath == "string" && t.defaultPath.trim() ? t.defaultPath.trim() : `matrix-error-report-${Date.now()}.txt`, a = await r.showSaveDialog(y ?? void 0, {
		title: "Сохранить отчёт",
		defaultPath: i,
		filters: [{
			name: "Text",
			extensions: ["txt"]
		}, {
			name: "All Files",
			extensions: ["*"]
		}]
	});
	return a.canceled || !a.filePath ? {
		ok: !1,
		canceled: !0
	} : (await o.writeFile(a.filePath, n, "utf8"), {
		ok: !0,
		path: a.filePath
	});
}), i.handle("search-gifs", async (e, t) => g(typeof t == "string" ? t : "")), i.handle("set-dock-badge", (e, t) => {
	if (process.platform !== "darwin" || !n.dock) return;
	let r = typeof t == "number" ? t : Number(t);
	if (!Number.isFinite(r) || r <= 0) {
		n.dock.setBadge("");
		return;
	}
	n.dock.setBadge(r > 99 ? "99+" : String(Math.floor(r)));
}), i.handle("is-window-focused", () => !!y && !y.isDestroyed() && y.isFocused()), i.handle("show-notification", (e, r) => {
	if (!t.isSupported()) return console.warn("[notifications] Notification.isSupported() === false"), {
		ok: !1,
		reason: "unsupported"
	};
	let i = typeof r?.title == "string" && r.title.trim() ? r.title.trim() : "Новое сообщение", a = typeof r?.body == "string" ? r.body.slice(0, 240) : "", o = typeof r?.roomId == "string" ? r.roomId : void 0, s = typeof r?.eventId == "string" ? r.eventId : void 0;
	try {
		let e = new t({
			title: i,
			body: a,
			silent: !1
		});
		return e.on("show", () => {
			console.info("[notifications] shown:", i);
		}), e.on("failed", (e, t) => {
			console.warn("[notifications] failed:", t);
		}), e.on("click", () => {
			y && !y.isDestroyed() && (y.isMinimized() && y.restore(), y.show(), y.focus(), o && y.webContents.send("notification-clicked", {
				roomId: o,
				eventId: s
			}));
		}), e.show(), process.platform === "darwin" && n.dock && n.dock.bounce("informational"), { ok: !0 };
	} catch (e) {
		return console.warn("[notifications] throw:", e), {
			ok: !1,
			reason: e instanceof Error ? e.message : String(e)
		};
	}
}), i.handle("sso-login", async (t, n, r) => new Promise((t, i) => {
	let a = new e({
		width: 560,
		height: 720,
		parent: y ?? void 0,
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
		let t = C(e);
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
})), n.whenReady().then(() => {
	S(), process.on("uncaughtException", (e) => {
		console.error("[main uncaughtException]", e), x(e, "exception");
	}), process.on("unhandledRejection", (e) => {
		console.error("[main unhandledRejection]", e), x(e, "rejection");
	});
}), n.on("window-all-closed", () => {
	process.platform !== "darwin" && n.quit();
}), n.on("activate", () => {
	e.getAllWindows().length === 0 ? S() : y && !y.isDestroyed() && (y.show(), y.focus());
});
//#endregion
export {};
