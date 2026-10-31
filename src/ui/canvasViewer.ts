import * as pdfjsLib from 'pdfjs-dist';
import { Stroke, PageStrokesMap } from '../types';
import { StylusEngine } from '../engine/stylus';

// Configure PDF.js worker with CSP blob fallback
async function initPdfWorker() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      const workerUrl = chrome.runtime.getURL('pdf.worker.min.mjs');
      try {
        const resp = await fetch(workerUrl);
        const script = await resp.text();
        const blob = new Blob([script], { type: 'application/javascript' });
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
      } catch {
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      }
    }
  } catch (err) {
    console.warn('[RedPen] Error configuring workerSrc:', err);
  }
}
initPdfWorker();

export interface CanvasViewerEvents {
  onStrokeDrawn: (pageIndex: number, stroke: Stroke) => void;
  onStrokeErased: (pageIndex: number, stroke: Stroke) => void;
}

interface PageRecord {
  pageIndex: number;
  pdfPage: any;
  container: HTMLDivElement;
  pdfCanvas: HTMLCanvasElement;
  inkCanvas: HTMLCanvasElement;
  unscaledWidth: number;
  unscaledHeight: number;
  renderedZoom: number;
  renderTask?: any;
}

export class CanvasViewer {
  private rootElement: HTMLElement;
  private scrollContainer: HTMLDivElement;
  private pagesWrapper: HTMLDivElement;
  private bottomZoomPill: HTMLDivElement;
  private stylusEngine: StylusEngine;
  private events: CanvasViewerEvents;

  private pdfDoc: any = null;
  private pageRecords: PageRecord[] = [];
  private pageStrokesMap: PageStrokesMap = {};
  private currentZoom: number = 1.0;
  private currentPage: number = 1;
  private totalPages: number = 1;
  private intersectionObserver: IntersectionObserver | null = null;

  constructor(stylusEngine: StylusEngine, events: CanvasViewerEvents) {
    this.stylusEngine = stylusEngine;
    this.events = events;

    this.rootElement = document.createElement('div');
    this.rootElement.className = 'classroom-stylus-viewer-root';

    // Scrollable dark background container #13181c
    this.scrollContainer = document.createElement('div');
    this.scrollContainer.className = 'cs-scroll-container';

    this.pagesWrapper = document.createElement('div');
    this.pagesWrapper.className = 'cs-pages-wrapper';
    this.scrollContainer.appendChild(this.pagesWrapper);

    // Floating bottom zoom pill
    this.bottomZoomPill = document.createElement('div');
    this.bottomZoomPill.className = 'cs-bottom-zoom-pill';

    this.rootElement.appendChild(this.scrollContainer);
    this.rootElement.appendChild(this.bottomZoomPill);

    this.renderBottomZoomPill();
    this.bindZoomEvents();
    this.initIntersectionObserver();
    this.showLoader('Loading student submission...');
  }

  showLoader(message: string = 'Loading student submission...') {
    this.pagesWrapper.innerHTML = `
      <div class="cs-viewer-loader">
        <div class="cs-spinner-lg"></div>
        <p class="cs-loader-text">${message}</p>
      </div>
    `;
  }

  getElement(): HTMLElement {
    return this.rootElement;
  }

  getZoomPill(): HTMLElement {
    return this.bottomZoomPill;
  }

  getScrollContainer(): HTMLElement {
    return this.scrollContainer;
  }

  setStrokes(pageStrokes: PageStrokesMap) {
    this.pageStrokesMap = pageStrokes;
    this.redrawAllInkCanvases();
  }

  getStrokes(): PageStrokesMap {
    return this.pageStrokesMap;
  }

