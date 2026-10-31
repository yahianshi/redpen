# Classroom Stylus - In-Page PDF Grading Canvas for Google Classroom

A complete, production-ready **Manifest V3** Chromium browser extension (specifically optimized for **Brave** and **Chrome**) that injects an in-page stylus grading canvas directly into Google Classroom's submission grading interface (`https://classroom.google.com/c/*/a/*/submissions/*`).

---

## ✨ Features & Architectural Highlights

### 1. SPA Routing & Seamless Native Classroom DOM Injection
- **SPA Change Detection**: Google Classroom is a Single Page Application. As teachers navigate between students (using the top switcher dropdown or `<` `>` arrows) or switch attachments in the right sidebar, the extension automatically detects changes using monkey-patched `pushState`/`replaceState`, `popstate`, and a `MutationObserver`.
- **Preserved Native UI**: Keeps Classroom's left navigation sidebar, top sub-header (`Student switcher`, `Return` button), and right grading sidebar (`Grade (/42)`, `Private comments`, `Comment bank`) completely untouched and fully interactive.
- **Center Dark Header Injection**: In Classroom's dark header bar (`#202124`), directly next to the native `"Edit with"` button, injects a matching dark-mode pill button: `"✏️ Grade with Stylus"`.
- **Dark-Mode Grading Toolbar**: When active, transforms the center of the dark header bar into a compact dark-mode toolbar (`#2d2e30` pills, `#e8eaed` text/icons, `#8ab4f8` Google Blue active accents):
  - **Pen**: Color dots (Red `#ef4444` grading default, Green `#22c55e`, Blue `#3b82f6`, Black `#000000`) and 3 thickness presets (Fine `2px`, Med `4px`, Thick `8px`).
  - **Highlighter**: Yellow `#facc15` and Green `#4ade80` with semi-transparent multiply blending (`opacity: 0.35`).
  - **Stroke Eraser**: Stroke-level eraser using point-to-segment distance collision math. Touching any stroke drawn in the current session immediately deletes the entire stroke.
  - **Undo / Redo**: Keyboard shortcuts (`Ctrl+Z`, `Ctrl+Y` / `Cmd+Z`, `Cmd+Shift+Z`) and icon buttons.
  - **Palm Rejection Guard**: Toggle between `"Stylus Only"` (strict pen mode, rejects finger/palm touches) and `"Stylus + Mouse"`.
  - **"↺ Reset to Original"**: One-click restore button with confirmation modal that reverts the Google Drive file to the student's initial clean unannotated upload.
  - **Sync Status Pill**: Subtle indicator showing `"✓ Saved"`, `"Syncing..."` (pulsing amber spinner), `"Unsaved"`, or `"⚠️ Sync error"`.

### 2. Layered Google Drive `fileId` Extraction
- **Layer 1 (Preview Iframe & DOM)**: Parses embedded Drive iframe URLs (`/file/d/{fileId}`, `?id={fileId}`) and DOM data attributes (`[data-drive-id]`, `[data-id]`).
- **Layer 2 (Google Classroom API Fallback)**: Automatically parses URL route `/c/{courseId}/a/{courseWorkId}/submissions/.../student/{studentSubId}` and calls `courses.courseWork.studentSubmissions.get` to resolve `driveFile.id`.
- **Layer 3 (Performance Timing)**: Scans recent network performance resources for Drive file identifiers.

### 3. High-Performance Stylus Engine (PointerEvents API)
- Continuous vertical PDF page rendering via `PDF.js` (`pdfjs-dist`) inside the center dark `#171717` container.
- Stacked HTML5 `<canvas>` annotation overlays positioned above each page.
- Coalesced Pointer Events (`e.getCoalescedEvents()`) for high-refresh rate styluses (120Hz-240Hz on Apple Pencil, Surface Pen, USI Chromebook styluses).
- Dynamic line weighting calculated from `e.pressure`.
- Quadratic Bezier midpoint curve smoothing for handwriting without jitter.
- Coordinates recorded in unscaled PDF points so zooming in or out never distorts or moves strokes.
- Floating bottom dark pill (`Page X / Y | - 🔍 +` | `Fit Width`).

