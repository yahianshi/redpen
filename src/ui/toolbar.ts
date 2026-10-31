import { ToolType, SyncStatus } from '../types';

export interface ToolbarEvents {
  onToolSelect: (tool: ToolType) => void;
  onPenColorChange: (color: string) => void;
  onPenThicknessChange: (thickness: number) => void;
  onHighlighterColorChange: (color: string) => void;
  onHighlighterThicknessChange?: (thickness: number) => void;
  onTextSizeChange?: (size: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onTogglePenOnly: (penOnly: boolean) => void;
  onRestoreOriginal: () => void;
  onOpenDedicatedTab?: () => void;
  onClose: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  onPrevPage?: () => void;
  onNextPage?: () => void;
  onScrollHalfPageUp?: () => void;
  onScrollHalfPageDown?: () => void;
}

export interface ToolbarOptions {
  showDedicatedTabButton?: boolean;
}

export class GradingToolbar {
  private container: HTMLElement;
  private events: ToolbarEvents;
  private options: ToolbarOptions;
  private activeTool: ToolType = 'pen';

  // 3 customizable colors per tool
  private penColors: [string, string, string] = ['#f0393c', '#3b82f6', '#000000'];
  private activePenSlot: number = 0;
  private currentPenThickness: number = 3;

  private hlColors: [string, string, string] = ['#facc15', '#c084fc', '#4ade80'];
  private activeHlSlot: number = 0;
  private currentHighlighterThickness: number = 22;

  private textColors: [string, string, string] = ['#f0393c', '#3b82f6', '#000000'];
  private activeTextSlot: number = 0;
  private currentTextSize: number = 24;

  private penOnlyMode: boolean = true;
  private syncStatus: SyncStatus = 'saved';
  private canUndo: boolean = false;
  private canRedo: boolean = false;
  private activePopover: 'pen' | 'highlighter' | 'text' | null = null;

