import { ToolType, SyncStatus } from '../types';

export interface ToolbarEvents {
  onToolSelect: (tool: ToolType) => void;
  onPenColorChange: (color: string) => void;
  onPenThicknessChange: (thickness: number) => void;
  onHighlighterColorChange: (color: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onTogglePenOnly: (penOnly: boolean) => void;
  onRestoreOriginal: () => void;
  onOpenDedicatedTab?: () => void;
  onClose: () => void;
}

export class GradingToolbar {
  private container: HTMLElement;
  private events: ToolbarEvents;
  private activeTool: ToolType = 'pen';
  private currentPenColor: string = '#ef4444';
  private currentPenThickness: number = 3;
  private currentHighlighterColor: string = '#facc15';
  private penOnlyMode: boolean = true;
  private syncStatus: SyncStatus = 'saved';
  private canUndo: boolean = false;
  private canRedo: boolean = false;

  constructor(events: ToolbarEvents) {
    this.events = events;
    this.container = document.createElement('div');
    this.container.className = 'classroom-stylus-toolbar-bar';
    this.render();
    this.bindEvents();
    this.bindKeyShortcuts();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  setSyncStatus(status: SyncStatus, errorDetail?: string) {
    this.syncStatus = status;
    const pill = this.container.querySelector('.cs-sync-pill');
    if (!pill) return;

    pill.className = `cs-sync-pill cs-status-${status}`;
    if (status === 'saved') {
      pill.innerHTML = `
        <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Saved</span>
      `;
      pill.removeAttribute('title');
    } else if (status === 'syncing') {
      pill.innerHTML = `
        <span class="cs-spinner-sm"></span>
        <span>Syncing...</span>
      `;
      pill.removeAttribute('title');
    } else if (status === 'unsaved') {
      pill.innerHTML = `
        <span class="cs-unsaved-dot"></span>
        <span>Unsaved</span>
      `;
      pill.removeAttribute('title');
    } else if (status === 'error') {
      pill.innerHTML = `
        <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>Sync error</span>
      `;
      if (errorDetail) pill.setAttribute('title', errorDetail);
    }
  }

  setHistoryState(canUndo: boolean, canRedo: boolean) {
    this.canUndo = canUndo;
    this.canRedo = canRedo;
    const undoBtn = this.container.querySelector<HTMLButtonElement>('.cs-btn-undo');
    const redoBtn = this.container.querySelector<HTMLButtonElement>('.cs-btn-redo');
    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
  }

  private render() {
    this.container.innerHTML = `
      <div class="cs-toolbar-inner">
        <!-- Left: Tool selector -->
        <div class="cs-tool-group">
          <!-- Pen Tool -->
          <button type="button" class="cs-pill-btn cs-tool-btn ${this.activeTool === 'pen' ? 'active' : ''}" data-tool="pen" title="Pen">
            <svg class="cs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/></svg>
            <span class="cs-tool-label">Pen</span>
          </button>

          <!-- Pen Colors & Presets Popup/Sub-bar -->
          <div class="cs-pen-options" style="${this.activeTool === 'pen' ? '' : 'display: none;'}">
            <div class="cs-color-dots">
              <button type="button" class="cs-color-dot ${this.currentPenColor === '#ef4444' ? 'selected' : ''}" data-color="#ef4444" style="background-color: #ef4444;" title="Red (Grading)"></button>
              <button type="button" class="cs-color-dot ${this.currentPenColor === '#22c55e' ? 'selected' : ''}" data-color="#22c55e" style="background-color: #22c55e;" title="Green (Correct)"></button>
              <button type="button" class="cs-color-dot ${this.currentPenColor === '#3b82f6' ? 'selected' : ''}" data-color="#3b82f6" style="background-color: #3b82f6;" title="Blue"></button>
              <button type="button" class="cs-color-dot ${this.currentPenColor === '#000000' ? 'selected' : ''}" data-color="#000000" style="background-color: #000000;" title="Black"></button>
            </div>
            <div class="cs-thickness-pills">
              <button type="button" class="cs-thick-btn ${this.currentPenThickness === 2 ? 'selected' : ''}" data-thick="2" title="Fine (2px)">• Fine</button>
              <button type="button" class="cs-thick-btn ${this.currentPenThickness === 4 ? 'selected' : ''}" data-thick="4" title="Medium (4px)">•• Med</button>
              <button type="button" class="cs-thick-btn ${this.currentPenThickness === 8 ? 'selected' : ''}" data-thick="8" title="Thick (8px)">••• Thick</button>
            </div>
          </div>

          <div class="cs-divider"></div>

          <!-- Highlighter Tool -->
          <button type="button" class="cs-pill-btn cs-tool-btn ${this.activeTool === 'highlighter' ? 'active' : ''}" data-tool="highlighter" title="Highlighter">
            <svg class="cs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
            <span class="cs-tool-label">Highlight</span>
          </button>

          <div class="cs-highlighter-options" style="${this.activeTool === 'highlighter' ? '' : 'display: none;'}">
            <button type="button" class="cs-color-dot ${this.currentHighlighterColor === '#facc15' ? 'selected' : ''}" data-hl-color="#facc15" style="background-color: #facc15;" title="Yellow Highlight"></button>
            <button type="button" class="cs-color-dot ${this.currentHighlighterColor === '#4ade80' ? 'selected' : ''}" data-hl-color="#4ade80" style="background-color: #4ade80;" title="Green Highlight"></button>
          </div>

          <div class="cs-divider"></div>

          <!-- Eraser Tool -->
          <button type="button" class="cs-pill-btn cs-tool-btn ${this.activeTool === 'eraser' ? 'active' : ''}" data-tool="eraser" title="Stroke Eraser (Touch any stroke to erase)">
            <svg class="cs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>
            <span class="cs-tool-label">Eraser</span>
          </button>
        </div>

        <div class="cs-divider"></div>

        <!-- Center-Right: Actions -->
        <div class="cs-action-group">
          <!-- Undo / Redo -->
          <button type="button" class="cs-icon-btn cs-btn-undo" title="Undo (Ctrl+Z)" ${this.canUndo ? '' : 'disabled'}>
            <svg class="cs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
          </button>
          <button type="button" class="cs-icon-btn cs-btn-redo" title="Redo (Ctrl+Y)" ${this.canRedo ? '' : 'disabled'}>
            <svg class="cs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
          </button>

          <!-- Pen-Only Palm Rejection Toggle -->
          <button type="button" class="cs-pill-btn cs-toggle-penmode ${this.penOnlyMode ? 'active' : ''}" title="${this.penOnlyMode ? 'Palm rejection ON: Accepts Stylus only. Click to allow mouse/touch.' : 'Palm rejection OFF: Accepts Stylus and Mouse. Click to lock to Stylus only.'}">
            <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <span>${this.penOnlyMode ? 'Stylus Only' : 'Stylus + Mouse'}</span>
          </button>

          <!-- Reset to Original -->
          <button type="button" class="cs-pill-btn cs-btn-restore" title="Restore student's original unannotated submission">
            <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            <span>↺ Reset Original</span>
          </button>

          <!-- Dedicated Tab Button -->
          <button type="button" class="cs-pill-btn cs-btn-dedicated-tab" title="Open this grading canvas in its own dedicated browser tab">
            <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            <span>⛶ Dedicated Tab</span>
          </button>

          <!-- Sync Status Pill -->
          <div class="cs-sync-pill cs-status-saved">
            <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Saved</span>
          </div>

          <!-- Close / Return -->
          <button type="button" class="cs-pill-btn cs-btn-close" title="Exit stylus canvas">
            <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span>Close</span>
          </button>
        </div>
      </div>
    `;
  }

  private bindEvents() {
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Tool click
      const toolBtn = target.closest<HTMLButtonElement>('.cs-tool-btn');
      if (toolBtn && toolBtn.dataset.tool) {
        const tool = toolBtn.dataset.tool as ToolType;
        this.activeTool = tool;
        this.render();
        this.events.onToolSelect(tool);
        return;
      }

      // Pen color dot
      const colorDot = target.closest<HTMLButtonElement>('.cs-color-dot[data-color]');
      if (colorDot && colorDot.dataset.color) {
        this.currentPenColor = colorDot.dataset.color;
        this.container.querySelectorAll('.cs-color-dot[data-color]').forEach((d) => {
          d.classList.toggle('selected', (d as HTMLElement).dataset.color === this.currentPenColor);
        });
        this.events.onPenColorChange(this.currentPenColor);
        return;
      }

      // Highlighter color dot
      const hlColorDot = target.closest<HTMLButtonElement>('.cs-color-dot[data-hl-color]');
      if (hlColorDot && hlColorDot.dataset.hlColor) {
        this.currentHighlighterColor = hlColorDot.dataset.hlColor;
        this.container.querySelectorAll('.cs-color-dot[data-hl-color]').forEach((d) => {
          d.classList.toggle('selected', (d as HTMLElement).dataset.hlColor === this.currentHighlighterColor);
        });
        this.events.onHighlighterColorChange(this.currentHighlighterColor);
        return;
      }

      // Thickness preset
      const thickBtn = target.closest<HTMLButtonElement>('.cs-thick-btn');
      if (thickBtn && thickBtn.dataset.thick) {
        this.currentPenThickness = parseInt(thickBtn.dataset.thick, 10);
        this.container.querySelectorAll('.cs-thick-btn').forEach((b) => {
          b.classList.toggle('selected', (b as HTMLElement).dataset.thick === String(this.currentPenThickness));
        });
        this.events.onPenThicknessChange(this.currentPenThickness);
        return;
      }

      // Undo
      if (target.closest('.cs-btn-undo')) {
        this.events.onUndo();
        return;
      }

      // Redo
      if (target.closest('.cs-btn-redo')) {
        this.events.onRedo();
        return;
      }

      // Pen-only mode toggle
      if (target.closest('.cs-toggle-penmode')) {
        this.penOnlyMode = !this.penOnlyMode;
        this.render();
        this.events.onTogglePenOnly(this.penOnlyMode);
        return;
      }

      // Restore original confirmation
      if (target.closest('.cs-btn-restore')) {
        this.showRestoreConfirmation();
        return;
      }

      // Dedicated tab
      if (target.closest('.cs-btn-dedicated-tab')) {
        this.events.onOpenDedicatedTab?.();
        return;
      }

      // Close
      if (target.closest('.cs-btn-close')) {
        this.events.onClose();
        return;
      }
    });
  }

