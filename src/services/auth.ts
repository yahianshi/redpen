import { OAuthTokenData } from '../types';
import { storage } from './storage';

const STORAGE_KEY_AUTH = 'classroom_stylus_oauth';

// Scopes required for Drive PDF access & Classroom submission fallback
export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
];

export class AuthService {
  /**
   * Retrieves the extension's redirect URL that must be added to Google Cloud Console
   * under Authorized redirect URIs.
   */
  static getRedirectUrl(): string {
    if (typeof chrome !== 'undefined' && chrome.identity && chrome.identity.getRedirectURL) {
      return chrome.identity.getRedirectURL('oauth2');
    }
    return `https://${chrome.runtime.id}.chromiumapp.org/oauth2`;
  }

  /**
   * Gets cached OAuth token if valid.
   */
  static async getCachedToken(): Promise<OAuthTokenData | null> {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_AUTH], (result) => {
        const data = result[STORAGE_KEY_AUTH] as OAuthTokenData | undefined;
        if (data && data.accessToken && data.expiresAt > Date.now()) {
          resolve(data);
        } else {
          resolve(null);
        }
      });
    });
  }

  /**
   * Saves OAuth token data to storage.
   */
  static async saveToken(tokenData: OAuthTokenData): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY_AUTH]: tokenData }, () => {
        resolve();
      });
    });
  }

  /**
   * Clears stored OAuth token (sign out).
   */
  static async clearToken(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.remove([STORAGE_KEY_AUTH], () => {
        resolve();
      });
    });
  }

  /**
   * Launches OAuth 2.0 Web Auth Flow compatible with Brave and Chrome.
   * Uses chrome.identity.launchWebAuthFlow rather than getAuthToken.
   */
  static async getValidToken(interactive = true): Promise<string> {
    // 1. Check existing cached token
    const cached = await this.getCachedToken();
    if (cached) {
      return cached.accessToken;
    }

    // 2. Fetch configured OAuth Client ID
    const settings = await storage.getSettings();
    const clientId = settings.oauthClientId?.trim();

    if (!clientId) {
      throw new Error(
        'Google OAuth Client ID is not configured. Please open the extension popup or options to set your Client ID.'
      );
    }

    const redirectUri = this.getRedirectUrl();
    const scopesEncoded = encodeURIComponent(OAUTH_SCOPES.join(' '));

    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&response_type=token` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${scopesEncoded}` +
      `&prompt=select_account`;

    return new Promise<string>((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        {
          url: authUrl,
          interactive,
        },
        async (responseUrl) => {
          if (chrome.runtime.lastError || !responseUrl) {
            const errMsg =
              chrome.runtime.lastError?.message || 'Authentication cancelled or window closed';
            reject(new Error(errMsg));
            return;
          }

          try {
            // Parse URL hash parameters: #access_token=...&token_type=Bearer&expires_in=3599
            const urlObj = new URL(responseUrl);
            const hash = urlObj.hash.substring(1);
            const params = new URLSearchParams(hash);

            const accessToken = params.get('access_token');
            const expiresIn = params.get('expires_in');
            const error = params.get('error');

            if (error) {
              reject(new Error(`OAuth Error: ${error}`));
              return;
            }

            if (!accessToken) {
              reject(new Error('No access_token found in OAuth redirect response.'));
              return;
            }

            const parsedExpiresIn = expiresIn ? parseInt(expiresIn, 10) : 3600;
            // Subtract 120 seconds buffer for safety
            const expiresAt = Date.now() + Math.max(300, parsedExpiresIn - 120) * 1000;

            const tokenData: OAuthTokenData = {
              accessToken,
              expiresAt,
              scope: params.get('scope') || undefined,
            };

            await AuthService.saveToken(tokenData);
            resolve(accessToken);
          } catch (e: any) {
            reject(new Error(`Failed to parse OAuth redirect: ${e.message}`));
          }
        }
      );
    });
  }
}
