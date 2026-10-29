import { contextBridge, ipcRenderer } from "electron";
import { type DesktopApi, IPC } from "../shared/ipc.ts";

/**
 * 渲染进程的唯一能力出口。
 *
 * 这里保持「只转发，不判断」：所有权限判定都在主进程。渲染进程拿到的是一个白名单
 * 函数集合，拿不到 `ipcRenderer` 本身，也就无法调用未声明的通道。
 */
const api: DesktopApi = {
	getState: () => ipcRenderer.invoke(IPC.stateGet),
	listReleases: (refresh) => ipcRenderer.invoke(IPC.releasesList, refresh === true),
	install: (version) => ipcRenderer.invoke(IPC.releasesInstall, version),
	activate: (version) => ipcRenderer.invoke(IPC.releasesActivate, version),
	remove: (version) => ipcRenderer.invoke(IPC.releasesRemove, version),
	start: () => ipcRenderer.invoke(IPC.serviceStart),
	stop: () => ipcRenderer.invoke(IPC.serviceStop),
	openConsole: () => ipcRenderer.invoke(IPC.serviceOpenConsole),
	openInBrowser: () => ipcRenderer.invoke(IPC.serviceOpenBrowser),
	dismissPassword: () => ipcRenderer.invoke(IPC.serviceDismissPassword),
	updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
	checkDesktopUpdate: () => ipcRenderer.invoke(IPC.desktopCheckUpdate),
	openReleasePage: () => ipcRenderer.invoke(IPC.desktopOpenReleasePage),
	openPath: (what) => ipcRenderer.invoke(IPC.shellOpenPath, what),
	onState: (listener) => subscribe(IPC.eventState, listener),
	onProgress: (listener) => subscribe(IPC.eventProgress, listener),
	onLog: (listener) => subscribe(IPC.eventLog, listener),
};

/**
 * 订阅主进程推送。
 *
 * `ipcRenderer.on` 的回调会带上 `event` 参数，而 `event.sender` 是渲染进程不该看见的
 * 对象；这里只把数据部分交出去。返回的函数用于在 React 卸载时摘掉监听。
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
	const handler = (_event: unknown, payload: T): void => listener(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("miubot", api);
