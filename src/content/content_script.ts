import { ClassroomDetector } from './detector';
import { GradingToolbar } from '../ui/toolbar';
import { CanvasViewer } from '../ui/canvasViewer';
import { StylusEngine } from '../engine/stylus';
import { PdfFlattener } from '../services/flattener';
import { storage } from '../services/storage';
import { ClassroomContext, ExtensionMessage, ExtensionResponse, Stroke, SessionData } from '../types';

class ClassroomStylusApp {
  private detector: ClassroomDetector | null = null;
  private currentContext: ClassroomContext | null = null;

  private isCanvasActive: boolean = false;
  private stylusButton: HTMLButtonElement | null = null;
  private toolbar: GradingToolbar | null = null;
  private canvasViewer: CanvasViewer | null = null;
  private stylusEngine: StylusEngine | null = null;

  private cleanBasePdfBytes: ArrayBuffer | null = null;
  private sessionData: SessionData | null = null;
  private originalRevisionId: string | undefined = undefined;

  private autosaveTimer: any = null;
  private isSaving: boolean = false;
  private savePending: boolean = false;

  constructor() {
    this.init();
  }

  private init() {
    console.log('[ClassroomStylus] Extension initialized on Google Classroom.');

    this.detector = new ClassroomDetector({
      onSubmissionDetected: (ctx) => this.handleSubmissionDetected(ctx),
      onSubmissionChanged: (ctx) => this.handleSubmissionChanged(ctx),
      onSubmissionClosed: () => this.handleSubmissionClosed(),
    });

    window.addEventListener('beforeunload', () => {
      if (this.sessionData && this.sessionData.isDirty) {
        this.saveFlattenedPdf(true);
      }
    });
  }

  private async handleSubmissionDetected(ctx: ClassroomContext) {
    this.currentContext = ctx;
    this.injectGradeWithStylusButton();
  }

  private async handleSubmissionChanged(ctx: ClassroomContext) {
    if (this.isCanvasActive && this.sessionData?.isDirty) {
      await this.saveFlattenedPdf(true);
    }

    this.teardownCanvas();
    this.currentContext = ctx;
    this.injectGradeWithStylusButton();
  }

  private async handleSubmissionClosed() {
    if (this.isCanvasActive && this.sessionData?.isDirty) {
      await this.saveFlattenedPdf(true);
    }
    this.teardownCanvas();
    this.removeStylusButton();
    this.currentContext = null;
  }

  /**
   * Injects the native matching pill button "✏️ Grade with Stylus"
   * into Classroom's dark header bar (#202124) next to "Edit with"
   */
  private injectGradeWithStylusButton() {
    if (this.stylusButton && document.body.contains(this.stylusButton)) {
      return;
    }

    // Try finding the dark header bar or action bar in center preview
    const headerBar = this.findClassroomDarkHeader();
    if (!headerBar) {
      // Retry in 300ms if DOM is still rendering
      setTimeout(() => this.injectGradeWithStylusButton(), 350);
      return;
    }

    // Create pill button matching Classroom's "Edit with" button
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'classroom-stylus-inject-pill-btn';
    btn.innerHTML = `
      <span class="cs-btn-icon">✏️</span>
      <span class="cs-btn-text">Grade with Stylus</span>
    `;

    btn.addEventListener('click', () => {
      this.toggleCanvasMode();
    });

    // Find "Edit with" button or insert in center / right area
    const editWithBtn = this.findEditWithButton(headerBar);
    if (editWithBtn && editWithBtn.parentNode) {
      editWithBtn.parentNode.insertBefore(btn, editWithBtn.nextSibling);
    } else {
      headerBar.appendChild(btn);
    }

    this.stylusButton = btn;
  }

  private removeStylusButton() {
    if (this.stylusButton && this.stylusButton.parentNode) {
      this.stylusButton.parentNode.removeChild(this.stylusButton);
    }
    this.stylusButton = null;
  }

  /**
   * Finds Classroom's center PDF viewer dark header bar (#202124)
   */
  private findClassroomDarkHeader(): HTMLElement | null {
    // Look for dark bar containing PDF title or action icons
    const candidates = document.querySelectorAll<HTMLElement>(
      'header, [role="banner"], [role="toolbar"], div[style*="background-color: rgb(32, 33, 36)"]'
    );

    for (const el of candidates) {
      const bg = window.getComputedStyle(el).backgroundColor;
      // rgb(32, 33, 36) is #202124
      if (bg.includes('32, 33, 36') || bg.includes('32,33,36')) {
        return el;
      }
    }

    // Fallback: Check parent container of any PDF icon or iframe
    const iframe = document.querySelector('iframe');
    if (iframe && iframe.parentElement) {
      const siblingHeader = iframe.parentElement.querySelector('header, [role="banner"], div');
      if (siblingHeader) return siblingHeader as HTMLElement;
    }

    // Secondary fallback: find elements near top of preview
    const previewHeader = document.querySelector<HTMLElement>('[aria-label*="preview"], [data-header-container]');
    if (previewHeader) return previewHeader;

    return null;
  }

