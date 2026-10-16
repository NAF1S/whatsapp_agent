const API_BASE = '/api/admin';
let currentPhone = null;
let currentSession = null;
let pollInterval = null;
let qrPollTimer = null;
let activeTab = 'escalations';
let currentWaState = { isConnected: false, isPaused: false };

// Auth Token/Password handling
function getAuthHeader() {
  const pwd = localStorage.getItem('hh_admin_pwd') || '';
  return { 'Authorization': `Bearer ${pwd}`, 'Content-Type': 'application/json' };
}

// Elements
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginError = document.getElementById('login-error');
const appLayout = document.getElementById('app');

const conversationsList = document.getElementById('conversations-list');
const messagesContainer = document.getElementById('messages-container');
const chatComposer = document.getElementById('chat-composer');
const headerActions = document.getElementById('header-actions');
const activeCustomerPhone = document.getElementById('active-customer-phone');
const activeCustomerStatus = document.getElementById('active-customer-status');
const activeCustomerReason = document.getElementById('active-customer-reason');
const toggleControlBtn = document.getElementById('toggle-control-btn');
const replyForm = document.getElementById('reply-form');
const replyText = document.getElementById('reply-text');
const escalationCount = document.getElementById('escalation-count');
const tabEscalations = document.getElementById('tab-escalations');
const tabAll = document.getElementById('tab-all');
const syncCatalogBtn = document.getElementById('sync-catalog-btn');
const logoutBtn = document.getElementById('logout-btn');
const mobileLogoutBtn = document.getElementById('mobile-logout-btn');
const backToListBtn = document.getElementById('back-to-list-btn');

// WhatsApp Gateway Elements
const waStatusDot = document.getElementById('wa-status-dot');
const waStatusBadge = document.getElementById('wa-status-badge');
const openQrBtn = document.getElementById('open-qr-btn');
const togglePauseBtn = document.getElementById('toggle-pause-btn');
const pauseIcon = document.getElementById('pause-icon');
const pauseText = document.getElementById('pause-text');
const resetWaBtn = document.getElementById('reset-wa-btn');
const qrModal = document.getElementById('qr-modal');
const closeQrBtn = document.getElementById('close-qr-btn');
const qrLoading = document.getElementById('qr-loading');
const qrImage = document.getElementById('qr-image');
const refreshQrBtn = document.getElementById('refresh-qr-btn');

// Admin Escalation Alert Elements
const adminPhoneInput = document.getElementById('admin-phone-input');
const saveAdminPhoneBtn = document.getElementById('save-admin-phone-btn');
const adminPhoneFeedback = document.getElementById('admin-phone-feedback');
const testAlertBtn = document.getElementById('test-alert-btn');
const testAlertBtnText = document.getElementById('test-alert-btn-text');
const alertStatusBadge = document.getElementById('alert-status-badge');

// Check initial auth
const savedPwd = localStorage.getItem('hh_admin_pwd');
if (savedPwd) {
  verifyAuth(savedPwd);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = passwordInput.value.trim();
  loginError.textContent = '';
  await verifyAuth(pwd);
});

async function verifyAuth(password) {
  try {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.setItem('hh_admin_pwd', password);
      loginOverlay.style.display = 'none';
      appLayout.style.display = 'flex';
      initDashboard();
    } else {
      loginError.textContent = data.error || 'Invalid administrator password';
    }
  } catch (err) {
    loginError.textContent = 'Server connection failed';
  }
}

function handleLogout() {
  localStorage.removeItem('hh_admin_pwd');
  window.location.reload();
}

logoutBtn.addEventListener('click', handleLogout);
if (mobileLogoutBtn) {
  mobileLogoutBtn.addEventListener('click', handleLogout);
}

// Mobile Back Navigation
if (backToListBtn) {
  backToListBtn.addEventListener('click', () => {
    appLayout.classList.remove('chat-active');
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  });
}

