// --- Global Graph State ---
var chartData = { series: Array.from({ length: 3 }, function () { return []; }), enabled: Array.from({ length: 3 }, function () { return true; }) };
var maxPoints = 50; // show last 50 points by default
var chartDisplayMode = 'all'; // 'limited' or 'all' - controls whether to limit points or show all data
var isSavingCsv = false; // flag to track if CSV saving is active
var csvData = []; // array to store data for CSV export
var csvSavePath = null; // path where CSV will be saved
var csvSessionMode = null; // mode used for current CSV session
var csvSessionPidControlType = null; // PID control type used for current CSV session
var chartJsRef = null;
var currentChartMode = null; // Track which mode the chart is initialized for: 'manual', 'onoff', or 'pid'
var currentChartControlType = null; // Track PID control type when in PID mode: 'P', 'PI', 'PD', or 'PID'
// Global control mode state so addPoint and JSON handler always see a defined value
var currentControlMode = 'manual'; // 'manual', 'onoff', or 'pid'
// Flag to skip first data point after mode switch (to avoid showing stale hardware data)
var skipNextDataPoint = false;
// Global On/Off mode variables - must be accessible to addPoint function
var onoffTargetTemp = 20; // Default target temperature for On/Off mode
var onoffHysteresisValue = 3; // Default hysteresis value
// Global PID mode variables - must be accessible to addPoint function
var pidTargetTemp = 20; // Default target temperature for PID mode

// Track last known values from hardware to avoid unnecessary UI updates
var lastKnownFanSpeed = null;
var lastKnownPower = null;
var lastKnownTemperature = null;

// Pending user-sent values — prevent hardware echo from snapping slider back
var pendingPowerValue = null;
var pendingPowerTimeout = null;
var pendingFanValue = null;
var pendingFanTimeout = null;
var manualOverheatSafetyActive = false;

// Storage for PID values from hardware (second JSON message)
// These are updated separately from T, P, F values
var lastPidValues = {
    proportional: 0,
    integral: 0,
    derivative: 0,
    output: 0
};

var pendingIntermediateTPackets = []; // {T, receivedAt} buffered T-only packets between main packets
var lastMainPacketTime = null;        // ms timestamp of last main {T,P,F} packet
var lastKnownP = 0;                   // carry-forward power from last main packet
var lastKnownF = 0;                   // carry-forward fan from last main packet

var chartInactivityTimeoutMs = 20 * 60 * 1000; // 20 minutes
var lastControlChangeAt = Date.now();
var isChartPausedForInactivity = false;

// ── Temperature unit preference ───────────────────────────────────────────────
var currentTempUnit = localStorage.getItem('temp-unit') || 'C'; // 'C' or 'F'

function celsiusToFahrenheit(c) { return (c * 9 / 5) + 32; }
function fahrenheitToCelsius(f) { return (f - 32) * 5 / 9; }

function updateTempUnitUI() {
    var isFahrenheit = currentTempUnit === 'F';
    var symbol       = isFahrenheit ? '°F' : '°C';
    var minTemp      = isFahrenheit ? 68  : 20;
    var maxTemp      = isFahrenheit ? 158 : 70;
    var btn0Val      = isFahrenheit ? 68  : 20;
    var btn50Val     = isFahrenheit ? 122 : 50;
    var btn100Val    = isFahrenheit ? 158 : 70;

    // Update all °C / °F suffix spans
    document.querySelectorAll('.temp-unit-suffix').forEach(function(el) {
        el.textContent = symbol;
    });

    // Update On/Off target slider
    var onoffSlider  = document.getElementById('onoffTargetSlider');
    var onoffDisplay = document.getElementById('onoffTargetDisplay');
    if (onoffSlider) {
        var curCelsius = isFahrenheit ? fahrenheitToCelsius(parseFloat(onoffSlider.value)) : parseFloat(onoffSlider.value);
        var newVal = isFahrenheit ? Math.round(celsiusToFahrenheit(curCelsius)) : Math.round(curCelsius);
        newVal = Math.max(minTemp, Math.min(maxTemp, newVal));
        onoffSlider.min = minTemp; onoffSlider.max = maxTemp; onoffSlider.value = newVal;
        if (onoffDisplay) { onoffDisplay.min = minTemp; onoffDisplay.max = maxTemp; onoffDisplay.value = newVal; }
        onoffTargetTemp = isFahrenheit ? fahrenheitToCelsius(newVal) : newVal;
    }

    // Update PID target slider
    var pidSlider  = document.getElementById('pidTargetSlider');
    var pidDisplay = document.getElementById('pidTargetDisplay');
    if (pidSlider) {
        var curCelsiusPid = isFahrenheit ? fahrenheitToCelsius(parseFloat(pidSlider.value)) : parseFloat(pidSlider.value);
        var newValPid = isFahrenheit ? Math.round(celsiusToFahrenheit(curCelsiusPid)) : Math.round(curCelsiusPid);
        newValPid = Math.max(minTemp, Math.min(maxTemp, newValPid));
        pidSlider.min = minTemp; pidSlider.max = maxTemp; pidSlider.value = newValPid;
        if (pidDisplay) { pidDisplay.min = minTemp; pidDisplay.max = maxTemp; pidDisplay.value = newValPid; }
        pidTargetTemp = isFahrenheit ? fahrenheitToCelsius(newValPid) : newValPid;
    }

    // Update quick-set button labels
    var onoffBtn0   = document.getElementById('onoffTarget0');
    var onoffBtn50  = document.getElementById('onoffTarget50');
    var onoffBtn100 = document.getElementById('onoffTarget100');
    var pidBtn0     = document.getElementById('pidTarget0');
    var pidBtn50    = document.getElementById('pidTarget50');
    var pidBtn100   = document.getElementById('pidTarget100');
    if (onoffBtn0)   onoffBtn0.textContent   = btn0Val   + symbol;
    if (onoffBtn50)  onoffBtn50.textContent  = btn50Val  + symbol;
    if (onoffBtn100) onoffBtn100.textContent = btn100Val + symbol;
    if (pidBtn0)     pidBtn0.textContent     = btn0Val   + symbol;
    if (pidBtn50)    pidBtn50.textContent    = btn50Val  + symbol;
    if (pidBtn100)   pidBtn100.textContent   = btn100Val + symbol;

    // Update hysteresis option labels (delta conversion: ×1.8 for °F)
    var hysteresisSelect = document.getElementById('onoffHysteresis');
    if (hysteresisSelect) {
        Array.from(hysteresisSelect.options).forEach(function(opt) {
            var cVal = parseFloat(opt.value);
            if (isFahrenheit) {
                opt.text = Math.round(cVal * 18) / 10 + ' °F';
            } else {
                opt.text = cVal + ' °C';
            }
        });
    }

    // Reset heater display so it shows next hardware value in new unit
    var heaterTempBigEl = document.getElementById('heaterTempBig');
    if (heaterTempBigEl) heaterTempBigEl.textContent = '--.-';

    // Reinitialise chart for current mode so axis labels update
    if (currentChartMode === 'manual') {
        clearAllGraphs(); initChartForManual();
    } else if (currentChartMode === 'onoff') {
        clearAllGraphs(); initChartForOnOff();
    } else if (currentChartMode === 'pid') {
        clearAllGraphs(); initChartForPID(currentChartControlType || 'PID');
    }

    // Sync admin radio buttons
    document.querySelectorAll('input[name="tempUnit"]').forEach(function(r) {
        r.checked = r.value === currentTempUnit;
    });

    // Trigger layout.js set-point refresh by firing an input event on the active slider
    var activeSlider = document.getElementById(
        currentControlMode === 'onoff' ? 'onoffTargetSlider' : 'pidTargetSlider'
    );
    if (activeSlider) activeSlider.dispatchEvent(new Event('input', { bubbles: true }));
}

async function setTemperatureUnit(unit) {
    currentTempUnit = unit;
    localStorage.setItem('temp-unit', unit);
    var kVal = unit === 'F' ? 1 : 0;
    if (window.electronAPI && window.electronAPI.sendCustomJson) {
        try { await window.electronAPI.sendCustomJson({ K: kVal }, 'temp-unit'); } catch (e) { /* web mode */ }
    }
    updateTempUnitUI();
}

function updateChartStatusBadge(paused) {
    var badge = document.getElementById('chartStatusBadge');
    if (!badge) return;
    if (paused) {
        badge.textContent = 'STOPPED';
        badge.classList.remove('badge-success');
        badge.classList.add('badge-error');
    } else {
        badge.textContent = 'LIVE';
        badge.classList.remove('badge-error');
        badge.classList.add('badge-success');
    }
}

function markUserControlActivity() {
    lastControlChangeAt = Date.now();
    if (isChartPausedForInactivity) {
        isChartPausedForInactivity = false;
        addToLog('Chart updates resumed after user control change.');
        updateChartStatusBadge(false);
    }
}

function refreshChartPauseState() {
    var now = Date.now();
    var inactivityDurationMs = now - lastControlChangeAt;
    if (!isChartPausedForInactivity && inactivityDurationMs >= chartInactivityTimeoutMs) {
        isChartPausedForInactivity = true;
        addToLog('Chart updates paused after 20 minutes of no control changes.');
        updateChartStatusBadge(true);
    }
}

function getPidControlTypeFromUI() {
    var pidControlTypeSelect = document.getElementById('pidControlType');
    if (pidControlTypeSelect && pidControlTypeSelect.value) {
        return pidControlTypeSelect.value;
    }
    return 'PID';
}

function getCurrentFanPercentForMode(modeName, fallbackFanValue) {
    if (modeName === 'manual') {
        var manualFanDisplay = document.getElementById('fanSpeedDisplay');
        var manualFanSlider = document.getElementById('fanSpeed');
        if (manualFanDisplay) {
            var manualFanDisplayValue = parseInt(manualFanDisplay.value, 10);
            if (!isNaN(manualFanDisplayValue)) return manualFanDisplayValue;
        }
        if (manualFanSlider) {
            var manualFanSliderValue = parseInt(manualFanSlider.value, 10);
            if (!isNaN(manualFanSliderValue)) return manualFanSliderValue;
        }
    } else if (modeName === 'onoff') {
        var onoffFanDisplayElement = document.getElementById('onoffFanSpeedDisplay');
        var onoffFanSliderElement = document.getElementById('onoffFanSpeed');
        if (onoffFanDisplayElement) {
            var onoffFanDisplayValue = parseInt(onoffFanDisplayElement.value, 10);
            if (!isNaN(onoffFanDisplayValue)) return onoffFanDisplayValue;
        }
        if (onoffFanSliderElement) {
            var onoffFanSliderValue = parseInt(onoffFanSliderElement.value, 10);
            if (!isNaN(onoffFanSliderValue)) return onoffFanSliderValue;
        }
    } else if (modeName === 'pid') {
        var pidFanDisplayElement = document.getElementById('pidFanSpeedDisplay');
        var pidFanSliderElement = document.getElementById('pidFanSpeed');
        if (pidFanDisplayElement) {
            var pidFanDisplayValue = parseInt(pidFanDisplayElement.value, 10);
            if (!isNaN(pidFanDisplayValue)) return pidFanDisplayValue;
        }
        if (pidFanSliderElement) {
            var pidFanSliderValue = parseInt(pidFanSliderElement.value, 10);
            if (!isNaN(pidFanSliderValue)) return pidFanSliderValue;
        }
    }

    if (typeof fallbackFanValue === 'number' && !isNaN(fallbackFanValue)) {
        return fallbackFanValue;
    }
    return 0;
}

function getCsvHeaderLineForMode(modeName) {
    if (modeName === 'manual') {
        return 'PowerPercent,HeaterTempC,FanPercent\n';
    }
    if (modeName === 'onoff') {
        return 'TargetTempC,HeaterTempC,HysteresisC,PowerInput,FanPercent\n';
    }
    if (modeName === 'pid') {
        return 'PIDControlType,TargetTempC,HeaterTempC,Output,Proportional,Integral,Derivative,FanPercent,PID_P_Set,PID_I_Set,PID_D_Set,PID_Frequency\n';
    }
    return 'Value\n';
}

function addCsvRowForCurrentSession(rowData) {
    if (!isSavingCsv || !csvSessionMode) {
        return;
    }
    if (csvSavePath && window.electronAPI && window.electronAPI.appendFile) {
        // Flush straight to disk so data already captured survives a sudden app close,
        // instead of only living in memory until Stop is pressed.
        window.electronAPI.appendFile(csvSavePath, rowData + '\n').then(function (result) {
            if (!result || !result.success) {
                addToLog('Error appending CSV row: ' + ((result && result.error) || 'Unknown error'));
            }
        }).catch(function (error) {
            addToLog('Error appending CSV row: ' + (error && error.message || error));
        });
    } else {
        csvData.push(rowData);
    }
}


// Function to completely clear and destroy all graph traces
function clearAllGraphs() {
    // Clear chart data
    chartData.series = [];
    chartData.enabled = [];
    
    // Stop hysteresis monitor if it's running
    if (window.hysteresisMonitorInterval) {
        clearInterval(window.hysteresisMonitorInterval);
        window.hysteresisMonitorInterval = null;
    }
    
    var primaryCanvas = document.getElementById('testChartPrimary');
    var secondaryCanvas = document.getElementById('testChartSecondary');
    
    // Destroy chartJsRef if it exists
    if (chartJsRef) {
        try {
            // Clear all data from datasets before destroying
            if (chartJsRef.data && chartJsRef.data.datasets) {
                for (var i = 0; i < chartJsRef.data.datasets.length; i++) {
                    chartJsRef.data.datasets[i].data = [];
                }
            }
            if (chartJsRef.data && chartJsRef.data.labels) {
                chartJsRef.data.labels = [];
            }
            // Force update with cleared data before destroying
            chartJsRef.update('none');
            // Small delay to ensure update completes
            chartJsRef.destroy();
        } catch (e) { /* ignore */ }
        chartJsRef = null;
    }
    
    // Destroy liveChartRef if it exists
    if (window.liveChartRef) {
        try {
            // Clear all data from datasets before destroying
            if (window.liveChartRef.data && window.liveChartRef.data.datasets) {
                for (var i = 0; i < window.liveChartRef.data.datasets.length; i++) {
                    window.liveChartRef.data.datasets[i].data = [];
                }
            }
            if (window.liveChartRef.data && window.liveChartRef.data.labels) {
                window.liveChartRef.data.labels = [];
            }
            // Force update with cleared data before destroying
            window.liveChartRef.update('none');
            window.liveChartRef.destroy();
        } catch (e) { /* ignore */ }
        window.liveChartRef = null;
    }
    
    function destroyChartOnCanvas(canvasElement) {
        if (!canvasElement || !window.Chart) {
            return;
        }
        var chartOnCanvas = Chart.getChart(canvasElement);
        if (chartOnCanvas) {
            try {
                chartOnCanvas.destroy();
            } catch (e) { /* ignore */ }
        }
        var context = canvasElement.getContext('2d');
        if (context) {
            context.save();
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, canvasElement.width, canvasElement.height);
            context.restore();
        }
    }

    destroyChartOnCanvas(primaryCanvas);
    destroyChartOnCanvas(secondaryCanvas);
    
    currentChartMode = null;
    currentChartControlType = null;
}

// Function to initialize chart for Manual mode (2 series: Linear Heater/Temperature, Power)
function initChartForManual() {
    // CRITICAL: Never create Manual chart if we're supposed to be in On/Off mode
    if (currentControlMode === 'onoff') {
        return;
    }
    
    clearAllGraphs();
    
    var primaryCanvas = document.getElementById('testChartPrimary');
    var secondaryCanvas = document.getElementById('testChartSecondary');
    if (!primaryCanvas || !secondaryCanvas || !window.Chart) return;

    var primaryCtx = primaryCanvas.getContext('2d');
    var secondaryCtx = secondaryCanvas.getContext('2d');
    var themeColors = getChartThemeColors();

    chartJsRef = new Chart(primaryCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Heater Temperature',
                data: [],
                borderColor: 'rgb(59, 130, 246)',
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.35,
                fill: false,
                hidden: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            animation: false,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        autoSkip: true,
                        maxTicksLimit: 10
                    }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Temperature (' + (currentTempUnit === 'F' ? '°F' : '°C') + ')',
                        color: themeColors.text,
                        font: { size: 16, weight: 'bold', family: 'Inter, sans-serif' }
                    },
                    grid: { color: 'rgba(148, 163, 184, 0.1)', display: true },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        callback: function(value) {
                            return Math.round(value) + (currentTempUnit === 'F' ? '°F' : '°C');
                        }
                    },
                    beginAtZero: false,
                    suggestedMin: 0,
                    suggestedMax: 100
                }
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        padding: 12,
                        usePointStyle: true,
                        generateLabels: function(chart) {
                            var original = Chart.defaults.plugins.legend.labels.generateLabels;
                            var labels = original.call(this, chart);
                            labels.forEach(function(label, index) {
                                var meta = chart.getDatasetMeta(index);
                                var isHidden = meta.hidden === true || (meta.hidden === null && chart.data.datasets[index].hidden === true);
                                if (isHidden) {
                                    label.fillStyle = 'transparent';
                                } else {
                                    label.fillStyle = label.strokeStyle;
                                }
                            });
                            return labels;
                        }
                    },
                    onClick: function(e, legendItem, legend) {
                        var index = legendItem.datasetIndex;
                        var ci = legend.chart;
                        var meta = ci.getDatasetMeta(index);
                        meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
                        ci.update();
                    }
                }
            }
        }
    });

    window.liveChartRef = new Chart(secondaryCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Power',
                data: [],
                borderColor: 'rgb(16, 185, 129)',
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.35,
                fill: false,
                hidden: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            animation: false,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        autoSkip: true,
                        maxTicksLimit: 10
                    }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Power (%)',
                        color: themeColors.text,
                        font: { size: 16, weight: 'bold', family: 'Inter, sans-serif' }
                    },
                    grid: { color: 'rgba(148, 163, 184, 0.1)', display: true },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        callback: function(value) {
                            return Math.round(value);
                        }
                    },
                    beginAtZero: true,
                    suggestedMin: 0,
                    suggestedMax: 100
                }
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        padding: 12,
                        usePointStyle: true,
                        generateLabels: function(chart) {
                            var original = Chart.defaults.plugins.legend.labels.generateLabels;
                            var labels = original.call(this, chart);
                            labels.forEach(function(label, index) {
                                var meta = chart.getDatasetMeta(index);
                                var isHidden = meta.hidden === true || (meta.hidden === null && chart.data.datasets[index].hidden === true);
                                if (isHidden) {
                                    label.fillStyle = 'transparent';
                                } else {
                                    label.fillStyle = label.strokeStyle;
                                }
                            });
                            return labels;
                        }
                    },
                    onClick: function(e, legendItem, legend) {
                        var index = legendItem.datasetIndex;
                        var ci = legend.chart;
                        var meta = ci.getDatasetMeta(index);
                        meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
                        ci.update();
                    }
                }
            }
        }
    });

    // Update chart data structure for manual mode
    chartData.series = Array.from({ length: 2 }, function () { return []; });
    chartData.enabled = Array.from({ length: 2 }, function () { return true; });
    currentChartMode = 'manual';
    currentChartControlType = null; // ControlType not applicable for manual mode
    
    // Skip first data point after mode switch to avoid stale hardware data
    skipNextDataPoint = true;
    
    updateChartTheme();
}

// Function to initialize chart for On/Off mode (4 series: Temperature, Target Temperature, Hysteresis, Power)
function initChartForOnOff() {
    // CRITICAL: Ensure we're in On/Off mode before clearing graphs
    currentControlMode = 'onoff';
    clearAllGraphs();
    
    var primaryCanvas = document.getElementById('testChartPrimary');
    var secondaryCanvas = document.getElementById('testChartSecondary');
    if (!primaryCanvas || !secondaryCanvas || !window.Chart) {
        return;
    }

    var primaryCtx = primaryCanvas.getContext('2d');
    var secondaryCtx = secondaryCanvas.getContext('2d');
    var themeColors = getChartThemeColors();
    chartJsRef = new Chart(primaryCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Heater Temperature',
                    data: [],
                    borderColor: 'rgb(59, 130, 246)',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.35,
                    fill: false,
                    spanGaps: true,
                    hidden: false
                },
                {
                    label: 'Target Temperature',
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
                },
                {
                    label: 'Hysteresis Low',
                    data: [],
                    borderColor: 'rgb(249, 115, 22)',
                    backgroundColor: 'transparent',
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.35,
                    fill: false,
                    spanGaps: true,
                    borderDash: [5, 5],
                    hidden: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        padding: 12,
                        usePointStyle: true,
                        generateLabels: function(chart) {
                            var original = Chart.defaults.plugins.legend.labels.generateLabels;
                            var labels = original.call(this, chart);
                            labels.forEach(function(label, index) {
                                var meta = chart.getDatasetMeta(index);
                                var isHidden = meta.hidden === true || (meta.hidden === null && chart.data.datasets[index].hidden === true);
                                if (isHidden) {
                                    label.fillStyle = 'transparent';
                                } else {
                                    label.fillStyle = label.strokeStyle;
                                }
                            });
                            return labels;
                        }
                    },
                    onClick: function(e, legendItem, legend) {
                        var index = legendItem.datasetIndex;
                        var ci = legend.chart;
                        var meta = ci.getDatasetMeta(index);
                        meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
                        ci.update();
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        autoSkip: true,
                        maxTicksLimit: 10
                    }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Temperature (' + (currentTempUnit === 'F' ? '°F' : '°C') + ')',
                        color: themeColors.text,
                        font: { size: 16, weight: 'bold', family: 'Inter, sans-serif' }
                    },
                    grid: { color: 'rgba(148, 163, 184, 0.1)', display: true },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        callback: function(value) {
                            return Math.round(value) + (currentTempUnit === 'F' ? '°F' : '°C');
                        }
                    },
                    beginAtZero: false,
                    suggestedMin: 0,
                    suggestedMax: 100
                }
            }
        }
    });

    window.liveChartRef = new Chart(secondaryCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Power',
                data: [],
                borderColor: 'rgb(16, 185, 129)',
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.35,
                fill: false,
                hidden: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        padding: 12,
                        usePointStyle: true,
                        generateLabels: function(chart) {
                            var original = Chart.defaults.plugins.legend.labels.generateLabels;
                            var labels = original.call(this, chart);
                            labels.forEach(function(label, index) {
                                var meta = chart.getDatasetMeta(index);
                                var isHidden = meta.hidden === true || (meta.hidden === null && chart.data.datasets[index].hidden === true);
                                if (isHidden) {
                                    label.fillStyle = 'transparent';
                                } else {
                                    label.fillStyle = label.strokeStyle;
                                }
                            });
                            return labels;
                        }
                    },
                    onClick: function(e, legendItem, legend) {
                        var index = legendItem.datasetIndex;
                        var ci = legend.chart;
                        var meta = ci.getDatasetMeta(index);
                        meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
                        ci.update();
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        autoSkip: true,
                        maxTicksLimit: 10
                    }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Power (%)',
                        color: themeColors.text,
                        font: { size: 16, weight: 'bold', family: 'Inter, sans-serif' }
                    },
                    grid: { color: 'rgba(148, 163, 184, 0.1)', display: true },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        callback: function(value) {
                            return Math.round(value);
                        }
                    },
                    beginAtZero: true,
                    suggestedMin: 0,
                    suggestedMax: 100
                }
            }
        }
    });

    // Update chart data structure for onoff mode
    chartData.series = Array.from({ length: 4 }, function () { return []; });
    chartData.enabled = Array.from({ length: 4 }, function () { return true; });
    currentChartMode = 'onoff';
    currentChartControlType = null; // ControlType not applicable for onoff mode
    
    // CRITICAL: Verify the chart was created correctly
    if (!window.liveChartRef) {
        return;
    }
    
    // No initial placeholder data points - wait for real data from hardware
    // This ensures the first data point shown is actual hardware data, not a placeholder
    
    // Skip first data point after mode switch to avoid stale hardware data
    skipNextDataPoint = true;
    
    updateChartTheme();
}

// Function to initialize chart for PID mode based on control type
function initChartForPID(controlType) {
    clearAllGraphs();
    
    var primaryCanvas = document.getElementById('testChartPrimary');
    var secondaryCanvas = document.getElementById('testChartSecondary');
    if (!primaryCanvas || !secondaryCanvas || !window.Chart) return;
    
    // Get control type from dropdown if not provided
    if (!controlType) {
        var pidControlTypeSelect = document.getElementById('pidControlType');
        controlType = pidControlTypeSelect ? pidControlTypeSelect.value : 'PID';
    }
    
    var primaryCtx = primaryCanvas.getContext('2d');
    var secondaryCtx = secondaryCanvas.getContext('2d');
    var themeColors = getChartThemeColors();
    primaryCanvas.style.background = themeColors.background;
    primaryCanvas.style.borderColor = themeColors.border;
    secondaryCanvas.style.background = themeColors.background;
    secondaryCanvas.style.borderColor = themeColors.border;
    
    // Primary Y-axis series (all PID types): Temperature, Target Temperature
    var primarySeries = [
        { label: 'Heater Temperature', color: '#40a9ff' },
        { label: 'Target Temperature', color: '#ff007a' }
    ];
    
    // Secondary Y-axis series (varies by control type)
    var secondarySeries = [];
    // Mid-tone colors chosen so each line is legible on both light and dark themes.
    var pidColors = {
        Output: '#8b5cf6',        // violet-500
        Proportional: '#eab308',  // amber-500
        Integral: '#16a34a',      // green-600
        Derivative: '#0891b2'     // cyan-700
    };
    if (controlType === 'P') {
        secondarySeries = [
            { label: 'Output', color: pidColors.Output },
            { label: 'Proportional', color: pidColors.Proportional }
        ];
    } else if (controlType === 'PI') {
        secondarySeries = [
            { label: 'Output', color: pidColors.Output },
            { label: 'Proportional', color: pidColors.Proportional },
            { label: 'Integral', color: pidColors.Integral }
        ];
    } else if (controlType === 'PD') {
        secondarySeries = [
            { label: 'Output', color: pidColors.Output },
            { label: 'Proportional', color: pidColors.Proportional },
            { label: 'Derivative', color: pidColors.Derivative }
        ];
    } else if (controlType === 'PID') {
        secondarySeries = [
            { label: 'Output', color: pidColors.Output },
            { label: 'Proportional', color: pidColors.Proportional },
            { label: 'Integral', color: pidColors.Integral },
            { label: 'Derivative', color: pidColors.Derivative }
        ];
    }
    
    var primaryDatasets = [];
    var secondaryDatasets = [];
    var totalSeries = primarySeries.length + secondarySeries.length;

    // Add primary chart series (Temperature, Target Temperature)
    for (var i = 0; i < primarySeries.length; i++) {
        var series = primarySeries[i];
        var baseColor = series.color;
        
        primaryDatasets.push({
            label: series.label,
            data: [],
            borderColor: baseColor,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.35,
            fill: false, // No fill/shadow effect
            hidden: false  // Ensure dataset is not hidden even when empty
        });
    }

    // Add secondary chart series (Output, P, I, D terms)
    for (var j = 0; j < secondarySeries.length; j++) {
        var series = secondarySeries[j];
        var baseColor = series.color;

        secondaryDatasets.push({
            label: series.label,
            data: [],
            borderColor: baseColor,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.35,
            fill: false, // No fill/shadow effect
            hidden: false  // Ensure dataset is not hidden even when empty
        });
    }
    
    chartJsRef = new Chart(primaryCtx, {
        type: 'line',
        data: { labels: [], datasets: primaryDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            animation: false,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { 
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        autoSkip: true,          // automatically skip labels
                        maxTicksLimit: 10        // show at most 10 time labels
                    }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Temperature (' + (currentTempUnit === 'F' ? '°F' : '°C') + ')',
                        color: themeColors.text,
                        font: { size: 16, weight: 'bold', family: 'Inter, sans-serif' }
                    },
                    grid: { color: 'rgba(148, 163, 184, 0.1)', display: true },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        callback: function(value) {
                            return Math.round(value) + (currentTempUnit === 'F' ? '°F' : '°C');
                        }
                    },
                    beginAtZero: false,
                    suggestedMin: 0,
                    suggestedMax: 100
                }
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        padding: 12,
                        usePointStyle: true,
                        generateLabels: function(chart) {
                            var original = Chart.defaults.plugins.legend.labels.generateLabels;
                            var labels = original.call(this, chart);
                            // Update point style based on visibility
                            labels.forEach(function(label, index) {
                                var meta = chart.getDatasetMeta(index);
                                // Check if dataset is hidden (meta.hidden can be true, false, or null)
                                var isHidden = meta.hidden === true || (meta.hidden === null && chart.data.datasets[index].hidden === true);
                                if (isHidden) {
                                    // When hidden, show only border (unfilled)
                                    label.fillStyle = 'transparent';
                                } else {
                                    // When visible, show filled circle
                                    label.fillStyle = label.strokeStyle;
                                }
                            });
                            return labels;
                        }
                    },
                    onClick: function(e, legendItem, legend) {
                        var index = legendItem.datasetIndex;
                        var ci = legend.chart;
                        var meta = ci.getDatasetMeta(index);
                        
                        // Toggle visibility
                        meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
                        ci.update();
                    }
                }
            }
        }
    });

    window.liveChartRef = new Chart(secondaryCtx, {
        type: 'line',
        data: { labels: [], datasets: secondaryDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            animation: false,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        autoSkip: true,
                        maxTicksLimit: 10
                    }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Control Terms',
                        color: themeColors.text,
                        font: { size: 16, weight: 'bold', family: 'Inter, sans-serif' }
                    },
                    grid: { color: 'rgba(148, 163, 184, 0.1)', display: true },
                    ticks: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' }
                    },
                    beginAtZero: false,
                    suggestedMin: -100,
                    suggestedMax: 100
                }
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: themeColors.text,
                        font: { size: 14, family: 'Inter, sans-serif' },
                        padding: 12,
                        usePointStyle: true,
                        generateLabels: function(chart) {
                            var original = Chart.defaults.plugins.legend.labels.generateLabels;
                            var labels = original.call(this, chart);
                            labels.forEach(function(label, index) {
                                var meta = chart.getDatasetMeta(index);
                                var isHidden = meta.hidden === true || (meta.hidden === null && chart.data.datasets[index].hidden === true);
                                if (isHidden) {
                                    label.fillStyle = 'transparent';
                                } else {
                                    label.fillStyle = label.strokeStyle;
                                }
                            });
                            return labels;
                        }
                    },
                    onClick: function(e, legendItem, legend) {
                        var index = legendItem.datasetIndex;
                        var ci = legend.chart;
                        var meta = ci.getDatasetMeta(index);
                        meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
                        ci.update();
                    }
                }
            }
        }
    });
    
    // Update chart data structure for PID mode
    chartData.series = Array.from({ length: totalSeries }, function () { return []; });
    chartData.enabled = Array.from({ length: totalSeries }, function () { return true; });
    chartData.pidControlType = controlType; // Store current control type
    currentChartMode = 'pid';
    currentChartControlType = controlType; // Track control type for validation
    
    // Skip first data point after mode switch to avoid stale hardware data
    skipNextDataPoint = true;
    
    updateChartTheme();
}

