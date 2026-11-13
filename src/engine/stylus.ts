import { Stroke, StrokePoint, ToolType, BoundingBox, PageStrokesMap } from '../types';

export interface StylusEngineOptions {
  penOnlyMode: boolean;
  activeTool: ToolType;
  penColor: string;
  penThickness: number;
  highlighterColor: string;
  highlighterThickness: number;
  textSize?: number;
  onStrokeAdded?: (pageIndex: number, stroke: Stroke) => void;
  onStrokeErased?: (pageIndex: number, erasedStroke: Stroke) => void;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
}

export type HistoryAction =
  | {
      type: 'add' | 'erase';
      pageIndex: number;
      stroke: Stroke;
    }
  | {
      type: 'rotate';
      pageIndex: number;
      deltaDegrees: number;
    };

export interface UndoRedoResult {
  type: 'stroke' | 'rotate';
  affectedPageIndex: number;
  deltaDegrees?: number;
}

export class StylusEngine {
  private options: StylusEngineOptions;
  private currentStroke: Stroke | null = null;
  private activePageIndex: number = -1;
  private undoStack: HistoryAction[] = [];
  private redoStack: HistoryAction[] = [];
  private cachedCanvasRect: DOMRect | null = null;

  constructor(options: StylusEngineOptions) {
    this.options = { ...options };
  }

  updateOptions(newOptions: Partial<StylusEngineOptions>) {
    this.options = { ...this.options, ...newOptions };
  }

  getOptions(): StylusEngineOptions {
    return { ...this.options };
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private notifyHistory() {
    this.options.onHistoryChange?.(this.canUndo(), this.canRedo());
  }

  recordStrokeAdded(pageIndex: number, stroke: Stroke) {
    this.undoStack.push({
      type: 'add',
      pageIndex,
      stroke,
    });
    this.redoStack = [];
    this.notifyHistory();
    this.options.onStrokeAdded?.(pageIndex, stroke);
  }

  recordStrokeErased(pageIndex: number, stroke: Stroke) {
    this.undoStack.push({
      type: 'erase',
      pageIndex,
      stroke,
    });
    this.redoStack = [];
    this.notifyHistory();
    this.options.onStrokeErased?.(pageIndex, stroke);
  }

  recordPageRotated(pageIndex: number, deltaDegrees: number = 90) {
    this.undoStack.push({
      type: 'rotate',
      pageIndex,
      deltaDegrees,
    });
    this.redoStack = [];
    this.notifyHistory();
  }

  /**
   * Transforms a PointerEvent coordinate on canvas to unscaled PDF points.
   * Utilizes instance cachedRect when available to avoid forced layout reflow.
   */
  getCanvasPoint(
    e: PointerEvent,
    canvas: HTMLCanvasElement,
    zoom: number,
    cachedRect?: DOMRect
  ): StrokePoint {
    const rect = cachedRect || this.cachedCanvasRect || (this.cachedCanvasRect = canvas.getBoundingClientRect());
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;

    // Convert CSS px to unscaled PDF point coordinates
    const x = rawX / zoom;
    const y = rawY / zoom;

    const pressure = e.pressure !== undefined && e.pressure > 0 ? e.pressure : 0.5;

    let width = this.options.penThickness;
    if (this.options.activeTool === 'highlighter') {
      width = this.options.highlighterThickness;
    } else if (e.pressure > 0) {
      width = this.options.penThickness * (0.4 + 1.2 * e.pressure);
    }

    return { x, y, pressure, width };
  }

  startPointer(
    e: PointerEvent,
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    pageStrokes: Stroke[]
  ): { strokeStarted: boolean; erasedStroke?: Stroke; stroke?: Stroke } {
    // Palm rejection: If pen-only mode is enabled, reject touch/mouse
    if (this.options.penOnlyMode && e.pointerType !== 'pen') {
      return { strokeStarted: false };
    }

    if (typeof canvas.setPointerCapture === 'function') {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Ignored if capture unsupported or pointer already released
      }
    }
    this.activePageIndex = pageIndex;
    this.cachedCanvasRect = canvas.getBoundingClientRect();

    const pt = this.getCanvasPoint(e, canvas, zoom, this.cachedCanvasRect);

    if (this.options.activeTool === 'eraser') {
      // Only erase on active press (stylus touching screen or mouse click)
      if (e.buttons === 0 && e.pressure === 0 && e.pointerType === 'pen') {
        return { strokeStarted: false };
      }
      const erased = this.checkAndErase(pt, pageIndex, pageStrokes, zoom);
      return { strokeStarted: false, erasedStroke: erased };
    }

    const isHighlighter = this.options.activeTool === 'highlighter';
    const color = isHighlighter ? this.options.highlighterColor : this.options.penColor;
    const thickness = isHighlighter
      ? this.options.highlighterThickness
      : this.options.penThickness;

    this.currentStroke = {
      id: 's_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      tool: this.options.activeTool,
      color,
      baseThickness: thickness,
      opacity: isHighlighter ? 0.35 : 1.0,
      points: [pt],
      bbox: { minX: pt.x, minY: pt.y, maxX: pt.x, maxY: pt.y },
      timestamp: Date.now(),
    };

    return { strokeStarted: true, stroke: this.currentStroke };
  }