// WhatsApp Bridge Status & Controls
async function checkWhatsAppStatus() {
  try {
    const res = await fetch(`${API_BASE}/whatsapp/status`, {
      headers: getAuthHeader(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    currentWaState = data;

    if (data.isPaused) {
      waStatusBadge.textContent = 'Paused';
      waStatusBadge.className = 'badge-status paused';
      if (waStatusDot) waStatusDot.className = 'status-dot paused';
      if (pauseIcon) pauseIcon.textContent = '▶';
      if (pauseText) pauseText.textContent = 'Resume Bot';
    } else if (data.isConnected) {
      waStatusBadge.textContent = 'Connected';
      waStatusBadge.className = 'badge-status connected';
      if (waStatusDot) waStatusDot.className = 'status-dot connected';
      if (pauseIcon) pauseIcon.textContent = '⏸';
      if (pauseText) pauseText.textContent = 'Pause Bot';
    } else {
      waStatusBadge.textContent = data.qrDataUrl ? 'Scan Needed' : 'Disconnected';
      waStatusBadge.className = 'badge-status disconnected';
      if (waStatusDot) waStatusDot.className = 'status-dot disconnected';
      if (pauseIcon) pauseIcon.textContent = '⏸';
      if (pauseText) pauseText.textContent = 'Pause Bot';
    }

    // If QR modal is open, update QR display
    if (qrModal.style.display === 'flex') {
      if (data.isConnected) {
        qrLoading.textContent = '✓ WhatsApp Connected!';
        qrLoading.style.display = 'block';
        qrImage.style.display = 'none';
        setTimeout(() => {
          closeQrModal();
        }, 1500);
      } else if (data.qrDataUrl) {
        qrImage.src = data.qrDataUrl;
        qrImage.style.display = 'block';
        qrLoading.style.display = 'none';
      } else {
        qrLoading.textContent = 'Generating QR code...';
        qrLoading.style.display = 'block';
        qrImage.style.display = 'none';
      }
    }

    return data;
  } catch (err) {
    console.error('WhatsApp status check failed', err);
    return null;
  }
}

function openQrModal() {
  qrModal.style.display = 'flex';
  qrLoading.textContent = 'Loading QR code...';
  qrLoading.style.display = 'block';
  qrImage.style.display = 'none';
  checkWhatsAppStatus();
  stopQrPolling();
  qrPollTimer = setInterval(checkWhatsAppStatus, 3000);
}

function closeQrModal() {
  qrModal.style.display = 'none';
  stopQrPolling();
}

function stopQrPolling() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
}

// Admin Escalation Alert Settings
async function loadAdminSettings() {
  if (!adminPhoneInput) return;
  try {
    const res = await fetch(`${API_BASE}/settings`, { headers: getAuthHeader() });
    if (!res.ok) return;
    const data = await res.json();
    if (data.adminPhone) {
      adminPhoneInput.value = data.adminPhone;
      if (alertStatusBadge) {
        alertStatusBadge.textContent = 'Active';
        alertStatusBadge.className = 'badge-status-sm';
      }
    } else {
      if (alertStatusBadge) {
        alertStatusBadge.textContent = 'Not Set';
        alertStatusBadge.className = 'badge-status-sm not-set';
      }
    }
  } catch (err) {
    console.error('Failed to load admin settings:', err);
  }
}

async function saveAdminPhone() {
  if (!adminPhoneInput) return;
  const phone = adminPhoneInput.value.trim();
  if (!phone) {
    showPhoneFeedback('Please enter a valid WhatsApp phone number (e.g. 01892740307)', 'error');
    return;
  }

  if (saveAdminPhoneBtn) {
    saveAdminPhoneBtn.disabled = true;
    saveAdminPhoneBtn.textContent = '...';
  }

  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'POST',
      headers: getAuthHeader(),
      body: JSON.stringify({ adminPhone: phone }),
    });

    const data = await res.json();
    if (res.ok && data.success) {
      adminPhoneInput.value = data.adminPhone;
      if (alertStatusBadge) {
        alertStatusBadge.textContent = 'Active';
        alertStatusBadge.className = 'badge-status-sm';
      }
      showPhoneFeedback('✓ WhatsApp alert number saved successfully!', 'success');
    } else {
      showPhoneFeedback(data.error || 'Failed to save phone number', 'error');
    }
  } catch (err) {
    showPhoneFeedback('Connection failed: ' + err.message, 'error');
  } finally {
    if (saveAdminPhoneBtn) {
      saveAdminPhoneBtn.disabled = false;
      saveAdminPhoneBtn.textContent = 'Save';
    }
  }
}

