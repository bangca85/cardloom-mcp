// Application State
let activeCardId = null;
let cardsList = [];
let currentPage = 1;
const itemsPerPage = 15;

// Graph variable
let network = null;

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Toast System (Tailwind Styled)
function showToast(title, body, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  
  let bgClass = 'bg-emerald-500/10 border-emerald-500/20 text-emerald-800';
  let icon = 'check_circle';
  if (type === 'warning') {
    bgClass = 'bg-amber-500/10 border-amber-500/20 text-amber-800';
    icon = 'warning';
  } else if (type === 'error') {
    bgClass = 'bg-red-500/10 border-red-500/20 text-red-800';
    icon = 'error';
  }

  toast.className = `p-4 border rounded-xl flex gap-3 items-start shadow-lg backdrop-blur-md transform transition-all duration-300 ease-out translate-y-2 opacity-0 ${bgClass}`;
  toast.innerHTML = `
    <span class="material-symbols-outlined text-[20px]">${icon}</span>
    <div>
      <div class="font-bold text-[14px]">${title}</div>
      <div class="text-[12px] opacity-90 mt-0.5">${body}</div>
    </div>
  `;
  container.appendChild(toast);
  
  // Trigger entry animation
  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  // Trigger exit and removal
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-x-4');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// DOM Elements
const searchInput = document.getElementById('search-input');
const filterVerified = document.getElementById('filter-verified');
const filterDraft = document.getElementById('filter-draft');
const filterDeprecated = document.getElementById('filter-deprecated');
const filterType = document.getElementById('filter-type');
const filterDomain = document.getElementById('filter-domain');

const cardList = document.getElementById('card-list');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');
const pageIndicator = document.getElementById('page-indicator');

const detailWelcome = document.getElementById('detail-welcome');
const detailCardView = document.getElementById('detail-card-view');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

const btnApprove = document.getElementById('btn-approve');
const btnDeprecate = document.getElementById('btn-deprecate');

// SPA Tab Switching
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.getAttribute('data-tab');
    
    tabButtons.forEach(b => {
      b.className = 'tab-btn text-on-surface-variant hover:text-primary transition-colors font-medium';
    });
    tabPanes.forEach(p => p.classList.add('hidden'));

    btn.className = 'tab-btn text-primary border-b-2 border-primary pb-1 font-medium';
    
    const targetPane = document.getElementById(`tab-${tabName}`);
    if (targetPane) targetPane.classList.remove('hidden');

    if (tabName === 'graph') {
      renderGraph();
      btnApprove.classList.add('hidden');
      btnDeprecate.classList.add('hidden');
    } else {
      if (activeCardId) {
        const activeCard = cardsList.find(c => c.id === activeCardId);
        if (activeCard) {
          renderCardDetail(activeCard);
        } else {
          btnApprove.classList.add('hidden');
          btnDeprecate.classList.add('hidden');
        }
      } else {
        btnApprove.classList.add('hidden');
        btnDeprecate.classList.add('hidden');
      }
    }
  });
});

// Load Cards List
async function loadCards() {
  const query = searchInput.value;
  const includeDrafts = filterDraft.checked;
  const includeDeprecated = filterDeprecated.checked;
  const includeVerified = filterVerified.checked;
  const type = filterType.value;
  const domain = filterDomain.value;

  const offset = (currentPage - 1) * itemsPerPage;
  
  const params = new URLSearchParams({
    query,
    include_drafts: includeDrafts ? 'true' : 'false',
    include_deprecated: includeDeprecated ? 'true' : 'false',
    type,
    domain,
    limit: itemsPerPage.toString(),
    offset: offset.toString()
  });

  try {
    const res = await fetch(`/api/cards?${params.toString()}`);
    const data = await res.json();
    cardsList = data;
    renderCardList();
    
    // Pagination controls
    prevPageBtn.disabled = currentPage === 1;
    nextPageBtn.disabled = data.length < itemsPerPage;
    pageIndicator.innerText = `Page ${currentPage}`;
  } catch (err) {
    showToast('System Error', 'Failed to load knowledge cards.', 'error');
  }
}

