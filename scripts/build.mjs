import { build } from 'vite';
import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const DIST_DIR = path.resolve(ROOT_DIR, 'dist');

async function runBuild() {
  console.log('🚀 Starting RedPen Classroom Extension Build...');

  // Ensure clean dist directory
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 1. Build Content Script (IIFE for isolated execution in webpage)
  console.log('📦 Building content script...');
  await build({
    configFile: false,
    build: {
      outDir: DIST_DIR,
      emptyOutDir: false,
      target: 'es2022',
      lib: {
        entry: path.resolve(ROOT_DIR, 'src/content/content_script.ts'),
        name: 'ClassroomStylusContent',
        formats: ['iife'],
        fileName: () => 'content_script.js',
      },
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.url': '""',
      },
    },
  });

  // 2. Build Background Service Worker (ESM format supported by Chrome MV3)
  console.log('📦 Building background service worker...');
  await build({
    configFile: false,
    build: {
      outDir: DIST_DIR,
      emptyOutDir: false,
      target: 'es2022',
      lib: {
        entry: path.resolve(ROOT_DIR, 'src/background/background.ts'),
        formats: ['es'],
        fileName: () => 'background.js',
      },
      define: {
        'process.env.NODE_ENV': '"production"',
      },
    },
  });

  // 3. Build Popup & Options HTML pages
  console.log('📦 Building popup and options pages...');
  await build({
    configFile: false,
    base: '',
    build: {
      outDir: DIST_DIR,
      emptyOutDir: false,
      target: 'es2022',
      rollupOptions: {
        input: {
          popup: path.resolve(ROOT_DIR, 'src/popup/popup.html'),
          options: path.resolve(ROOT_DIR, 'src/options/options.html'),
          annotator: path.resolve(ROOT_DIR, 'src/annotator/annotator.html'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: '[name].[ext]',
        },
      },
    },
  });

  // Move popup.html, options.html, and annotator.html to root of dist if nested
  const nestedPopup = path.resolve(DIST_DIR, 'src/popup/popup.html');
  const targetPopup = path.resolve(DIST_DIR, 'popup.html');
  if (fs.existsSync(nestedPopup)) {
    fs.renameSync(nestedPopup, targetPopup);
    let popupHtml = fs.readFileSync(targetPopup, 'utf-8');
    popupHtml = popupHtml.replaceAll('../../', './');
    fs.writeFileSync(targetPopup, popupHtml);
  }

  const nestedOptions = path.resolve(DIST_DIR, 'src/options/options.html');
  const targetOptions = path.resolve(DIST_DIR, 'options.html');
  if (fs.existsSync(nestedOptions)) {
    fs.renameSync(nestedOptions, targetOptions);
    let optionsHtml = fs.readFileSync(targetOptions, 'utf-8');
    optionsHtml = optionsHtml.replaceAll('../../', './');
    fs.writeFileSync(targetOptions, optionsHtml);
  }

  const nestedAnnotator = path.resolve(DIST_DIR, 'src/annotator/annotator.html');
  const targetAnnotator = path.resolve(DIST_DIR, 'annotator.html');
  if (fs.existsSync(nestedAnnotator)) {
    fs.renameSync(nestedAnnotator, targetAnnotator);
    let annotatorHtml = fs.readFileSync(targetAnnotator, 'utf-8');
    annotatorHtml = annotatorHtml.replaceAll('../../', './').replaceAll('../content/', './');
    fs.writeFileSync(targetAnnotator, annotatorHtml);
  }

  // Remove empty src directory in dist if any
  const distSrc = path.resolve(DIST_DIR, 'src');
  if (fs.existsSync(distSrc)) {
    fs.rmSync(distSrc, { recursive: true, force: true });
  }

  // 4. Copy CSS
  console.log('📋 Copying stylesheets and assets...');
  fs.copyFileSync(
    path.resolve(ROOT_DIR, 'src/content/styles.css'),
    path.resolve(DIST_DIR, 'styles.css')
  );

  // 5. Copy manifest.json
  fs.copyFileSync(
    path.resolve(ROOT_DIR, 'manifest.json'),
    path.resolve(DIST_DIR, 'manifest.json')
  );

  // 6. Copy public assets (icons and pdf.worker.min.mjs)
  const publicDir = path.resolve(ROOT_DIR, 'public');
  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, DIST_DIR, { recursive: true });
  }

  console.log('✅ Extension build completed successfully! Output in ./dist');
}

runBuild().catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