  movePointer(
    e: PointerEvent,
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    pageStrokes: Stroke[]
  ): { stroke?: Stroke; erasedStroke?: Stroke; predictedPoints?: StrokePoint[] } {
    if (this.options.penOnlyMode && e.pointerType !== 'pen') {
      return {};
    }

    // Reuse cached canvas bounding rect during active stroke to eliminate synchronous layout reflows
    const rect = this.cachedCanvasRect || (this.cachedCanvasRect = canvas.getBoundingClientRect());

    // Coalesced events for high-frequency styluses (120Hz/240Hz)
    let events: PointerEvent[] | readonly PointerEvent[];
    if (typeof e.getCoalescedEvents === 'function') {
      try {
        const coalesced = e.getCoalescedEvents();
        events = coalesced && coalesced.length > 0 ? coalesced : [e];
      } catch {
        events = [e];
      }
    } else {
      events = [e];
    }

    if (this.options.activeTool === 'eraser') {
      // Only erase when pointer is actively pressed down (clicked or stylus touching screen)
      if (e.buttons === 0 && e.pressure === 0) {
        return {};
      }
      for (const ev of events) {
        if (ev.buttons === 0 && ev.pressure === 0) continue;
        const pt = this.getCanvasPoint(ev, canvas, zoom, rect);
        const erased = this.checkAndErase(pt, pageIndex, pageStrokes, zoom);
        if (erased) {
          return { erasedStroke: erased };
        }
      }
      return {};
    }

    if (!this.currentStroke || this.activePageIndex !== pageIndex) {
      return {};
    }

    for (const ev of events) {
      const pt = this.getCanvasPoint(ev, canvas, zoom, rect);
      this.currentStroke.points.push(pt);

      // Update stroke bounding box
      const halfW = pt.width / 2;
      this.currentStroke.bbox.minX = Math.min(this.currentStroke.bbox.minX, pt.x - halfW);
      this.currentStroke.bbox.minY = Math.min(this.currentStroke.bbox.minY, pt.y - halfW);
      this.currentStroke.bbox.maxX = Math.max(this.currentStroke.bbox.maxX, pt.x + halfW);
      this.currentStroke.bbox.maxY = Math.max(this.currentStroke.bbox.maxY, pt.y + halfW);
    }

    // Extract predicted events if supported by browser/OS for zero-latency stylus tracing
    let predictedPoints: StrokePoint[] | undefined = undefined;
    if (typeof (e as any).getPredictedEvents === 'function') {
      try {
        const predicted = (e as any).getPredictedEvents();
        if (predicted && predicted.length > 0) {
          predictedPoints = [];
          for (const pev of predicted) {
            predictedPoints.push(this.getCanvasPoint(pev, canvas, zoom, rect));
          }
        }
      } catch {
        // Fallback gracefully if predicted events are unavailable
      }
    }

    return { stroke: this.currentStroke, predictedPoints };
  }

