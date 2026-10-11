let priceChart = null;
let gridChart = null;

const API_BASE = '/api';
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

const LEVEL_COLORS = {
  'very-low': '#00a651',
  'low': '#7cb342',
  'medium': '#fbc02d',
  'high': '#f57c00',
  'very-high': '#d32f2f',
};

const CACHE_STATUS_CLASSES = {
  'fresh': 'status-fresh',
  'acceptable': 'status-acceptable',
  'stale': 'status-stale',
  'expired': 'status-expired',
};

// Load data on page load
document.addEventListener('DOMContentLoaded', async () => {
  await loadAllData();
  // Refresh every 5 minutes
  setInterval(loadAllData, REFRESH_INTERVAL);
});

async function loadAllData() {
  await Promise.all([
    loadPriceData(),
    loadGridData(),
  ]);
}

async function loadPriceData() {
  const priceLoading = document.getElementById('price-loading');
  const priceError = document.getElementById('price-error');
  const priceContent = document.getElementById('price-content');

  try {
    priceLoading.style.display = 'block';
    priceError.style.display = 'none';
    priceContent.style.display = 'none';

    const currency = localStorage.getItem('selectedCurrency') || 'GBP';
    const response = await fetch(`${API_BASE}/commodity-price/forecast?currency=${currency}&hours=24`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // Update current price
    const currentResponse = await fetch(`${API_BASE}/commodity-price/current?currency=${currency}`);
    const currentData = await currentResponse.json();

    if (currentData.current) {
      const current = currentData.current;
      document.getElementById('current-price').textContent =
        formatPrice(current.price, current.decimals, current.currency);

      const levelEl = document.getElementById('current-price-level');
      if (current.priceLevel) {
        levelEl.className = `level-indicator level-${current.priceLevel}`;
      }
    }

    // Update metadata
    const metadata = data.metadata || {};
    document.getElementById('price-currency').textContent = metadata.currency || 'GBP';
    document.getElementById('price-unit').textContent = metadata.tariff_unit || 'kWh';
    document.getElementById('price-period').textContent = `${metadata.period_minutes || 30} minutes`;
    document.getElementById('price-age').textContent = formatAge(metadata.fetched_at);

    const statusEl = document.getElementById('price-status');
    statusEl.textContent = data.cacheStatus;
    statusEl.className = `status-badge ${CACHE_STATUS_CLASSES[data.cacheStatus] || ''}`;

    // Render chart
    renderPriceChart(data.forecast, metadata);

    priceContent.style.display = 'block';
    priceLoading.style.display = 'none';
  } catch (error) {
    console.error('Failed to load price data:', error);
    priceError.textContent = `Error: ${error.message}`;
    priceError.style.display = 'block';
    priceLoading.style.display = 'none';
  }
}

async function loadGridData() {
  const gridLoading = document.getElementById('grid-loading');
  const gridError = document.getElementById('grid-error');
  const gridContent = document.getElementById('grid-content');

  try {
    gridLoading.style.display = 'block';
    gridError.style.display = 'none';
    gridContent.style.display = 'none';

    const region = localStorage.getItem('selectedRegion') || 'uk';
    const response = await fetch(`${API_BASE}/grid-conditions/forecast?region=${region}&hours=48`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // Update current conditions
    const currentResponse = await fetch(`${API_BASE}/grid-conditions/current?region=${region}`);
    const currentData = await currentResponse.json();

    if (currentData.current) {
      const current = currentData.current;
      document.getElementById('current-intensity').textContent =
        `${current.gridCarbonIntensity || '—'} gCO2/kWh`;

      const levelEl = document.getElementById('current-intensity-level');
      if (current.gridCarbonLevel) {
        levelEl.className = `level-indicator level-${current.gridCarbonLevel}`;
      }
    }

    // Update metadata
    const metadata = data.metadata || {};
    document.getElementById('grid-region').textContent = (metadata.region || 'uk').toUpperCase();
    document.getElementById('grid-postcode').textContent = metadata.postcode || 'National';
    document.getElementById('grid-age').textContent = formatAge(metadata.fetched_at);

    const statusEl = document.getElementById('grid-status');
    statusEl.textContent = data.cacheStatus;
    statusEl.className = `status-badge ${CACHE_STATUS_CLASSES[data.cacheStatus] || ''}`;

    // Render chart
    renderGridChart(data.forecast, metadata);

    gridContent.style.display = 'block';
    gridLoading.style.display = 'none';
  } catch (error) {
    console.error('Failed to load grid data:', error);
    gridError.textContent = `Error: ${error.message}`;
    gridError.style.display = 'block';
    gridLoading.style.display = 'none';
  }
}

function renderPriceChart(forecast, metadata) {
  const chartCanvas = document.getElementById('priceChart');
  if (!chartCanvas) {
    console.error('priceChart canvas not found');
    return;
  }

  const ctx = chartCanvas.getContext('2d');
  if (!ctx) {
    console.error('Could not get 2D context for priceChart');
    return;
  }

  if (forecast.length === 0) {
    console.warn('No price forecast data to display');
    return;
  }

  const labels = forecast.map(p => formatTime(p.periodStart));
  const decimals = metadata.decimals || 3;
  const prices = forecast.map(p => p.price ? p.price / Math.pow(10, decimals) : 0);
  const colors = forecast.map(p => LEVEL_COLORS[p.priceLevel] || '#999');

  const backgroundColors = colors.map(c => c + '40'); // Add transparency

  if (priceChart) {
    priceChart.destroy();
  }

  priceChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `Price (${metadata.currency || 'GBP'}/${metadata.tariff_unit || 'kWh'})`,
          data: prices,
          backgroundColor: backgroundColors,
          borderColor: colors,
          borderWidth: 2,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const value = context.parsed.y;
              const price = value.toFixed(3);
              return `${price} ${metadata.currency}/${metadata.tariff_unit}`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return value.toFixed(2);
            },
          },
        },
      },
    },
  });
}

