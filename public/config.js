const API_BASE = '/api';
const STORAGE_PREFIX = 'evse-config-';

document.addEventListener('DOMContentLoaded', async () => {
  loadConfigFromStorage();
  await refreshSystemStatus();
  // Refresh system status every 30 seconds
  setInterval(refreshSystemStatus, 30 * 1000);
});

function loadConfigFromStorage() {
  // Load Kraken config
  const krakenApiKey = localStorage.getItem(STORAGE_PREFIX + 'kraken-api-key');
  if (krakenApiKey) {
    document.getElementById('kraken-api-key').value = krakenApiKey;
  }

  // Load Octopus config
  const octopusApiKey = localStorage.getItem(STORAGE_PREFIX + 'octopus-api-key');
  if (octopusApiKey) {
    document.getElementById('octopus-api-key').value = octopusApiKey;
  }
  const octopusProduct = localStorage.getItem(STORAGE_PREFIX + 'octopus-product');
  if (octopusProduct) {
    document.getElementById('octopus-product').value = octopusProduct;
  }
  const octopusRegion = localStorage.getItem(STORAGE_PREFIX + 'octopus-region');
  if (octopusRegion) {
    document.getElementById('octopus-region').value = octopusRegion;
  }

  // Load UK postcode
  const ukPostcode = localStorage.getItem(STORAGE_PREFIX + 'uk-postcode');
  if (ukPostcode) {
    document.getElementById('uk-postcode').value = ukPostcode;
  }

  // Load custom tariff
  const customTariff = localStorage.getItem(STORAGE_PREFIX + 'custom-tariff');
  if (customTariff) {
    loadCustomTariff(JSON.parse(customTariff));
  }
}

function savePriceSources() {
  const krakenApiKey = document.getElementById('kraken-api-key').value;
  const octopusApiKey = document.getElementById('octopus-api-key').value;
  const octopusProduct = document.getElementById('octopus-product').value;
  const octopusRegion = document.getElementById('octopus-region').value;

  // Save to localStorage
  localStorage.setItem(STORAGE_PREFIX + 'kraken-api-key', krakenApiKey);
  localStorage.setItem(STORAGE_PREFIX + 'octopus-api-key', octopusApiKey);
  localStorage.setItem(STORAGE_PREFIX + 'octopus-product', octopusProduct);
  localStorage.setItem(STORAGE_PREFIX + 'octopus-region', octopusRegion);

  showStatus('Price source configuration saved', 'success');

  // TODO: Send to backend to save in database
}

function saveGridSources() {
  const ukPostcode = document.getElementById('uk-postcode').value;

  localStorage.setItem(STORAGE_PREFIX + 'uk-postcode', ukPostcode);
  localStorage.setItem('selectedRegion', 'uk');

  showStatus('Grid source configuration saved', 'success');

  // TODO: Send to backend to save in database
}

function addTariffPeriod() {
  const periodsContainer = document.getElementById('tariff-periods');
  const periodCount = periodsContainer.children.length;

  const periodDiv = document.createElement('div');
  periodDiv.className = 'tariff-period';
  periodDiv.dataset.index = periodCount;

  const startHour = Math.floor((periodCount * 30) / 60) % 24;
  const startMin = (periodCount * 30) % 60;

  periodDiv.innerHTML = `
    <input type="time" value="${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}"
           class="period-start" />
    <input type="number" step="0.001" placeholder="Price" class="period-price" />
    <input type="text" placeholder="Description (optional)" class="period-description" />
    <button type="button" class="btn-danger" onclick="removeTariffPeriod(${periodCount})">Remove</button>
  `;

  periodsContainer.appendChild(periodDiv);
}

function removeTariffPeriod(index) {
  const periodDiv = document.querySelector(`[data-index="${index}"]`);
  if (periodDiv) {
    periodDiv.remove();
  }
}

function saveCustomTariff() {
  const name = document.getElementById('tariff-name').value;
  const currency = document.getElementById('tariff-currency').value;
  const decimals = parseInt(document.getElementById('tariff-decimals').value);

  if (!name) {
    showStatus('Please enter a tariff name', 'error');
    return;
  }

  const periods = [];
  document.querySelectorAll('.tariff-period').forEach((periodDiv) => {
    const start = periodDiv.querySelector('.period-start').value;
    const price = parseFloat(periodDiv.querySelector('.period-price').value);
    const description = periodDiv.querySelector('.period-description').value;

    if (!start || !price) {
      showStatus('Please fill in all period data', 'error');
      return;
    }

    const [hours, minutes] = start.split(':').map(Number);
    const startMinutes = hours * 60 + minutes;
    const endMinutes = (startMinutes + 30) % (24 * 60);

    periods.push({
      startMinutes,
      endMinutes,
      price: Math.round(price * Math.pow(10, decimals)),
      description,
    });
  });

  const tariff = { name, currency, decimals, periods };
  localStorage.setItem(STORAGE_PREFIX + 'custom-tariff', JSON.stringify(tariff));

  showStatus('Custom tariff saved', 'success');

  // TODO: Send to backend to save in database
}