  endPointer(
    e: PointerEvent,
    pageIndex: number,
    canvas: HTMLCanvasElement
  ): Stroke | null {
    if (typeof canvas.hasPointerCapture === 'function' && canvas.hasPointerCapture(e.pointerId)) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignored
      }
    }

    this.cachedCanvasRect = null;

    if (this.currentStroke && this.activePageIndex === pageIndex) {
      const finishedStroke = this.currentStroke;
      this.currentStroke = null;
      this.activePageIndex = -1;

      // Push to undo stack
      this.undoStack.push({
        type: 'add',
        pageIndex,
        stroke: finishedStroke,
      });
      this.redoStack = []; // Clear redo
      this.notifyHistory();

      this.options.onStrokeAdded?.(pageIndex, finishedStroke);
      return finishedStroke;
    }

    this.currentStroke = null;
    this.activePageIndex = -1;
    return null;
  }

  /**
   * Eraser logic: Checks if pointer intersects any stroke on the page.
   * If collision is found, removes the stroke and records in undo history.
   */
  private checkAndErase(
    pt: StrokePoint,
    pageIndex: number,
    pageStrokes: Stroke[],
    zoom: number
  ): Stroke | undefined {
    const eraserRadius = Math.max(12 / zoom, 8); // ~12px in screen space

    for (let i = pageStrokes.length - 1; i >= 0; i--) {
      const stroke = pageStrokes[i];
      if (!this.isPointNearBBox(pt, stroke.bbox, eraserRadius)) {
        continue;
      }

      if (this.isPointHittingStroke(pt, stroke, eraserRadius)) {
        const [erased] = pageStrokes.splice(i, 1);
        if (erased) {
          this.undoStack.push({
            type: 'erase',
            pageIndex,
            stroke: erased,
          });
          this.redoStack = [];
          this.notifyHistory();
          this.options.onStrokeErased?.(pageIndex, erased);
          return erased;
        }
      }
    }

    return undefined;
  }

  isPointNearBBox(pt: StrokePoint, bbox: BoundingBox, threshold: number): boolean {
    return (
      pt.x >= bbox.minX - threshold &&
      pt.x <= bbox.maxX + threshold &&
      pt.y >= bbox.minY - threshold &&
      pt.y <= bbox.maxY + threshold
    );
  }

  private isPointHittingStroke(
    pt: StrokePoint,
    stroke: Stroke,
    eraserRadius: number
  ): boolean {
    if (stroke.tool === 'text') {
      return this.isPointNearBBox(pt, stroke.bbox, eraserRadius);
    }

    if (stroke.points.length === 1) {
      const p = stroke.points[0];
      const dist = Math.hypot(pt.x - p.x, pt.y - p.y);
      return dist <= eraserRadius + (p.width || stroke.baseThickness) / 2;
    }

    for (let i = 0; i < stroke.points.length - 1; i++) {
      const a = stroke.points[i];
      const b = stroke.points[i + 1];

      const dist = this.pointToSegmentDistance(pt.x, pt.y, a.x, a.y, b.x, b.y);
      const segWidth = (a.width + b.width) / 2 || stroke.baseThickness;

      if (dist <= eraserRadius + segWidth / 2) {
        return true;
      }
    }

    return false;
  }

  private pointToSegmentDistance(
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
      return Math.hypot(px - x1, py - y1);
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    return Math.hypot(px - projX, py - projY);
  }

  /**
   * Undo last action (stroke addition, erasure, or page rotation)
   */
  undo(pageStrokesMap: PageStrokesMap): UndoRedoResult | null {
    const action = this.undoStack.pop();
    if (!action) return null;

    if (action.type === 'rotate') {
      this.redoStack.push(action);
      this.notifyHistory();
      return {
        type: 'rotate',
        affectedPageIndex: action.pageIndex,
        deltaDegrees: -action.deltaDegrees,
      };
    }

    const pageIndex = action.pageIndex;
    const strokes = pageStrokesMap[pageIndex] || (pageStrokesMap[pageIndex] = []);

    if (action.type === 'add') {
      // Undo addition => remove stroke
      const idx = strokes.findIndex((s) => s.id === action.stroke.id);
      if (idx !== -1) {
        strokes.splice(idx, 1);
      }
    } else if (action.type === 'erase') {
      // Undo erasure => re-insert stroke
      strokes.push(action.stroke);
    }

    this.redoStack.push(action);
    this.notifyHistory();
    return {
      type: 'stroke',
      affectedPageIndex: pageIndex,
    };
  }

  /**
   * Redo last undone action (stroke addition, erasure, or page rotation)
   */
  redo(pageStrokesMap: PageStrokesMap): UndoRedoResult | null {
    const action = this.redoStack.pop();
    if (!action) return null;

    if (action.type === 'rotate') {
      this.undoStack.push(action);
      this.notifyHistory();
      return {
        type: 'rotate',
        affectedPageIndex: action.pageIndex,
        deltaDegrees: action.deltaDegrees,
      };
    }

    const pageIndex = action.pageIndex;
    const strokes = pageStrokesMap[pageIndex] || (pageStrokesMap[pageIndex] = []);

    if (action.type === 'add') {
      // Redo addition => re-add stroke
      strokes.push(action.stroke);
    } else if (action.type === 'erase') {
      // Redo erasure => remove stroke again
      const idx = strokes.findIndex((s) => s.id === action.stroke.id);
      if (idx !== -1) {
        strokes.splice(idx, 1);
      }
    }

    this.undoStack.push(action);
    this.notifyHistory();
    return {
      type: 'stroke',
      affectedPageIndex: pageIndex,
    };
  }

  /**
   * Renders a single stroke onto a 2D canvas context with quadratic Bezier smoothing.
   * Supports optional predictedPoints for real-time low-latency stroke heads.
   */
  static renderSingleStroke(
    ctx: CanvasRenderingContext2D,
    stroke: Stroke,
    zoom: number,
    predictedPoints?: StrokePoint[]
  ) {
    if (!stroke.points || stroke.points.length === 0) return;

    ctx.save();

    const isHighlighter = stroke.tool === 'highlighter';
    if (isHighlighter) {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'multiply';
    } else {
      ctx.globalAlpha = stroke.opacity ?? 1.0;
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.tool === 'text' && stroke.text) {
      const pt = stroke.points[0];
      const fontSize = (stroke.fontSize || 16) * zoom;
      ctx.font = `bold ${fontSize}px 'Google Sans', Roboto, sans-serif`;
      ctx.fillStyle = stroke.color;
      ctx.textBaseline = 'top';
      const lines = stroke.text.split('\n');
      lines.forEach((line, lineIdx) => {
        ctx.fillText(line, pt.x * zoom, pt.y * zoom + lineIdx * fontSize * 1.25);
      });
      ctx.restore();
      return;
    }

    if (stroke.points.length === 1 && (!predictedPoints || predictedPoints.length === 0)) {
      const pt = stroke.points[0];
      const r = ((pt.width || stroke.baseThickness) * zoom) / 2;
      ctx.beginPath();
      ctx.arc(pt.x * zoom, pt.y * zoom, Math.max(1, r), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    // Combine real points and any forward-predicted points for live rendering
    const pts = predictedPoints && predictedPoints.length > 0
      ? stroke.points.concat(predictedPoints)
      : stroke.points;

    const p0 = pts[0];
    // Set lineWidth once per path rather than mutating canvas state in a loop
    ctx.lineWidth = Math.max(1, (p0.width || stroke.baseThickness) * zoom);

    if (pts.length === 2) {
      const p1 = pts[1];
      ctx.beginPath();
      ctx.moveTo(p0.x * zoom, p0.y * zoom);
      ctx.lineTo(p1.x * zoom, p1.y * zoom);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Bezier curve smoothing through midpoints
    ctx.beginPath();
    ctx.moveTo(p0.x * zoom, p0.y * zoom);

    for (let i = 1; i < pts.length - 1; i++) {
      const curr = pts[i];
      const next = pts[i + 1];
      const midX = ((curr.x + next.x) / 2) * zoom;
      const midY = ((curr.y + next.y) / 2) * zoom;

      ctx.quadraticCurveTo(curr.x * zoom, curr.y * zoom, midX, midY);
    }

    const last = pts[pts.length - 1];
    const secondLast = pts[pts.length - 2];
    ctx.quadraticCurveTo(
      secondLast.x * zoom,
      secondLast.y * zoom,
      last.x * zoom,
      last.y * zoom
    );

    ctx.stroke();
    ctx.restore();
  }

  /**
   * Renders a list of strokes onto a 2D canvas context with quadratic Bezier smoothing.
   */
  static renderStrokes(
    ctx: CanvasRenderingContext2D,
    strokes: Stroke[],
    zoom: number
  ) {
    if (!strokes || strokes.length === 0) return;
    for (const stroke of strokes) {
      StylusEngine.renderSingleStroke(ctx, stroke, zoom);
    }
  }
}
