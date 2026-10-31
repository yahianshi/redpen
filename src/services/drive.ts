import { DriveRevision } from '../types';
import { AuthService } from './auth';

export class DriveService {
  /**
   * Helper to execute authenticated fetch requests with automatic token retrieval
   */
  private static async authFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await AuthService.getValidToken(true);
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      // Token might be invalid or expired, clear cache and retry once
      await AuthService.clearToken();
      const freshToken = await AuthService.getValidToken(true);
      headers.set('Authorization', `Bearer ${freshToken}`);
      return fetch(url, {
        ...options,
        headers,
      });
    }

    return response;
  }

  /**
   * Downloads raw PDF file bytes from Google Drive.
   */
  static async downloadPdf(fileId: string): Promise<ArrayBuffer> {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    const res = await this.authFetch(url);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to download PDF (${res.status}): ${errText}`);
    }

    return await res.arrayBuffer();
  }

  /**
   * Uploads modified PDF bytes in-place using PATCH uploadType=media.
   * This automatically creates a new revision in Google Drive while preserving fileId and permissions.
   */
  static async uploadPdf(fileId: string, pdfBytes: Uint8Array): Promise<any> {
    const url = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`;
    
    // Copy to an independent Uint8Array with ArrayBuffer to ensure clean body transmission
    const bodyBuffer = pdfBytes.slice().buffer;

    const res = await this.authFetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/pdf',
      },
      body: bodyBuffer,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to upload PDF (${res.status}): ${errText}`);
    }

    return await res.json();
  }

  /**
   * Lists all revisions for a file.
   * revisions[0] represents the initial student upload.
   */
  static async listRevisions(fileId: string): Promise<DriveRevision[]> {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/revisions?fields=revisions(id,modifiedTime,keepForever,originalFilename,size)&supportsAllDrives=true`;
    const res = await this.authFetch(url);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to list revisions (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return (data.revisions as DriveRevision[]) || [];
  }

  /**
   * Marks a revision with keepForever: true so Google Drive never auto-prunes it.
   */
  static async pinOriginalRevision(fileId: string, revisionId: string): Promise<void> {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?supportsAllDrives=true`;
    const res = await this.authFetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ keepForever: true }),
    });

    if (!res.ok) {
      console.warn(`[RedPen] Failed to pin revision ${revisionId}:`, await res.text());
    }
  }

  /**
   * Downloads raw content of a specific revision (e.g. revisions[0] unannotated student upload).
   */
  static async downloadRevision(fileId: string, revisionId: string): Promise<ArrayBuffer> {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?alt=media&supportsAllDrives=true`;
    const res = await this.authFetch(url);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to download revision ${revisionId} (${res.status}): ${errText}`);
    }

    return await res.arrayBuffer();
  }

  /**
   * Google Classroom API to retrieve submission attachment driveFile ID.
   * Supports both userId query (?userId=...) and submissionId path.
   */
  static async getClassroomSubmission(
    courseId: string,
    courseWorkId: string,
    userIdOrSubId: string
  ): Promise<any> {
    // 1. First attempt: list with userId parameter
    try {
      const listUrl = `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(courseId)}/courseWork/${encodeURIComponent(courseWorkId)}/studentSubmissions?userId=${encodeURIComponent(userIdOrSubId)}`;
      const listRes = await this.authFetch(listUrl);
      if (listRes.ok) {
        const data = await listRes.json();
        if (data.studentSubmissions && data.studentSubmissions.length > 0) {
          return data.studentSubmissions[0];
        }
      }
    } catch (e) {
      console.warn('[RedPen] List by userId failed, trying get:', e);
    }

    // 2. Second attempt: get by ID
    try {
      const getUrl = `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(courseId)}/courseWork/${encodeURIComponent(courseWorkId)}/studentSubmissions/${encodeURIComponent(userIdOrSubId)}`;
      const res = await this.authFetch(getUrl);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn('[RedPen] Get by submissionId failed, trying full list:', e);
    }

    // 3. Third attempt: list all submissions in coursework and match
    try {
      const allUrl = `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(courseId)}/courseWork/${encodeURIComponent(courseWorkId)}/studentSubmissions?pageSize=50`;
      const allRes = await this.authFetch(allUrl);
      if (allRes.ok) {
        const allData = await allRes.json();
        const submissions = allData.studentSubmissions || [];
        const match = submissions.find((s: any) => s.userId === userIdOrSubId || s.id === userIdOrSubId);
        if (match) return match;
        if (submissions.length > 0) return submissions[0];
      }
    } catch (e) {
      console.warn('[RedPen] Coursework submissions list failed:', e);
    }

    throw new Error('Could not find student submission in Google Classroom API');
  }

  /**
   * Searches Google Drive for a file by name (exact or substring).
   */
  static async searchFileByName(fileName: string): Promise<string | undefined> {
    const cleanName = fileName.replace(/'/g, "\\'").trim();
    const baseName = cleanName.replace(/\s*\.pdf$/i, '').trim();

    // 1. Try exact filename match first
    try {
      const qExact = `name = '${encodeURIComponent(cleanName)}' and trashed = false`;
      const url1 = `https://www.googleapis.com/drive/v3/files?q=${qExact}&orderBy=modifiedTime desc&pageSize=5&supportsAllDrives=true`;
      const res1 = await this.authFetch(url1);
      if (res1.ok) {
        const data1 = await res1.json();
        if (data1.files && data1.files.length > 0) {
          return data1.files[0].id;
        }
      }
    } catch (e) {
      console.warn('[RedPen] Exact search error:', e);
    }

    // 2. Try flexible name contains match for PDFs
    try {
      const qContains = `name contains '${encodeURIComponent(baseName)}' and mimeType = 'application/pdf' and trashed = false`;
      const url2 = `https://www.googleapis.com/drive/v3/files?q=${qContains}&orderBy=modifiedTime desc&pageSize=5&supportsAllDrives=true`;
      const res2 = await this.authFetch(url2);
      if (res2.ok) {
        const data2 = await res2.json();
        if (data2.files && data2.files.length > 0) {
          return data2.files[0].id;
        }
      }
    } catch (e) {
      console.warn('[RedPen] Contains search error:', e);
    }

    return undefined;
  }
}
