import { storage } from '../services/storage';
import { ExtensionMessage, ExtensionResponse } from '../types';

document.addEventListener('DOMContentLoaded', async () => {
  const connectionBadge = document.getElementById('connectionBadge')!;
  const connectedCard = document.getElementById('connectedCard') as HTMLElement;
  const reauthCard = document.getElementById('reauthCard') as HTMLElement;
  const setupWizard = document.getElementById('setupWizard') as HTMLElement;

  const wizardPage1 = document.getElementById('wizardPage1') as HTMLElement;
  const wizardPage2 = document.getElementById('wizardPage2') as HTMLElement;
  const wizardPage3 = document.getElementById('wizardPage3') as HTMLElement;

  const redirectUriInput = document.getElementById('redirectUri') as HTMLInputElement;
  const copyRedirectBtn = document.getElementById('copyRedirectBtn') as HTMLButtonElement;
  const clientIdInput = document.getElementById('clientIdInput') as HTMLInputElement;

  const nextToPage2Btn = document.getElementById('nextToPage2Btn') as HTMLButtonElement;
  const backToPage1Btn = document.getElementById('backToPage1Btn') as HTMLButtonElement;
  const nextToPage3Btn = document.getElementById('nextToPage3Btn') as HTMLButtonElement;
  const backToPage2Btn = document.getElementById('backToPage2Btn') as HTMLButtonElement;

  const saveConnectBtn = document.getElementById('saveConnectBtn') as HTMLButtonElement;
  const quickSignInBtn = document.getElementById('quickSignInBtn') as HTMLButtonElement;
  const reauthConnectedBtn = document.getElementById('reauthConnectedBtn') as HTMLButtonElement;
  const editSetupFromConnected = document.getElementById('editSetupFromConnected') as HTMLButtonElement;
  const openSetupFromReauth = document.getElementById('openSetupFromReauth') as HTMLButtonElement;
  const signOutBtn = document.getElementById('signOutBtn') as HTMLButtonElement;

  const authStatusMsg = document.getElementById('authStatusMessage')!;
  const reauthStatusMsg = document.getElementById('reauthStatusMessage')!;

  let currentWizardPage = 1;

  // Load saved settings
  const settings = await storage.getSettings();
  if (settings.oauthClientId) {
    clientIdInput.value = settings.oauthClientId;
  }

  // Auto-save Client ID on input
  clientIdInput.addEventListener('input', () => {
    const val = clientIdInput.value.trim();
    storage.updateSettings({ oauthClientId: val });
  });

  // Request auth status from background
  checkAuthAndRender();

  function checkAuthAndRender() {
    chrome.runtime.sendMessage({ type: 'AUTH_STATUS' } as ExtensionMessage, (resp: ExtensionResponse) => {
      if (resp && resp.success && resp.data) {
        redirectUriInput.value = resp.data.redirectUri || '';
        const hasClientId = !!(resp.data.clientId || clientIdInput.value.trim());
        const isAuthenticated = !!resp.data.isAuthenticated;

        if (isAuthenticated) {
          showConnectedView();
        } else if (hasClientId) {
          showReauthView();
        } else {
          showSetupWizardView(1);
        }
      }
    });
  }

  // --- View Switchers ---
  function showConnectedView() {
    connectionBadge.className = 'badge badge-connected';
    connectionBadge.textContent = 'Connected ✓';
    connectedCard.style.display = 'block';
    reauthCard.style.display = 'none';
    setupWizard.style.display = 'none';
  }

  function showReauthView() {
    connectionBadge.className = 'badge badge-expired';
    connectionBadge.textContent = 'Sign In Required';
    connectedCard.style.display = 'none';
    reauthCard.style.display = 'block';
    setupWizard.style.display = 'none';
  }

  function showSetupWizardView(page: number = 1) {
    connectionBadge.className = 'badge badge-disconnected';
    connectionBadge.textContent = 'Setup Needed';
    connectedCard.style.display = 'none';
    reauthCard.style.display = 'none';
    setupWizard.style.display = 'flex';
    setWizardPage(page);
  }

  function setWizardPage(page: number) {
    currentWizardPage = page;
    wizardPage1.style.display = page === 1 ? 'flex' : 'none';
    wizardPage2.style.display = page === 2 ? 'flex' : 'none';
    wizardPage3.style.display = page === 3 ? 'flex' : 'none';

    // Update stepper dots & lines
    document.querySelectorAll('.stepper-node').forEach((node) => {
      const stepNum = parseInt((node as HTMLElement).dataset.stepIndicator || '1', 10);
      node.classList.toggle('active', stepNum === page);
      node.classList.toggle('completed', stepNum < page);
    });

    const line1 = document.querySelector('.stepper-line[data-line="1"]');
    const line2 = document.querySelector('.stepper-line[data-line="2"]');
    if (line1) line1.classList.toggle('completed', page > 1);
    if (line2) line2.classList.toggle('completed', page > 2);
  }

  // --- Wizard Navigation ---
  nextToPage2Btn.addEventListener('click', () => {
    setWizardPage(2);
  });

  backToPage1Btn.addEventListener('click', () => {
    setWizardPage(1);
  });

  nextToPage3Btn.addEventListener('click', () => {
    const val = clientIdInput.value.trim();
    if (!val) {
      clientIdInput.focus();
      return;
    }
    storage.updateSettings({ oauthClientId: val });
    setWizardPage(3);
  });

  backToPage2Btn.addEventListener('click', () => {
    setWizardPage(2);
  });

  // Switch to setup wizard from Reauth / Connected views
  openSetupFromReauth.addEventListener('click', () => {
    showSetupWizardView(2);
  });

  editSetupFromConnected.addEventListener('click', () => {
    showSetupWizardView(2);
  });

  // --- Copy redirect URI ---
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

  // --- Perform Authorization (Interactive) ---
  async function performAuth(buttonEl: HTMLButtonElement, statusEl: HTMLElement) {
    const clientId = clientIdInput.value.trim();
    if (!clientId) {
      showStatus(statusEl, 'Please enter your Google Cloud Client ID.', 'error');
      showSetupWizardView(2);
      clientIdInput.focus();
      return;
    }

    buttonEl.disabled = true;
    const originalText = buttonEl.textContent;
    buttonEl.textContent = 'Signing in with Google...';
    statusEl.textContent = '';

    await storage.updateSettings({ oauthClientId: clientId });

    chrome.runtime.sendMessage(
      { type: 'AUTH_GET_TOKEN', interactive: true } as ExtensionMessage,
      (resp: ExtensionResponse) => {
        buttonEl.disabled = false;
        buttonEl.textContent = originalText;

        if (resp && resp.success) {
          showStatus(statusEl, 'Successfully authorized!', 'success');
          setTimeout(() => {
            showConnectedView();
          }, 400);
        } else {
          showStatus(statusEl, `Sign-in failed: ${resp?.error || 'Access denied or closed'}`, 'error');
        }
      }
    );
  }

  saveConnectBtn.addEventListener('click', () => performAuth(saveConnectBtn, authStatusMsg));
  quickSignInBtn.addEventListener('click', () => performAuth(quickSignInBtn, reauthStatusMsg));
  reauthConnectedBtn.addEventListener('click', () => performAuth(reauthConnectedBtn, authStatusMsg));

  // --- Disconnect Account ---
  signOutBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' } as ExtensionMessage, () => {
      showReauthView();
    });
  });

  function showStatus(targetEl: HTMLElement, msg: string, type: 'error' | 'success') {
    targetEl.className = `status-msg ${type}`;
    targetEl.textContent = msg;
  }
});