async function handleTestAlert() {
  if (!testAlertBtn) return;
  testAlertBtn.disabled = true;
  if (testAlertBtnText) testAlertBtnText.textContent = 'Sending Alert...';

  try {
    const res = await fetch(`${API_BASE}/test-alert`, {
      method: 'POST',
      headers: getAuthHeader(),
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showPhoneFeedback('✓ Test WhatsApp report sent to your phone!', 'success');
    } else {
      showPhoneFeedback(data.error || 'Failed to send test alert', 'error');
    }
  } catch (err) {
    showPhoneFeedback('Error sending test alert: ' + err.message, 'error');
  } finally {
    testAlertBtn.disabled = false;
    if (testAlertBtnText) testAlertBtnText.textContent = 'Send Test Alert';
  }
}

function showPhoneFeedback(msg, type) {
  if (!adminPhoneFeedback) return;
  adminPhoneFeedback.textContent = msg;
  adminPhoneFeedback.className = `admin-phone-feedback ${type}`;
  adminPhoneFeedback.style.display = 'block';

  setTimeout(() => {
    adminPhoneFeedback.style.display = 'none';
  }, 5000);
}

function initDashboard() {
  loadConversations();
  checkWhatsAppStatus();
  loadAdminSettings();

  setInterval(loadConversations, 10000); // Poll list every 10s
  setInterval(checkWhatsAppStatus, 15000); // Check WA status every 15s

  // Admin WhatsApp Alert Listeners
  if (saveAdminPhoneBtn) {
    saveAdminPhoneBtn.addEventListener('click', saveAdminPhone);
  }
  if (adminPhoneInput) {
    adminPhoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveAdminPhone();
      }
    });
  }
  if (testAlertBtn) {
    testAlertBtn.addEventListener('click', handleTestAlert);
  }

  // Tab switching
  tabEscalations.addEventListener('click', () => {
    activeTab = 'escalations';
    tabEscalations.classList.add('active');
    tabAll.classList.remove('active');
    loadConversations();
  });

  tabAll.addEventListener('click', () => {
    activeTab = 'all';
    tabAll.classList.add('active');
    tabEscalations.classList.remove('active');
    loadConversations();
  });

  // WhatsApp Controls
  openQrBtn.addEventListener('click', openQrModal);
  closeQrBtn.addEventListener('click', closeQrModal);
  refreshQrBtn.addEventListener('click', checkWhatsAppStatus);

  qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) {
      closeQrModal();
    }
  });

  togglePauseBtn.addEventListener('click', async () => {
    togglePauseBtn.disabled = true;
    try {
      const nextPaused = !currentWaState.isPaused;
      const res = await fetch(`${API_BASE}/whatsapp/toggle-pause`, {
        method: 'POST',
        headers: getAuthHeader(),
        body: JSON.stringify({ paused: nextPaused }),
      });
      if (res.ok) {
        await checkWhatsAppStatus();
      } else {
        alert('Failed to toggle bot pause state');
      }
    } catch (err) {
      alert('Error toggling pause state: ' + err.message);
    } finally {
      togglePauseBtn.disabled = false;
    }
  });

  resetWaBtn.addEventListener('click', async () => {
    const confirmed = confirm(
      'Are you sure you want to reset the WhatsApp connection?\n\nThis will log out the existing WhatsApp session and generate a fresh QR code for scanning.'
    );
    if (!confirmed) return;

    resetWaBtn.disabled = true;
    try {
      const res = await fetch(`${API_BASE}/whatsapp/reset`, {
        method: 'POST',
        headers: getAuthHeader(),
      });
      const data = await res.json();
      alert(data.message || 'WhatsApp session reset. Please scan the new QR code.');
      openQrModal();
    } catch (err) {
      alert('Failed to reset connection: ' + err.message);
    } finally {
      resetWaBtn.disabled = false;
    }
  });

  // Catalog Full Sync
  syncCatalogBtn.addEventListener('click', async () => {
    syncCatalogBtn.disabled = true;
    const label = syncCatalogBtn.querySelector('.sync-label');
    if (label) label.textContent = 'Syncing...';
    try {
      const res = await fetch(`${API_BASE}/sync-catalog`, {
        method: 'POST',
        headers: getAuthHeader(),
      });
      const data = await res.json();
      alert(`Sync completed! ${data.synced || 0} products indexed into database.`);
    } catch (err) {
      alert('Catalog sync failed: ' + err.message);
    } finally {
      syncCatalogBtn.disabled = false;
      if (label) label.textContent = 'Sync Products';
    }
  });

  // Human Reply
  replyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentPhone) return;
    const text = replyText.value.trim();
    if (!text) return;

    replyText.value = '';
    try {
      const res = await fetch(`${API_BASE}/reply`, {
        method: 'POST',
        headers: getAuthHeader(),
        body: JSON.stringify({ phone: currentPhone, text }),
      });
      if (res.ok) {
        await loadMessages(currentPhone);
      } else {
        alert('Failed to send reply via WhatsApp');
      }
    } catch (err) {
      alert('Network error: ' + err.message);
    }
  });

  // Lock / Release human takeover
  toggleControlBtn.addEventListener('click', async () => {
    if (!currentPhone || !currentSession) return;
    const isHuman = currentSession.is_human_controlled;
    const endpoint = isHuman ? `${API_BASE}/close-ticket` : `${API_BASE}/lock-ticket`;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: getAuthHeader(),
        body: JSON.stringify({ phone: currentPhone }),
      });
      if (res.ok) {
        await loadConversations();
        await loadMessages(currentPhone);
      }
    } catch (err) {
      alert('Error updating session: ' + err.message);
    }
  });
}