  private showRestoreConfirmation() {
    // Classroom native modal overlay
    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'cs-modal-overlay';
    modalOverlay.innerHTML = `
      <div class="cs-modal-card">
        <h3 class="cs-modal-title">↺ Reset to Original Submission?</h3>
        <p class="cs-modal-body">
          This will permanently remove all teacher ink annotations drawn in this session and restore the student's initial clean, unannotated submission on Google Drive.
        </p>
        <div class="cs-modal-actions">
          <button type="button" class="cs-modal-btn cs-modal-cancel">Cancel</button>
          <button type="button" class="cs-modal-btn cs-modal-confirm">Reset to Original</button>
        </div>
      </div>
    `;

    document.body.appendChild(modalOverlay);

    const cancelBtn = modalOverlay.querySelector('.cs-modal-cancel')!;
    const confirmBtn = modalOverlay.querySelector('.cs-modal-confirm')!;

    const close = () => {
      if (modalOverlay.parentNode) {
        modalOverlay.parentNode.removeChild(modalOverlay);
      }
    };

    cancelBtn.addEventListener('click', close);
    confirmBtn.addEventListener('click', () => {
      close();
      this.events.onRestoreOriginal();
    });
  }

  private bindKeyShortcuts() {
    window.addEventListener('keydown', (e) => {
      // If user is typing in Classroom's right sidebar grade/comment input, do not intercept
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.getAttribute('contenteditable') === 'true')
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) {
          e.preventDefault();
          this.events.onRedo();
        } else {
          e.preventDefault();
          this.events.onUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.events.onRedo();
      }
    });
  }
}