// Legacy function - now redirects to mode-specific initialization
function initChart() {
    // Default to manual mode on initial load
    initChartForManual();
}
// function initChart() { REMOVED }

// Auto-scale Y-axis to use whole numbers with minimum 5 range
function autoScaleYAxis(chart) {
    if (!chart || !chart.data || !chart.data.datasets) return;
    
    // Collect values from all visible datasets in this chart
    var values = [];
    
    for (var i = 0; i < chart.data.datasets.length; i++) {
        var dataset = chart.data.datasets[i];
        var meta = chart.getDatasetMeta(i);
        
        // Only include data from visible datasets
        if (!meta.hidden && !dataset.hidden) {
            for (var j = 0; j < dataset.data.length; j++) {
                var val = dataset.data[j];
                if (val !== null && val !== undefined && !isNaN(val)) {
                    values.push(val);
                }
            }
        }
    }
    
    // Auto-scale chart Y-axis
    if (values.length > 0) {
        var tempMin = Math.min.apply(Math, values);
        var tempMax = Math.max.apply(Math, values);
        var tempRange = tempMax - tempMin;
        
        var tempPadding = Math.max(tempRange * 0.15, 2);
        var newTempMin = tempMin - tempPadding;
        var newTempMax = tempMax + tempPadding;
        
        // Ensure minimum range of 5
        if (newTempMax - newTempMin < 5) {
            var center = (newTempMin + newTempMax) / 2;
            newTempMin = center - 2.5;
            newTempMax = center + 2.5;
        }
        
        // Round to whole numbers
        newTempMin = Math.floor(newTempMin);
        newTempMax = Math.ceil(newTempMax);
        
        // Ensure we still have at least 5 range after rounding
        if (newTempMax - newTempMin < 5) {
            newTempMax = newTempMin + 5;
        }
        
        // Update chart scale
        if (chart.options.scales.y) {
            chart.options.scales.y.min = newTempMin;
            chart.options.scales.y.max = newTempMax;
        }
    }
}

function addPoint(valuesArray13, options) {
    options = options || {};
    // Skip first data point after mode switch to avoid stale hardware data
    if (skipNextDataPoint) {
        console.log('⏭️ Skipping first data point after mode switch to avoid stale hardware data');
        skipNextDataPoint = false;
        return; // Skip this data point completely
    }
    
    // Validate graph matches current ControlMode and ControlType conditions
    var needsReinit = false;
    var reinitMode = null;
    var reinitControlType = null;
    
    // Check if ControlMode matches chart mode
    if (currentControlMode === 'manual') {
        if (currentChartMode !== 'manual') {
            needsReinit = true;
            reinitMode = 'manual';
        }
    } else if (currentControlMode === 'onoff') {
        if (currentChartMode !== 'onoff' || !chartJsRef || !window.liveChartRef) {
            needsReinit = true;
            reinitMode = 'onoff';
        }
    } else if (currentControlMode === 'pid') {
        // For PID mode, also check ControlType
        var pidControlTypeSelect = document.getElementById('pidControlType');
        var expectedControlType = pidControlTypeSelect ? pidControlTypeSelect.value : 'PID';
        if (currentChartMode !== 'pid' || currentChartControlType !== expectedControlType) {
            needsReinit = true;
            reinitMode = 'pid';
            reinitControlType = expectedControlType;
        }
    }
    
    // Reinitialize graph if conditions don't match
    if (needsReinit) {
        if (reinitMode === 'manual') {
            // CRITICAL: Double-check we're not in On/Off mode before creating Manual chart
            if (currentControlMode === 'onoff') {
                initChartForOnOff();
            } else {
                initChartForManual();
            }
        } else if (reinitMode === 'onoff') {
            // CRITICAL: Set currentControlMode BEFORE initializing chart to prevent race condition
            currentControlMode = 'onoff';
            initChartForOnOff();
        } else if (reinitMode === 'pid') {
            initChartForPID(reinitControlType || 'PID');
        }
        return; // Skip this data point, will be added on next call
    }
    
    // Only add data if chart is initialized for current mode
    if (!currentChartMode) return;
    
    // Add data based on current mode
    if (currentChartMode === 'manual') {
        // Manual mode: 2 series (Linear Heater/Temperature, Power) - NO Target Temp
        if (chartData.series.length >= 2) {
            chartData.series[0].push(valuesArray13[9] || 0);  // Linear Heater (Temperature)
            chartData.series[1].push(valuesArray13[10] || 0); // Power
            
            // Only limit points if in 'limited' mode
            if (chartDisplayMode === 'limited' && chartData.series[0].length > maxPoints) {
                for (var j = 0; j < 2; j++) chartData.series[j].shift();
            }
        }
    } else if (currentChartMode === 'pid') {
        // PID mode: Series vary by control type
        // Primary Y-axis: [0] Temperature, [1] Target Temperature
        // Secondary Y-axis: [2] Output, [3] Proportional, [4] Integral (if PI/PID), [5] Derivative (if PD/PID)
        var controlType = chartData.pidControlType || 'PID';
        var expectedSeries = 2; // Temperature + Target
        
        if (controlType === 'P') {
            expectedSeries = 4; // Temp, Target, Output, Proportional
        } else if (controlType === 'PI') {
            expectedSeries = 5; // Temp, Target, Output, Proportional, Integral
        } else if (controlType === 'PD') {
            expectedSeries = 5; // Temp, Target, Output, Proportional, Derivative
        } else if (controlType === 'PID') {
            expectedSeries = 6; // Temp, Target, Output, Proportional, Integral, Derivative
        }
        
        if (chartData.series.length >= expectedSeries) {
            // Primary Y-axis: Temperature and Target Temperature
            chartData.series[0].push(valuesArray13[9] || 0);  // Linear Heater (Temperature)
            
            // Use pidTargetTemp from the UI slider instead of hardware value
            var targetTempValue = (typeof pidTargetTemp === 'number' ? pidTargetTemp : 20);
            chartData.series[1].push(targetTempValue); // Target Temperature from UI slider
            
            // Secondary Y-axis: Output and PID terms (from JSON data)
            // valuesArray13[13] = Output (Ot)
            // valuesArray13[14] = Proportional (Pr)
            // valuesArray13[15] = Integral (It)
            // valuesArray13[16] = Derivative (Dr)
            var outputVal = valuesArray13[13] || 0;
            var prVal = valuesArray13[14] || 0;
            var itVal = valuesArray13[15] || 0;
            var drVal = valuesArray13[16] || 0;
            
            console.log('📈 Adding to PID graph:', {
                Temp: valuesArray13[9],
                Target: targetTempValue,
                Output: outputVal,
                Proportional: prVal,
                Integral: itVal,
                Derivative: drVal,
                ControlType: controlType
            });
            
            chartData.series[2].push(outputVal); // Output from hardware
            chartData.series[3].push(prVal); // Proportional term from hardware
            
            if (controlType === 'PI' || controlType === 'PID') {
                chartData.series[4].push(itVal); // Integral term from hardware
            }
            if (controlType === 'PD' || controlType === 'PID') {
                var derivIndex = controlType === 'PID' ? 5 : 4;
                chartData.series[derivIndex].push(drVal); // Derivative term from hardware
            }
            
            addToLog('📈 Graph updated: Temp=' + (valuesArray13[9] || 0).toFixed(1) + 
                    ', Ot=' + outputVal.toFixed(2) + 
                    ', Pr=' + prVal.toFixed(2) + 
                    ', It=' + itVal.toFixed(2) + 
                    ', Dr=' + drVal.toFixed(2));
            
            // Only limit points if in 'limited' mode
            if (chartDisplayMode === 'limited' && chartData.series[0].length > maxPoints) {
                for (var j = 0; j < expectedSeries; j++) chartData.series[j].shift();
            }
        }
    } else if (currentChartMode === 'onoff') {
        // On/Off mode: 4 series (Temperature, Target Temperature, Hysteresis, Power)
        // Order: [0] Temperature, [1] Target Temperature, [2] Hysteresis Low, [3] Power
        if (chartData.series.length >= 4) {
            chartData.series[0].push(valuesArray13[9] || 0);  // Linear Heater (Temperature)

            // Prefer the UI target temperature for graphing; fall back to hardware value if needed
            // Always use a valid number (default to 20°C if nothing is set)
            var targetTv = (typeof onoffTargetTemp === 'number' ? onoffTargetTemp : valuesArray13[11]);
            if (typeof targetTv !== 'number' || isNaN(targetTv)) {
                targetTv = 20; // Default target temperature
            }
            chartData.series[1].push(targetTv); // Target Temperature for graph
            
            // Calculate Hysteresis lower threshold only (below target) - ensure it's always below
            var hystVal = (typeof onoffHysteresisValue === 'number') ? onoffHysteresisValue : 3;
            var hystLow = targetTv - hystVal;
            // Ensure hysteresis is always below target (safety check)
            if (hystLow >= targetTv) {
                hystLow = targetTv - hystVal;
            }
            // Ensure hystLow is never negative or invalid
            if (typeof hystLow !== 'number' || isNaN(hystLow) || hystLow < 0) {
                hystLow = Math.max(0, targetTv - hystVal);
            }
            chartData.series[2].push(hystLow);
            
            chartData.series[3].push(valuesArray13[10] || 0); // Power
            
            // Only limit points if in 'limited' mode
            if (chartDisplayMode === 'limited' && chartData.series[0].length > maxPoints) {
                for (var j = 0; j < 4; j++) chartData.series[j].shift();
            }
        }
    }


    // CSV rows are recorded by data handlers so we can use mode-specific formats.
    if (options.skipCsv === true) {
        // Intentionally do nothing.
    }
    // Update both charts based on current mode
    try {
        if (!chartJsRef || !window.liveChartRef || !chartJsRef.data || !window.liveChartRef.data) {
            return;
        }

        var now = (options && options.timestamp instanceof Date) ? options.timestamp : new Date();
        var timeLabel = now.getHours().toString().padStart(2, '0') + ':' +
                        now.getMinutes().toString().padStart(2, '0') + ':' +
                        now.getSeconds().toString().padStart(2, '0');

        chartJsRef.data.labels.push(timeLabel);
        window.liveChartRef.data.labels.push(timeLabel);

        if (chartDisplayMode === 'limited' && chartJsRef.data.labels.length > maxPoints) {
            chartJsRef.data.labels.shift();
        }
        if (chartDisplayMode === 'limited' && window.liveChartRef.data.labels.length > maxPoints) {
            window.liveChartRef.data.labels.shift();
        }

        if (currentChartMode === 'manual') {
            if (chartJsRef.data.datasets[0]) {
                chartJsRef.data.datasets[0].data.push(valuesArray13[9] || 0);
            }
            if (window.liveChartRef.data.datasets[0]) {
                window.liveChartRef.data.datasets[0].data.push(valuesArray13[10] || 0);
            }
        } else if (currentChartMode === 'onoff') {
            var targetTv2 = (typeof onoffTargetTemp === 'number' ? onoffTargetTemp : valuesArray13[11]);
            if (typeof targetTv2 !== 'number' || isNaN(targetTv2)) {
                targetTv2 = 20;
            }
            var hystVal2 = (typeof onoffHysteresisValue === 'number') ? onoffHysteresisValue : 3;
            var hystLow2 = targetTv2 - hystVal2;
            if (typeof hystLow2 !== 'number' || isNaN(hystLow2) || hystLow2 < 0) {
                hystLow2 = Math.max(0, targetTv2 - hystVal2);
            }

            if (chartJsRef.data.datasets[0]) {
                chartJsRef.data.datasets[0].data.push(valuesArray13[9] || 0);
            }
            if (chartJsRef.data.datasets[1]) {
                chartJsRef.data.datasets[1].data.push(targetTv2);
            }
            if (chartJsRef.data.datasets[2]) {
                chartJsRef.data.datasets[2].data.push(hystLow2);
            }
            if (window.liveChartRef.data.datasets[0]) {
                window.liveChartRef.data.datasets[0].data.push(valuesArray13[10] || 0);
            }
        } else if (currentChartMode === 'pid') {
            var controlType2 = chartData.pidControlType || 'PID';
            var targetTempValue2 = (typeof pidTargetTemp === 'number' ? pidTargetTemp : 20);

            if (chartJsRef.data.datasets[0]) {
                chartJsRef.data.datasets[0].data.push(valuesArray13[9] || 0);
            }
            if (chartJsRef.data.datasets[1]) {
                chartJsRef.data.datasets[1].data.push(targetTempValue2);
            }

            if (window.liveChartRef.data.datasets[0]) {
                window.liveChartRef.data.datasets[0].data.push(valuesArray13[13] || 0);
            }
            if (window.liveChartRef.data.datasets[1]) {
                window.liveChartRef.data.datasets[1].data.push(valuesArray13[14] || 0);
            }
            if ((controlType2 === 'PI' || controlType2 === 'PID') && window.liveChartRef.data.datasets[2]) {
                window.liveChartRef.data.datasets[2].data.push(valuesArray13[15] || 0);
            }
            if ((controlType2 === 'PD' || controlType2 === 'PID')) {
                var derivativeDatasetIndex = controlType2 === 'PID' ? 3 : 2;
                if (window.liveChartRef.data.datasets[derivativeDatasetIndex]) {
                    window.liveChartRef.data.datasets[derivativeDatasetIndex].data.push(valuesArray13[16] || 0);
                }
            }
        }

        function trimDatasets(chart) {
            if (!chart || !chart.data || !chart.data.datasets) return;
            for (var ds = 0; ds < chart.data.datasets.length; ds++) {
                if (chartDisplayMode === 'limited' && chart.data.datasets[ds].data.length > maxPoints) {
                    chart.data.datasets[ds].data.shift();
                }
            }
        }

        trimDatasets(chartJsRef);
        trimDatasets(window.liveChartRef);

        autoScaleYAxis(chartJsRef);
        autoScaleYAxis(window.liveChartRef);
        chartJsRef.update('none');
        window.liveChartRef.update('none');
    } catch (e) { /* ignore */ }
}

// Chart.js handles hover events automatically


// Hook up checkbox toggles
document.addEventListener('change', function (evt) {
    var target = evt.target;
    if (target && target.matches && target.matches('#seriesToggles input[type="checkbox"]')) {
        var idx = parseInt(target.getAttribute('data-series'), 10);
        var checked = target.checked;
        if (!isNaN(idx)) {
            chartData.enabled[idx] = checked;
            redrawChart();
        }
    }
});
// Renderer process script: UI and IPC communication with main process
// Runs in the renderer (web page) and uses the secure preload API

let isConnected = false;
let packetCount = 0;
// QL heartbeat now runs in main.js to avoid renderer timer throttling.

// Get references to HTML elements
const comPortSelect = null; // Element doesn't exist in current HTML
const baudRateSelect = null; // Element doesn't exist in current HTML
const connectBtn = document.getElementById('webConnectBtn');
const disconnectBtn = null; // No disconnect button in current HTML
const refreshPortsBtn = null; // Element doesn't exist in current HTML
const webConnectBtn = document.getElementById('webConnectBtn');
const adminBtn = document.getElementById('adminBtn');
const connectionStatus = null; // Element doesn't exist in current HTML
const packetCountDisplay = null; // Element doesn't exist in current HTML
const lastUpdateDisplay = document.getElementById('lastUpdate');
const connectionInfoDisplay = null; // Element doesn't exist in current HTML
const rawDataDisplay = null; // Element doesn't exist in current HTML
const parsedDataDisplay = null; // Element doesn't exist in current HTML
const fanSpeedInput = document.getElementById('fanSpeed');
const fanSpeedDisplay = document.getElementById('fanSpeedDisplay');
const fanTooltip = document.getElementById('fanTooltip');
const heaterTempInput = document.getElementById('heaterTemp');
const heaterTempValue = document.getElementById('heaterTempValue');
const heaterTooltip = document.getElementById('heaterTooltip');
const fanOffBtn = document.getElementById('fanOff');
const fan50Btn = document.getElementById('fan50');
const fan100Btn = document.getElementById('fan100');
var simulationWindow = null; // Track simulation window reference
var curriculumWindow = null; // Track curriculum window reference
var safetyCommandsSent = false; // Track if safety commands were sent after reconnection
var wasInUnsafeState = false; // Track if system was in unsafe state when disconnected

function addToLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = '[' + timestamp + '] ' + message + '\n';
}

// Create a safe fallback for electronAPI if it doesn't exist
// This prevents crashes if the preload script didn't load properly
function ensureElectronAPI() {
    if (!window.electronAPI) {
        // Build stubs that store callbacks so setupServerBridge() can fire them later
        var _callbacks = {};
        function makeStore(name) {
            _callbacks[name] = [];
            return function (cb) { _callbacks[name].push(cb); };
        }
        window.electronAPI = {
            _callbacks: _callbacks,
            getAvailablePorts: async function () { return []; },
            connectToPort: async function () { return { success: false, error: 'Not connected to server' }; },
            disconnectFromPort: async function () { return { success: true }; },
            sendFanSpeed: async function () { return { success: false }; },
            sendPower: async function () { return { success: false }; },
            sendControlMode: async function () { return { success: false }; },
            sendHysteresis: async function () { return { success: false }; },
            sendHeaterTemp: async function () { return { success: false }; },
            sendPIDValue: async function () { return { success: false }; },
            sendPIDFrequency: async function () { return { success: false }; },
            sendCustomJson: async function () { return { success: false }; },
            onDataReceived: makeStore('data-received'),
            onJsonDataReceived: makeStore('json-data-received'),
            onDataChunk: makeStore('data-chunk'),
            onConnectionStatus: makeStore('connection-status'),
            onPortsUpdate: makeStore('ports-update'),
            onSerialTxDebug: makeStore('serial-tx-debug'),
            onUiDebugLog: makeStore('ui-debug-log'),
            removeAllListeners: function () {}
        };
        return false; // Return false to indicate API was missing
    }
    return true; // Return true to indicate API is available
}

// Server bridge: replaces electronAPI stubs with real fetch/SSE implementations
// so browsers (phone/tablet) get live hardware data via the web server.
function setupServerBridge() {
    addToLog('Connecting to server bridge...');

    function fireCallbacks(name, data) {
        var cbs = (window.electronAPI._callbacks || {})[name] || [];
        cbs.forEach(function (cb) { try { cb(null, data); } catch (e) {} });
    }

    async function webCmd(commandObj) {
        if (!isConnected) return { success: false, error: 'Hardware not connected' };
        try {
            var r = await fetch('/api/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(commandObj)
            });
            return await r.json();
        } catch (e) { return { success: false, error: e.message }; }
    }

    // Override stubs with real server-backed implementations
    window.electronAPI.getAvailablePorts = async function () {
        try { var r = await fetch('/api/ports'); return await r.json(); } catch { return []; }
    };
    window.electronAPI.connectToPort = async function (portPath, baudRate) {
        try {
            var r = await fetch('/api/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port: portPath, baudRate: baudRate || 115200 })
            });
            return await r.json();
        } catch (e) { return { success: false, error: e.message }; }
    };
    window.electronAPI.disconnectFromPort = async function () {
        try { await fetch('/api/disconnect', { method: 'POST' }); return { success: true }; }
        catch { return { success: true }; }
    };
    window.electronAPI.sendFanSpeed       = (v) => webCmd({ F: Math.max(0, Math.min(100, parseInt(v) || 0)) });
    window.electronAPI.sendPower          = (v) => webCmd({ P: Math.max(0, Math.min(100, parseInt(v) || 0)) });
    window.electronAPI.sendControlMode    = (v) => webCmd({ C: Math.max(1, Math.min(3, parseInt(v) || 1)) });
    window.electronAPI.sendHysteresis     = (v) => webCmd({ Y: parseFloat(v) });
    window.electronAPI.sendHeaterTemp     = (v) => webCmd({ T: Math.max(20, Math.min(70, parseInt(v) || 20)) });
    window.electronAPI.sendPIDValue       = (type, value) => {
        var key = type === 'P' ? 'PID_P' : type === 'I' ? 'PID_I' : 'PID_D';
        return webCmd({ [key]: parseFloat(value) });
    };
    window.electronAPI.sendPIDFrequency   = (v) => webCmd({ PID_Hz: parseFloat(v) });
    window.electronAPI.sendCustomJson     = (obj) => webCmd(obj);

    // SSE: receive hardware data and connection events from the server
    var es = new EventSource('/api/events');

    es.addEventListener('json-data', function (e) {
        try { fireCallbacks('json-data-received', JSON.parse(e.data)); } catch {}
    });

    es.addEventListener('connection-status', function (e) {
        try { fireCallbacks('connection-status', JSON.parse(e.data)); } catch {}
    });

    // Mirror control positions pushed from PC app or other web clients
    es.addEventListener('state-update', function (e) {
        try { applyRemoteStateUpdate(JSON.parse(e.data)); } catch (err) {}
    });

    es.onopen  = function () { addToLog('Server bridge connected — receiving live data.'); };
    es.onerror = function () { addToLog('Server bridge disconnected, reconnecting...'); };
}

// --- Web Serial (browser) fallback ---
let webSerialPort = null;
let webSerialReader = null;
async function tryWebSerialAutoConnect() {
    if (!('serial' in navigator)) { addToLog('Web Serial API not available in this browser.'); return; }
    try {
        // Try previously-granted ports first (no prompt). Filters help some browsers label the device
        const ports = await navigator.serial.getPorts();
        for (const p of ports) {
            const info = p.getInfo ? p.getInfo() : {};
            const vid = (info.usbVendorId || 0).toString(16).toUpperCase().padStart(4, '0');
            const pid = (info.usbProductId || 0).toString(16).toUpperCase().padStart(4, '0');
            if (vid === '12BF' && pid === '010C') {
                await openWebSerial(p);
                return;
            }
        }
        // If we reach here, no pre-authorized port exists. Browsers require a user gesture to request access.
        addToLog('Web mode: cannot auto-request serial permission without a click. Click anywhere to grant once.');
        document.body.addEventListener('click', requestWebSerialOnce, { once: true });
    } catch (e) {
        addToLog('Web Serial error: ' + e.message);
    }
}

async function requestWebSerialOnce() {
    try {
        const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x12BF, usbProductId: 0x010C }] });
        await openWebSerial(port);
    } catch (e) {
        addToLog('User denied Web Serial permission or error: ' + e.message);
    }
}

async function openWebSerial(port) {
    try {
        await port.open({ baudRate: 115200 });
        webSerialPort = port;
        updateConnectionStatus(true, 'WebSerial');
        addToLog('Web Serial connected');
        const decoder = new TextDecoder();
        const reader = port.readable.getReader();
        webSerialReader = reader;
        let buffer = new Uint8Array(0);
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) {
                // Forward raw bytes into existing packet assembler path by calling handleIncomingData with Uint8Array
                handleIncomingData(new Uint8Array(value));
            }
        }
    } catch (e) {
        addToLog('Web Serial open error: ' + e.message);
        updateConnectionStatus(false);
    }
}

async function closeWebSerial() {
    try { if (webSerialReader) { await webSerialReader.cancel(); } } catch { }
    try { if (webSerialPort) { await webSerialPort.close(); } } catch { }
    webSerialReader = null; webSerialPort = null;
}

// Safety function: Set safe values when hardware goes offline
function setSafeValuesOffline() {
    addToLog('Hardware offline - Setting safe values...');

    // Check if system was in unsafe state (heater on or high fan speed)
    var currentFanSpeed = fanSpeedInput ? parseInt(fanSpeedInput.value, 10) : 0;
    var currentHeaterTemp = heaterTempInput ? parseInt(heaterTempInput.value, 10) : 20;

    wasInUnsafeState = (currentFanSpeed > 30 || currentHeaterTemp > 30);

    if (wasInUnsafeState) {
        addToLog('System was in unsafe state - will send shutdown commands on reconnection');
    } else {
        addToLog('System was in safe state - no shutdown commands needed on reconnection');
    }

    // Reset safety commands flag for next reconnection
    safetyCommandsSent = false;

    // Set fan speed to 0
    if (fanSpeedInput) {
        fanSpeedInput.value = 0;
        if (fanSpeedDisplay) fanSpeedDisplay.value = '0';
        updateSliderFill(0);
        updateFanIcon(0);
    }

    // Set heater temperature to 20°C (safe room temperature)
    if (heaterTempInput) {
        heaterTempInput.value = 20;
        addToLog('Setting heater temp to 20°C (minimum safe temperature)');
        updateHeaterSliderFill(20);
        updateHeaterIcon(20);
        // Also update the display value
        var heaterTempValue = document.getElementById('heaterTempValue');
        if (heaterTempValue) heaterTempValue.value = '20';
        addToLog('Heater slider set to 20°C (minimum position)');
    }

    addToLog('Safe values set: Fan=0%, Heater=20°C');
}

