/**
 * supabase-auth.js — Shared auth module for index.html and roster.html
 * Depends on: supabase-config.js (provides `supabase` client)
 */

// --- Globals ---
let currentUser = null;
let currentOrg = null;
let currentOrgRole = null;

function getCurrentOrgId() {
  return currentOrg ? currentOrg.id : null;
}

// --- Entry point for each page ---
async function checkAuthAndInit(initAppFn) {
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;

    if (!session) {
      const page = window.location.pathname.includes('roster') ? '?redirect=roster' : '';
      window.location.href = 'auth.html' + page;
      return;
    }

    currentUser = session.user;
    updateUserInfoBar();

    // Load org memberships
    const orgs = await loadUserOrganizations();

    if (orgs.length === 0) {
      showOrgCreateModal();
      return;
    }

    if (orgs.length === 1) {
      setCurrentOrg(orgs[0], orgs[0].role);
    } else {
      // Check localStorage for last org
      const lastOrgId = localStorage.getItem('sb_current_org');
      const lastOrg = lastOrgId ? orgs.find(o => o.id === lastOrgId) : null;
      if (lastOrg) {
        setCurrentOrg(lastOrg, lastOrg.role);
      } else {
        showOrgPickerModal(orgs);
        return;
      }
    }

    updateUserInfoBar();
    await initAppFn();

  } catch (err) {
    console.error('Auth init failed:', err);
    window.location.href = 'auth.html';
  }
}

// --- Sign out ---
async function signOut() {
  try {
    await supabase.auth.signOut();
  } catch (e) {
    console.warn('Sign out error:', e);
  }
  localStorage.removeItem('sb_current_org');
  window.location.href = 'auth.html';
}

// --- Organization queries ---
async function loadUserOrganizations() {
  const { data, error } = await supabase
    .from('organization_members')
    .select('org_id, role, organizations(id, name)')
    .eq('user_id', currentUser.id);

  if (error) {
    console.error('Failed to load orgs:', error);
    return [];
  }

  return (data || []).map(row => ({
    id: row.organizations.id,
    name: row.organizations.name,
    role: row.role
  }));
}

async function createOrganization(name) {
  // Insert organization
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .insert({ name, created_by: currentUser.id })
    .select()
    .single();

  if (orgErr) throw orgErr;

  // Add creator as owner
  const { error: memErr } = await supabase
    .from('organization_members')
    .insert({ org_id: org.id, user_id: currentUser.id, role: 'owner' });

  if (memErr) throw memErr;

  return org;
}

function setCurrentOrg(org, role) {
  currentOrg = org;
  currentOrgRole = role;
  localStorage.setItem('sb_current_org', org.id);
}

// --- UI: User info bar ---
function updateUserInfoBar() {
  const bar = document.getElementById('userInfoBar');
  if (!bar) return;

  const avatar = currentUser?.user_metadata?.avatar_url || '';
  const name = currentUser?.user_metadata?.full_name || currentUser?.email || '';
  const orgName = currentOrg?.name || '';

  bar.innerHTML =
    '<div class="user-info-bar__content">' +
      (avatar ? '<img class="user-info-bar__avatar" src="' + avatar + '" alt="">' : '') +
      '<span class="user-info-bar__name">' + escapeHtmlAuth(name) + '</span>' +
      (orgName ? '<span class="user-info-bar__org">' + escapeHtmlAuth(orgName) + '</span>' : '') +
      '<button class="user-info-bar__logout" id="btnLogout">התנתק</button>' +
    '</div>';

  bar.style.display = 'flex';

  document.getElementById('btnLogout').addEventListener('click', signOut);
}

function escapeHtmlAuth(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- UI: Org Create Modal ---
function showOrgCreateModal() {
  const modal = document.getElementById('orgModal');
  if (!modal) return;

  modal.innerHTML =
    '<div class="org-modal__overlay" id="orgModalOverlay">' +
      '<div class="org-modal__box">' +
        '<h3 class="org-modal__title">יצירת ארגון</h3>' +
        '<p class="org-modal__desc">נראה שאין לך ארגון עדיין. צור ארגון חדש כדי להתחיל.</p>' +
        '<input class="org-modal__input" id="orgNameInput" placeholder="שם הארגון (למשל: פלוגה ב)" maxlength="100">' +
        '<div class="org-modal__actions">' +
          '<button class="org-modal__btn org-modal__btn--primary" id="orgCreateBtn">צור ארגון</button>' +
        '</div>' +
        '<div class="org-modal__status" id="orgStatus"></div>' +
      '</div>' +
    '</div>';

  const input = document.getElementById('orgNameInput');
  const btn = document.getElementById('orgCreateBtn');
  const status = document.getElementById('orgStatus');

  input.focus();

  btn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) { status.textContent = 'יש להזין שם ארגון'; return; }
    btn.disabled = true;
    btn.textContent = 'יוצר...';
    try {
      const org = await createOrganization(name);
      setCurrentOrg(org, 'owner');
      modal.innerHTML = '';
      updateUserInfoBar();
      // Reload page to trigger full init
      window.location.reload();
    } catch (err) {
      status.textContent = 'שגיאה: ' + err.message;
      btn.disabled = false;
      btn.textContent = 'צור ארגון';
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn.click();
  });
}

// --- UI: Org Picker Modal ---
function showOrgPickerModal(orgs) {
  const modal = document.getElementById('orgModal');
  if (!modal) return;

  let html =
    '<div class="org-modal__overlay" id="orgModalOverlay">' +
      '<div class="org-modal__box">' +
        '<h3 class="org-modal__title">בחר ארגון</h3>' +
        '<div class="org-modal__list">';

  orgs.forEach(org => {
    html += '<button class="org-modal__org-btn" data-org-id="' + org.id + '">' +
      escapeHtmlAuth(org.name) +
      '<span class="org-modal__role">' + escapeHtmlAuth(org.role) + '</span>' +
    '</button>';
  });

  html += '</div></div></div>';
  modal.innerHTML = html;

  modal.querySelectorAll('.org-modal__org-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const orgId = btn.dataset.orgId;
      const org = orgs.find(o => o.id === orgId);
      if (org) {
        setCurrentOrg(org, org.role);
        modal.innerHTML = '';
        updateUserInfoBar();
        window.location.reload();
      }
    });
  });
}