  async loadPdf(pdfBytes: ArrayBuffer, initialStrokes: PageStrokesMap) {
    this.pageStrokesMap = initialStrokes;
    this.pagesWrapper.innerHTML = '';
    this.pageRecords = [];

    // Show loading spinner
    const spinner = document.createElement('div');
    spinner.className = 'cs-viewer-loader';
    spinner.innerHTML = `
      <div class="cs-spinner-lg"></div>
      <p class="cs-loader-text">Loading student submission...</p>
    `;
    this.pagesWrapper.appendChild(spinner);

    try {
      // Load PDF via PDF.js
      const loadingTask = pdfjsLib.getDocument({
        data: pdfBytes.slice(0),
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/cmaps/',
        cMapPacked: true,
      });

      this.pdfDoc = await loadingTask.promise;
      this.totalPages = this.pdfDoc.numPages;
      this.currentPage = 1;

      this.pagesWrapper.innerHTML = '';

      // Determine initial zoom to fit container width comfortably
      const containerWidth = this.scrollContainer.clientWidth || 900;
      const firstPage = await this.pdfDoc.getPage(1);
      const viewport = firstPage.getViewport({ scale: 1.0 });
      const fitZoom = Math.min(1.5, Math.max(0.6, (containerWidth - 64) / viewport.width));
      this.currentZoom = Math.round(fitZoom * 100) / 100;

      // Create page containers
      for (let i = 1; i <= this.totalPages; i++) {
        const pageIndex = i - 1;
        const page = await this.pdfDoc.getPage(i);
        const vp = page.getViewport({ scale: 1.0 });

        const pageContainer = document.createElement('div');
        pageContainer.className = 'cs-page-card';
        pageContainer.dataset.pageIndex = String(pageIndex);
        pageContainer.dataset.pageNum = String(i);

        const pdfCanvas = document.createElement('canvas');
        pdfCanvas.className = 'cs-pdf-canvas';

        const inkCanvas = document.createElement('canvas');
        inkCanvas.className = 'cs-ink-canvas';

        pageContainer.appendChild(pdfCanvas);
        pageContainer.appendChild(inkCanvas);
        this.pagesWrapper.appendChild(pageContainer);

        const record: PageRecord = {
          pageIndex,
          pdfPage: page,
          container: pageContainer,
          pdfCanvas,
          inkCanvas,
          unscaledWidth: vp.width,
          unscaledHeight: vp.height,
          renderedZoom: 0,
        };

        this.pageRecords.push(record);
        this.attachPointerEvents(record);
        if (this.intersectionObserver) {
          this.intersectionObserver.observe(pageContainer);
        }
      }

      await this.renderAllPages();
      this.updateBottomZoomPill();
    } catch (err: any) {
      console.error('[RedPen] Failed to load PDF:', err);
      this.pagesWrapper.innerHTML = `
        <div class="cs-error-card">
          <svg class="cs-icon-lg" viewBox="0 0 24 24" fill="none" stroke="#f28b82" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <h3 class="cs-error-title">Failed to render PDF</h3>
          <p class="cs-error-msg">${err?.message || 'Unknown error occurred while decoding document.'}</p>
        </div>
      `;
    }
  }

  private async renderAllPages() {
    for (const record of this.pageRecords) {
      await this.renderSinglePage(record);
    }
  }

  private async renderSinglePage(record: PageRecord) {
    const zoom = this.currentZoom;
    const dpr = window.devicePixelRatio || 1;

    const width = record.unscaledWidth * zoom;
    const height = record.unscaledHeight * zoom;

    // Set page container dimensions
    record.container.style.width = `${width}px`;
    record.container.style.height = `${height}px`;

    // Cancel any previous active render operation on this canvas
    if (record.renderTask) {
      try {
        record.renderTask.cancel();
      } catch {}
      try {
        await record.renderTask.promise;
      } catch (err: any) {
        // RenderingCancelledException is expected when zoom changes rapidly
      }
      record.renderTask = null;
    }

    // 1. Render PDF Canvas
    const pdfViewport = record.pdfPage.getViewport({ scale: zoom * dpr });
    record.pdfCanvas.width = width * dpr;
    record.pdfCanvas.height = height * dpr;
    record.pdfCanvas.style.width = `${width}px`;
    record.pdfCanvas.style.height = `${height}px`;

    const pdfCtx = record.pdfCanvas.getContext('2d', { alpha: false });
    if (pdfCtx) {
      pdfCtx.imageSmoothingEnabled = true;
      const renderTask = record.pdfPage.render({
        canvasContext: pdfCtx,
        viewport: pdfViewport,
      });
      record.renderTask = renderTask;
      try {
        await renderTask.promise;
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') {
          return;
        }
        console.warn('[RedPen] PDF render error:', err);
      } finally {
        if (record.renderTask === renderTask) {
          record.renderTask = null;
        }
      }
    }

    // 2. Setup Ink Canvas
    record.inkCanvas.width = width * dpr;
    record.inkCanvas.height = height * dpr;
    record.inkCanvas.style.width = `${width}px`;
    record.inkCanvas.style.height = `${height}px`;

