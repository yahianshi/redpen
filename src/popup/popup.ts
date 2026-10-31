import { storage } from '../services/storage';
import { ExtensionMessage, ExtensionResponse } from '../types';

document.addEventListener('DOMContentLoaded', async () => {
  const connectionBadge = document.getElementById('connectionBadge')!;
  const redirectUriInput = document.getElementById('redirectUri') as HTMLInputElement;
  const copyRedirectBtn = document.getElementById('copyRedirectBtn') as HTMLButtonElement;
  const clientIdInput = document.getElementById('clientIdInput') as HTMLInputElement;
  const saveConnectBtn = document.getElementById('saveConnectBtn') as HTMLButtonElement;
  const signOutBtn = document.getElementById('signOutBtn') as HTMLButtonElement;
  const authStatusMsg = document.getElementById('authStatusMessage')!;

  const colorButtons = document.querySelectorAll<HTMLButtonElement>('.color-btn');
  const thicknessSelect = document.getElementById('thicknessSelect') as HTMLSelectElement;
  const penOnlyToggle = document.getElementById('penOnlyToggle') as HTMLInputElement;

  // Load current settings
  const settings = await storage.getSettings();
  clientIdInput.value = settings.oauthClientId || '';
  thicknessSelect.value = String(settings.defaultPenThickness || 3);
  penOnlyToggle.checked = settings.penOnlyMode ?? true;

  updateColorSelection(settings.defaultPenColor || '#ef4444');

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
      copyRedirectBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyRedirectBtn.textContent = 'Copy';
      }, 1500);
    } catch {
      redirectUriInput.select();
      document.execCommand('copy');
      copyRedirectBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyRedirectBtn.textContent = 'Copy';
      }, 1500);
    }
  });

  // Save Client ID and trigger OAuth Connect
  saveConnectBtn.addEventListener('click', async () => {
    const clientId = clientIdInput.value.trim();
    if (!clientId) {
      showStatus('Please enter a valid Google Cloud Client ID', 'error');
      return;
    }

    saveConnectBtn.disabled = true;
    saveConnectBtn.textContent = 'Connecting...';
    authStatusMsg.textContent = '';

    // 1. Save Client ID
    await storage.updateSettings({ oauthClientId: clientId });

    // 2. Request interactive token
    chrome.runtime.sendMessage(
      { type: 'AUTH_GET_TOKEN', interactive: true } as ExtensionMessage,
      (resp: ExtensionResponse) => {
        saveConnectBtn.disabled = false;
        saveConnectBtn.textContent = 'Connect with Google';

        if (resp && resp.success) {
          showStatus('Successfully authorized with Google!', 'success');
          setConnectedState(true);
        } else {
          showStatus(`Authorization failed: ${resp?.error || 'Unknown error'}`, 'error');
          setConnectedState(false);
        }
      }
    );
  });

  // Sign out
  signOutBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' } as ExtensionMessage, () => {
      setConnectedState(false);
      showStatus('Signed out successfully.', 'success');
    });
  });

  // Preferences change listeners
  colorButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const color = btn.dataset.color || '#ef4444';
      updateColorSelection(color);
      await storage.updateSettings({ defaultPenColor: color });
    });
  });

  thicknessSelect.addEventListener('change', async () => {
    const thick = parseInt(thicknessSelect.value, 10);
    await storage.updateSettings({ defaultPenThickness: thick });
  });

  penOnlyToggle.addEventListener('change', async () => {
    await storage.updateSettings({ penOnlyMode: penOnlyToggle.checked });
  });

  function updateColorSelection(selectedColor: string) {
    colorButtons.forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.color === selectedColor);
    });
  }

  function setConnectedState(isConnected: boolean) {
    if (isConnected) {
      connectionBadge.className = 'badge badge-connected';
      connectionBadge.textContent = 'Authorized ✓';
      signOutBtn.style.display = 'inline-block';
    } else {
      connectionBadge.className = 'badge badge-disconnected';
      connectionBadge.textContent = 'Not Connected';
      signOutBtn.style.display = 'none';
    }
  }

  function showStatus(msg: string, type: 'error' | 'success') {
    authStatusMsg.className = `status-msg ${type}`;
    authStatusMsg.textContent = msg;
  }
});
