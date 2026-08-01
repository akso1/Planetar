import { BrowserWindow, Notification, app, dialog, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs$1 from "node:fs";
//#region electron/gifSearch.ts
var UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
function envKey(name) {
	const v = process.env[name];
	return v && v.trim() ? v.trim() : void 0;
}
async function searchTenor(query) {
	const key = envKey("VITE_TENOR_API_KEY") || envKey("TENOR_API_KEY");
	if (!key) return [];
	const q = query.trim() || "funny";
	const url = `https://g.tenor.com/v1/search?q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}&client_key=matrix_macos&limit=24&media_filter=minimal`;
	const res = await fetch(url, { headers: { "User-Agent": UA } });
	if (!res.ok) throw new Error(`Tenor HTTP ${res.status}`);
	return ((await res.json()).results || []).map((r) => {
		const m = r.media?.[0];
		const preview = m?.nanogif || m?.tinygif || m?.gif;
		const full = m?.gif || m?.tinygif || m?.nanogif;
		return {
			id: `tenor_${r.id}`,
			title: r.title || "GIF",
			previewUrl: preview?.url || "",
			url: full?.url || preview?.url || "",
			w: full?.dims?.[0],
			h: full?.dims?.[1],
			source: "tenor"
		};
	}).filter((g) => g.previewUrl && g.url);
}
async function searchGiphy(query) {
	const key = envKey("VITE_GIPHY_API_KEY") || envKey("GIPHY_API_KEY");
	if (!key) return [];
	const q = query.trim() || "funny";
	const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13`;
	const res = await fetch(url, { headers: { "User-Agent": UA } });
	if (!res.ok) throw new Error(`Giphy HTTP ${res.status}`);
	return ((await res.json()).data || []).map((r) => {
		const preview = r.images?.fixed_width_small?.url || r.images?.preview_gif?.url || r.images?.downsized?.url || "";
		const full = r.images?.downsized?.url || r.images?.original?.url || preview;
		const w = Number(r.images?.downsized?.width || r.images?.original?.width);
		const h = Number(r.images?.downsized?.height || r.images?.original?.height);
		return {
			id: `giphy_${r.id}`,
			title: r.title || "GIF",
			previewUrl: preview,
			url: full,
			w: Number.isFinite(w) ? w : void 0,
			h: Number.isFinite(h) ? h : void 0,
			source: "giphy"
		};
	}).filter((g) => g.previewUrl && g.url);
}
function looksLikeGif(url) {
	const u = url.toLowerCase();
	return u.includes(".gif") || u.includes("media.tenor.com") || u.includes("giphy.com") || u.includes("media.giphy.com") || u.includes("/gif");
}
async function getDdgVqd(query) {
	const res = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { headers: {
		"User-Agent": UA,
		Accept: "text/html"
	} });
	if (!res.ok) throw new Error(`DDG HTML HTTP ${res.status}`);
	const html = await res.text();
	const m = html.match(/vqd=["']([\d-]+)["']/) || html.match(/vqd=([\d-]+)/);
	if (!m?.[1]) throw new Error("DDG vqd not found");
	return m[1];
}
/** Keyless GIF search via DuckDuckGo image search (type:gif). */
async function searchDuckDuckGo(query) {
	const base = query.trim() || "funny";
	const q = /\bgif\b/i.test(base) ? base : `${base} gif`;
	const vqd = await getDdgVqd(q);
	const url = new URL("https://duckduckgo.com/i.js");
	url.searchParams.set("l", "us-en");
	url.searchParams.set("o", "json");
	url.searchParams.set("q", q);
	url.searchParams.set("vqd", vqd);
	url.searchParams.set("f", ",,,,type:gif,,");
	url.searchParams.set("p", "1");
	const res = await fetch(url.toString(), { headers: {
		"User-Agent": UA,
		Referer: "https://duckduckgo.com/",
		Accept: "application/json"
	} });
	if (!res.ok) throw new Error(`DDG i.js HTTP ${res.status}`);
	const data = await res.json();
	const hits = [];
	for (const r of data.results || []) {
		const image = r.image || "";
		const thumb = r.thumbnail || image;
		if (!image) continue;
		if (!looksLikeGif(image) && !looksLikeGif(thumb)) continue;
		hits.push({
			id: `ddg_${hits.length}_${Buffer.from(image).toString("base64url").slice(0, 16)}`,
			title: r.title || "GIF",
			previewUrl: thumb || image,
			url: image,
			w: typeof r.width === "number" ? r.width : void 0,
			h: typeof r.height === "number" ? r.height : void 0,
			source: "ddg"
		});
		if (hits.length >= 24) break;
	}
	if (!hits.length) for (const r of (data.results || []).slice(0, 24)) {
		const image = r.image || "";
		if (!image) continue;
		hits.push({
			id: `ddg_${hits.length}_${Buffer.from(image).toString("base64url").slice(0, 16)}`,
			title: r.title || "GIF",
			previewUrl: r.thumbnail || image,
			url: image,
			w: typeof r.width === "number" ? r.width : void 0,
			h: typeof r.height === "number" ? r.height : void 0,
			source: "ddg"
		});
	}
	return hits;
}
async function searchGifsMain(query) {
	const errors = [];
	for (const [name, fn] of [["tenor", searchTenor], ["giphy", searchGiphy]]) try {
		const results = await fn(query);
		if (results.length) return {
			results,
			error: null
		};
	} catch (err) {
		console.warn(`[gif] ${name} failed`, err);
		errors.push(name);
	}
	try {
		const results = await searchDuckDuckGo(query);
		if (results.length) return {
			results,
			error: null
		};
		return {
			results: [],
			error: "По запросу ничего не найдено"
		};
	} catch (err) {
		console.warn("[gif] ddg failed", err);
		return {
			results: [],
			error: "Не удалось загрузить GIF. Проверьте сеть." + (errors.length ? ` (также: ${errors.join(", ")})` : "")
		};
	}
}
//#endregion
//#region electron/sessionStore.ts
function sessionFilePath() {
	return path.join(app.getPath("userData"), "matrix-session.enc");
}
function sessionPlainFallbackPath() {
	return path.join(app.getPath("userData"), "matrix-session.json");
}
function readSessionCredentials() {
	try {
		const encPath = sessionFilePath();
		if (fs$1.existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
			const buf = fs$1.readFileSync(encPath);
			const json = safeStorage.decryptString(buf);
			const parsed = JSON.parse(json);
			if (parsed?.baseUrl && parsed?.userId && parsed?.accessToken && parsed?.deviceId) return parsed;
			return null;
		}
		const plainPath = sessionPlainFallbackPath();
		if (fs$1.existsSync(plainPath)) {
			const json = fs$1.readFileSync(plainPath, "utf8");
			const parsed = JSON.parse(json);
			if (parsed?.baseUrl && parsed?.userId && parsed?.accessToken && parsed?.deviceId) return parsed;
		}
	} catch (err) {
		console.warn("[sessionStore] read failed:", err);
	}
	return null;
}
function writeSessionCredentials(creds) {
	try {
		const json = JSON.stringify(creds);
		if (safeStorage.isEncryptionAvailable()) {
			const encrypted = safeStorage.encryptString(json);
			fs$1.writeFileSync(sessionFilePath(), encrypted);
			try {
				fs$1.unlinkSync(sessionPlainFallbackPath());
			} catch {}
			return { ok: true };
		}
		fs$1.writeFileSync(sessionPlainFallbackPath(), json, "utf8");
		return {
			ok: true,
			reason: "plain-fallback"
		};
	} catch (err) {
		console.warn("[sessionStore] write failed:", err);
		return {
			ok: false,
			reason: err instanceof Error ? err.message : String(err)
		};
	}
}
function clearSessionCredentials() {
	for (const p of [sessionFilePath(), sessionPlainFallbackPath()]) try {
		fs$1.unlinkSync(p);
	} catch {}
}
//#endregion
//#region electron/main.ts
var __dirname = path.dirname(fileURLToPath(import.meta.url));
var VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
var mainWindow = null;
var creatingWindow = false;
function broadcastMainError(error, kind) {
	const err = error instanceof Error ? error : new Error(String(error));
	const payload = {
		title: kind === "rejection" ? "Сбой фоновой задачи (main)" : "Сбой системного процесса",
		summary: "Ошибка в Electron main process. Окно приложения постарались сохранить.",
		detail: err.message,
		stack: err.stack
	};
	for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("main-error", payload);
}
function createWindow() {
	if (creatingWindow) return;
	creatingWindow = true;
	try {
		mainWindow = new BrowserWindow({
			width: 1200,
			height: 800,
			frame: false,
			titleBarStyle: "hidden",
			trafficLightPosition: {
				x: 16,
				y: 16
			},
			vibrancy: "under-window",
			backgroundColor: "#00000000",
			webPreferences: {
				preload: path.join(__dirname, "preload.cjs"),
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				partition: "persist:matrix-macos-client"
			}
		});
		if (VITE_DEV_SERVER_URL) {
			mainWindow.loadURL(VITE_DEV_SERVER_URL);
			mainWindow.webContents.openDevTools();
		} else mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
		mainWindow.webContents.on("render-process-gone", (_event, details) => {
			broadcastMainError(/* @__PURE__ */ new Error(`Renderer crashed: ${details.reason} (exit ${details.exitCode})`), "exception");
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
			mainWindow = null;
		});
		mainWindow.on("closed", () => {
			mainWindow = null;
		});
	} finally {
		creatingWindow = false;
	}
}
/** Extract loginToken from an SSO redirect URL */
function extractLoginToken(url) {
	try {
		return new URL(url).searchParams.get("loginToken");
	} catch {
		const match = url.match(/[?&]loginToken=([^&]+)/);
		return match ? decodeURIComponent(match[1]) : null;
	}
}
ipcMain.handle("session-get", () => {
	return readSessionCredentials();
});
ipcMain.handle("session-set", (_event, creds) => {
	if (!creds || typeof creds.baseUrl !== "string" || typeof creds.userId !== "string" || typeof creds.accessToken !== "string") return {
		ok: false,
		reason: "invalid-credentials"
	};
	return writeSessionCredentials(creds);
});
ipcMain.handle("session-clear", () => {
	clearSessionCredentials();
});
ipcMain.handle("open-external", async (_event, url) => {
	await shell.openExternal(url);
});
ipcMain.handle("save-text-file", async (_event, opts) => {
	const content = typeof opts?.content === "string" ? opts.content : "";
	const defaultPath = typeof opts?.defaultPath === "string" && opts.defaultPath.trim() ? opts.defaultPath.trim() : `matrix-error-report-${Date.now()}.txt`;
	const result = await dialog.showSaveDialog(mainWindow ?? void 0, {
		title: "Сохранить отчёт",
		defaultPath,
		filters: [{
			name: "Text",
			extensions: ["txt"]
		}, {
			name: "All Files",
			extensions: ["*"]
		}]
	});
	if (result.canceled || !result.filePath) return {
		ok: false,
		canceled: true
	};
	await fs.writeFile(result.filePath, content, "utf8");
	return {
		ok: true,
		path: result.filePath
	};
});
ipcMain.handle("search-gifs", async (_event, query) => {
	return searchGifsMain(typeof query === "string" ? query : "");
});
ipcMain.handle("set-dock-badge", (_event, count) => {
	if (process.platform !== "darwin" || !app.dock) return;
	const n = typeof count === "number" ? count : Number(count);
	if (!Number.isFinite(n) || n <= 0) {
		app.dock.setBadge("");
		return;
	}
	app.dock.setBadge(n > 99 ? "99+" : String(Math.floor(n)));
});
ipcMain.handle("is-window-focused", () => {
	return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
});
ipcMain.handle("show-notification", (_event, payload) => {
	if (!Notification.isSupported()) {
		console.warn("[notifications] Notification.isSupported() === false");
		return {
			ok: false,
			reason: "unsupported"
		};
	}
	const title = typeof payload?.title === "string" && payload.title.trim() ? payload.title.trim() : "Новое сообщение";
	const body = typeof payload?.body === "string" ? payload.body.slice(0, 240) : "";
	const roomId = typeof payload?.roomId === "string" ? payload.roomId : void 0;
	const eventId = typeof payload?.eventId === "string" ? payload.eventId : void 0;
	try {
		const notif = new Notification({
			title,
			body,
			silent: false
		});
		notif.on("show", () => {
			console.info("[notifications] shown:", title);
		});
		notif.on("failed", (_e, err) => {
			console.warn("[notifications] failed:", err);
		});
		notif.on("click", () => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				if (mainWindow.isMinimized()) mainWindow.restore();
				mainWindow.show();
				mainWindow.focus();
				if (roomId) mainWindow.webContents.send("notification-clicked", {
					roomId,
					eventId
				});
			}
		});
		notif.show();
		if (process.platform === "darwin" && app.dock) app.dock.bounce("informational");
		return { ok: true };
	} catch (err) {
		console.warn("[notifications] throw:", err);
		return {
			ok: false,
			reason: err instanceof Error ? err.message : String(err)
		};
	}
});
/**
* Open SSO in a controlled BrowserWindow and resolve with loginToken
* when the homeserver redirects back to redirectUrlPrefix.
*/
ipcMain.handle("sso-login", async (_event, ssoUrl, redirectUrlPrefix) => {
	return new Promise((resolve, reject) => {
		const authWin = new BrowserWindow({
			width: 560,
			height: 720,
			parent: mainWindow ?? void 0,
			modal: false,
			show: true,
			title: "Sign in",
			backgroundColor: "#0e1621",
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true
			}
		});
		let settled = false;
		const finish = (token, error) => {
			if (settled) return;
			settled = true;
			if (!authWin.isDestroyed()) authWin.close();
			if (token) resolve(token);
			else reject(error ?? /* @__PURE__ */ new Error("SSO cancelled"));
		};
		const tryCapture = (navUrl) => {
			if (redirectUrlPrefix && !navUrl.startsWith(redirectUrlPrefix) && !navUrl.includes("loginToken=")) return false;
			const token = extractLoginToken(navUrl);
			if (token) {
				finish(token);
				return true;
			}
			return false;
		};
		authWin.webContents.on("will-redirect", (event, url) => {
			if (tryCapture(url)) event.preventDefault();
		});
		authWin.webContents.on("will-navigate", (event, url) => {
			if (tryCapture(url)) event.preventDefault();
		});
		authWin.webContents.on("did-navigate", (_event, url) => {
			tryCapture(url);
		});
		authWin.on("closed", () => {
			if (!settled) finish(null, /* @__PURE__ */ new Error("SSO window closed"));
		});
		authWin.loadURL(ssoUrl).catch((err) => {
			finish(null, err instanceof Error ? err : new Error(String(err)));
		});
	});
});
app.whenReady().then(() => {
	createWindow();
	process.on("uncaughtException", (error) => {
		console.error("[main uncaughtException]", error);
		broadcastMainError(error, "exception");
	});
	process.on("unhandledRejection", (reason) => {
		console.error("[main unhandledRejection]", reason);
		broadcastMainError(reason, "rejection");
	});
});
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
	else if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.show();
		mainWindow.focus();
	}
});
//#endregion
export {};