// Safety function: Send shutdown commands when hardware reconnects (only if system was unsafe)
async function sendShutdownCommandsOnReconnect() {
    if (!isConnected || safetyCommandsSent) {
        if (safetyCommandsSent) {
            addToLog('Safety commands already sent, skipping...');
        }
        return;
    }

    // Remember the mode the user had selected before the safety reset
    var modeBeforeReconnect = currentControlMode || 'manual';

    // ALWAYS send shutdown commands when connecting to hardware
    // This ensures the system starts in a safe state every time
    addToLog('Hardware connected - Sending initialization commands to reset everything...');
    safetyCommandsSent = true; // Set flag immediately to prevent multiple calls

    try {
        // 1. Set control mode to Manual (mode = 1)
        var modeResult = await window.electronAPI.sendControlMode(1);
        if (modeResult && modeResult.success) {
            addToLog('Control mode set to Manual (1)');
        }

        // Firmware only writes the PWM/output register when the incoming value
        // differs from its last-cached value — since that cache already reads 0
        // on boot, sending 0 as the very first command is a no-op and the
        // fan/heater keeps running at whatever duty it powered up with. Pulse a
        // tiny nonzero value first to force a real register write, then drop to 0.
        await window.electronAPI.sendFanSpeed(1);
        await window.electronAPI.sendPower(1);

        // 2. Send fan stop command (0%)
        var fanResult = await window.electronAPI.sendFanSpeed(0);
        if (fanResult && fanResult.success) {
            addToLog('Fan speed set to 0%');
        }

        // 3. Send power off command (0%)
        var powerResult = await window.electronAPI.sendPower(0);
        if (powerResult && powerResult.success) {
            addToLog('Power set to 0%');
        }

        addToLog('All initialization commands sent - System is in safe state');

        // Set fan speed to 0 in UI
        var fanSpeedInput = document.getElementById('fanSpeedInput');
        var fanSpeedDisplay = document.getElementById('fanSpeedDisplay');
        if (fanSpeedInput) {
            fanSpeedInput.value = 0;
        }
        if (fanSpeedDisplay) {
            fanSpeedDisplay.value = 0;
        }

        // Update fan slider fill
        var fanFillElement = document.getElementById('fanSliderFill');
        if (fanFillElement) {
            fanFillElement.style.setProperty('--fill-percent', '0%');
            fanFillElement.style.width = '0%';
        }

        // Update fan icon and buttons
        if (typeof updateFanIcon === 'function') {
            updateFanIcon(0);
        }
        if (typeof updateFanButtons === 'function') {
            updateFanButtons(0);
        }

        // Set power to 0 in UI (Manual mode)
        var powerSlider = document.getElementById('powerSlider');
        var powerDisplay = document.getElementById('powerDisplay');
        if (powerSlider) {
            powerSlider.value = 0;
        }
        if (powerDisplay) {
            powerDisplay.value = 0;
        }

        // Update power slider fill
        var powerSliderFill = document.getElementById('powerSliderFill');
        if (powerSliderFill) {
            powerSliderFill.style.setProperty('--fill-percent', '0%');
            powerSliderFill.style.width = '0%';
        }

        addToLog('UI updated to match safe state');

        // Restore the mode the user had before reconnect, or stay in Manual if that was the mode
        if (modeBeforeReconnect !== 'manual') {
            addToLog('Restoring previous control mode: ' + modeBeforeReconnect);
            skipNextDataPoint = true;
            // window.switchControlMode is set in the init block after DOM is ready
            if (typeof window.switchControlMode === 'function') {
                await window.switchControlMode(modeBeforeReconnect);
            } else {
                // Fallback: reinit chart for the saved mode without full switch
                currentControlMode = modeBeforeReconnect;
                if (modeBeforeReconnect === 'onoff') {
                    initChartForOnOff();
                } else if (modeBeforeReconnect === 'pid') {
                    var pidSel = document.getElementById('pidControlType');
                    initChartForPID(pidSel ? pidSel.value : 'PID');
                }
            }
        } else {
            // Reinitialize chart for Manual mode after reconnect
            skipNextDataPoint = true;
            currentControlMode = 'manual';
            initChartForManual();
            addToLog('Chart reinitialized for Manual mode');
        }

    } catch (error) {
        addToLog('Error sending initialization commands: ' + error.message);
        safetyCommandsSent = false; // Reset flag if there was an error
    }
}

function updateConnectionStatus(connected, portInfo) {
    if (portInfo === undefined) {
        portInfo = '';
    }

    // Check if connection status actually changed
    var wasConnected = isConnected;
    isConnected = connected;

    // Update system status indicator
    var systemStatusIndicator = document.getElementById('systemStatusIndicator');
    if (systemStatusIndicator) {
        if (connected) {
            systemStatusIndicator.textContent = 'SYSTEM ONLINE';
            systemStatusIndicator.classList.remove('badge-error', 'offline');
            systemStatusIndicator.classList.add('badge-success', 'online');
        } else {
            systemStatusIndicator.textContent = 'SYSTEM OFFLINE';
            systemStatusIndicator.classList.remove('badge-success', 'online');
            systemStatusIndicator.classList.add('badge-error', 'offline');
        }
    }

    if (connected) {
        if (connectionStatus) {
            connectionStatus.textContent = 'Connected';
            connectionStatus.className = 'status-connected';
        }
        if (connectionInfoDisplay) connectionInfoDisplay.textContent = portInfo;
        if (connectBtn) connectBtn.disabled = true;
        if (disconnectBtn) disconnectBtn.disabled = false;

        // When hardware reconnects (was offline, now online), clear graphs and restart plotting
        if (!wasConnected && connected) {
            // Clear all graphs when device reconnects
            clearAllGraphs();
            addToLog('Device reconnected - graphs cleared, restarting data collection');
            markUserControlActivity();

            // Send safety shutdown commands only when hardware actually reconnects (not on every packet)
            setTimeout(() => {
                sendShutdownCommandsOnReconnect();
            }, 1000); // Wait 1 second before sending safety commands
        }
    } else {
        if (connectionStatus) {
            connectionStatus.textContent = 'Disconnected';
            connectionStatus.className = 'status-disconnected';
        }
        if (connectionInfoDisplay) connectionInfoDisplay.textContent = 'No device connected';
        if (connectBtn) connectBtn.disabled = true;
        if (disconnectBtn) disconnectBtn.disabled = true;

        // Set safe values only when hardware actually goes offline (not on every disconnection check)
        if (wasConnected && !connected) {
            setSafeValuesOffline();
            markUserControlActivity();
        }
    }
}

async function refreshComPorts() {
    try {
        addToLog('Refreshing available COM ports...');
        const ports = await window.electronAPI.getAvailablePorts();
        if (comPortSelect) {
            comPortSelect.innerHTML = '<option value="">Select COM Port...</option>';
            for (var i = 0; i < ports.length; i++) {
                var port = ports[i];
                var option = document.createElement('option');
                option.value = port.path;
                var manufacturer = port.manufacturer || 'Unknown Device';
                var serialNumber = port.serialNumber || 'Unknown';
                option.textContent = port.path + ' - ' + manufacturer + ' (SN: ' + serialNumber + ')';
                comPortSelect.appendChild(option);
            }
        }
        addToLog('Found ' + ports.length + ' available ports:');
        for (var j = 0; j < ports.length; j++) {
            var p = ports[j];
            addToLog('  - ' + p.path + ': ' + (p.manufacturer || 'Unknown') + ' (SN: ' + (p.serialNumber || 'Unknown') + ')');
        }
        if (ports.length === 0) {
            addToLog('No COM ports found. Try:');
            addToLog('  1. Check if device is connected');
            addToLog('  2. Install device drivers');
            addToLog('  3. Check Device Manager for COM port number');
            addToLog('  4. Try a different USB cable/port');
        }
    } catch (error) {
        addToLog('Error refreshing ports: ' + error.message);
        addToLog('This might be a permissions issue. Try running as administrator.');
    }
}

function handlePortsUpdateFromMain(event, ports) {
    if (comPortSelect) {
        var previousSelection = comPortSelect.value;
        comPortSelect.innerHTML = '<option value=\"\">Select COM Port...</option>';
        for (var i = 0; i < ports.length; i++) {
            var port = ports[i];
            var option = document.createElement('option');
            option.value = port.path;
            var manufacturer = port.manufacturer || 'Unknown Device';
            var serialNumber = port.serialNumber || 'Unknown';
            option.textContent = port.path + ' - ' + manufacturer + ' (SN: ' + serialNumber + ')';
            comPortSelect.appendChild(option);
        }
        if (previousSelection && ports.some(function (p) { return p.path === previousSelection; })) {
            comPortSelect.value = previousSelection;
            return;
        }
    }

    // Update popout plot if visible
    try {
        var overlayEl = document.getElementById('graphOverlay');
        if (overlayEl && overlayEl.className !== 'overlay-hidden') {
            redrawChart(); // This will update both main and popout plots
        }
    } catch (e) { }
}

// Chart.js handles all chart functionality

async function connectToPort() {
    var selectedPort = comPortSelect.value;
    var selectedBaudRate = 115200;
    if (baudRateSelect && typeof baudRateSelect.value === 'string' && baudRateSelect.value.trim() !== '') {
        var parsed = parseInt(baudRateSelect.value, 10);
        if (!isNaN(parsed)) {
            selectedBaudRate = parsed;
        }
    }
    if (!selectedPort) {
        addToLog('Please select a COM port first');
        return;
    }
    try {
        addToLog('Attempting to connect to ' + selectedPort + ' at ' + selectedBaudRate + ' baud...');
        var result = await window.electronAPI.connectToPort(selectedPort, selectedBaudRate);
        if (result.success) {
            addToLog('Successfully connected to ' + selectedPort);
            updateConnectionStatus(true, selectedPort + ' @ ' + selectedBaudRate + ' baud');
        } else {
            addToLog('Failed to connect: ' + result.error);
            updateConnectionStatus(false);
        }
    } catch (error) {
        addToLog('Connection error: ' + error.message);
        updateConnectionStatus(false);
    }
}

async function disconnectFromPort() {
    try {
        addToLog('Disconnecting from port...');
        var result = await window.electronAPI.disconnectFromPort();
        if (result.success) {
            addToLog('Disconnected successfully');
        } else {
            addToLog('Error disconnecting: ' + result.error);
        }
        updateConnectionStatus(false);
    } catch (error) {
        addToLog('Disconnect error: ' + error.message);
        updateConnectionStatus(false);
    }
}

function handleIncomingData(data) {
    var dataArray = (function (d) {
        // Convert incoming data to a plain array of bytes in a safe, simple way
        try {
            if (Array.isArray(d)) {
                return d.slice();
            }
            if (d instanceof Uint8Array) {
                return Array.from(d);
            }
            if (d && typeof d.length === 'number') {
                return Array.from(d);
            }
            // Last attempt: try to wrap in Uint8Array
            return Array.from(new Uint8Array(d));
        } catch (e) {
            addToLog('Unable to parse incoming data: ' + (e && e.message ? e.message : String(e)));
            return [];
        }
    })(data);
    if (dataArray.length > 0) {
        var hexString = dataArray.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
        addToLog('DEBUG: All incoming data (length: ' + dataArray.length + '): ' + hexString);

        // Check if this looks like a 4-byte packet
        if (dataArray.length === 4) {
            addToLog('DEBUG: This is a 4-byte packet!');
            addToLog('DEBUG: First byte: 0x' + dataArray[0].toString(16).padStart(2, '0'));
            addToLog('DEBUG: Second byte: 0x' + dataArray[1].toString(16).padStart(2, '0'));
            addToLog('DEBUG: Third byte: 0x' + dataArray[2].toString(16).padStart(2, '0'));
            addToLog('DEBUG: Fourth byte: 0x' + dataArray[3].toString(16).padStart(2, '0'));

            if (dataArray[0] === 0x11 && dataArray[1] === 0x11 && dataArray[2] === 0x11) {
                addToLog('DEBUG: This matches the 11 11 11 pattern (fan speed)!');
            } else if (dataArray[0] === 0x22 && dataArray[1] === 0x22 && dataArray[2] === 0x22) {
                addToLog('DEBUG: This matches the 22 22 22 pattern (heater mode)!');
            } else if (dataArray[0] === 0x33 && dataArray[1] === 0x33 && dataArray[2] === 0x33) {
                addToLog('DEBUG: This matches the 33 33 33 pattern (heater temperature)!');
            } else {
                addToLog('DEBUG: This does NOT match any known 4-byte pattern');
                addToLog('DEBUG: Looking for: 0x11 0x11 0x11 (fan) or 0x22 0x22 0x22 (heater mode) or 0x33 0x33 0x33 (heater temp)');
            }
        } else {
            addToLog('DEBUG: Not a 4-byte packet, length is: ' + dataArray.length);
        }
    }

    // Check for fan speed data - format: [0x11, 0x11, 0x11, data] (exactly 4 bytes)
    if (dataArray.length === 4 && dataArray[0] === 0x11 && dataArray[1] === 0x11 && dataArray[2] === 0x11) {
        var fanSpeed = dataArray[3]; // Fan speed value (0-100)

        // Debug: Print the received data
        var hexString = dataArray.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
        addToLog('DEBUG: Received 4-byte fan speed data: ' + hexString);
        addToLog('DEBUG: Fan speed value: ' + fanSpeed);

        // Validate fan speed range
        if (fanSpeed >= 0 && fanSpeed <= 100) {
            updateFanSliderFromHardware(fanSpeed);
            addToLog('Fan speed received from hardware: ' + fanSpeed + '%');
        } else {
            addToLog('Invalid fan speed value: ' + fanSpeed);
        }
        return; // Exit early since this is a 4-byte packet
    }

    // Check for heater temperature data - format: [0x33, 0x33, 0x33, temp] (exactly 4 bytes)
    if (dataArray.length === 4 && dataArray[0] === 0x33 && dataArray[1] === 0x33 && dataArray[2] === 0x33) {
        var heaterTemp = dataArray[3]; // Heater temperature value (20-70°C)

        // Debug: Print the received data
        var hexString = dataArray.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
        addToLog('DEBUG: Received 4-byte heater temperature data: ' + hexString);
        addToLog('DEBUG: Heater temperature value: ' + heaterTemp);
        addToLog('DEBUG: About to call updateHeaterSliderFromHardware with temp: ' + heaterTemp);

        // Validate heater temperature range (20-70°C)
        if (heaterTemp >= 20 && heaterTemp <= 70) {
            addToLog('DEBUG: Heater temperature is valid, calling updateHeaterSliderFromHardware...');
            updateHeaterSliderFromHardware(heaterTemp);
            addToLog('Heater temperature received from hardware: ' + heaterTemp + '°C');
        } else {
            addToLog('Invalid heater temperature value: ' + heaterTemp + ' (expected 20-70)');
        }
        return; // Exit early since this is a 4-byte packet
    }

    if (dataArray.length >= 56) {
        if (dataArray[0] === 0x55 && dataArray[1] === 0x55) {
            if (dataArray[54] === 0xAA && dataArray[55] === 0xAA) {
                // We are receiving valid frames; ensure UI shows ONLINE
                try { updateConnectionStatus(true); } catch (e) { }
                packetCount += 1;
                if (packetCountDisplay) packetCountDisplay.textContent = String(packetCount);
                if (lastUpdateDisplay) lastUpdateDisplay.textContent = new Date().toLocaleTimeString();
                displayRawData(dataArray);
                addRawData(dataArray);
                parseAndDisplayData(dataArray);
                addToLog('Valid packet received (' + packetCount + ')');
            } else {
                addToLog('Invalid packet: Wrong footer bytes');
            }
        } else {
            addToLog('Invalid packet: Wrong header bytes');
        }
    } else {
        addToLog('Incomplete data received: ' + dataArray.length + ' bytes (expected 56)');
    }
}

// Function to update fan button states
function updateFanButtons(currentSpeed) {
    // Remove active class from all fan buttons
    if (fanOffBtn) {
        fanOffBtn.classList.remove('active');
    }
    if (fan50Btn) {
        fan50Btn.classList.remove('active');
    }
    if (fan100Btn) {
        fan100Btn.classList.remove('active');
    }

    // Add active class to the button matching current speed
    if (currentSpeed === 0 && fanOffBtn) {
        fanOffBtn.classList.add('active');
    } else if (currentSpeed === 50 && fan50Btn) {
        fan50Btn.classList.add('active');
    } else if (currentSpeed === 100 && fan100Btn) {
        fan100Btn.classList.add('active');
    }
}

// Function to update fan slider when receiving data from hardware
function updateFanSliderFromHardware(fanSpeed) {
    // Ensure fan speed is within valid range (0-100)
    fanSpeed = Math.max(0, Math.min(100, fanSpeed));

    // Only update UI if the value has actually changed
    if (fanSpeed === lastKnownFanSpeed) {
        return; // No change, skip update
    }
    
    lastKnownFanSpeed = fanSpeed;

    addToLog('DEBUG: Updating fan slider to: ' + fanSpeed + '%');
    addToLog('DEBUG: fanSpeedInput element found: ' + (fanSpeedInput ? 'YES' : 'NO'));
    addToLog('DEBUG: fanSpeedDisplay element found: ' + (fanSpeedDisplay ? 'YES' : 'NO'));

    // Update the fan speed input slider
    if (fanSpeedInput) {
        fanSpeedInput.value = fanSpeed;
        addToLog('DEBUG: Set fanSpeedInput.value to: ' + fanSpeedInput.value);

        // Update the display text (only if user is not typing in it)
        if (fanSpeedDisplay && document.activeElement !== fanSpeedDisplay) {
            fanSpeedDisplay.value = fanSpeed;
            addToLog('DEBUG: Set fanSpeedDisplay.value to: ' + fanSpeedDisplay.value);
        }

        // Update the visual slider fill
        updateSliderFill(fanSpeed);
        addToLog('DEBUG: Called updateSliderFill with: ' + fanSpeed);

        // Update the fan icon animation
        updateFanIcon(fanSpeed);
        addToLog('DEBUG: Called updateFanIcon with: ' + fanSpeed);

        // Update button states
        updateFanButtons(fanSpeed);

        addToLog('Fan slider updated from hardware: ' + fanSpeed + '%');
    } else {
        addToLog('ERROR: fanSpeedInput element not found!');
    }
}

// Function to update heater slider when receiving data from hardware
function updateHeaterSliderFromHardware(temperature) {
    // Ensure heater temperature is within valid range (20-70°C)
    temperature = Math.max(20, Math.min(70, temperature));

    addToLog('DEBUG: Updating heater slider to: ' + temperature + '°C');
    addToLog('DEBUG: heaterTempInput element found: ' + (heaterTempInput ? 'YES' : 'NO'));
    addToLog('DEBUG: heaterTempValue element found: ' + (heaterTempValue ? 'YES' : 'NO'));

    // Update the heater temperature input slider
    if (heaterTempInput) {
        heaterTempInput.value = temperature;
        addToLog('DEBUG: Set heaterTempInput.value to: ' + heaterTempInput.value);

        // Update the display text
        if (heaterTempValue) {
            heaterTempValue.value = temperature;
            addToLog('DEBUG: Set heaterTempValue.value to: ' + heaterTempValue.value);
        }

        // Update the visual slider fill
        updateHeaterSliderFill(temperature);
        addToLog('DEBUG: Called updateHeaterSliderFill with: ' + temperature);

        // Update the heater icon position
        updateHeaterIcon(temperature);
        addToLog('DEBUG: Called updateHeaterIcon with: ' + temperature);

        addToLog('Heater slider updated from hardware: ' + temperature + '°C');
    } else {
        addToLog('ERROR: heaterTempInput element not found!');
    }
}

function addRawData(data) {
    if (!data || data.length === 0) return;

    const hexString = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
    if (rawDataDisplay) {
        rawDataDisplay.textContent = hexString;
    }
}

function displayRawData(dataArray) {
    var hexString = '';
    for (var i = 0; i < dataArray.length; i += 16) {
        var row = '';
        var ascii = '';
        for (var j = 0; j < 16 && i + j < dataArray.length; j++) {
            var byte = dataArray[i + j];
            row += byte.toString(16).toUpperCase().padStart(2, '0') + ' ';
            ascii += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.';
        }
        hexString += i.toString(16).toUpperCase().padStart(4, '0') + ': ' + row.padEnd(48) + ' ' + ascii + '\n';
    }
    if (rawDataDisplay) rawDataDisplay.textContent = hexString;
}

// Helper function to convert RGB to hex color
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (x) {
        var hex = Math.round(x).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}

// Function to get color for temperature: Blue at 1.0°C, Red at 75°C
function getTemperatureColor(temp) {
    // Clamp temperature between 1.0 and 75.0
    var clampedTemp = Math.max(1.0, Math.min(75.0, temp));
    // Calculate ratio from 0 (1.0°C) to 1 (75°C)
    var ratio = (clampedTemp - 1.0) / (75.0 - 1.0);
    // Blue: RGB(0, 0, 255), Red: RGB(255, 0, 0)
    var red = Math.round(ratio * 255);
    var green = 0;
    var blue = Math.round((1.0 - ratio) * 255);
    return rgbToHex(red, green, blue);
}

// Function to get color for power: Green at 0W, Red at 36W
function getPowerColor(power) {
    // Clamp power between 0 and 36
    var clampedPower = Math.max(0, Math.min(36, power));
    // Calculate ratio from 0 (0W) to 1 (36W)
    var ratio = clampedPower / 36.0;
    // Green: RGB(0, 255, 0), Red: RGB(255, 0, 0)
    var red = Math.round(ratio * 255);
    var green = Math.round((1.0 - ratio) * 255);
    var blue = 0;
    return rgbToHex(red, green, blue);
}

// Function to get color for wind speed: Green at 0 m/s, Red at 2.1 m/s
// Function to validate temperature: if > 200 or < -10, return 0.00
function validateTemperature(temp) {
    if (temp > 200 || temp < -10) {
        return 0.00;
    }
    return temp;
}

function parseAndDisplayData(dataArray) {
    var parsedInfo = '';
    var actualData = dataArray.slice(2, 54);
    parsedInfo += 'Packet Structure:\n';
    parsedInfo += 'Header: 0x' + dataArray[0].toString(16).padStart(2, '0') + ' 0x' + dataArray[1].toString(16).padStart(2, '0') + '\n';
    parsedInfo += 'Data Length: ' + actualData.length + ' bytes\n';
    parsedInfo += 'Footer: 0x' + dataArray[54].toString(16).padStart(2, '0') + ' 0x' + dataArray[55].toString(16).padStart(2, '0') + '\n\n';
    parsedInfo += 'Data Interpretation:\n';
    // Bytes 2..33 (32 bytes) are eight 4-byte float temperatures (little-endian)
    if (actualData.length >= 32) {
        for (var sensorIndex = 0; sensorIndex < 8; sensorIndex++) {
            var base = sensorIndex * 4;
            var b0 = actualData[base + 0];
            var b1 = actualData[base + 1];
            var b2 = actualData[base + 2];
            var b3 = actualData[base + 3];
            var buf = new ArrayBuffer(4);
            var dv = new DataView(buf);
            dv.setUint8(0, b0);
            dv.setUint8(1, b1);
            dv.setUint8(2, b2);
            dv.setUint8(3, b3);
            var temp = dv.getFloat32(0, true); // little-endian
            // Validate temperature: if > 200 or < -10, set to 0.00
            var validatedTemp = validateTemperature(temp);
            // T1-T8 tiles removed - no longer updating tiles
            parsedInfo += 'Sensor ' + (sensorIndex + 1) + ': ' + validatedTemp.toFixed(2) + '\u00B0C\n';
        }


        // Bytes 34..37 (actualData[32..35]): time as float32 (little-endian)
        if (actualData.length >= 36) {
            var t0 = actualData[32], t1 = actualData[33], t2 = actualData[34], t3 = actualData[35];
            var tbuf = new ArrayBuffer(4);
            var tdv = new DataView(tbuf);
            tdv.setUint8(0, t0);
            tdv.setUint8(1, t1);
            tdv.setUint8(2, t2);
            tdv.setUint8(3, t3);
            // Build array for chart: T1-T8 and Radial Heater removed, only keeping Linear Heater, Power, Target
            var tempsForChart = [];
            // T1-T8 removed - fill with NaN to maintain array structure (indices 0-7)
            for (var s2 = 0; s2 < 8; s2++) {
                tempsForChart.push(NaN);
            }
            // Radial Heater removed - fill with NaN (index 8)
            tempsForChart.push(NaN);
            // Linear Heater if available (bytes 40-43, index 9)
            if (actualData.length >= 44) {
                var hb4 = actualData[40], hb5 = actualData[41], hb6 = actualData[42], hb7 = actualData[43];
                var hbuf2 = new ArrayBuffer(4);
                var hdv2 = new DataView(hbuf2);
                hdv2.setUint8(0, hb4); hdv2.setUint8(1, hb5); hdv2.setUint8(2, hb6); hdv2.setUint8(3, hb7);
                var rawHeaterRight = hdv2.getFloat32(0, true);
                // Validate heater temperature before adding to chart
                tempsForChart.push(validateTemperature(rawHeaterRight));
            } else {
                tempsForChart.push(NaN);
            }
            // Power if available
            if (actualData.length >= 48) {
                var pp0 = actualData[44], pp1 = actualData[45], pp2 = actualData[46], pp3 = actualData[47];
                var pbuf2 = new ArrayBuffer(4);
                var pdv2 = new DataView(pbuf2);
                pdv2.setUint8(0, pp0); pdv2.setUint8(1, pp1); pdv2.setUint8(2, pp2); pdv2.setUint8(3, pp3);
                tempsForChart.push(pdv2.getFloat32(0, true)); // series index 10
            } else {
                tempsForChart.push(NaN);
            }
            // Target temp from slider (use current UI value if available)
            var targetTempFromUI = heaterTempInput ? parseInt(heaterTempInput.value, 10) : NaN;
            tempsForChart.push(isNaN(targetTempFromUI) ? NaN : targetTempFromUI); // series index 11
            if (typeof addPoint === 'function') {
                addPoint(tempsForChart);
            }
        }

        // Bytes 38..45 (actualData[36..43]): two more temperature sensors as float32
        // Note: This section is redundant - heaters are already handled above, but keeping for compatibility
        if (actualData.length >= 44) {
            for (var extraIndex = 0; extraIndex < 2; extraIndex++) {
                var ebase = 36 + extraIndex * 4;
                var eb0 = actualData[ebase + 0];
                var eb1 = actualData[ebase + 1];
                var eb2 = actualData[ebase + 2];
                var eb3 = actualData[ebase + 3];
                var ebuf = new ArrayBuffer(4);
                var edv = new DataView(ebuf);
                edv.setUint8(0, eb0);
                edv.setUint8(1, eb1);
                edv.setUint8(2, eb2);
                edv.setUint8(3, eb3);
                var rawEtemp = edv.getFloat32(0, true);
                // Validate temperature: if > 200 or < -10, set to 0.00
                var etemp = validateTemperature(rawEtemp);
                parsedInfo += 'Sensor ' + (9 + extraIndex) + ': ' + etemp.toFixed(2) + '\u00B0C\n';
                // Heater elements are now handled in the main parsing section

            }
        }

        // Bytes 46..49 (actualData[44..47]): Power as float32 (1 decimal place)
        if (actualData.length >= 48) {
            var p0 = actualData[44], p1 = actualData[45], p2 = actualData[46], p3 = actualData[47];
            var pbuf = new ArrayBuffer(4);
            var pdv = new DataView(pbuf);
            pdv.setUint8(0, p0); pdv.setUint8(1, p1); pdv.setUint8(2, p2); pdv.setUint8(3, p3);
            var power = pdv.getFloat32(0, true);
            parsedInfo += 'Power: ' + power.toFixed(1) + ' W\n';
        }
    } else if (actualData.length >= 4) {
        // At least one sensor available
        var tb0 = actualData[0], tb1 = actualData[1], tb2 = actualData[2], tb3 = actualData[3];
        var bf = new ArrayBuffer(4);
        var dvf = new DataView(bf);
        dvf.setUint8(0, tb0);
        dvf.setUint8(1, tb1);
        dvf.setUint8(2, tb2);
        dvf.setUint8(3, tb3);
        var t = dvf.getFloat32(0, true);
        parsedInfo += 'Sensor 1: ' + t.toFixed(2) + '\u00B0C\n';
    }
    parsedInfo += '\nFirst 20 data bytes: ';
    for (var i = 0; i < Math.min(20, actualData.length); i++) {
        parsedInfo += '0x' + actualData[i].toString(16).padStart(2, '0') + ' ';
    }
    if (parsedDataDisplay) parsedDataDisplay.textContent = parsedInfo;
}

function clearLog() {
    packetCount = 0;
    if (packetCountDisplay) packetCountDisplay.textContent = '0';
    if (lastUpdateDisplay) lastUpdateDisplay.textContent = 'Never';
    if (rawDataDisplay) rawDataDisplay.textContent = 'No data received yet';
    if (parsedDataDisplay) parsedDataDisplay.textContent = 'Data will be parsed and displayed here';
}



function csvFilenameTimestamp() {
    var now = new Date();
    var year = now.getFullYear();
    var month = String(now.getMonth() + 1).padStart(2, '0');
    var day = String(now.getDate()).padStart(2, '0');
    var hours = String(now.getHours()).padStart(2, '0');
    var minutes = String(now.getMinutes()).padStart(2, '0');
    var seconds = String(now.getSeconds()).padStart(2, '0');
    return year + '-' + month + '-' + day + ' ' + hours + '-' + minutes + '-' + seconds;
}

