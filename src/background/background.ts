import { AuthService } from '../services/auth';
import { DriveService } from '../services/drive';
import { storage } from '../services/storage';
import { ExtensionMessage, ExtensionResponse } from '../types';

console.log('[RedPen] Background service worker started.');

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  handleMessage(message)
    .then((res) => sendResponse(res))
    .catch((err) => {
      console.error('[RedPen Background] Error processing message:', err);
      sendResponse({
        success: false,
        error: err?.message || 'Unknown background processing error',
      });
    });

  // Return true to indicate asynchronous response
  return true;
});

async function handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  switch (message.type) {
    case 'AUTH_GET_TOKEN': {
      try {
        const token = await AuthService.getValidToken(message.interactive ?? true);
        return { success: true, data: { token } };
      } catch (err: any) {
        return { success: false, error: err.message, needsAuth: true };
      }
    }

    case 'AUTH_LOGOUT': {
      await AuthService.clearToken();
      return { success: true, data: null };
    }

    case 'AUTH_STATUS': {
      const cached = await AuthService.getCachedToken();
      const settings = await storage.getSettings();
      const redirectUri = AuthService.getRedirectUrl();
      return {
        success: true,
        data: {
          isAuthenticated: !!cached,
          expiresAt: cached?.expiresAt,
          clientId: settings.oauthClientId,
          redirectUri,
        },
      };
    }

    case 'AUTH_SAVE_CLIENT_ID': {
      await storage.updateSettings({ oauthClientId: message.clientId.trim() });
      return { success: true, data: null };
    }

    case 'DRIVE_DOWNLOAD_FILE': {
      const buffer = await DriveService.downloadPdf(message.fileId);
      const base64 = arrayBufferToBase64(buffer);
      return { success: true, data: base64 };
    }

    case 'DRIVE_UPLOAD_FILE': {
      const bytes = base64ToUint8Array(message.pdfBase64);
      const result = await DriveService.uploadPdf(message.fileId, bytes);
      return { success: true, data: result };
    }

    case 'DRIVE_LIST_REVISIONS': {
      const revisions = await DriveService.listRevisions(message.fileId);
      return { success: true, data: revisions };
    }

    case 'DRIVE_PIN_REVISION': {
      await DriveService.pinOriginalRevision(message.fileId, message.revisionId);
      return { success: true, data: null };
    }

    case 'DRIVE_DOWNLOAD_REVISION': {
      const buffer = await DriveService.downloadRevision(message.fileId, message.revisionId);
      const base64 = arrayBufferToBase64(buffer);
      return { success: true, data: base64 };
    }

    case 'DRIVE_SEARCH_NAME': {
      const fileId = await DriveService.searchFileByName(message.fileName);
      return { success: true, data: { fileId } };
    }

    case 'OPEN_ANNOTATOR_TAB': {
      const annotatorUrl = chrome.runtime.getURL(
        `annotator.html?fileId=${encodeURIComponent(message.fileId)}&fileName=${encodeURIComponent(message.fileName || '')}`
      );
      await chrome.tabs.create({ url: annotatorUrl });
      return { success: true, data: null };
    }

    case 'CLASSROOM_GET_SUBMISSION': {
      const data = await DriveService.getClassroomSubmission(
        message.courseId,
        message.courseWorkId,
        message.submissionId
      );
      return { success: true, data };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
