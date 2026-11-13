import { PDFDocument } from 'pdf-lib';
import { PdfFlattener } from '../src/services/flattener';
import { StylusEngine } from '../src/engine/stylus';
import { decodeClassroomParam } from '../src/content/detector';
import { Stroke, StrokePoint } from '../src/types';

async function runTestSuite() {
  console.log('🧪 Starting RedPen Classroom Verification Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName}`);
      failed++;
    }
  }

  // --- Test 1: PDF Flattener & Non-Compounding Flattening ---
  console.log('--- Suite 1: PDF Flattener & Non-Compounding Flattening ---');
  try {
    const baseDoc = await PDFDocument.create();
    const page = baseDoc.addPage([600, 800]);
    const cleanBytes = (await baseDoc.save()).buffer;

    const stroke1: Stroke = {
      id: 's1',
      tool: 'pen',
      color: '#ef4444',
      baseThickness: 3,
      opacity: 1.0,
      points: [
        { x: 100, y: 100, pressure: 0.8, width: 3.5 },
        { x: 150, y: 150, pressure: 0.9, width: 4.0 },
      ],
      bbox: { minX: 100, minY: 100, maxX: 150, maxY: 150 },
      timestamp: Date.now(),
    };

    const stroke2: Stroke = {
      id: 's2',
      tool: 'highlighter',
      color: '#facc15',
      baseThickness: 16,
      opacity: 0.35,
      points: [
        { x: 200, y: 200, pressure: 0.5, width: 16 },
        { x: 300, y: 200, pressure: 0.5, width: 16 },
      ],
      bbox: { minX: 200, minY: 200, maxX: 300, maxY: 200 },
      timestamp: Date.now(),
    };

    // Flatten page with 2 strokes
    const flattened1 = await PdfFlattener.flattenStrokes(cleanBytes, { 0: [stroke1, stroke2] });
    assert(flattened1.length > cleanBytes.byteLength, 'Flattened PDF with 2 strokes is larger than base PDF');

    // Simulate erasing stroke1: flatten with only stroke2
    const flattened2 = await PdfFlattener.flattenStrokes(cleanBytes, { 0: [stroke2] });
    assert(flattened2.length > 0, 'Flattened PDF without erased stroke produced valid PDF');
    assert(flattened2.length < flattened1.length, 'Non-compounding: erasing stroke reduces flattened PDF size');

    // Dot stroke test
    const dotStroke: Stroke = {
      id: 's3',
      tool: 'pen',
      color: '#22c55e',
      baseThickness: 4,
      opacity: 1.0,
      points: [{ x: 50, y: 50, pressure: 0.5, width: 4 }],
      bbox: { minX: 50, minY: 50, maxX: 50, maxY: 50 },
      timestamp: Date.now(),
    };
    const flattenedDot = await PdfFlattener.flattenStrokes(cleanBytes, { 0: [dotStroke] });
    assert(flattenedDot.length > 0, 'Single point dot stroke bakes into PDF cleanly');
  } catch (e: any) {
    console.error('Flattener test error:', e);
    failed++;
  }

  // --- Test 2: Stylus Engine & Undo/Redo ---
  console.log('\n--- Suite 2: Stylus Engine & Undo/Redo ---');
  try {
    const engine = new StylusEngine({
      penOnlyMode: true,
      activeTool: 'pen',
      penColor: '#ef4444',
      penThickness: 3,
      highlighterColor: '#facc15',
      highlighterThickness: 16,
    });

    const pageStrokesMap = {
      0: [
        {
          id: 'test_s1',
          tool: 'pen' as const,
          color: '#ef4444',
          baseThickness: 3,
          opacity: 1.0,
          points: [
            { x: 50, y: 50, pressure: 0.5, width: 3 },
            { x: 100, y: 100, pressure: 0.5, width: 3 },
          ],
          bbox: { minX: 50, minY: 50, maxX: 100, maxY: 100 },
          timestamp: Date.now(),
        },
      ],
    };

    assert(engine.getOptions().penOnlyMode === true, 'StylusEngine initialized in penOnlyMode');

    // Test Undo/Redo
    assert(!engine.canUndo(), 'Initially cannot undo');
    // Simulate engine recording a stroke action
    const mockStroke: Stroke = {
      id: 'test_s2',
      tool: 'pen',
      color: '#22c55e',
      baseThickness: 3,
      opacity: 1.0,
      points: [{ x: 10, y: 10, pressure: 0.5, width: 3 }],
      bbox: { minX: 10, minY: 10, maxX: 10, maxY: 10 },
      timestamp: Date.now(),
    };

    // Push action to test undo
    (engine as any).undoStack.push({ type: 'add', pageIndex: 0, stroke: mockStroke });
    pageStrokesMap[0].push(mockStroke);
    assert(engine.canUndo(), 'Can undo after stroke added');

    const undoResult = engine.undo(pageStrokesMap);
    assert(undoResult?.affectedPageIndex === 0, 'Undo returns affected page index');
    assert(pageStrokesMap[0].length === 1, 'Undo removes the added stroke');
    assert(engine.canRedo(), 'Can redo after undo');

    const redoResult = engine.redo(pageStrokesMap);
    assert(redoResult?.affectedPageIndex === 0, 'Redo returns affected page index');
    assert(pageStrokesMap[0].length === 2, 'Redo re-inserts the stroke');
  } catch (e: any) {
    console.error('StylusEngine test error:', e);
    failed++;
  }

  // --- Test 3: Eraser Collision Math ---
  console.log('\n--- Suite 3: Eraser Hit Detection ---');
  try {
    const engine = new StylusEngine({
      penOnlyMode: false,
      activeTool: 'eraser',
      penColor: '#ef4444',
      penThickness: 3,
      highlighterColor: '#facc15',
      highlighterThickness: 16,
    });

    const targetStroke: Stroke = {
      id: 'target',
      tool: 'pen',
      color: '#ef4444',
      baseThickness: 4,
      opacity: 1.0,
      points: [
        { x: 100, y: 100, pressure: 0.5, width: 4 },
        { x: 200, y: 100, pressure: 0.5, width: 4 },
      ],
      bbox: { minX: 98, minY: 98, maxX: 202, maxY: 102 },
      timestamp: Date.now(),
    };

    const strokesList = [targetStroke];

    // Eraser touches middle of segment at (150, 102) - should hit!
    const hitPt: StrokePoint = { x: 150, y: 102, pressure: 0.5, width: 12 };
    const erased = (engine as any).checkAndErase(hitPt, 0, strokesList, 1.0);
    assert(erased !== undefined, 'Eraser correctly hits stroke within collision threshold');
    assert(strokesList.length === 0, 'Erased stroke is removed from strokes array');

    // Point far away at (500, 500) - should NOT hit
    const nonHitPt: StrokePoint = { x: 500, y: 500, pressure: 0.5, width: 12 };
    const strokesList2 = [targetStroke];
    const notErased = (engine as any).checkAndErase(nonHitPt, 0, strokesList2, 1.0);
    assert(notErased === undefined, 'Eraser ignores point far from stroke');
    assert(strokesList2.length === 1, 'Stroke remains untouched');
  } catch (e: any) {
    console.error('Eraser test error:', e);
    failed++;
  }

  // --- Test 4: URL Regex & Classroom Context Extraction ---
  console.log('\n--- Suite 4: SPA URL Parsing & Drive File ID Regex ---');
  try {
    const url = 'https://classroom.google.com/c/ODg3ODAxOTc2ODI1/a/ODk1NjIxNjc1MjI2/submissions/by-status/and-sort-first-name/student/NDQ2NzU2ODMwNzY2/m/ODk1NjE5MTI4ODI3';
    
    const urlRegex = /\/c\/([^/]+)\/a\/([^/]+)\/submissions\/(?:[^/]+\/)+student\/([^/?#]+)/;
    const match = url.match(urlRegex);
    assert(match !== null, 'Submission URL pattern matched successfully');
    assert(match![1] === 'ODg3ODAxOTc2ODI1', 'courseId correctly parsed: ' + match![1]);
    assert(match![2] === 'ODk1NjIxNjc1MjI2', 'courseWorkId correctly parsed: ' + match![2]);
    assert(match![3] === 'NDQ2NzU2ODMwNzY2', 'studentSubId correctly parsed: ' + match![3]);

    assert(decodeClassroomParam(match![1]) === '887801976825', 'courseId decoded to numeric ID: ' + decodeClassroomParam(match![1]));
    assert(decodeClassroomParam(match![2]) === '895621675226', 'courseWorkId decoded to numeric ID: ' + decodeClassroomParam(match![2]));
    assert(decodeClassroomParam(match![3]) === '446756830766', 'studentSubId decoded to numeric ID: ' + decodeClassroomParam(match![3]));

    // Test Drive file ID extraction from various Google preview formats
    const iframeSrc1 = 'https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/preview';
    const m1 = iframeSrc1.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
    assert(m1 !== null && m1[1] === '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', 'Extracted fileId from /file/d/ iframe src');

    const iframeSrc2 = 'https://docs.google.com/viewer?id=1AbC_dEfG-1234567890abcdefghijk&embedded=true';
    const m2 = iframeSrc2.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    assert(m2 !== null && m2[1] === '1AbC_dEfG-1234567890abcdefghijk', 'Extracted fileId from ?id= query param');

    const iframeSrc3 = 'https://drive.google.com/viewerng/viewer?authuser=0&docid=1Zyx_WVUTSRQPONMLKJIHGFEDCBA';
    const m3 = iframeSrc3.match(/[?&](?:docid|fileid|docId|fileId)=([a-zA-Z0-9_-]{20,})/i);
    assert(m3 !== null && m3[1] === '1Zyx_WVUTSRQPONMLKJIHGFEDCBA', 'Extracted fileId from docid= query param');

    const iframeSrc4 = 'https://drive.google.com/open?id=1SampleDriveFileIdLongEnough12345';
    const m4 = iframeSrc4.match(/\/(?:open|preview)\?id=([a-zA-Z0-9_-]{20,})/i);
    assert(m4 !== null && m4[1] === '1SampleDriveFileIdLongEnough12345', 'Extracted fileId from open?id= param');

    // Test filename extraction with trailing space before extension
    const rawName = 'math quiz 4 .pdf';
    const fnMatch = rawName.match(/([a-zA-Z0-9_\- ]+?\s*\.pdf)/i);
    assert(fnMatch !== null && fnMatch[1].trim() === 'math quiz 4 .pdf', 'Matched student filename with spacing before .pdf');
    const baseClean = fnMatch![1].replace(/\s*\.pdf$/i, '').trim();
    assert(baseClean === 'math quiz 4', 'Base filename extracted cleanly: ' + baseClean);

    // Test student submission URL filter (only show on active student submissions with pdf)
    const validStudentSubUrl = 'https://classroom.google.com/c/ODg3ODAxOTc2ODI1/a/ODk1NjIxNjc1MjI2/submissions/by-status/and-sort-first-name/student/ODc1MzIxNTk0NTM5/m/ODk1NjIyNTI3NzQ0';
    const subPattern = /\/c\/[^/]+\/a\/[^/]+\/submissions\/(?:[^/]+\/)*student\/[^/?#]+/i;
    assert(subPattern.test(validStudentSubUrl) === true, 'Eligible student submission URL correctly matched');

    const streamUrl = 'https://classroom.google.com/c/ODg3ODAxOTc2ODI1';
    assert(subPattern.test(streamUrl) === false, 'Course root URL correctly rejected from showing button');

    const allSubmissionsUrl = 'https://classroom.google.com/c/ODg3ODAxOTc2ODI1/a/ODk1NjIxNjc1MjI2/submissions/by-status';
    assert(subPattern.test(allSubmissionsUrl) === false, 'Ungraded submissions overview correctly rejected without active student');
  } catch (e: any) {
    console.error('URL parsing test error:', e);
    failed++;
  }

  // --- Test 5: Keyboard Shortcuts & Event Isolation ---
  console.log('\n--- Suite 5: Keydown Listener Isolation & Repeat Suppression ---');
  try {
    // Setup minimal DOM mock
    const listeners: { [evt: string]: Function[] } = { keydown: [], click: [] };
    const winMock: any = {
      addEventListener: (type: string, fn: Function) => {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      removeEventListener: (type: string, fn: Function) => {
        if (listeners[type]) {
          listeners[type] = listeners[type].filter((f) => f !== fn);
        }
      },
    };
    const mockContainer: any = {
      isConnected: true,
      className: '',
      innerHTML: '',
      parentNode: null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      contains: () => false,
    };
    const docMock: any = {
      activeElement: null,
      createElement: () => ({ ...mockContainer }),
      addEventListener: (type: string, fn: Function) => {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      removeEventListener: (type: string, fn: Function) => {
        if (listeners[type]) {
          listeners[type] = listeners[type].filter((f) => f !== fn);
        }
      },
      body: { appendChild: () => {}, removeChild: () => {} },
    };

    (global as any).window = winMock;
    (global as any).document = docMock;

    const { GradingToolbar } = await import('../src/ui/toolbar');

    let undoCount = 0;
    let redoCount = 0;
    let nextCount = 0;

    const tb = new GradingToolbar({
      onToolSelect: () => {},
      onPenColorChange: () => {},
      onPenThicknessChange: () => {},
      onHighlighterColorChange: () => {},
      onUndo: () => { undoCount++; },
      onRedo: () => { redoCount++; },
      onTogglePenOnly: () => {},
      onRestoreOriginal: () => {},
      onClose: () => {},
      onNextPage: () => { nextCount++; },
      onPrevPage: () => {},
    });

    // Verify key listener was registered
    assert(listeners['keydown'].length === 1, 'Keydown listener registered on window');

    // Simulate single Ctrl+Z
    let prevented = false;
    let stopped = false;
    const makeKeyEvent = (key: string, ctrl: boolean, repeat: boolean) => ({
      key,
      ctrlKey: ctrl,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      repeat,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
      stopImmediatePropagation: () => { stopped = true; },
    });

    // Test 1: Single Ctrl+Z triggers undo once and stops propagation
    listeners['keydown'][0](makeKeyEvent('z', true, false));
    assert(undoCount === 1, 'Single Ctrl+Z fires onUndo exactly once');
    assert(prevented === true, 'Ctrl+Z calls preventDefault');
    assert(stopped === true, 'Ctrl+Z calls stopPropagation to protect Classroom');

    // Test 2: Key repeat (holding Ctrl+Z) does NOT fire multiple undos
    prevented = false;
    stopped = false;
    listeners['keydown'][0](makeKeyEvent('z', true, true)); // repeat: true
    assert(undoCount === 1, 'Holding Ctrl+Z with e.repeat=true does not trigger extra undos');

    // Test 3: ArrowRight stops propagation so Classroom does not scroll
    stopped = false;
    listeners['keydown'][0](makeKeyEvent('ArrowRight', false, false));
    assert(nextCount === 1, 'ArrowRight triggers onNextPage');
    assert(stopped === true, 'ArrowRight stops propagation to prevent Google Classroom page scrolling');

    // Test 4: tb.destroy() cleans up listeners cleanly
    tb.destroy();
    assert(listeners['keydown'].length === 0, 'tb.destroy() unregisters keydown listener from window');

    // Simulate key after destroy
    listeners['keydown'].forEach((fn) => fn(makeKeyEvent('z', true, false)));
    assert(undoCount === 1, 'No undos triggered after toolbar destroy');
  } catch (e: any) {
    console.error('Toolbar keydown test error:', e);
    failed++;
  }

  // --- Test 6: Permanent PDF Page Rotation & Flattening on Rotated Pages ---
  console.log('\n--- Suite 6: PDF Page Rotation & Flattening ---');
  try {
    const baseDoc = await PDFDocument.create();
    baseDoc.addPage([600, 800]); // Page 0
    baseDoc.addPage([600, 800]); // Page 1
    const baseBytes = (await baseDoc.save()).buffer;

    // Test 1: rotatePage rotates page 0 by 90 degrees
    const rot90Bytes = await PdfFlattener.rotatePage(baseBytes, 0, 90);
    const docRot90 = await PDFDocument.load(rot90Bytes);
    assert(docRot90.getPage(0).getRotation().angle === 90, 'Page 0 successfully rotated to 90 degrees in PDF file');
    assert(docRot90.getPage(1).getRotation().angle === 0, 'Page 1 remains at 0 degrees');

    // Test 2: rotatePage by another 90 degrees reaches 180 degrees
    const rot180Bytes = await PdfFlattener.rotatePage(rot90Bytes, 0, 90);
    const docRot180 = await PDFDocument.load(rot180Bytes);
    assert(docRot180.getPage(0).getRotation().angle === 180, 'Page 0 rotated to 180 degrees in PDF file');

    // Test 3: rotatePage completes full 360 cycle back to 0 degrees
    const rot360Bytes = await PdfFlattener.rotatePage(rot180Bytes, 0, 180);
    const docRot360 = await PDFDocument.load(rot360Bytes);
    assert(docRot360.getPage(0).getRotation().angle === 0, 'Page 0 rotated back to 0 degrees (360 mod 360)');

    // Test 4: Flatten strokes onto rotated page (rot = 90)
    const testStroke: Stroke = {
      id: 'rot_stroke_1',
      tool: 'pen',
      color: '#f0393c',
      baseThickness: 4,
      opacity: 1.0,
      points: [
        { x: 100, y: 150, pressure: 0.5, width: 4 },
        { x: 200, y: 250, pressure: 0.5, width: 4 },
      ],
      bbox: { minX: 100, minY: 150, maxX: 200, maxY: 250 },
      timestamp: Date.now(),
    };

    const textStroke: Stroke = {
      id: 'rot_stroke_text',
      tool: 'text',
      color: '#3b82f6',
      baseThickness: 2,
      text: 'Good job!',
      fontSize: 18,
      points: [{ x: 120, y: 180, pressure: 0.5, width: 2 }],
      bbox: { minX: 120, minY: 180, maxX: 220, maxY: 200 },
      timestamp: Date.now(),
    };

    const flattenedRotated = await PdfFlattener.flattenStrokes(rot90Bytes, {
      0: [testStroke, textStroke],
    });
    assert(flattenedRotated.length > rot90Bytes.byteLength, 'Strokes and text flattened cleanly onto 90° rotated PDF');

    const verifiedDoc = await PDFDocument.load(flattenedRotated);
    assert(verifiedDoc.getPage(0).getRotation().angle === 90, 'Flattened output PDF preserves page 90° rotation permanently');
  } catch (e: any) {
    console.error('Page rotation test error:', e);
    failed++;
  }

  console.log(`\n========================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) process.exit(1);
}

runTestSuite();