function startCsvSaving() {
    // Ask user for save location
    if (window.electronAPI && window.electronAPI.showSaveDialog) {
        window.electronAPI.showSaveDialog({
            title: 'Save Process Control Temperature Data',
            defaultPath: 'Process Control Temperature ' + csvFilenameTimestamp() + '.csv',
            filters: [
                { name: 'CSV Files', extensions: ['csv'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        }).then(function (result) {
            if (!result.canceled && result.filePath) {
                // Create CSV file immediately so user can see it on disk at start.
                csvSessionMode = currentControlMode;
                if (csvSessionMode === 'pid') {
                    csvSessionPidControlType = getPidControlTypeFromUI();
                } else {
                    csvSessionPidControlType = null;
                }
                var csvHeader = getCsvHeaderLineForMode(csvSessionMode);
                window.electronAPI.writeFile(result.filePath, csvHeader).then(function (writeResult) {
                    if (writeResult && writeResult.success) {
                        // Start saving only after file is successfully created.
                        isSavingCsv = true;
                        csvData = []; // Clear previous data
                        csvSavePath = result.filePath; // Store the selected path
                        startCsvBtn.style.display = 'none'; // Hide start button
                        stopCsvBtn.style.display = 'inline-block'; // Show stop button
                        addToLog('CSV file created and saving started (' + csvSessionMode.toUpperCase() + '): ' + result.filePath);
                    } else {
                        var createError = (writeResult && writeResult.error) ? writeResult.error : 'Unknown error creating CSV file';
                        addToLog('Could not create CSV file: ' + createError);
                    }
                }).catch(function (writeError) {
                    addToLog('Could not create CSV file: ' + writeError.message);
                });
            } else {
                addToLog('Save cancelled by user');
            }
        }).catch(function (error) {
            addToLog('Error opening save dialog: ' + error.message);
        });
    } else {
        // Fallback for web version - use default download
        isSavingCsv = true;
        csvData = []; // Clear previous data
        csvSavePath = null; // No specific path for web version
        startCsvBtn.style.display = 'none'; // Hide start button
        stopCsvBtn.style.display = 'inline-block'; // Show stop button
        addToLog('CSV saving started - will download when stopped');
    }
}

function stopCsvSaving() {
    // Stop saving and export
    isSavingCsv = false;
    startCsvBtn.style.display = 'inline-block'; // Show start button
    stopCsvBtn.style.display = 'none'; // Hide stop button

    if (csvSavePath) {
        // Rows were already appended to disk as they arrived - nothing left to write.
        addToLog('CSV file saved to: ' + csvSavePath);
        csvSavePath = null;
        csvSessionMode = null;
        csvSessionPidControlType = null;
        return;
    }

    if (csvData.length === 0) {
        addToLog('No data collected during saving session');
        csvSessionMode = null;
        csvSessionPidControlType = null;
        return;
    }

    // Web fallback (no Electron API): create CSV content from collected rows and download.
    var csvContent = getCsvHeaderLineForMode(csvSessionMode);
    for (var i = 0; i < csvData.length; i++) {
        csvContent += csvData[i] + '\n';
    }
    downloadCsvFile(csvContent);
    csvSessionMode = null;
    csvSessionPidControlType = null;
}

function downloadCsvFile(csvContent) {
    var filename = 'Process Control Temperature ' + csvFilenameTimestamp() + '.csv';

    // Create and download the file
    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');

    if (link.download !== undefined) {
        var url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        addToLog('CSV file downloaded: ' + filename + ' (' + csvData.length + ' points collected)');
    } else {
        addToLog('CSV download not supported in this browser');
    }
}

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

function applyTheme(themeKey) {
    var resolved = themeKey === 'light' ? 'light' : 'dark';
    var body = document.body;
    body.classList.remove('theme-light', 'theme-dark');
    body.classList.add('theme-' + resolved);
    document.documentElement.setAttribute('data-theme', resolved);
    updateChartTheme();
    updateLogoForTheme();
}

function updateLogoForTheme() {
    var img = document.getElementById('matrixLogo');
    if (!img) return;
    var theme = document.documentElement.getAttribute('data-theme');
    img.src = theme === 'light'
        ? 'assets/Matrix 2024 Balck.png'
        : 'assets/Matrix 2024 White.png';
}

function applyLayout(layoutKey) {
    var body = document.body;
    body.classList.remove('layout-compact');
    body.classList.remove('layout-stacked');
    body.classList.add('layout-standard');
}

function updateChartTheme() {
    var colors = getChartThemeColors();
    if (chartJsRef) {
        try {
            if (chartJsRef.data && chartJsRef.data.datasets && chartJsRef.data.datasets.length > 10) {
                // Power line is always pure red for visibility
                chartJsRef.data.datasets[10].borderColor = '#ff0000';
                chartJsRef.data.datasets[10].backgroundColor = '#ff0000';
            }
            chartJsRef.options.scales.x.grid.display = false; // Remove vertical grid lines
            chartJsRef.options.scales.x.ticks.color = colors.text;
            if (chartJsRef.options.scales.x.ticks.font) {
                chartJsRef.options.scales.x.ticks.font.size = 14;
                chartJsRef.options.scales.x.ticks.font.family = 'Inter, sans-serif';
            }
            chartJsRef.options.scales.y.grid.color = 'rgba(148, 163, 184, 0.1)'; // Improved grid visibility
            chartJsRef.options.scales.y.ticks.color = colors.text;
            if (chartJsRef.options.scales.y.ticks.font) {
                chartJsRef.options.scales.y.ticks.font.size = 14;
                chartJsRef.options.scales.y.ticks.font.family = 'Inter, sans-serif';
            }
            chartJsRef.options.scales.y.title.color = colors.text;
            if (chartJsRef.options.scales.y.title.font) {
                chartJsRef.options.scales.y.title.font.size = 16;
                chartJsRef.options.scales.y.title.font.weight = 'bold';
                chartJsRef.options.scales.y.title.font.family = 'Inter, sans-serif';
            }
            if (chartJsRef.options.plugins && chartJsRef.options.plugins.legend && chartJsRef.options.plugins.legend.labels) {
                chartJsRef.options.plugins.legend.labels.color = colors.text;
                if (chartJsRef.options.plugins.legend.labels.font) {
                    chartJsRef.options.plugins.legend.labels.font.size = 14;
                    chartJsRef.options.plugins.legend.labels.font.family = 'Inter, sans-serif';
                }
            }
            chartJsRef.update('none');
        } catch (e) { /* ignore */ }
    }
    if (window.liveChartRef) {
        try {
            var liveChart = window.liveChartRef;
            if (liveChart.data && liveChart.data.datasets && liveChart.data.datasets.length > 10) {
                // Power line is always pure red for visibility
                liveChart.data.datasets[10].borderColor = '#ff0000';
                liveChart.data.datasets[10].backgroundColor = '#ff0000';
            }
            liveChart.options.scales.x.grid.display = false; // Remove vertical grid lines
            liveChart.options.scales.x.ticks.color = colors.text;
            if (liveChart.options.scales.x.ticks.font) {
                liveChart.options.scales.x.ticks.font.size = 14;
                liveChart.options.scales.x.ticks.font.family = 'Inter, sans-serif';
            }
            liveChart.options.scales.y.grid.color = 'rgba(148, 163, 184, 0.1)'; // Improved grid visibility
            liveChart.options.scales.y.ticks.color = colors.text;
            if (liveChart.options.scales.y.ticks.font) {
                liveChart.options.scales.y.ticks.font.size = 14;
                liveChart.options.scales.y.ticks.font.family = 'Inter, sans-serif';
            }
            liveChart.options.scales.y.title.color = colors.text;
            if (liveChart.options.scales.y.title.font) {
                liveChart.options.scales.y.title.font.size = 16;
                liveChart.options.scales.y.title.font.weight = 'bold';
                liveChart.options.scales.y.title.font.family = 'Inter, sans-serif';
            }
            if (liveChart.options.plugins && liveChart.options.plugins.legend && liveChart.options.plugins.legend.labels) {
                liveChart.options.plugins.legend.labels.color = colors.text;
                if (liveChart.options.plugins.legend.labels.font) {
                    liveChart.options.plugins.legend.labels.font.size = 14;
                    liveChart.options.plugins.legend.labels.font.family = 'Inter, sans-serif';
                }
            }
            liveChart.update('none');
        } catch (e) { /* ignore */ }
    }
}

// Function to handle JSON data received from hardware
// This function processes temperature and power data sent as JSON from the hardware
function handleJsonData(jsonData) {
    try {
        // Log raw JSON data for debugging
        console.log('📥 Renderer received JSON:', JSON.stringify(jsonData));
        addToLog('📥 JSON: ' + JSON.stringify(jsonData));
        
        // Ensure a chart is initialized before we try to add points.
        // IMPORTANT: Respect the currentControlMode that the user selected,
        // instead of always forcing Manual. This prevents the graph from
        // jumping back to Manual right after switching to On/Off or PID.
        if (!currentChartMode) {
            try {
                if (currentControlMode === 'onoff') {
                    initChartForOnOff();
                } else if (currentControlMode === 'pid') {
                    // Use current PID control type if available, otherwise default to 'PID'
                    var pidControlTypeSelect = document.getElementById('pidControlType');
                    var controlType = pidControlTypeSelect ? pidControlTypeSelect.value : 'PID';
                    initChartForPID(controlType);
                } else {
                    // Fallback: Manual mode (only if not in On/Off mode)
                    if (currentControlMode !== 'onoff') {
                        currentControlMode = 'manual';
                        initChartForManual();
                    } else {
                        initChartForOnOff();
                    }
                }
            } catch (chartInitErr) {
                addToLog('Chart init error: ' + (chartInitErr.message || chartInitErr));
            }
        }
        
        // Check if the JSON is valid
        if (!jsonData || typeof jsonData !== 'object') {
            addToLog('⚠️ Invalid JSON data received');
            return;
        }
        
        // ============================================================================
        // HANDLE TWO TYPES OF JSON MESSAGES FROM HARDWARE:
        // 1. Main data: {"T": 25.5, "P": 45.2, "F": 50}
        // 2. PID data:  {"Pr": 5.67, "It": 2.89, "Dr": 1.23, "Ot": 12.34}
        // ============================================================================
        
        // Check if this is a PID values message (has Pr, It, Dr, or Ot)
        var isPidMessage = (typeof jsonData.Pr !== 'undefined' || 
                           typeof jsonData.It !== 'undefined' || 
                           typeof jsonData.Dr !== 'undefined' || 
                           typeof jsonData.Ot !== 'undefined');
        
        if (isPidMessage) {
            // This is the second JSON message with PID values
            // Store them in global storage for use when main data arrives
            console.log('🎯 PID Message detected!');
            addToLog('🎯 PID Message Type Detected');
            
            if (typeof jsonData.Pr === 'number' && !isNaN(jsonData.Pr)) {
                lastPidValues.proportional = jsonData.Pr;
                console.log('  Proportional (Pr):', jsonData.Pr);
            }
            if (typeof jsonData.It === 'number' && !isNaN(jsonData.It)) {
                lastPidValues.integral = jsonData.It;
                console.log('  Integral (It):', jsonData.It);
            }
            if (typeof jsonData.Dr === 'number' && !isNaN(jsonData.Dr)) {
                lastPidValues.derivative = jsonData.Dr;
                console.log('  Derivative (Dr):', jsonData.Dr);
            }
            if (typeof jsonData.Ot === 'number' && !isNaN(jsonData.Ot)) {
                lastPidValues.output = jsonData.Ot;
                console.log('  Output (Ot):', jsonData.Ot);
            }
            
            // Log the PID values received
            addToLog('✅ PID Values Stored - Pr: ' + lastPidValues.proportional.toFixed(2) + 
                    ', It: ' + lastPidValues.integral.toFixed(2) + 
                    ', Dr: ' + lastPidValues.derivative.toFixed(2) + 
                    ', Ot: ' + lastPidValues.output.toFixed(2));
            
            // PID message processed - exit function
            return;
        }
        
        // ============================================================================
        // HANDLE INTERMEDIATE T-ONLY PACKET: {"T": val} — no P, F, or PID fields
        // Buffer these; they will be flushed equally-distributed when the next main
        // packet arrives.
        // ============================================================================
        var hasT = typeof jsonData.T !== 'undefined';
        var hasP = typeof jsonData.P !== 'undefined';
        var hasF = typeof jsonData.F !== 'undefined';
        if (hasT && !hasP && !hasF) {
            var tVal = parseFloat(jsonData.T);
            if (!isNaN(tVal)) {
                var iPr = (typeof jsonData.Pr === 'number' && !isNaN(jsonData.Pr)) ? jsonData.Pr : null;
                var iIt = (typeof jsonData.It === 'number' && !isNaN(jsonData.It)) ? jsonData.It : null;
                var iDr = (typeof jsonData.Dr === 'number' && !isNaN(jsonData.Dr)) ? jsonData.Dr : null;
                var iOt = (typeof jsonData.Ot === 'number' && !isNaN(jsonData.Ot)) ? jsonData.Ot : null;
                pendingIntermediateTPackets.push({ T: tVal, Pr: iPr, It: iIt, Dr: iDr, Ot: iOt, receivedAt: Date.now() });
                // Update lastPidValues so the following main packet uses latest PID terms
                if (iPr !== null) lastPidValues.proportional = iPr;
                if (iIt !== null) lastPidValues.integral = iIt;
                if (iDr !== null) lastPidValues.derivative = iDr;
                if (iOt !== null) lastPidValues.output = iOt;
            }
            return;
        }

        // ============================================================================
        // HANDLE MAIN DATA MESSAGE: {"T": 25.5, "P": 45.2, "F": 50}
        // ============================================================================
        
        console.log('📊 Main Data Message detected!');
        addToLog('📊 Main Data Message (T, P, F)');
        
        // Extract temperature (T), power (P), and fan (F) from JSON
        // T = temperature in Celsius
        // P = power in Watts
        // F = fan speed (0-100) - optional
        var temperature = jsonData.T;
        var power = jsonData.P;
        var fanSpeed = jsonData.F;
        
        console.log('  Temperature (T):', temperature);
        console.log('  Power (P):', power);
        console.log('  Fan (F):', fanSpeed);
        
        // Use the stored PID values from the last PID message
        var proportional = lastPidValues.proportional;
        var integral = lastPidValues.integral;
        var derivative = lastPidValues.derivative;
        var output = lastPidValues.output;
        
        console.log('  Using stored PID values:');
        console.log('    Proportional:', proportional);
        console.log('    Integral:', integral);
        console.log('    Derivative:', derivative);
        console.log('    Output:', output);
        
        // Validate that we have temperature and power data
        if (typeof temperature !== 'number' || isNaN(temperature)) {
            return;
        }
        
        if (typeof power !== 'number' || isNaN(power)) {
            return;
        }

        lastKnownP = power;
        lastKnownF = (typeof fanSpeed === 'number' && !isNaN(fanSpeed)) ? fanSpeed : lastKnownF;

        var heaterTempBigEl = document.getElementById('heaterTempBig');
        if (heaterTempBigEl) heaterTempBigEl.textContent = temperature.toFixed(1);

        // In manual mode, sync incoming JSON power value to the manual slider UI.
        // IMPORTANT: We only update UI elements here and do not send commands back.
        if (currentControlMode === 'manual') {
            var powerFromJson = Math.max(0, Math.min(100, Math.round(power)));

            // Only update the UI when the received value actually changes.
            var powerSliderElement = document.getElementById('powerSlider');
            var currentPowerSliderValue = powerSliderElement ? parseInt(powerSliderElement.value, 10) : NaN;

            // If a user command is in-flight, skip hardware echo unless it confirms our value.
            if (pendingPowerValue !== null) {
                if (powerFromJson === pendingPowerValue) {
                    clearTimeout(pendingPowerTimeout);
                    pendingPowerValue = null;
                }
            }

            if ((pendingPowerValue === null) && (isNaN(currentPowerSliderValue) || currentPowerSliderValue !== powerFromJson)) {
                var powerDisplayElement = document.getElementById('powerDisplay');
                var powerTooltipElement = document.getElementById('powerTooltip');
                var powerSliderFillElement = document.getElementById('powerSliderFill');
                var powerOffButtonElement = document.getElementById('powerOff');
                var power50ButtonElement = document.getElementById('power50');
                var power100ButtonElement = document.getElementById('power100');

                if (powerSliderElement) {
                    powerSliderElement.value = powerFromJson;
                }

                // Keep slider and text box fully in sync with incoming JSON power.
                if (powerDisplayElement) {
                    powerDisplayElement.value = powerFromJson;
                }

                // Always update fill bar directly so it matches the slider thumb.
                if (powerSliderFillElement) {
                    powerSliderFillElement.style.setProperty('--fill-percent', powerFromJson + '%');
                    powerSliderFillElement.style.width = powerFromJson + '%';
                }

                if (typeof updatePowerSliderFill === 'function') {
                    updatePowerSliderFill(powerFromJson);
                }

                if (powerTooltipElement) {
                    powerTooltipElement.textContent = powerFromJson + '%';
                }

                if (powerOffButtonElement) powerOffButtonElement.classList.remove('active');
                if (power50ButtonElement) power50ButtonElement.classList.remove('active');
                if (power100ButtonElement) power100ButtonElement.classList.remove('active');
                if (powerFromJson === 0 && powerOffButtonElement) {
                    powerOffButtonElement.classList.add('active');
                } else if (powerFromJson === 50 && power50ButtonElement) {
                    power50ButtonElement.classList.add('active');
                } else if (powerFromJson === 100 && power100ButtonElement) {
                    power100ButtonElement.classList.add('active');
                }

                addToLog('Manual slider synced from JSON P=' + powerFromJson + '%');
            }
        }

        // Update fan speed if provided in JSON - ONLY if value has changed
        if (typeof fanSpeed === 'number' && !isNaN(fanSpeed) && fanSpeed >= 0 && fanSpeed <= 100) {
            // If a user command is in-flight, skip hardware echo unless it confirms our value.
            if (pendingFanValue !== null) {
                if (fanSpeed === pendingFanValue) {
                    clearTimeout(pendingFanTimeout);
                    pendingFanValue = null;
                }
            }
            // Only update UI if no pending command and the value has actually changed
            if (pendingFanValue === null && fanSpeed !== lastKnownFanSpeed) {
                lastKnownFanSpeed = fanSpeed;
                if (fanSpeedInput) {
                    fanSpeedInput.value = fanSpeed;
                    // Only update text box if user is not currently typing in it
                    if (fanSpeedDisplay && document.activeElement !== fanSpeedDisplay) {
                        fanSpeedDisplay.value = fanSpeed;
                    }
                    updateSliderFill(fanSpeed);
                    updateFanIcon(fanSpeed);
                }
            }
        }
        
        // Get target temperature from the UI slider (if available)
        // CRITICAL: Use On/Off target temp if in On/Off mode, otherwise use Manual mode heater temp
        var targetTemperature = NaN;
        if (currentControlMode === 'onoff' && typeof onoffTargetTemp === 'number' && !isNaN(onoffTargetTemp)) {
            // In On/Off mode, use the On/Off target temperature
            targetTemperature = onoffTargetTemp;
        } else if (heaterTempInput) {
            // In Manual mode, use the heater temp input
            var targetValue = parseInt(heaterTempInput.value, 10);
            if (!isNaN(targetValue)) {
                targetTemperature = targetValue;
            }
        }
        
        // Build the data array that addPoint expects
        // The array now has 17 elements (indices 0-16):
        // Index 9: Heater Temperature (this is what we get from jsonData.T)
        // Index 10: Power (this is what we get from jsonData.P)
        // Index 11: Target Temperature (from UI slider)
        // Index 12: Not used
        // Index 13: Output (Ot) - PID mode only
        // Index 14: Proportional (Pr) - PID mode only
        // Index 15: Integral (It) - PID mode only
        // Index 16: Derivative (Dr) - PID mode only
        var valuesArray13 = [];
        
        // Fill indices 0-8 with NaN (not used, but needed for array structure)
        for (var i = 0; i < 9; i++) {
            valuesArray13.push(NaN);
        }
        
        // Index 9: Heater Temperature from JSON
        valuesArray13.push(temperature);
        
        // Index 10: Power from JSON
        valuesArray13.push(power);
        
        // Index 11: Target Temperature from UI
        valuesArray13.push(targetTemperature);
        
        // Index 12: Not used, but add NaN to complete the array
        valuesArray13.push(NaN);
        
        // Index 13: Output (Ot) - for PID mode
        valuesArray13.push((typeof output === 'number' && !isNaN(output)) ? output : 0);
        
        // Index 14: Proportional (Pr) - for PID mode
        valuesArray13.push((typeof proportional === 'number' && !isNaN(proportional)) ? proportional : 0);
        
        // Index 15: Integral (It) - for PID mode
        valuesArray13.push((typeof integral === 'number' && !isNaN(integral)) ? integral : 0);
        
        // Index 16: Derivative (Dr) - for PID mode
        valuesArray13.push((typeof derivative === 'number' && !isNaN(derivative)) ? derivative : 0);
        
        // Update connection status to show we're receiving data
        try {
            updateConnectionStatus(true);
        } catch (e) {
            // Ignore errors
        }
        
        // Update packet count and last update time
        packetCount += 1;
        if (packetCountDisplay) {
            packetCountDisplay.textContent = String(packetCount);
        }
        if (lastUpdateDisplay) {
            lastUpdateDisplay.textContent = new Date().toLocaleTimeString();
        }
        
        // --------------------------------------------------------------------
        // Update the main Chart.js graph using addPoint() function
        // This ensures the correct chart (Manual/On/Off/PID) is updated based on current mode
        // --------------------------------------------------------------------
        // CRITICAL: Use addPoint() instead of directly updating chartJsRef
        // This ensures On/Off mode uses window.liveChartRef, not chartJsRef
        refreshChartPauseState();
        if (!isChartPausedForInactivity && typeof addPoint === 'function') {
            // Flush buffered T-only intermediate packets, equally distributed between
            // the previous main packet time and now, before plotting the current main packet.
            if (!skipNextDataPoint && pendingIntermediateTPackets.length > 0 && lastMainPacketTime !== null) {
                var flushNow = Date.now();
                var flushPrev = lastMainPacketTime;
                var flushN = pendingIntermediateTPackets.length;
                for (var pi = 0; pi < flushN; pi++) {
                    var interimTs = new Date(flushPrev + (pi + 1) * (flushNow - flushPrev) / (flushN + 1));
                    var iPkt = pendingIntermediateTPackets[pi];
                    var iArr = [NaN,NaN,NaN,NaN,NaN,NaN,NaN,NaN,NaN,
                                iPkt.T,
                                lastKnownP, NaN, NaN,
                                iPkt.Ot !== null ? iPkt.Ot : lastPidValues.output,
                                iPkt.Pr !== null ? iPkt.Pr : lastPidValues.proportional,
                                iPkt.It !== null ? iPkt.It : lastPidValues.integral,
                                iPkt.Dr !== null ? iPkt.Dr : lastPidValues.derivative];
                    addPoint(iArr, { skipCsv: true, timestamp: interimTs });
                }
            }
            pendingIntermediateTPackets = [];
            lastMainPacketTime = Date.now();
            addPoint(valuesArray13, { skipCsv: true });
        }
        
        // All chart updates now go through addPoint() which handles the correct chart based on mode

        // If CSV saving is active, store mode-specific CSV row
        if (isSavingCsv) {
            var modeForCsv = csvSessionMode || currentControlMode;
            var fanForCsv = getCurrentFanPercentForMode(modeForCsv, fanSpeed);

            if (modeForCsv === 'manual') {
                var manualPowerSlider = document.getElementById('powerSlider');
                var manualPowerDisplay = document.getElementById('powerDisplay');
                var powerPercentForCsv = NaN;
                if (manualPowerSlider) {
                    powerPercentForCsv = parseFloat(manualPowerSlider.value);
                }
                if (isNaN(powerPercentForCsv) && manualPowerDisplay) {
                    powerPercentForCsv = parseFloat(manualPowerDisplay.value);
                }
                if (isNaN(powerPercentForCsv)) {
                    powerPercentForCsv = 0;
                }

                addCsvRowForCurrentSession(
                    powerPercentForCsv.toFixed(1) + ',' +
                    temperature.toFixed(2) + ',' +
                    fanForCsv
                );
            } else if (modeForCsv === 'onoff') {
                var onoffTargetForCsv = (typeof onoffTargetTemp === 'number' && !isNaN(onoffTargetTemp)) ? onoffTargetTemp : 20;
                var onoffHystForCsv = (typeof onoffHysteresisValue === 'number' && !isNaN(onoffHysteresisValue)) ? onoffHysteresisValue : 3;

                addCsvRowForCurrentSession(
                    onoffTargetForCsv.toFixed(1) + ',' +
                    temperature.toFixed(2) + ',' +
                    onoffHystForCsv.toFixed(1) + ',' +
                    power.toFixed(1) + ',' +
                    fanForCsv
                );
            } else if (modeForCsv === 'pid') {
                var pidTargetForCsv = (typeof pidTargetTemp === 'number' && !isNaN(pidTargetTemp)) ? pidTargetTemp : 20;
                var outputForCsv = (typeof output === 'number' && !isNaN(output)) ? output : 0;
                var proportionalForCsv = (typeof proportional === 'number' && !isNaN(proportional)) ? proportional : 0;
                var integralForCsv = (typeof integral === 'number' && !isNaN(integral)) ? integral : 0;
                var derivativeForCsv = (typeof derivative === 'number' && !isNaN(derivative)) ? derivative : 0;

                var pidPInputElement = document.getElementById('pidPInput');
                var pidIInputElement = document.getElementById('pidIInput');
                var pidDInputElement = document.getElementById('pidDInput');
                var pidPSet = pidPInputElement ? parseFloat(pidPInputElement.value) : 0;
                var pidISet = pidIInputElement ? parseFloat(pidIInputElement.value) : 0;
                var pidDSet = pidDInputElement ? parseFloat(pidDInputElement.value) : 0;
                if (isNaN(pidPSet)) pidPSet = 0;
                if (isNaN(pidISet)) pidISet = 0;
                if (isNaN(pidDSet)) pidDSet = 0;

                var pidFrequencyElement = document.getElementById('pidFrequency');
                var pidFreqForCsv = pidFrequencyElement ? parseFloat(pidFrequencyElement.value) : 1;
                if (isNaN(pidFreqForCsv)) pidFreqForCsv = 1;

                addCsvRowForCurrentSession(
                    (csvSessionPidControlType || getPidControlTypeFromUI()) + ',' +
                    pidTargetForCsv.toFixed(1) + ',' +
                    temperature.toFixed(2) + ',' +
                    outputForCsv.toFixed(2) + ',' +
                    proportionalForCsv.toFixed(2) + ',' +
                    integralForCsv.toFixed(2) + ',' +
                    derivativeForCsv.toFixed(2) + ',' +
                    fanForCsv + ',' +
                    pidPSet.toFixed(2) + ',' +
                    pidISet.toFixed(2) + ',' +
                    pidDSet.toFixed(2) + ',' +
                    pidFreqForCsv
                );
            }
        }

        // Log success
        addToLog('Data processed - Temp: ' + temperature.toFixed(2) + '°C, Power: ' + power.toFixed(1) + 'W');
        
    } catch (error) {
        // Silent error
        addToLog('Error processing JSON data: ' + (error.message || String(error)));
    }
}

function setupDataListeners() {
    window.electronAPI.onDataReceived(function (event, data) {
        handleIncomingData(data);
    });
    
    // Add listener for JSON data from hardware
    // This listens for the 'json-data-received' event sent from main.js
    if (window.electronAPI.onJsonDataReceived) {
        window.electronAPI.onJsonDataReceived(function (event, jsonData) {
            handleJsonData(jsonData);
        });
        console.log('JSON data listener registered');
    } else {
        console.log('Warning: onJsonDataReceived not available in electronAPI');
    }
    // Also display raw incoming chunks for debugging when framing fails
    if (window.electronAPI.onDataChunk) {
        window.electronAPI.onDataChunk(function (event, chunk) {
            try {
                var arr = (chunk instanceof Uint8Array) ? Array.from(chunk) : (Array.isArray(chunk) ? chunk.slice() : Array.from(new Uint8Array(chunk)));
                // Show last ~128 bytes of raw stream in Raw Data panel if no valid packet shown yet
                if (rawDataDisplay && (!rawDataDisplay.textContent || rawDataDisplay.textContent.indexOf('No data received yet') !== -1)) {
                    var hex = '';
                    var start = Math.max(0, arr.length - 128);
                    for (var i = start; i < arr.length; i++) {
                        hex += arr[i].toString(16).toUpperCase().padStart(2, '0') + ' ';
                    }
                    if (rawDataDisplay) rawDataDisplay.textContent = hex.trim();
                }
            } catch (e) {
                // ignore
            }
        });
    }
    if (window.electronAPI.onSerialTxDebug) {
        window.electronAPI.onSerialTxDebug(function (event, txData) {
            try {
                var description = txData && txData.description ? txData.description : 'command';
                var jsonCommand = txData && txData.json ? txData.json : '';
                addToLog('TX sent (' + description + '): ' + jsonCommand);
            } catch (e) {
                // ignore
            }
        });
    }
    window.electronAPI.onConnectionStatus(function (event, status) {
        if (status.connected) {
            updateConnectionStatus(true, status.port);
            // Re-send temperature unit preference so hardware reports in the saved unit
            if (currentTempUnit === 'F' && window.electronAPI.sendCustomJson) {
                window.electronAPI.sendCustomJson({ K: 1 }, 'temp-unit').catch(function() {});
            }
        } else {
            updateConnectionStatus(false);
            if (status.error) {
                addToLog('Connection error: ' + status.error);
            }
        }
    });

    // Mirror state changes pushed from phone/tablet clients
    if (window.electronAPI.onRemoteControlUpdate) {
        window.electronAPI.onRemoteControlUpdate(function (event, state) {
            applyRemoteStateUpdate(state);
        });
    }

    // Show the local web server URL once the embedded server is listening
    if (window.electronAPI.onWebServerUrl) {
        window.electronAPI.onWebServerUrl(function (event, info) {
            populateRemoteAccessCard(info);
            addToLog('[WEB] Remote access URL: ' + info.url);
        });
    }
}

function populateRemoteAccessCard(info) {
    var urlEl = document.getElementById('webServerUrl');
    var ipEl = document.getElementById('webServerIp');
    var qrEl = document.getElementById('webServerQr');
    if (urlEl) { urlEl.textContent = info.url; urlEl.href = info.url; }
    if (ipEl && info.ips && info.ips.length) { ipEl.textContent = info.ips.join(', '); }
    if (qrEl && info.qrCode) { qrEl.src = info.qrCode; qrEl.classList.remove('hidden'); }
}

function setupUiActionLogging() {
    if (!window.electronAPI || !window.electronAPI.sendUiDebugLog) {
        return;
    }

    var lastSliderLogTimeByElement = {};

    function getElementName(target) {
        if (!target) return 'unknown';
        if (target.id && target.id.trim() !== '') return target.id;
        if (target.name && target.name.trim() !== '') return target.name;
        if (target.className && typeof target.className === 'string' && target.className.trim() !== '') {
            return target.tagName.toLowerCase() + '.' + target.className.split(' ')[0];
        }
        return target.tagName ? target.tagName.toLowerCase() : 'unknown';
    }

    function sendUiLog(actionType, target, value) {
        try {
            window.electronAPI.sendUiDebugLog({
                actionType: actionType,
                target: getElementName(target),
                value: value
            });
        } catch (error) {
            // ignore
        }
    }

    document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target) return;
        var clickable = target.closest('button, a, [role="button"]');
        if (!clickable) return;
        sendUiLog('button_click', clickable, clickable.textContent ? clickable.textContent.trim() : '');
    }, true);

    document.addEventListener('change', function (event) {
        var target = event.target;
        if (!target) return;
        if (target.tagName === 'SELECT') {
            sendUiLog('menu_select', target, target.value);
            return;
        }
        if (target.matches('input, textarea')) {
            sendUiLog('input_change', target, target.value);
        }
    }, true);

    document.addEventListener('input', function (event) {
        var target = event.target;
        if (!target) return;
        if (target.matches('input[type="range"]')) {
            var elementKey = getElementName(target);
            var now = Date.now();
            var lastTime = lastSliderLogTimeByElement[elementKey] || 0;
            if (now - lastTime >= 250) {
                lastSliderLogTimeByElement[elementKey] = now;
                sendUiLog('slider_move', target, target.value);
            }
        }
    }, true);
}