// Render Card List
function renderCardList() {
  cardList.innerHTML = '';
  if (cardsList.length === 0) {
    cardList.innerHTML = '<div class="text-center text-on-surface-variant text-[14px] py-8">No cards found</div>';
    return;
  }

  cardsList.forEach(card => {
    const wrapper = document.createElement('div');
    
    // Check flags for warnings
    let flagsPreview = '';
    if (card.flags && card.flags.length > 0) {
      flagsPreview = `<span class="text-error text-[12px] font-bold">⚠️</span>`;
    }

    const cleanBody = (card.body || '')
      .replace(/[#*`>_\-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const summary = cleanBody.length > 60 ? cleanBody.substring(0, 60) + '...' : cleanBody || 'No details provided.';

    const isSelected = activeCardId === card.id;

    if (isSelected) {
      wrapper.className = "p-4 bg-primary/10 border-l-4 border-primary rounded-xl cursor-pointer transition-all hover:bg-primary/15";
      wrapper.innerHTML = `
        <h4 class="font-bold text-primary text-[14px] pt-[2px]">${card.title} ${flagsPreview}</h4>
        <p class="text-[12px] text-on-surface-variant mt-1 line-clamp-1">${summary}</p>
        <div class="flex gap-2 mt-2">
          <span class="px-2 py-0.5 bg-white/50 rounded text-[10px] text-primary font-bold">${(card.domain || 'SYSTEM').toUpperCase()}</span>
          <span class="px-2 py-0.5 bg-white/50 rounded text-[10px] text-primary font-bold">${card.type.toUpperCase()}</span>
        </div>
      `;
    } else {
      wrapper.className = "p-4 glass-panel rounded-xl cursor-pointer hover:translate-x-1 transition-all border border-transparent hover:border-white/60";
      wrapper.innerHTML = `
        <h4 class="font-medium text-on-surface text-[14px] pt-[2px]">${card.title} ${flagsPreview}</h4>
        <p class="text-[12px] text-on-surface-variant mt-1 line-clamp-1">${summary}</p>
        <div class="flex gap-2 mt-2">
          <span class="px-2 py-0.5 bg-white/10 rounded text-[10px] text-on-surface-variant font-bold">${(card.domain || 'SYSTEM').toUpperCase()}</span>
          <span class="px-2 py-0.5 bg-white/10 rounded text-[10px] text-on-surface-variant font-bold">${card.type.toUpperCase()}</span>
        </div>
      `;
    }

    wrapper.addEventListener('click', () => {
      selectCard(card.id);
    });

    cardList.appendChild(wrapper);
  });
}

// Select Card Detail
async function selectCard(id) {
  activeCardId = id;
  
  // Rerender list to reflect selected class styling
  renderCardList();

  try {
    const res = await fetch(`/api/cards/${id}`);
    if (res.status === 404) {
      showToast('Not Found', 'Knowledge card does not exist.', 'error');
      return;
    }
    const card = await res.json();
    renderCardDetail(card);
  } catch (err) {
    showToast('System Error', 'Failed to load card details.', 'error');
  }
}

// Render Card Detail View
function renderCardDetail(card) {
  detailWelcome.classList.add('hidden');
  detailCardView.classList.remove('hidden');

  // Title & ID
  document.getElementById('card-title').innerText = card.title;
  const cardIdEl = document.getElementById('card-id');
  cardIdEl.innerText = card.id;
  cardIdEl.title = card.id;

  // Status Badge Rendering
  const statusBadge = document.getElementById('card-status-badge');
  if (card.status === 'verified') {
    statusBadge.className = 'bg-emerald-500/10 text-emerald-700 px-3 py-1 rounded-full text-label-sm flex items-center gap-1';
    statusBadge.innerHTML = '<span class="material-symbols-outlined text-[14px]" style="font-variation-settings: \'FILL\' 1;">verified</span> Verified';
  } else if (card.status === 'draft') {
    statusBadge.className = 'bg-amber-500/10 text-amber-700 px-3 py-1 rounded-full text-label-sm flex items-center gap-1';
    statusBadge.innerHTML = '<span class="material-symbols-outlined text-[14px]" style="font-variation-settings: \'FILL\' 1;">hourglass_empty</span> Draft';
  } else {
    statusBadge.className = 'bg-slate-500/10 text-slate-700 px-3 py-1 rounded-full text-label-sm flex items-center gap-1';
    statusBadge.innerHTML = '<span class="material-symbols-outlined text-[14px]" style="font-variation-settings: \'FILL\' 1;">block</span> Deprecated';
  }

  // Render Warning Flags
  const flagsContainer = document.getElementById('card-flags-container');
  flagsContainer.innerHTML = '';
  if (card.flags && card.flags.length > 0) {
    card.flags.forEach(flag => {
      const pill = document.createElement('span');
      let colorClasses = 'bg-amber-500/10 border-amber-500/20 text-amber-800';
      if (flag === 'needs_review' || flag === 'untrusted') {
        colorClasses = 'bg-red-500/10 border-red-500/20 text-red-800';
      }
      pill.className = `px-3 py-1 border rounded-full text-label-sm flex items-center gap-1 font-medium ${colorClasses}`;
      pill.innerHTML = `<span class="material-symbols-outlined text-[14px]">warning</span> ${flag}`;
      flagsContainer.appendChild(pill);
    });
  }

  // Properties Bento Grid
  document.getElementById('meta-type').innerText = card.type.charAt(0).toUpperCase() + card.type.slice(1);
  document.getElementById('meta-domain').innerText = card.domain ? card.domain.charAt(0).toUpperCase() + card.domain.slice(1) : 'N/A';
  document.getElementById('meta-scope').innerText = card.scope.charAt(0).toUpperCase() + card.scope.slice(1);
  document.getElementById('meta-version').innerText = card.version_range || 'N/A';

  // Extra Context info
  document.getElementById('meta-stack').innerText = (card.stack && card.stack.length > 0) ? card.stack.join(', ') : 'N/A';
  document.getElementById('meta-applies-to').innerText = (card.applies_to && card.applies_to.length > 0) ? card.applies_to.join(', ') : 'N/A';

  // Fidelity Grid
  const trustPercent = Math.round(card.trust * 100);
  document.getElementById('meta-trust').innerText = `${trustPercent}%`;
  
  const trustFill = document.getElementById('trust-progress-fill');
  if (trustFill) {
    trustFill.style.width = `${trustPercent}%`;
    if (trustPercent >= 80) {
      trustFill.className = 'h-full bg-emerald-500 rounded-full shadow-[0_0_12px_rgba(16,185,129,0.5)]';
    } else if (trustPercent >= 50) {
      trustFill.className = 'h-full bg-amber-500 rounded-full shadow-[0_0_12px_rgba(245,158,11,0.5)]';
    } else {
      trustFill.className = 'h-full bg-red-500 rounded-full shadow-[0_0_12px_rgba(239,68,68,0.5)]';
    }
  }

  document.getElementById('meta-commit').innerText = card.source_commit ? `sha-${card.source_commit.substring(0, 7)}` : 'N/A';
  document.getElementById('meta-provenance').innerText = card.provenance || 'N/A';

  // Audit Logs (Verified & Deprecated rows)
  const verifiedRow = document.getElementById('meta-verified-row');
  if (card.verified_by) {
    verifiedRow.classList.remove('hidden');
    document.getElementById('meta-verified').innerText = `${card.verified_by} via ${card.verification_method || 'manual'}`;
  } else {
    verifiedRow.classList.add('hidden');
  }

  const deprecatedRow = document.getElementById('meta-deprecated-row');
  if (card.status === 'deprecated') {
    deprecatedRow.classList.remove('hidden');
    document.getElementById('meta-deprecated').innerText = card.deprecation_reason || 'Unknown';
  } else {
    deprecatedRow.classList.add('hidden');
  }

  // Render Markdown Body
  const bodyContent = document.getElementById('card-body-content');
  bodyContent.innerHTML = marked.parse(card.body || '');

  // Enable/Disable Action buttons based on card status
  if (card.status === 'draft') {
    btnApprove.classList.remove('hidden');
    btnDeprecate.classList.remove('hidden');
  } else if (card.status === 'verified') {
    btnApprove.classList.add('hidden');
    btnDeprecate.classList.remove('hidden');
  } else {
    // Deprecated
    btnApprove.classList.add('hidden');
    btnDeprecate.classList.add('hidden');
  }
}

// Action: Approve Card
btnApprove.addEventListener('click', async () => {
  if (!activeCardId) return;
  btnApprove.disabled = true;

  try {
    const res = await fetch(`/api/cards/${activeCardId}/approve`, { method: 'POST' });
    const outcome = await res.json();

    if (res.status === 200) {
      if (outcome.git_committed && outcome.index_updated) {
        showToast('Success', `Card ${activeCardId} has been approved.`);
      } else {
        let warningMsg = '';
        if (!outcome.index_updated) warningMsg += `SQLite Index error: ${outcome.index_error || 'Unknown'}. `;
        if (!outcome.git_committed) warningMsg += `Git commit error: ${outcome.git_error || 'Unknown'}. `;
        showToast('Approved with warnings', warningMsg, 'warning');
      }
      
      await loadCards();
      await selectCard(activeCardId);
      if (!document.getElementById('tab-graph').classList.contains('hidden')) {
        renderGraph();
      }
    } else {
      const errorMsg = outcome.error ? outcome.error.message : 'Approval failed.';
      showToast('Failure', errorMsg, 'error');
    }
  } catch (err) {
    showToast('System Error', 'Could not connect to the server.', 'error');
  } finally {
    btnApprove.disabled = false;
  }
});

// Action: Deprecate Card
btnDeprecate.addEventListener('click', async () => {
  if (!activeCardId) return;
  const reason = prompt('Please enter the deprecation reason (required):');
  if (reason === null) return; // user cancelled
  if (reason.trim() === '') {
    showToast('Input Error', 'Deprecation reason cannot be empty.', 'error');
    return;
  }

  btnDeprecate.disabled = true;

  try {
    const res = await fetch(`/api/cards/${activeCardId}/deprecate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() })
    });
    const outcome = await res.json();

    if (res.status === 200) {
      if (outcome.git_committed && outcome.index_updated) {
        showToast('Success', `Card ${activeCardId} has been deprecated.`);
      } else {
        let warningMsg = '';
        if (!outcome.index_updated) warningMsg += `SQLite Index error: ${outcome.index_error || 'Unknown'}. `;
        if (!outcome.git_committed) warningMsg += `Git commit error: ${outcome.git_error || 'Unknown'}. `;
        showToast('Deprecated with warnings', warningMsg, 'warning');
      }

      await loadCards();
      await selectCard(activeCardId);
      if (!document.getElementById('tab-graph').classList.contains('hidden')) {
        renderGraph();
      }
    } else {
      const errorMsg = outcome.error ? outcome.error.message : 'Deprecation failed.';
      showToast('Failure', errorMsg, 'error');
    }
  } catch (err) {
    showToast('System Error', 'Could not connect to the server.', 'error');
  } finally {
    btnDeprecate.disabled = false;
  }
});

// Render Network Graph
async function renderGraph() {
  const container = document.getElementById('graph-container');
  const scaleBanner = document.getElementById('scale-banner');
  
  const params = new URLSearchParams();
  if (activeCardId) {
    params.append('focus_id', activeCardId);
  }
  
  const domain = filterDomain.value;
  if (domain) params.append('domain', domain);
  
  try {
    const res = await fetch(`/api/graph?${params.toString()}`);
    const data = await res.json();

    if (data.isDegraded) {
      scaleBanner.classList.remove('hidden');
    } else {
      scaleBanner.classList.add('hidden');
    }

    const nodes = data.nodes.map(n => {
      // Status Color scheme (Matching redesigned light style)
      let bgColor = '#efecf8'; // surface-container
      let borderColor = '#c7c4d7'; // outline-variant
      if (n.status === 'verified') {
        bgColor = '#e1fbf2'; // emerald extremely soft
        borderColor = '#10b981'; // emerald
      } else if (n.status === 'draft') {
        bgColor = '#fff3eb'; // amber soft
        borderColor = '#f59e0b'; // amber
      }

      const nodeOpt = {
        id: n.id,
        label: n.id,
        shape: 'box',
        color: {
          background: bgColor,
          border: borderColor,
          highlight: {
            background: '#e1e0ff', // primary-fixed
            border: '#4648d4' // primary
          }
        },
        font: {
          color: '#1b1b23', // on-surface
          face: 'Inter',
          size: 13,
          bold: true
        },
        borderWidth: 2,
        margin: 12,
        shadow: {
          enabled: true,
          color: 'rgba(99, 102, 241, 0.08)',
          size: 6,
          x: 2,
          y: 2
        }
      };

      if (n.flags && n.flags.length > 0) {
        if (n.flags.includes('needs_review') || n.flags.includes('untrusted')) {
          nodeOpt.shadow = {
            enabled: true,
            color: '#ba1a1a', // error
            size: 12,
            x: 0,
            y: 0
          };
          nodeOpt.borderWidth = 3;
          nodeOpt.color.border = '#ba1a1a';
        } else if (n.flags.includes('stale') || n.flags.includes('drift')) {
          nodeOpt.shapeProperties = { borderDashes: [4, 4] };
          nodeOpt.color.border = '#ffdcc5'; // orange outline-ish
        }
      }

      return nodeOpt;
    });

    const dataset = {
      nodes: new vis.DataSet(nodes),
      edges: new vis.DataSet(data.edges.map(e => ({
        ...e,
        color: '#767586' // outline variant
      })))
    };

    const options = {
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.01,
          springLength: 100,
          springConstant: 0.08
        }
      },
      interaction: {
        hover: true,
        tooltipDelay: 200
      }
    };

    network = new vis.Network(container, dataset, options);

    network.on('selectNode', (params) => {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const detailTabBtn = document.querySelector('[data-tab="detail"]');
        detailTabBtn.click();
        selectCard(nodeId);
      }
    });

  } catch (err) {
    showToast('System Error', 'Could not render network graph.', 'error');
  }
}

document.getElementById('btn-reset-graph').addEventListener('click', () => {
  if (network) {
    network.fit();
  }
});

const triggerReload = debounce(() => {
  currentPage = 1;
  loadCards();
}, 250);

searchInput.addEventListener('input', triggerReload);
filterVerified.addEventListener('change', triggerReload);
filterDraft.addEventListener('change', triggerReload);
filterDeprecated.addEventListener('change', triggerReload);
filterType.addEventListener('change', triggerReload);
filterDomain.addEventListener('change', triggerReload);

prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    loadCards();
  }
});

nextPageBtn.addEventListener('click', () => {
  currentPage++;
  loadCards();
});

// Init load
loadCards();
