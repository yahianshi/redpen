import { ClassroomDetector, decodeClassroomParam } from './detector';
import { GradingToolbar } from '../ui/toolbar';
import { CanvasViewer } from '../ui/canvasViewer';
import { StylusEngine } from '../engine/stylus';
import { PdfFlattener } from '../services/flattener';
import { storage } from '../services/storage';
import { ClassroomContext, ExtensionMessage, ExtensionResponse, Stroke, SessionData } from '../types';

// ===================================================================
// IFRAME HELPER (runs inside drive.google.com embedded preview iframe)
// ===================================================================
function initIframeHelper() {
  const fileIdMatch = window.location.href.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
  const fileId = fileIdMatch ? fileIdMatch[1] : undefined;

  if (fileId && window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'CLASSROOM_STYLUS_IFRAME_FILEID', fileId }, '*');
  }

  function tryInjectIframeButton() {
    if (document.querySelector('.classroom-stylus-iframe-pill-btn')) return;

    const buttons = document.querySelectorAll<HTMLElement>('button, [role="button"], div[role="menuitem"]');
    let editWithBtn: HTMLElement | null = null;
    for (const btn of buttons) {
      const txt = (btn.textContent || '').toLowerCase();
      if (txt.includes('edit with') || txt.includes('open with') || txt.includes('lumin')) {
        editWithBtn = btn;
        break;
      }
    }

    const header = document.querySelector<HTMLElement>('header, [role="banner"], [role="toolbar"], div[style*="32, 33, 36"]');
    const targetParent = editWithBtn?.parentElement || header;

    if (targetParent) {
      const pillBtn = document.createElement('button');
      pillBtn.type = 'button';
      pillBtn.className = 'classroom-stylus-inject-pill-btn classroom-stylus-iframe-pill-btn';
      pillBtn.innerHTML = `
        <span class="cs-btn-icon">✏️</span>
        <span class="cs-btn-text">Grade with Stylus</span>
      `;
      pillBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.parent.postMessage({ type: 'CLASSROOM_STYLUS_ACTIVATE', fileId }, '*');
      });

      if (editWithBtn && editWithBtn.nextSibling) {
        editWithBtn.parentElement?.insertBefore(pillBtn, editWithBtn.nextSibling);
      } else {
        targetParent.appendChild(pillBtn);
      }
    } else {
      setTimeout(tryInjectIframeButton, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInjectIframeButton);
  } else {
    tryInjectIframeButton();
  }
}

// ===================================================================
// MAIN CLASSROOM APP (runs in top classroom.google.com window)
// ===================================================================
class ClassroomStylusApp {
  private detector: ClassroomDetector | null = null;
  private currentContext: ClassroomContext | null = null;

  private isCanvasActive: boolean = false;
  private overlayContainer: HTMLElement | null = null;
  private topBarButton: HTMLButtonElement | null = null;
  private floatingLauncher: HTMLElement | null = null;
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
    console.log('[ClassroomStylus] Main app initializing on Google Classroom...');

    this.detector = new ClassroomDetector({
      onSubmissionDetected: (ctx) => this.handleSubmissionDetected(ctx),
      onSubmissionChanged: (ctx) => this.handleSubmissionChanged(ctx),
      onSubmissionClosed: () => this.handleSubmissionClosed(),
    });

    window.addEventListener('message', (event) => {
      if (event.data?.type === 'CLASSROOM_STYLUS_IFRAME_FILEID' && event.data.fileId) {
        if (this.currentContext) {
          this.currentContext.fileId = event.data.fileId;
        }
      } else if (event.data?.type === 'CLASSROOM_STYLUS_ACTIVATE') {
        const fileId = event.data.fileId || this.currentContext?.fileId;
        this.enterCanvasMode(fileId);
      }
    });

    window.addEventListener('beforeunload', () => {
      if (this.sessionData && this.sessionData.isDirty) {
        this.saveFlattenedPdf(true);
      }
    });

