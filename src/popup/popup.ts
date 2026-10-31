import { storage } from '../services/storage';
import { ExtensionMessage, ExtensionResponse } from '../types';

document.addEventListener('DOMContentLoaded', async () => {
  const connectionBadge = document.getElementById('connectionBadge')!;
  const connectedCard = document.getElementById('connectedCard') as HTMLElement;
  const setupWizard = document.getElementById('setupWizard') as HTMLElement;

  const redirectUriInput = document.getElementById('redirectUri') as HTMLInputElement;
  const copyRedirectBtn = document.getElementById('copyRedirectBtn') as HTMLButtonElement;
  const clientIdInput = document.getElementById('clientIdInput') as HTMLInputElement;
  const saveConnectBtn = document.getElementById('saveConnectBtn') as HTMLButtonElement;
  const signOutBtn = document.getElementById('signOutBtn') as HTMLButtonElement;
  const authStatusMsg = document.getElementById('authStatusMessage')!;

  // Load saved settings
  const settings = await storage.getSettings();
  clientIdInput.value = settings.oauthClientId || '';

  // Auto-save Client ID on input change
  clientIdInput.addEventListener('input', () => {
    const val = clientIdInput.value.trim();
    storage.updateSettings({ oauthClientId: val });
  });

  // Request auth status from background
  chrome.runtime.sendMessage({ type: 'AUTH_STATUS' } as ExtensionMessage, (resp: ExtensionResponse) => {
    if (resp && resp.success && resp.data) {
      redirectUriInput.value = resp.data.redirectUri || '';

      if (resp.data.isAuthenticated) {
        setConnectedState(true);
      } else {
        setConnectedState(false);
      }
    }
  });

  // Copy redirect URI
  copyRedirectBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(redirectUriInput.value);
      copyRedirectBtn.textContent = '✓ Copied!';
      setTimeout(() => {
        copyRedirectBtn.textContent = 'Copy URI';
      }, 1800);
    } catch {
      redirectUriInput.select();
      document.execCommand('copy');
      copyRedirectBtn.textContent = '✓ Copied!';
      setTimeout(() => {
        copyRedirectBtn.textContent = 'Copy URI';
      }, 1800);
    }
  });

  // Save Client ID & Connect with Google
  saveConnectBtn.addEventListener('click', async () => {
    const clientId = clientIdInput.value.trim();
    if (!clientId) {
      showStatus('Please enter your Google Cloud Client ID in Step 2.', 'error');
      clientIdInput.focus();
      return;
    }

    saveConnectBtn.disabled = true;
    saveConnectBtn.textContent = 'Connecting...';
    authStatusMsg.textContent = '';

    // 1. Save Client ID
    await storage.updateSettings({ oauthClientId: clientId });

    // 2. Request interactive token via Brave-compatible launchWebAuthFlow
    chrome.runtime.sendMessage(
      { type: 'AUTH_GET_TOKEN', interactive: true } as ExtensionMessage,
      (resp: ExtensionResponse) => {
        saveConnectBtn.disabled = false;
        saveConnectBtn.textContent = '🚀 Connect with Google';

        if (resp && resp.success) {
          showStatus('Successfully authorized!', 'success');
          setConnectedState(true);
        } else {
          showStatus(`Authorization failed: ${resp?.error || 'Access denied or closed'}`, 'error');
          setConnectedState(false);
        }
      }
    );
  });

  // Disconnect Account
  signOutBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' } as ExtensionMessage, () => {
      setConnectedState(false);
      showStatus('Disconnected successfully.', 'success');
    });
  });

  function setConnectedState(isConnected: boolean) {
    if (isConnected) {
      connectionBadge.className = 'badge badge-connected';
      connectionBadge.textContent = 'Connected ✓';
      connectedCard.style.display = 'block';
      setupWizard.style.display = 'none';
    } else {
      connectionBadge.className = 'badge badge-disconnected';
      connectionBadge.textContent = 'Setup Needed';
      connectedCard.style.display = 'none';
      setupWizard.style.display = 'flex';
    }
  }

  function showStatus(msg: string, type: 'error' | 'success') {
    authStatusMsg.className = `status-msg ${type}`;
    authStatusMsg.textContent = msg;
  }
});