  constructor(events: ToolbarEvents, options: ToolbarOptions = {}) {
    this.events = events;
    this.options = {
      showDedicatedTabButton: true,
      ...options,
    };
    this.container = document.createElement('div');
    this.container.className = 'classroom-stylus-toolbar-bar';
    this.render();
    this.bindEvents();
    this.bindKeyShortcuts();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  updatePageZoomState(_currentPage: number, _totalPages: number, _zoomPercent: number) {
    // Zoom and page navigation controls are displayed only on the bottom pill
  }

  private getCurrentPenColor(): string {
    return this.penColors[this.activePenSlot];
  }

  private getCurrentHighlighterColor(): string {
    return this.hlColors[this.activeHlSlot];
  }

  private getCurrentTextColor(): string {
    return this.textColors[this.activeTextSlot];
  }

  setActiveTool(tool: ToolType) {
    this.activeTool = tool;
    this.closeCustomPopover();
    this.container.querySelectorAll<HTMLButtonElement>('.cs-tool-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });

    const penOpts = this.container.querySelector<HTMLElement>('.cs-pen-options');
    const hlOpts = this.container.querySelector<HTMLElement>('.cs-highlighter-options');
    const textOpts = this.container.querySelector<HTMLElement>('.cs-text-options');

    if (penOpts) penOpts.style.display = tool === 'pen' ? 'flex' : 'none';
    if (hlOpts) hlOpts.style.display = tool === 'highlighter' ? 'flex' : 'none';
    if (textOpts) textOpts.style.display = tool === 'text' ? 'flex' : 'none';

    this.events.onToolSelect(tool);
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
    const showDedicated = this.options.showDedicatedTabButton !== false;

    this.container.innerHTML = `
      <div class="cs-toolbar-inner">
        <!-- Left: Tool selector & contextual options -->
        <div class="cs-tool-group">
          <!-- Pen Tool -->
          <button type="button" class="cs-pill-btn cs-tool-btn ${this.activeTool === 'pen' ? 'active' : ''}" data-tool="pen" title="Pen (Draw annotations - P)">
            <svg class="cs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/></svg>
            <span class="cs-tool-label">Pen</span>
            <span class="cs-color-preview-dot cs-pen-preview-dot" style="background-color: ${this.getCurrentPenColor()};"></span>
          </button>

          <!-- Pen Options (3 colors + thickness + gear cog) -->
          <div class="cs-pen-options" style="${this.activeTool === 'pen' ? 'display: flex;' : 'display: none;'}">
            <div class="cs-color-dots">
              <button type="button" class="cs-color-dot ${this.activePenSlot === 0 ? 'selected' : ''}" data-tool-slot="pen" data-slot="0" style="background-color: ${this.penColors[0]};" title="Red (Customize via ⚙️)"></button>
              <button type="button" class="cs-color-dot ${this.activePenSlot === 1 ? 'selected' : ''}" data-tool-slot="pen" data-slot="1" style="background-color: ${this.penColors[1]};" title="Blue (Customize via ⚙️)"></button>
              <button type="button" class="cs-color-dot ${this.activePenSlot === 2 ? 'selected' : ''}" data-tool-slot="pen" data-slot="2" style="background-color: ${this.penColors[2]};" title="Black (Customize via ⚙️)"></button>
            </div>
            <div class="cs-thickness-pills">
              <button type="button" class="cs-thick-btn ${this.currentPenThickness === 2 ? 'selected' : ''}" data-thick="2" title="Fine (2px)">Fine</button>
              <button type="button" class="cs-thick-btn ${this.currentPenThickness === 4 ? 'selected' : ''}" data-thick="4" title="Medium (4px)">Med</button>
              <button type="button" class="cs-thick-btn ${this.currentPenThickness === 8 ? 'selected' : ''}" data-thick="8" title="Thick (8px)">Thick</button>
              <button type="button" class="cs-thick-btn cs-btn-open-custom" data-custom-target="pen" title="Pen settings">⚙️</button>
            </div>
          </div>

          <div class="cs-divider"></div>

          <!-- Highlighter Tool -->
          <button type="button" class="cs-pill-btn cs-tool-btn ${this.activeTool === 'highlighter' ? 'active' : ''}" data-tool="highlighter" title="Highlighter (H)">
            <svg class="cs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
            <span class="cs-tool-label">Highlight</span>
            <span class="cs-color-preview-dot cs-hl-preview-dot" style="background-color: ${this.getCurrentHighlighterColor()};"></span>
          </button>

          <!-- Highlighter Options (3 colors: yellow, light purple, green + thickness + gear cog) -->
          <div class="cs-highlighter-options" style="${this.activeTool === 'highlighter' ? 'display: flex;' : 'display: none;'}">
            <div class="cs-color-dots">
              <button type="button" class="cs-color-dot ${this.activeHlSlot === 0 ? 'selected' : ''}" data-tool-slot="highlighter" data-slot="0" style="background-color: ${this.hlColors[0]};" title="Yellow (Customize via ⚙️)"></button>
              <button type="button" class="cs-color-dot ${this.activeHlSlot === 1 ? 'selected' : ''}" data-tool-slot="highlighter" data-slot="1" style="background-color: ${this.hlColors[1]};" title="Light Purple (Customize via ⚙️)"></button>
              <button type="button" class="cs-color-dot ${this.activeHlSlot === 2 ? 'selected' : ''}" data-tool-slot="highlighter" data-slot="2" style="background-color: ${this.hlColors[2]};" title="Green (Customize via ⚙️)"></button>
            </div>
            <div class="cs-thickness-pills">
              <button type="button" class="cs-thick-btn ${this.currentHighlighterThickness === 14 ? 'selected' : ''}" data-hl-thick="14" title="Fine (14px)">Fine</button>
              <button type="button" class="cs-thick-btn ${this.currentHighlighterThickness === 22 ? 'selected' : ''}" data-hl-thick="22" title="Medium (22px)">Med</button>
              <button type="button" class="cs-thick-btn ${this.currentHighlighterThickness === 34 ? 'selected' : ''}" data-hl-thick="34" title="Broad (34px)">Broad</button>
              <button type="button" class="cs-thick-btn cs-btn-open-custom" data-custom-target="highlighter" title="Highlighter settings">⚙️</button>
            </div>
          </div>

          <div class="cs-divider"></div>

          <!-- Text Tool -->
          <button type="button" class="cs-pill-btn cs-tool-btn ${this.activeTool === 'text' ? 'active' : ''}" data-tool="text" title="Text Note (T) - Click to type, click existing note to edit">
            <svg class="cs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
            <span class="cs-tool-label">Text</span>
            <span class="cs-color-preview-dot cs-text-preview-dot" style="background-color: ${this.getCurrentTextColor()};"></span>
          </button>

          <!-- Text Options (3 colors: red, blue, black + sizes + gear cog) -->
          <div class="cs-text-options" style="${this.activeTool === 'text' ? 'display: flex;' : 'display: none;'}">
            <div class="cs-color-dots">
              <button type="button" class="cs-color-dot ${this.activeTextSlot === 0 ? 'selected' : ''}" data-tool-slot="text" data-slot="0" style="background-color: ${this.textColors[0]};" title="Red (Customize via ⚙️)"></button>
              <button type="button" class="cs-color-dot ${this.activeTextSlot === 1 ? 'selected' : ''}" data-tool-slot="text" data-slot="1" style="background-color: ${this.textColors[1]};" title="Blue (Customize via ⚙️)"></button>
              <button type="button" class="cs-color-dot ${this.activeTextSlot === 2 ? 'selected' : ''}" data-tool-slot="text" data-slot="2" style="background-color: ${this.textColors[2]};" title="Black (Customize via ⚙️)"></button>
            </div>
            <div class="cs-thickness-pills">
              <button type="button" class="cs-thick-btn ${this.currentTextSize === 18 ? 'selected' : ''}" data-text-size="18" title="Regular (18px)">18px</button>
              <button type="button" class="cs-thick-btn ${this.currentTextSize === 24 ? 'selected' : ''}" data-text-size="24" title="Medium (24px - Default)">24px</button>
              <button type="button" class="cs-thick-btn ${this.currentTextSize === 32 ? 'selected' : ''}" data-text-size="32" title="Large (32px)">32px</button>
              <button type="button" class="cs-thick-btn cs-btn-open-custom" data-custom-target="text" title="Text settings">⚙️</button>
            </div>
          </div>

          <div class="cs-divider"></div>

          <!-- Eraser Tool (Last) -->
          <button type="button" class="cs-pill-btn cs-tool-btn ${this.activeTool === 'eraser' ? 'active' : ''}" data-tool="eraser" title="Stroke Eraser (E) - Click/touch stroke to erase">
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

          <div class="cs-divider"></div>

          <!-- Pen-Only Palm Rejection Toggle -->
          <button type="button" class="cs-pill-btn cs-toggle-penmode ${this.penOnlyMode ? 'active' : ''}" title="${this.penOnlyMode ? 'Palm rejection ON: Accepts Stylus only. Click to allow touch/mouse.' : 'Palm rejection OFF: Accepts Stylus and Touch. Click to lock to Stylus only.'}">
            <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <span class="cs-action-label">${this.penOnlyMode ? 'Stylus Only' : 'Stylus + Touch'}</span>
          </button>

          <!-- Reset to Original -->
          <button type="button" class="cs-pill-btn cs-btn-restore" title="Restore student's original unannotated submission">
            <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            <span class="cs-action-label">↺ Reset</span>
          </button>

          ${
            showDedicated
              ? `<!-- Dedicated Tab Button -->
              <button type="button" class="cs-pill-btn cs-btn-dedicated-tab" title="Open this grading canvas in its own dedicated fullscreen tab">
                <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                <span class="cs-action-label">⛶ Tab</span>
              </button>`
              : ''
          }

          <!-- Sync Status Pill -->
          <div class="cs-sync-pill cs-status-saved">
            <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            <span class="cs-sync-label">Saved</span>
          </div>

          <!-- Close / Return -->
          <button type="button" class="cs-pill-btn cs-btn-close" title="Exit stylus grading">
            <svg class="cs-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span class="cs-action-label">Close</span>
          </button>
        </div>
      </div>
    `;
  }

  private closeCustomPopover() {
    const popover = this.container.querySelector('.cs-custom-popover');
    if (popover) {
      popover.remove();
    }
    this.activePopover = null;
  }

  private toggleCustomPopover(target: 'pen' | 'highlighter' | 'text', anchorBtn: HTMLElement) {
    if (this.activePopover === target) {
      this.closeCustomPopover();
      return;
    }

    this.closeCustomPopover();
    this.activePopover = target;

    const popover = document.createElement('div');
    popover.className = 'cs-custom-popover';

    const rect = anchorBtn.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const leftOffset = Math.max(8, rect.left - containerRect.left - 40);
    popover.style.left = `${leftOffset}px`;

    if (target === 'pen') {
      const activeColor = this.penColors[this.activePenSlot];
      popover.innerHTML = `
        <div class="cs-pop-header">
          <span class="cs-pop-title">⚙️ Pen Settings</span>
          <button type="button" class="cs-pop-close" title="Close">✕</button>
        </div>

        <div class="cs-pop-row">
          <div class="cs-pop-label-row">
            <span class="cs-pop-label">Thickness:</span>
            <b class="cs-pop-size-label">${this.currentPenThickness}px</b>
          </div>
          <input type="range" class="cs-pop-slider" min="1" max="24" step="1" value="${this.currentPenThickness}" />
        </div>

        <div class="cs-pop-row">
          <div class="cs-pop-label-row">
            <span class="cs-pop-label">Select & Edit Color:</span>
            <span class="cs-pop-slot-text">Slot ${this.activePenSlot + 1}</span>
          </div>
          <div class="cs-pop-slots-row">
            <button type="button" class="cs-pop-slot ${this.activePenSlot === 0 ? 'selected' : ''}" data-pop-slot="0" style="background-color: ${this.penColors[0]};" title="Slot 1"></button>
            <button type="button" class="cs-pop-slot ${this.activePenSlot === 1 ? 'selected' : ''}" data-pop-slot="1" style="background-color: ${this.penColors[1]};" title="Slot 2"></button>
            <button type="button" class="cs-pop-slot ${this.activePenSlot === 2 ? 'selected' : ''}" data-pop-slot="2" style="background-color: ${this.penColors[2]};" title="Slot 3"></button>
          </div>
          <div class="cs-pop-color-group">
            <input type="color" class="cs-pop-color-picker" value="${activeColor}" />
            <input type="text" class="cs-pop-hex-input" value="${activeColor}" maxlength="7" spellcheck="false" />
          </div>
        </div>

        <div class="cs-pop-preview-box">
          <div class="cs-pop-pen-preview" style="height: ${this.currentPenThickness}px; background-color: ${activeColor};"></div>
        </div>
      `;
    } else if (target === 'highlighter') {
      const activeColor = this.hlColors[this.activeHlSlot];
      popover.innerHTML = `
        <div class="cs-pop-header">
          <span class="cs-pop-title">⚙️ Highlighter Settings</span>
          <button type="button" class="cs-pop-close" title="Close">✕</button>
        </div>

        <div class="cs-pop-row">
          <div class="cs-pop-label-row">
            <span class="cs-pop-label">Thickness:</span>
            <b class="cs-pop-size-label">${this.currentHighlighterThickness}px</b>
          </div>
          <input type="range" class="cs-pop-slider" min="8" max="50" step="2" value="${this.currentHighlighterThickness}" />
        </div>

        <div class="cs-pop-row">
          <div class="cs-pop-label-row">
            <span class="cs-pop-label">Select & Edit Color:</span>
            <span class="cs-pop-slot-text">Slot ${this.activeHlSlot + 1}</span>
          </div>
          <div class="cs-pop-slots-row">
            <button type="button" class="cs-pop-slot ${this.activeHlSlot === 0 ? 'selected' : ''}" data-pop-slot="0" style="background-color: ${this.hlColors[0]};" title="Slot 1"></button>
            <button type="button" class="cs-pop-slot ${this.activeHlSlot === 1 ? 'selected' : ''}" data-pop-slot="1" style="background-color: ${this.hlColors[1]};" title="Slot 2"></button>
            <button type="button" class="cs-pop-slot ${this.activeHlSlot === 2 ? 'selected' : ''}" data-pop-slot="2" style="background-color: ${this.hlColors[2]};" title="Slot 3"></button>
          </div>
          <div class="cs-pop-color-group">
            <input type="color" class="cs-pop-color-picker" value="${activeColor}" />
            <input type="text" class="cs-pop-hex-input" value="${activeColor}" maxlength="7" spellcheck="false" />
          </div>
        </div>

        <div class="cs-pop-preview-box">
          <div class="cs-pop-hl-preview" style="height: ${this.currentHighlighterThickness}px; background-color: ${activeColor}; opacity: 0.45;"></div>
        </div>
      `;
    } else if (target === 'text') {
      const activeColor = this.textColors[this.activeTextSlot];
      popover.innerHTML = `
        <div class="cs-pop-header">
          <span class="cs-pop-title">⚙️ Text Settings</span>
          <button type="button" class="cs-pop-close" title="Close">✕</button>
        </div>

        <div class="cs-pop-row">
          <div class="cs-pop-label-row">
            <span class="cs-pop-label">Font Size:</span>
            <b class="cs-pop-size-label">${this.currentTextSize}px</b>
          </div>
          <input type="range" class="cs-pop-slider" min="12" max="64" step="2" value="${this.currentTextSize}" />
        </div>

        <div class="cs-pop-row">
          <div class="cs-pop-label-row">
            <span class="cs-pop-label">Select & Edit Color:</span>
            <span class="cs-pop-slot-text">Slot ${this.activeTextSlot + 1}</span>
          </div>
          <div class="cs-pop-slots-row">
            <button type="button" class="cs-pop-slot ${this.activeTextSlot === 0 ? 'selected' : ''}" data-pop-slot="0" style="background-color: ${this.textColors[0]};" title="Slot 1"></button>
            <button type="button" class="cs-pop-slot ${this.activeTextSlot === 1 ? 'selected' : ''}" data-pop-slot="1" style="background-color: ${this.textColors[1]};" title="Slot 2"></button>
            <button type="button" class="cs-pop-slot ${this.activeTextSlot === 2 ? 'selected' : ''}" data-pop-slot="2" style="background-color: ${this.textColors[2]};" title="Slot 3"></button>
          </div>
          <div class="cs-pop-color-group">
            <input type="color" class="cs-pop-color-picker" value="${activeColor}" />
            <input type="text" class="cs-pop-hex-input" value="${activeColor}" maxlength="7" spellcheck="false" />
          </div>
        </div>

        <div class="cs-pop-preview-box">
          <span class="cs-pop-text-preview" style="font-size: ${this.currentTextSize}px; color: ${activeColor}; font-weight: bold; font-family: 'Google Sans', Roboto, sans-serif;">Sample Text</span>
        </div>
      `;
    }

    this.container.appendChild(popover);
    this.bindPopoverEvents(popover, target);
  }

  private bindPopoverEvents(popover: HTMLElement, target: 'pen' | 'highlighter' | 'text') {
    const colorPicker = popover.querySelector<HTMLInputElement>('.cs-pop-color-picker');
    const hexInput = popover.querySelector<HTMLInputElement>('.cs-pop-hex-input');
    const slider = popover.querySelector<HTMLInputElement>('.cs-pop-slider');
    const sizeLabel = popover.querySelector<HTMLElement>('.cs-pop-size-label');
    const slotText = popover.querySelector<HTMLElement>('.cs-pop-slot-text');
    const closeBtn = popover.querySelector<HTMLButtonElement>('.cs-pop-close');

    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeCustomPopover();
    });

    const getColorsArray = (): [string, string, string] => {
      if (target === 'pen') return this.penColors;
      if (target === 'highlighter') return this.hlColors;
      return this.textColors;
    };

    const getActiveSlotIndex = (): number => {
      if (target === 'pen') return this.activePenSlot;
      if (target === 'highlighter') return this.activeHlSlot;
      return this.activeTextSlot;
    };

    const setActiveSlotIndex = (slot: number) => {
      if (target === 'pen') this.activePenSlot = slot;
      else if (target === 'highlighter') this.activeHlSlot = slot;
      else this.activeTextSlot = slot;
    };

    const updateActiveColor = (newColor: string) => {
      if (!newColor) return;
      const colors = getColorsArray();
      const slot = getActiveSlotIndex();
      colors[slot] = newColor;

      if (colorPicker) colorPicker.value = newColor;
      if (hexInput) hexInput.value = newColor;

      // Update slot dot in popover
      const popSlotBtn = popover.querySelector<HTMLElement>(`.cs-pop-slot[data-pop-slot="${slot}"]`);
      if (popSlotBtn) popSlotBtn.style.backgroundColor = newColor;

      // Update main toolbar color dot
      const toolOptionClass = target === 'pen' ? '.cs-pen-options' : (target === 'highlighter' ? '.cs-highlighter-options' : '.cs-text-options');
      const mainDot = this.container.querySelector<HTMLElement>(`${toolOptionClass} .cs-color-dot[data-slot="${slot}"]`);
      if (mainDot) mainDot.style.backgroundColor = newColor;

      // Update preview dot on main tool button & fire event
      if (target === 'pen') {
        const previewDot = this.container.querySelector('.cs-pen-preview-dot') as HTMLElement;
        if (previewDot) previewDot.style.backgroundColor = newColor;
        this.events.onPenColorChange(newColor);

        const penPreview = popover.querySelector<HTMLElement>('.cs-pop-pen-preview');
        if (penPreview) penPreview.style.backgroundColor = newColor;
      } else if (target === 'highlighter') {
        const previewDot = this.container.querySelector('.cs-hl-preview-dot') as HTMLElement;
        if (previewDot) previewDot.style.backgroundColor = newColor;
        this.events.onHighlighterColorChange(newColor);

        const hlPreview = popover.querySelector<HTMLElement>('.cs-pop-hl-preview');
        if (hlPreview) hlPreview.style.backgroundColor = newColor;
      } else if (target === 'text') {
        const previewDot = this.container.querySelector('.cs-text-preview-dot') as HTMLElement;
        if (previewDot) previewDot.style.backgroundColor = newColor;
        this.events.onPenColorChange(newColor);

        const textPreview = popover.querySelector<HTMLElement>('.cs-pop-text-preview');
        if (textPreview) textPreview.style.color = newColor;
      }
    };

    // Slot click inside popover to switch which slot is being edited
    popover.querySelectorAll<HTMLButtonElement>('.cs-pop-slot').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const slot = parseInt(btn.dataset.popSlot || '0', 10);
        setActiveSlotIndex(slot);

        popover.querySelectorAll('.cs-pop-slot').forEach((b) => {
          b.classList.toggle('selected', (b as HTMLElement).dataset.popSlot === String(slot));
        });

        if (slotText) slotText.textContent = `Slot ${slot + 1}`;

        // Also select on main toolbar
        const toolOptionClass = target === 'pen' ? '.cs-pen-options' : (target === 'highlighter' ? '.cs-highlighter-options' : '.cs-text-options');
        this.container.querySelectorAll(`${toolOptionClass} .cs-color-dot`).forEach((d) => {
          d.classList.toggle('selected', (d as HTMLElement).dataset.slot === String(slot));
        });

        const colors = getColorsArray();
        const curColor = colors[slot];
        if (colorPicker) colorPicker.value = curColor;
        if (hexInput) hexInput.value = curColor;
        updateActiveColor(curColor);
      });
    });

    colorPicker?.addEventListener('input', (e) => {
      updateActiveColor((e.target as HTMLInputElement).value);
    });

    hexInput?.addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value.trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
        updateActiveColor(val);
      }
    });

    slider?.addEventListener('input', (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      if (sizeLabel) sizeLabel.textContent = `${val}px`;

      if (target === 'pen') {
        this.currentPenThickness = val;
        const penPreview = popover.querySelector<HTMLElement>('.cs-pop-pen-preview');
        if (penPreview) penPreview.style.height = `${val}px`;
        this.events.onPenThicknessChange(val);
      } else if (target === 'highlighter') {
        this.currentHighlighterThickness = val;
        const hlPreview = popover.querySelector<HTMLElement>('.cs-pop-hl-preview');
        if (hlPreview) hlPreview.style.height = `${val}px`;
        this.events.onHighlighterThicknessChange?.(val);
      } else if (target === 'text') {
        this.currentTextSize = val;
        const textPreview = popover.querySelector<HTMLElement>('.cs-pop-text-preview');
        if (textPreview) textPreview.style.fontSize = `${val}px`;
        this.events.onTextSizeChange?.(val);
      }
    });
  }

  private bindEvents() {
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Close popover if clicked outside
      if (!target.closest('.cs-custom-popover') && !target.closest('.cs-btn-open-custom')) {
        this.closeCustomPopover();
      }

      // Tool click
      const toolBtn = target.closest<HTMLButtonElement>('.cs-tool-btn');
      if (toolBtn && toolBtn.dataset.tool) {
        const tool = toolBtn.dataset.tool as ToolType;
        this.setActiveTool(tool);
        return;
      }

      // Open Settings (Gear cog)
      const customToggle = target.closest<HTMLButtonElement>('.cs-btn-open-custom');
      if (customToggle && customToggle.dataset.customTarget) {
        const customTarget = customToggle.dataset.customTarget as 'pen' | 'highlighter' | 'text';
        this.toggleCustomPopover(customTarget, customToggle);
        return;
      }

      // Main Toolbar 3-color dot clicks
      const colorDot = target.closest<HTMLButtonElement>('.cs-color-dot[data-tool-slot]');
      if (colorDot && colorDot.dataset.toolSlot && colorDot.dataset.slot !== undefined) {
        const tool = colorDot.dataset.toolSlot;
        const slot = parseInt(colorDot.dataset.slot, 10);

        if (tool === 'pen') {
          this.activePenSlot = slot;
          this.container.querySelectorAll('.cs-pen-options .cs-color-dot').forEach((d) => {
            d.classList.toggle('selected', (d as HTMLElement).dataset.slot === String(slot));
          });
          const curColor = this.penColors[slot];
          const penDot = this.container.querySelector('.cs-pen-preview-dot') as HTMLElement;
          if (penDot) penDot.style.backgroundColor = curColor;
          this.events.onPenColorChange(curColor);
        } else if (tool === 'highlighter') {
          this.activeHlSlot = slot;
          this.container.querySelectorAll('.cs-highlighter-options .cs-color-dot').forEach((d) => {
            d.classList.toggle('selected', (d as HTMLElement).dataset.slot === String(slot));
          });
          const curColor = this.hlColors[slot];
          const hlDot = this.container.querySelector('.cs-hl-preview-dot') as HTMLElement;
          if (hlDot) hlDot.style.backgroundColor = curColor;
          this.events.onHighlighterColorChange(curColor);
        } else if (tool === 'text') {
          this.activeTextSlot = slot;
          this.container.querySelectorAll('.cs-text-options .cs-color-dot').forEach((d) => {
            d.classList.toggle('selected', (d as HTMLElement).dataset.slot === String(slot));
          });
          const curColor = this.textColors[slot];
          const textDot = this.container.querySelector('.cs-text-preview-dot') as HTMLElement;
          if (textDot) textDot.style.backgroundColor = curColor;
          this.events.onPenColorChange(curColor);
        }
        return;
      }

      // Thickness preset for Pen
      const thickBtn = target.closest<HTMLButtonElement>('.cs-thick-btn[data-thick]');
      if (thickBtn && thickBtn.dataset.thick) {
        this.currentPenThickness = parseInt(thickBtn.dataset.thick, 10);
        this.container.querySelectorAll('.cs-thick-btn[data-thick]').forEach((b) => {
          b.classList.toggle('selected', (b as HTMLElement).dataset.thick === String(this.currentPenThickness));
        });
        this.events.onPenThicknessChange(this.currentPenThickness);
        return;
      }

      // Thickness preset for Highlighter
      const hlThickBtn = target.closest<HTMLButtonElement>('.cs-thick-btn[data-hl-thick]');
      if (hlThickBtn && hlThickBtn.dataset.hlThick) {
        this.currentHighlighterThickness = parseInt(hlThickBtn.dataset.hlThick, 10);
        this.container.querySelectorAll('.cs-thick-btn[data-hl-thick]').forEach((b) => {
          b.classList.toggle('selected', (b as HTMLElement).dataset.hlThick === String(this.currentHighlighterThickness));
        });
        this.events.onHighlighterThicknessChange?.(this.currentHighlighterThickness);
        return;
      }

      // Font size preset for Text
      const textPresetBtn = target.closest<HTMLButtonElement>('.cs-thick-btn[data-text-size]');
      if (textPresetBtn && textPresetBtn.dataset.textSize) {
        this.currentTextSize = parseInt(textPresetBtn.dataset.textSize, 10);
        this.container.querySelectorAll('.cs-thick-btn[data-text-size]').forEach((b) => {
          b.classList.toggle('selected', (b as HTMLElement).dataset.textSize === String(this.currentTextSize));
        });
        this.events.onTextSizeChange?.(this.currentTextSize);
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
        this.bindEvents();
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

    // Close popover when clicking outside toolbar
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target as Node)) {
        this.closeCustomPopover();
      }
    });
  }

  private showRestoreConfirmation() {
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

    const cancelBtn = modalOverlay.querySelector('.cs-modal-cancel');
    const confirmBtn = modalOverlay.querySelector('.cs-modal-confirm');

    const close = () => {
      if (modalOverlay.parentNode) {
        modalOverlay.parentNode.removeChild(modalOverlay);
      }
    };

    cancelBtn?.addEventListener('click', close);
    confirmBtn?.addEventListener('click', () => {
      close();
      this.events.onRestoreOriginal();
    });
  }

  private bindKeyShortcuts() {
    window.addEventListener('keydown', (e) => {
      // If user is typing in Classroom's right sidebar grade/comment input or floating text note, do not intercept
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.getAttribute('contenteditable') === 'true')
      ) {
        return;
      }

      // Close popover on Escape
      if (e.key === 'Escape' && this.activePopover) {
        this.closeCustomPopover();
        return;
      }

      // Undo / Redo
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
      // Hotkey: P for Pen
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        this.setActiveTool('pen');
      }
      // Hotkey: E for Eraser
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        this.setActiveTool('eraser');
      }
      // Hotkey: H for Highlighter
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        this.setActiveTool('highlighter');
      }
      // Hotkey: T for Text
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        this.setActiveTool('text');
      }
      // Hotkey: Next Page (ArrowRight, PageDown, ])
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ']')) {
        e.preventDefault();
        this.events.onNextPage?.();
      }
      // Hotkey: Previous Page (ArrowLeft, PageUp, [)
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === '[')) {
        e.preventDefault();
        this.events.onPrevPage?.();
      }
      // Hotkey: Scroll Half Page Down (ArrowDown)
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        this.events.onScrollHalfPageDown?.();
      }
      // Hotkey: Scroll Half Page Up (ArrowUp)
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        this.events.onScrollHalfPageUp?.();
      }
      // Hotkey: Zoom In (+ or =)
      else if (!e.ctrlKey && !e.metaKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.events.onZoomIn?.();
      }
      // Hotkey: Zoom Out (- or _)
      else if (!e.ctrlKey && !e.metaKey && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        this.events.onZoomOut?.();
      }
      // Hotkey: Reset Zoom (0)
      else if (!e.ctrlKey && !e.metaKey && e.key === '0') {
        e.preventDefault();
        this.events.onZoomReset?.();
      }
    });
  }
}
