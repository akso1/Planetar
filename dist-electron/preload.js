import { createRequire as e } from "node:module";
import { ipcRenderer as t } from "electron";
//#region \0rolldown/runtime.js
var n = /* @__PURE__ */ e(import.meta.url);
window.require = n, window.global = window, window.electronAPI = {
	openExternal: (e) => t.invoke("open-external", e),
	ssoLogin: (e, n) => t.invoke("sso-login", e, n),
	searchGifs: (e) => t.invoke("search-gifs", e),
	showNotification: (e) => t.invoke("show-notification", e),
	setDockBadge: (e) => t.invoke("set-dock-badge", e),
	isWindowFocused: () => t.invoke("is-window-focused"),
	saveTextFile: (e) => t.invoke("save-text-file", e),
	onMainError: (e) => {
		let n = (t, n) => e(n);
		return t.on("main-error", n), () => t.removeListener("main-error", n);
	},
	onNotificationClicked: (e) => {
		let n = (t, n) => e(n);
		return t.on("notification-clicked", n), () => t.removeListener("notification-clicked", n);
	}
};
//#endregion
export {};