if (connectBtn) connectBtn.addEventListener('click', connectToPort);
if (disconnectBtn) disconnectBtn.addEventListener('click', disconnectFromPort);
if (refreshPortsBtn) refreshPortsBtn.addEventListener('click', refreshComPorts);

document.addEventListener('DOMContentLoaded', function () {
    // Check if electronAPI is available and create fallback if needed
    var apiAvailable = ensureElectronAPI();

    addToLog('Process Control Temperature started');

    if (!apiAvailable) {
        // Wire up real server API before setupDataListeners registers its callbacks
        setupServerBridge();
    }

    setupUiActionLogging();

    addToLog('Click "Refresh Ports" to see available COM ports');
    // Charts are initialized by mode-specific functions when control mode is selected

    // Initialize PID fan slider fill to 0% to ensure background is visible
    var pidFanFill = document.getElementById('pidFanSliderFill');
    if (pidFanFill) {
        pidFanFill.style.setProperty('--fill-percent', '0%', 'important');
        pidFanFill.style.setProperty('width', '0%', 'important');
    }

    // Re-setup PID fan buttons to ensure they work (in case elements weren't ready earlier)
    setupPidFanButtons();

    // Re-setup PID fan slider handler to ensure it works
    setupPidFanSliderHandler();

    setupDataListeners();

    // Electron mode: actively poll for web server URL until it arrives
    // (the IPC event may already have fired before listeners were registered)
    if (apiAvailable && window.electronAPI.getWebServerUrl) {
        (function pollWebServerUrl(attemptsLeft) {
            window.electronAPI.getWebServerUrl().then(function(info) {
                if (info) {
                    populateRemoteAccessCard(info);
                } else if (attemptsLeft > 0) {
                    setTimeout(function() { pollWebServerUrl(attemptsLeft - 1); }, 500);
                }
            }).catch(function() {});
        })(20); // up to 20 × 500 ms = 10 s
    }

    // Setup clear/save controls
    var clearDataBtn = document.getElementById('clearDataBtn');
    var startCsvBtn = document.getElementById('startCsvBtn');
    var stopCsvBtn = document.getElementById('stopCsvBtn');
    var captureDistanceBtn = document.getElementById('captureDistanceBtn');

    if (!window.electronAPI || !window.electronAPI.showSaveDialog) {
        if (startCsvBtn) startCsvBtn.style.display = 'none';
        if (stopCsvBtn) stopCsvBtn.style.display = 'none';
    }



    if (clearDataBtn) {
        clearDataBtn.addEventListener('click', function () {
            // Clear all chart data
            for (var i = 0; i < 3; i++) {
                chartData.series[i] = [];
            }

            // Clear Chart.js data
            if (window.liveChartRef) {
                window.liveChartRef.data.labels = [];
                for (var j = 0; j < window.liveChartRef.data.datasets.length; j++) {
                    window.liveChartRef.data.datasets[j].data = [];
                }
                window.liveChartRef.update('none');
            }

            if (chartJsRef) {
                chartJsRef.data.labels = [];
                for (var k = 0; k < chartJsRef.data.datasets.length; k++) {
                    chartJsRef.data.datasets[k].data = [];
                }
                chartJsRef.update('none');
            }

            redrawChart();
            addToLog('All chart data cleared');
        });
    }

    // Handle chart display mode dropdown
    var chartDisplayModeSelect = document.getElementById('chartDisplayMode');
    if (chartDisplayModeSelect) {
        chartDisplayModeSelect.addEventListener('change', function () {
            var newMode = this.value;
            if (newMode !== chartDisplayMode) {
                chartDisplayMode = newMode;
                addToLog('Chart display mode changed to: ' + (newMode === 'limited' ? 'Last 50 Points' : 'All Data Points'));

                // Clear all chart data when switching display modes (start fresh)
                if (chartData.series) {
                    for (var i = 0; i < chartData.series.length; i++) {
                        chartData.series[i] = [];
                    }
                }

                // Clear Chart.js charts
                if (window.liveChartRef) {
                    window.liveChartRef.data.labels = [];
                    for (var j = 0; j < window.liveChartRef.data.datasets.length; j++) {
                        window.liveChartRef.data.datasets[j].data = [];
                    }
                    window.liveChartRef.update('none');
                }

                if (chartJsRef) {
                    chartJsRef.data.labels = [];
                    for (var j = 0; j < chartJsRef.data.datasets.length; j++) {
                        chartJsRef.data.datasets[j].data = [];
                    }
                    chartJsRef.update('none');
                }

                // Chart.js charts are cleared above

                addToLog('Chart cleared - new data will be displayed in ' + (newMode === 'limited' ? 'limited' : 'all data') + ' mode');
            }
        });
    }


    if (startCsvBtn) {
        startCsvBtn.addEventListener('click', function () {
            startCsvSaving();
        });
    }

    if (stopCsvBtn) {
        stopCsvBtn.addEventListener('click', function () {
            stopCsvSaving();
        });
    }

    // Function to resize distance input boxes based on content
    function resizeDistanceInput(input) {
        if (!input) return;

        // Get the current value or use placeholder
        var textToMeasure = input.value || input.placeholder || '0';
        if (!textToMeasure) textToMeasure = '0';

        var computedStyle = window.getComputedStyle(input);
        var fontSize = parseFloat(computedStyle.fontSize) || 16;

        // Use canvas for accurate text measurement
        var canvas = document.createElement('canvas');
        var context = canvas.getContext('2d');

        // Build font string: weight size family
        var fontFamily = computedStyle.fontFamily || 'Arial';
        var fontWeight = computedStyle.fontWeight || 'normal';
        var fontString = fontWeight + ' ' + fontSize + 'px ' + fontFamily;
        context.font = fontString;

        // Measure text width
        var textWidth = context.measureText(textToMeasure).width;

        // Get padding and border values
        var paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
        var paddingRight = parseFloat(computedStyle.paddingRight) || 0;
        var borderLeft = parseFloat(computedStyle.borderLeftWidth) || 0;
        var borderRight = parseFloat(computedStyle.borderRightWidth) || 0;

        // Calculate total width needed
        // With box-sizing: border-box, width includes padding and border
        var totalWidth = textWidth + paddingLeft + paddingRight + borderLeft + borderRight;

        // Add generous buffer (at least 30px or 2 character widths)
        var charWidth = textWidth / Math.max(textToMeasure.length, 1);
        var buffer = Math.max(charWidth * 2.5, 30);
        totalWidth += buffer;

        // Set min and max constraints
        var rootFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
        var minWidth = 4 * rootFontSize; // 4rem minimum
        var maxWidth = 40 * rootFontSize; // 40rem maximum (very large for long numbers like 10000)
        totalWidth = Math.max(minWidth, Math.min(maxWidth, totalWidth));

        // Set the width
        input.style.width = totalWidth + 'px';

        // Force a reflow to ensure the width is applied
        input.offsetHeight;
    }

    // Initialize Chart.js test chart for live data (10 temps + power + target)
    try {
        var primaryCanvasInit = document.getElementById('testChartPrimary');
        var secondaryCanvasInit = document.getElementById('testChartSecondary');
        if (primaryCanvasInit && secondaryCanvasInit && window.Chart && !currentChartMode) {
            initChartForManual();
        }
    } catch (e) { /* ignore */ }
    updateChartTheme();
    window.electronAPI.onPortsUpdate(handlePortsUpdateFromMain);
    refreshComPorts();
    // Server bridge handles hardware in web mode — Web Serial not needed
    if (!apiAvailable && webConnectBtn) {
        webConnectBtn.style.display = 'none';
    }


    // ============================================================================
    // PROCESS CONTROL MODE SWITCHING
    // ============================================================================

    // Control mode state
    // currentControlMode is declared as a global at the top of this file so that
    // it is always defined when addPoint or JSON handlers are called.
    currentControlMode = 'manual'; // 'manual', 'onoff', or 'pid'
    var pidControlActive = false; // Track if PID control is actively running
    // Get control mode elements
    var controlModeSelect = document.getElementById('controlModeSelect');
    var manualControlMode = document.getElementById('manualControlMode');
    var onoffControlMode = document.getElementById('onoffControlMode');
    var pidControlMode = document.getElementById('pidControlMode');

    // On/Off mode elements
    var onoffFanSpeedInput = document.getElementById('onoffFanSpeed');
    var onoffFanSpeedDisplay = document.getElementById('onoffFanSpeedDisplay');
    var onoffFanOffBtn = document.getElementById('onoffFanOff');
    var onoffFan50Btn = document.getElementById('onoffFan50');
    var onoffFan100Btn = document.getElementById('onoffFan100');
    // On/Off Target Temperature control elements
    var onoffTargetSlider = document.getElementById('onoffTargetSlider');
    var onoffTargetDisplay = document.getElementById('onoffTargetDisplay');
    var onoffTargetSliderFill = document.getElementById('onoffTargetSliderFill');
    var onoffTargetTooltip = document.getElementById('onoffTargetTooltip');
    var onoffTarget0Btn = document.getElementById('onoffTarget0');
    var onoffTarget50Btn = document.getElementById('onoffTarget50');
    var onoffTarget100Btn = document.getElementById('onoffTarget100');
    // onoffTargetTemp and onoffHysteresisValue are now global variables (declared at top of file)
    // Initialize them if they haven't been set yet
    if (typeof onoffTargetTemp === 'undefined') {
        onoffTargetTemp = 20;
    }
    if (typeof onoffHysteresisValue === 'undefined') {
        onoffHysteresisValue = 3;
    }
    var onoffHysteresis = document.getElementById('onoffHysteresis');

    // PID mode elements - Target Temperature control (same as On/Off)
    var pidTargetSlider = document.getElementById('pidTargetSlider');
    var pidTargetDisplay = document.getElementById('pidTargetDisplay');
    var pidTargetSliderFill = document.getElementById('pidTargetSliderFill');
    var pidTargetTooltip = document.getElementById('pidTargetTooltip');
    var pidTarget0Btn = document.getElementById('pidTarget0');
    var pidTarget50Btn = document.getElementById('pidTarget50');
    var pidTarget100Btn = document.getElementById('pidTarget100');
    // pidTargetTemp is now declared globally at the top of the file
    // PID Fan control elements
    var pidFanSpeedInput = document.getElementById('pidFanSpeed');
    var pidFanSpeedDisplay = document.getElementById('pidFanSpeedDisplay');
    var pidFanSliderFill = document.getElementById('pidFanSliderFill');
    var pidFanTooltip = document.getElementById('pidFanTooltip');
    var pidFanOffBtn = document.getElementById('pidFanOff');
    var pidFan50Btn = document.getElementById('pidFan50');
    var pidFan100Btn = document.getElementById('pidFan100');

    // PID Control Type and Parameter inputs
    var pidControlType = document.getElementById('pidControlType');
    var errorMenuWrapper = document.getElementById('errorMenuWrapper');
    var integralWindupBtn = document.getElementById('integralWindupBtn');
    var integralWindupNextValue = 1;
    var pidPInput = document.getElementById('pidPInput');
    var pidIInput = document.getElementById('pidIInput');
    var pidDInput = document.getElementById('pidDInput');
    var pidPInputContainer = document.getElementById('pidPInputContainer');
    var pidIInputContainer = document.getElementById('pidIInputContainer');
    var pidDInputContainer = document.getElementById('pidDInputContainer');
    var pidFrequency = document.getElementById('pidFrequency');

    // Function to update PID input visibility based on control type
    function updatePIDInputsVisibility() {
        if (!pidControlType) return;

        var controlType = pidControlType.value;

        // P input is always visible
        if (pidPInputContainer) pidPInputContainer.style.display = 'flex';

        // I input visible for PI and PID
        if (pidIInputContainer) {
            pidIInputContainer.style.display =
                (controlType === 'PI' || controlType === 'PID') ? 'flex' : 'none';
        }

        // D input visible for PD and PID
        if (pidDInputContainer) {
            pidDInputContainer.style.display =
                (controlType === 'PD' || controlType === 'PID') ? 'flex' : 'none';
        }

        updateIntegralWindupVisibility();
    }

    function updateIntegralWindupVisibility() {
        if (!errorMenuWrapper || !pidControlType) return;
        var show = (currentControlMode === 'pid' && pidControlType.value === 'PI');
        errorMenuWrapper.classList.toggle('hidden', !show);
        if (!show) {
            integralWindupNextValue = 1;
            if (integralWindupBtn) integralWindupBtn.textContent = 'Integral Windup DISABLED';
            var errorMenuDetails = document.getElementById('errorMenuDetails');
            if (errorMenuDetails) errorMenuDetails.removeAttribute('open');
        }
    }


    // Function to send hysteresis value to hardware
    async function sendHysteresisToHardware(value) {
        try {
            // Send the hysteresis value to hardware
            // Note: This assumes there's an IPC handler for this
            // If not, you may need to add one in main.js
            if (window.electronAPI && window.electronAPI.sendHysteresis) {
                var result = await window.electronAPI.sendHysteresis(value);
                if (result && result.success) {
                    addToLog('On/Off: Hysteresis ' + value + '°C sent to hardware');
                } else {
                    addToLog('On/Off: Failed to send hysteresis: ' + (result && result.error ? result.error : 'Unknown error'));
                }
            } else {
                // If IPC handler doesn't exist, just log it
                addToLog('On/Off: Hysteresis set to ' + value + '°C (hardware communication not available)');
            }
        } catch (error) {
            addToLog('On/Off: Error sending hysteresis: ' + error.message);
        }
    }

    // Function to send BOTH target temperature AND hysteresis to hardware together
    // This is used when switching to On/Off mode or when either value changes
    async function sendOnOffTargetAndHysteresisToHardware() {
        try {
            addToLog('On/Off: Sending target temperature and hysteresis to hardware...');
            
            // Get current values
            var targetTemp = onoffTargetTemp; // Global variable
            var hysteresis = onoffHysteresisValue; // Global variable
            
            // Make sure values are valid numbers
            if (typeof targetTemp !== 'number' || isNaN(targetTemp)) {
                targetTemp = 20; // Default
            }
            if (typeof hysteresis !== 'number' || isNaN(hysteresis)) {
                hysteresis = 3; // Default
            }
            
            // Send target temperature first
            if (window.electronAPI && window.electronAPI.sendHeaterTemp) {
                var tempResult = await window.electronAPI.sendHeaterTemp(targetTemp);
                if (tempResult && tempResult.success) {
                    addToLog('On/Off: Target temperature ' + targetTemp + (currentTempUnit === 'F' ? '°F' : '°C') + ' sent to hardware');
                } else {
                    addToLog('On/Off: Failed to send target temperature: ' + (tempResult && tempResult.error ? tempResult.error : 'Unknown error'));
                }
            }
            
            // Small delay between commands to avoid overwhelming the hardware
            await new Promise(function(resolve) { setTimeout(resolve, 50); });
            
            // Send hysteresis second
            if (window.electronAPI && window.electronAPI.sendHysteresis) {
                var hystResult = await window.electronAPI.sendHysteresis(hysteresis);
                if (hystResult && hystResult.success) {
                    addToLog('On/Off: Hysteresis ' + hysteresis + ' sent to hardware');
                } else {
                    addToLog('On/Off: Failed to send hysteresis: ' + (hystResult && hystResult.error ? hystResult.error : 'Unknown error'));
                }
            }
            
            addToLog('On/Off: Target temperature (' + targetTemp + ') and hysteresis (' + hysteresis + ') sent successfully');
            
        } catch (error) {
            addToLog('On/Off: Error sending target and hysteresis: ' + error.message);
        }
    }

    // Function to switch control modes
    async function switchControlMode(mode) {
        markUserControlActivity();
        if (isSavingCsv) {
            addToLog('CSV saving stopped because control mode was changed.');
            stopCsvSaving();
        }
        currentControlMode = mode;

        // Send control mode to hardware IMMEDIATELY
        // Manual = 1, On/Off = 2, PID = 3
        var modeValue = 1; // Default to Manual
        if (mode === 'manual') {
            modeValue = 1;
        } else if (mode === 'onoff') {
            modeValue = 2;
        } else if (mode === 'pid') {
            modeValue = 3;
        }

        // Send control mode to hardware
        try {
            if (window.electronAPI && window.electronAPI.sendControlMode) {
                var result = await window.electronAPI.sendControlMode(modeValue);
                if (result && result.success) {
                    addToLog('Control mode sent to hardware: ' + mode.toUpperCase() + ' (value: ' + modeValue + ')');
                } else {
                    addToLog('Failed to send control mode: ' + (result && result.error ? result.error : 'Unknown error'));
                }
            } else {
                addToLog('Control mode changed to: ' + mode.toUpperCase() + ' (hardware communication not available)');
            }
        } catch (error) {
            addToLog('Error sending control mode: ' + error.message);
        }

        // SAFETY: Send shutdown commands to hardware when switching modes
        // This ensures fan, heater, and power are turned off for protection and reliability
        addToLog('Sending safety shutdown commands...');
        
        try {
            // 1. Turn off fan (set to 0%)
            if (window.electronAPI && window.electronAPI.sendFanSpeed) {
                var fanResult = await window.electronAPI.sendFanSpeed(0);
                if (fanResult && fanResult.success) {
                    addToLog('Safety: Fan turned off (0%)');
                }
            }

            // Small delay between commands
            await new Promise(function(resolve) { setTimeout(resolve, 100); });

            // 2. Turn off heater (mode 0)
            if (window.electronAPI && window.electronAPI.setHeaterMode) {
                var heaterModeResult = await window.electronAPI.setHeaterMode(0);
                if (heaterModeResult && heaterModeResult.success) {
                    addToLog('Safety: Heater turned off');
                }
            }

            // Small delay between commands
            await new Promise(function(resolve) { setTimeout(resolve, 100); });

            // 3. Set target temperature to 20°C (safe default)
            if (window.electronAPI && window.electronAPI.sendHeaterTemp) {
                var tempResult = await window.electronAPI.sendHeaterTemp(20);
                if (tempResult && tempResult.success) {
                    addToLog('Safety: Target temperature set to 20°C');
                }
            }

            // Small delay between commands
            await new Promise(function(resolve) { setTimeout(resolve, 100); });

            // 4. Set power to 0% (for manual mode)
            if (window.electronAPI && window.electronAPI.sendPower) {
                var powerResult = await window.electronAPI.sendPower(0);
                if (powerResult && powerResult.success) {
                    addToLog('Safety: Power set to 0%');
                }
            }

            addToLog('All safety commands sent successfully');

        } catch (error) {
            addToLog('Error sending safety commands: ' + error.message);
        }

        // Reset all control values when switching modes - UPDATE UI to match hardware state
        
        // Set fan UI to 0 for all modes
        if (fanSpeedInput) {
            fanSpeedInput.value = 0;
            if (fanSpeedDisplay) fanSpeedDisplay.value = 0;
            var fanFillElement = document.getElementById('fanSliderFill');
            if (fanFillElement) {
                fanFillElement.style.setProperty('--fill-percent', '0%');
                fanFillElement.style.width = '0%';
            }
            // Update fan button states and icon
            if (typeof updateFanButtons === 'function') {
                updateFanButtons(0);
            }
            if (typeof updateFanIcon === 'function') {
                updateFanIcon(0);
            }
        }
        if (onoffFanSpeedInput) {
            onoffFanSpeedInput.value = 0;
            if (onoffFanSpeedDisplay) onoffFanSpeedDisplay.value = 0;
            var onoffFanFillElement = document.getElementById('onoffFanSliderFill');
            if (onoffFanFillElement) {
                onoffFanFillElement.style.setProperty('--fill-percent', '0%');
                onoffFanFillElement.style.width = '0%';
            }
            // Update On/Off fan button states
            if (typeof updateOnOffFanButtons === 'function') {
                updateOnOffFanButtons(0);
            }
        }
        if (pidFanSpeedInput) {
            pidFanSpeedInput.value = 0;
            if (pidFanSpeedDisplay) pidFanSpeedDisplay.value = 0;
            var pidFanFillElement = document.getElementById('pidFanSliderFill');
            if (pidFanFillElement) {
                pidFanFillElement.style.setProperty('--fill-percent', '0%', 'important');
                pidFanFillElement.style.setProperty('width', '0%', 'important');
            }
            // Update PID fan button states
            if (typeof updatePIDFanButtons === 'function') {
                updatePIDFanButtons(0);
            }
        }

        // Set power UI to 0 (for manual mode) - ONLY UPDATE UI, don't send to hardware
        if (powerSlider) {
            powerSlider.value = 0;
            var powerDisplay = document.getElementById('powerDisplay');
            if (powerDisplay) powerDisplay.value = 0;
            if (typeof updatePowerSliderFill === 'function') {
                updatePowerSliderFill(0);
            }
            // Update button states
            if (powerOffBtn) powerOffBtn.classList.add('active');
            if (power50Btn) power50Btn.classList.remove('active');
            if (power100Btn) power100Btn.classList.remove('active');
        }

        // Set target temp UI to 20 for all modes - ONLY UPDATE UI, don't send to hardware
        if (heaterTempInput) {
            heaterTempInput.value = 20;
            if (typeof updateHeaterSliderFill === 'function') {
                updateHeaterSliderFill(20);
            } else {
                var heaterFillElement = document.getElementById('heaterSliderFill');
                if (heaterFillElement) {
                    var percentage = ((20 - 20) / (70 - 20)) * 100;
                    heaterFillElement.style.setProperty('--fill-percent', percentage + '%');
                    heaterFillElement.style.width = percentage + '%';
                }
            }
        }
        
        // Update On/Off target temp UI - ONLY UPDATE UI
        if (onoffTargetSlider) {
            onoffTargetSlider.value = 20;
            onoffTargetTemp = 20;
            if (onoffTargetDisplay) onoffTargetDisplay.value = 20;
            if (onoffTargetTooltip) onoffTargetTooltip.textContent = '20°C';
            if (typeof updateOnOffTargetSliderFill === 'function') {
                updateOnOffTargetSliderFill(20);
            }
            if (typeof updateOnOffTargetButtons === 'function') {
                updateOnOffTargetButtons(20);
            }
        }
        
        // Update PID target temp UI - ONLY UPDATE UI
        if (pidTargetSlider) {
            pidTargetSlider.value = 20;
            pidTargetTemp = 20;
            if (pidTargetDisplay) pidTargetDisplay.value = 20;
            if (pidTargetTooltip) pidTargetTooltip.textContent = '20°C';
            if (typeof updatePidTargetSliderFill === 'function') {
                updatePidTargetSliderFill(20);
            }
            if (typeof updatePidTargetButtons === 'function') {
                updatePidTargetButtons(20);
            }
        }

        // Hide all control sections
        if (manualControlMode) manualControlMode.style.display = 'none';
        if (onoffControlMode) onoffControlMode.style.display = 'none';
        if (pidControlMode) pidControlMode.style.display = 'none';

        // Stop active control loops
        pidControlActive = false;

        // Clear all existing graph traces and reinitialize for new mode
        if (mode === 'manual') {
            initChartForManual();
            if (manualControlMode) manualControlMode.style.display = 'block';
            addToLog('Switched to Manual control mode');
        } else if (mode === 'onoff') {
            // CRITICAL: Ensure currentControlMode is set BEFORE initializing chart
            currentControlMode = 'onoff';
            initChartForOnOff();
            if (onoffControlMode) onoffControlMode.style.display = 'block';
            addToLog('Switched to On/Off control mode');
            
            // Send both target temperature and hysteresis to hardware when switching to On/Off mode
            await sendOnOffTargetAndHysteresisToHardware();
        } else if (mode === 'pid') {
            // Get current control type and initialize chart
            var pidControlTypeSelect = document.getElementById('pidControlType');
            var controlType = pidControlTypeSelect ? pidControlTypeSelect.value : 'PID';
            initChartForPID(controlType);
            if (pidControlMode) pidControlMode.style.display = 'block';
            addToLog('Switched to PID control mode (' + controlType + ')');
            if (typeof updatePIDInputsVisibility === 'function') {
                updatePIDInputsVisibility();
            }
            
            // Send current PID values to hardware when switching to PID mode
            if (window.electronAPI && window.electronAPI.sendPIDValue) {
                try {
                    var pValue = pidPInput ? parseFloat(pidPInput.value) : NaN;
                    var iValue = pidIInput ? parseFloat(pidIInput.value) : NaN;
                    var dValue = pidDInput ? parseFloat(pidDInput.value) : NaN;
                    var frequencyValue = pidFrequency ? parseFloat(pidFrequency.value) : 1.0;

                    if (isNaN(pValue)) pValue = parseFloat(localStorage.getItem('pid-default-P')) || 3.162;
                    if (isNaN(iValue)) iValue = parseFloat(localStorage.getItem('pid-default-I')) || 0.01;
                    if (isNaN(dValue)) dValue = parseFloat(localStorage.getItem('pid-default-D')) || 150;
                    if (isNaN(frequencyValue) || frequencyValue < 0.2 || frequencyValue > 1.2) frequencyValue = 1.0;
                    
                    // Send PID values and frequency to hardware
                    var resultP = await window.electronAPI.sendPIDValue('P', pValue);
                    var resultI = await window.electronAPI.sendPIDValue('I', iValue);
                    var resultD = await window.electronAPI.sendPIDValue('D', dValue);
                    var resultFrequency = await window.electronAPI.sendPIDFrequency(frequencyValue);
                    
                    if (resultP && resultP.success && resultI && resultI.success && resultD && resultD.success && resultFrequency && resultFrequency.success) {
                        addToLog('PID values sent to hardware: P=' + pValue + ', I=' + iValue + ', D=' + dValue + ', Frequency=' + frequencyValue + ' Hz');
                    } else {
                        addToLog('PID mode activated - Error sending values to hardware');
                    }
                } catch (error) {
                    addToLog('PID mode activated - Error sending values: ' + error.message);
                }
            }
        }

        updateIntegralWindupVisibility();
    }

    // Expose as global so sendShutdownCommandsOnReconnect (defined before init) can call it
    window.switchControlMode = switchControlMode;

    // Setup control mode dropdown
    if (controlModeSelect) {
        controlModeSelect.addEventListener('change', function () {
            var selectedMode = this.value;
            switchControlMode(selectedMode);
        });
    }

    // Helper function to update On/Off fan button states
    function updateOnOffFanButtons(speed) {
        if (onoffFanOffBtn) onoffFanOffBtn.classList.remove('active');
        if (onoffFan50Btn) onoffFan50Btn.classList.remove('active');
        if (onoffFan100Btn) onoffFan100Btn.classList.remove('active');
        
        if (speed === 0 && onoffFanOffBtn) {
            onoffFanOffBtn.classList.add('active');
        } else if (speed === 50 && onoffFan50Btn) {
            onoffFan50Btn.classList.add('active');
        } else if (speed === 100 && onoffFan100Btn) {
            onoffFan100Btn.classList.add('active');
        }
    }

    // On/Off fan controls (same as manual mode)
    if (onoffFanOffBtn) {
        onoffFanOffBtn.addEventListener('click', function () {
            setFanSpeed(0, onoffFanSpeedInput, onoffFanSpeedDisplay, 'onoffFanSliderFill');
            updateOnOffFanButtons(0);
        });
    }

    if (onoffFan50Btn) {
        onoffFan50Btn.addEventListener('click', function () {
            setFanSpeed(50, onoffFanSpeedInput, onoffFanSpeedDisplay, 'onoffFanSliderFill');
            updateOnOffFanButtons(50);
        });
    }

    if (onoffFan100Btn) {
        onoffFan100Btn.addEventListener('click', function () {
            setFanSpeed(100, onoffFanSpeedInput, onoffFanSpeedDisplay, 'onoffFanSliderFill');
            updateOnOffFanButtons(100);
        });
    }

    // Setup On/Off fan slider input handler
    if (onoffFanSpeedInput) {
        onoffFanSpeedInput.addEventListener('input', function () {
            var speed = parseInt(onoffFanSpeedInput.value, 10);
            // Only update text box if user is not typing in it
            if (onoffFanSpeedDisplay && document.activeElement !== onoffFanSpeedDisplay) {
                onoffFanSpeedDisplay.value = speed;
            }
            var fillElement = document.getElementById('onoffFanSliderFill');
            if (fillElement) {
                fillElement.style.setProperty('--fill-percent', speed + '%');
                fillElement.style.width = speed + '%';
            }
            // Update fan thumb icon
            var fanThumbIcon = document.getElementById('onoffFanThumbIcon');
            if (fanThumbIcon) {
                fanThumbIcon.style.left = speed + '%';
            }
            // Update tooltip position and text
            var fanTooltip = document.getElementById('onoffFanTooltip');
            if (fanTooltip && onoffFanSpeedInput) {
                fanTooltip.textContent = speed + '%';
                var rect = onoffFanSpeedInput.getBoundingClientRect();
                var percentage = speed / 100;
                var leftPos = percentage * rect.width;
                fanTooltip.style.left = leftPos + 'px';
                fanTooltip.style.transform = 'translateX(-50%)';
            }
            // Update button states
            updateOnOffFanButtons(speed);
        });

        onoffFanSpeedInput.addEventListener('change', async function () {
            var speed = parseInt(onoffFanSpeedInput.value, 10);
            speed = Math.max(0, Math.min(100, speed));
            if (onoffFanSpeedDisplay) onoffFanSpeedDisplay.value = speed;
            updateOnOffFanButtons(speed);
            markUserControlActivity();
            try {
                var result = await window.electronAPI.sendFanSpeed(speed);
                if (result && result.success) {
                    addToLog('On/Off: Fan speed set to ' + speed + '%');
                }
            } catch (error) {
                addToLog('Error setting fan speed: ' + error.message);
            }
        });
    }

    // Setup On/Off fan speed display input handler
    if (onoffFanSpeedDisplay) {
        // Note: We do NOT update slider/buttons while typing (no 'input' event)
        // Only update when user presses Enter or clicks outside (blur event)

        onoffFanSpeedDisplay.addEventListener('blur', async function () {
            var speed = parseInt(onoffFanSpeedDisplay.value, 10);
            if (isNaN(speed)) {
                if (onoffFanSpeedInput) {
                    onoffFanSpeedDisplay.value = parseInt(onoffFanSpeedInput.value, 10);
                }
            } else {
                speed = Math.max(0, Math.min(100, speed));
                onoffFanSpeedDisplay.value = speed;
                if (onoffFanSpeedInput) {
                    onoffFanSpeedInput.value = speed;
                    var fillElement = document.getElementById('onoffFanSliderFill');
                    if (fillElement) {
                        fillElement.style.setProperty('--fill-percent', speed + '%');
                        fillElement.style.width = speed + '%';
                    }
                }
                updateOnOffFanButtons(speed);
                markUserControlActivity();
                try {
                    var result = await window.electronAPI.sendFanSpeed(speed);
                    if (result && result.success) {
                        addToLog('On/Off: Fan speed set to ' + speed + '%');
                    }
                } catch (error) {
                    addToLog('Error setting fan speed: ' + error.message);
                }
            }
        });

        onoffFanSpeedDisplay.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.keyCode === 13) {
                event.preventDefault();
                onoffFanSpeedDisplay.blur();
            }
        });
    }

    // Helper function to set fan speed
    function setFanSpeed(speed, inputElement, displayElement, fillElementId) {
        markUserControlActivity();
        if (inputElement) inputElement.value = speed;
        if (displayElement) displayElement.value = speed;
        // Update slider fill
        if (fillElementId) {
            var fillElement = document.getElementById(fillElementId);
            if (fillElement) {
                fillElement.style.setProperty('--fill-percent', speed + '%');
                fillElement.style.width = speed + '%';
            }
        }
        // Update tooltip position for fan sliders
        if (inputElement) {
            var tooltipId = fillElementId.replace('SliderFill', 'Tooltip');
            var tooltip = document.getElementById(tooltipId);
            if (tooltip) {
                tooltip.textContent = speed + '%';
                var rect = inputElement.getBoundingClientRect();
                var percentage = speed / 100;
                var leftPos = percentage * rect.width;
                tooltip.style.left = leftPos + 'px';
                tooltip.style.transform = 'translateX(-50%)';
            }
        }
        // Send to hardware
        if (window.electronAPI && window.electronAPI.sendFanSpeed) {
            window.electronAPI.sendFanSpeed(speed).then(function (result) {
                if (result && result.success) {
                    addToLog('Fan speed set to ' + speed + '%');
                }
            }).catch(function (error) {
                addToLog('Error setting fan speed: ' + error.message);
            });
        }
    }

    // Setup PID mode controls
    // Initialize to manual mode
    switchControlMode('manual');

    // ============================================================================
    // MANUAL MODE: POWER CONTROL AND TEMPERATURE GAUGE
    // ============================================================================

    // Power control elements
    var powerSlider = document.getElementById('powerSlider');
    var powerSliderFill = document.getElementById('powerSliderFill');
    var powerTooltip = document.getElementById('powerTooltip');
    var powerOffBtn = document.getElementById('powerOff');
    var power50Btn = document.getElementById('power50');
    var power100Btn = document.getElementById('power100');

    // Function to map power percentage (0-100%) to heater temperature (20-70°C)
    function powerToHeaterTemp(powerPercent) {
        // Linear mapping: 0% = 20°C, 100% = 70°C
        return Math.round(20 + (powerPercent / 100) * (70 - 20));
    }

    // Function to update power slider fill
    function updatePowerSliderFill(powerPercent) {
        if (powerSliderFill) {
            powerSliderFill.style.setProperty('--fill-percent', powerPercent + '%');
            powerSliderFill.style.width = powerPercent + '%';
        }
        // Update tooltip position
        if (powerTooltip && powerSlider) {
            var rect = powerSlider.getBoundingClientRect();
            var percentage = powerPercent / 100;
            var leftPos = percentage * rect.width;
            powerTooltip.style.left = leftPos + 'px';
            powerTooltip.style.transform = 'translateX(-50%)';
        }
    }

    // Function to set power and send to hardware
    async function setPower(powerPercent) {
        markUserControlActivity();
        powerPercent = Math.max(0, Math.min(100, powerPercent));

        pendingPowerValue = powerPercent;
        if (pendingPowerTimeout) clearTimeout(pendingPowerTimeout);
        pendingPowerTimeout = setTimeout(function () { pendingPowerValue = null; }, 2500);

        // Update UI - slider, text box, and fill
        if (powerSlider) powerSlider.value = powerPercent;
        var powerDisplay = document.getElementById('powerDisplay');
        if (powerDisplay) powerDisplay.value = powerPercent;
        updatePowerSliderFill(powerPercent);

        // Update button states
        if (powerOffBtn) powerOffBtn.classList.remove('active');
        if (power50Btn) power50Btn.classList.remove('active');
        if (power100Btn) power100Btn.classList.remove('active');
        if (powerPercent === 0 && powerOffBtn) {
            powerOffBtn.classList.add('active');
        } else if (powerPercent === 50 && power50Btn) {
            power50Btn.classList.add('active');
        } else if (powerPercent === 100 && power100Btn) {
            power100Btn.classList.add('active');
        }

        // Map power to heater temperature (used for the radial heater)
        var heaterTemp = powerToHeaterTemp(powerPercent);

        // Send power percentage to hardware (JSON {"P": value}) if API is available
        try {
            if (window.electronAPI && window.electronAPI.sendPower) {
                var powerResult = await window.electronAPI.sendPower(powerPercent);
                if (powerResult && powerResult.success) {
                    addToLog('Manual: Power command sent to hardware: ' + powerPercent + '%');
                } else if (powerResult && powerResult.error) {
                    addToLog('Manual: Failed to send power command: ' + powerResult.error);
                }
            }

            // If power is 0%, turn heater off, otherwise turn on radial heater
            if (powerPercent === 0) {
                // Turn heater off
                var modeResult = await window.electronAPI.setHeaterMode(0);
                if (modeResult && modeResult.success) {
                    addToLog('Power set to 0% - Heater turned OFF');
                }
            } else {
                // Turn on radial heater and set temperature
                var modeResult = await window.electronAPI.setHeaterMode(1);
                if (modeResult && modeResult.success && window.electronAPI && window.electronAPI.sendHeaterTemp) {
                    var tempResult = await window.electronAPI.sendHeaterTemp(heaterTemp);
                    if (tempResult && tempResult.success) {
                        addToLog('Power set to ' + powerPercent + '% (Heater temp: ' + heaterTemp + '°C)');
                    }
                }
            }
        } catch (error) {
            addToLog('Error setting power: ' + error.message);
        }
    }

    // Power slider event handlers
    if (powerSlider) {
        powerSlider.addEventListener('input', function () {
            var power = parseInt(powerSlider.value, 10);
            pendingPowerValue = power;
            if (pendingPowerTimeout) clearTimeout(pendingPowerTimeout);
            pendingPowerTimeout = setTimeout(function () { pendingPowerValue = null; }, 2500);
            updatePowerSliderFill(power);
            // Update text box in real-time (but only if it's not currently being edited)
            var powerDisplay = document.getElementById('powerDisplay');
            if (powerDisplay && document.activeElement !== powerDisplay) {
                powerDisplay.value = power;
            }
            if (powerTooltip) {
                powerTooltip.textContent = power + '%';
            }
            // Update button states in real-time
            if (powerOffBtn) powerOffBtn.classList.remove('active');
            if (power50Btn) power50Btn.classList.remove('active');
            if (power100Btn) power100Btn.classList.remove('active');
            if (power === 0 && powerOffBtn) {
                powerOffBtn.classList.add('active');
            } else if (power === 50 && power50Btn) {
                power50Btn.classList.add('active');
            } else if (power === 100 && power100Btn) {
                power100Btn.classList.add('active');
            }
        });

        powerSlider.addEventListener('change', function () {
            var power = parseInt(powerSlider.value, 10);
            setPower(power);
        });

        powerSlider.addEventListener('mousemove', function (e) {
            if (powerTooltip) {
                var rect = powerSlider.getBoundingClientRect();
                var power = Math.round(((e.clientX - rect.left) / rect.width) * 100);
                power = Math.max(0, Math.min(100, power));
                powerTooltip.textContent = power + '%';
            }
        });
    }

    // Power text box event handlers
    var powerDisplay = document.getElementById('powerDisplay');
    if (powerDisplay) {
        // Note: We do NOT update slider/buttons while typing (no 'input' event)
        // Only update when user presses Enter or clicks outside (blur event)

        // Send to hardware when user clicks outside (blur)
        powerDisplay.addEventListener('blur', function () {
            var power = parseInt(powerDisplay.value, 10);
            if (isNaN(power)) {
                // If invalid, restore from slider
                if (powerSlider) {
                    powerDisplay.value = parseInt(powerSlider.value, 10);
                }
            } else {
                // Clamp and send
                power = Math.max(0, Math.min(100, power));
                powerDisplay.value = power;
                // Update slider and fill
                if (powerSlider) {
                    powerSlider.value = power;
                    updatePowerSliderFill(power);
                }
                // Update button states
                if (powerOffBtn) powerOffBtn.classList.remove('active');
                if (power50Btn) power50Btn.classList.remove('active');
                if (power100Btn) power100Btn.classList.remove('active');
                if (power === 0 && powerOffBtn) {
                    powerOffBtn.classList.add('active');
                } else if (power === 50 && power50Btn) {
                    power50Btn.classList.add('active');
                } else if (power === 100 && power100Btn) {
                    power100Btn.classList.add('active');
                }
                // Send to hardware
                setPower(power);
            }
        });

        // Send to hardware when user presses Enter
        powerDisplay.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.keyCode === 13) {
                event.preventDefault();
                powerDisplay.blur(); // Trigger blur event which handles validation and sending
            }
        });
    }


    // Power preset buttons
    if (powerOffBtn) {
        powerOffBtn.addEventListener('click', function () {
            powerOffBtn.classList.add('active');
            if (power50Btn) power50Btn.classList.remove('active');
            if (power100Btn) power100Btn.classList.remove('active');
            setPower(0);
        });
    }

    if (power50Btn) {
        power50Btn.addEventListener('click', function () {
            power50Btn.classList.add('active');
            if (powerOffBtn) powerOffBtn.classList.remove('active');
            if (power100Btn) power100Btn.classList.remove('active');
            setPower(50);
        });
    }

    if (power100Btn) {
        power100Btn.addEventListener('click', function () {
            power100Btn.classList.add('active');
            if (powerOffBtn) powerOffBtn.classList.remove('active');
            if (power50Btn) power50Btn.classList.remove('active');
            setPower(100);
        });
    }

    // ============================================================================
    // ON/OFF MODE: TARGET TEMPERATURE CONTROL
    // ============================================================================

    // Function to update On/Off target temperature slider fill
    function updateOnOffTargetSliderFill(tempVal) {
        var tMin = currentTempUnit === 'F' ? 68 : 20;
        var tMax = currentTempUnit === 'F' ? 158 : 70;
        if (onoffTargetSliderFill) {
            var percentage = ((tempVal - tMin) / (tMax - tMin)) * 100;
            onoffTargetSliderFill.style.setProperty('--fill-percent', percentage + '%');
            onoffTargetSliderFill.style.width = percentage + '%';
        }
        if (onoffTargetTooltip && onoffTargetSlider) {
            var rect = onoffTargetSlider.getBoundingClientRect();
            var pct = (tempVal - tMin) / (tMax - tMin);
            onoffTargetTooltip.style.left = (pct * rect.width) + 'px';
            onoffTargetTooltip.style.transform = 'translateX(-50%)';
        }
    }

    // Function to update button active states based on temperature value
    function updateOnOffTargetButtons(tempVal) {
        if (onoffTarget0Btn) onoffTarget0Btn.classList.remove('active');
        if (onoffTarget50Btn) onoffTarget50Btn.classList.remove('active');
        if (onoffTarget100Btn) onoffTarget100Btn.classList.remove('active');
        var b0 = currentTempUnit === 'F' ? 68 : 20;
        var b50 = currentTempUnit === 'F' ? 122 : 50;
        var b100 = currentTempUnit === 'F' ? 158 : 70;
        if (tempVal === b0 && onoffTarget0Btn) onoffTarget0Btn.classList.add('active');
        else if (tempVal === b50 && onoffTarget50Btn) onoffTarget50Btn.classList.add('active');
        else if (tempVal === b100 && onoffTarget100Btn) onoffTarget100Btn.classList.add('active');
    }

    // Function to set On/Off target temperature and send to hardware
    async function setOnOffTargetTemp(tempVal) {
        markUserControlActivity();
        var tMin = currentTempUnit === 'F' ? 68 : 20;
        var tMax = currentTempUnit === 'F' ? 158 : 70;
        var sym  = currentTempUnit === 'F' ? '°F' : '°C';
        tempVal = Math.max(tMin, Math.min(tMax, tempVal));
        onoffTargetTemp = tempVal;
        updateOnOffTargetSliderFill(tempVal);

        if (onoffTargetSlider) onoffTargetSlider.value = tempVal;
        if (onoffTargetDisplay) onoffTargetDisplay.value = tempVal;
        if (onoffTargetTooltip) onoffTargetTooltip.textContent = tempVal + sym;
        
        // Update button states based on the value
        updateOnOffTargetButtons(tempCelsius);

        // Send BOTH target temperature AND hysteresis to hardware when in On/Off mode
        // This ensures hardware always has both values together
        if (currentControlMode === 'onoff') {
            await sendOnOffTargetAndHysteresisToHardware();
        }
    }

    // On/Off Target Temperature slider event handlers
    if (onoffTargetSlider) {
        onoffTargetSlider.addEventListener('input', function () {
            var temp = parseInt(onoffTargetSlider.value, 10);
            onoffTargetTemp = temp;
            if (onoffTargetDisplay) onoffTargetDisplay.value = temp;
            updateOnOffTargetSliderFill(temp);
            if (onoffTargetTooltip) {
                onoffTargetTooltip.textContent = temp + (currentTempUnit === 'F' ? '°F' : '°C');
            }
            updateOnOffTargetButtons(temp);
        });

        onoffTargetSlider.addEventListener('change', function () {
            var temp = parseInt(onoffTargetSlider.value, 10);
            setOnOffTargetTemp(temp);
        });

        onoffTargetSlider.addEventListener('mousemove', function (e) {
            if (onoffTargetTooltip) {
                var tMin = currentTempUnit === 'F' ? 68 : 20;
                var tMax = currentTempUnit === 'F' ? 158 : 70;
                var rect = onoffTargetSlider.getBoundingClientRect();
                var percentage = (e.clientX - rect.left) / rect.width;
                var temp = Math.round(tMin + (percentage * (tMax - tMin)));
                temp = Math.max(tMin, Math.min(tMax, temp));
                onoffTargetTooltip.textContent = temp + (currentTempUnit === 'F' ? '°F' : '°C');
            }
        });
    }

    if (onoffTargetDisplay) {
        // Allow user to type freely - do NOT update anything while typing
        onoffTargetDisplay.addEventListener('input', function () {
            // Do nothing while user is typing
            // Slider and buttons will update only when user presses Enter or clicks outside
        });

        // When user clicks outside the box, validate and apply the value
        onoffTargetDisplay.addEventListener('blur', function () {
            var tMin = currentTempUnit === 'F' ? 68 : 20;
            var tMax = currentTempUnit === 'F' ? 158 : 70;
            var temp = parseInt(onoffTargetDisplay.value, 10);
            if (isNaN(temp)) {
                if (onoffTargetSlider) {
                    onoffTargetDisplay.value = parseInt(onoffTargetSlider.value, 10);
                }
            } else {
                temp = Math.max(tMin, Math.min(tMax, temp));
                onoffTargetDisplay.value = temp;
                if (onoffTargetSlider) {
                    onoffTargetSlider.value = temp;
                    updateOnOffTargetSliderFill(temp);
                }
                updateOnOffTargetButtons(temp);
                onoffTargetTemp = temp;
                setOnOffTargetTemp(temp);
            }
        });

        // When user presses Enter, apply the value
        onoffTargetDisplay.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.keyCode === 13) {
                event.preventDefault();
                onoffTargetDisplay.blur(); // Trigger blur to validate and apply
            }
        });
    }

    // On/Off Target Temperature preset buttons
    if (onoffTarget0Btn) {
        onoffTarget0Btn.addEventListener('click', function () {
            setOnOffTargetTemp(currentTempUnit === 'F' ? 68 : 20);
        });
    }

    if (onoffTarget50Btn) {
        onoffTarget50Btn.addEventListener('click', function () {
            setOnOffTargetTemp(currentTempUnit === 'F' ? 122 : 50);
        });
    }

    if (onoffTarget100Btn) {
        onoffTarget100Btn.addEventListener('click', function () {
            setOnOffTargetTemp(currentTempUnit === 'F' ? 158 : 70);
        });
    }

    // On/Off Hysteresis dropdown handler
    if (onoffHysteresis) {
        onoffHysteresis.addEventListener('change', async function () {
            var value = parseInt(onoffHysteresis.value, 10);
            onoffHysteresisValue = value;
            markUserControlActivity();

            // Send BOTH hysteresis AND target temperature to hardware when in On/Off mode
            // This ensures hardware always has both values together
            if (currentControlMode === 'onoff') {
                await sendOnOffTargetAndHysteresisToHardware();
            } else {
                // Just update the value, don't send to hardware
                addToLog('On/Off: Hysteresis set to ' + value + ' (will be sent when On/Off mode is active)');
            }
        });
    }

    // ============================================================================
    // PID MODE: TARGET TEMPERATURE CONTROL
    // ============================================================================

    // Function to update PID target temperature slider fill
    function updatePidTargetSliderFill(tempVal) {
        var tMin = currentTempUnit === 'F' ? 68 : 20;
        var tMax = currentTempUnit === 'F' ? 158 : 70;
        if (pidTargetSliderFill) {
            var percentage = ((tempVal - tMin) / (tMax - tMin)) * 100;
            pidTargetSliderFill.style.setProperty('--fill-percent', percentage + '%');
            pidTargetSliderFill.style.width = percentage + '%';
        }
        if (pidTargetTooltip && pidTargetSlider) {
            var rect = pidTargetSlider.getBoundingClientRect();
            var pct = (tempVal - tMin) / (tMax - tMin);
            pidTargetTooltip.style.left = (pct * rect.width) + 'px';
            pidTargetTooltip.style.transform = 'translateX(-50%)';
        }
    }

    // Function to update button active states based on temperature value
    function updatePidTargetButtons(tempVal) {
        if (pidTarget0Btn) pidTarget0Btn.classList.remove('active');
        if (pidTarget50Btn) pidTarget50Btn.classList.remove('active');
        if (pidTarget100Btn) pidTarget100Btn.classList.remove('active');
        var b0 = currentTempUnit === 'F' ? 68 : 20;
        var b50 = currentTempUnit === 'F' ? 122 : 50;
        var b100 = currentTempUnit === 'F' ? 158 : 70;
        if (tempVal === b0 && pidTarget0Btn) pidTarget0Btn.classList.add('active');
        else if (tempVal === b50 && pidTarget50Btn) pidTarget50Btn.classList.add('active');
        else if (tempVal === b100 && pidTarget100Btn) pidTarget100Btn.classList.add('active');
    }

    // Function to set PID target temperature and send to hardware
    async function setPidTargetTemp(tempVal) {
        markUserControlActivity();
        var tMin = currentTempUnit === 'F' ? 68 : 20;
        var tMax = currentTempUnit === 'F' ? 158 : 70;
        var sym  = currentTempUnit === 'F' ? '°F' : '°C';
        tempVal = Math.max(tMin, Math.min(tMax, tempVal));
        pidTargetTemp = tempVal;
        updatePidTargetSliderFill(tempVal);

        if (pidTargetSlider) pidTargetSlider.value = tempVal;
        if (pidTargetDisplay) pidTargetDisplay.value = tempVal;
        if (pidTargetTooltip) pidTargetTooltip.textContent = tempVal + sym;

        updatePidTargetButtons(tempVal);

        try {
            if (window.electronAPI && window.electronAPI.sendHeaterTemp) {
                var result = await window.electronAPI.sendHeaterTemp(tempVal);
                if (result && result.success) {
                    addToLog('PID: Target temperature sent to hardware: ' + tempVal + sym);
                } else if (result && result.error) {
                    addToLog('PID: Failed to send target temperature: ' + result.error);
                }
            }
        } catch (error) {
            addToLog('PID: Error sending target temperature: ' + error.message);
        }
    }

    // PID Target Temperature slider event handlers
    if (pidTargetSlider) {
        pidTargetSlider.addEventListener('input', function () {
            var temp = parseInt(pidTargetSlider.value, 10);
            pidTargetTemp = temp;
            if (pidTargetDisplay) pidTargetDisplay.value = temp;
            updatePidTargetSliderFill(temp);
            if (pidTargetTooltip) {
                pidTargetTooltip.textContent = temp + (currentTempUnit === 'F' ? '°F' : '°C');
            }
            updatePidTargetButtons(temp);
        });

        pidTargetSlider.addEventListener('change', function () {
            var temp = parseInt(pidTargetSlider.value, 10);
            setPidTargetTemp(temp);
        });

        pidTargetSlider.addEventListener('mousemove', function (e) {
            if (pidTargetTooltip) {
                var tMin = currentTempUnit === 'F' ? 68 : 20;
                var tMax = currentTempUnit === 'F' ? 158 : 70;
                var rect = pidTargetSlider.getBoundingClientRect();
                var percentage = (e.clientX - rect.left) / rect.width;
                var temp = Math.round(tMin + (percentage * (tMax - tMin)));
                temp = Math.max(tMin, Math.min(tMax, temp));
                pidTargetTooltip.textContent = temp + (currentTempUnit === 'F' ? '°F' : '°C');
            }
        });
    }

    // PID Target Temperature display input handler
    if (pidTargetDisplay) {
        // Allow user to type freely - do NOT update anything while typing
        pidTargetDisplay.addEventListener('input', function () {
            // Do nothing while user is typing
            // Slider and buttons will update only when user presses Enter or clicks outside
        });

        // When user clicks outside the box, validate and apply the value
        pidTargetDisplay.addEventListener('blur', function () {
            var tMin = currentTempUnit === 'F' ? 68 : 20;
            var tMax = currentTempUnit === 'F' ? 158 : 70;
            var temp = parseInt(pidTargetDisplay.value, 10);
            if (isNaN(temp)) {
                if (pidTargetSlider) {
                    pidTargetDisplay.value = parseInt(pidTargetSlider.value, 10);
                }
            } else {
                temp = Math.max(tMin, Math.min(tMax, temp));
                pidTargetDisplay.value = temp;
                if (pidTargetSlider) {
                    pidTargetSlider.value = temp;
                    updatePidTargetSliderFill(temp);
                }
                updatePidTargetButtons(temp);
                pidTargetTemp = temp;
                setPidTargetTemp(temp);
            }
        });

        // When user presses Enter, apply the value
        pidTargetDisplay.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.keyCode === 13) {
                event.preventDefault();
                pidTargetDisplay.blur(); // Trigger blur to validate and apply
            }
        });
    }

    // PID Target Temperature preset buttons
    if (pidTarget0Btn) {
        pidTarget0Btn.addEventListener('click', function () {
            setPidTargetTemp(currentTempUnit === 'F' ? 68 : 20);
        });
    }

    if (pidTarget50Btn) {
        pidTarget50Btn.addEventListener('click', function () {
            setPidTargetTemp(currentTempUnit === 'F' ? 122 : 50);
        });
    }

    if (pidTarget100Btn) {
        pidTarget100Btn.addEventListener('click', function () {
            setPidTargetTemp(currentTempUnit === 'F' ? 158 : 70);
        });

        // ============================================================================
        // PID CONTROL TYPE AND PARAMETERS EVENT LISTENERS
        // ============================================================================

        // PID Control Type dropdown change handler
        if (pidControlType) {
            pidControlType.addEventListener('change', async function () {
                markUserControlActivity();
                if (isSavingCsv) {
                    addToLog('CSV saving stopped because PID control type was changed.');
                    stopCsvSaving();
                }
                var newControlType = pidControlType.value;
                updatePIDInputsVisibility();
                
                // Set default values and send all three parameters (P, I, D) to hardware
                if (window.electronAPI && window.electronAPI.sendPIDValue) {
                    try {
                        var pValue, iValue, dValue;
                        var savedP = parseFloat(localStorage.getItem('pid-default-P')) || 3.162;
                        var savedI = parseFloat(localStorage.getItem('pid-default-I')) || 0.01;
                        var savedD = parseFloat(localStorage.getItem('pid-default-D')) || 150;

                        if (newControlType === 'P') {
                            pValue = savedP; iValue = 0; dValue = 0;
                        } else if (newControlType === 'PI') {
                            pValue = savedP; iValue = savedI; dValue = 0;
                        } else if (newControlType === 'PD') {
                            pValue = savedP; iValue = 0; dValue = savedD;
                        } else if (newControlType === 'PID') {
                            pValue = savedP; iValue = savedI; dValue = savedD;
                        }

                        // Update input boxes
                        if (pidPInput) pidPInput.value = pValue;
                        if (pidIInput) pidIInput.value = iValue;
                        if (pidDInput) pidDInput.value = dValue;

                        // Send all three values to hardware
                        var resultP = await window.electronAPI.sendPIDValue('P', pValue);
                        var resultI = await window.electronAPI.sendPIDValue('I', iValue);
                        var resultD = await window.electronAPI.sendPIDValue('D', dValue);

                        if (resultP && resultP.success && resultI && resultI.success && resultD && resultD.success) {
                            addToLog('PID Control Type: ' + newControlType + ' mode - P=' + pValue + ', I=' + iValue + ', D=' + dValue + ' sent to hardware');
                        } else {
                            addToLog('PID Control Type: ' + newControlType + ' mode - Error sending values to hardware');
                        }
                    } catch (error) {
                        addToLog('Error setting PID values for control type: ' + error.message);
                    }
                }
                
                // Clear and reinitialize graph when control type changes (only if in PID mode)
                if (currentControlMode === 'pid') {
                    // Check if control type actually changed
                    if (currentChartControlType !== newControlType) {
                        initChartForPID(newControlType);
                        addToLog('PID Control Type changed to: ' + newControlType + ' - Graph cleared and reinitialized');
                    }
                } else {
                    addToLog('PID Control Type changed to: ' + newControlType + ' (will apply when switching to PID mode)');
                }
            });
        }

        // Integral Windup toggle button handler (Error menu, visible in PID + PI mode only)
        if (integralWindupBtn) {
            integralWindupBtn.addEventListener('click', async function () {
                var value = integralWindupNextValue;
                integralWindupNextValue = (value === 1) ? 2 : 1;
                integralWindupBtn.textContent = 'Integral Windup ' + (value === 1 ? 'ENABLED' : 'DISABLED');
                try {
                    if (window.electronAPI && window.electronAPI.sendCustomJson) {
                        await window.electronAPI.sendCustomJson({ W: value }, 'Integral Windup W=' + value);
                        addToLog('Integral Windup: Sent {W: ' + value + '}');
                    } else {
                        addToLog('Integral Windup: {W: ' + value + '} (hardware not available)');
                    }
                } catch (error) {
                    addToLog('Integral Windup: Error sending W=' + value + ': ' + error.message);
                }
            });
        }

        // P value input change handler
        if (pidPInput) {
            pidPInput.addEventListener('change', async function () {
                var value = parseFloat(pidPInput.value);
                if (isNaN(value)) {
                    addToLog('PID P: Invalid value');
                    pidPInput.value = parseFloat(localStorage.getItem('pid-default-P')) || 3.162;
                    return;
                }

                if (window.electronAPI && window.electronAPI.sendPIDValue) {
                    markUserControlActivity();
                    try {
                        var result = await window.electronAPI.sendPIDValue('P', value);
                        if (result && result.success) {
                            addToLog('PID P value set to: ' + value);
                        } else {
                            addToLog('Failed to set PID P value: ' + (result && result.error ? result.error : 'Unknown error'));
                        }
                    } catch (error) {
                        addToLog('Error setting PID P value: ' + error.message);
                    }
                } else {
                    addToLog('PID P value set to: ' + value + ' (hardware communication not available)');
                }
            });

            pidPInput.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.keyCode === 13) {
                    event.preventDefault();
                    pidPInput.blur();
                }
            });
        }

        // I value input change handler
        if (pidIInput) {
            pidIInput.addEventListener('change', async function () {
                var value = parseFloat(pidIInput.value);
                if (isNaN(value)) {
                    addToLog('PID I: Invalid value');
                    pidIInput.value = parseFloat(localStorage.getItem('pid-default-I')) || 0.01;
                    return;
                }

                if (window.electronAPI && window.electronAPI.sendPIDValue) {
                    markUserControlActivity();
                    try {
                        var result = await window.electronAPI.sendPIDValue('I', value);
                        if (result && result.success) {
                            addToLog('PID I value set to: ' + value);
                        } else {
                            addToLog('Failed to set PID I value: ' + (result && result.error ? result.error : 'Unknown error'));
                        }
                    } catch (error) {
                        addToLog('Error setting PID I value: ' + error.message);
                    }
                } else {
                    addToLog('PID I value set to: ' + value + ' (hardware communication not available)');
                }
            });

            pidIInput.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.keyCode === 13) {
                    event.preventDefault();
                    pidIInput.blur();
                }
            });
        }

        // D value input change handler
        if (pidDInput) {
            pidDInput.addEventListener('change', async function () {
                var value = parseFloat(pidDInput.value);
                if (isNaN(value)) {
                    addToLog('PID D: Invalid value');
                    pidDInput.value = parseFloat(localStorage.getItem('pid-default-D')) || 150;
                    return;
                }

                if (window.electronAPI && window.electronAPI.sendPIDValue) {
                    markUserControlActivity();
                    try {
                        var result = await window.electronAPI.sendPIDValue('D', value);
                        if (result && result.success) {
                            addToLog('PID D value set to: ' + value);
                        } else {
                            addToLog('Failed to set PID D value: ' + (result && result.error ? result.error : 'Unknown error'));
                        }
                    } catch (error) {
                        addToLog('Error setting PID D value: ' + error.message);
                    }
                } else {
                    addToLog('PID D value set to: ' + value + ' (hardware communication not available)');
                }
            });

            pidDInput.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.keyCode === 13) {
                    event.preventDefault();
                    pidDInput.blur();
                }
            });
        }

        // Control Frequency input change handler
        if (pidFrequency) {
            pidFrequency.addEventListener('change', async function () {
                var value = parseFloat(pidFrequency.value);
                if (isNaN(value) || value < 0.2 || value > 1.2) {
                    addToLog('PID Frequency: Invalid value');
                    pidFrequency.value = 1.0;
                    return;
                }

                if (window.electronAPI && window.electronAPI.sendPIDFrequency) {
                    markUserControlActivity();
                    try {
                        var result = await window.electronAPI.sendPIDFrequency(value);
                        if (result && result.success) {
                            addToLog('PID Control Frequency set to: ' + value + ' Hz');
                        } else {
                            addToLog('Failed to set PID frequency: ' + (result && result.error ? result.error : 'Unknown error'));
                        }
                    } catch (error) {
                        addToLog('Error setting PID frequency: ' + error.message);
                    }
                } else {
                    addToLog('PID Control Frequency set to: ' + value + ' Hz (hardware communication not available)');
                }
            });

            pidFrequency.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.keyCode === 13) {
                    event.preventDefault();
                    pidFrequency.blur();
                }
            });
        }

        var pidResetBtn = document.getElementById('pidResetBtn');
        if (pidResetBtn) {
            pidResetBtn.addEventListener('click', async function () {
                var pValue = 3.162, iValue = 0.01, dValue = 150, frequencyValue = 1.0;
                if (pidPInput) pidPInput.value = pValue;
                if (pidIInput) pidIInput.value = iValue;
                if (pidDInput) pidDInput.value = dValue;
                if (pidFrequency) pidFrequency.value = String(frequencyValue);
                localStorage.setItem('pid-default-P', String(pValue));
                localStorage.setItem('pid-default-I', String(iValue));
                localStorage.setItem('pid-default-D', String(dValue));

                if (window.electronAPI && window.electronAPI.sendPIDValue) {
                    await window.electronAPI.sendPIDValue('P', pValue);
                    await window.electronAPI.sendPIDValue('I', iValue);
                    await window.electronAPI.sendPIDValue('D', dValue);
                    await window.electronAPI.sendPIDFrequency(frequencyValue);
                }
                addToLog('PID defaults restored and sent to hardware');
            });
        }

        // Initialize PID input visibility on page load
        updatePIDInputsVisibility();

    }

    // ============================================================================
    // PID MODE: POWER CONTROL AND FAN CONTROL
    // ============================================================================

    // Function to set PID power
    async function setPidPower(powerPercent) {
        powerPercent = Math.max(0, Math.min(100, powerPercent));

        var heaterTemp = powerToHeaterTemp(powerPercent);

        try {
            if (powerPercent === 0) {
                var modeResult = await window.electronAPI.setHeaterMode(0);
                if (modeResult && modeResult.success) {
                    addToLog('PID: Power set to 0% - Heater turned OFF');
                }
            } else {
                var modeResult = await window.electronAPI.setHeaterMode(2);
                if (modeResult && modeResult.success) {
                    var tempResult = await window.electronAPI.sendHeaterTemp(heaterTemp);
                    if (tempResult && tempResult.success) {
                        addToLog('PID: Power set to ' + powerPercent + '% (Heater temp: ' + heaterTemp + '°C)');
                    }
                }
            }
        } catch (error) {
            addToLog('Error setting PID power: ' + error.message);
        }
    }

    // PID Fan control - similar to On/Off fan control

    // Helper function to update PID fan button states
    function updatePidFanButtons(speed) {
        var pidFanOffBtn = document.getElementById('pidFanOff');
        var pidFan50Btn = document.getElementById('pidFan50');
        var pidFan100Btn = document.getElementById('pidFan100');
        
        if (pidFanOffBtn) pidFanOffBtn.classList.remove('active');
        if (pidFan50Btn) pidFan50Btn.classList.remove('active');
        if (pidFan100Btn) pidFan100Btn.classList.remove('active');
        
        if (speed === 0 && pidFanOffBtn) {
            pidFanOffBtn.classList.add('active');
        } else if (speed === 50 && pidFan50Btn) {
            pidFan50Btn.classList.add('active');
        } else if (speed === 100 && pidFan100Btn) {
            pidFan100Btn.classList.add('active');
        }
    }

    // Function to setup PID fan slider event handler (defined early so it can be called)
    function setupPidFanSliderHandler() {
        var slider = document.getElementById('pidFanSpeed');
        if (slider) {
            // Remove any existing listeners by cloning
            var newSlider = slider.cloneNode(true);
            slider.parentNode.replaceChild(newSlider, slider);
            slider = newSlider;
            
            // IMPORTANT: Update the global reference to point to the new slider
            pidFanSpeedInput = slider;

            slider.addEventListener('input', function (e) {
                var fan = parseInt(this.value, 10);
                console.log('PID Fan slider input event - value:', fan + '%');

                // Update display
                var display = document.getElementById('pidFanSpeedDisplay');
                if (display) display.value = fan;

                // Update fill bar - use !important to override any CSS
                var fillElement = document.getElementById('pidFanSliderFill');
                if (fillElement) {
                    // Set both CSS variable and direct width with !important
                    fillElement.style.setProperty('--fill-percent', fan + '%', 'important');
                    fillElement.style.setProperty('width', fan + '%', 'important');
                    console.log('Fill bar updated to:', fan + '%', 'Actual width:', fillElement.style.width, 'Computed width:', window.getComputedStyle(fillElement).width);
                } else {
                    console.error('pidFanSliderFill element not found!');
                }

                // Update tooltip
                var tooltip = document.getElementById('pidFanTooltip');
                if (tooltip) {
                    tooltip.textContent = fan + '%';
                    var rect = slider.getBoundingClientRect();
                    var percentage = fan / 100;
                    var leftPos = percentage * rect.width;
                    tooltip.style.left = leftPos + 'px';
                    tooltip.style.transform = 'translateX(-50%)';
                }

                // Update button states in real-time
                updatePidFanButtons(fan);
            });

            slider.addEventListener('change', function () {
                var fan = parseInt(this.value, 10);
                setPidFanSpeed(fan);
            });

            console.log('PID Fan slider event handler attached');
        } else {
            console.error('pidFanSpeed slider element not found!');
        }
    }

    // Function to update PID fan slider fill
    function updatePidFanSliderFill(fanPercent) {
        // Re-query the element to ensure we have the latest reference
        var fillElement = document.getElementById('pidFanSliderFill');
        if (fillElement) {
            // Use !important to override any CSS rules
            fillElement.style.setProperty('--fill-percent', fanPercent + '%', 'important');
            fillElement.style.setProperty('width', fanPercent + '%', 'important');
            console.log('updatePidFanSliderFill: Updated to', fanPercent + '%');
        } else {
            console.error('pidFanSliderFill element not found in updatePidFanSliderFill!');
        }

        // Also update the global reference if it exists
        if (pidFanSliderFill) {
            pidFanSliderFill.style.setProperty('--fill-percent', fanPercent + '%', 'important');
            pidFanSliderFill.style.setProperty('width', fanPercent + '%', 'important');
        }

        // Update tooltip position
        var tooltip = document.getElementById('pidFanTooltip');
        var slider = document.getElementById('pidFanSpeed');
        if (tooltip && slider) {
            var rect = slider.getBoundingClientRect();
            var percentage = fanPercent / 100;
            var leftPos = percentage * rect.width;
            tooltip.style.left = leftPos + 'px';
            tooltip.style.transform = 'translateX(-50%)';
        }
    }

    // Function to set PID fan speed
    async function setPidFanSpeed(fanPercent) {
        markUserControlActivity();
        console.log('setPidFanSpeed called with:', fanPercent);
        fanPercent = Math.max(0, Math.min(100, fanPercent));

        // Always re-query the slider to ensure we have the correct reference
        var slider = document.getElementById('pidFanSpeed');
        if (slider) {
            slider.value = fanPercent;
            console.log('Updated pidFanSpeed slider to:', fanPercent);
        } else {
            console.error('pidFanSpeed slider element not found!');
        }

        // Update the display text box
        var display = document.getElementById('pidFanSpeedDisplay');
        if (display) {
            display.value = fanPercent;
            console.log('Updated pidFanSpeedDisplay to:', fanPercent);
        } else {
            console.error('pidFanSpeedDisplay not found!');
        }

        updatePidFanSliderFill(fanPercent);
        
        // Update button states
        updatePidFanButtons(fanPercent);

        try {
            if (window.electronAPI && window.electronAPI.sendFanSpeed) {
                var result = await window.electronAPI.sendFanSpeed(fanPercent);
                if (result && result.success) {
                    addToLog('PID: Fan speed set to ' + fanPercent + '%');
                }
            } else {
                console.warn('electronAPI.sendFanSpeed not available');
                addToLog('PID: Fan speed set to ' + fanPercent + '% (simulation mode)');
            }
        } catch (error) {
            console.error('Error setting PID fan speed:', error);
            addToLog('Error setting PID fan speed: ' + error.message);
        }
    }

    // Setup the PID fan slider handler
    if (pidFanSpeedInput) {
        setupPidFanSliderHandler();
    } else {
        // Try again in DOMContentLoaded if element not found yet
        document.addEventListener('DOMContentLoaded', function () {
            setupPidFanSliderHandler();
        });
    }

    if (pidFanSpeedDisplay) {
        // Note: We do NOT update slider/buttons while typing (no 'input' event)
        // Only update when user presses Enter or clicks outside (blur event)

        pidFanSpeedDisplay.addEventListener('blur', function () {
            var fan = parseInt(pidFanSpeedDisplay.value, 10);
            var slider = document.getElementById('pidFanSpeed');
            
            if (isNaN(fan)) {
                // If invalid, reset to slider value
                if (slider) {
                    pidFanSpeedDisplay.value = parseInt(slider.value, 10);
                }
            } else {
                // Clamp to valid range (0-100%)
                fan = Math.max(0, Math.min(100, fan));
                pidFanSpeedDisplay.value = fan;
                
                // Update slider
                if (slider) {
                    slider.value = fan;
                    updatePidFanSliderFill(fan);
                }
                
                // Update button states and send to hardware
                setPidFanSpeed(fan);
            }
        });

        pidFanSpeedDisplay.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.keyCode === 13) {
                event.preventDefault();
                pidFanSpeedDisplay.blur();
            }
        });
    }

    // Function to setup PID fan buttons (can be called multiple times safely)
    function setupPidFanButtons() {
        // Re-query elements in case they weren't ready before
        var pidFanOffBtn = document.getElementById('pidFanOff');
        var pidFan50Btn = document.getElementById('pidFan50');
        var pidFan100Btn = document.getElementById('pidFan100');

        if (pidFanOffBtn) {
            // Remove old listener and add new one
            pidFanOffBtn.onclick = function () {
                console.log('PID Fan 0% button clicked');
                pidFanOffBtn.classList.add('active');
                if (pidFan50Btn) pidFan50Btn.classList.remove('active');
                if (pidFan100Btn) pidFan100Btn.classList.remove('active');
                setPidFanSpeed(0);
            };
        } else {
            console.error('pidFanOffBtn not found!');
        }

        if (pidFan50Btn) {
            pidFan50Btn.onclick = function () {
                console.log('PID Fan 50% button clicked');
                pidFan50Btn.classList.add('active');
                if (pidFanOffBtn) pidFanOffBtn.classList.remove('active');
                if (pidFan100Btn) pidFan100Btn.classList.remove('active');
                setPidFanSpeed(50);
            };
        } else {
            console.error('pidFan50Btn not found!');
        }

        if (pidFan100Btn) {
            pidFan100Btn.onclick = function () {
                console.log('PID Fan 100% button clicked');
                pidFan100Btn.classList.add('active');
                if (pidFanOffBtn) pidFanOffBtn.classList.remove('active');
                if (pidFan50Btn) pidFan50Btn.classList.remove('active');
                setPidFanSpeed(100);
            };
        } else {
            console.error('pidFan100Btn not found!');
        }
    }

    // PID Fan preset buttons - initial setup
    setupPidFanButtons();

    // Remove the automatic graph popup on chart click
    // Users can use a dedicated button instead
    const chartContainer = document.querySelector('.chart-container');
    if (chartContainer) {
        // Remove the click handler that was opening the graph window
        chartContainer.style.cursor = 'default';
        chartContainer.title = 'Chart - Use legend to hide/show data series';
    }

    // Add event listener for the "Print Graph" button (Time Chart)
    const printChartBtn = document.getElementById('printChartBtn');
    if (printChartBtn) {
        printChartBtn.addEventListener('click', function () {
            printBothCharts();
        });
    }

    // Helper function to prepare chart for printing (invert colors for visibility)
    function prepareChartForPrint(chart) {
        if (!chart || !chart.options) return null;

        // Store original colors
        var originalColors = {
            scales: {},
            datasets: []
        };

        // Store original scale colors
        if (chart.options.scales) {
            if (chart.options.scales.x) {
                originalColors.scales.x = {
                    grid: chart.options.scales.x.grid ? chart.options.scales.x.grid.color : null,
                    ticks: chart.options.scales.x.ticks ? chart.options.scales.x.ticks.color : null,
                    title: chart.options.scales.x.title ? chart.options.scales.x.title.color : null
                };
                if (chart.options.scales.x.grid) chart.options.scales.x.grid.color = '#000000';
                if (chart.options.scales.x.ticks) chart.options.scales.x.ticks.color = '#000000';
                if (chart.options.scales.x.title) chart.options.scales.x.title.color = '#000000';
            }
            if (chart.options.scales.y) {
                originalColors.scales.y = {
                    grid: chart.options.scales.y.grid ? chart.options.scales.y.grid.color : null,
                    ticks: chart.options.scales.y.ticks ? chart.options.scales.y.ticks.color : null,
                    title: chart.options.scales.y.title ? chart.options.scales.y.title.color : null
                };
                if (chart.options.scales.y.grid) chart.options.scales.y.grid.color = '#000000';
                if (chart.options.scales.y.ticks) chart.options.scales.y.ticks.color = '#000000';
                if (chart.options.scales.y.title) chart.options.scales.y.title.color = '#000000';
            }
            if (chart.options.scales.y2) {
                originalColors.scales.y2 = {
                    grid: chart.options.scales.y2.grid ? chart.options.scales.y2.grid.color : null,
                    ticks: chart.options.scales.y2.ticks ? chart.options.scales.y2.ticks.color : null,
                    title: chart.options.scales.y2.title ? chart.options.scales.y2.title.color : null
                };
                if (chart.options.scales.y2.grid) chart.options.scales.y2.grid.color = '#000000';
                if (chart.options.scales.y2.ticks) chart.options.scales.y2.ticks.color = '#000000';
                if (chart.options.scales.y2.title) chart.options.scales.y2.title.color = '#000000';
            }
        }

        // Store and change dataset colors (especially Power line to black)
        if (chart.data && chart.data.datasets) {
            for (var i = 0; i < chart.data.datasets.length; i++) {
                originalColors.datasets[i] = {
                    borderColor: chart.data.datasets[i].borderColor,
                    backgroundColor: chart.data.datasets[i].backgroundColor
                };
                // Power line (index 10) is already red, no need to change
            }
        }

        // Store and change legend colors
        if (chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.labels) {
            originalColors.legend = chart.options.plugins.legend.labels.color;
            chart.options.plugins.legend.labels.color = '#000000';
        }

        return originalColors;
    }

    // Helper function to restore chart colors after printing
    function restoreChartColors(chart, originalColors) {
        if (!chart || !originalColors) return;

        // Restore scale colors
        if (originalColors.scales && chart.options.scales) {
            if (originalColors.scales.x && chart.options.scales.x) {
                if (chart.options.scales.x.grid) chart.options.scales.x.grid.color = originalColors.scales.x.grid;
                if (chart.options.scales.x.ticks) chart.options.scales.x.ticks.color = originalColors.scales.x.ticks;
                if (chart.options.scales.x.title) chart.options.scales.x.title.color = originalColors.scales.x.title;
            }
            if (originalColors.scales.y && chart.options.scales.y) {
                if (chart.options.scales.y.grid) chart.options.scales.y.grid.color = originalColors.scales.y.grid;
                if (chart.options.scales.y.ticks) chart.options.scales.y.ticks.color = originalColors.scales.y.ticks;
                if (chart.options.scales.y.title) chart.options.scales.y.title.color = originalColors.scales.y.title;
            }
            if (originalColors.scales.y2 && chart.options.scales.y2) {
                if (chart.options.scales.y2.grid) chart.options.scales.y2.grid.color = originalColors.scales.y2.grid;
                if (chart.options.scales.y2.ticks) chart.options.scales.y2.ticks.color = originalColors.scales.y2.ticks;
                if (chart.options.scales.y2.title) chart.options.scales.y2.title.color = originalColors.scales.y2.title;
            }
        }

        // Restore dataset colors
        if (originalColors.datasets && chart.data && chart.data.datasets) {
            for (var i = 0; i < originalColors.datasets.length && i < chart.data.datasets.length; i++) {
                if (originalColors.datasets[i]) {
                    chart.data.datasets[i].borderColor = originalColors.datasets[i].borderColor;
                    chart.data.datasets[i].backgroundColor = originalColors.datasets[i].backgroundColor;
                }
            }
        }

        // Restore legend colors
        if (originalColors.legend && chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.labels) {
            chart.options.plugins.legend.labels.color = originalColors.legend;
        }
    }

    // Function to print the Time chart
    function printChart() {
        // Try to initialize chart if it doesn't exist
        if (!window.liveChartRef) {
            // Try to initialize the live chart
            try {
                var testCanvas = document.getElementById('testChartPrimary');
                if (testCanvas && window.Chart) {
                    var ctx = testCanvas.getContext('2d');
                    var themeColors = getChartThemeColors();
                    testCanvas.style.background = themeColors.background;
                    testCanvas.style.borderColor = themeColors.border;
                    var colors = ['#ff4d4f', '#40a9ff', '#73d13d', '#fa8c16', '#b37feb', '#36cfc9', '#f759ab', '#9254de', '#faad14', '#1f7a8c', '#ff0000', '#ff007a'];
                    var labels = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'Radial Heater', 'Linear Heater', 'Power', 'Target'];
                    var ds = [];
                    for (var i = 0; i < 12; i++) {
                        ds.push({ label: labels[i], data: [], borderColor: colors[i], backgroundColor: colors[i], pointRadius: 0, borderWidth: 2, tension: 0.2, yAxisID: i === 10 ? 'y2' : 'y' });
                    }
                    window.liveChartRef = new Chart(ctx, {
                        type: 'line',
                        data: { labels: [], datasets: ds },
                        options: {
                            responsive: true,
                            animation: false,
                            interaction: { mode: 'nearest', intersect: false },
                            plugins: { legend: { position: 'right', labels: { color: themeColors.text } } },
                            scales: {
                                x: {
                                    grid: { color: themeColors.grid },
                                    ticks: { 
                                        color: themeColors.text,
                                        autoSkip: true,          // automatically skip labels
                                        maxTicksLimit: 10        // show at most 10 time labels
                                    }
                                },
                                y: {
                                    type: 'linear',
                                    position: 'left',
                                    title: { display: true, text: 'Temperature (' + (currentTempUnit === 'F' ? '°F' : '°C') + ')', color: themeColors.text },
                                    grid: { color: themeColors.grid },
                                    ticks: {
                                        color: themeColors.text,
                                        callback: function(value) {
                                            return Math.round(value) + (currentTempUnit === 'F' ? '°F' : '°C');
                                        }
                                    }
                                },
                                y2: {
                                    type: 'linear',
                                    position: 'right',
                                    grid: { drawOnChartArea: false, color: themeColors.grid },
                                    title: { display: true, text: 'Power (W)', color: themeColors.text },
                                    ticks: { 
                                        color: themeColors.text,
                                        callback: function(value) {
                                            return Math.round(value);
                                        }
                                    }
                                }
                            }
                        }
                    });
                }
            } catch (e) {
                console.error('Error initializing chart:', e);
            }
        }

        // Check if chart exists after trying to initialize
        var chart = null;
        var canvas = null;

        if (window.liveChartRef && window.liveChartRef.canvas) {
            chart = window.liveChartRef;
            canvas = chart.canvas;
        } else if (chartJsRef && chartJsRef.canvas) {
            // Fallback: try to use chartJsRef if available
            chart = chartJsRef;
            canvas = chart.canvas;
        } else {
            alert('Chart is not initialized yet. Please wait for the chart to load or refresh the page.');
            return;
        }

        if (!canvas) {
            alert('Chart canvas not found!');
            return;
        }

        // Check if chart has any data
        var hasData = false;
        if (chart.data && chart.data.datasets) {
            for (var i = 0; i < chart.data.datasets.length; i++) {
                if (chart.data.datasets[i].data && chart.data.datasets[i].data.length > 0) {
                    hasData = true;
                    break;
                }
            }
        }

        if (!hasData) {
            alert('Chart has no data to print! Please make sure data is being received.');
            return;
        }

        // Prepare chart for printing (invert colors)
        var originalColors = prepareChartForPrint(chart);

        // Force chart to resize and update to ensure it's fully rendered
        chart.resize();
        chart.update('none');

        // Wait for chart to fully render, then export
        setTimeout(function () {
            try {
                // Check if canvas has content
                if (canvas.width === 0 || canvas.height === 0) {
                    restoreChartColors(chart, originalColors);
                    chart.update('none');
                    alert('Chart canvas is empty. Please wait for data to load.');
                    return;
                }

                // Convert canvas to image - use higher quality
                var imageData = canvas.toDataURL('image/png', 1.0);

                // Restore original colors immediately after export
                restoreChartColors(chart, originalColors);
                chart.update('none');

                // Check if we got valid image data
                if (!imageData || imageData === 'data:,' || imageData.length < 100) {
                    alert('Chart export failed. Please try again.');
                    console.error('Image data length:', imageData ? imageData.length : 0);
                    return;
                }

                // Print directly using hidden iframe - completely invisible
                var iframe = document.createElement('iframe');
                iframe.style.position = 'fixed';
                iframe.style.left = '-9999px';
                iframe.style.top = '-9999px';
                iframe.style.width = '0';
                iframe.style.height = '0';
                iframe.style.border = 'none';
                iframe.style.visibility = 'hidden';
                iframe.style.display = 'none';
                document.body.appendChild(iframe);

                var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                iframeDoc.open();
                iframeDoc.write('<!DOCTYPE html><html><head><title>Print Chart</title>');
                iframeDoc.write('<meta http-equiv="Content-Security-Policy" content="img-src data: \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\' \'unsafe-inline\'; default-src \'self\' data:;">');
                iframeDoc.write('<style>');
                iframeDoc.write('body { margin: 0; padding: 20px; text-align: center; }');
                iframeDoc.write('img { max-width: 100%; height: auto; display: block; margin: 0 auto; }');
                iframeDoc.write('h2 { font-family: Arial, sans-serif; color: #333; }');
                iframeDoc.write('@media print { body { margin: 0; padding: 0; } }');
                iframeDoc.write('</style>');
                iframeDoc.write('</head><body>');
                iframeDoc.write('<h2>Device Data Chart - Temperature vs Time</h2>');
                iframeDoc.write('<img src="' + imageData + '" id="chartImage" />');
                iframeDoc.write('</body></html>');
                iframeDoc.close();

                // Wait for image to load before printing
                setTimeout(function () {
                    var img = iframeDoc.getElementById('chartImage');
                    if (img && img.complete) {
                        iframe.contentWindow.focus();
                        iframe.contentWindow.print();
                        setTimeout(function () {
                            if (iframe.parentNode) {
                                document.body.removeChild(iframe);
                            }
                        }, 500);
                    } else if (img) {
                        img.onload = function () {
                            iframe.contentWindow.focus();
                            iframe.contentWindow.print();
                            setTimeout(function () {
                                if (iframe.parentNode) {
                                    document.body.removeChild(iframe);
                                }
                            }, 500);
                        };
                    }
                }, 100);
            } catch (error) {
                alert('Error printing chart: ' + error.message);
                console.error('Print error:', error);
            }
        }, 500);
    }

    // Function to print both charts together on separate pages
    function printBothCharts() {
        var primaryChart = chartJsRef;
        var secondaryChart = window.liveChartRef;

        if (!primaryChart || !primaryChart.canvas) {
            alert('Primary chart is not initialized yet. Please wait for the chart to load.');
            return;
        }
        if (!secondaryChart || !secondaryChart.canvas) {
            alert('Secondary chart is not initialized yet. Please wait for the chart to load.');
            return;
        }

        // Verify at least one dataset has data
        var hasData = false;
        if (primaryChart.data && primaryChart.data.datasets) {
            for (var i = 0; i < primaryChart.data.datasets.length; i++) {
                if (primaryChart.data.datasets[i].data && primaryChart.data.datasets[i].data.length > 0) {
                    hasData = true;
                    break;
                }
            }
        }
        if (!hasData) {
            alert('Chart has no data to print! Please make sure data is being received.');
            return;
        }

        // Prepare both charts for print (invert colors to black for visibility)
        var primaryOriginalColors = prepareChartForPrint(primaryChart);
        primaryChart.update('none');
        var secondaryOriginalColors = prepareChartForPrint(secondaryChart);
        secondaryChart.update('none');

        setTimeout(function () {
            try {
                var primaryCanvas = primaryChart.canvas;
                var secondaryCanvas = secondaryChart.canvas;

                var primaryImageData = (primaryCanvas && primaryCanvas.width > 0 && primaryCanvas.height > 0)
                    ? primaryCanvas.toDataURL('image/png', 1.0) : null;
                var secondaryImageData = (secondaryCanvas && secondaryCanvas.width > 0 && secondaryCanvas.height > 0)
                    ? secondaryCanvas.toDataURL('image/png', 1.0) : null;

                // Restore chart colors immediately after capture
                if (primaryOriginalColors) { restoreChartColors(primaryChart, primaryOriginalColors); primaryChart.update('none'); }
                if (secondaryOriginalColors) { restoreChartColors(secondaryChart, secondaryOriginalColors); secondaryChart.update('none'); }

                if (!primaryImageData || primaryImageData.length < 100) {
                    alert('Could not capture primary chart image.');
                    return;
                }
                if (!secondaryImageData || secondaryImageData.length < 100) {
                    alert('Could not capture secondary chart image.');
                    return;
                }

                var iframe = document.createElement('iframe');
                iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;border:none;visibility:hidden;display:none;';
                document.body.appendChild(iframe);

                var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                iframeDoc.open();
                iframeDoc.write('<!DOCTYPE html><html><head><title>Print Charts</title>');
                iframeDoc.write('<meta http-equiv="Content-Security-Policy" content="img-src data: \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\' \'unsafe-inline\'; default-src \'self\' data:;">');
                iframeDoc.write('<style>');
                iframeDoc.write('* { box-sizing: border-box; }');
                iframeDoc.write('body { margin: 0; padding: 0; background: white; font-family: Arial, sans-serif; }');
                iframeDoc.write('.chart-page { width: 100%; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 20px; background: white; break-after: page; page-break-after: always; page-break-inside: avoid; }');
                iframeDoc.write('.chart-page.last { break-after: auto; page-break-after: auto; }');
                iframeDoc.write('h2 { color: #333; margin: 0 0 16px 0; font-size: 16px; text-align: center; }');
                iframeDoc.write('img { max-width: 95%; height: auto; display: block; margin: 0 auto; }');
                iframeDoc.write('@media print {');
                iframeDoc.write('  body { background: white !important; }');
                iframeDoc.write('  .chart-page { background: white !important; break-after: page; page-break-after: always; page-break-inside: avoid; }');
                iframeDoc.write('  .chart-page.last { break-after: auto; page-break-after: auto; }');
                iframeDoc.write('}');
                iframeDoc.write('</style></head><body>');

                iframeDoc.write('<div class="chart-page">');
                iframeDoc.write('<h2>Device Data Chart — Temperature vs Time</h2>');
                iframeDoc.write('<img id="img1" src="' + primaryImageData + '" />');
                iframeDoc.write('</div>');

                iframeDoc.write('<div class="chart-page last">');
                iframeDoc.write('<h2>Multi-Variable Analysis</h2>');
                iframeDoc.write('<img id="img2" src="' + secondaryImageData + '" />');
                iframeDoc.write('</div>');

                iframeDoc.write('<script>');
                iframeDoc.write('var loaded = 0;');
                iframeDoc.write('function tryPrint() { if (++loaded >= 2) { window.focus(); setTimeout(function(){ window.print(); }, 200); } }');
                iframeDoc.write('var img1 = document.getElementById("img1");');
                iframeDoc.write('var img2 = document.getElementById("img2");');
                iframeDoc.write('img1.onload = tryPrint;');
                iframeDoc.write('img2.onload = tryPrint;');
                iframeDoc.write('if (img1.complete) tryPrint();');
                iframeDoc.write('if (img2.complete) tryPrint();');
                iframeDoc.write('<\/script>');
                iframeDoc.write('</body></html>');
                iframeDoc.close();

                setTimeout(function () {
                    document.body.removeChild(iframe);
                }, 3000);
            } catch (error) {
                alert('Error printing charts: ' + error.message);
                console.error('Print error:', error);
            }
        }, 500);
    }

    // Add keyboard shortcut Ctrl+P to print both charts
    document.addEventListener('keydown', function (event) {
        // Check if Ctrl+P is pressed (or Cmd+P on Mac)
        if ((event.ctrlKey || event.metaKey) && event.key === 'p') {
            // Prevent the default browser print behavior
            event.preventDefault();

            // Print both charts
            printBothCharts();
        }
    });

    // Initialize main PID inputs from saved defaults so they show correct values before any mode switch
    try {
        var _pidPEl = document.getElementById('pidPInput');
        var _pidIEl = document.getElementById('pidIInput');
        var _pidDEl = document.getElementById('pidDInput');
        if (_pidPEl) _pidPEl.value = parseFloat(localStorage.getItem('pid-default-P')) || 3.162;
        if (_pidIEl) _pidIEl.value = parseFloat(localStorage.getItem('pid-default-I')) || 0.01;
        if (_pidDEl) _pidDEl.value = parseFloat(localStorage.getItem('pid-default-D')) || 150;
    } catch (e) { /* ignore */ }

    // Apply saved theme/layout
    try {
        var savedLayout = localStorage.getItem('appLayout') || 'standard';
        var savedTheme = localStorage.getItem('matrix-theme') || 'dark';
        applyTheme(savedTheme);
        applyLayout(savedLayout);
        var themeSel = document.getElementById('theme-select');
        if (themeSel) {
            themeSel.value = savedTheme;
            themeSel.addEventListener('change', function () {
                applyTheme(themeSel.value);
                localStorage.setItem('matrix-theme', themeSel.value);
            });
        }
        var layoutSel = document.getElementById('layoutSelect');
        if (layoutSel) layoutSel.addEventListener('change', function () { applyLayout(layoutSel.value); localStorage.setItem('appLayout', layoutSel.value); });
    } catch (e) { /* ignore */ }

    // Simulation and Curriculum buttons removed - functionality no longer available

    // Helper function to open curriculum window
    function openCurriculumWindow() {
        // Open Curriculum menu window
        curriculumWindow = window.open('curriculum.html', 'curriculumWindow', 'width=1100,height=900,resizable=yes,scrollbars=yes');
        if (curriculumWindow) {
            curriculumWindow.focus();
            // Track when window is closed
            var checkClosed = setInterval(function () {
                if (curriculumWindow.closed) {
                    clearInterval(checkClosed);
                    curriculumWindow = null;
                }
            }, 500);
            addToLog('Process Control Temperature Curriculum opened.');
        }
    }

    // Comprehensive window resize handler to fix layout issues
    function handleWindowResize() {
        // Resize all charts
        if (chartJsRef && chartJsRef.canvas && chartJsRef.canvas.isConnected) {
            try { chartJsRef.resize(); } catch (e) { /* ignore resize errors */ }
        }
        if (window.liveChartRef && window.liveChartRef.canvas && window.liveChartRef.canvas.isConnected) {
            try { window.liveChartRef.resize(); } catch (e) { /* ignore resize errors */ }
        }

        // Ensure container doesn't overflow
        var container = document.querySelector('.container');
        if (container) {
            container.style.maxWidth = '100%';
        }

        // Ensure header doesn't overflow
        var headerContainer = document.querySelector('.header-container');
        if (headerContainer) {
            headerContainer.style.overflowX = 'hidden';
        }

        // Ensure controls layout doesn't overflow
        var controlsLayout = document.querySelector('.controls-layout');
        if (controlsLayout) {
            controlsLayout.style.overflowX = 'hidden';
        }
    }

    // syncPrintButtonSizes function removed - no longer needed

    // Add resize event listener with debouncing for better performance
    var resizeTimeout;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(function () {
            handleWindowResize();
        }, 100);
    });

    // Call once on load to ensure initial layout is correct
    handleWindowResize();
});
// Fan speed UI events
if (fanSpeedInput) {
    function updateSliderFill(value) {
        var percentage = parseInt(value, 10);
        var fillElement = document.getElementById('fanSliderFill');
        if (fillElement) {
            // Simple fill calculation - just use the percentage directly
            fillElement.style.setProperty('--fill-percent', percentage + '%');
            fillElement.style.width = percentage + '%';
        }
    }

    function updateFanIcon(value) {
        // Fan emoji removed - no animation needed
    }

    function updateFanTextIcon(value) {
        var percentage = parseInt(value, 10);

        if (fanTextIcon && fanTextPercentage) {
            // Update the percentage text
            if (fanTextPercentage) fanTextPercentage.textContent = percentage + '%';

            // Control the fan icon animation based on speed
            if (percentage === 0) {
                // Stop animation and reset rotation when speed is 0
                fanTextIcon.style.animation = 'none';
                fanTextIcon.style.transform = 'rotate(0deg)';
            } else {
                // Start continuous spinning animation
                // Faster speed = faster animation (shorter duration)
                var animationDuration = 3 - (percentage / 100) * 2; // 3s at 0% to 1s at 100%
                fanTextIcon.style.animation = 'fanTextSpin ' + animationDuration + 's linear infinite';
            }
        }
    }

    fanSpeedInput.addEventListener('input', function () {
        var percentage = parseInt(fanSpeedInput.value, 10);
        pendingFanValue = percentage;
        if (pendingFanTimeout) clearTimeout(pendingFanTimeout);
        pendingFanTimeout = setTimeout(function () { pendingFanValue = null; }, 2500);
        // Only update text box if it's not currently being edited (not focused)
        if (fanSpeedDisplay && document.activeElement !== fanSpeedDisplay) {
            fanSpeedDisplay.value = percentage;
        }
        updateSliderFill(fanSpeedInput.value);
        updateFanIcon(fanSpeedInput.value);
        // Update button states in real-time
        updateFanButtons(percentage);
        // Update tooltip position
        if (fanTooltip) {
            fanTooltip.textContent = percentage + '%';
            var rect = fanSpeedInput.getBoundingClientRect();
            var percent = percentage / 100;
            var leftPos = percent * rect.width;
            fanTooltip.style.left = leftPos + 'px';
            fanTooltip.style.transform = 'translateX(-50%)';
        }
    });

    // Handle user typing in fan speed input field
    if (fanSpeedDisplay) {
        // Note: We do NOT update slider/buttons while typing (no 'input' event)
        // Only update when user presses Enter or clicks outside (blur event)
        
        // Function to validate and send fan speed data
        async function validateAndSendFanSpeed() {
            var value = parseInt(fanSpeedDisplay.value, 10);
            if (isNaN(value)) {
                // Reset to current slider value if invalid
                if (fanSpeedInput) {
                    fanSpeedDisplay.value = parseInt(fanSpeedInput.value, 10);
                }
            } else {
                // Clamp value to valid range
                value = Math.max(0, Math.min(100, value));
                fanSpeedDisplay.value = value;
                markUserControlActivity();
                // Update slider and send to hardware
                if (fanSpeedInput) {
                    fanSpeedInput.value = value;
                    updateSliderFill(value);
                    updateFanIcon(value);
                    updateFanButtons(value);
                    // Send to hardware
                    try {
                        var result = await window.electronAPI.sendFanSpeed(value);
                        if (!result || !result.success) {
                            addToLog('Failed to send fan speed: ' + (result && result.error ? result.error : 'Unknown error'));
                        }
                    } catch (error) {
                        addToLog('Error sending fan speed: ' + error.message);
                    }
                }
            }
        }

        // Send data when user clicks outside (blur)
        fanSpeedDisplay.addEventListener('blur', validateAndSendFanSpeed);

        // Send data when user presses Enter
        fanSpeedDisplay.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.keyCode === 13) {
                event.preventDefault();
                validateAndSendFanSpeed();
                fanSpeedDisplay.blur(); // Remove focus after sending
            }
        });
    }

    // Fan slider hover tooltip
    fanSpeedInput.addEventListener('mousemove', function (e) {
        if (fanTooltip) {
            var rect = fanSpeedInput.getBoundingClientRect();
            var percentage = Math.round(((e.clientX - rect.left) / rect.width) * 100);
            percentage = Math.max(0, Math.min(100, percentage));
            fanTooltip.textContent = percentage + '%';
            fanTooltip.style.left = e.clientX - rect.left + 'px';
        }
    });

    fanSpeedInput.addEventListener('change', async function () {
        try {
            var v = parseInt(fanSpeedInput.value, 10);
            markUserControlActivity();
            pendingFanValue = v;
            if (pendingFanTimeout) clearTimeout(pendingFanTimeout);
            pendingFanTimeout = setTimeout(function () { pendingFanValue = null; }, 2500);
            // Update button states when slider changes
            updateFanButtons(v);
            var result = await window.electronAPI.sendFanSpeed(v);
            if (!result || !result.success) {
                addToLog('Failed to send fan speed: ' + (result && result.error ? result.error : 'Unknown error'));
            } else {
                addToLog('Fan speed sent: ' + v);
            }
        } catch (e) {
            addToLog('Error sending fan speed: ' + e.message);
        }
    });

    // Initialize slider fill and fan icons
    updateSliderFill(fanSpeedInput.value);
    updateFanIcon(fanSpeedInput.value);
    if (fanSpeedDisplay) fanSpeedDisplay.value = parseInt(fanSpeedInput.value, 10);
    // Initialize button states
    var initialSpeed = parseInt(fanSpeedInput.value, 10);
    updateFanButtons(initialSpeed);
}

