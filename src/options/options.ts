import { storage } from '../services/storage';
import { ExtensionMessage, ExtensionResponse } from '../types';

document.addEventListener('DOMContentLoaded', async () => {
  const authStatusBadge = document.getElementById('authStatusBadge')!;
  const redirectUriInput = document.getElementById('redirectUriInput') as HTMLInputElement;
  const copyUriBtn = document.getElementById('copyUriBtn') as HTMLButtonElement;
  const clientIdInput = document.getElementById('clientIdInput') as HTMLInputElement;
  const connectAuthBtn = document.getElementById('connectAuthBtn') as HTMLButtonElement;
  const disconnectAuthBtn = document.getElementById('disconnectAuthBtn') as HTMLButtonElement;
  const authMessage = document.getElementById('authMessage')!;

  const colorDots = document.querySelectorAll<HTMLButtonElement>('.color-dot');
  const penThicknessSelect = document.getElementById('penThicknessSelect') as HTMLSelectElement;
  const penOnlyCheckbox = document.getElementById('penOnlyCheckbox') as HTMLInputElement;
  const autosaveDelayInput = document.getElementById('autosaveDelayInput') as HTMLInputElement;
  const savePrefsBtn = document.getElementById('savePrefsBtn') as HTMLButtonElement;
  const prefsSaveMsg = document.getElementById('prefsSaveMsg')!;

  let selectedColor = '#ef4444';

  // Load existing settings
  const settings = await storage.getSettings();
  clientIdInput.value = settings.oauthClientId || '';
  penThicknessSelect.value = String(settings.defaultPenThickness || 3);
  penOnlyCheckbox.checked = settings.penOnlyMode ?? true;
  autosaveDelayInput.value = String(settings.autosaveDelayMs || 2500);

  selectedColor = settings.defaultPenColor || '#ef4444';
  updateColorDots(selectedColor);

  // Check auth status
  chrome.runtime.sendMessage({ type: 'AUTH_STATUS' } as ExtensionMessage, (resp: ExtensionResponse) => {
    if (resp && resp.success && resp.data) {
      redirectUriInput.value = resp.data.redirectUri || '';
      updateAuthUI(resp.data.isAuthenticated);
    }
  });

  // Copy URI button
  copyUriBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(redirectUriInput.value);
      copyUriBtn.textContent = 'Copied!';
      setTimeout(() => (copyUriBtn.textContent = 'Copy URI'), 1500);
    } catch {
      redirectUriInput.select();
      document.execCommand('copy');
      copyUriBtn.textContent = 'Copied!';
      setTimeout(() => (copyUriBtn.textContent = 'Copy URI'), 1500);
    }
  });

  // Connect Auth
  connectAuthBtn.addEventListener('click', async () => {
    const clientId = clientIdInput.value.trim();
    if (!clientId) {
      setAuthMessage('Please enter a Google Cloud OAuth Client ID', 'error');
      return;
    }

    connectAuthBtn.disabled = true;
    connectAuthBtn.textContent = 'Connecting...';
    authMessage.textContent = '';

    await storage.updateSettings({ oauthClientId: clientId });

    chrome.runtime.sendMessage(
      { type: 'AUTH_GET_TOKEN', interactive: true } as ExtensionMessage,
      (resp: ExtensionResponse) => {
        connectAuthBtn.disabled = false;
        connectAuthBtn.textContent = 'Save & Connect with Google';

        if (resp && resp.success) {
          updateAuthUI(true);
          setAuthMessage('Successfully connected to Google Drive!', 'success');
        } else {
          updateAuthUI(false);
          setAuthMessage(`Authentication failed: ${resp?.error || 'Unknown error'}`, 'error');
        }
      }
    );
  });

  // Disconnect Auth
  disconnectAuthBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' } as ExtensionMessage, () => {
      updateAuthUI(false);
      setAuthMessage('Signed out successfully.', 'success');
    });
  });

  // Color selection
  colorDots.forEach((dot) => {
    dot.addEventListener('click', () => {
      selectedColor = dot.dataset.color || '#ef4444';
      updateColorDots(selectedColor);
    });
  });

  // Save Preferences
  savePrefsBtn.addEventListener('click', async () => {
    const thickness = parseInt(penThicknessSelect.value, 10);
    const penOnly = penOnlyCheckbox.checked;
    const autosaveDelay = parseInt(autosaveDelayInput.value, 10) || 2500;

    await storage.updateSettings({
      defaultPenColor: selectedColor,
      defaultPenThickness: thickness,
      penOnlyMode: penOnly,
      autosaveDelayMs: autosaveDelay,
    });

    prefsSaveMsg.textContent = 'Preferences saved ✓';
    setTimeout(() => {
      prefsSaveMsg.textContent = '';
    }, 2000);
  });

  function updateColorDots(color: string) {
    colorDots.forEach((dot) => {
      dot.classList.toggle('selected', dot.dataset.color === color);
    });
  }

  function updateAuthUI(isAuthenticated: boolean) {
    if (isAuthenticated) {
      authStatusBadge.className = 'badge badge-connected';
      authStatusBadge.textContent = 'Authorized with Google ✓';
      disconnectAuthBtn.style.display = 'inline-block';
    } else {
      authStatusBadge.className = 'badge badge-disconnected';
      authStatusBadge.textContent = 'Not Authorized';
      disconnectAuthBtn.style.display = 'none';
    }
  }

  function setAuthMessage(text: string, type: 'success' | 'error') {
    authMessage.className = `status-box ${type}`;
    authMessage.textContent = text;
  }
});