function renderGridChart(forecast, metadata) {
  const chartCanvas = document.getElementById('gridChart');
  if (!chartCanvas) {
    console.error('gridChart canvas not found');
    return;
  }

  const ctx = chartCanvas.getContext('2d');
  if (!ctx) {
    console.error('Could not get 2D context for gridChart');
    return;
  }

  if (forecast.length === 0) {
    console.warn('No grid forecast data to display');
    return;
  }

  const labels = forecast.map(c => formatTime(c.periodStart));
  const intensity = forecast.map(c => c.gridCarbonIntensity || 0);
  const colors = forecast.map(c => LEVEL_COLORS[c.gridCarbonLevel] || '#999');

  const backgroundColors = colors.map(c => c + '40'); // Add transparency

  if (gridChart) {
    gridChart.destroy();
  }

  gridChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Grid Carbon Intensity (gCO2/kWh)',
          data: intensity,
          borderColor: '#1976d2',
          backgroundColor: '#1976d240',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: colors,
          pointBorderColor: colors,
          pointRadius: 4,
          pointHoverRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.parsed.y} gCO2/kWh`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return value + ' gCO2/kWh';
            },
          },
        },
      },
    },
  });
}

function formatPrice(price, decimals, currency) {
  if (!price) return '—';
  const value = price / Math.pow(10, decimals);
  return `${value.toFixed(decimals)} ${currency}`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatAge(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - timestamp;

  if (ageSeconds < 60) return 'Just now';
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86400)}d ago`;
}

async function refreshPrice() {
  await loadPriceData();
}

async function refreshGrid() {
  await loadGridData();
}

async function exportData(type) {
  try {
    if (type === 'price') {
      const currency = localStorage.getItem('selectedCurrency') || 'GBP';
      const response = await fetch(`${API_BASE}/commodity-price/forecast?currency=${currency}&hours=24`);
      const data = await response.json();
      downloadJSON(`price-forecast-${new Date().toISOString().split('T')[0]}.json`, data);
    } else if (type === 'grid') {
      const region = localStorage.getItem('selectedRegion') || 'uk';
      const response = await fetch(`${API_BASE}/grid-conditions/forecast?region=${region}&hours=48`);
      const data = await response.json();
      downloadJSON(`grid-forecast-${new Date().toISOString().split('T')[0]}.json`, data);
    }
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export data');
  }
}

function downloadJSON(filename, data) {
  const element = document.createElement('a');
  element.setAttribute('href', 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2)));
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}