// Heater controls
if (heaterTempInput && heaterTempValue) {
    function updateHeaterSliderFill(value) {
        var temp = parseInt(value, 10);
        // Convert temperature range (20-70) to percentage (0-100)
        var tempPercentage = ((temp - 20) / (70 - 20)) * 100;
        var fillElement = document.getElementById('heaterSliderFill');
        if (fillElement) {
            fillElement.style.setProperty('--fill-percent', tempPercentage + '%');
            fillElement.style.width = tempPercentage + '%';
        }
    }

    function updateHeaterIcon(value) {
        var temp = parseInt(value, 10);
        var heaterIcon = document.getElementById('heaterThumbIcon');
        var sliderWrapper = document.querySelector('.heater-slider-wrapper');

        if (heaterIcon && sliderWrapper) {
            // Calculate position of the heater icon based on slider value
            var sliderWidth = sliderWrapper.offsetWidth;
            var thumbWidth = 24; // Same as thumb size
            var thumbRadius = thumbWidth / 2; // Half the thumb width for centering

            // Calculate the center position of the thumb
            var maxPosition = sliderWidth - thumbWidth;
            var tempPercentage = ((temp - 20) / (70 - 20)) * 100;
            var thumbCenterPosition = (tempPercentage / 100) * maxPosition + thumbRadius;

            // Position the heater icon at the center of the thumb
            heaterIcon.style.left = thumbCenterPosition + 'px';
        }
    }

    heaterTempInput.addEventListener('input', function () {
        var temp = parseInt(heaterTempInput.value, 10);
        if (heaterTempValue) heaterTempValue.value = temp;
        updateHeaterSliderFill(heaterTempInput.value);
        updateHeaterIcon(heaterTempInput.value);
    });

    // Handle user typing in heater temperature input field
    if (heaterTempValue) {
        // Function to validate and send heater temperature data
        async function validateAndSendHeaterTemp() {
            var value = parseInt(heaterTempValue.value, 10);
            if (isNaN(value)) {
                // Reset to current slider value if invalid
                if (heaterTempInput) {
                    heaterTempValue.value = parseInt(heaterTempInput.value, 10);
                }
            } else {
                // Clamp value to valid range
                value = Math.max(20, Math.min(70, value));
                heaterTempValue.value = value;
                markUserControlActivity();
                // Update slider and send to hardware
                if (heaterTempInput) {
                    heaterTempInput.value = value;
                    updateHeaterSliderFill(value);
                    updateHeaterIcon(value);
                    // Send to hardware
                    try {
                        var result = await window.electronAPI.sendHeaterTemp(value);
                        if (!result || !result.success) {
                            addToLog('Failed to send heater temp: ' + (result && result.error ? result.error : 'Unknown error'));
                        }
                    } catch (error) {
                        addToLog('Error sending heater temp: ' + error.message);
                    }
                }
            }
        }

        heaterTempValue.addEventListener('input', function () {
            var value = parseInt(heaterTempValue.value, 10);
            if (!isNaN(value)) {
                // Clamp value to valid range
                value = Math.max(20, Math.min(70, value));
                heaterTempValue.value = value;
                // Update slider
                if (heaterTempInput) {
                    heaterTempInput.value = value;
                    updateHeaterSliderFill(value);
                    updateHeaterIcon(value);
                }
            }
        });

        // Send data when user clicks outside (blur)
        heaterTempValue.addEventListener('blur', validateAndSendHeaterTemp);

        // Send data when user presses Enter
        heaterTempValue.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.keyCode === 13) {
                event.preventDefault();
                validateAndSendHeaterTemp();
                heaterTempValue.blur(); // Remove focus after sending
            }
        });
    }

    // Heater slider hover tooltip
    heaterTempInput.addEventListener('mousemove', function (e) {
        if (heaterTooltip) {
            var rect = heaterTempInput.getBoundingClientRect();
            var temp = Math.round(20 + ((e.clientX - rect.left) / rect.width) * 50);
            temp = Math.max(20, Math.min(70, temp));
            heaterTooltip.textContent = temp + '°C';
            heaterTooltip.style.left = e.clientX - rect.left + 'px';
        }
    });

    heaterTempInput.addEventListener('change', async function () {
        try {
            var v = parseInt(heaterTempInput.value, 10);
            markUserControlActivity();
            var result = await window.electronAPI.sendHeaterTemp(v);
            if (!result || !result.success) {
                addToLog('Failed to send heater temp: ' + (result && result.error ? result.error : 'Unknown error'));
            } else {
                addToLog('Heater temp sent: ' + v + '\u00B0C');
            }
        } catch (e) {
            addToLog('Error sending heater temp: ' + e.message);
        }
        // Update target temp series to a flat line across current window
        var target = parseInt(heaterTempInput.value, 10);
        // Ensure series[2] exists to length xCount
        var xCount = chartData.series[0].length;
        chartData.series[2] = [];
        for (var i = 0; i < xCount; i++) {
            chartData.series[2].push(target);
        }
        if (chartData.enabled.length < 3) chartData.enabled[2] = true;
        redrawChart();
    });

    // Initialize heater slider fill and icon
    updateHeaterSliderFill(heaterTempInput.value);
    updateHeaterIcon(heaterTempInput.value);
}

