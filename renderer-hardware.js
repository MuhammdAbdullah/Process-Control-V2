// renderer-hardware.js
// Shared renderer for Pressure, Level, Flow, Servo Angle, Servo Speed hardware types.
// Each HTML page defines window.HARDWARE_CONFIG before loading this script.
// Matches index.html chart styling, legend config, PID term display, and navigation.

(function () {
  'use strict';

  var CFG = window.HARDWARE_CONFIG;
  if (!CFG) { console.error('No HARDWARE_CONFIG defined'); return; }

  // ── State ────────────────────────────────────────────────────────────────────
  var currentMode = 'manual';     // 'manual' | 'onoff' | 'pid'
  var skipNextPoint = false;
  var chartJsRef = null;          // Primary chart (matches index.html name)
  var liveChartRef = null;        // Secondary chart
  var chartDisplayMode = 'all';   // 'limited' | 'all'
  var maxPoints = 50;
  var CHART_RENDER_INTERVAL_MS = 100; // Keep chart paint work at 10 fps while still processing/logging every sample.
  var lastChartRenderMs = 0;
  var chartRenderTimer = null;
  var isSavingCsv = false;
  var csvRows = [];
  var csvSessionMode = null;
  var csvSavePath = null; // path chosen at Start (Electron only); rows are appended to disk as they arrive
  var valveOpen = false;
  var lastSetpoint = null;
  var lastHysteresis = 1;

  // PID state — hardware sends two separate JSON messages per cycle
  // First: {T, P, F}  Second: {Pr, It, Dr, Ot}
  var lastPidValues = { proportional: 0, integral: 0, derivative: 0, output: 0 };
  var currentPidControlType = 'PID'; // 'P' | 'PI' | 'PD' | 'PID'
  var lastPidFrequency = 1;

  var api = window.electronAPI || null;
  var isElectron = !!api;

  // ── Admin state ──────────────────────────────────────────────────────────────
  var bootloaderConnected = false;
  var hexFileLoaded = false;
  var hexFilePath = '';
  var lastProportionalValue = '', lastIntegralValue = '', lastDifferentialValue = '';
  var wasConnected = false;
  var hasSeenConnection = false;
  var reconnectTimer = null;
  var PID_FACTORY_DEFAULTS = { P: 3.162, I: 0.01, D: 150 };

  function productPidDefaults() {
    var configured = CFG.pidDefaults || {};
    var frequencyEl = el('pidFrequency');
    return {
      P: typeof configured.P === 'number' ? configured.P : 3.162,
      I: typeof configured.I === 'number' ? configured.I : 0.01,
      D: typeof configured.D === 'number' ? configured.D : 150,
      frequency: typeof configured.frequency === 'number' ? configured.frequency :
        (frequencyEl ? parseFloat(frequencyEl.value) || 1 : 1)
    };
  }

  function productPidStorageKey(term) {
    return 'pid-' + CFG.type + '-' + term;
  }

  function loadProductPidValues() {
    var defaults = productPidDefaults();
    var values = {
      P: parseFloat(localStorage.getItem(productPidStorageKey('P'))),
      I: parseFloat(localStorage.getItem(productPidStorageKey('I'))),
      D: parseFloat(localStorage.getItem(productPidStorageKey('D'))),
      frequency: parseFloat(localStorage.getItem(productPidStorageKey('frequency')))
    };
    if (isNaN(values.P)) values.P = defaults.P;
    if (isNaN(values.I)) values.I = defaults.I;
    if (isNaN(values.D)) values.D = defaults.D;
    if (isNaN(values.frequency)) values.frequency = defaults.frequency;

    var p = el('pidPInput'), i = el('pidIInput'), d = el('pidDInput'), f = el('pidFrequency');
    if (p) p.value = values.P;
    if (i) i.value = values.I;
    if (d) d.value = values.D;
    if (f) f.value = String(values.frequency);
    lastPidFrequency = values.frequency;
  }

  function saveProductPidValue(term, value) {
    if (typeof value === 'number' && !isNaN(value)) {
      localStorage.setItem(productPidStorageKey(term), String(value));
    }
  }

  function resetProductPidValues() {
    ['P', 'I', 'D', 'frequency'].forEach(function (term) {
      localStorage.removeItem(productPidStorageKey(term));
    });
    loadProductPidValues();
    commitPID();
    var frequency = parseFloat((el('pidFrequency') || {}).value);
    if (!isNaN(frequency) && frequency > 0) {
      lastPidFrequency = frequency;
      queueSend({ PID_Hz: frequency }, 'PID Frequency Reset');
    }
    addLog('PID defaults restored for ' + CFG.name, 'success');
  }

  // ── DOM helper ────────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  // ── Theme colors (matches renderer.js getChartThemeColors) ──────────────────
  function getChartThemeColors() {
    var theme = document.documentElement.getAttribute('data-theme');
    var isDark = theme !== 'light';
    return {
      background: 'transparent',
      border: 'transparent',
      grid: 'rgba(148, 163, 184, 0.1)',
      text: isDark ? '#ffffff' : '#1e293b'
    };
  }

  // ── Command throttling ────────────────────────────────────────────────────────
  var SERIAL_MIN_MS = 40;
  var lastSendTime = 0;
  var sendQueue = Promise.resolve();

  function sendJson(obj, label) {
    if (isElectron) {
      api.sendCustomJson(obj, label || JSON.stringify(obj));
    } else {
      fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj)
      }).catch(function () {});
    }
  }

  function queueSend(obj, label) {
    sendQueue = sendQueue.then(function () {
      var now = Date.now();
      var wait = Math.max(0, SERIAL_MIN_MS - (now - lastSendTime));
      return new Promise(function (r) { setTimeout(r, wait); });
    }).then(function () {
      lastSendTime = Date.now();
      sendJson(obj, label);
    });
  }

  // ── Connection status ─────────────────────────────────────────────────────────
  function setConnected(connected, msg) {
    var badge = el('systemStatusIndicator');
    if (badge) {
      badge.textContent = connected ? 'SYSTEM ONLINE' : 'SYSTEM OFFLINE';
      badge.className = 'badge badge-sm gap-1 font-bold tracking-wider uppercase ' +
        (connected ? 'badge-success' : 'badge-error');
    }
    addLog(msg || (connected ? 'Connected' : 'Disconnected'), connected ? 'success' : 'error');

    if (!wasConnected && connected) {
      if (!hasSeenConnection) {
        hasSeenConnection = true;

        // Clear chart data without destroying/recreating (safe during unstable reconnect)
        if (chartJsRef)  { chartJsRef.data.labels = []; chartJsRef.data.datasets.forEach(function(d) { d.data = []; }); chartJsRef.update(); }
        if (liveChartRef){ liveChartRef.data.labels = []; liveChartRef.data.datasets.forEach(function(d) { d.data = []; }); liveChartRef.update(); }

        // Reset UI to manual without sending any serial commands yet
        currentMode = 'manual';
        skipNextPoint = true;
        document.querySelectorAll('.mode-btn').forEach(function(btn) {
          var active = btn.getAttribute('data-mode') === 'manual';
          btn.classList.toggle('btn-active', active);
          btn.classList.toggle('btn-primary', active);
        });
        ['manual', 'onoff', 'pid'].forEach(function(m) {
          var panel = el(m + 'ControlMode');
          if (panel) panel.style.display = m === 'manual' ? 'flex' : 'none';
        });

        // Send C:1 after port stabilises — debounced so reconnect loops don't stack
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function() {
          reconnectTimer = null;
          // Firmware only writes the PWM/output register when the incoming value
          // differs from its last-cached value. Send safe output resets before the
          // mode command so selecting Manual cannot briefly leave a pump enabled.
          if (CFG.valveToggle) queueSend({ H: 0 }, 'Valve closed');
          if (CFG.secondaryOutput) {
            queueSend({ F: 1 }, CFG.secondaryOutput.label + ' force update');
            queueSend({ F: 0 }, CFG.secondaryOutput.label);
          }
          queueSend({ P: 1 }, CFG.primaryOutput.label + ' force update');
          queueSend({ P: 0 }, CFG.primaryOutput.label);
          var safeSetpoint = safeSetpointValue();
          queueSend({ T: pulseSetpointValue(safeSetpoint) }, 'Setpoint force update');
          queueSend({ T: safeSetpoint }, 'Setpoint');
          queueSend({ C: 1 }, 'Control Mode');
          addLog('Device connected — charts cleared, reset to Manual mode', 'info');
        }, 1000);
      } else {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        skipNextPoint = true;
        addLog('Device reconnected — preserving ' + currentMode.toUpperCase() + ' mode', 'info');
      }
    }

    wasConnected = connected;
  }

  // ── Sensor / setpoint display ─────────────────────────────────────────────────
  function showSensor(val) {
    var display = el('sensorValueBig');
    var dec = (CFG.sensor.decimals !== undefined) ? CFG.sensor.decimals : 1;
    if (display) display.textContent = (typeof val === 'number') ? val.toFixed(dec) : '--.-';
    var ts = el('lastUpdate');
    if (ts && typeof val === 'number') ts.textContent = new Date().toLocaleTimeString();
  }

  function showSetpoint(val) {
    var display = el('setpointBig');
    if (!display) return;
    display.textContent = (typeof val === 'number')
      ? (val.toFixed(1) + ' ' + CFG.sensor.unit)
      : ('-- ' + CFG.sensor.unit);
  }

  function setControlValue(inputId, displayId, value) {
    var input = el(inputId);
    var display = el(displayId);
    if (input) input.value = value;
    if (display) display.value = value;
  }

  function closeValveButtons() {
    valveOpen = false;
    ['valveToggleBtn', 'onoffValveBtn', 'pidValveBtn'].forEach(function (id) {
      var btn = el(id);
      if (!btn) return;
      btn.textContent = 'Valve: CLOSED';
      btn.className = 'btn btn-sm w-full btn-error';
    });
  }

  function safeSetpointValue() {
    if (typeof CFG.safeSetpoint === 'number') return CFG.safeSetpoint;
    if (CFG.type === 'servo-angle') return 0;
    return (CFG.sensor && typeof CFG.sensor.min === 'number') ? Math.max(0, CFG.sensor.min) : 0;
  }

  function pulseSetpointValue(safeSetpoint) {
    var max = (CFG.sensor && typeof CFG.sensor.max === 'number') ? CFG.sensor.max : safeSetpoint + 1;
    if (safeSetpoint < max) return safeSetpoint + 1;
    return safeSetpoint;
  }

  function resetControlsForModeSwitch() {
    var safeSetpoint = safeSetpointValue();

    setControlValue('primarySlider', 'primaryDisplay', 0);
    setControlValue('secondarySlider', 'secondaryDisplay', 0);
    setControlValue('onoffSecondarySlider', 'onoffSecondaryDisplay', 0);
    setControlValue('pidSecondarySlider', 'pidSecondaryDisplay', 0);
    setControlValue('onoffSetpointSlider', 'onoffSetpointDisplay', safeSetpoint);
    setControlValue('pidSetpointSlider', 'pidSetpointDisplay', safeSetpoint);
    closeValveButtons();

    lastSetpoint = safeSetpoint;
    showSetpoint(safeSetpoint);
    lastPidValues = { proportional: 0, integral: 0, derivative: 0, output: 0 };

    if (CFG.valveToggle) queueSend({ H: 0 }, 'Valve closed');
    if (CFG.secondaryOutput) {
      queueSend({ F: 1 }, CFG.secondaryOutput.label + ' force update');
      queueSend({ F: 0 }, CFG.secondaryOutput.label);
    }
    queueSend({ P: 1 }, CFG.primaryOutput.label + ' force update');
    queueSend({ P: 0 }, CFG.primaryOutput.label);
    queueSend({ T: pulseSetpointValue(safeSetpoint) }, 'Setpoint force update');
    queueSend({ T: safeSetpoint }, 'Setpoint');
  }

  function updatePIDInputsVisibility() {
    var ct = currentPidControlType;
    var pC = el('pidPInputContainer'), iC = el('pidIInputContainer'), dC = el('pidDInputContainer');
    if (pC) pC.style.display = 'flex';
    if (iC) iC.style.display = (ct === 'PI' || ct === 'PID') ? 'flex' : 'none';
    if (dC) dC.style.display = (ct === 'PD' || ct === 'PID') ? 'flex' : 'none';
  }

  // ── Chart legend builder (matches renderer.js exactly) ───────────────────────
  function makeLegendConfig(themeColors) {
    return {
      position: 'top',
      labels: {
        color: themeColors.text,
        font: { size: 14, family: 'Inter, sans-serif' },
        padding: 12,
        usePointStyle: true,
        generateLabels: function (chart) {
          var original = Chart.defaults.plugins.legend.labels.generateLabels;
          var labels = original.call(this, chart);
          labels.forEach(function (label, index) {
            var meta = chart.getDatasetMeta(index);
            var isHidden = meta.hidden === true ||
              (meta.hidden === null && chart.data.datasets[index].hidden === true);
            label.fillStyle = isHidden ? 'transparent' : label.strokeStyle;
          });
          return labels;
        }
      },
      onClick: function (e, legendItem, legend) {
        var index = legendItem.datasetIndex;
        var ci = legend.chart;
        var meta = ci.getDatasetMeta(index);
        meta.hidden = (meta.hidden === null) ? !ci.data.datasets[index].hidden : null;
        ci.update();
      }
    };
  }

  function makeXScale(themeColors) {
    return {
      grid: { display: false },
      ticks: {
        color: themeColors.text,
        font: { size: 14, family: 'Inter, sans-serif' },
        autoSkip: true,
        maxTicksLimit: 10
      }
    };
  }

  function makeYScale(themeColors, titleText, unit, beginAtZero) {
    return {
      type: 'linear',
      position: 'left',
      title: {
        display: true,
        text: titleText,
        color: themeColors.text,
        font: { size: 16, weight: 'bold', family: 'Inter, sans-serif' }
      },
      grid: { color: 'rgba(148, 163, 184, 0.1)', display: true },
      ticks: {
        color: themeColors.text,
        font: { size: 14, family: 'Inter, sans-serif' },
        callback: function (value) {
          return Math.round(value) + (unit || '');
        }
      },
      beginAtZero: !!beginAtZero
    };
  }

  // ── Chart destroy helper ──────────────────────────────────────────────────────
  function destroyCharts() {
    if (chartRenderTimer) {
      clearTimeout(chartRenderTimer);
      chartRenderTimer = null;
    }
    function killChart(ref) {
      if (!ref) return;
      try {
        if (ref.data && ref.data.datasets) {
          ref.data.datasets.forEach(function (d) { d.data = []; });
        }
        ref.update('none');
        ref.destroy();
      } catch (e) {}
    }
    killChart(chartJsRef);  chartJsRef  = null;
    killChart(liveChartRef); liveChartRef = null;

    // Also kill any orphan chart on the canvases
    ['testChartPrimary', 'testChartSecondary'].forEach(function (id) {
      var canvas = el(id);
      if (!canvas || !window.Chart) return;
      var existing = Chart.getChart(canvas);
      if (existing) { try { existing.destroy(); } catch (e) {} }
      var ctx = canvas.getContext('2d');
      if (ctx) { ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.restore(); }
    });
  }

  // ── Auto-scale Y axis ─────────────────────────────────────────────────────────
  function autoScaleY(chart) {
    if (!chart || !chart.data || !chart.data.datasets) return;
    var values = [];
    chart.data.datasets.forEach(function (ds, i) {
      var meta = chart.getDatasetMeta(i);
      if (!meta.hidden && !ds.hidden) {
        ds.data.forEach(function (v) {
          if (v !== null && v !== undefined && !isNaN(v)) values.push(v);
        });
      }
    });
    if (!values.length) return;
    var lo = Math.min.apply(null, values);
    var hi = Math.max.apply(null, values);
    var pad = Math.max((hi - lo) * 0.15, 2);
    lo = Math.floor(lo - pad);
    hi = Math.ceil(hi + pad);
    if (hi - lo < 5) hi = lo + 5;
    if (chart.options.scales && chart.options.scales.y) {
      chart.options.scales.y.min = lo;
      chart.options.scales.y.max = hi;
    }
  }

  function renderChartsNow() {
    if (chartJsRef) chartJsRef.update('none');
    if (liveChartRef) liveChartRef.update('none');
  }

  function scheduleChartRender() {
    var now = Date.now();
    var wait = Math.max(0, CHART_RENDER_INTERVAL_MS - (now - lastChartRenderMs));
    if (wait === 0) {
      if (chartRenderTimer) {
        clearTimeout(chartRenderTimer);
        chartRenderTimer = null;
      }
      lastChartRenderMs = now;
      renderChartsNow();
      return;
    }
    if (!chartRenderTimer) {
      chartRenderTimer = setTimeout(function () {
        chartRenderTimer = null;
        lastChartRenderMs = Date.now();
        renderChartsNow();
      }, wait);
    }
  }

  // ── Time label ────────────────────────────────────────────────────────────────
  function timeLabel() {
    var now = new Date();
    return now.getHours().toString().padStart(2,'0') + ':' +
           now.getMinutes().toString().padStart(2,'0') + ':' +
           now.getSeconds().toString().padStart(2,'0');
  }

  function localTimestamp() {
    var now = new Date();
    return now.getFullYear() + '-' +
      (now.getMonth() + 1).toString().padStart(2, '0') + '-' +
      now.getDate().toString().padStart(2, '0') + 'T' +
      now.getHours().toString().padStart(2, '0') + ':' +
      now.getMinutes().toString().padStart(2, '0') + ':' +
      now.getSeconds().toString().padStart(2, '0') + '.' +
      now.getMilliseconds().toString().padStart(3, '0');
  }

  // ── Init charts ───────────────────────────────────────────────────────────────
  function initCharts(mode) {
    destroyCharts();
    var Chart = window.Chart;
    if (!Chart) return;

    var primaryCanvas   = el('testChartPrimary');
    var secondaryCanvas = el('testChartSecondary');
    if (!primaryCanvas || !secondaryCanvas) return;

    var tc = getChartThemeColors();
    var sLabel = CFG.sensor.label + ' (' + CFG.sensor.unit + ')';

    // ── PRIMARY CHART ──────────────────────────────────────────────────────────
    var primaryDatasets = [{
      label: 'Actual ' + CFG.sensor.label,
      data: [],
      borderColor: 'rgb(59, 130, 246)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.35,
      fill: false,
      hidden: false
    }];

    if (mode !== 'manual') {
      primaryDatasets.push({
        label: 'Setpoint',
        data: [],
        borderColor: 'rgb(251, 191, 36)',
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        tension: 0.35,
        fill: false,
        spanGaps: true,
        hidden: false
      });
    }

    // On/Off adds hysteresis band line
    if (mode === 'onoff') {
      primaryDatasets.push({
        label: 'Hysteresis Low',
        data: [],
        borderColor: 'rgb(249, 115, 22)',
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderDash: [5, 5],
        pointRadius: 0,
        tension: 0.35,
        fill: false,
        spanGaps: true,
        hidden: false
      });
    }

    chartJsRef = new Chart(primaryCanvas.getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: primaryDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: makeLegendConfig(tc) },
        scales: {
          x: makeXScale(tc),
          y: makeYScale(tc, sLabel, '', false)
        }
      }
    });

    // ── SECONDARY CHART ────────────────────────────────────────────────────────
    var secondaryDatasets = [];

    if (mode === 'pid') {
      // PID mode: Output + active PID term lines (matches renderer.js exactly)
      var pidColors = {
        Output: '#8b5cf6',
        Proportional: '#eab308',
        Integral: '#16a34a',
        Derivative: '#0891b2'
      };
      var ct = currentPidControlType;
      var pidSeries = [{ label: 'Output', color: pidColors.Output },
                       { label: 'Proportional', color: pidColors.Proportional }];
      if (ct === 'PI' || ct === 'PID') pidSeries.push({ label: 'Integral',    color: pidColors.Integral });
      if (ct === 'PD' || ct === 'PID') pidSeries.push({ label: 'Derivative',  color: pidColors.Derivative });

      pidSeries.forEach(function (s) {
        secondaryDatasets.push({
          label: s.label,
          data: [],
          borderColor: s.color,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.35,
          fill: false,
          hidden: false
        });
      });

      liveChartRef = new Chart(secondaryCanvas.getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: secondaryDatasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'nearest', intersect: false },
          plugins: { legend: makeLegendConfig(tc) },
          scales: {
            x: makeXScale(tc),
            y: makeYScale(tc, 'Control Terms', '', false)
          }
        }
      });

    } else if (CFG.secondaryOutput) {
      // Level / Flow: primary output + valve %
      var outLabel = CFG.primaryOutput.label + ' (' + CFG.primaryOutput.unit + ')';
      var valLabel = CFG.secondaryOutput.label + ' (' + CFG.secondaryOutput.unit + ')';
      secondaryDatasets = [
        { label: outLabel,   data: [], borderColor: 'rgb(16, 185, 129)', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.35, fill: false, hidden: false },
        { label: valLabel,   data: [], borderColor: 'rgb(251, 191, 36)', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.35, fill: false, hidden: false }
      ];

      liveChartRef = new Chart(secondaryCanvas.getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: secondaryDatasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: makeLegendConfig(tc) },
          scales: {
            x: makeXScale(tc),
            y: makeYScale(tc, outLabel, '', true)
          }
        }
      });

    } else {
      // Pressure / Servo: just primary output
      var outLabel2 = CFG.primaryOutput.label + (CFG.primaryOutput.unit ? ' (' + CFG.primaryOutput.unit + ')' : '');
      secondaryDatasets = [{
        label: outLabel2,
        data: [],
        borderColor: 'rgb(16, 185, 129)',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.35,
        fill: false,
        hidden: false
      }];

      liveChartRef = new Chart(secondaryCanvas.getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: secondaryDatasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: makeLegendConfig(tc) },
          scales: {
            x: makeXScale(tc),
            y: makeYScale(tc, outLabel2, '', false)
          }
        }
      });
    }
  }

  // ── Add data point ────────────────────────────────────────────────────────────
  function addChartPoint(sensorVal, outputVal, valveVal) {
    if (skipNextPoint) { skipNextPoint = false; return; }
    if (!chartJsRef || !liveChartRef) return;

    var tl = timeLabel();

    // Push time label to both charts
    chartJsRef.data.labels.push(tl);
    liveChartRef.data.labels.push(tl);
    if (chartDisplayMode === 'limited') {
      if (chartJsRef.data.labels.length > maxPoints)   chartJsRef.data.labels.shift();
      if (liveChartRef.data.labels.length > maxPoints) liveChartRef.data.labels.shift();
    }

    // Primary chart
    if (chartJsRef.data.datasets[0]) chartJsRef.data.datasets[0].data.push(sensorVal);
    if (currentMode !== 'manual') {
      if (chartJsRef.data.datasets[1]) chartJsRef.data.datasets[1].data.push(lastSetpoint);
    }
    if (currentMode === 'onoff') {
      if (chartJsRef.data.datasets[2]) {
        var hystLow = (typeof lastSetpoint === 'number' ? lastSetpoint : 0) - lastHysteresis;
        var hystMin = (CFG.sensor && typeof CFG.sensor.min === 'number') ? CFG.sensor.min : 0;
        chartJsRef.data.datasets[2].data.push(Math.max(hystMin, hystLow));
      }
    }

    // Secondary chart
    if (currentMode === 'pid') {
      var ct = currentPidControlType;
      if (liveChartRef.data.datasets[0]) liveChartRef.data.datasets[0].data.push(lastPidValues.output);
      if (liveChartRef.data.datasets[1]) liveChartRef.data.datasets[1].data.push(lastPidValues.proportional);
      if ((ct === 'PI' || ct === 'PID') && liveChartRef.data.datasets[2])
        liveChartRef.data.datasets[2].data.push(lastPidValues.integral);
      if (ct === 'PD' || ct === 'PID') {
        var di = (ct === 'PID') ? 3 : 2;
        if (liveChartRef.data.datasets[di]) liveChartRef.data.datasets[di].data.push(lastPidValues.derivative);
      }
    } else if (CFG.secondaryOutput) {
      if (liveChartRef.data.datasets[0]) liveChartRef.data.datasets[0].data.push(outputVal);
      if (liveChartRef.data.datasets[1]) liveChartRef.data.datasets[1].data.push(typeof valveVal === 'number' ? valveVal : 0);
    } else {
      if (liveChartRef.data.datasets[0]) liveChartRef.data.datasets[0].data.push(outputVal);
    }

    // Trim if limited
    function trimChart(ch) {
      if (!ch || chartDisplayMode !== 'limited') return;
      ch.data.datasets.forEach(function (d) { if (d.data.length > maxPoints) d.data.shift(); });
    }
    trimChart(chartJsRef);
    trimChart(liveChartRef);

    autoScaleY(chartJsRef);
    autoScaleY(liveChartRef);
    scheduleChartRender();

    // CSV
    if (isSavingCsv) {
      var csvRow = [
        localTimestamp(),
        (typeof sensorVal === 'number' ? sensorVal.toFixed(2) : ''),
        (typeof outputVal  === 'number' ? outputVal.toFixed(2)  : '')
      ];
      if (csvSessionMode !== 'manual') {
        csvRow.push(lastSetpoint !== null ? lastSetpoint : '');
      }
      if (csvSessionMode === 'onoff') {
        csvRow.push(typeof lastHysteresis === 'number' ? lastHysteresis : '');
      }
      if (csvSessionMode === 'pid') {
        var pidPSetVal = parseFloat((el('pidPInput') || {}).value);
        var pidISetVal = parseFloat((el('pidIInput') || {}).value);
        var pidDSetVal = parseFloat((el('pidDInput') || {}).value);
        csvRow.push(
          currentPidControlType,
          lastPidValues.output.toFixed(2),
          lastPidValues.proportional.toFixed(2),
          lastPidValues.integral.toFixed(2),
          lastPidValues.derivative.toFixed(2),
          lastPidFrequency,
          isNaN(pidPSetVal) ? '' : pidPSetVal.toFixed(2),
          isNaN(pidISetVal) ? '' : pidISetVal.toFixed(2),
          isNaN(pidDSetVal) ? '' : pidDSetVal.toFixed(2)
        );
      }
      if (CFG.secondaryOutput) {
        csvRow.push(typeof valveVal === 'number' ? valveVal.toFixed(2) : '');
      }
      var csvLine = csvRow.join(',');
      if (csvSavePath && api && api.appendFile) {
        // Flush straight to disk so data already captured survives a sudden app close.
        api.appendFile(csvSavePath, csvLine + '\n').then(function (result) {
          if (!result || !result.success) {
            addLog('Error appending CSV row: ' + ((result && result.error) || 'Unknown error'), 'error');
          }
        }).catch(function (err) {
          addLog('Error appending CSV row: ' + (err && err.message || err), 'error');
        });
      } else {
        csvRows.push(csvLine);
      }
    }
  }

  // ── Update chart theme colors (when theme changes) ────────────────────────────
  function updateChartTheme() {
    var tc = getChartThemeColors();
    [chartJsRef, liveChartRef].forEach(function (ch) {
      if (!ch) return;
      if (ch.options.plugins && ch.options.plugins.legend && ch.options.plugins.legend.labels)
        ch.options.plugins.legend.labels.color = tc.text;
      if (ch.options.scales) {
        if (ch.options.scales.x) {
          if (ch.options.scales.x.ticks) ch.options.scales.x.ticks.color = tc.text;
        }
        if (ch.options.scales.y) {
          if (ch.options.scales.y.ticks) ch.options.scales.y.ticks.color = tc.text;
          if (ch.options.scales.y.title) ch.options.scales.y.title.color = tc.text;
        }
      }
      ch.update('none');
    });
  }

  // ── Data handler ──────────────────────────────────────────────────────────────
  function handleJsonData(data) {
    if (!data) return;

    // PID component message: {Pr, It, Dr, Ot}
    if (data.Pr !== undefined || data.It !== undefined || data.Dr !== undefined || data.Ot !== undefined) {
      lastPidValues.proportional = typeof data.Pr === 'number' ? data.Pr : lastPidValues.proportional;
      lastPidValues.integral     = typeof data.It === 'number' ? data.It : lastPidValues.integral;
      lastPidValues.derivative   = typeof data.Dr === 'number' ? data.Dr : lastPidValues.derivative;
      lastPidValues.output       = typeof data.Ot === 'number' ? data.Ot : lastPidValues.output;
      return; // wait for the main T/P/F message to add chart point
    }

    var sensorVal = (typeof data.T === 'number') ? data.T : null;
    var outputVal = (typeof data.P === 'number') ? data.P : null;
    var valveVal  = (typeof data.F === 'number') ? data.F : null;

    if (sensorVal !== null) showSensor(sensorVal);

    addChartPoint(sensorVal, outputVal, valveVal);
    addRawData(JSON.stringify(data));
  }

  // ── Mode switching ────────────────────────────────────────────────────────────
  function switchMode(mode) {
    resetControlsForModeSwitch();

    currentMode = mode;
    skipNextPoint = true;

    var modeCode = mode === 'manual' ? 1 : mode === 'onoff' ? 2 : 3;
    if (mode === 'pid') {
      loadProductPidValues();
      lastPidValues = { proportional: 0, integral: 0, derivative: 0, output: 0 };
      queueSend({ W: 2 }, 'PID Integral Reset');
    }
    queueSend({ C: modeCode }, 'Control Mode');

    // Update button styles
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      var active = btn.getAttribute('data-mode') === mode;
      btn.classList.toggle('btn-active', active);
      btn.classList.toggle('btn-primary', active);
    });

    // Show/hide panels
    ['manual', 'onoff', 'pid'].forEach(function (m) {
      var panel = el(m + 'ControlMode');
      if (panel) panel.style.display = m === mode ? 'flex' : 'none';
    });

    initCharts(mode);

    if (mode === 'pid') {
      commitPID();
      var freqEl = el('pidFrequency');
      if (freqEl) {
        var freqVal = parseFloat(freqEl.value);
        if (!isNaN(freqVal) && freqVal > 0) queueSend({ PID_Hz: freqVal }, 'PID Frequency');
      }
    }

    addLog('Switched to ' + mode.toUpperCase() + ' mode', 'info');
  }

  // ── Logging ───────────────────────────────────────────────────────────────────
  function addLog(msg, type) {
    var container = el('adminLogContainer');
    if (!container) return;
    type = type || 'info';
    var div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = '<span class="log-timestamp">[' + new Date().toLocaleTimeString() + ']</span>' +
      ' <span class="log-' + type + '"> ' + escapeHtml(String(msg)) + '</span>';
    container.appendChild(div);
    if (container.children.length > 500) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }

  function addRawData(msg) {
    var container = el('rawDataContainer');
    if (!container) return;
    var div = document.createElement('div');
    div.className = 'raw-data-entry';
    div.innerHTML = '<span class="log-timestamp">[' + new Date().toLocaleTimeString() + ']</span>' +
      ' <span class="raw-data-ascii"> ' + escapeHtml(String(msg)) + '</span>';
    container.appendChild(div);
    if (container.children.length > 200) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Clock ─────────────────────────────────────────────────────────────────────
  function updateClock() {
    var clockEl = el('digitalClock');
    if (!clockEl) return;
    var now = new Date();
    clockEl.textContent = now.getHours().toString().padStart(2,'0') + ':' +
                          now.getMinutes().toString().padStart(2,'0') + ':' +
                          now.getSeconds().toString().padStart(2,'0');
  }

  // ── Slider helper ─────────────────────────────────────────────────────────────
  function bindSlider(sliderId, displayId, jsonKey, label) {
    var slider  = el(sliderId);
    var display = el(displayId);
    if (!slider) return;
    function updateDisplay() {
      var val = parseFloat(slider.value);
      if (display) display.value = val;
      if (jsonKey === 'T') { lastSetpoint = val; showSetpoint(val); }
    }
    function send() {
      updateDisplay();
      var val = parseFloat(slider.value);
      var cmd = {}; cmd[jsonKey] = val;
      queueSend(cmd, label);
    }
    slider.addEventListener('input', updateDisplay);   // update UI only while dragging
    slider.addEventListener('change', send);           // send to hardware on release
    updateDisplay();                                   // seed display/setpoint from default value
    if (display) {
      display.addEventListener('change', function () {
        var v = Math.min(Math.max(parseFloat(display.value), parseFloat(slider.min)), parseFloat(slider.max));
        display.value = v; slider.value = v; send();
      });
    }
  }

  // ── Valve toggle helper ───────────────────────────────────────────────────────
  function bindValveToggle(btnId) {
    var btn = el(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      valveOpen = !valveOpen;
      btn.textContent = valveOpen ? 'Valve: OPEN' : 'Valve: CLOSED';
      btn.className   = 'btn btn-sm w-full ' + (valveOpen ? 'btn-success' : 'btn-error');
      queueSend({ H: valveOpen ? 1 : 0 }, 'Valve Toggle');
    });
  }

  // ── Zero sensor helper ────────────────────────────────────────────────────────
  function bindZeroSensor() {
    var btn = el('zeroSensorBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      queueSend({ Z: 1 }, 'Zero Sensor');
    });
  }

  // ── Navigation ────────────────────────────────────────────────────────────────
  var APP_MENUS        = { main: 'sidebar-main', admin: 'sidebar-admin' };
  var APP_DEFAULT_PAGES = { main: 'page-pct-main', admin: 'page-admin' };
  var ALL_PAGE_IDS     = ['page-pct-main', 'page-admin'];

  function showPage(pageId, adminTab) {
    ALL_PAGE_IDS.forEach(function (id) {
      var p = el(id);
      if (p) p.classList.add('hidden');
    });
    var target = el(pageId);
    if (target) target.classList.remove('hidden');

    if (adminTab) {
      window.switchTab(adminTab, document.querySelector('.tab-button[onclick*="\'' + adminTab + '\'"]'));
    }

    // Active link highlight
    document.querySelectorAll('.sidebar-link').forEach(function (a) { a.classList.remove('active'); });
    if (adminTab) {
      var al = document.querySelector('.sidebar-link[data-admin-tab="' + adminTab + '"]');
      if (al) al.classList.add('active');
    } else {
      var pl = document.querySelector('.sidebar-link[data-page="' + pageId.replace('page-','') + '"]:not([data-admin-tab]):not([data-app])');
      if (pl) pl.classList.add('active');
    }
  }

  function switchToApp(appKey) {
    if (appKey === 'curriculum') {
      window._skipDisconnectOnUnload = true;
      var originType = (window.HARDWARE_CONFIG && window.HARDWARE_CONFIG.type) || '';
      window.location.href = 'index.html?from=' + encodeURIComponent(originType) + '#curriculum';
      return;
    }
    // Show/hide sidebar menus
    Object.keys(APP_MENUS).forEach(function (app) {
      var menu = el(APP_MENUS[app]);
      if (menu) menu.classList.toggle('hidden', app !== appKey);
    });
    // Navigate to default page
    showPage(APP_DEFAULT_PAGES[appKey] || 'page-pct-main');
    // Highlight active app-switcher entry
    document.querySelectorAll('#sidebar-apps .sidebar-link').forEach(function (t) {
      t.classList.toggle('active', t.dataset.app === appKey);
    });
  }

  // ── Hardware navigation ───────────────────────────────────────────────────────
  var HW_PAGES = {
    temperature:   'index.html',
    pressure:      'pressure.html',
    level:         'level.html',
    flow:          'flow.html',
    'servo-angle': 'servo-angle.html',
    'servo-speed': 'servo-speed.html'
  };

  var HW_TYPE_CODES = {
    temperature:   201,
    pressure:      202,
    level:         203,
    flow:          204,
    'servo-angle': 206,
    'servo-speed': 205
  };

  function navigateToHardware(type) {
    var page = HW_PAGES[type];
    if (!page) return;
    var code = HW_TYPE_CODES[type];
    function doNavigate() {
      window._skipDisconnectOnUnload = true;
      if (isElectron && api.loadHardwarePage) {
        api.loadHardwarePage(type);
      } else {
        window.location.href = page;
      }
    }
    if (code !== undefined && isElectron && api.sendCustomJson) {
      api.sendCustomJson({ A: code }, 'hardware-type').then(function (result) {
        if (!result || !result.success) {
          addLog('Hardware type command failed: ' + ((result && result.error) || 'not connected'), 'error');
        }
        doNavigate();
      }, function (err) {
        addLog('Hardware type command error: ' + (err && err.message || err), 'error');
        doNavigate();
      });
    } else {
      doNavigate();
    }
  }

  // ── CSV ───────────────────────────────────────────────────────────────────────
  function filenameTimestamp() {
    var now = new Date();
    return now.getFullYear() + '-' +
      (now.getMonth() + 1).toString().padStart(2, '0') + '-' +
      now.getDate().toString().padStart(2, '0') + ' ' +
      now.getHours().toString().padStart(2, '0') + '-' +
      now.getMinutes().toString().padStart(2, '0') + '-' +
      now.getSeconds().toString().padStart(2, '0');
  }

  function typeDisplayName() {
    return CFG.type.split('-').map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  function startCsv() {
    csvSessionMode = currentMode;
    var header = 'Timestamp,' + CFG.sensor.label + '(' + CFG.sensor.unit + '),Output' +
      (csvSessionMode !== 'manual' ? ',Setpoint' : '') +
      (csvSessionMode === 'onoff' ? ',Hysteresis(' + CFG.sensor.unit + ')' : '') +
      (csvSessionMode === 'pid' ? ',PIDControlType,PIDOutput,Proportional,Integral,Derivative,PID_Frequency,PID_P_Set,PID_I_Set,PID_D_Set' : '') +
      (CFG.secondaryOutput ? ',' + CFG.secondaryOutput.label + '(' + CFG.secondaryOutput.unit + ')' : '');
    var filename = 'Process Control ' + typeDisplayName() + ' ' + filenameTimestamp() + '.csv';

    if (isElectron && api.showSaveDialog) {
      // Ask for the save location up front so the file exists on disk before
      // any data arrives — rows are then appended live, not buffered until Stop.
      api.showSaveDialog({ defaultPath: filename, filters: [{ name: 'CSV', extensions: ['csv'] }] })
        .then(function (result) {
          if (!result || result.canceled || !result.filePath) {
            addLog('CSV save cancelled', 'warn');
            return;
          }
          return api.writeFile(result.filePath, header + '\n').then(function (writeResult) {
            if (writeResult && writeResult.success) {
              csvSavePath = result.filePath;
              csvRows = [];
              isSavingCsv = true;
              var s = el('startCsvBtn'), t = el('stopCsvBtn');
              if (s) s.style.display = 'none';
              if (t) t.style.display = '';
              addLog('CSV file created and capture started: ' + result.filePath, 'success');
            } else {
              addLog('Could not create CSV file: ' + ((writeResult && writeResult.error) || 'Unknown error'), 'error');
            }
          });
        })
        .catch(function (err) {
          addLog('Error opening save dialog: ' + (err && err.message || err), 'error');
        });
    } else {
      // Web fallback — no save dialog available; buffer in memory and download on Stop.
      csvSavePath = null;
      csvRows = [header];
      isSavingCsv = true;
      var s = el('startCsvBtn'), t = el('stopCsvBtn');
      if (s) s.style.display = 'none';
      if (t) t.style.display = '';
      addLog('CSV capture started - will download when stopped', 'success');
    }
  }

  function stopCsv() {
    isSavingCsv = false;
    var s = el('startCsvBtn'), t = el('stopCsvBtn');
    if (s) s.style.display = '';
    if (t) t.style.display = 'none';

    if (csvSavePath) {
      // Rows were already appended to disk as they arrived.
      addLog('CSV saved to: ' + csvSavePath, 'success');
      csvSavePath = null;
      csvRows = [];
      return;
    }

    var content = csvRows.join('\n');
    var filename = 'Process Control ' + typeDisplayName() + ' ' + filenameTimestamp() + '.csv';
    var a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(content);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    addLog('CSV saved', 'success');
  }

  // ── PID commit ────────────────────────────────────────────────────────────────
  function commitPID() {
    var p = parseFloat((el('pidPInput') || {}).value) || 0;
    var i = parseFloat((el('pidIInput') || {}).value) || 0;
    var d = parseFloat((el('pidDInput') || {}).value) || 0;
    saveProductPidValue('P', p);
    saveProductPidValue('I', i);
    saveProductPidValue('D', d);
    queueSend({ PID_P: p }, 'PID P');
    queueSend({ PID_I: i }, 'PID I');
    queueSend({ PID_D: d }, 'PID D');
    addLog('PID committed: P=' + p + ' I=' + i + ' D=' + d, 'success');
  }

  // ── SSE fallback ──────────────────────────────────────────────────────────────
  function setupSSE() {
    var es = new EventSource('/api/events');
    es.addEventListener('json-data-received', function (e) {
      try { handleJsonData(JSON.parse(e.data)); } catch (x) {}
    });
    es.addEventListener('connection-status', function (e) {
      try { var s = JSON.parse(e.data); setConnected(s.connected, s.message); } catch (x) {}
    });
    es.addEventListener('state-update', function (e) {
      try { handleJsonData(JSON.parse(e.data)); } catch (x) {}
    });
    es.onerror = function () { setConnected(false, 'SSE connection lost'); };
  }

  // ── Sidebar toggle ────────────────────────────────────────────────────────────
  function initSidebar() {
    var toggle   = el('sidebar-toggle');
    var closeBtn = el('sidebar-close-btn');
    var sidebar  = el('sidebar');
    var backdrop = el('sidebar-backdrop');

    function doToggle() {
      if (!sidebar) return;
      if (window.innerWidth < 768) {
        var isOpen = !sidebar.classList.contains('-translate-x-full');
        sidebar.classList.toggle('-translate-x-full', isOpen);
        if (backdrop) backdrop.classList.toggle('hidden', isOpen);
      } else {
        var isCollapsed = sidebar.classList.contains('w-0');
        if (isCollapsed) {
          sidebar.classList.remove('w-0','overflow-hidden');
          sidebar.classList.add('w-64');
          localStorage.setItem('matrix-sidebar-collapsed','false');
        } else {
          sidebar.classList.remove('w-64');
          sidebar.classList.add('w-0','overflow-hidden');
          localStorage.setItem('matrix-sidebar-collapsed','true');
        }
      }
    }

    function doClose() {
      if (!sidebar) return;
      sidebar.classList.add('-translate-x-full');
      if (backdrop) backdrop.classList.add('hidden');
    }

    if (toggle)   toggle.addEventListener('click', doToggle);
    if (closeBtn) closeBtn.addEventListener('click', doClose);
    if (backdrop) backdrop.addEventListener('click', doClose);

    // Restore collapse state
    if (localStorage.getItem('matrix-sidebar-collapsed') === 'true' && window.innerWidth >= 768) {
      if (sidebar) { sidebar.classList.add('w-0','overflow-hidden'); sidebar.classList.remove('w-64'); }
    }
  }

  // ── Admin panel HTML template (injected into #page-admin at runtime) ────────
  var ADMIN_HTML = `
    <div class="bg-base-200 border-b border-base-300 flex-shrink-0 px-2 py-1">
      <div class="flex flex-wrap items-center gap-y-1">
        <button id="adminBackBtn" class="btn btn-sm btn-primary gap-1 flex-shrink-0 mr-1">← Main App</button>
        <button class="tab-button btn btn-ghost btn-sm rounded-none border-b-2 border-primary active whitespace-nowrap" onclick="switchTab('dashboard', this)">📊 Dashboard</button>
        <button class="tab-button btn btn-ghost btn-sm rounded-none border-b-2 border-transparent whitespace-nowrap" onclick="switchTab('pid', this)">🎛️ PID Controls</button>
        <button class="tab-button btn btn-ghost btn-sm rounded-none border-b-2 border-transparent whitespace-nowrap" onclick="switchTab('bootloader', this)">🔧 Bootloader</button>
        <button class="tab-button btn btn-ghost btn-sm rounded-none border-b-2 border-transparent whitespace-nowrap" onclick="switchTab('updates', this)">🔄 Updates</button>
        <button class="tab-button btn btn-ghost btn-sm rounded-none border-b-2 border-transparent whitespace-nowrap" onclick="switchTab('settings', this)">⚙️ Settings</button>
      </div>
    </div>
    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <div id="dashboardTab" class="tab-content active space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="card bg-base-200 shadow">
            <div class="card-body p-3 gap-2">
              <div class="flex items-center justify-between">
                <h3 class="font-semibold text-sm">📋 System Logs</h3>
                <div class="flex gap-1"><button class="btn btn-xs btn-ghost" onclick="exportLogs()">💾 Export</button></div>
              </div>
              <div id="adminLogContainer" class="log-scroll bg-base-300 rounded p-2 font-mono text-xs leading-relaxed h-96 overflow-y-scroll">
                <div class="log-entry"><span class="log-timestamp">[Loading...]</span><span class="log-info"> Admin panel initialized</span></div>
              </div>
            </div>
          </div>
          <div class="card bg-base-200 shadow">
            <div class="card-body p-3 gap-2">
              <div class="flex items-center justify-between">
                <h3 class="font-semibold text-sm">📡 Raw Data Stream</h3>
                <div class="flex gap-1">
                  <button class="btn btn-xs btn-ghost" onclick="clearRawData()">📡 Clear</button>
                  <button class="btn btn-xs btn-ghost" onclick="exportRawData()">📊 Export</button>
                </div>
              </div>
              <div id="rawDataContainer" class="log-scroll bg-base-300 rounded p-2 font-mono text-xs leading-relaxed h-96 overflow-y-scroll">
                <div class="raw-data-entry"><span class="log-timestamp">[Waiting for data...]</span></div>
              </div>
            </div>
          </div>
        </div>
        <div id="remoteAccessCard" class="card bg-base-200 shadow">
          <div class="card-body p-4">
            <h3 class="font-semibold text-sm mb-1">📱 Remote Access (Phone / Tablet)</h3>
            <p class="text-xs opacity-60 mb-3">Scan the QR code or open the URL on any device on the same Wi-Fi:</p>
            <div class="flex flex-row items-center gap-4">
              <img id="webServerQr" src="" alt="QR Code" class="w-32 h-32 hidden rounded" />
              <div class="flex flex-col gap-1">
                <span class="text-xs opacity-60">IP Address:</span>
                <span id="webServerIp" class="font-mono text-sm font-semibold">—</span>
                <span class="text-xs opacity-60 mt-1">URL:</span>
                <a id="webServerUrl" href="#" target="_blank" class="font-mono text-primary text-sm break-all">Waiting for server…</a>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="pidTab" class="tab-content">
        <div class="card bg-base-200 shadow max-w-lg">
          <div class="card-body gap-4">
            <h2 class="card-title text-base border-b border-success pb-3">🎛️ PID Control Settings</h2>
            <div class="space-y-1">
              <label class="label pb-0" for="adminPidProduct"><span class="label-text font-semibold">Product:</span></label>
              <select id="adminPidProduct" class="select select-bordered select-sm w-full">
                <option value="temperature">201 — Temperature</option>
                <option value="pressure">202 — Pressure</option>
                <option value="level">203 — Level</option>
                <option value="flow">204 — Flow</option>
                <option value="servo-speed">205 — Servo Speed</option>
                <option value="servo-angle">206 — Servo Angle</option>
              </select>
            </div>
            <div class="space-y-1">
              <label class="label pb-0" for="proportionalInput"><span class="label-text font-semibold">Proportional (P):</span></label>
              <div class="flex items-center gap-3">
                <input type="text" id="proportionalInput" placeholder="Enter float value (e.g., 1.5)" class="input input-bordered input-sm flex-1">
                <span class="pid-status" id="proportionalStatus"></span>
              </div>
            </div>
            <div class="space-y-1">
              <label class="label pb-0" for="integralInput"><span class="label-text font-semibold">Integral (I):</span></label>
              <div class="flex items-center gap-3">
                <input type="text" id="integralInput" placeholder="Enter float value (e.g., 0.1)" class="input input-bordered input-sm flex-1">
                <span class="pid-status" id="integralStatus"></span>
              </div>
            </div>
            <div class="space-y-1">
              <label class="label pb-0" for="differentialInput"><span class="label-text font-semibold">Differential (D):</span></label>
              <div class="flex items-center gap-3">
                <input type="text" id="differentialInput" placeholder="Enter float value (e.g., 0.05)" class="input input-bordered input-sm flex-1">
                <span class="pid-status" id="differentialStatus"></span>
              </div>
            </div>
            <div class="space-y-1">
              <label class="label pb-0" for="adminPidFrequency"><span class="label-text font-semibold">Frequency (Hz):</span></label>
              <input type="number" id="adminPidFrequency" min="0.2" max="1000" step="0.01" class="input input-bordered input-sm w-full">
            </div>
            <p class="text-xs text-base-content/50 mt-1">Values are saved as defaults for the selected product and sent when that product enters PID mode.</p>
            <div class="card-actions justify-end mt-2">
              <button id="pidRestoreDefaultsBtn" class="btn btn-sm btn-outline btn-warning">Restore to Default</button>
              <span id="pidRestoreStatus" class="text-xs self-center"></span>
            </div>
          </div>
        </div>
      </div>
      <div id="bootloaderTab" class="tab-content">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="card bg-base-200 shadow">
            <div class="card-body gap-4">
              <h2 class="card-title text-base border-b border-success pb-3">📡 Communication Settings</h2>
              <div class="space-y-2" style="display:none;">
                <h3 class="font-semibold text-sm">Serial Port</h3>
                <div class="flex items-center gap-2">
                  <label class="label-text w-24 flex-shrink-0">Com Port:</label>
                  <select id="comPortSelect" class="select select-bordered select-sm flex-1" disabled><option value="">Select Port...</option></select>
                </div>
                <div class="flex items-center gap-2">
                  <label class="label-text w-24 flex-shrink-0">Baud Rate:</label>
                  <select id="baudRateSelect" class="select select-bordered select-sm flex-1">
                    <option value="9600">9600</option><option value="19200">19200</option>
                    <option value="38400">38400</option><option value="57600">57600</option>
                    <option value="115200" selected>115200</option>
                  </select>
                </div>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" id="comEnableCheck" class="checkbox checkbox-sm checkbox-primary" onchange="onComEnableChanged()">
                  <span class="label-text">Enable</span>
                </label>
              </div>
              <div class="space-y-2">
                <h3 class="font-semibold text-sm">USB</h3>
                <div class="flex items-center gap-2">
                  <label class="label-text w-10 flex-shrink-0">VID:</label>
                  <input type="text" id="usbVidInput" value="0x12BF" placeholder="0x12BF" class="input input-bordered input-sm flex-1 font-mono">
                </div>
                <div class="flex items-center gap-2">
                  <label class="label-text w-10 flex-shrink-0">PID:</label>
                  <input type="text" id="usbPidInput" value="0xA1" placeholder="0xA1" class="input input-bordered input-sm flex-1 font-mono">
                </div>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" id="usbEnableCheck" checked class="checkbox checkbox-sm checkbox-primary" onchange="onUsbEnableChanged()">
                  <span class="label-text">Enable</span>
                </label>
              </div>
            </div>
          </div>
          <div class="card bg-base-200 shadow">
            <div class="card-body gap-4">
              <h2 class="card-title text-base border-b border-success pb-3">🔧 Bootloader Actions</h2>
              <div class="grid grid-cols-3 gap-2">
                <button class="btn btn-sm btn-outline" id="bootloaderVerBtn" onclick="bootloaderVersion()" disabled style="display:none;">Bootloader Ver</button>
                <button class="btn btn-sm btn-outline" id="loadHexBtn" onclick="loadHexFile()" disabled>Load Hex File</button>
                <button class="btn btn-sm btn-warning" id="eraseBtn" onclick="eraseFlash()" disabled style="display:none;">Erase</button>
                <button class="btn btn-sm btn-primary" id="programBtn" onclick="programFlash()" disabled style="display:none;">Program</button>
                <button class="btn btn-sm btn-outline" id="verifyBtn" onclick="verifyFlash()" disabled style="display:none;">Verify</button>
                <button class="btn btn-sm btn-success" id="runAppBtn" onclick="runApplication()" disabled>Run Application</button>
                <button class="btn btn-sm btn-error col-span-2" id="eraseProgVerifyBtn" onclick="eraseProgramVerify()" disabled>Erase-Program-Verify</button>
                <button class="btn btn-sm btn-outline" id="connectBtn" onclick="connectBootloader()" disabled>Connect</button>
                <button class="btn btn-sm btn-outline col-span-3" id="triggerBootloaderBtn" onclick="triggerBootloader()">Trigger Bootloader</button>
              </div>
              <div id="firmwareProgressSection" class="space-y-2" style="display:none;">
                <div class="text-xs font-bold text-center" id="firmwareProgressLabel">Initializing...</div>
                <progress class="progress progress-success w-full h-5" id="firmwareProgressFill" value="0" max="100"></progress>
                <div class="text-xs font-bold text-center firmware-progress-text" id="firmwareProgressText">0%</div>
              </div>
              <div class="bg-base-300 rounded p-2 border-l-4 border-success">
                <span class="file-path-label" id="hexFilePathLabel">No hex file loaded</span>
              </div>
              <div class="log-scroll bg-base-300 rounded p-2 h-48 overflow-y-auto"><div id="bootloaderLog"></div></div>
            </div>
          </div>
        </div>
      </div>
      <div id="updatesTab" class="tab-content">
        <div class="card bg-base-200 shadow max-w-lg">
          <div class="card-body gap-4">
            <h2 class="card-title text-base border-b border-success pb-3">🔄 Check for Updates</h2>
            <div class="bg-base-300 rounded p-3 border-l-4 border-success space-y-2">
              <div class="flex justify-between text-sm"><strong>Current Version:</strong><span id="currentVersionDisplay" class="font-mono">Loading...</span></div>
              <div class="flex justify-between text-sm"><strong>Status:</strong><span id="updateStatusDisplay" class="opacity-70">Ready to check</span></div>
            </div>
            <div class="update-status-message" id="updateStatusMessage" style="display:none;">
              <div class="update-status-content text-sm leading-relaxed" id="updateStatusContent"></div>
            </div>
            <div id="updateProgressSection" style="display:none;" class="space-y-1">
              <progress class="progress progress-primary w-full" id="updateProgressFill" value="0" max="100"></progress>
              <span class="text-xs font-bold text-center block" id="updateProgressText">0%</span>
            </div>
            <button class="btn btn-primary btn-sm w-full" id="checkUpdateBtn" onclick="checkForUpdates()">🔄 Check for Updates</button>
          </div>
        </div>
      </div>
      <div id="settingsTab" class="tab-content">
        <div class="flex flex-col gap-4 max-w-sm">
          <div class="card bg-base-200 shadow">
            <div class="card-body gap-4">
              <h2 class="card-title text-base border-b border-success pb-3">🔧 Hardware Type</h2>
              <p class="text-xs text-base-content/60">Select the hardware system connected to this PC. The app will reload with the correct frontend.</p>
              <select id="hardwareTypeSelect" class="select select-bordered select-sm w-full">
                <option value="temperature">🌡️ Temperature</option>
                <option value="pressure">⚡ Pressure</option>
                <option value="level">📊 Level</option>
                <option value="flow">💧 Flow</option>
                <option value="servo-angle">🔄 Servo – Angle</option>
                <option value="servo-speed">⚙️ Servo – Speed</option>
              </select>
              <p class="text-xs text-base-content/50">Changing this will navigate to the matching hardware page.</p>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  // ── Admin helper functions ────────────────────────────────────────────────────
  function addBootloaderLog(message, type) {
    var c = el('bootloaderLog'); if (!c) return;
    var entry = document.createElement('div');
    entry.className = 'bootloader-log-entry ' + (type || 'info');
    entry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    c.appendChild(entry); c.scrollTop = c.scrollHeight;
  }

  function showFirmwareProgress(label, percent, mode) {
    var section = el('firmwareProgressSection'), labelEl = el('firmwareProgressLabel');
    var fillEl = el('firmwareProgressFill'), textEl = el('firmwareProgressText');
    if (!section) return;
    section.style.display = 'block'; labelEl.textContent = label; fillEl.value = percent; textEl.textContent = percent + '%';
    fillEl.classList.remove('progress-success', 'progress-warning', 'progress-info');
    textEl.classList.remove('erasing', 'verifying');
    if (mode === 'erase') { fillEl.classList.add('progress-warning'); textEl.classList.add('erasing'); }
    else if (mode === 'verify') { fillEl.classList.add('progress-info'); textEl.classList.add('verifying'); }
    else fillEl.classList.add('progress-success');
  }

  function hideFirmwareProgress() { var s = el('firmwareProgressSection'); if (s) s.style.display = 'none'; }

  function updateFirmwareProgress(label, percent) {
    var l = el('firmwareProgressLabel'), f = el('firmwareProgressFill'), t = el('firmwareProgressText');
    if (l) l.textContent = label; if (f) f.value = percent; if (t) t.textContent = Math.round(percent) + '%';
  }

  function setBootloaderButtonState(state) {
    var ids = ['connectBtn','triggerBootloaderBtn','loadHexBtn','eraseProgVerifyBtn','runAppBtn','bootloaderVerBtn','eraseBtn','programBtn','verifyBtn'];
    var btns = {}; ids.forEach(function (id) { btns[id] = el(id); });
    function enable(id, val) { if (btns[id]) btns[id].disabled = !val; }
    switch (state) {
      case 'disconnected': enable('connectBtn',false); enable('triggerBootloaderBtn',true); enable('loadHexBtn',false); enable('eraseProgVerifyBtn',false); enable('runAppBtn',false); break;
      case 'connected':    enable('connectBtn',true); enable('triggerBootloaderBtn',false); enable('loadHexBtn',true); enable('eraseProgVerifyBtn',false); enable('runAppBtn',false); break;
      case 'hex_loaded':   enable('connectBtn',true); enable('triggerBootloaderBtn',false); enable('loadHexBtn',true); enable('eraseProgVerifyBtn',true); enable('runAppBtn',false); break;
      case 'busy':         ids.forEach(function (id) { enable(id, false); }); break;
      case 'ready_to_run': ids.filter(function (id) { return id !== 'runAppBtn'; }).forEach(function (id) { enable(id, false); }); enable('runAppBtn', true); break;
    }
  }

  function loadAdminPIDDefaults() {
    var productSelect = el('adminPidProduct');
    var type = productSelect ? productSelect.value : CFG.type;
    var configured = {
      temperature: { P: 3.162, I: 0.01, D: 150, frequency: 1 },
      pressure: { P: 5, I: 0.5, D: 0, frequency: 5 },
      level: { P: 3.162, I: 0.01, D: 150, frequency: 5 },
      flow: { P: 3.162, I: 0.01, D: 150, frequency: 1 },
      'servo-speed': { P: 1.5, I: 250, D: 0.02, frequency: 250 },
      'servo-angle': { P: 0.7, I: 2, D: 0.09, frequency: 250 }
    }[type] || PID_FACTORY_DEFAULTS;
    function stored(term, fallback) {
      var value = parseFloat(localStorage.getItem('pid-' + type + '-' + term));
      return isNaN(value) ? fallback : value;
    }
    var p = stored('P', configured.P), i = stored('I', configured.I), d = stored('D', configured.D);
    var frequency = stored('frequency', configured.frequency);
    var pIn = el('proportionalInput'), iIn = el('integralInput'), dIn = el('differentialInput'), fIn = el('adminPidFrequency');
    if (pIn) { pIn.value = p; lastProportionalValue = String(p); }
    if (iIn) { iIn.value = i; lastIntegralValue = String(i); }
    if (dIn) { dIn.value = d; lastDifferentialValue = String(d); }
    if (fIn) fIn.value = frequency;
  }

  function saveAdminPIDValue(type, term, value) {
    localStorage.setItem('pid-' + type + '-' + term, String(value));
    if (type === 'temperature' && term !== 'frequency') {
      localStorage.setItem('pid-default-' + term, String(value));
    }
  }

  function updatePIDStatus(type, success, message) {
    var statusEl = el(type + 'Status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = 'pid-status ' + (success ? 'success' : 'error');
      setTimeout(function () { statusEl.textContent = ''; statusEl.className = 'pid-status'; }, 3000);
    }
  }

  function handleUpdateStatus(updateInfo) {
    var statusDisplay = el('updateStatusDisplay'), statusMessage = el('updateStatusMessage');
    var statusContent = el('updateStatusContent'), progressSection = el('updateProgressSection');
    var progressFill = el('updateProgressFill'), progressText = el('updateProgressText');
    var checkBtn = el('checkUpdateBtn');
    if (!statusMessage) return;
    statusMessage.style.display = 'block';
    var st = updateInfo.status;
    if (st === 'checking') {
      if (statusDisplay) statusDisplay.textContent = 'Checking...';
      statusMessage.className = 'update-status-message info';
      if (statusContent) statusContent.textContent = updateInfo.message || 'Checking...';
      if (progressSection) progressSection.style.display = 'none';
    } else if (st === 'available') {
      if (statusDisplay) statusDisplay.textContent = 'Update Available!';
      statusMessage.className = 'update-status-message success';
      var msg = 'New version ' + updateInfo.version + ' available!';
      if (updateInfo.releaseNotes) msg += '\n\nRelease Notes:\n' + updateInfo.releaseNotes;
      if (statusContent) statusContent.textContent = msg;
      if (progressSection) progressSection.style.display = 'none';
      if (checkBtn) checkBtn.disabled = false;
      addLog('Update available: v' + updateInfo.version, 'info');
    } else if (st === 'not-available') {
      if (statusDisplay) statusDisplay.textContent = 'Up to Date';
      statusMessage.className = 'update-status-message success';
      if (statusContent) statusContent.textContent = updateInfo.message || 'You are using the latest version.';
      if (progressSection) progressSection.style.display = 'none';
      if (checkBtn) checkBtn.disabled = false;
    } else if (st === 'downloading') {
      if (statusDisplay) statusDisplay.textContent = 'Downloading...';
      statusMessage.className = 'update-status-message info';
      if (statusContent) statusContent.textContent = updateInfo.message || 'Downloading...';
      if (progressSection) progressSection.style.display = 'block';
      if (updateInfo.percent !== undefined) {
        if (progressFill) progressFill.value = updateInfo.percent;
        if (progressText) progressText.textContent = updateInfo.percent + '%';
      }
    } else if (st === 'downloaded') {
      if (statusDisplay) statusDisplay.textContent = 'Ready to Install';
      statusMessage.className = 'update-status-message success';
      if (statusContent) statusContent.textContent = 'Downloaded — restart to install.';
      if (progressFill) progressFill.value = 100; if (progressText) progressText.textContent = '100%';
      if (checkBtn) checkBtn.disabled = false;
    } else if (st === 'error') {
      if (statusDisplay) statusDisplay.textContent = 'Error';
      statusMessage.className = 'update-status-message error';
      if (statusContent) statusContent.textContent = updateInfo.message || 'An error occurred.';
      if (progressSection) progressSection.style.display = 'none';
      if (checkBtn) checkBtn.disabled = false;
      addLog('Update error: ' + updateInfo.message, 'error');
    }
  }

  // ── Bootloader & admin functions (called via HTML onclick attrs) ──────────────
  window.onComEnableChanged = function () {
    var comEnabled = el('comEnableCheck') && el('comEnableCheck').checked;
    if (el('comPortSelect'))  el('comPortSelect').disabled  = !comEnabled;
    if (el('baudRateSelect')) el('baudRateSelect').disabled = !comEnabled;
    if (comEnabled) {
      if (el('usbEnableCheck')) el('usbEnableCheck').checked = false;
      if (el('usbVidInput')) el('usbVidInput').disabled = true;
      if (el('usbPidInput')) el('usbPidInput').disabled = true;
    }
  };

  window.onUsbEnableChanged = function () {
    var usbEnabled = el('usbEnableCheck') && el('usbEnableCheck').checked;
    if (el('usbVidInput')) el('usbVidInput').disabled = !usbEnabled;
    if (el('usbPidInput')) el('usbPidInput').disabled = !usbEnabled;
    if (usbEnabled) {
      if (el('comEnableCheck')) el('comEnableCheck').checked = false;
      if (el('comPortSelect'))  el('comPortSelect').disabled  = true;
      if (el('baudRateSelect')) el('baudRateSelect').disabled = true;
    }
  };

  window.triggerBootloader = async function () {
    var btn = el('triggerBootloaderBtn'); if (!btn) return;
    btn.disabled = true; addBootloaderLog('Sending bootloader trigger...', 'info');
    try {
      if (isElectron && api.sendBootloader) {
        var result = await api.sendBootloader(1);
        if (result.success) {
          addBootloaderLog('Bootloader command sent — click Connect when device is ready.', 'info');
          var connectBtn = el('connectBtn'); if (connectBtn) connectBtn.disabled = false;
        } else { addBootloaderLog('Failed: ' + (result.error || 'Unknown'), 'error'); btn.disabled = false; }
      } else { addBootloaderLog('Bootloader control not available', 'error'); btn.disabled = false; }
    } catch (e) { addBootloaderLog('Error: ' + e.message, 'error'); btn.disabled = false; }
  };

  window.connectBootloader = async function () {
    var connectBtn = el('connectBtn');
    if (bootloaderConnected) {
      addBootloaderLog('Disconnecting...', 'info');
      if (isElectron && api.disconnectFromPort) await api.disconnectFromPort();
      bootloaderConnected = false; hexFileLoaded = false;
      if (connectBtn) connectBtn.textContent = 'Connect';
      setBootloaderButtonState('disconnected'); addBootloaderLog('Disconnected', 'info');
    } else {
      var comEnabled = el('comEnableCheck') && el('comEnableCheck').checked;
      var usbEnabled = el('usbEnableCheck') && el('usbEnableCheck').checked;
      if (!comEnabled && !usbEnabled) { addBootloaderLog('Enable COM or USB first', 'error'); return; }
      if (connectBtn) connectBtn.disabled = true;
      addBootloaderLog('Connecting...', 'info');
      try {
        var result;
        if (comEnabled) {
          var port = el('comPortSelect') ? el('comPortSelect').value : '';
          var baud = el('baudRateSelect') ? parseInt(el('baudRateSelect').value) : 115200;
          if (!port) { addBootloaderLog('Select a COM port', 'error'); if (connectBtn) connectBtn.disabled = false; return; }
          if (isElectron && api.connectToPort) result = await api.connectToPort(port, baud);
        } else {
          var vid = el('usbVidInput') ? el('usbVidInput').value : '0x12BF';
          var pid = el('usbPidInput') ? el('usbPidInput').value : '0xA1';
          if (isElectron && api.connectToBootloaderUSB) result = await api.connectToBootloaderUSB(vid, pid);
        }
        if (result && result.success) {
          bootloaderConnected = true; if (connectBtn) connectBtn.textContent = 'Disconnect';
          setBootloaderButtonState('connected'); addBootloaderLog('Connected — load a hex file to continue', 'success');
        } else { addBootloaderLog('Connection failed: ' + ((result && result.error) || 'Unknown'), 'error'); if (connectBtn) connectBtn.disabled = false; }
      } catch (e) { addBootloaderLog('Error: ' + e.message, 'error'); if (connectBtn) connectBtn.disabled = false; }
    }
  };

  window.bootloaderVersion = async function () {
    addBootloaderLog('Reading version...', 'info');
    if (isElectron && api.bootloaderReadInfo) {
      var r = await api.bootloaderReadInfo();
      addBootloaderLog(r && r.success ? 'Version: ' + r.majorVersion + '.' + r.minorVersion : 'Failed: ' + ((r && r.error) || 'Unknown'), (r && r.success) ? 'success' : 'error');
    }
  };

  window.loadHexFile = async function () {
    if (!isElectron || !api.showOpenDialog) { addBootloaderLog('File dialog not available', 'error'); return; }
    try {
      var result = await api.showOpenDialog({ filters: [{ name: 'Hex Files', extensions: ['hex'] }], properties: ['openFile'] });
      if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        hexFilePath = result.filePaths[0];
        var label = el('hexFilePathLabel');
        if (label) { label.textContent = hexFilePath; label.classList.add('has-file'); }
        if (api.loadHexFile) {
          var lr = await api.loadHexFile(hexFilePath);
          if (lr && lr.success) { hexFileLoaded = true; addBootloaderLog('Hex loaded — click Erase-Program-Verify', 'success'); setBootloaderButtonState('hex_loaded'); }
          else addBootloaderLog('Load failed: ' + ((lr && lr.error) || 'Unknown'), 'error');
        }
      }
    } catch (e) { addBootloaderLog('Error: ' + e.message, 'error'); }
  };

  window.eraseFlash = async function () {
    addBootloaderLog('Erasing flash...', 'info'); setBootloaderButtonState('busy'); showFirmwareProgress('Erasing Flash...', 0, 'erase');
    if (isElectron && api.bootloaderEraseFlash) {
      try {
        var prog = 0, iv = setInterval(function () { prog += 5; if (prog < 90) updateFirmwareProgress('Erasing...', prog); }, 100);
        var r = await api.bootloaderEraseFlash(); clearInterval(iv);
        if (r && r.success) { updateFirmwareProgress('Erase Complete!', 100); addBootloaderLog('Flash erased', 'success'); setTimeout(hideFirmwareProgress, 1500); }
        else { hideFirmwareProgress(); addBootloaderLog('Erase failed: ' + ((r && r.error) || 'Unknown'), 'error'); }
      } catch (e) { hideFirmwareProgress(); addBootloaderLog('Error: ' + e.message, 'error'); }
      finally { setBootloaderButtonState(hexFileLoaded ? 'hex_loaded' : 'connected'); }
    }
  };

  window.programFlash = async function () {
    if (!hexFileLoaded) { addBootloaderLog('Load hex file first', 'error'); return; }
    addBootloaderLog('Programming flash...', 'info'); setBootloaderButtonState('busy'); showFirmwareProgress('Programming...', 0, 'program');
    if (isElectron && api.bootloaderProgramFlash) {
      try {
        var r = await api.bootloaderProgramFlash();
        if (r && r.success) { updateFirmwareProgress('Complete!', 100); addBootloaderLog('Programming complete', 'success'); setTimeout(hideFirmwareProgress, 1500); }
        else { hideFirmwareProgress(); addBootloaderLog('Failed: ' + ((r && r.error) || 'Unknown'), 'error'); }
      } catch (e) { hideFirmwareProgress(); addBootloaderLog('Error: ' + e.message, 'error'); }
      finally { setBootloaderButtonState(hexFileLoaded ? 'hex_loaded' : 'connected'); }
    } else { hideFirmwareProgress(); addBootloaderLog('Not available', 'error'); setBootloaderButtonState(hexFileLoaded ? 'hex_loaded' : 'connected'); }
  };

  window.verifyFlash = async function () {
    addBootloaderLog('Verifying...', 'info'); setBootloaderButtonState('busy');
    if (isElectron && api.bootloaderReadCRC) {
      try {
        var r = await api.bootloaderReadCRC();
        if (r && r.success) addBootloaderLog(r.crcMatch ? 'Verification OK' : 'CRC mismatch', r.crcMatch ? 'success' : 'error');
        else addBootloaderLog('Failed: ' + ((r && r.error) || 'Unknown'), 'error');
      } catch (e) { addBootloaderLog('Error: ' + e.message, 'error'); }
      finally { setBootloaderButtonState(hexFileLoaded ? 'hex_loaded' : 'connected'); }
    }
  };

  window.eraseProgramVerify = async function () {
    if (!hexFileLoaded) { addBootloaderLog('Load hex file first', 'error'); return; }
    addBootloaderLog('Starting Erase-Program-Verify sequence...', 'info'); setBootloaderButtonState('busy');
    try {
      addBootloaderLog('Step 1/3: Erasing...', 'info'); showFirmwareProgress('Erasing Flash...', 0, 'erase');
      var er = await api.bootloaderEraseFlash();
      if (!er || !er.success) { hideFirmwareProgress(); addBootloaderLog('Erase failed: ' + ((er && er.error) || 'Unknown'), 'error'); setBootloaderButtonState('hex_loaded'); return; }
      addBootloaderLog('Erase complete', 'success');
      addBootloaderLog('Step 2/3: Programming...', 'info'); showFirmwareProgress('Programming Flash...', 0, 'program');
      var pr = await api.bootloaderProgramFlash();
      if (!pr || !pr.success) { hideFirmwareProgress(); addBootloaderLog('Program failed: ' + ((pr && pr.error) || 'Unknown'), 'error'); setBootloaderButtonState('hex_loaded'); return; }
      addBootloaderLog('Program complete', 'success');
      addBootloaderLog('Step 3/3: Verifying...', 'info'); showFirmwareProgress('Verifying...', 0, 'verify');
      var vr = await api.bootloaderReadCRC();
      if (!vr || !vr.success) { hideFirmwareProgress(); addBootloaderLog('Verify failed: ' + ((vr && vr.error) || 'Unknown'), 'error'); setBootloaderButtonState('hex_loaded'); return; }
      if (vr.crcMatch) { updateFirmwareProgress('Complete!', 100); setTimeout(hideFirmwareProgress, 2000); addBootloaderLog('All done — click Run Application', 'success'); setBootloaderButtonState('ready_to_run'); }
      else { hideFirmwareProgress(); addBootloaderLog('CRC mismatch', 'error'); setBootloaderButtonState('hex_loaded'); }
    } catch (e) { hideFirmwareProgress(); addBootloaderLog('Error: ' + e.message, 'error'); setBootloaderButtonState('hex_loaded'); }
  };

  window.runApplication = async function () {
    addBootloaderLog('Jumping to application...', 'info'); setBootloaderButtonState('busy');
    if (isElectron && api.bootloaderJumpToApp) {
      try {
        var r = await api.bootloaderJumpToApp();
        if (r && r.success) addBootloaderLog('Application running', 'success');
        else addBootloaderLog('Failed: ' + ((r && r.error) || 'Unknown'), 'error');
      } catch (e) {
        if (e.message && (e.message.includes('disconnected') || e.message.includes('Cannot write')))
          addBootloaderLog('Device jumped to application (bootloader disconnected — normal)', 'success');
        else addBootloaderLog('Error: ' + e.message, 'error');
      }
      bootloaderConnected = false; hexFileLoaded = false;
      var cb = el('connectBtn'); if (cb) cb.textContent = 'Connect';
      setBootloaderButtonState('disconnected');
    }
  };

  // ── Global functions expected by HTML onclick attrs ───────────────────────────
  window.switchTab = function (tab, btn) {
    document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
    document.querySelectorAll('.tab-button').forEach(function (b) {
      b.classList.remove('active');
      b.style.borderBottomColor = 'transparent';
    });
    var content = el(tab + 'Tab');
    if (content) content.classList.add('active');
    if (btn) { btn.classList.add('active'); btn.style.borderBottomColor = 'oklch(var(--p))'; }
  };

  window.exportLogs = function () {
    var c = el('adminLogContainer');
    if (!c) return;
    var text = Array.from(c.querySelectorAll('.log-entry')).map(function(d){return d.textContent;}).join('\n');
    var a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    a.download = CFG.type + '-logs.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  window.clearRawData = function () {
    var c = el('rawDataContainer'); if (c) c.innerHTML = '';
  };

  window.exportRawData = function () {
    var c = el('rawDataContainer');
    if (!c) return;
    var text = Array.from(c.querySelectorAll('.raw-data-entry')).map(function(d){return d.textContent;}).join('\n');
    var a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    a.download = CFG.type + '-raw-data.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  window.checkForUpdates = async function () {
    var checkBtn = el('checkUpdateBtn'), statusDisplay = el('updateStatusDisplay');
    var statusMessage = el('updateStatusMessage'), statusContent = el('updateStatusContent');
    var progressSection = el('updateProgressSection');
    if (!isElectron || !api.checkForUpdates) {
      addLog('Update checking not available', 'info');
      if (statusDisplay) statusDisplay.textContent = 'Not available (web mode)'; return;
    }
    if (checkBtn) checkBtn.disabled = true;
    if (statusDisplay) statusDisplay.textContent = 'Checking...';
    if (statusMessage) { statusMessage.style.display = 'block'; statusMessage.className = 'update-status-message info'; }
    if (statusContent) statusContent.textContent = 'Checking for updates...';
    if (progressSection) progressSection.style.display = 'none';
    addLog('Checking for updates…', 'info');
    try {
      var result = await api.checkForUpdates();
      if (!result.success) {
        if (statusDisplay) statusDisplay.textContent = 'Error';
        if (statusMessage) statusMessage.className = 'update-status-message error';
        if (statusContent) statusContent.textContent = result.error || 'Failed';
        if (checkBtn) checkBtn.disabled = false;
      }
    } catch (e) {
      if (statusDisplay) statusDisplay.textContent = 'Error';
      if (statusMessage) statusMessage.className = 'update-status-message error';
      if (statusContent) statusContent.textContent = 'Error: ' + e.message;
      if (checkBtn) checkBtn.disabled = false;
    }
  };

  // ── Main init ─────────────────────────────────────────────────────────────────
  function init() {
    // Inject admin panel HTML into #page-admin (replaces any existing simplified content)
    var adminPage = el('page-admin');
    if (adminPage && !adminPage.dataset.adminInjected) {
      adminPage.innerHTML = ADMIN_HTML;
      adminPage.dataset.adminInjected = 'true';
    }

    // Apply saved theme
    var theme = localStorage.getItem('matrix-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    var themeSelect = el('theme-select');
    if (themeSelect) {
      themeSelect.value = theme;
      themeSelect.addEventListener('change', function () {
        var t = themeSelect.value;
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('matrix-theme', t);
        updateChartTheme();
      });
    }

    // Clock
    updateClock();
    setInterval(updateClock, 1000);

    // Sidebar
    initSidebar();

    // Sidebar link clicks (delegated)
    document.addEventListener('click', function (e) {
      var link = e.target.closest('.sidebar-link');
      if (!link) return;
      e.preventDefault();
      var pageId   = link.dataset.page;
      var adminTab = link.dataset.adminTab;
      var appKey   = link.dataset.app;
      if (!pageId) return;
      if (appKey) switchToApp(appKey);
      showPage('page-' + pageId, adminTab);
      // Close sidebar on mobile
      if (window.innerWidth < 768) {
        var sb = el('sidebar'), bd = el('sidebar-backdrop');
        if (sb) sb.classList.add('-translate-x-full');
        if (bd) bd.classList.add('hidden');
      }
    });

    // Admin back button
    var adminBackBtn = el('adminBackBtn');
    if (adminBackBtn) adminBackBtn.addEventListener('click', function () { switchToApp('main'); });

    // Mode buttons
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchMode(btn.getAttribute('data-mode')); });
    });

    // PID control type selector
    var pidTypeSelect = el('pidControlType');
    if (pidTypeSelect) {
      pidTypeSelect.addEventListener('change', function () {
        currentPidControlType = pidTypeSelect.value;
        updatePIDInputsVisibility();
        if (currentMode === 'pid') { skipNextPoint = true; initCharts('pid'); }
      });
      updatePIDInputsVisibility();
    }

    // PID frequency selector
    var pidFreqSelect = el('pidFrequency');
    if (pidFreqSelect) {
      var initFreqVal = parseFloat(pidFreqSelect.value);
      if (!isNaN(initFreqVal) && initFreqVal > 0) lastPidFrequency = initFreqVal;
      pidFreqSelect.addEventListener('change', function () {
        var val = parseFloat(pidFreqSelect.value);
        if (!isNaN(val) && val > 0) {
          lastPidFrequency = val;
          saveProductPidValue('frequency', val);
          queueSend({ PID_Hz: val }, 'PID Frequency');
        }
      });
    }

    // ── Manual mode controls ─────────────────────────────────────────────────
    bindSlider('primarySlider', 'primaryDisplay', 'P', CFG.primaryOutput.label);
    loadProductPidValues();
    bindValveToggle('valveToggleBtn');
    if (CFG.secondaryOutput) bindSlider('secondarySlider', 'secondaryDisplay', 'F', CFG.secondaryOutput.label);

    // ── On/Off controls ──────────────────────────────────────────────────────
    bindSlider('onoffSetpointSlider', 'onoffSetpointDisplay', 'T', 'Setpoint');
    var onoffHys = el('onoffHysteresis');
    if (onoffHys) {
      onoffHys.addEventListener('change', function () {
        lastHysteresis = parseFloat(onoffHys.value);
        queueSend({ Y: lastHysteresis }, 'Hysteresis');
      });
    }
    bindValveToggle('onoffValveBtn');
    if (CFG.secondaryOutput) bindSlider('onoffSecondarySlider', 'onoffSecondaryDisplay', 'F', CFG.secondaryOutput.label);

    // ── PID controls ─────────────────────────────────────────────────────────
    bindSlider('pidSetpointSlider', 'pidSetpointDisplay', 'T', 'PID Setpoint');
    bindValveToggle('pidValveBtn');
    if (CFG.secondaryOutput) bindSlider('pidSecondarySlider', 'pidSecondaryDisplay', 'F', CFG.secondaryOutput.label);
    bindZeroSensor();
    var pidCommitBtn = el('pidCommitBtn');
    if (pidCommitBtn) pidCommitBtn.addEventListener('click', commitPID);
    var pidResetBtn = el('pidResetBtn');
    if (pidResetBtn) pidResetBtn.addEventListener('click', resetProductPidValues);
    var pidPInputEl = el('pidPInput');
    if (pidPInputEl) pidPInputEl.addEventListener('change', function () {
      var val = parseFloat(pidPInputEl.value);
      if (!isNaN(val)) { saveProductPidValue('P', val); queueSend({ PID_P: val }, 'PID P'); }
    });
    var pidIInputEl = el('pidIInput');
    if (pidIInputEl) pidIInputEl.addEventListener('change', function () {
      var val = parseFloat(pidIInputEl.value);
      if (!isNaN(val)) { saveProductPidValue('I', val); queueSend({ PID_I: val }, 'PID I'); }
    });
    var pidDInputEl = el('pidDInput');
    if (pidDInputEl) pidDInputEl.addEventListener('change', function () {
      var val = parseFloat(pidDInputEl.value);
      if (!isNaN(val)) { saveProductPidValue('D', val); queueSend({ PID_D: val }, 'PID D'); }
    });

    // ── Chart toolbar ────────────────────────────────────────────────────────
    var startCsvBtn = el('startCsvBtn'), stopCsvBtn = el('stopCsvBtn'), clearBtn = el('clearDataBtn');
    if (startCsvBtn) startCsvBtn.addEventListener('click', startCsv);
    if (stopCsvBtn)  stopCsvBtn.addEventListener('click',  stopCsv);
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (chartJsRef)  { chartJsRef.data.labels  = []; chartJsRef.data.datasets.forEach(function(d){d.data=[];}); chartJsRef.update(); }
        if (liveChartRef){ liveChartRef.data.labels = []; liveChartRef.data.datasets.forEach(function(d){d.data=[];}); liveChartRef.update(); }
      });
    }

    // Chart display mode (Last 50 pts / All Data)
    var chartDisplayModeSelect = el('chartDisplayMode');
    if (chartDisplayModeSelect) {
      chartDisplayModeSelect.addEventListener('change', function () {
        chartDisplayMode = chartDisplayModeSelect.value;
        if (chartJsRef)   { chartJsRef.data.labels   = []; chartJsRef.data.datasets.forEach(function(d){d.data=[];}); chartJsRef.update(); }
        if (liveChartRef) { liveChartRef.data.labels  = []; liveChartRef.data.datasets.forEach(function(d){d.data=[];}); liveChartRef.update(); }
      });
    }

    // ── Hardware type selector ───────────────────────────────────────────────
    var hwSelect = el('hardwareTypeSelect');
    if (hwSelect) {
      hwSelect.value = CFG.type;
      hwSelect.addEventListener('change', function () { navigateToHardware(hwSelect.value); });
    }

    // ── Hardware ID assignment ───────────────────────────────────────────────
    window.assignHardwareId = function () {
      var sel = el('hw-id-assign-select');
      var btn = el('hw-id-assign-btn');
      if (!sel || !btn || !isElectron || !api.sendCustomJson) return;
      var id = parseInt(sel.value, 10);
      if (isNaN(id)) return;
      btn.disabled = true; btn.textContent = 'Sending…';
      api.sendCustomJson({ A: id }, 'assign-hardware-id').then(function () {
        btn.textContent = '✓ Done';
        setTimeout(function () { btn.disabled = false; btn.textContent = 'Write ID to Hardware'; }, 2000);
      }, function () {
        btn.textContent = '✗ Failed'; btn.disabled = false;
      });
    };

    // Update detected-hw-id badge when hardware broadcasts its type
    if (isElectron && api.onHardwareIdReceived) {
      api.onHardwareIdReceived(function (data) {
        var badge = el('detected-hw-id');
        if (badge && data && data.id) {
          badge.textContent = data.info ? data.info.name + ' (ID ' + data.id + ')' : 'ID ' + data.id;
        }
      });
    }

    // ── Version display ──────────────────────────────────────────────────────
    if (isElectron && api.getAppVersion) {
      api.getAppVersion().then(function (v) {
        var vEl = el('currentVersionDisplay');
        if (vEl) vEl.textContent = (v && v.version) ? v.version : String(v);
      }).catch(function () {});
    }

    // ── Admin panel wiring ───────────────────────────────────────────────────
    setBootloaderButtonState('disconnected');
    loadAdminPIDDefaults();

    var adminPidProduct = el('adminPidProduct');
    if (adminPidProduct) {
      adminPidProduct.value = CFG.type;
      loadAdminPIDDefaults();
      adminPidProduct.addEventListener('change', function () {
        loadAdminPIDDefaults();
        var selected = adminPidProduct.options[adminPidProduct.selectedIndex];
        addLog('Loaded PID defaults for ' + (selected ? selected.textContent : adminPidProduct.value), 'info');
      });
    }

    var proportionalInput = el('proportionalInput');
    if (proportionalInput) {
      proportionalInput.addEventListener('change', function () {
        var v = this.value.trim();
        if (v !== lastProportionalValue && v !== '') {
          lastProportionalValue = v;
          saveAdminPIDValue(adminPidProduct ? adminPidProduct.value : CFG.type, 'P', v);
          updatePIDStatus('proportional', true, 'Saved');
        }
      });
    }
    var integralInput = el('integralInput');
    if (integralInput) {
      integralInput.addEventListener('change', function () {
        var v = this.value.trim();
        if (v !== lastIntegralValue && v !== '') {
          lastIntegralValue = v;
          saveAdminPIDValue(adminPidProduct ? adminPidProduct.value : CFG.type, 'I', v);
          updatePIDStatus('integral', true, 'Saved');
        }
      });
    }
    var differentialInput = el('differentialInput');
    if (differentialInput) {
      differentialInput.addEventListener('change', function () {
        var v = this.value.trim();
        if (v !== lastDifferentialValue && v !== '') {
          lastDifferentialValue = v;
          saveAdminPIDValue(adminPidProduct ? adminPidProduct.value : CFG.type, 'D', v);
          updatePIDStatus('differential', true, 'Saved');
        }
      });
    }
    var adminPidFrequency = el('adminPidFrequency');
    if (adminPidFrequency) {
      adminPidFrequency.addEventListener('change', function () {
        var v = parseFloat(this.value);
        if (!isNaN(v) && v > 0) {
          saveAdminPIDValue(adminPidProduct ? adminPidProduct.value : CFG.type, 'frequency', v);
          updatePIDStatus('proportional', true, 'Saved');
        }
      });
    }
    var pidRestoreBtn = el('pidRestoreDefaultsBtn');
    if (pidRestoreBtn) {
      pidRestoreBtn.addEventListener('click', function () {
        var type = adminPidProduct ? adminPidProduct.value : CFG.type;
        ['P', 'I', 'D', 'frequency'].forEach(function (term) {
          localStorage.removeItem('pid-' + type + '-' + term);
        });
        loadAdminPIDDefaults();
        var p = parseFloat((el('proportionalInput') || {}).value) || 0;
        var i = parseFloat((el('integralInput') || {}).value) || 0;
        var d = parseFloat((el('differentialInput') || {}).value) || 0;
        var frequency = parseFloat((el('adminPidFrequency') || {}).value) || 0;
        saveAdminPIDValue(type, 'P', p);
        saveAdminPIDValue(type, 'I', i);
        saveAdminPIDValue(type, 'D', d);
        saveAdminPIDValue(type, 'frequency', frequency);
        var rs = el('pidRestoreStatus');
        if (rs) { rs.textContent = 'Restored P=' + p + ', I=' + i + ', D=' + d + ', F=' + frequency + ' Hz'; setTimeout(function () { rs.textContent = ''; }, 4000); }
        addLog('PID defaults restored for ' + type + ': P=' + p + ', I=' + i + ', D=' + d + ', F=' + frequency + ' Hz', 'info');
      });
    }

    // ── Data listeners ───────────────────────────────────────────────────────
    if (isElectron) {
      api.onJsonDataReceived(function (event, data) { handleJsonData(data); });
      api.onConnectionStatus(function (event, status) { setConnected(status.connected, status.message); });
      api.onUiDebugLog(function (event, payload) { addLog(payload.message || String(payload), 'info'); });
      api.onSerialTxDebug(function (event, payload) { addRawData('TX: ' + (payload.raw || JSON.stringify(payload))); });
      if (api.onWebServerUrl) {
        api.onWebServerUrl(function (event, info) { applyServerInfo(info); });
      }
      if (api.getWebServerUrl) {
        api.getWebServerUrl().then(function (info) { if (info) applyServerInfo(info); }).catch(function () {});
      }
      if (api.onUpdateStatus) {
        api.onUpdateStatus(function (event, updateInfo) { handleUpdateStatus(updateInfo); });
      }
      if (api.onBootloaderProgress) {
        api.onBootloaderProgress(function (data) {
          var mode = data.step === 'erase' ? 'erase' : (data.step === 'verify' ? 'verify' : 'program');
          showFirmwareProgress(data.label, data.progress, mode);
          updateFirmwareProgress(data.label, data.progress);
          if (data.progress >= 100 && (data.step === 'verify' || String(data.label).includes('completed')))
            setTimeout(hideFirmwareProgress, 3000);
        });
      }
    } else {
      setupSSE();
    }

    // ── Initial state ────────────────────────────────────────────────────────
    initCharts('manual');
    switchToApp('main');
    addLog(CFG.name + ' Control initialized', 'info');
  }

  function applyServerInfo(info) {
    var urlEl = el('webServerUrl'), ipEl = el('webServerIp'), qrEl = el('webServerQr');
    if (urlEl) { urlEl.textContent = info.url; urlEl.href = info.url; }
    if (ipEl && info.ips && info.ips.length) ipEl.textContent = info.ips.join(', ');
    else if (ipEl) ipEl.textContent = info.url;
    if (qrEl && info.qrCode) { qrEl.src = info.qrCode; qrEl.classList.remove('hidden'); }
  }

  document.addEventListener('DOMContentLoaded', init);

})();
