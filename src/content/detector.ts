import { ClassroomContext } from '../types';

export interface DetectorEvents {
  onSubmissionDetected: (ctx: ClassroomContext) => void;
  onSubmissionChanged: (ctx: ClassroomContext) => void;
  onSubmissionClosed: () => void;
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
   * 2. Inspect performance timing entries
   */
  findGoogleDriveFileId(): string | undefined {
    // 1. Inspect iframes (Classroom embeds Drive PDF viewer iframe)
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe');
    for (const iframe of iframes) {
      const src = iframe.src || iframe.getAttribute('data-src') || '';
      const match = this.extractFileIdFromString(src);
      if (match) return match;
    }

    // 2. Inspect DOM data attributes
    const elementsWithDriveId = document.querySelectorAll<HTMLElement>(
      '[data-drive-id], [data-id], [data-file-id], [data-target-id]'
    );
    for (const el of elementsWithDriveId) {
      const attrVal =
        el.getAttribute('data-drive-id') ||
        el.getAttribute('data-file-id') ||
        el.getAttribute('data-id') ||
        el.getAttribute('data-target-id');
      if (attrVal && /^[a-zA-Z0-9_-]{25,}$/.test(attrVal)) {
        return attrVal;
      }
    }

    // 3. Inspect anchor links
    const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="drive.google.com"]');
    for (const link of links) {
      const match = this.extractFileIdFromString(link.href);
      if (match) return match;
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

  private extractFileIdFromString(str: string): string | undefined {
    if (!str) return undefined;

    // Pattern 1: /file/d/{fileId}
    const m1 = str.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
    if (m1) return m1[1];

    // Pattern 2: /d/{fileId}
    const m2 = str.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    if (m2) return m2[1];

    // Pattern 3: id={fileId}
    const m3 = str.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    if (m3) return m3[1];

    // Pattern 4: docId={fileId} or fileId={fileId}
    const m4 = str.match(/[?&](?:docId|fileId)=([a-zA-Z0-9_-]{20,})/);
    if (m4) return m4[1];

    return undefined;
  }

  private parseUrlParams(url: string): {
    courseId?: string;
    courseWorkId?: string;
    submissionId?: string;
  } {
    // Example: https://classroom.google.com/c/ODg3ODAxOTc2ODI1/a/ODk1NjIxNjc1MjI2/submissions/by-status/and-sort-first-name/student/NDQ2NzU2ODMwNzY2/m/ODk1NjE5MTI4ODI3
    const match = url.match(
      /\/c\/([^/]+)\/a\/([^/]+)\/submissions\/(?:[^/]+\/)+student\/([^/?#]+)/
    );

    if (match) {
      return {
        courseId: match[1],
        courseWorkId: match[2],
        submissionId: match[3],
      };
    }

    // Secondary generic pattern
    const courseMatch = url.match(/\/c\/([^/]+)/);
    const assignMatch = url.match(/\/a\/([^/]+)/);
    const studentMatch = url.match(/\/student\/([^/?#]+)/);

    return {
      courseId: courseMatch ? courseMatch[1] : undefined,
      courseWorkId: assignMatch ? assignMatch[1] : undefined,
      submissionId: studentMatch ? studentMatch[1] : undefined,
    };
  }

  private extractActiveFileName(): string | undefined {
    // Look for filename in Classroom's dark header or preview container
    const headerTitle = document.querySelector<HTMLElement>(
      '[role="banner"] [title*=".pdf"], header [title*=".pdf"], div[title*=".pdf"]'
    );
    if (headerTitle) {
      return headerTitle.getAttribute('title') || headerTitle.textContent?.trim() || undefined;
    }

    const anyPdfTitle = document.querySelector<HTMLElement>('div[aria-label*=".pdf"]');
    if (anyPdfTitle) {
      return anyPdfTitle.getAttribute('aria-label') || undefined;
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