// Fan speed button functions
async function setFanSpeed(speed) {
    markUserControlActivity();
    // Make sure speed is valid (0, 50, or 100)
    if (speed !== 0 && speed !== 50 && speed !== 100) {
        addToLog('Invalid fan speed: ' + speed + '. Must be 0, 50, or 100.');
        return;
    }

    // Update the slider value
    if (fanSpeedInput) {
        fanSpeedInput.value = speed;
    }

    // Update the display
    if (fanSpeedDisplay) {
        fanSpeedDisplay.value = speed;
    }

    // Update slider fill and icon
    updateSliderFill(speed);
    updateFanIcon(speed);

    // Update button states
    updateFanButtons(speed);

    // Send the command to hardware
    try {
        var result = await window.electronAPI.sendFanSpeed(speed);
        if (!result || !result.success) {
            addToLog('Failed to send fan speed: ' + (result && result.error ? result.error : 'Unknown error'));
        } else {
            addToLog('Fan speed set to: ' + speed + '%');
        }
    } catch (e) {
        addToLog('Error sending fan speed: ' + e.message);
    }
}

// Fan button event listeners
if (fanOffBtn) {
    fanOffBtn.addEventListener('click', function () {
        setFanSpeed(0);
    });
}

if (fan50Btn) {
    fan50Btn.addEventListener('click', function () {
        setFanSpeed(50);
    });
}

