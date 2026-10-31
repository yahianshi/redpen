import { ClassroomDetector, decodeClassroomParam } from './detector';
import { GradingToolbar } from '../ui/toolbar';
import { CanvasViewer } from '../ui/canvasViewer';
import { StylusEngine } from '../engine/stylus';
import { PdfFlattener } from '../services/flattener';
import { storage } from '../services/storage';
import { ClassroomContext, ExtensionMessage, ExtensionResponse, Stroke, SessionData } from '../types';

function isExtensionValid(): boolean {
  try {
    return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

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
        <span class="cs-btn-text">Grade with RedPen</span>
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
  private sidebarButton: HTMLButtonElement | null = null;
  private buttonPollerTimer: any = null;
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
    console.log('[RedPen] Main app initializing on Google Classroom...');

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

    // 500ms continuous poller to ensure buttons appear as soon as DOM renders and persist through Classroom SPA changes
    this.buttonPollerTimer = setInterval(() => {
      if (!isExtensionValid()) {
        if (this.buttonPollerTimer) {
          clearInterval(this.buttonPollerTimer);
          this.buttonPollerTimer = null;
        }
        return;
      }
      this.updateButtonsState();
    }, 500);

    // Initial check
    this.updateButtonsState();
  }

  private async handleSubmissionDetected(ctx: ClassroomContext) {
    this.currentContext = ctx;
    this.updateButtonsState();
  }

  private async handleSubmissionChanged(ctx: ClassroomContext) {
    if (this.isCanvasActive && this.sessionData?.isDirty) {
      await this.saveFlattenedPdf(true);
    }

    const wasActive = this.isCanvasActive;
    this.teardownCanvas();
    this.currentContext = ctx;
    this.updateButtonsState();

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

  private isEligiblePdfSubmission(): boolean {
    const url = window.location.href;
    // URL pattern: https://classroom.google.com/c/*/a/*/submissions/.../student/...
    const isStudentSubmissionUrl = /\/c\/[^/]+\/a\/[^/]+\/submissions\/(?:[^/]+\/)*student\/[^/?#]+/i.test(url);
    if (!isStudentSubmissionUrl) {
      return false;
    }

    // 1. Check if extracted filename contains .pdf
    const fileName = this.extractActiveFileName();
    if (fileName && /\.pdf\b/i.test(fileName)) {
      return true;
    }

    // 2. Check right sidebar chips for a .pdf attachment
    const chip = this.findSubmissionPdfChip();
    if (chip) {
      return true;
    }

    // 3. Check for any element explicitly containing .pdf in title or aria-label
    const anyPdfAttr = document.querySelector<HTMLElement>('[title*=".pdf" i], [aria-label*=".pdf" i], [data-filename*=".pdf" i]');
    if (anyPdfAttr) {
      return true;
    }

    // 4. Check if document body contains text matching a .pdf filename (e.g. "math quiz 4 .pdf")
    if (document.body && /\b[a-zA-Z0-9_\- ]+?\s*\.pdf\b/i.test(document.body.innerText)) {
      return true;
    }

    // 5. Check if preview iframe explicitly references a .pdf
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe');
    for (const f of iframes) {
      const src = (f.src || f.getAttribute('data-src') || '').toLowerCase();
      if (src.includes('.pdf')) {
        return true;
      }
    }

    return false;
  }

  private updateButtonsState() {
    // If canvas mode is active, sync active labels
    if (this.isCanvasActive) {
      if (this.sidebarButton) {
        if (!this.sidebarButton.classList.contains('active')) this.sidebarButton.classList.add('active');
        const textEl = this.sidebarButton.querySelector('.cs-btn-text');
        if (textEl && textEl.textContent !== '✓ Grading Active (Click to Exit)') {
          textEl.textContent = '✓ Grading Active (Click to Exit)';
        }
      }
      return;
    }

    const isEligible = this.isEligiblePdfSubmission();
    if (!isEligible) {
      this.removeButtons();
      return;
    }

    this.injectRightSidebarButton();
  }

  private findSubmissionPdfChip(): HTMLElement | null {
    // 1. Search for leaf elements containing .pdf on the right half of the screen
    const thresholdX = typeof window !== 'undefined' ? window.innerWidth * 0.45 : 0;
    const candidates = document.querySelectorAll<HTMLElement>(
      'span, a, div, p, [role="button"], [role="link"], li'
    );

    for (const el of candidates) {
      if (el.childElementCount <= 2) {
        const txt = (el.textContent || '').trim();
        if (txt.length > 4 && txt.length < 120 && /\.pdf\b/i.test(txt)) {
          if (thresholdX > 0) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.left < thresholdX) {
              continue; // Skip left-hand elements
            }
          }

          // Found .pdf element in sidebar region! Walk up to find the attachment chip container.
          let chip: HTMLElement = el;
          let cur: HTMLElement | null = el;
          while (cur && cur !== document.body) {
            const role = cur.getAttribute('role');
            const tag = cur.tagName.toLowerCase();
            if (role === 'button' || role === 'link' || tag === 'a' || tag === 'li') {
              chip = cur;
              break;
            }
            if (
              cur.parentElement &&
              (cur.parentElement.textContent?.includes('Grade') ||
               cur.parentElement.textContent?.includes('Private comments') ||
               cur.parentElement.textContent?.includes('Turned in'))
            ) {
              chip = cur;
              break;
            }
            cur = cur.parentElement;
          }
          return chip;
        }
      }
    }

    // 2. Search by title / aria-label attribute
    const attrElements = document.querySelectorAll<HTMLElement>('[title*=".pdf" i], [aria-label*=".pdf" i]');
    for (const el of attrElements) {
      const chip = el.closest<HTMLElement>('[role="button"], [role="link"], a, li') || el;
      return chip;
    }

    return null;
  }

  private findRightSidebarMountPoint(): { container?: HTMLElement; insertAfter?: HTMLElement; insertBefore?: HTMLElement } | null {
    // 1. Insert directly after the submission PDF chip/card
    const chip = this.findSubmissionPdfChip();
    if (chip && chip.parentElement) {
      let target: HTMLElement = chip;
      if (target.parentElement && target.parentElement.clientHeight > 0 && target.parentElement.clientHeight < 42 && target.parentElement.parentElement) {
        target = target.parentElement;
      }
      return { insertAfter: target };
    }

    // 2. Fallback: Insert immediately above the "Grade" input section
    const gradeInputs = document.querySelectorAll<HTMLInputElement>('input[type="number"], input[type="text"], input');
    for (const inp of gradeInputs) {
      const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
      const parentTxt = (inp.parentElement?.parentElement?.textContent || '').toLowerCase();
      if (aria.includes('grade') || parentTxt.includes('grade') || parentTxt.includes('/')) {
        let gradeRow: HTMLElement = inp;
        while (
          gradeRow.parentElement &&
          gradeRow.parentElement !== document.body &&
          !gradeRow.parentElement.textContent?.includes('Grade and feedback')
        ) {
          if (gradeRow.parentElement.clientWidth > 150) {
            break;
          }
          gradeRow = gradeRow.parentElement;
        }
        return { insertBefore: gradeRow };
      }
    }

    // 3. Fallback: Find the right sidebar container (contains "Grade and feedback")
    const allDivs = document.querySelectorAll<HTMLElement>('aside, [role="complementary"], div');
    for (const el of allDivs) {
      if (el.textContent?.includes('Grade and feedback')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 180) {
          return { container: el };
        }
      }
    }

    return null;
  }

  private injectRightSidebarButton() {
    if (this.sidebarButton && document.body.contains(this.sidebarButton)) {
      return;
    }

    const host = this.findRightSidebarMountPoint();
    if (!host) {
      return;
    }

    if (!this.sidebarButton) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'classroom-stylus-sidebar-btn';
      btn.innerHTML = `
        <span class="cs-btn-icon">✏️</span>
        <span class="cs-btn-text">Grade with RedPen</span>
      `;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleCanvasMode();
      });

      this.sidebarButton = btn;
    }

    if (host.insertAfter && host.insertAfter.parentElement) {
      host.insertAfter.parentElement.insertBefore(this.sidebarButton, host.insertAfter.nextSibling);
    } else if (host.insertBefore && host.insertBefore.parentElement) {
      host.insertBefore.parentElement.insertBefore(this.sidebarButton, host.insertBefore);
    } else if (host.container) {
      host.container.appendChild(this.sidebarButton);
    }
  }

  private removeButtons() {
    if (this.sidebarButton && this.sidebarButton.parentNode) {
      this.sidebarButton.parentNode.removeChild(this.sidebarButton);
      this.sidebarButton = null;
    }
    // Clean up any old topbar buttons that might have been injected
    document.querySelectorAll('.classroom-stylus-topbar-btn').forEach((el) => {
      el.parentNode?.removeChild(el);
    });
  }

  private async checkAuthStatus(): Promise<{ isAuthenticated: boolean; hasClientId: boolean }> {
    const resp = await this.sendMessage({ type: 'AUTH_STATUS' });
    if (resp && resp.success && resp.data) {
      return {
        isAuthenticated: !!resp.data.isAuthenticated,
        hasClientId: !!resp.data.clientId,
      };
    }
    return { isAuthenticated: false, hasClientId: false };
  }

  private promptForAuth(hasClientId: boolean, fileIdOverride?: string) {
    document.querySelectorAll('.cs-auth-modal-overlay').forEach((el) => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'cs-modal-overlay cs-auth-modal-overlay';

    if (!hasClientId) {
      overlay.innerHTML = `
        <div class="cs-modal-card">
          <h3 class="cs-modal-title">⚙️ Google Cloud Setup Required</h3>
          <p class="cs-modal-body">
            Before you can grade with RedPen and save flattened PDFs to Google Drive, please configure your Google Cloud Client ID.
            Click the <strong>RedPen extension icon</strong> in your browser toolbar to complete the quick 3-step setup.
          </p>
          <div class="cs-modal-actions">
            <button type="button" class="cs-modal-btn cs-modal-cancel">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('.cs-modal-cancel')?.addEventListener('click', () => overlay.remove());
      return;
    }

    overlay.innerHTML = `
      <div class="cs-modal-card">
        <h3 class="cs-modal-title">🔐 Sign In to Google Drive</h3>
        <p class="cs-modal-body">
          Authentication is required to download and autosave graded student PDF submissions directly to Google Drive. Click below to sign in:
        </p>
        <div class="cs-modal-actions">
          <button type="button" class="cs-modal-btn cs-modal-cancel">Cancel</button>
          <button type="button" class="cs-modal-btn cs-modal-confirm cs-auth-signin-btn">🚀 Sign In with Google</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('.cs-modal-cancel')?.addEventListener('click', () => overlay.remove());

    const signInBtn = overlay.querySelector<HTMLButtonElement>('.cs-auth-signin-btn');
    signInBtn?.addEventListener('click', async () => {
      signInBtn.disabled = true;
      signInBtn.textContent = 'Signing in...';

      const resp = await this.sendMessage({ type: 'AUTH_GET_TOKEN', interactive: true });
      if (resp && resp.success) {
        overlay.remove();
        this.showToast('Successfully signed in! Opening grading canvas...', 'success');
        setTimeout(() => {
          this.enterCanvasMode(fileIdOverride);
        }, 300);
      } else {
        signInBtn.disabled = false;
        signInBtn.textContent = '🚀 Sign In with Google';
        this.showToast(`Sign-in failed: ${resp?.error || 'Access denied'}`, 'error');
      }
    });
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
    console.log('[RedPen] Entering Canvas Mode...');

    // 0. Make sure the user is authenticated with Google before opening canvas
    const authStatus = await this.checkAuthStatus();
    if (!authStatus.isAuthenticated) {
      this.promptForAuth(authStatus.hasClientId, fileIdOverride);
      return;
    }

    this.isCanvasActive = true;

    // 1. Immediately update button states safely
    if (this.sidebarButton) {
      this.sidebarButton.classList.add('active');
      const textEl = this.sidebarButton.querySelector('.cs-btn-text');
      if (textEl) textEl.textContent = '✓ Grading Active (Click to Exit)';
    }

    // 2. Resolve Google Drive fileId early (before hiding iframe or DOM elements)
    let fileId = fileIdOverride || this.currentContext?.fileId;
    if (!fileId) {
      fileId = this.detector?.findGoogleDriveFileId();
    }

    const detectedFileName = this.extractActiveFileName();
    if (detectedFileName && this.currentContext) {
      this.currentContext.fileName = detectedFileName;
    }

    // 3. Locate the center preview container in Google Classroom
    const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
    const driveIframe = iframes.find((f) => {
      const src = f.src || f.getAttribute('data-src') || '';
      return src.includes('drive.google.com') || src.includes('docs.google.com');
    }) || iframes[0];

    // Find the preview host element (parent of iframe, or Classroom's center pane)
    let previewHost: HTMLElement | null = driveIframe?.parentElement || null;
    while (previewHost && previewHost.clientHeight < 250 && previewHost.parentElement && previewHost.parentElement !== document.body) {
      previewHost = previewHost.parentElement;
    }

    if (!previewHost || previewHost === document.body) {
      previewHost = document.querySelector<HTMLElement>('main, [role="main"]') || document.body;
    }

    // 4. Hide Google Drive preview iframe(s)
    iframes.forEach((iframe) => {
      iframe.style.setProperty('display', 'none', 'important');
      iframe.setAttribute('data-cs-hidden', 'true');
    });

    // 5. Mount or re-mount our center overlay container
    if (this.overlayContainer && this.overlayContainer.parentNode) {
      this.overlayContainer.parentNode.removeChild(this.overlayContainer);
      this.overlayContainer = null;
    }

    this.overlayContainer = document.createElement('div');
    this.overlayContainer.className = 'classroom-stylus-overlay-panel';

    if (previewHost !== document.body) {
      previewHost.classList.add('classroom-stylus-container-active');
      previewHost.style.setProperty('position', 'relative', 'important');
      previewHost.style.setProperty('width', '100%', 'important');
      previewHost.style.setProperty('height', '100%', 'important');
      previewHost.style.setProperty('max-height', '100%', 'important');
      previewHost.style.setProperty('min-height', '0', 'important');
      previewHost.style.setProperty('background-color', '#13181c', 'important');
      previewHost.style.setProperty('display', 'flex', 'important');
      previewHost.style.setProperty('flex-direction', 'column', 'important');
      previewHost.style.setProperty('overflow', 'hidden', 'important');

      this.overlayContainer.style.cssText = `
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        width: 100% !important;
        height: 100% !important;
        max-height: 100% !important;
        min-height: 0 !important;
        z-index: 1000 !important;
        background-color: #13181c !important;
        display: flex !important;
        flex-direction: column !important;
        overflow: hidden !important;
      `;
      previewHost.appendChild(this.overlayContainer);
    } else {
      // Fallback: fixed positioning
      this.overlayContainer.className = 'classroom-stylus-overlay-panel classroom-stylus-overlay-panel-fallback';
      this.overlayContainer.style.cssText = `
        position: fixed !important;
        top: 56px !important;
        left: 72px !important;
        right: 360px !important;
        bottom: 0px !important;
        z-index: 9999 !important;
        background-color: #13181c !important;
        display: flex !important;
        flex-direction: column !important;
        overflow: hidden !important;
      `;
      document.body.appendChild(this.overlayContainer);
    }

    // 6. Read user settings & mount Toolbar
    const settings = await storage.getSettings();

    this.toolbar = new GradingToolbar(
      {
        onToolSelect: (tool) => this.stylusEngine?.updateOptions({ activeTool: tool }),
        onPenColorChange: (color) => this.stylusEngine?.updateOptions({ penColor: color }),
        onPenThicknessChange: (thick) => this.stylusEngine?.updateOptions({ penThickness: thick }),
        onHighlighterColorChange: (color) => this.stylusEngine?.updateOptions({ highlighterColor: color }),
        onHighlighterThicknessChange: (thick) => this.stylusEngine?.updateOptions({ highlighterThickness: thick }),
        onTextSizeChange: (size) => this.stylusEngine?.updateOptions({ textSize: size }),
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
          storage.updateSettings({ penOnlyMode: penOnly });
        },
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
        onZoomIn: () => this.canvasViewer?.zoomIn(),
        onZoomOut: () => this.canvasViewer?.zoomOut(),
        onZoomReset: () => this.canvasViewer?.resetZoom(),
        onPrevPage: () => this.canvasViewer?.prevPage(),
        onNextPage: () => this.canvasViewer?.nextPage(),
        onScrollHalfPageDown: () => this.canvasViewer?.scrollHalfPageDown(),
        onScrollHalfPageUp: () => this.canvasViewer?.scrollHalfPageUp(),
      },
      {
        initialPenOnlyMode: settings.penOnlyMode,
      }
    );

    this.overlayContainer.appendChild(this.toolbar.getElement());

    // 7. Initialize Stylus Engine and Canvas Viewer
    this.stylusEngine = new StylusEngine({
      penOnlyMode: settings.penOnlyMode,
      activeTool: 'pen',
      penColor: settings.defaultPenColor,
      penThickness: settings.defaultPenThickness,
      highlighterColor: settings.defaultHighlighterColor,
      highlighterThickness: settings.defaultHighlighterThickness,
      textSize: 24,
      onStrokeAdded: () => this.markDirtyAndDebounceSave(),
      onStrokeErased: () => this.markDirtyAndDebounceSave(),
      onHistoryChange: (canUndo, canRedo) => this.toolbar?.setHistoryState(canUndo, canRedo),
    });

    this.canvasViewer = new CanvasViewer(this.stylusEngine, {
      onStrokeDrawn: () => this.markDirtyAndDebounceSave(),
      onStrokeErased: () => this.markDirtyAndDebounceSave(),
    });

    this.canvasViewer.setPageZoomCallback((page, total, zoomPct) => {
      this.toolbar?.updatePageZoomState(page, total, zoomPct);
    });

    this.overlayContainer.appendChild(this.canvasViewer.getElement());

    // 8. Layered search fallbacks for fileId:
    // Drive search by filename
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
        console.warn('[RedPen] File search fallback error:', e);
      }
    }

    // Classroom API fallback with decoded IDs
    if (!fileId && this.currentContext?.courseId && this.currentContext?.courseWorkId && this.currentContext?.submissionId) {
      try {
        fileId = await this.resolveFileIdFromClassroomApi(
          this.currentContext.courseId,
          this.currentContext.courseWorkId,
          this.currentContext.submissionId
        );
      } catch (e) {
        console.warn('[RedPen] Classroom API resolution error:', e);
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
    if (this.detector) {
      const detected = this.detector.extractActiveFileName();
      if (detected) return detected;
    }

    // Look for filename in Classroom's dark header or preview container
    const headerTitle = document.querySelector<HTMLElement>(
      '[role="banner"] [title*=".pdf" i], header [title*=".pdf" i], [role="banner"] [aria-label*=".pdf" i]'
    );
    if (headerTitle) {
      const raw = headerTitle.getAttribute('title') || headerTitle.getAttribute('aria-label') || headerTitle.textContent || '';
      const m = raw.match(/([a-zA-Z0-9_\- ]+?\s*\.pdf)/i);
      if (m) return m[1].trim();
    }

    // Check attachment chips in right sidebar
    const chips = document.querySelectorAll<HTMLElement>(
      '[role="button"][title*=".pdf" i], [role="link"][title*=".pdf" i], div[title*=".pdf" i]'
    );
    for (const chip of chips) {
      const raw = chip.getAttribute('title') || chip.getAttribute('aria-label') || chip.textContent || '';
      const m = raw.match(/([a-zA-Z0-9_\- ]+?\s*\.pdf)/i);
      if (m) return m[1].trim();
    }

    // Check short text nodes containing .pdf
    const leaves = document.querySelectorAll<HTMLElement>('span, a, p, div');
    for (const el of leaves) {
      if (el.childElementCount <= 1) {
        const text = (el.textContent || '').trim();
        if (text.length > 4 && text.length < 80 && /\.pdf\b/i.test(text)) {
          const m = text.match(/([a-zA-Z0-9_\- ]+?\s*\.pdf)/i);
          if (m) return m[1].trim();
        }
      }
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
        <div style="margin-top: 12px; text-align: center;">
          <button type="button" id="csOpenTabBtn" class="btn btn-secondary" style="font-size: 12px; padding: 6px 14px; background: #2d2e30; color: #8ab4f8; border: 1px solid #5f6368; border-radius: 9999px; cursor: pointer;">
            ⧉ Open Fullscreen Grading Tab Instead
          </button>
        </div>
      </div>
    `;

    const loadBtn = scrollContainer.querySelector<HTMLButtonElement>('#csManualLoadBtn');
    const input = scrollContainer.querySelector<HTMLInputElement>('#csManualDriveInput');
    const openTabBtn = scrollContainer.querySelector<HTMLButtonElement>('#csOpenTabBtn');

    openTabBtn?.addEventListener('click', () => {
      const fId = this.currentContext?.fileId || input?.value.trim() || '';
      chrome.runtime.sendMessage({
        type: 'OPEN_ANNOTATOR_TAB',
        fileId: fId,
        fileName: defaultName,
      });
    });

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
          console.warn('[RedPen] Non-critical: could not pin original revision:', e);
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
      console.error('[RedPen] Error loading PDF:', err);
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

      if (this.sessionData) {
        this.sessionData.isDirty = false;
        this.sessionData.lastSavedTime = Date.now();
        await storage.saveSessionStrokes(this.sessionData);
      }

      this.toolbar?.setSyncStatus('saved');
    } catch (err: any) {
      console.error('[RedPen] Autosave error:', err);
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
      console.error('[RedPen] Failed to restore original:', err);
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

    if (this.sidebarButton) {
      this.sidebarButton.classList.remove('active');
      const textEl = this.sidebarButton.querySelector('.cs-btn-text');
      if (textEl) textEl.textContent = 'Grade with RedPen';
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

    // Clean up container classes and restore Google Drive iframes
    document.querySelectorAll('.classroom-stylus-container-active').forEach((el) => {
      el.classList.remove('classroom-stylus-container-active');
      (el as HTMLElement).style.backgroundColor = '';
    });

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
      if (!isExtensionValid()) {
        resolve({
          success: false,
          error: 'Extension context invalidated. Please reload the page.',
        });
        return;
      }
      try {
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
      } catch (err: any) {
        resolve({
          success: false,
          error: err?.message || 'Context invalidated',
        });
      }
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