async function loadConversations() {
  try {
    const res = await fetch(`${API_BASE}/conversations?filter=${activeTab}`, {
      headers: getAuthHeader(),
    });
    if (!res.ok) return;

    const data = await res.json();
    escalationCount.textContent = data.escalationCount || 0;

    conversationsList.innerHTML = '';
    if (!data.conversations || data.conversations.length === 0) {
      conversationsList.innerHTML = `<div class="empty-state">${activeTab === 'escalations' ? 'No active human escalations' : 'No conversations found'}</div>`;
      return;
    }

    data.conversations.forEach((conv) => {
      const div = document.createElement('div');
      div.className = `conv-item ${currentPhone === conv.phone ? 'active' : ''}`;
      div.innerHTML = `
        <div class="conv-phone">${conv.phone}</div>
        <div class="conv-preview">${conv.last_message || 'No messages'}</div>
        ${conv.is_human_controlled ? '<span class="conv-tag human">Needs Human</span>' : ''}
      `;
      div.addEventListener('click', () => selectConversation(conv.phone));
      conversationsList.appendChild(div);
    });
  } catch (err) {
    console.error('Failed to load conversations', err);
  }
}

async function selectConversation(phone) {
  currentPhone = phone;
  appLayout.classList.add('chat-active'); // Switches mobile view from sidebar to chat
  loadConversations();
  await loadMessages(phone);

  chatComposer.style.display = 'block';
  headerActions.style.display = 'block';

  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => loadMessages(phone), 4000);
}

async function loadMessages(phone) {
  try {
    const res = await fetch(`${API_BASE}/conversation/${encodeURIComponent(phone)}`, {
      headers: getAuthHeader(),
    });
    if (!res.ok) return;

    const data = await res.json();
    currentSession = data.session;

    activeCustomerPhone.textContent = data.session?.customer_name
      ? `${data.session.customer_name} (${phone})`
      : phone;

    if (data.session?.is_human_controlled) {
      activeCustomerStatus.textContent = 'Human Controlled';
      activeCustomerStatus.className = 'status-pill human';
      activeCustomerReason.textContent = data.session.handoff_reason ? `— ${data.session.handoff_reason}` : '';
      toggleControlBtn.textContent = 'Release to Bot';
      toggleControlBtn.className = 'action-btn unlock';
    } else {
      activeCustomerStatus.textContent = 'Automated Bot';
      activeCustomerStatus.className = 'status-pill bot';
      activeCustomerReason.textContent = '';
      toggleControlBtn.textContent = 'Take Over (Lock)';
      toggleControlBtn.className = 'action-btn lock';
    }

    messagesContainer.innerHTML = '';
    data.messages.forEach((msg) => {
      const bubble = document.createElement('div');
      bubble.className = `message-bubble ${msg.role}`;
      bubble.textContent = msg.content;

      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.textContent = `${msg.role.toUpperCase()} • ${time}`;
      bubble.appendChild(meta);

      messagesContainer.appendChild(bubble);
    });

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (err) {
    console.error('Failed to load messages', err);
  }
}