if (fan100Btn) {
    fan100Btn.addEventListener('click', function () {
        setFanSpeed(100);
    });
}


// clearAllGraphs is now defined earlier in the file (line 17) as part of graph lifecycle management
// The earlier function completely destroys and clears all graph traces, which is what we need
// When hardware reconnects, we should reinitialize the chart for the current mode
console.log('All graphs cleared after hardware device reconnected');
// Note: Chart will be reinitialized when data starts flowing again based on currentChartMode

window.addEventListener('beforeunload', function () {
    if (isConnected && !window._skipDisconnectOnUnload) {
        window.electronAPI.disconnectFromPort().catch(function (error) {
            console.log('Error during disconnect:', error);
        });
    }
});

// applyRemoteStateUpdate — mirror control positions from a remote client.
// Writes directly to DOM .value — does NOT call sendXxx() — no re-broadcast loop.
function applyRemoteStateUpdate(state) {
    if (!state) return;

    // Fan speed (shared across modes)
    if (typeof state.fanSpeed === 'number') {
        var fs = state.fanSpeed;
        // Manual mode fan
        if (fanSpeedInput && parseInt(fanSpeedInput.value, 10) !== fs) {
            fanSpeedInput.value = fs;
            lastKnownFanSpeed = fs;
            if (typeof updateSliderFill === 'function') updateSliderFill(fs);
            if (typeof updateFanIcon === 'function') updateFanIcon(fs);
            if (typeof updateFanButtons === 'function') updateFanButtons(fs);
        }
        var fanDisplay = document.getElementById('fanSpeedDisplay');
        if (fanDisplay && document.activeElement !== fanDisplay) fanDisplay.value = fs;
        // On/Off mode fan
        var onoffFan = document.getElementById('onoffFanSpeed');
        if (onoffFan && parseInt(onoffFan.value, 10) !== fs) onoffFan.value = fs;
        // PID mode fan
        var pidFan = document.getElementById('pidFanSpeed');
        if (pidFan && parseInt(pidFan.value, 10) !== fs) pidFan.value = fs;
    }

    // Power slider (manual mode)
    if (typeof state.power === 'number') {
        var pw = state.power;
        var pSlider = document.getElementById('powerSlider');
        if (pSlider && parseInt(pSlider.value, 10) !== pw) {
            pSlider.value = pw;
            lastKnownPower = pw;
        }
        var pDisplay = document.getElementById('powerDisplay');
        if (pDisplay && document.activeElement !== pDisplay) pDisplay.value = pw;
    }

    // Heater / target temperature
    if (typeof state.heaterTemp === 'number') {
        var ht = state.heaterTemp;
        // Manual mode heater slider
        if (heaterTempInput && parseInt(heaterTempInput.value, 10) !== ht) {
            heaterTempInput.value = ht;
            if (typeof updateHeaterSliderFill === 'function') updateHeaterSliderFill(ht);
            if (typeof updateHeaterIcon === 'function') updateHeaterIcon(ht);
        }
        var htDisplay = document.getElementById('heaterTempValue');
        if (htDisplay && document.activeElement !== htDisplay) htDisplay.value = ht;
        // On/Off mode target
        var ooSlider = document.getElementById('onoffTargetSlider');
        if (ooSlider && parseInt(ooSlider.value, 10) !== ht) ooSlider.value = ht;
        var ooDisplay = document.getElementById('onoffTargetDisplay');
        if (ooDisplay && document.activeElement !== ooDisplay) ooDisplay.value = ht;
        if (typeof onoffTargetTemp !== 'undefined') onoffTargetTemp = ht;
        // PID mode target
        var pidSlider = document.getElementById('pidTargetSlider');
        if (pidSlider && parseInt(pidSlider.value, 10) !== ht) pidSlider.value = ht;
        var pidDisplay = document.getElementById('pidTargetDisplay');
        if (pidDisplay && document.activeElement !== pidDisplay) pidDisplay.value = ht;
        if (typeof pidTargetTemp !== 'undefined') pidTargetTemp = ht;
    }

    // Hysteresis
    if (typeof state.hysteresis === 'number') {
        var hyEl = document.getElementById('onoffHysteresis');
        if (hyEl && document.activeElement !== hyEl) {
            hyEl.value = state.hysteresis;
            if (typeof onoffHysteresisValue !== 'undefined') onoffHysteresisValue = state.hysteresis;
        }
    }

    // PID gains
    if (typeof state.pidP === 'number') {
        var ppEl = document.getElementById('pidPInput');
        if (ppEl && document.activeElement !== ppEl) ppEl.value = state.pidP;
    }
    if (typeof state.pidI === 'number') {
        var piEl = document.getElementById('pidIInput');
        if (piEl && document.activeElement !== piEl) piEl.value = state.pidI;
    }
    if (typeof state.pidD === 'number') {
        var pdEl = document.getElementById('pidDInput');
        if (pdEl && document.activeElement !== pdEl) pdEl.value = state.pidD;
    }

    // Control mode panel switch (no hardware send, no chart reinit)
    if (typeof state.controlMode === 'number') {
        var modeMap = { 1: 'manual', 2: 'onoff', 3: 'pid' };
        var newMode = modeMap[state.controlMode];
        if (newMode && newMode !== currentControlMode) {
            currentControlMode = newMode;
            var modeSelect = document.getElementById('controlModeSelect');
            if (modeSelect) modeSelect.value = newMode;
            var manualPanel = document.getElementById('manualControlMode');
            var onoffPanel  = document.getElementById('onoffControlMode');
            var pidPanel    = document.getElementById('pidControlMode');
            if (manualPanel) manualPanel.style.display = (newMode === 'manual') ? '' : 'none';
            if (onoffPanel)  onoffPanel.style.display  = (newMode === 'onoff')  ? '' : 'none';
            if (pidPanel)    pidPanel.style.display    = (newMode === 'pid')    ? '' : 'none';
        }
    }
}


