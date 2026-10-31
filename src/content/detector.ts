import { ClassroomContext } from '../types';

export interface DetectorEvents {
  onSubmissionDetected: (ctx: ClassroomContext) => void;
  onSubmissionChanged: (ctx: ClassroomContext) => void;
  onSubmissionClosed: () => void;
}

export function decodeClassroomParam(val?: string): string | undefined {
  if (!val) return undefined;
  // If already purely numeric digits, return as-is
  if (/^\d+$/.test(val)) return val;
  try {
    const decoded = atob(val);
    if (/^\d+$/.test(decoded)) return decoded;
  } catch {
    // If not valid base64 or decoding fails, keep original
  }
  return val;
}

export class ClassroomDetector {
  private lastUrl: string = '';
  private currentContext: ClassroomContext | null = null;
  private observer: MutationObserver | null = null;
  private pollerTimer: any = null;
  private events: DetectorEvents;

  constructor(events: DetectorEvents) {
    this.events = events;
    this.lastUrl = window.location.href;
    this.initUrlListener();
    this.initDomObserver();
    this.initMessageListener();
  }

  private initMessageListener() {
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'CLASSROOM_STYLUS_IFRAME_FILEID' && event.data.fileId) {
        if (this.currentContext && !this.currentContext.fileId) {
          this.currentContext.fileId = event.data.fileId;
          this.events.onSubmissionChanged(this.currentContext);
        }
      }
    });
  }

  isSubmissionUrl(url: string = window.location.href): boolean {
    // Target pattern: https://classroom.google.com/c/*/a/*/submissions/*
    return /\/c\/[^/]+\/a\/[^/]+\/submissions\//.test(url);
  }

  getCurrentContext(): ClassroomContext | null {
    return this.currentContext;
  }

  private initUrlListener() {
    // 1. Monkey-patch pushState & replaceState
    const rawPushState = history.pushState;
    const rawReplaceState = history.replaceState;

    history.pushState = (data: any, unused: string, url?: string | URL | null) => {
      rawPushState.call(history, data, unused, url);
      this.checkUrlChange();
    };

    history.replaceState = (data: any, unused: string, url?: string | URL | null) => {
      rawReplaceState.call(history, data, unused, url);
      this.checkUrlChange();
    };

    window.addEventListener('popstate', () => {
      this.checkUrlChange();
    });

    // 2. Poller fallback (300ms) for framework SPA transitions
    this.pollerTimer = setInterval(() => {
      this.checkUrlChange();
    }, 400);

    // Initial check
    this.checkUrlChange(true);
  }

  private initDomObserver() {
    this.observer = new MutationObserver(() => {
      if (this.isSubmissionUrl()) {
        this.attemptExtractContext();
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data-drive-id', 'data-id'],
    });
  }

  private checkUrlChange(force = false) {
    const currentUrl = window.location.href;
    if (force || currentUrl !== this.lastUrl) {
      const prevUrl = this.lastUrl;
      this.lastUrl = currentUrl;

      if (!this.isSubmissionUrl(currentUrl)) {
        if (this.currentContext) {
          this.currentContext = null;
          this.events.onSubmissionClosed();
        }
        return;
      }

      // Re-extract context
      this.attemptExtractContext(prevUrl !== currentUrl);
    }
  }

  attemptExtractContext(urlChanged = false) {
    const parsed = this.parseUrlParams(window.location.href);
    const fileId = this.findGoogleDriveFileId();
    const fileName = this.extractActiveFileName();

    if (!fileId && !parsed.courseId) return;

    const newContext: ClassroomContext = {
      ...parsed,
      fileId: fileId || this.currentContext?.fileId,
      fileName: fileName || this.currentContext?.fileName,
    };

    const isDifferent =
      !this.currentContext ||
      this.currentContext.fileId !== newContext.fileId ||
      this.currentContext.submissionId !== newContext.submissionId ||
      urlChanged;

    if (isDifferent) {
      const prevContext = this.currentContext;
      this.currentContext = newContext;
      if (prevContext) {
        this.events.onSubmissionChanged(newContext);
      } else {
        this.events.onSubmissionDetected(newContext);
      }
    }
  }

  /**
   * Layered extraction of Google Drive fileId:
   * 1. Inspect preview iframe and DOM data attributes
   * 2. Inspect anchor links and attachment chips
   * 3. Inspect performance timing entries
   */
  findGoogleDriveFileId(): string | undefined {
    // 1. Inspect iframes (Classroom embeds Drive PDF viewer iframe)
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe');
    for (const iframe of iframes) {
      const src = iframe.src || iframe.getAttribute('data-src') || '';
      const match = this.extractFileIdFromString(src);
      if (match) return match;
    }

    // 2. Inspect DOM data attributes on cards and chips
    const elementsWithDriveId = document.querySelectorAll<HTMLElement>(
      '[data-drive-id], [data-id], [data-file-id], [data-target-id], [data-item-id]'
    );
    for (const el of elementsWithDriveId) {
      const attrVal =
        el.getAttribute('data-drive-id') ||
        el.getAttribute('data-file-id') ||
        el.getAttribute('data-id') ||
        el.getAttribute('data-target-id') ||
        el.getAttribute('data-item-id');
      if (attrVal && /^[a-zA-Z0-9_-]{20,}$/.test(attrVal)) {
        return attrVal;
      }
    }

    // 3. Inspect anchor links (e.g. "math quiz 4 .pdf ↗" title link or attachment chips)
    const links = document.querySelectorAll<HTMLElement>('a[href], [data-url], [data-href]');
    for (const el of links) {
      const target = el.getAttribute('href') || el.getAttribute('data-url') || el.getAttribute('data-href') || '';
      if (target.includes('drive.google.com') || target.includes('docs.google.com')) {
        const match = this.extractFileIdFromString(target);
        if (match) return match;
      }
    }

    // 4. Performance resource timing fallback
    if (typeof performance !== 'undefined' && performance.getEntriesByType) {
      const resources = performance.getEntriesByType('resource');
      for (let i = resources.length - 1; i >= Math.max(0, resources.length - 50); i--) {
        const name = resources[i].name;
        if (name.includes('drive.google.com') || name.includes('docs.google.com')) {
          const match = this.extractFileIdFromString(name);
          if (match) return match;
        }
      }
    }

    return undefined;
  }

  extractFileIdFromString(str: string): string | undefined {
    if (!str) return undefined;

    // Pattern 1: /file/d/{fileId} or /d/{fileId}
    const m1 = str.match(/\/(?:file\/)?d\/([a-zA-Z0-9_-]{20,})/i);
    if (m1) return m1[1];

    // Pattern 2: id={fileId}
    const m2 = str.match(/[?&]id=([a-zA-Z0-9_-]{20,})/i);
    if (m2) return m2[1];

    // Pattern 3: docid={fileId} or fileid={fileId}
    const m3 = str.match(/[?&](?:docid|fileid|docId|fileId)=([a-zA-Z0-9_-]{20,})/i);
    if (m3) return m3[1];

    // Pattern 4: /open?id= or /preview?id=
    const m4 = str.match(/\/(?:open|preview)\?id=([a-zA-Z0-9_-]{20,})/i);
    if (m4) return m4[1];

    // Pattern 5: viewerng/viewer?docid=
    const m5 = str.match(/\/viewerng\/viewer\?(?:[^&]*&)*docid=([a-zA-Z0-9_-]{20,})/i);
    if (m5) return m5[1];

    return undefined;
  }

  private parseUrlParams(url: string): {
    courseId?: string;
    courseWorkId?: string;
    submissionId?: string;
  } {
    // Example: https://classroom.google.com/c/ODg3ODAxOTc2ODI1/a/ODk1NjIxNjc1MjI2/submissions/by-status/and-sort-first-name/student/NDQ2NzU2ODMwNzY2/m/ODk1NjE5MTI4ODI3
    const match = url.match(
      /\/c\/([^/]+)\/a\/([^/]+)\/submissions\/(?:[^/]+\/)*student\/([^/?#]+)(?:\/m\/([^/?#]+))?/
    );

    if (match) {
      return {
        courseId: decodeClassroomParam(match[1]),
        courseWorkId: decodeClassroomParam(match[2]),
        submissionId: decodeClassroomParam(match[3]),
      };
    }

    // Secondary generic pattern
    const courseMatch = url.match(/\/c\/([^/]+)/);
    const assignMatch = url.match(/\/a\/([^/]+)/);
    const studentMatch = url.match(/\/student\/([^/?#]+)/);

    return {
      courseId: decodeClassroomParam(courseMatch ? courseMatch[1] : undefined),
      courseWorkId: decodeClassroomParam(assignMatch ? assignMatch[1] : undefined),
      submissionId: decodeClassroomParam(studentMatch ? studentMatch[1] : undefined),
    };
  }

  extractActiveFileName(): string | undefined {
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
    const chips = document.querySelectorAll<HTMLElement>('[role="button"][title*=".pdf" i], [role="link"][title*=".pdf" i], div[title*=".pdf" i]');
    for (const chip of chips) {
      const raw = chip.getAttribute('title') || chip.getAttribute('aria-label') || chip.textContent || '';
      const m = raw.match(/([a-zA-Z0-9_\- ]+?\s*\.pdf)/i);
      if (m) return m[1].trim();
    }

    // Fallback: check short text nodes containing .pdf
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

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.pollerTimer) {
      clearInterval(this.pollerTimer);
      this.pollerTimer = null;
    }
  }
}
