
(function () {
    var APP_MENUS = { main: 'sidebar-main', admin: 'sidebar-admin', curriculum: 'sidebar-curriculum' };
    var APP_DEFAULT_PAGES = { main: 'pct-main', admin: 'admin', curriculum: 'ws-1' };
    var ALL_PAGE_IDS = ['pct-main','admin','ws-1','ws-2','ws-3','ws-4','ws-5','ws-6','ws-7','ws-8','ws-9','ws-10'];

    // Maps a hardware type (query param set by renderer-hardware.js when it
    // sends you here for Curriculum) back to that sensor's own page file.
    var HW_ORIGIN_PAGES = {
        pressure:      'pressure.html',
        level:         'level.html',
        flow:          'flow.html',
        'servo-speed': 'servo-speed.html',
        'servo-angle': 'servo-angle.html'
    };
    var CURRICULUM_ORIGIN_KEY = 'pct-curriculum-origin-app';

    function setSidebarVisible(visible) {
        var sb = document.getElementById('sidebar');
        if (!sb) return;
        if (visible) {
            sb.classList.remove('w-0', 'overflow-hidden');
            sb.classList.add('w-64');
        } else {
            sb.classList.remove('w-64');
            sb.classList.add('w-0', 'overflow-hidden');
        }
    }

    function showPage(pageId, adminTab) {
        ALL_PAGE_IDS.forEach(function(id) {
            var el = document.getElementById('page-' + id);
            if (el) el.classList.add('hidden');
        });
        var target = document.getElementById('page-' + pageId);
        if (target) target.classList.remove('hidden');

        // Hide sidebar in admin, restore it otherwise
        if (pageId === 'admin') {
            setSidebarVisible(false);
        } else {
            var wasCollapsed = localStorage.getItem('matrix-sidebar-collapsed') === 'true';
            setSidebarVisible(!wasCollapsed);
        }

        if (adminTab && typeof switchTab === 'function') {
            var tabBtns = document.querySelectorAll('.tab-button');
            tabBtns.forEach(function(btn) {
                var oc = btn.getAttribute('onclick') || '';
                if (oc.indexOf("'" + adminTab + "'") !== -1) switchTab(adminTab, btn);
            });
        }

        document.querySelectorAll('.sidebar-link').forEach(function(a) { a.classList.remove('active'); });
        if (adminTab) {
            var adminLink = document.querySelector('.sidebar-link[data-admin-tab="' + adminTab + '"]');
            if (adminLink) adminLink.classList.add('active');
        } else {
            var links = document.querySelectorAll('.sidebar-link[data-page="' + pageId + '"]:not([data-control-mode]):not([data-admin-tab]):not([data-app])');
            if (links.length) links[0].classList.add('active');
        }
    }

    document.addEventListener('DOMContentLoaded', function() {
        var backBtn = document.getElementById('adminBackBtn');
        if (backBtn) backBtn.addEventListener('click', function() { switchToApp('main'); });

        // When opened from another sensor page's Curriculum link, remember where
        // to send "Main App" back to, and switch directly to curriculum.
        if (window.location.hash === '#curriculum') {
            var params = new URLSearchParams(window.location.search);
            var originType = params.get('from');
            if (originType && HW_ORIGIN_PAGES[originType]) {
                sessionStorage.setItem(CURRICULUM_ORIGIN_KEY, originType);
            } else {
                sessionStorage.removeItem(CURRICULUM_ORIGIN_KEY);
            }
            switchToApp('curriculum');
        } else {
            // Arrived at the temperature app directly (not via another app's
            // Curriculum link) — any remembered origin is now stale.
            sessionStorage.removeItem(CURRICULUM_ORIGIN_KEY);
        }

        // Remote Access card is only meaningful on the PC app (Electron)
        if (!navigator.userAgent.includes('Electron')) {
            var card = document.getElementById('remoteAccessCard');
            if (card) card.style.display = 'none';
        }
    });

    function switchToApp(appKey) {
        if (appKey === 'main') {
            var originType = sessionStorage.getItem(CURRICULUM_ORIGIN_KEY);
            if (originType && HW_ORIGIN_PAGES[originType]) {
                sessionStorage.removeItem(CURRICULUM_ORIGIN_KEY);
                window._skipDisconnectOnUnload = true;
                window.location.href = HW_ORIGIN_PAGES[originType];
                return;
            }
        }
        Object.keys(APP_MENUS).forEach(function(app) {
            var menu = document.getElementById(APP_MENUS[app]);
            if (menu) menu.classList.toggle('hidden', app !== appKey);
        });
        showPage(APP_DEFAULT_PAGES[appKey]);
        document.querySelectorAll('#sidebar-apps .sidebar-link').forEach(function(t) {
            t.classList.toggle('active', t.dataset.app === appKey);
        });
    }

    document.addEventListener('click', function(e) {
        var link = e.target.closest('.sidebar-link');
        if (!link) return;
        e.preventDefault();
        var pageId = link.dataset.page;
        var adminTab = link.dataset.adminTab;
        var controlMode = link.dataset.controlMode;
        var appKey = link.dataset.app;
        if (!pageId) return;

        if (appKey && APP_MENUS[appKey]) {
            switchToApp(appKey);
        }
        showPage(pageId, adminTab);

        if (controlMode) {
            var modeBtn = document.querySelector('.mode-btn[data-mode="' + controlMode + '"]');
            if (modeBtn) modeBtn.click();
        }

        var sidebar = document.getElementById('sidebar');
        if (window.innerWidth < 768 && sidebar) {
            sidebar.classList.add('-translate-x-full');
            var bd = document.getElementById('sidebar-backdrop');
            if (bd) bd.classList.add('hidden');
        }
    });

    var sidebar = document.getElementById('sidebar');
    var sidebarToggle = document.getElementById('sidebar-toggle');
    var sidebarBackdrop = document.getElementById('sidebar-backdrop');
    var sidebarCloseBtn = document.getElementById('sidebar-close-btn');

    function toggleSidebar() {
        if (window.innerWidth < 768) {
            var isOpen = !sidebar.classList.contains('-translate-x-full');
            sidebar.classList.toggle('-translate-x-full', isOpen);
            if (sidebarBackdrop) sidebarBackdrop.classList.toggle('hidden', isOpen);
        } else {
            var isCollapsed = sidebar.classList.contains('w-0');
            if (isCollapsed) {
                sidebar.classList.remove('w-0', 'overflow-hidden');
                sidebar.classList.add('w-64');
                localStorage.setItem('matrix-sidebar-collapsed', 'false');
            } else {
                sidebar.classList.remove('w-64');
                sidebar.classList.add('w-0', 'overflow-hidden');
                localStorage.setItem('matrix-sidebar-collapsed', 'true');
            }
        }
    }

    if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebar);
    if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', function() {
        sidebar.classList.add('-translate-x-full');
        if (sidebarBackdrop) sidebarBackdrop.classList.add('hidden');
    });
    if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', function() {
        sidebar.classList.add('-translate-x-full');
        sidebarBackdrop.classList.add('hidden');
    });

    var savedCollapsed = localStorage.getItem('matrix-sidebar-collapsed');
    if (savedCollapsed === 'true' && window.innerWidth >= 768) {
        sidebar.classList.add('w-0', 'overflow-hidden');
        sidebar.classList.remove('w-64');
    }

    var adminBtn = document.getElementById('adminBtn');
    if (adminBtn) {
        adminBtn.addEventListener('click', function(e) {
            e.stopImmediatePropagation();
            switchToApp('admin');
        }, true);
    }

    window.switchToApp = switchToApp;

    // Temperature unit — apply saved preference and sync radio buttons
    if (typeof updateTempUnitUI === 'function') {
        updateTempUnitUI();
    } else {
        // renderer.js may not be ready yet; defer until it is
        document.addEventListener('rendererReady', function() {
            if (typeof updateTempUnitUI === 'function') updateTempUnitUI();
        });
    }

    // Theme switcher (matches template pattern exactly)
    var themeSelect = document.getElementById('theme-select');
    var htmlEl = document.documentElement;
    var savedTheme = localStorage.getItem('matrix-theme') || 'dark';
    htmlEl.setAttribute('data-theme', savedTheme);
    if (themeSelect) {
        themeSelect.value = savedTheme;
        themeSelect.addEventListener('change', function() {
            var newTheme = themeSelect.value;
            htmlEl.setAttribute('data-theme', newTheme);
            localStorage.setItem('matrix-theme', newTheme);
        });
    }

    // Hardware ID Assignment
    function assignHardwareId() {
        var sel = document.getElementById('hw-id-assign-select');
        var btn = document.getElementById('hw-id-assign-btn');
        var id = parseInt(sel.value, 10);
        if (!window.electronAPI || isNaN(id)) return;
        btn.disabled = true; btn.textContent = 'Sending…';
        window.electronAPI.sendCustomJson({ A: id }, 'assign-hardware-id').then(function() {
            btn.textContent = '✓ Done';
            setTimeout(function() { btn.disabled = false; btn.textContent = 'Write ID to Hardware'; }, 2000);
        }, function() {
            btn.textContent = '✗ Failed'; btn.disabled = false;
        });
    }
    window.assignHardwareId = assignHardwareId;

    // Populate detected HW ID if hardware-id-received fires on this page
    if (window.electronAPI && window.electronAPI.onHardwareIdReceived) {
        window.electronAPI.onHardwareIdReceived(function(data) {
            var el = document.getElementById('detected-hw-id');
            if (el && data && data.id) el.textContent = data.info ? data.info.name + ' (ID ' + data.id + ')' : 'ID ' + data.id;
        });
    }

    // Hardware type selector — navigate to the matching hardware frontend
    var hwSelect = document.getElementById('hardwareTypeSelect');
    if (hwSelect) {
        var hwPages = {
            temperature:   'index.html',
            pressure:      'pressure.html',
            level:         'level.html',
            flow:          'flow.html',
            'servo-angle': 'servo-angle.html',
            'servo-speed': 'servo-speed.html'
        };
        var hwTypeCodes = {
            temperature:   201,
            pressure:      202,
            level:         203,
            flow:          204,
            'servo-angle': 206,
            'servo-speed': 205
        };
        hwSelect.addEventListener('change', function() {
            var type = hwSelect.value;
            var code = hwTypeCodes[type];
            function doNavigate() {
                if (type === 'temperature') return; // already here
                window._skipDisconnectOnUnload = true;
                if (window.electronAPI && window.electronAPI.loadHardwarePage) {
                    window.electronAPI.loadHardwarePage(type);
                } else {
                    window.location.href = hwPages[type] || 'index.html';
                }
            }
            if (code !== undefined && window.electronAPI && window.electronAPI.sendCustomJson) {
                window.electronAPI.sendCustomJson({ A: code }, 'hardware-type').then(function (result) {
                    if (!result || !result.success) {
                        console.warn('[HW TYPE] command failed:', result && result.error || 'not connected');
                    }
                    doNavigate();
                }, function (err) {
                    console.error('[HW TYPE] command error:', err);
                    doNavigate();
                });
            } else {
                doNavigate();
            }
        });
    }
})();