    record.renderedZoom = zoom;
    this.redrawInkCanvas(record);
  }

  private redrawInkCanvas(record: PageRecord) {
    const ctx = record.inkCanvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, record.inkCanvas.width, record.inkCanvas.height);
    ctx.scale(dpr, dpr);

    const strokes = this.pageStrokesMap[record.pageIndex] || [];
    StylusEngine.renderStrokes(ctx, strokes, this.currentZoom);
  }

  redrawAllInkCanvases() {
    for (const record of this.pageRecords) {
      this.redrawInkCanvas(record);
    }
  }

  redrawSinglePageIndex(pageIndex: number) {
    const record = this.pageRecords.find((r) => r.pageIndex === pageIndex);
    if (record) {
      this.redrawInkCanvas(record);
    }
  }

  private attachPointerEvents(record: PageRecord) {
    const inkCanvas = record.inkCanvas;
    let isDrawing = false;
    let isPointerDown = false;

    inkCanvas.addEventListener('pointerdown', (e: PointerEvent) => {
      // Stylus touch-action: none prevents palm scrolling
      e.preventDefault();
      isPointerDown = true;

      // Text tool handles click-to-type
      if (this.stylusEngine.getOptions().activeTool === 'text') {
        this.spawnTextInput(e, record);
        return;
      }

      const strokes = this.pageStrokesMap[record.pageIndex] || (this.pageStrokesMap[record.pageIndex] = []);

      const result = this.stylusEngine.startPointer(
        e,
        record.pageIndex,
        inkCanvas,
        this.currentZoom,
        strokes
      );

      if (result.erasedStroke) {
        this.redrawInkCanvas(record);
        this.events.onStrokeErased(record.pageIndex, result.erasedStroke);
      } else if (result.strokeStarted) {
        isDrawing = true;
      }
    });

    inkCanvas.addEventListener('pointermove', (e: PointerEvent) => {
      // If tool is eraser, strictly require active pointer press (clicked or touching screen)
      if (this.stylusEngine.getOptions().activeTool === 'eraser') {
        if (!isPointerDown || (e.buttons === 0 && e.pressure === 0)) {
          return;
        }
      }

      const strokes = this.pageStrokesMap[record.pageIndex] || (this.pageStrokesMap[record.pageIndex] = []);

      const result = this.stylusEngine.movePointer(
        e,
        record.pageIndex,
        inkCanvas,
        this.currentZoom,
        strokes
      );

      if (result.erasedStroke) {
        this.redrawInkCanvas(record);
        this.events.onStrokeErased(record.pageIndex, result.erasedStroke);
      } else if (result.stroke && isDrawing) {
        // Live stroke update
        const ctx = inkCanvas.getContext('2d');
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
          ctx.scale(dpr, dpr);

          // Render previous committed strokes + active in-progress stroke
          StylusEngine.renderStrokes(ctx, [...strokes, result.stroke], this.currentZoom);
        }
      }
    });

    const handlePointerUp = (e: PointerEvent) => {
      isPointerDown = false;
      if (!isDrawing && this.stylusEngine.getOptions().activeTool !== 'eraser') return;
      isDrawing = false;

      const finishedStroke = this.stylusEngine.endPointer(e, record.pageIndex, inkCanvas);
      if (finishedStroke) {
        const strokes = this.pageStrokesMap[record.pageIndex] || (this.pageStrokesMap[record.pageIndex] = []);
        strokes.push(finishedStroke);
        this.redrawInkCanvas(record);
        this.events.onStrokeDrawn(record.pageIndex, finishedStroke);
      }
    };

    inkCanvas.addEventListener('pointerup', handlePointerUp);
    inkCanvas.addEventListener('pointercancel', handlePointerUp);
    inkCanvas.addEventListener('pointerleave', () => {
      isPointerDown = false;
    });
  }

  private spawnTextInput(e: PointerEvent, record: PageRecord) {
    document.querySelectorAll('.cs-floating-text-input').forEach((el) => el.remove());

    const rect = record.inkCanvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const unscaledX = clickX / this.currentZoom;
    const unscaledY = clickY / this.currentZoom;

    const strokes = this.pageStrokesMap[record.pageIndex] || (this.pageStrokesMap[record.pageIndex] = []);

    // Check if clicked near an existing text stroke to edit it!
    const hitThreshold = 18;
    let existingStrokeIdx = -1;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (
        s.tool === 'text' &&
        this.stylusEngine.isPointNearBBox(
          { x: unscaledX, y: unscaledY, pressure: 1, width: 1 },
          s.bbox,
          hitThreshold
        )
      ) {
        existingStrokeIdx = i;
        break;
      }
    }

    let existingStroke: Stroke | null = null;
    let initialText = '';
    let textOriginX = unscaledX;
    let textOriginY = unscaledY;
    let fontSize = this.stylusEngine.getOptions().textSize || 24; // Default increased to 24px!
    let curColor = this.stylusEngine.getOptions().penColor || '#f0393c';

    if (existingStrokeIdx !== -1) {
      existingStroke = strokes[existingStrokeIdx];
      initialText = existingStroke.text || '';
      textOriginX = existingStroke.points[0]?.x ?? unscaledX;
      textOriginY = existingStroke.points[0]?.y ?? unscaledY;
      fontSize = existingStroke.fontSize || fontSize;
      curColor = existingStroke.color || curColor;

      // Temporarily remove existing stroke from canvas while editing
      strokes.splice(existingStrokeIdx, 1);
      this.redrawInkCanvas(record);
    }

    const input = document.createElement('textarea');
    input.className = 'cs-floating-text-input';
    input.placeholder = 'Type comment... (Enter to finish, Shift+Enter for newline, Esc to cancel)';
    input.value = initialText;
    input.style.left = `${textOriginX * this.currentZoom}px`;
    input.style.top = `${textOriginY * this.currentZoom}px`;
    input.style.color = curColor;
    input.style.fontSize = `${fontSize * this.currentZoom}px`;

    let committed = false;

    const commitText = () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      input.remove();

      if (!val) {
        // If it was an existing stroke and user cleared it, record erase
        if (existingStroke) {
          this.stylusEngine.recordStrokeErased(record.pageIndex, existingStroke);
          this.events.onStrokeErased(record.pageIndex, existingStroke);
        }
        return;
      }

      const lines = val.split('\n');
      const maxLineLen = Math.max(...lines.map((l) => l.length));
      const estWidth = maxLineLen * (fontSize * 0.65);
      const estHeight = lines.length * (fontSize * 1.3);

      const textStroke: Stroke = {
        id: existingStroke?.id || ('t_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)),
        tool: 'text',
        color: curColor,
        baseThickness: fontSize,
        opacity: 1.0,
        points: [{ x: textOriginX, y: textOriginY, pressure: 1, width: fontSize }],
        text: val,
        fontSize,
        bbox: {
          minX: textOriginX,
          minY: textOriginY,
          maxX: textOriginX + estWidth,
          maxY: textOriginY + estHeight,
        },
        timestamp: Date.now(),
      };

      strokes.push(textStroke);
      this.redrawInkCanvas(record);
      this.stylusEngine.recordStrokeAdded(record.pageIndex, textStroke);
      this.events.onStrokeDrawn(record.pageIndex, textStroke);
    };

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        commitText();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        committed = true;
        input.remove();
        // Restore existing stroke on Escape
        if (existingStroke) {
          strokes.push(existingStroke);
          this.redrawInkCanvas(record);
        }
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(commitText, 100);
    });

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight}px`;
    });

    record.container.appendChild(input);
    setTimeout(() => {
      input.focus();
      if (initialText) {
        input.setSelectionRange(initialText.length, initialText.length);
      }
    }, 20);
  }

  // --- Zoom & Page Navigation Pill ---
  private renderBottomZoomPill() {
    this.bottomZoomPill.innerHTML = `
      <div class="cs-zoom-group">
        <button type="button" class="cs-zoom-btn cs-page-prev" title="Previous page">◀</button>
        <span class="cs-page-indicator">Page <b class="cs-cur-page">${this.currentPage}</b> / <span class="cs-total-page">${this.totalPages}</span></span>
        <button type="button" class="cs-zoom-btn cs-page-next" title="Next page">▶</button>
      </div>

      <div class="cs-zoom-sep"></div>

      <div class="cs-zoom-group">
        <button type="button" class="cs-zoom-btn cs-zoom-out" title="Zoom out (-15%)">−</button>
        <button type="button" class="cs-zoom-btn cs-zoom-reset" title="Fit width">${Math.round(this.currentZoom * 100)}%</button>
        <button type="button" class="cs-zoom-btn cs-zoom-in" title="Zoom in (+15%)">+</button>
      </div>
    `;
  }

  private onPageZoomChange?: (page: number, total: number, zoomPercent: number) => void;

  setPageZoomCallback(cb: (page: number, total: number, zoomPercent: number) => void) {
    this.onPageZoomChange = cb;
    cb(this.currentPage, this.totalPages, Math.round(this.currentZoom * 100));
  }

  prevPage() {
    this.scrollToPage(Math.max(1, this.currentPage - 1));
  }

  nextPage() {
    this.scrollToPage(Math.min(this.totalPages, this.currentPage + 1));
  }

  scrollHalfPageDown() {
    const amt = (this.scrollContainer.clientHeight || window.innerHeight) * 0.5;
    this.scrollContainer.scrollBy({ top: amt, behavior: 'smooth' });
  }

  scrollHalfPageUp() {
    const amt = (this.scrollContainer.clientHeight || window.innerHeight) * 0.5;
    this.scrollContainer.scrollBy({ top: -amt, behavior: 'smooth' });
  }

  zoomIn() {
    this.setZoom(Math.min(3.0, this.currentZoom + 0.15));
  }

  zoomOut() {
    this.setZoom(Math.max(0.4, this.currentZoom - 0.15));
  }

  resetZoom() {
    const containerWidth = this.scrollContainer.clientWidth || 900;
    const firstPage = this.pageRecords[0];
    if (firstPage) {
      const fit = Math.min(2.0, Math.max(0.5, (containerWidth - 64) / firstPage.unscaledWidth));
      this.setZoom(fit);
    }
  }

  getCurrentZoomPercent(): number {
    return Math.round(this.currentZoom * 100);
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  getTotalPages(): number {
    return this.totalPages;
  }

  private updateBottomZoomPill() {
    const curPageEl = this.bottomZoomPill.querySelector('.cs-cur-page');
    const totPageEl = this.bottomZoomPill.querySelector('.cs-total-page');
    const zoomResetEl = this.bottomZoomPill.querySelector('.cs-zoom-reset');

    if (curPageEl) curPageEl.textContent = String(this.currentPage);
    if (totPageEl) totPageEl.textContent = String(this.totalPages);
    if (zoomResetEl) zoomResetEl.textContent = `${Math.round(this.currentZoom * 100)}%`;

    this.onPageZoomChange?.(this.currentPage, this.totalPages, Math.round(this.currentZoom * 100));
  }

  private bindZoomEvents() {
    this.bottomZoomPill.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;

      if (target.closest('.cs-zoom-in')) {
        this.setZoom(Math.min(3.0, this.currentZoom + 0.15));
      } else if (target.closest('.cs-zoom-out')) {
        this.setZoom(Math.max(0.4, this.currentZoom - 0.15));
      } else if (target.closest('.cs-zoom-reset')) {
        // Fit width
        const containerWidth = this.scrollContainer.clientWidth || 900;
        const firstPage = this.pageRecords[0];
        if (firstPage) {
          const fit = Math.min(2.0, Math.max(0.5, (containerWidth - 64) / firstPage.unscaledWidth));
          this.setZoom(fit);
        }
      } else if (target.closest('.cs-page-prev')) {
        this.scrollToPage(Math.max(1, this.currentPage - 1));
      } else if (target.closest('.cs-page-next')) {
        this.scrollToPage(Math.min(this.totalPages, this.currentPage + 1));
      }
    });
  }

  async setZoom(newZoom: number) {
    this.currentZoom = Math.round(newZoom * 100) / 100;
    this.updateBottomZoomPill();
    await this.renderAllPages();
  }

  scrollToPage(pageNum: number) {
    const record = this.pageRecords.find((r) => r.pageIndex === pageNum - 1);
    if (record) {
      record.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.currentPage = pageNum;
      this.updateBottomZoomPill();
    }
  }

  private initIntersectionObserver() {
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = parseInt((entry.target as HTMLElement).dataset.pageNum || '1', 10);
            this.currentPage = pageNum;
            this.updateBottomZoomPill();
          }
        }
      },
      {
        root: this.scrollContainer,
        threshold: 0.4,
      }
    );
  }

  destroy() {
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    for (const r of this.pageRecords) {
      if (r.renderTask) {
        try { r.renderTask.cancel(); } catch {}
        r.renderTask = null;
      }
    }
    this.pagesWrapper.innerHTML = '';
    this.pageRecords = [];
  }
}
