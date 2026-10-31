export type ToolType = 'pen' | 'highlighter' | 'eraser';

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  width: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Stroke {
  id: string;
  tool: ToolType;
  color: string;
  baseThickness: number;
  points: StrokePoint[];
  opacity: number;
  bbox: BoundingBox;
  timestamp: number;
}

export interface PageStrokesMap {
  [pageIndex: number]: Stroke[];
}

export interface SessionData {
  fileId: string;
  pageStrokes: PageStrokesMap;
  lastSavedTime: number;
  isDirty: boolean;
  originalRevisionId?: string;
}

export type SyncStatus = 'saved' | 'syncing' | 'unsaved' | 'error';

export interface UserSettings {
  oauthClientId: string;
  defaultPenColor: string;
  defaultPenThickness: number;
  defaultHighlighterColor: string;
  defaultHighlighterThickness: number;
  penOnlyMode: boolean; // Palm rejection
  autosaveDelayMs: number;
}

export interface DriveRevision {
  id: string;
  mimeType?: string;
  modifiedTime: string;
  keepForever?: boolean;
  originalFilename?: string;
  size?: string;
}

export interface ClassroomContext {
  courseId?: string;
  courseWorkId?: string;
  submissionId?: string;
  fileId?: string;
  fileName?: string;
  studentName?: string;
}

export interface OAuthTokenData {
  accessToken: string;
  expiresAt: number; // Unix timestamp ms
  scope?: string;
}

// Background <-> Content messages
export type ExtensionMessage =
  | { type: 'AUTH_GET_TOKEN'; interactive?: boolean }
  | { type: 'AUTH_LOGOUT' }
  | { type: 'AUTH_STATUS' }
  | { type: 'AUTH_SAVE_CLIENT_ID'; clientId: string }
  | { type: 'DRIVE_DOWNLOAD_FILE'; fileId: string }
  | { type: 'DRIVE_UPLOAD_FILE'; fileId: string; pdfBase64: string }
  | { type: 'DRIVE_LIST_REVISIONS'; fileId: string }
  | { type: 'DRIVE_DOWNLOAD_REVISION'; fileId: string; revisionId: string }
  | { type: 'DRIVE_PIN_REVISION'; fileId: string; revisionId: string }
  | { type: 'DRIVE_SEARCH_NAME'; fileName: string }
  | { type: 'OPEN_ANNOTATOR_TAB'; fileId: string; fileName?: string }
  | { type: 'CLASSROOM_GET_SUBMISSION'; courseId: string; courseWorkId: string; submissionId: string };

export type ExtensionResponse<T = any> =
  | { success: true; data: T }
  | { success: false; error: string; needsAuth?: boolean };
