// src/services/storage.ts
var e = "cleanPdfs", t = "sessionStrokes", n = {
	oauthClientId: "",
	defaultPenColor: "#ef4444",
	defaultPenThickness: 3,
	defaultHighlighterColor: "#facc15",
	defaultHighlighterThickness: 16,
	penOnlyMode: !0,
	autosaveDelayMs: 2500
}, r = new class {
	dbPromise = null;
	memoryCleanPdfCache = /* @__PURE__ */ new Map();
	memoryStrokesCache = /* @__PURE__ */ new Map();
	getDB() {
		return this.dbPromise ||= new Promise((n, r) => {
			if (typeof indexedDB > "u") {
				r(/* @__PURE__ */ Error("IndexedDB not available in current context"));
				return;
			}
			let i = indexedDB.open("ClassroomStylusDB", 1);
			i.onupgradeneeded = (n) => {
				let r = n.target.result;
				r.objectStoreNames.contains(e) || r.createObjectStore(e, { keyPath: "fileId" }), r.objectStoreNames.contains(t) || r.createObjectStore(t, { keyPath: "fileId" });
			}, i.onsuccess = () => n(i.result), i.onerror = () => r(i.error);
		}), this.dbPromise;
	}
	async saveCleanBasePdf(t, n, r) {
		this.memoryCleanPdfCache.set(t, n);
		try {
			let i = (await this.getDB()).transaction(e, "readwrite");
			i.objectStore(e).put({
				fileId: t,
				data: n,
				originalRevisionId: r,
				savedAt: Date.now()
			}), await new Promise((e, t) => {
				i.oncomplete = () => e(), i.onerror = () => t(i.error);
			});
		} catch (e) {
			console.warn("[ClassroomStylus] Failed to persist clean PDF in IndexedDB, using memory:", e);
		}
	}
	async getCleanBasePdf(t) {
		if (this.memoryCleanPdfCache.has(t)) return { data: this.memoryCleanPdfCache.get(t) };
		try {
			let n = (await this.getDB()).transaction(e, "readonly").objectStore(e).get(t);
			return await new Promise((e) => {
				n.onsuccess = () => {
					n.result && n.result.data ? (this.memoryCleanPdfCache.set(t, n.result.data), e({
						data: n.result.data,
						originalRevisionId: n.result.originalRevisionId
					})) : e(null);
				}, n.onerror = () => e(null);
			});
		} catch {
			return null;
		}
	}
	async getSessionStrokes(e) {
		if (this.memoryStrokesCache.has(e)) return this.memoryStrokesCache.get(e);
		try {
			let n = (await this.getDB()).transaction(t, "readonly").objectStore(t).get(e);
			return await new Promise((t) => {
				n.onsuccess = () => {
					if (n.result) {
						let r = n.result;
						this.memoryStrokesCache.set(e, r), t(r);
					} else {
						let n = {
							fileId: e,
							pageStrokes: {},
							lastSavedTime: 0,
							isDirty: !1
						};
						this.memoryStrokesCache.set(e, n), t(n);
					}
				}, n.onerror = () => {
					t({
						fileId: e,
						pageStrokes: {},
						lastSavedTime: 0,
						isDirty: !1
					});
				};
			});
		} catch {
			return {
				fileId: e,
				pageStrokes: {},
				lastSavedTime: 0,
				isDirty: !1
			};
		}
	}
	async saveSessionStrokes(e) {
		this.memoryStrokesCache.set(e.fileId, e);
		try {
			let n = (await this.getDB()).transaction(t, "readwrite");
			n.objectStore(t).put(e), await new Promise((e, t) => {
				n.oncomplete = () => e(), n.onerror = () => t(n.error);
			});
		} catch (e) {
			console.warn("[ClassroomStylus] Failed to persist strokes in IndexedDB, keeping in memory:", e);
		}
	}
	async clearSessionStrokes(e) {
		this.memoryStrokesCache.delete(e);
		try {
			let n = (await this.getDB()).transaction(t, "readwrite");
			n.objectStore(t).delete(e), await new Promise((e, t) => {
				n.oncomplete = () => e(), n.onerror = () => t(n.error);
			});
		} catch (e) {
			console.warn("[ClassroomStylus] Error clearing session strokes:", e);
		}
	}
	async getSettings() {
		return new Promise((e) => {
			typeof chrome < "u" && chrome.storage && chrome.storage.local ? chrome.storage.local.get(["classroom_stylus_settings"], (t) => {
				t && t.classroom_stylus_settings ? e({
					...n,
					...t.classroom_stylus_settings
				}) : e({ ...n });
			}) : e({ ...n });
		});
	}
	async updateSettings(e) {
		let t = {
			...await this.getSettings(),
			...e
		};
		return new Promise((e) => {
			typeof chrome < "u" && chrome.storage && chrome.storage.local ? chrome.storage.local.set({ classroom_stylus_settings: t }, () => {
				e(t);
			}) : e(t);
		});
	}
}(), i = "classroom_stylus_oauth", a = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/classroom.coursework.students.readonly"], o = class e {
	static getRedirectUrl() {
		return typeof chrome < "u" && chrome.identity && chrome.identity.getRedirectURL ? chrome.identity.getRedirectURL("oauth2") : `https://${chrome.runtime.id}.chromiumapp.org/oauth2`;
	}
	static async getCachedToken() {
		return new Promise((e) => {
			chrome.storage.local.get([i], (t) => {
				let n = t[i];
				n && n.accessToken && n.expiresAt > Date.now() ? e(n) : e(null);
			});
		});
	}
	static async saveToken(e) {
		return new Promise((t) => {
			chrome.storage.local.set({ [i]: e }, () => {
				t();
			});
		});
	}
	static async clearToken() {
		return new Promise((e) => {
			chrome.storage.local.remove([i], () => {
				e();
			});
		});
	}
	static async getValidToken(t = !0) {
		let n = await this.getCachedToken();
		if (n) return n.accessToken;
		let i = (await r.getSettings()).oauthClientId?.trim();
		if (!i) throw Error("Google OAuth Client ID is not configured. Please open the extension popup or options to set your Client ID.");
		let o = this.getRedirectUrl(), s = encodeURIComponent(a.join(" ")), c = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(i)}&response_type=token&redirect_uri=${encodeURIComponent(o)}&scope=${s}&prompt=select_account`;
		return new Promise((n, r) => {
			chrome.identity.launchWebAuthFlow({
				url: c,
				interactive: t
			}, async (t) => {
				if (chrome.runtime.lastError || !t) {
					let e = chrome.runtime.lastError?.message || "Authentication cancelled or window closed";
					r(Error(e));
				} else try {
					let i = new URL(t).hash.substring(1), a = new URLSearchParams(i), o = a.get("access_token"), s = a.get("expires_in"), c = a.get("error");
					if (c) {
						r(/* @__PURE__ */ Error(`OAuth Error: ${c}`));
						return;
					}
					if (!o) {
						r(/* @__PURE__ */ Error("No access_token found in OAuth redirect response."));
						return;
					}
					let l = s ? parseInt(s, 10) : 3600, u = {
						accessToken: o,
						expiresAt: Date.now() + Math.max(300, l - 120) * 1e3,
						scope: a.get("scope") || void 0
					};
					await e.saveToken(u), n(o);
				} catch (e) {
					r(/* @__PURE__ */ Error(`Failed to parse OAuth redirect: ${e.message}`));
				}
			});
		});
	}
}, s = class {
	static async authFetch(e, t = {}) {
		let n = await o.getValidToken(!0), r = new Headers(t.headers || {});
		r.set("Authorization", `Bearer ${n}`);
		let i = await fetch(e, {
			...t,
			headers: r
		});
		if (i.status === 401) {
			await o.clearToken();
			let n = await o.getValidToken(!0);
			return r.set("Authorization", `Bearer ${n}`), fetch(e, {
				...t,
				headers: r
			});
		}
		return i;
	}
	static async downloadPdf(e) {
		let t = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(e)}?alt=media&supportsAllDrives=true`, n = await this.authFetch(t);
		if (!n.ok) {
			let e = await n.text();
			throw Error(`Failed to download PDF (${n.status}): ${e}`);
		}
		return await n.arrayBuffer();
	}
	static async uploadPdf(e, t) {
		let n = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(e)}?uploadType=media&supportsAllDrives=true`, r = t.slice().buffer, i = await this.authFetch(n, {
			method: "PATCH",
			headers: { "Content-Type": "application/pdf" },
			body: r
		});
		if (!i.ok) {
			let e = await i.text();
			throw Error(`Failed to upload PDF (${i.status}): ${e}`);
		}
		return await i.json();
	}
	static async listRevisions(e) {
		let t = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(e)}/revisions?fields=revisions(id,modifiedTime,keepForever,originalFilename,size)&supportsAllDrives=true`, n = await this.authFetch(t);
		if (!n.ok) {
			let e = await n.text();
			throw Error(`Failed to list revisions (${n.status}): ${e}`);
		}
		return (await n.json()).revisions || [];
	}
	static async pinOriginalRevision(e, t) {
		let n = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(e)}/revisions/${encodeURIComponent(t)}?supportsAllDrives=true`, r = await this.authFetch(n, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keepForever: !0 })
		});
		r.ok || console.warn(`[ClassroomStylus] Failed to pin revision ${t}:`, await r.text());
	}
	static async downloadRevision(e, t) {
		let n = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(e)}/revisions/${encodeURIComponent(t)}?alt=media&supportsAllDrives=true`, r = await this.authFetch(n);
		if (!r.ok) {
			let e = await r.text();
			throw Error(`Failed to download revision ${t} (${r.status}): ${e}`);
		}
		return await r.arrayBuffer();
	}
	static async getClassroomSubmission(e, t, n) {
		try {
			let r = `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(e)}/courseWork/${encodeURIComponent(t)}/studentSubmissions?userId=${encodeURIComponent(n)}`, i = await this.authFetch(r);
			if (i.ok) {
				let e = await i.json();
				if (e.studentSubmissions && e.studentSubmissions.length > 0) return e.studentSubmissions[0];
			}
		} catch (e) {
			console.warn("[ClassroomStylus] List by userId failed, trying get:", e);
		}
		try {
			let r = `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(e)}/courseWork/${encodeURIComponent(t)}/studentSubmissions/${encodeURIComponent(n)}`, i = await this.authFetch(r);
			if (i.ok) return await i.json();
		} catch (e) {
			console.warn("[ClassroomStylus] Get by submissionId failed, trying full list:", e);
		}
		try {
			let r = `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(e)}/courseWork/${encodeURIComponent(t)}/studentSubmissions?pageSize=50`, i = await this.authFetch(r);
			if (i.ok) {
				let e = (await i.json()).studentSubmissions || [], t = e.find((e) => e.userId === n || e.id === n);
				if (t) return t;
				if (e.length > 0) return e[0];
			}
		} catch (e) {
			console.warn("[ClassroomStylus] Coursework submissions list failed:", e);
		}
		throw Error("Could not find student submission in Google Classroom API");
	}
	static async searchFileByName(e) {
		let t = e.replace(/'/g, "\\'").trim(), n = t.replace(/\s*\.pdf$/i, "").trim();
		try {
			let e = `https://www.googleapis.com/drive/v3/files?q=${`name = '${encodeURIComponent(t)}' and trashed = false`}&orderBy=modifiedTime desc&pageSize=5&supportsAllDrives=true`, n = await this.authFetch(e);
			if (n.ok) {
				let e = await n.json();
				if (e.files && e.files.length > 0) return e.files[0].id;
			}
		} catch (e) {
			console.warn("[ClassroomStylus] Exact search error:", e);
		}
		try {
			let e = `https://www.googleapis.com/drive/v3/files?q=${`name contains '${encodeURIComponent(n)}' and mimeType = 'application/pdf' and trashed = false`}&orderBy=modifiedTime desc&pageSize=5&supportsAllDrives=true`, t = await this.authFetch(e);
			if (t.ok) {
				let e = await t.json();
				if (e.files && e.files.length > 0) return e.files[0].id;
			}
		} catch (e) {
			console.warn("[ClassroomStylus] Contains search error:", e);
		}
	}
};
// src/background/background.ts
console.log("[ClassroomStylus] Background service worker started.");
function c(e) {
	let t = "", n = new Uint8Array(e), r = n.byteLength;
	for (let e = 0; e < r; e++) t += String.fromCharCode(n[e]);
	return btoa(t);
}
function l(e) {
	let t = atob(e), n = t.length, r = new Uint8Array(n);
	for (let e = 0; e < n; e++) r[e] = t.charCodeAt(e);
	return r;
}
chrome.runtime.onMessage.addListener((e, t, n) => (u(e).then((e) => n(e)).catch((e) => {
	console.error("[ClassroomStylus Background] Error processing message:", e), n({
		success: !1,
		error: e?.message || "Unknown background processing error"
	});
}), !0));
async function u(e) {
	switch (e.type) {
		case "AUTH_GET_TOKEN": try {
			return {
				success: !0,
				data: { token: await o.getValidToken(e.interactive ?? !0) }
			};
		} catch (e) {
			return {
				success: !1,
				error: e.message,
				needsAuth: !0
			};
		}
		case "AUTH_LOGOUT": return await o.clearToken(), {
			success: !0,
			data: null
		};
		case "AUTH_STATUS": {
			let e = await o.getCachedToken(), t = await r.getSettings(), n = o.getRedirectUrl();
			return {
				success: !0,
				data: {
					isAuthenticated: !!e,
					expiresAt: e?.expiresAt,
					clientId: t.oauthClientId,
					redirectUri: n
				}
			};
		}
		case "AUTH_SAVE_CLIENT_ID": return await r.updateSettings({ oauthClientId: e.clientId.trim() }), {
			success: !0,
			data: null
		};
		case "DRIVE_DOWNLOAD_FILE": return {
			success: !0,
			data: c(await s.downloadPdf(e.fileId))
		};
		case "DRIVE_UPLOAD_FILE": {
			let t = l(e.pdfBase64);
			return {
				success: !0,
				data: await s.uploadPdf(e.fileId, t)
			};
		}
		case "DRIVE_LIST_REVISIONS": return {
			success: !0,
			data: await s.listRevisions(e.fileId)
		};
		case "DRIVE_PIN_REVISION": return await s.pinOriginalRevision(e.fileId, e.revisionId), {
			success: !0,
			data: null
		};
		case "DRIVE_DOWNLOAD_REVISION": return {
			success: !0,
			data: c(await s.downloadRevision(e.fileId, e.revisionId))
		};
		case "DRIVE_SEARCH_NAME": return {
			success: !0,
			data: { fileId: await s.searchFileByName(e.fileName) }
		};
		case "OPEN_ANNOTATOR_TAB": {
			let t = chrome.runtime.getURL(`annotator.html?fileId=${encodeURIComponent(e.fileId)}&fileName=${encodeURIComponent(e.fileName || "")}`);
			return await chrome.tabs.create({ url: t }), {
				success: !0,
				data: null
			};
		}
		case "CLASSROOM_GET_SUBMISSION": return {
			success: !0,
			data: await s.getClassroomSubmission(e.courseId, e.courseWorkId, e.submissionId)
		};
		default: return {
			success: !1,
			error: "Unknown message type"
		};
	}
}
