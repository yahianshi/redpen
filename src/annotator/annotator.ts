import { GradingToolbar } from '../ui/toolbar';
import { CanvasViewer } from '../ui/canvasViewer';
import { StylusEngine } from '../engine/stylus';
import { PdfFlattener } from '../services/flattener';
import { storage } from '../services/storage';
import { ExtensionMessage, ExtensionResponse, SessionData } from '../types';

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const fileId = params.get('fileId') || '';
  const fileName = params.get('fileName') || 'Document.pdf';

  document.title = `✏️ Grading - ${fileName}`;

  const toolbarHost = document.getElementById('toolbarHost')!;
  const canvasHost = document.getElementById('canvasHost')!;

  if (!fileId) {
    canvasHost.innerHTML = `
      <div class="cs-error-card">
        <h3 class="cs-error-title">No Google Drive File Specified</h3>
        <p class="cs-error-msg">Please open this page from Google Classroom or provide ?fileId={driveId} in the URL.</p>
      </div>
    `;
    return;
  }

  let cleanBasePdfBytes: ArrayBuffer | null = null;
  let sessionData: SessionData | null = null;
  let originalRevisionId: string | undefined = undefined;
  let autosaveTimer: any = null;
  let isSaving = false;
  let savePending = false;

  const settings = await storage.getSettings();

  const stylusEngine = new StylusEngine({
    penOnlyMode: settings.penOnlyMode,
    activeTool: 'pen',
    penColor: settings.defaultPenColor,
    penThickness: settings.defaultPenThickness,
    highlighterColor: settings.defaultHighlighterColor,
    highlighterThickness: settings.defaultHighlighterThickness,
    onStrokeAdded: () => markDirtyAndDebounceSave(),
    onStrokeErased: () => markDirtyAndDebounceSave(),
    onHistoryChange: (canUndo, canRedo) => toolbar.setHistoryState(canUndo, canRedo),
  });

  const canvasViewer = new CanvasViewer(stylusEngine, {
    onStrokeDrawn: () => markDirtyAndDebounceSave(),
    onStrokeErased: () => markDirtyAndDebounceSave(),
  });

  canvasHost.appendChild(canvasViewer.getElement());

  const toolbar = new GradingToolbar({
    onToolSelect: (tool) => stylusEngine.updateOptions({ activeTool: tool }),
    onPenColorChange: (color) => stylusEngine.updateOptions({ penColor: color }),
    onPenThicknessChange: (thick) => stylusEngine.updateOptions({ penThickness: thick }),
    onHighlighterColorChange: (color) => stylusEngine.updateOptions({ highlighterColor: color }),
    onUndo: () => {
      const result = stylusEngine.undo(canvasViewer.getStrokes());
      if (result) {
        canvasViewer.redrawSinglePageIndex(result.affectedPageIndex);
        markDirtyAndDebounceSave();
      }
    },
    onRedo: () => {
      const result = stylusEngine.redo(canvasViewer.getStrokes());
      if (result) {
        canvasViewer.redrawSinglePageIndex(result.affectedPageIndex);
        markDirtyAndDebounceSave();
      }
    },
    onTogglePenOnly: (penOnly) => stylusEngine.updateOptions({ penOnlyMode: penOnly }),
    onRestoreOriginal: async () => {
      if (!sessionData || !cleanBasePdfBytes) return;
      toolbar.setSyncStatus('syncing');
      try {
        let cleanBytes = cleanBasePdfBytes;
        if (originalRevisionId) {
          const revResp: ExtensionResponse<string> = await sendMessage({
            type: 'DRIVE_DOWNLOAD_REVISION',
            fileId,
            revisionId: originalRevisionId,
          });
          if (revResp.success && revResp.data) {
            cleanBytes = base64ToArrayBuffer(revResp.data);
            cleanBasePdfBytes = cleanBytes;
          }
        }
        sessionData.pageStrokes = {};
        sessionData.isDirty = false;
        await storage.clearSessionStrokes(fileId);

        const base64Data = arrayBufferToBase64(cleanBytes);
        await sendMessage({
          type: 'DRIVE_UPLOAD_FILE',
          fileId,
          pdfBase64: base64Data,
        });

        canvasViewer.setStrokes({});
        toolbar.setSyncStatus('saved');
      } catch (err: any) {
        toolbar.setSyncStatus('error', err.message);
      }
    },
    onOpenDedicatedTab: () => {
      // Already in dedicated tab
    },
    onClose: () => {
      window.close();
    },
  });

  toolbarHost.appendChild(toolbar.getElement());

  // Load PDF and session
  toolbar.setSyncStatus('syncing');
  try {
    let cleanCache = await storage.getCleanBasePdf(fileId);
    if (!cleanCache) {
      const resp: ExtensionResponse<string> = await sendMessage({
        type: 'DRIVE_DOWNLOAD_FILE',
        fileId,
      });
      if (!resp.success) {
        throw new Error(resp.error || 'Failed to download PDF');
      }
      cleanBasePdfBytes = base64ToArrayBuffer(resp.data);

      try {
        const revsResp: ExtensionResponse<any[]> = await sendMessage({
          type: 'DRIVE_LIST_REVISIONS',
          fileId,
        });
        if (revsResp.success && revsResp.data && revsResp.data.length > 0) {
          originalRevisionId = revsResp.data[0].id;
          await sendMessage({
            type: 'DRIVE_PIN_REVISION',
            fileId,
            revisionId: originalRevisionId!,
          });
        }
      } catch {}

      await storage.saveCleanBasePdf(fileId, cleanBasePdfBytes, originalRevisionId);
    } else {
      cleanBasePdfBytes = cleanCache.data;
      originalRevisionId = cleanCache.originalRevisionId;
    }

    sessionData = await storage.getSessionStrokes(fileId);
    await canvasViewer.loadPdf(cleanBasePdfBytes, sessionData.pageStrokes || {});
    toolbar.setSyncStatus('saved');
  } catch (err: any) {
    toolbar.setSyncStatus('error', err.message);
  }

  function markDirtyAndDebounceSave() {
    if (!sessionData) return;
    sessionData.isDirty = true;
    sessionData.pageStrokes = canvasViewer.getStrokes();
    sessionData.lastSavedTime = Date.now();
    storage.saveSessionStrokes(sessionData);
    toolbar.setSyncStatus('unsaved');

    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveFlattenedPdf, 2500);
  }

  async function saveFlattenedPdf() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    if (!sessionData || !cleanBasePdfBytes) return;

    if (isSaving) {
      savePending = true;
      return;
    }

    isSaving = true;
    toolbar.setSyncStatus('syncing');

    try {
      const strokes = canvasViewer.getStrokes();
      const modifiedBytes = await PdfFlattener.flattenStrokes(cleanBasePdfBytes, strokes);
      const base64Data = arrayBufferToBase64(modifiedBytes.slice().buffer as ArrayBuffer);

      const resp: ExtensionResponse<any> = await sendMessage({
        type: 'DRIVE_UPLOAD_FILE',
        fileId,
        pdfBase64: base64Data,
      });

      if (!resp.success) throw new Error(resp.error || 'Upload failed');

      sessionData.isDirty = false;
      await storage.saveSessionStrokes(sessionData);
      toolbar.setSyncStatus('saved');
    } catch (err: any) {
      toolbar.setSyncStatus('error', err.message);
    } finally {
      isSaving = false;
      if (savePending) {
        savePending = false;
        saveFlattenedPdf();
      }
    }
  }

  function sendMessage<T = any>(msg: ExtensionMessage): Promise<ExtensionResponse<T>> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        resolve(response || { success: false, error: 'Empty response' });
      });
    });
  }

  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
});
