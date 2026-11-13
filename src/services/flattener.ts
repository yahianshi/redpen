import { PDFDocument, rgb, LineCapStyle, RGB, degrees } from 'pdf-lib';
import { PageStrokesMap, Stroke, StrokePoint } from '../types';

/**
 * Maps rendered screen/canvas display coordinates to pdf-lib internal page coordinates,
 * taking into account the page's current rotation angle (0°, 90°, 180°, 270°).
 */
function mapDisplayToPdf(
  x: number,
  y: number,
  rotation: number,
  pageWidth: number,
  pageHeight: number
): { x: number; y: number } {
  if (rotation === 90) {
    return { x: y, y: x };
  } else if (rotation === 180) {
    return { x: pageWidth - x, y: y };
  } else if (rotation === 270) {
    return { x: pageWidth - y, y: pageHeight - x };
  }
  return { x: x, y: pageHeight - y };
}

/**
 * Parses hex color strings (e.g. "#ef4444" or "#f00") or "rgb(...)" into a pdf-lib RGB color object.
 */
function parseColor(colorStr: string): RGB {
  let r = 0, g = 0, b = 0;

  if (colorStr.startsWith('#')) {
    let hex = colorStr.slice(1);
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16) / 255;
      g = parseInt(hex.slice(2, 4), 16) / 255;
      b = parseInt(hex.slice(4, 6), 16) / 255;
    }
  } else if (colorStr.startsWith('rgb')) {
    const match = colorStr.match(/\d+/g);
    if (match && match.length >= 3) {
      r = parseInt(match[0], 10) / 255;
      g = parseInt(match[1], 10) / 255;
      b = parseInt(match[2], 10) / 255;
    }
  }

  return rgb(
    Math.min(1, Math.max(0, r)),
    Math.min(1, Math.max(0, g)),
    Math.min(1, Math.max(0, b))
  );
}

export class PdfFlattener {
  /**
   * Bakes current session strokes onto a fresh clone of cleanBasePdfBytes.
   * This non-compounding approach ensures that deleted/erased strokes are
   * completely removed without artifacts or accumulating file size.
   */
  static async flattenStrokes(
    cleanBasePdfBytes: ArrayBuffer,
    pageStrokes: PageStrokesMap
  ): Promise<Uint8Array> {
    // Clone clean base PDF
    const pdfDoc = await PDFDocument.load(cleanBasePdfBytes.slice(0), {
      ignoreEncryption: true,
    });

    const pageCount = pdfDoc.getPageCount();

    // Iterate through pages that have annotations
    for (const [pageIdxStr, strokes] of Object.entries(pageStrokes)) {
      const pageIndex = parseInt(pageIdxStr, 10);
      if (pageIndex < 0 || pageIndex >= pageCount || !strokes || strokes.length === 0) {
        continue;
      }

      const page = pdfDoc.getPage(pageIndex);
      const { width: pageWidth, height: pageHeight } = page.getSize();
      const rotation = (page.getRotation().angle || 0) % 360;

      for (const stroke of strokes) {
        if (!stroke.points || stroke.points.length === 0) continue;

        const color = parseColor(stroke.color);
        const opacity = stroke.tool === 'highlighter' ? 0.35 : (stroke.opacity ?? 1.0);

        if (stroke.tool === 'text' && stroke.text) {
          const pt = stroke.points[0];
          const fontSize = stroke.fontSize || 16;
          const lines = stroke.text.split('\n');
          const textRotation = (360 - rotation) % 360;

          lines.forEach((line: string, lIdx: number) => {
            const dispX = pt.x;
            const dispY = pt.y + (lIdx + 1) * fontSize * 1.15;
            const pdfPt = mapDisplayToPdf(dispX, dispY, rotation, pageWidth, pageHeight);
            page.drawText(line, {
              x: pdfPt.x,
              y: pdfPt.y,
              size: fontSize,
              color,
              opacity,
              rotate: degrees(textRotation),
            });
          });
          continue;
        }

        if (stroke.points.length === 1) {
          // Single dot
          const pt = stroke.points[0];
          const radius = Math.max(1, (pt.width || stroke.baseThickness) / 2);
          const pdfPt = mapDisplayToPdf(pt.x, pt.y, rotation, pageWidth, pageHeight);
          page.drawCircle({
            x: pdfPt.x,
            y: pdfPt.y,
            size: radius,
            color,
            opacity,
          });
          continue;
        }

        // Draw line segments between smoothed points
        for (let i = 0; i < stroke.points.length - 1; i++) {
          const p1 = stroke.points[i];
          const p2 = stroke.points[i + 1];

          const segThickness = Math.max(0.5, (p1.width + p2.width) / 2 || stroke.baseThickness);
          const pdfP1 = mapDisplayToPdf(p1.x, p1.y, rotation, pageWidth, pageHeight);
          const pdfP2 = mapDisplayToPdf(p2.x, p2.y, rotation, pageWidth, pageHeight);

          page.drawLine({
            start: pdfP1,
            end: pdfP2,
            thickness: segThickness,
            color,
            opacity,
            lineCap: LineCapStyle.Round,
          });
        }
      }
    }

    return await pdfDoc.save();
  }

  /**
   * Modifies the underlying PDF by rotating the specified page by deltaDegrees (default +90° clockwise).
   * Modifies the PDF dictionary so the page is permanently edited and rotated when viewed or downloaded.
   */
  static async rotatePage(
    pdfBytes: ArrayBuffer,
    pageIndex: number,
    deltaDegrees: number = 90
  ): Promise<ArrayBuffer> {
    const pdfDoc = await PDFDocument.load(pdfBytes.slice(0), {
      ignoreEncryption: true,
    });
    const pageCount = pdfDoc.getPageCount();
    if (pageIndex < 0 || pageIndex >= pageCount) {
      throw new Error(`Page index ${pageIndex} is out of bounds (total pages: ${pageCount})`);
    }
    const page = pdfDoc.getPage(pageIndex);
    const currentRot = page.getRotation().angle || 0;
    const newRot = (currentRot + deltaDegrees + 360) % 360;
    page.setRotation(degrees(newRot));
    const saved = await pdfDoc.save();
    return saved.buffer as ArrayBuffer;
  }
}