function loadCustomTariff(tariff) {
  document.getElementById('tariff-name').value = tariff.name;
  document.getElementById('tariff-currency').value = tariff.currency;
  document.getElementById('tariff-decimals').value = tariff.decimals;

  const periodsContainer = document.getElementById('tariff-periods');
  periodsContainer.innerHTML = '';

  tariff.periods.forEach((period, index) => {
    const hours = Math.floor(period.startMinutes / 60);
    const minutes = period.startMinutes % 60;
    const price = period.price / Math.pow(10, tariff.decimals);

    const periodDiv = document.createElement('div');
    periodDiv.className = 'tariff-period';
    periodDiv.dataset.index = index;
    periodDiv.innerHTML = `
      <input type="time" value="${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}"
             class="period-start" />
      <input type="number" step="0.001" placeholder="Price" class="period-price" value="${price}" />
      <input type="text" placeholder="Description (optional)" class="period-description" value="${period.description || ''}" />
      <button type="button" class="btn-danger" onclick="removeTariffPeriod(${index})">Remove</button>
    `;
    periodsContainer.appendChild(periodDiv);
  });
}

function clearCustomTariff() {
  if (confirm('Are you sure you want to clear the custom tariff?')) {
    localStorage.removeItem(STORAGE_PREFIX + 'custom-tariff');
    document.getElementById('tariff-name').value = '';
    document.getElementById('tariff-periods').innerHTML = '';
    showStatus('Custom tariff cleared', 'success');
  }
}

async function refreshSystemStatus() {
  try {
    const response = await fetch(`${API_BASE}/config/status`);
    const data = await response.json();

    // Update fetcher status
    const fetcherStatusDiv = document.getElementById('fetcher-status');
    let html = '';
    for (const fetcher of data.fetchers) {
      const statusClass = fetcher.enabled ? 'status-active' : 'status-inactive';
      html += `
        <div class="fetcher-item">
          <div style="display: flex; align-items: center;">
            <span class="status-indicator ${statusClass}"></span>
            <strong>${fetcher.name}</strong> (Every ${fetcher.intervalMinutes} min)
          </div>
          <button class="btn-secondary" onclick="triggerFetch('${fetcher.name}')" ${!fetcher.enabled ? 'disabled' : ''}>
            Fetch Now
          </button>
        </div>
      `;
    }
    fetcherStatusDiv.innerHTML = html;

    // Update cache stats
    const cacheStats = data.cache.stats;
    document.getElementById('cache-entries').textContent = data.cache.totalEntries;
    document.getElementById('cache-hit-rate').textContent = data.cache.averageHitRate + '%';

    // Calculate next update (rough estimate)
    const nextUpdate = new Date(Date.now() + 5 * 60 * 1000).toLocaleTimeString();
    document.getElementById('next-update').textContent = nextUpdate;
  } catch (error) {
    console.error('Failed to refresh system status:', error);
  }
}

async function triggerFetch(fetcherName) {
  try {
    const response = await fetch(`${API_BASE}/admin/fetch/${fetcherName}`, { method: 'POST' });
    const data = await response.json();

    if (response.ok) {
      showStatus(`Triggered fetch for ${fetcherName}`, 'success');
      setTimeout(refreshSystemStatus, 2000);
    } else {
      showStatus(`Failed to trigger fetch: ${data.error}`, 'error');
    }
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  }
}

async function triggerAllFetches() {
  const fetchers = ['kraken', 'octopus', 'uk-carbon-intensity'];
  for (const fetcher of fetchers) {
    try {
      await fetch(`${API_BASE}/admin/fetch/${fetcher}`, { method: 'POST' });
    } catch (error) {
      console.warn(`Failed to trigger ${fetcher}:`, error);
    }
  }
  showStatus('All fetches triggered', 'info');
  setTimeout(refreshSystemStatus, 2000);
}

function showStatus(message, type = 'info') {
  const statusDiv = document.getElementById('status-message');
  statusDiv.className = `status-message status-${type}`;
  statusDiv.textContent = message;
  statusDiv.style.display = 'block';

  if (type !== 'error') {
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 5000);
  }
}
