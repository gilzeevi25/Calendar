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
    // Store invite param in localStorage so it survives the auth redirect
    const urlParams = new URLSearchParams(window.location.search);
    const inviteOrgId = urlParams.get('invite');
    if (inviteOrgId) {
      localStorage.setItem('sb_pending_invite', inviteOrgId);
      // Clean the URL without reloading
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState(null, '', cleanUrl);
    }

    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;

    if (!session) {
      const page = window.location.pathname.includes('roster') ? '?redirect=roster' : '';
      window.location.href = 'auth.html' + page;
      return;
    }

    currentUser = session.user;
    updateUserInfoBar();

    // Process pending invite before loading orgs
    const pendingInvite = localStorage.getItem('sb_pending_invite');
    if (pendingInvite) {
      localStorage.removeItem('sb_pending_invite');
      try {
        await acceptInvite(pendingInvite);
        setCurrentOrg({ id: pendingInvite }, 'member');
      } catch (inviteErr) {
        console.warn('Invite accept failed:', inviteErr.message);
      }
    }

    // Load org memberships
    const orgs = await loadUserOrganizations();

    if (orgs.length === 0) {
      showNoAccessMessage();
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

// --- UI: No Access Message ---
function showNoAccessMessage() {
  const modal = document.getElementById('orgModal');
  if (!modal) return;

  modal.innerHTML =
    '<div class="org-modal__overlay">' +
      '<div class="org-modal__box">' +
        '<h3 class="org-modal__title">אין גישה</h3>' +
        '<p class="org-modal__desc">אין לך גישה לאף ארגון. בקש מהמנהל שלך קישור הזמנה כדי להצטרף.</p>' +
        '<div class="org-modal__actions">' +
          '<button class="org-modal__btn org-modal__btn--primary" id="noAccessSignOut">התנתק</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.getElementById('noAccessSignOut').addEventListener('click', signOut);
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
