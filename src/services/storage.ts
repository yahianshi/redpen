import { SessionData, Stroke, UserSettings, PageStrokesMap } from '../types';

const DB_NAME = 'ClassroomStylusDB';
const DB_VERSION = 1;
const STORE_CLEAN_PDFS = 'cleanPdfs';
const STORE_SESSION_STROKES = 'sessionStrokes';

export const DEFAULT_SETTINGS: UserSettings = {
  oauthClientId: '',
  defaultPenColor: '#f0393c', // RedPen brand red
  defaultPenThickness: 3,
  defaultHighlighterColor: '#facc15', // Yellow
  defaultHighlighterThickness: 16,
  penOnlyMode: true, // Stylus/pen prioritized, palm rejection
  autosaveDelayMs: 2500, // 2.5s debounce
};

class StorageService {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryCleanPdfCache = new Map<string, ArrayBuffer>();
  private memoryStrokesCache = new Map<string, SessionData>();

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB not available in current context'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_CLEAN_PDFS)) {
          db.createObjectStore(STORE_CLEAN_PDFS, { keyPath: 'fileId' });
        }
        if (!db.objectStoreNames.contains(STORE_SESSION_STROKES)) {
          db.createObjectStore(STORE_SESSION_STROKES, { keyPath: 'fileId' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  // --- Clean Base PDF Cache ---
  async saveCleanBasePdf(fileId: string, pdfData: ArrayBuffer, originalRevisionId?: string): Promise<void> {
    this.memoryCleanPdfCache.set(fileId, pdfData);
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_CLEAN_PDFS, 'readwrite');
      const store = tx.objectStore(STORE_CLEAN_PDFS);
      store.put({
        fileId,
        data: pdfData,
        originalRevisionId,
        savedAt: Date.now(),
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[RedPen] Failed to persist clean PDF in IndexedDB, using memory:', err);
    }
  }

  async getCleanBasePdf(fileId: string): Promise<{ data: ArrayBuffer; originalRevisionId?: string } | null> {
    if (this.memoryCleanPdfCache.has(fileId)) {
      return { data: this.memoryCleanPdfCache.get(fileId)! };
    }

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_CLEAN_PDFS, 'readonly');
      const store = tx.objectStore(STORE_CLEAN_PDFS);
      const request = store.get(fileId);

      return await new Promise((resolve) => {
        request.onsuccess = () => {
          if (request.result && request.result.data) {
            this.memoryCleanPdfCache.set(fileId, request.result.data);
            resolve({
              data: request.result.data,
              originalRevisionId: request.result.originalRevisionId,
            });
          } else {
            resolve(null);
          }
        };
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  // --- Session Strokes Cache ---
  async getSessionStrokes(fileId: string): Promise<SessionData> {
    if (this.memoryStrokesCache.has(fileId)) {
      return this.memoryStrokesCache.get(fileId)!;
    }

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_SESSION_STROKES, 'readonly');
      const store = tx.objectStore(STORE_SESSION_STROKES);
      const request = store.get(fileId);

      return await new Promise((resolve) => {
        request.onsuccess = () => {
          if (request.result) {
            const data: SessionData = request.result;
            this.memoryStrokesCache.set(fileId, data);
            resolve(data);
          } else {
            const fresh: SessionData = {
              fileId,
              pageStrokes: {},
              lastSavedTime: 0,
              isDirty: false,
            };
            this.memoryStrokesCache.set(fileId, fresh);
            resolve(fresh);
          }
        };
        request.onerror = () => {
          const fresh: SessionData = {
            fileId,
            pageStrokes: {},
            lastSavedTime: 0,
            isDirty: false,
          };
          resolve(fresh);
        };
      });
    } catch {
      return {
        fileId,
        pageStrokes: {},
        lastSavedTime: 0,
        isDirty: false,
      };
    }
  }

  async saveSessionStrokes(sessionData: SessionData): Promise<void> {
    this.memoryStrokesCache.set(sessionData.fileId, sessionData);
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_SESSION_STROKES, 'readwrite');
      const store = tx.objectStore(STORE_SESSION_STROKES);
      store.put(sessionData);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[RedPen] Failed to persist strokes in IndexedDB, keeping in memory:', err);
    }
  }

  async clearSessionStrokes(fileId: string): Promise<void> {
    this.memoryStrokesCache.delete(fileId);
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_SESSION_STROKES, 'readwrite');
      const store = tx.objectStore(STORE_SESSION_STROKES);
      store.delete(fileId);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[RedPen] Error clearing session strokes:', err);
    }
  }

  // --- Chrome Storage User Settings ---
  async getSettings(): Promise<UserSettings> {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['classroom_stylus_settings'], (result) => {
          if (result && result.classroom_stylus_settings) {
            resolve({ ...DEFAULT_SETTINGS, ...result.classroom_stylus_settings });
          } else {
            resolve({ ...DEFAULT_SETTINGS });
          }
        });
      } else {
        resolve({ ...DEFAULT_SETTINGS });
      }
    });
  }

  async updateSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
    const current = await this.getSettings();
    const updated = { ...current, ...partial };
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ classroom_stylus_settings: updated }, () => {
          resolve(updated);
        });
      } else {
        resolve(updated);
      }
    });
  }
}

export const storage = new StorageService();
