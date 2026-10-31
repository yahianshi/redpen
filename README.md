# RedPen Classroom - In-Page PDF Grading for Google Classroom

<p align="center">
  <img src="public/icons/logo-max.png" alt="RedPen Classroom Logo" width="180" style="border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);" />
</p>

<p align="center">
  <strong>Fast, fluid, native stylus PDF grading directly inside Google Classroom with zero third-party servers.</strong><br />
  Autosaves flattened PDFs in-place to Google Drive. Built for Brave and Chrome (Manifest V3).
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-f0393c.svg" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Platform-Brave%20%7C%20Chrome-13181c.svg" alt="Platforms" />
  <img src="https://img.shields.io/badge/Tests-32%20Passing-81c995.svg" alt="Tests" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" />
</p>

---

## 🚀 Why RedPen?

Grading student PDF assignments in Google Classroom typically requires third-party web apps (Lumin, Kami, etc.) that demand external accounts, cloud storage syncing, or slow multi-window flows.

**RedPen Classroom** eliminates this friction by injecting an ultra-low-latency vector grading canvas **directly inside Google Classroom's grading interface** (`https://classroom.google.com/c/*/a/*/submissions/*`).

- 🎯 **In-Place Grading**: Click **"✏️ Grade with RedPen"** on the student's submission card or header. Grade without ever leaving Classroom.
- ⚡ **Zero External Servers**: RedPen runs 100% locally in your browser. All API calls communicate directly with Google Drive and Classroom using your own OAuth credentials.
- 🖊️ **Stylus & Pressure Sensitivity**: 120Hz-240Hz pointer coalescing, pressure-sensitive line weighting, and palm rejection for Apple Pencil, Surface Pen, and USI Chromebook styluses.
- 🛡️ **Non-Compounding Vector Baking**: Flattening uses `pdf-lib` to bake annotations onto a clean cached base. Erasing a stroke removes it from the Drive PDF without degrading document quality.
- ↺ **One-Click Original Restore**: Google Drive's initial revision is pinned (`keepForever: true`). Revert to the student's unannotated original upload at any time.

---

## 🎨 Toolset & UI

RedPen follows a minimalist dark interface (`#13181c`) with signature red accents (`#f0393c`):

| Tool | Default Color Palette | Description |
| :--- | :--- | :--- |
| **Pen** | Red (`#f0393c`), Blue (`#3b82f6`), Black (`#000000`) | Smooth Bezier handwriting with pressure sensitivity. Thickness configurable via `⚙️`. |
| **Highlighter** | Yellow (`#facc15`), Purple (`#c084fc`), Green (`#4ade80`) | Semi-transparent highlight layer with `multiply` blending. |
| **Text** | Red (`#f0393c`), Blue (`#3b82f6`), Black (`#000000`) | Click anywhere to place typed notes. Click existing notes anytime to edit. |
| **Eraser** | — | Stroke-level eraser. Touching any annotation cleanly deletes the entire stroke. |

> **Customization**: Every tool contains strictly 3 active color slots in the toolbar. Click the gear icon (`⚙️`) next to any tool to pick custom hex colors for any slot or adjust sizing with a live preview.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| <kbd>P</kbd> | Activate **Pen** |
| <kbd>H</kbd> | Activate **Highlighter** |
| <kbd>T</kbd> | Activate **Text** tool |
| <kbd>E</kbd> | Activate **Eraser** |
| <kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Cmd</kbd> + <kbd>Z</kbd> | **Undo** last stroke or action |
| <kbd>Ctrl</kbd> + <kbd>Y</kbd> / <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd> | **Redo** undone action |
| <kbd>+</kbd> / <kbd>=</kbd> | Zoom In |
| <kbd>-</kbd> | Zoom Out |
| <kbd>0</kbd> | Reset Zoom (Fit to Screen Width) |
| <kbd>PageDown</kbd> / <kbd>→</kbd> | Jump to Next Page |
| <kbd>PageUp</kbd> / <kbd>←</kbd> | Jump to Previous Page |
| <kbd>↓</kbd> / <kbd>↑</kbd> | Scroll Half-Page Down / Up |

---

## 🛠️ Installation & Setup

### 1. Build from Source
```bash
# Clone the repository
git clone https://github.com/yahianshi/redpen.git
cd redpen

# Install dependencies
npm install

# Run automated tests (32 tests)
npm test

# Build production bundle
npm run build
```
The compiled extension is output to the `./dist` folder.

### 2. Load into Brave or Chrome
1. Open your browser and navigate to:
   - **Brave**: `brave://extensions`
   - **Chrome**: `chrome://extensions`
2. Enable **Developer mode** (toggle in the upper right corner).
3. Click **Load unpacked**.
4. Select the `dist/` directory inside this repository.

---

## 🔑 60-Second Google Cloud Setup

RedPen connects directly to your Google account via OAuth 2.0 Web Application credentials.

1. Click the **RedPen** icon in your browser toolbar to open the setup wizard.
2. **Page 1 (Redirect URI)**: Click **Copy URI** to copy your unique extension redirect URI (e.g. `https://<extension-id>.chromiumapp.org/oauth2`).
3. Click the provided direct link to open the [Google Cloud Console Credentials Page](https://console.cloud.google.com/apis/credentials):
   - Under **Enabled APIs & Services**, ensure **Google Drive API** and **Google Classroom API** are enabled.
   - Click **Create Credentials** → **OAuth client ID**.
   - Application type: **Web application**.
   - Under **Authorized redirect URIs**, paste the URI copied in Step 2.
   - Click **Create** and copy your **Client ID**.
4. **Page 2 (Client ID)**: Paste your Client ID into the RedPen wizard and click **Next**.
5. **Page 3 (Authorize)**: Click **Connect with Google**, choose your Google account, and grant access.

> **Token Expiry**: Your Client ID remains safely saved. When your Google OAuth session expires, RedPen shows a one-click **"🚀 Sign In with Google"** button without requiring setup again.

---

## 🎓 Grading Workflow

1. Open any assignment submission in Google Classroom:
   `https://classroom.google.com/c/.../a/.../submissions/.../student/...`
2. Look for the **"✏️ Grade with RedPen"** button on the right sidebar or header.
3. Write feedback, highlight errors, or type summary notes.
4. RedPen continuously auto-saves in the background (`✓ Saved` sync pill).
5. Switch students using Classroom's native `<` `>` arrows or student dropdown. RedPen will cleanly commit pending changes and load the next student's PDF automatically.

---

## 📁 Project Architecture

```
redpen-classroom/
├── dist/                  # Built extension output (unpacked target)
├── public/
│   ├── icons/             # Clean branded PNG icons (16, 32, 48, 128) & logos
│   └── pdf.worker.min.mjs # Local PDF.js worker for CSP compliance
├── src/
│   ├── annotator/         # Standalone fullscreen grading tab
│   ├── background/        # MV3 service worker & OAuth token manager
│   ├── content/           # Classroom SPA detector, DOM observer & overlay injector
│   ├── engine/            # Stylus engine, Bezier curve smoothing, stroke eraser
│   ├── services/          # Google Drive/Classroom API, storage & PDF flattener
│   ├── ui/                # Canvas viewer (PDF.js + canvas stacks) & responsive toolbar
│   └── types/             # TypeScript interfaces for strokes, context & messages
├── scripts/
│   └── build.mjs          # Vite + Rollup multi-target build pipeline
├── test/
│   └── run_tests.ts       # 32-suite automated verification tests
├── manifest.json          # Chrome Manifest V3 configuration
└── package.json
```

---

## 📄 License

MIT License. Free and open source for teachers and educators everywhere.
