import { createRequire } from "node:module";
import { ipcRenderer } from "electron";
//#endregion
//#region electron/preload.ts
window.require = /* @__PURE__ */ (() => createRequire(import.meta.url))();
window.global = window;
window.electronAPI = {
	openExternal: (url) => ipcRenderer.invoke("open-external", url),
	ssoLogin: (ssoUrl, redirectUrlPrefix) => ipcRenderer.invoke("sso-login", ssoUrl, redirectUrlPrefix),
	searchGifs: (query) => ipcRenderer.invoke("search-gifs", query),
	showNotification: (payload) => ipcRenderer.invoke("show-notification", payload),
	setDockBadge: (count) => ipcRenderer.invoke("set-dock-badge", count),
	isWindowFocused: () => ipcRenderer.invoke("is-window-focused"),
	saveTextFile: (opts) => ipcRenderer.invoke("save-text-file", opts),
	onMainError: (handler) => {
		const listener = (_event, payload) => handler(payload);
		ipcRenderer.on("main-error", listener);
		return () => ipcRenderer.removeListener("main-error", listener);
	},
	onNotificationClicked: (handler) => {
		const listener = (_event, payload) => handler(payload);
		ipcRenderer.on("notification-clicked", listener);
		return () => ipcRenderer.removeListener("notification-clicked", listener);
	}
};
//#endregion
export {};