    this.injectButtons();
  }

  private async handleSubmissionDetected(ctx: ClassroomContext) {
    this.currentContext = ctx;
    this.injectButtons();
  }

  private async handleSubmissionChanged(ctx: ClassroomContext) {
    if (this.isCanvasActive && this.sessionData?.isDirty) {
      await this.saveFlattenedPdf(true);
    }

    const wasActive = this.isCanvasActive;
    this.teardownCanvas();
    this.currentContext = ctx;
    this.injectButtons();

    if (wasActive) {
      setTimeout(() => this.enterCanvasMode(), 300);
    }
  }

  private async handleSubmissionClosed() {
    if (this.isCanvasActive && this.sessionData?.isDirty) {
      await this.saveFlattenedPdf(true);
    }
    this.teardownCanvas();
    this.removeButtons();
    this.currentContext = null;
  }

  private injectButtons() {
    this.injectTopBarButton();
    this.injectFloatingLauncher();
  }

  private injectTopBarButton() {
    if (this.topBarButton && document.body.contains(this.topBarButton)) {
      return;
    }

    const targetSubHeader = this.findClassroomTopSubHeader();
    if (!targetSubHeader) {
      setTimeout(() => this.injectTopBarButton(), 400);
      return;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'classroom-stylus-topbar-btn';
    btn.innerHTML = `
      <span class="cs-btn-icon">✏️</span>
      <span class="cs-btn-text">Grade with Stylus</span>
    `;

    btn.addEventListener('click', () => {
      this.toggleCanvasMode();
    });

    const returnBtn = this.findReturnButton(targetSubHeader);
    if (returnBtn && returnBtn.parentElement) {
      returnBtn.parentElement.insertBefore(btn, returnBtn);
    } else {
      targetSubHeader.appendChild(btn);
    }

    this.topBarButton = btn;
  }

  private injectFloatingLauncher() {
    if (this.floatingLauncher && document.body.contains(this.floatingLauncher)) {
      return;
    }

    const launcher = document.createElement('div');
    launcher.className = 'classroom-stylus-floating-launcher';
    launcher.innerHTML = `
      <button type="button" class="classroom-stylus-launch-btn">
        <span class="cs-btn-icon">✏️</span>
        <span class="cs-btn-text">Grade with Stylus</span>
      </button>
    `;

    const btn = launcher.querySelector<HTMLButtonElement>('.classroom-stylus-launch-btn')!;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      this.enterCanvasMode();
    });

    document.body.appendChild(launcher);
    this.floatingLauncher = launcher;
  }

  private removeButtons() {
    if (this.topBarButton && this.topBarButton.parentNode) {
      this.topBarButton.parentNode.removeChild(this.topBarButton);
      this.topBarButton = null;
    }
    if (this.floatingLauncher && this.floatingLauncher.parentNode) {
      this.floatingLauncher.parentNode.removeChild(this.floatingLauncher);
      this.floatingLauncher = null;
    }
  }

  private findClassroomTopSubHeader(): HTMLElement | null {
    const returnBtn = this.findReturnButton();
    if (returnBtn && returnBtn.parentElement) {
      return returnBtn.parentElement;
    }

    const arrows = document.querySelectorAll('button[aria-label*="next" i], button[aria-label*="previous" i]');
    if (arrows.length > 0 && arrows[0].parentElement) {
      return arrows[0].parentElement;
    }

    const headers = document.querySelectorAll<HTMLElement>('header, [role="banner"], [role="toolbar"], div[class*="header" i]');
    for (const h of headers) {
      if (h.textContent?.includes('.pdf') || h.textContent?.includes('Quiz') || h.textContent?.includes('Return')) {
        return h;
      }
    }

    return null;
  }

  private findReturnButton(scope: ParentNode = document): HTMLElement | null {
    const buttons = scope.querySelectorAll<HTMLElement>('button, [role="button"]');
    for (const b of buttons) {
      const txt = (b.textContent || '').trim().toLowerCase();
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      if (txt === 'return' || aria === 'return') {
        return b;
      }
    }
    return null;
  }

  private async toggleCanvasMode() {
    if (this.isCanvasActive) {
      await this.exitCanvasMode();
    } else {
      await this.enterCanvasMode();
    }
  }

  /**
   * Overrides the Google Drive center preview window and injects our custom Stylus Canvas.
   */
  public async enterCanvasMode(fileIdOverride?: string) {
    console.log('[ClassroomStylus] Entering Canvas Mode...');
    this.isCanvasActive = true;

    // 1. Immediately update button states
    if (this.topBarButton) {
      this.topBarButton.classList.add('active');
      this.topBarButton.querySelector('.cs-btn-text')!.textContent = '✓ Grading Active';
    }
    if (this.floatingLauncher) {
      this.floatingLauncher.style.display = 'none';
    }

    // 2. Immediately hide Google Drive preview iframes
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe');
    iframes.forEach((iframe) => {
      iframe.style.setProperty('display', 'none', 'important');
      iframe.setAttribute('data-cs-hidden', 'true');
    });

    // 3. Dynamically measure Classroom layout bounds
    // Left boundary: right edge of left navigation
    const leftNav = document.querySelector<HTMLElement>('nav, [role="navigation"]');
    const leftPx = leftNav ? Math.max(0, leftNav.getBoundingClientRect().right) : 72;

    // Right boundary: left edge of right grading sidebar ("Grade and feedback")
    let rightPx = 320;
    const allDivs = document.querySelectorAll<HTMLElement>('div, aside');
    for (const el of allDivs) {
      if (el.clientWidth > 240 && el.clientWidth < 400 && el.textContent?.includes('Grade and feedback')) {
        rightPx = Math.max(0, window.innerWidth - el.getBoundingClientRect().left);
        break;
      }
    }

    // Top boundary: bottom edge of top header
    const topHeader = this.findClassroomTopSubHeader() || document.querySelector<HTMLElement>('header, [role="banner"], [role="toolbar"]');
    const topPx = topHeader ? Math.max(0, topHeader.getBoundingClientRect().bottom) : 56;

    // 4. Create and mount our center overlay container
    if (!this.overlayContainer) {
      this.overlayContainer = document.createElement('div');
      this.overlayContainer.className = 'classroom-stylus-overlay-panel';
      this.overlayContainer.style.cssText = `
        position: fixed !important;
        top: ${topPx}px !important;
        left: ${leftPx}px !important;
        right: ${rightPx}px !important;
        bottom: 0px !important;
        z-index: 9999 !important;
        background-color: #171717 !important;
        display: flex !important;
        flex-direction: column !important;
        overflow: hidden !important;
        box-shadow: inset 0 2px 8px rgba(0,0,0,0.5);
      `;
      document.body.appendChild(this.overlayContainer);
    }

    this.overlayContainer.innerHTML = '';

    // 5. Mount Toolbar
    this.toolbar = new GradingToolbar({
      onToolSelect: (tool) => this.stylusEngine?.updateOptions({ activeTool: tool }),
      onPenColorChange: (color) => this.stylusEngine?.updateOptions({ penColor: color }),
      onPenThicknessChange: (thick) => this.stylusEngine?.updateOptions({ penThickness: thick }),
      onHighlighterColorChange: (color) => this.stylusEngine?.updateOptions({ highlighterColor: color }),
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
      onTogglePenOnly: (penOnly) => this.stylusEngine?.updateOptions({ penOnlyMode: penOnly }),
      onRestoreOriginal: () => this.restoreOriginalSubmission(),
      onOpenDedicatedTab: () => {
        const fId = this.currentContext?.fileId || fileIdOverride;
        if (fId) {
          chrome.runtime.sendMessage({
            type: 'OPEN_ANNOTATOR_TAB',
            fileId: fId,
            fileName: this.currentContext?.fileName || this.extractActiveFileName(),
          });
        } else {
          this.showToast('Please wait for document to load before opening dedicated tab.', 'info');
        }
      },
      onClose: () => this.exitCanvasMode(),
    });

    this.overlayContainer.appendChild(this.toolbar.getElement());

    // 6. Initialize Stylus Engine and Canvas Viewer
    const settings = await storage.getSettings();

    this.stylusEngine = new StylusEngine({
      penOnlyMode: settings.penOnlyMode,
      activeTool: 'pen',
      penColor: settings.defaultPenColor,
      penThickness: settings.defaultPenThickness,
      highlighterColor: settings.defaultHighlighterColor,
      highlighterThickness: settings.defaultHighlighterThickness,
      onStrokeAdded: () => this.markDirtyAndDebounceSave(),
      onStrokeErased: () => this.markDirtyAndDebounceSave(),
      onHistoryChange: (canUndo, canRedo) => this.toolbar?.setHistoryState(canUndo, canRedo),
    });

    this.canvasViewer = new CanvasViewer(this.stylusEngine, {
      onStrokeDrawn: () => this.markDirtyAndDebounceSave(),
      onStrokeErased: () => this.markDirtyAndDebounceSave(),
    });

    this.overlayContainer.appendChild(this.canvasViewer.getElement());

    // 7. Resolve Google Drive fileId with layered fallbacks
    let fileId = fileIdOverride || this.currentContext?.fileId;
    if (!fileId) {
      fileId = this.detector?.findGoogleDriveFileId();
    }

    const detectedFileName = this.extractActiveFileName();
    if (detectedFileName && this.currentContext) {
      this.currentContext.fileName = detectedFileName;
    }

    // Fallback: Drive search by filename
    if (!fileId && detectedFileName) {
      try {
        const searchResp: ExtensionResponse<any> = await this.sendMessage({
          type: 'DRIVE_SEARCH_NAME',
          fileName: detectedFileName,
        });
        if (searchResp.success && searchResp.data?.fileId) {
          fileId = searchResp.data.fileId;
        }
      } catch (e) {
        console.warn('[ClassroomStylus] File search fallback error:', e);
      }
    }

    // Fallback: Classroom API with decoded IDs
    if (!fileId && this.currentContext?.courseId && this.currentContext?.courseWorkId && this.currentContext?.submissionId) {
      try {
        fileId = await this.resolveFileIdFromClassroomApi(
          this.currentContext.courseId,
          this.currentContext.courseWorkId,
          this.currentContext.submissionId
        );
      } catch (e) {
        console.warn('[ClassroomStylus] Classroom API resolution error:', e);
      }
    }

    if (fileId && this.currentContext) {
      this.currentContext.fileId = fileId;
    }

    if (!fileId) {
      // In-canvas interactive prompt if fileId couldn't be auto-resolved
      this.showInCanvasFilePrompt(detectedFileName || 'Student PDF');
      return;
    }

    await this.loadDocumentAndSession(fileId);
  }

  private extractActiveFileName(): string | undefined {
    // Check elements for .pdf filenames
    const textNodes = document.querySelectorAll<HTMLElement>('[title*=".pdf"], [aria-label*=".pdf"], a, span, div');
    for (const el of textNodes) {
      const titleAttr = el.getAttribute('title') || el.getAttribute('aria-label') || '';
      const m1 = titleAttr.match(/\b([a-zA-Z0-9_\- ]+\.pdf)\b/i);
      if (m1) return m1[1].trim();

      const text = el.textContent || '';
      const m2 = text.match(/\b([a-zA-Z0-9_\- ]+\.pdf)\b/i);
      if (m2 && m2[1].length < 60) return m2[1].trim();
    }
    return undefined;
  }

  private showInCanvasFilePrompt(defaultName: string) {
    if (!this.canvasViewer) return;
    const scrollContainer = this.canvasViewer.getScrollContainer();
    scrollContainer.innerHTML = `
      <div class="cs-error-card" style="max-width: 520px; margin: 60px auto;">
        <svg class="cs-icon-lg" viewBox="0 0 24 24" fill="none" stroke="#8ab4f8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <h3 class="cs-error-title" style="color: #e8eaed; font-size: 18px;">Locating Google Drive File</h3>
        <p class="cs-error-msg">Searching Google Drive for <strong>${defaultName}</strong>...</p>
        <div style="display: flex; gap: 8px; margin-top: 16px; width: 100%;">
          <input type="text" id="csManualDriveInput" placeholder="Paste Google Drive File Link or ID" class="form-input" style="flex: 1; padding: 10px; font-size: 13px;" />
          <button type="button" id="csManualLoadBtn" class="btn btn-primary" style="padding: 0 16px;">Load PDF</button>
        </div>
      </div>
    `;

    const loadBtn = scrollContainer.querySelector<HTMLButtonElement>('#csManualLoadBtn');
    const input = scrollContainer.querySelector<HTMLInputElement>('#csManualDriveInput');

    loadBtn?.addEventListener('click', async () => {
      const val = input?.value.trim() || '';
      const m = val.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/) || val.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) || [null, val];
      const manualId = m[1];
      if (manualId && /^[a-zA-Z0-9_-]{20,}$/.test(manualId)) {
        if (this.currentContext) this.currentContext.fileId = manualId;
        await this.loadDocumentAndSession(manualId);
      } else {
        this.showToast('Please enter a valid Google Drive file ID or link.', 'error');
      }
    });
  }

  private async loadDocumentAndSession(fileId: string) {
    this.toolbar?.setSyncStatus('syncing');

    try {
      let cleanCache = await storage.getCleanBasePdf(fileId);
      if (!cleanCache) {
        const resp: ExtensionResponse<string> = await this.sendMessage({
          type: 'DRIVE_DOWNLOAD_FILE',
          fileId,
        });

        if (!resp.success) {
          throw new Error(resp.error || 'Failed to download PDF from Google Drive');
        }

        const rawBytes = this.base64ToArrayBuffer(resp.data);
        this.cleanBasePdfBytes = rawBytes;

        try {
          const revsResp: ExtensionResponse<any[]> = await this.sendMessage({
            type: 'DRIVE_LIST_REVISIONS',
            fileId,
          });
          if (revsResp.success && revsResp.data && revsResp.data.length > 0) {
            this.originalRevisionId = revsResp.data[0].id;
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

      this.sessionData = await storage.getSessionStrokes(fileId);

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

    storage.saveSessionStrokes(this.sessionData);
    this.toolbar?.setSyncStatus('unsaved');

    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
    }

    this.autosaveTimer = setTimeout(() => {
      this.saveFlattenedPdf();
    }, 2500);
  }

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

      const modifiedBytes = await PdfFlattener.flattenStrokes(
        this.cleanBasePdfBytes,
        strokes
      );

      const base64Data = this.arrayBufferToBase64(modifiedBytes.slice().buffer as ArrayBuffer);

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

  private async restoreOriginalSubmission() {
    if (!this.sessionData || !this.cleanBasePdfBytes || !this.canvasViewer) return;

    this.toolbar?.setSyncStatus('syncing');

    try {
      const fileId = this.sessionData.fileId;
      let cleanBytes: ArrayBuffer = this.cleanBasePdfBytes;

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

      this.sessionData.pageStrokes = {};
      this.sessionData.isDirty = false;
      this.sessionData.lastSavedTime = Date.now();
      await storage.clearSessionStrokes(fileId);

      const base64Data = this.arrayBufferToBase64(cleanBytes);
      const resp: ExtensionResponse<any> = await this.sendMessage({
        type: 'DRIVE_UPLOAD_FILE',
        fileId,
        pdfBase64: base64Data,
      });

      if (!resp.success) {
        throw new Error(resp.error || 'Failed to restore clean PDF');
      }

      this.canvasViewer.setStrokes({});
      this.toolbar?.setSyncStatus('saved');
      this.showToast('Restored to student’s unannotated original upload.', 'info');
    } catch (err: any) {
      console.error('[ClassroomStylus] Failed to restore original:', err);
      this.toolbar?.setSyncStatus('error', err.message);
      this.showToast(`Restore failed: ${err.message}`, 'error');
    }
  }

  public async exitCanvasMode() {
    if (this.sessionData && this.sessionData.isDirty) {
      await this.saveFlattenedPdf(true);
    }
    this.teardownCanvas();
  }

  private teardownCanvas() {
    this.isCanvasActive = false;

    if (this.topBarButton) {
      this.topBarButton.classList.remove('active');
      this.topBarButton.querySelector('.cs-btn-text')!.textContent = 'Grade with Stylus';
    }

    if (this.floatingLauncher) {
      this.floatingLauncher.style.display = 'block';
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

    if (this.overlayContainer) {
      if (this.overlayContainer.parentNode) {
        this.overlayContainer.parentNode.removeChild(this.overlayContainer);
      }
      this.overlayContainer = null;
    }

    // Restore hidden Google Drive iframes
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[data-cs-hidden="true"]');
    iframes.forEach((iframe) => {
      iframe.style.display = '';
      iframe.removeAttribute('data-cs-hidden');
    });

    this.cleanBasePdfBytes = null;
    this.sessionData = null;
  }

  private async resolveFileIdFromClassroomApi(
    courseId: string,
    courseWorkId: string,
    submissionId: string
  ): Promise<string | undefined> {
    const resp: ExtensionResponse<any> = await this.sendMessage({
      type: 'CLASSROOM_GET_SUBMISSION',
      courseId: decodeClassroomParam(courseId) || courseId,
      courseWorkId: decodeClassroomParam(courseWorkId) || courseWorkId,
      submissionId: decodeClassroomParam(submissionId) || submissionId,
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
            error: chrome.runtime.lastError.message || 'Extension background unreachable',
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

// Router between iframe helper and main application
if (window !== window.top) {
  initIframeHelper();
} else {
  new ClassroomStylusApp();
}