### 4. Session Cache, Autosave Flattening & "Restore Original" Architecture
- **Clean Base PDF Caching**: When a PDF is opened, downloads raw PDF bytes via `GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media` and caches `cleanBasePdfBytes` in IndexedDB (`pdfStylusGradingDB`).
- **Original Revision Pinning**: Calls `GET https://www.googleapis.com/drive/v3/files/{fileId}/revisions`, identifies `revisions[0].id` (the student's original submission), and marks `keepForever: true` so Google Drive never auto-purges it.
- **Debounced Autosave (2.5 seconds)**: When the teacher stops writing for 2.5s, the background flattener:
  1. Loads a fresh clone of `cleanBasePdfBytes` into `pdf-lib`.
  2. Bakes the active `sessionStrokes` onto the `pdf-lib` pages as clean vector lines with round caps (`LineCapStyle.Round`).
  3. Uploads the flattened PDF in-place via `PATCH https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=media`.
  Because flattening always bakes onto `cleanBasePdfBytes` rather than re-baking over previous exports, erasing a stroke in the session cleanly removes it from the saved Google Drive file!
- **"↺ Reset to Original"**: Clears session strokes, uploads the clean base PDF (or `revisions[0]`) via `PATCH`, and refreshes the canvas immediately.

### 5. Brave Browser OAuth2 Compatibility
- Standard extensions rely on Chrome's proprietary `chrome.identity.getAuthToken`, which fails in Brave due to blocked Google profile sync.
- This extension uses `chrome.identity.launchWebAuthFlow` with standard OAuth 2.0 Web/Chrome App flow.
- Scopes:
  - `https://www.googleapis.com/auth/drive`
  - `https://www.googleapis.com/auth/classroom.coursework.students.readonly`
- Automatically caches tokens in `chrome.storage.local` with renewal buffer.

---

## 🛠️ Build & Installation Instructions

### Prerequisites
- Node.js (v18+) and npm.

### 1. Build the Extension
```bash
npm install
npm run build
```
This produces the complete unpacked extension inside the `dist/` directory:
- `dist/manifest.json` (Manifest V3)
- `dist/content_script.js` (Self-contained bundled with `pdf-lib` and `pdfjs-dist`)
- `dist/background.js` (Service worker)
- `dist/styles.css` (Classroom dark theme styling)
- `dist/popup.html`, `dist/options.html`
- `dist/pdf.worker.min.mjs`
- `dist/icons/`

To run the automated verification test suite:
```bash
npm test
```

### 2. Load Unpacked in Brave or Chrome

#### For Brave:
1. Open Brave and navigate to `brave://extensions`.
2. Toggle on **Developer mode** in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the `/home/bl33d/Desktop/extention/dist` directory.

#### For Chrome:
1. Open Chrome and navigate to `chrome://extensions`.
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `/home/bl33d/Desktop/extention/dist` directory.

---

## 🔑 60-Second Google Cloud OAuth Setup

1. Click the **Classroom Stylus** extension icon in your browser toolbar to open the popup.
2. Click the **Copy** button next to **Extension Redirect URI** (e.g., `https://<extension-id>.chromiumapp.org/oauth2`).
3. Open [Google Cloud Console](https://console.cloud.google.com/apis/dashboard):
   - Under **APIs & Services > Library**, enable:
     - **Google Drive API**
     - **Google Classroom API**
   - Under **APIs & Services > Credentials**:
     - Click **Create Credentials > OAuth client ID**.
     - Choose **Web application**.
     - Under **Authorized redirect URIs**, click **Add URI** and paste the copied extension redirect URI.
     - Click **Create** and copy your **Client ID**.
4. In the extension popup or Options page, paste your Client ID into the **Google Cloud OAuth Client ID** field and click **Connect with Google**.
5. Select your Google account and grant permissions. The badge will turn green: **Authorized ✓**.

---

## 📝 Grading in Google Classroom

1. Navigate to any Google Classroom assignment grading page:
   `https://classroom.google.com/c/.../a/.../submissions/...`
2. In the dark header bar above the student's PDF, click `"✏️ Grade with Stylus"`.
3. The custom grading canvas opens immediately:
   - Select **Pen** or **Highlighter**.
   - Choose a grading color (Red, Green, Blue, Black).
   - Draw annotations using your stylus or mouse. Dynamic pressure sensitivity adjusts line thickness.
   - Use the **Eraser** to delete any session stroke with a single tap.
   - Use `Ctrl+Z` / `Ctrl+Y` to Undo and Redo.
4. As you grade, the autosave debouncer flattens strokes and updates Google Drive automatically (`✓ Saved`).
5. Switching students (via top dropdown or `<` `>` arrows) seamlessly saves pending edits and loads the next submission.
6. Click `"↺ Reset Original"` at any time to discard all annotations and revert to the student's initial upload.