  private findEditWithButton(headerBar: HTMLElement): HTMLElement | null {
    const buttons = headerBar.querySelectorAll<HTMLElement>('button, [role="button"]');
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || '';
      if (text.includes('edit with') || text.includes('open with') || text.includes('lumin')) {
        return btn;
      }
    }
    return null;
  }

  /**
   * Toggles between native Classroom preview and our Stylus Grading Canvas
   */
  private async toggleCanvasMode() {
    if (this.isCanvasActive) {
      await this.exitCanvasMode();
    } else {
      await this.enterCanvasMode();
    }
  }

  private async enterCanvasMode() {
    if (!this.currentContext) {
      this.detector?.attemptExtractContext(true);
      this.currentContext = this.detector?.getCurrentContext() || null;
    }

    // Resolve fileId if not yet found
    let fileId = this.currentContext?.fileId;
    if (!fileId && this.currentContext?.courseId && this.currentContext?.courseWorkId && this.currentContext?.submissionId) {
      fileId = await this.resolveFileIdFromClassroomApi(
        this.currentContext.courseId,
        this.currentContext.courseWorkId,
        this.currentContext.submissionId
      );
      if (fileId && this.currentContext) {
        this.currentContext.fileId = fileId;
      }
    }

    if (!fileId) {
      this.showToast('Could not extract Google Drive fileId for this submission. Please ensure the PDF is open.', 'error');
      return;
    }

    // Locate center preview area to overlay
    const centerPreview = this.findCenterPreviewArea();
    if (!centerPreview) {
      this.showToast('Could not locate Classroom center preview area.', 'error');
      return;
    }

    this.isCanvasActive = true;
    if (this.stylusButton) {
      this.stylusButton.classList.add('active');
      this.stylusButton.querySelector('.cs-btn-text')!.textContent = '✓ Grading Active';
    }

    // Create and inject toolbar into header
    const headerBar = this.findClassroomDarkHeader() || centerPreview;
    this.toolbar = new GradingToolbar({
      onToolSelect: (tool) => {
        this.stylusEngine?.updateOptions({ activeTool: tool });
      },
      onPenColorChange: (color) => {
        this.stylusEngine?.updateOptions({ penColor: color });
      },
      onPenThicknessChange: (thickness) => {
        this.stylusEngine?.updateOptions({ penThickness: thickness });
      },
      onHighlighterColorChange: (color) => {
        this.stylusEngine?.updateOptions({ highlighterColor: color });
      },
      onUndo: () => {
        if (!this.canvasViewer || !this.stylusEngine) return;
        const result = this.stylusEngine.undo(this.canvasViewer.getStrokes());
        if (result) {
          this.canvasViewer.redrawSinglePageIndex(result.affectedPageIndex);
          this.markDirtyAndDebounceSave();
        }
      },
      onRedo: () => {
        if (!this.canvasViewer || !this.stylusEngine) return;
        const result = this.stylusEngine.redo(this.canvasViewer.getStrokes());
        if (result) {
          this.canvasViewer.redrawSinglePageIndex(result.affectedPageIndex);
          this.markDirtyAndDebounceSave();
        }
      },
      onTogglePenOnly: (penOnly) => {
        this.stylusEngine?.updateOptions({ penOnlyMode: penOnly });
      },
      onRestoreOriginal: () => {
        this.restoreOriginalSubmission();
      },
      onClose: () => {
        this.exitCanvasMode();
      },
    });

    headerBar.appendChild(this.toolbar.getElement());

    // Load user settings
    const settings = await storage.getSettings();

    // Initialize Stylus Engine
    this.stylusEngine = new StylusEngine({
      penOnlyMode: settings.penOnlyMode,
      activeTool: 'pen',
      penColor: settings.defaultPenColor,
      penThickness: settings.defaultPenThickness,
      highlighterColor: settings.defaultHighlighterColor,
      highlighterThickness: settings.defaultHighlighterThickness,
      onStrokeAdded: (pageIdx, stroke) => {
        this.markDirtyAndDebounceSave();
      },
      onStrokeErased: (pageIdx, stroke) => {
        this.markDirtyAndDebounceSave();
      },
      onHistoryChange: (canUndo, canRedo) => {
        this.toolbar?.setHistoryState(canUndo, canRedo);
      },
    });

    // Initialize Canvas Viewer
    this.canvasViewer = new CanvasViewer(this.stylusEngine, {
      onStrokeDrawn: () => {
        this.markDirtyAndDebounceSave();
      },
      onStrokeErased: () => {
        this.markDirtyAndDebounceSave();
      },
    });

    // Hide native iframe / preview container and insert our viewer
    centerPreview.classList.add('cs-overlay-active');
    centerPreview.appendChild(this.canvasViewer.getElement());

    // Load PDF bytes and session strokes
    await this.loadDocumentAndSession(fileId);
  }

  private findCenterPreviewArea(): HTMLElement | null {
    // Look for iframe container or center view
    const iframe = document.querySelector<HTMLIFrameElement>('iframe');
    if (iframe && iframe.parentElement) {
      return iframe.parentElement;
    }

    const mainContainer = document.querySelector<HTMLElement>('main, [role="main"]');
    if (mainContainer) return mainContainer;

    return document.body;
  }

  private async loadDocumentAndSession(fileId: string) {
    this.toolbar?.setSyncStatus('syncing');

    try {
      // 1. Get or fetch clean base PDF
      let cleanCache = await storage.getCleanBasePdf(fileId);
      if (!cleanCache) {
        // Fetch raw PDF via background worker
        const resp: ExtensionResponse<string> = await this.sendMessage({
          type: 'DRIVE_DOWNLOAD_FILE',
          fileId,
        });

        if (!resp.success) {
          throw new Error(resp.error || 'Failed to download PDF');
        }

        const rawBytes = this.base64ToArrayBuffer(resp.data);
        this.cleanBasePdfBytes = rawBytes;

        // Pin original revision 0
        try {
          const revsResp: ExtensionResponse<any[]> = await this.sendMessage({
            type: 'DRIVE_LIST_REVISIONS',
            fileId,
          });
          if (revsResp.success && revsResp.data && revsResp.data.length > 0) {
            this.originalRevisionId = revsResp.data[0].id;
            // Pin keepForever
            await this.sendMessage({
              type: 'DRIVE_PIN_REVISION',
              fileId,
              revisionId: this.originalRevisionId!,
            });
          }
        } catch (e) {
          console.warn('[ClassroomStylus] Non-critical: could not pin original revision:', e);
        }

        await storage.saveCleanBasePdf(fileId, rawBytes, this.originalRevisionId);
      } else {
        this.cleanBasePdfBytes = cleanCache.data;
        this.originalRevisionId = cleanCache.originalRevisionId;
      }

      // 2. Load session strokes
      this.sessionData = await storage.getSessionStrokes(fileId);

      // 3. Render in CanvasViewer
      if (this.canvasViewer && this.cleanBasePdfBytes) {
        await this.canvasViewer.loadPdf(this.cleanBasePdfBytes, this.sessionData.pageStrokes || {});
      }

      this.toolbar?.setSyncStatus('saved');
    } catch (err: any) {
      console.error('[ClassroomStylus] Error loading PDF:', err);
      this.toolbar?.setSyncStatus('error', err.message);
      this.showToast(`Error: ${err.message}`, 'error');
    }
  }

  private markDirtyAndDebounceSave() {
    if (!this.sessionData || !this.canvasViewer) return;

    this.sessionData.isDirty = true;
    this.sessionData.pageStrokes = this.canvasViewer.getStrokes();
    this.sessionData.lastSavedTime = Date.now();

    // Persist immediately to IndexedDB/memory so strokes are never lost
    storage.saveSessionStrokes(this.sessionData);

    this.toolbar?.setSyncStatus('unsaved');

    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
    }

    // 2.5s debounce before autosaving flattened PDF to Drive
    this.autosaveTimer = setTimeout(() => {
      this.saveFlattenedPdf();
    }, 2500);
  }

  /**
   * Non-compounding background flattener & Drive patch
   */
  private async saveFlattenedPdf(immediate = false): Promise<void> {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }

    if (!this.sessionData || !this.cleanBasePdfBytes || !this.canvasViewer) {
      return;
    }

    if (this.isSaving) {
      this.savePending = true;
      return;
    }

    this.isSaving = true;
    this.toolbar?.setSyncStatus('syncing');

    try {
      const strokes = this.canvasViewer.getStrokes();
      const fileId = this.sessionData.fileId;

      // 1. Flatten strokes onto fresh cleanBasePdfBytes copy using pdf-lib
      const modifiedBytes = await PdfFlattener.flattenStrokes(
        this.cleanBasePdfBytes,
        strokes
      );

      // 2. Convert to base64 for message passing to background service worker
      const base64Data = this.arrayBufferToBase64(modifiedBytes.slice().buffer as ArrayBuffer);

      // 3. Upload to Google Drive via PATCH uploadType=media
      const resp: ExtensionResponse<any> = await this.sendMessage({
        type: 'DRIVE_UPLOAD_FILE',
        fileId,
        pdfBase64: base64Data,
      });

      if (!resp.success) {
        throw new Error(resp.error || 'Failed to upload modified PDF');
      }

      this.sessionData.isDirty = false;
      this.sessionData.lastSavedTime = Date.now();
      await storage.saveSessionStrokes(this.sessionData);

      this.toolbar?.setSyncStatus('saved');
    } catch (err: any) {
      console.error('[ClassroomStylus] Autosave error:', err);
      this.toolbar?.setSyncStatus('error', err.message);
    } finally {
      this.isSaving = false;
      if (this.savePending) {
        this.savePending = false;
        this.saveFlattenedPdf();
      }
    }
  }

  /**
   * "↺ Reset to Original"
   */
  private async restoreOriginalSubmission() {
    if (!this.sessionData || !this.cleanBasePdfBytes || !this.canvasViewer) return;

    this.toolbar?.setSyncStatus('syncing');

    try {
      const fileId = this.sessionData.fileId;

      let cleanBytes: ArrayBuffer = this.cleanBasePdfBytes;

      // If originalRevisionId is tracked, attempt to fetch clean revision bytes
      if (this.originalRevisionId) {
        const revResp: ExtensionResponse<string> = await this.sendMessage({
          type: 'DRIVE_DOWNLOAD_REVISION',
          fileId,
          revisionId: this.originalRevisionId,
        });
        if (revResp.success && revResp.data) {
          cleanBytes = this.base64ToArrayBuffer(revResp.data);
          this.cleanBasePdfBytes = cleanBytes;
        }
      }

      // 1. Clear session strokes
      this.sessionData.pageStrokes = {};
      this.sessionData.isDirty = false;
      this.sessionData.lastSavedTime = Date.now();
      await storage.clearSessionStrokes(fileId);

      // 2. Upload clean bytes to Drive
      const base64Data = this.arrayBufferToBase64(cleanBytes);
      const resp: ExtensionResponse<any> = await this.sendMessage({
        type: 'DRIVE_UPLOAD_FILE',
        fileId,
        pdfBase64: base64Data,
      });

      if (!resp.success) {
        throw new Error(resp.error || 'Failed to restore clean PDF to Drive');
      }

      // 3. Reset viewer strokes and re-render
      this.canvasViewer.setStrokes({});
      this.toolbar?.setSyncStatus('saved');
      this.showToast('Student submission restored to original unannotated upload.', 'info');
    } catch (err: any) {
      console.error('[ClassroomStylus] Failed to restore original:', err);
      this.toolbar?.setSyncStatus('error', err.message);
      this.showToast(`Restore failed: ${err.message}`, 'error');
    }
  }

  private async exitCanvasMode() {
    if (this.sessionData && this.sessionData.isDirty) {
      await this.saveFlattenedPdf(true);
    }
    this.teardownCanvas();
  }

  private teardownCanvas() {
    this.isCanvasActive = false;

    if (this.stylusButton) {
      this.stylusButton.classList.remove('active');
      this.stylusButton.querySelector('.cs-btn-text')!.textContent = 'Grade with Stylus';
    }

    if (this.toolbar) {
      const el = this.toolbar.getElement();
      if (el.parentNode) el.parentNode.removeChild(el);
      this.toolbar = null;
    }

    if (this.canvasViewer) {
      const el = this.canvasViewer.getElement();
      if (el.parentNode) el.parentNode.removeChild(el);
      this.canvasViewer.destroy();
      this.canvasViewer = null;
    }

    const centerPreview = this.findCenterPreviewArea();
    if (centerPreview) {
      centerPreview.classList.remove('cs-overlay-active');
    }

    this.cleanBasePdfBytes = null;
    this.sessionData = null;
  }

  // --- Helpers ---
  private async resolveFileIdFromClassroomApi(
    courseId: string,
    courseWorkId: string,
    submissionId: string
  ): Promise<string | undefined> {
    const resp: ExtensionResponse<any> = await this.sendMessage({
      type: 'CLASSROOM_GET_SUBMISSION',
      courseId,
      courseWorkId,
      submissionId,
    });

    if (resp.success && resp.data) {
      const attachments = resp.data.assignmentSubmission?.attachments || [];
      for (const att of attachments) {
        if (att.driveFile && att.driveFile.id) {
          return att.driveFile.id;
        }
      }
    }
    return undefined;
  }

  private sendMessage<T = any>(msg: ExtensionMessage): Promise<ExtensionResponse<T>> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: chrome.runtime.lastError.message || 'Extension background script unreachable',
          });
        } else {
          resolve(response || { success: false, error: 'Empty response from background' });
        }
      });
    });
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private showToast(message: string, type: 'info' | 'error' = 'info') {
    const toast = document.createElement('div');
    toast.className = `cs-toast cs-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }
}

// Instantiate on Google Classroom page
new ClassroomStylusApp();
