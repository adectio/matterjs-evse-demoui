const API_BASE = '/api';
const STORAGE_PREFIX = 'evse-config-';

document.addEventListener('DOMContentLoaded', async () => {
  loadConfigFromStorage();
  await loadCustomTariff();
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

const PRICE_LEVELS = ['Very low', 'Low', 'Medium', 'High', 'Very high'];

// Prices are stored in 1/100 of a penny/cent, as the price server publishes them
const PRICE_SCALE = 100;

function addTariffPeriod(period) {
  const periodsContainer = document.getElementById('tariff-periods');
  const periodDiv = document.createElement('div');
  periodDiv.className = 'tariff-period';

  // A new period starts 30 minutes after the last one
  const last = periodsContainer.lastElementChild?.querySelector('.period-start').value;
  const startMinutes = period?.startMinutes ?? (last ? (minutesFromTime(last) + 30) % (24 * 60) : 0);

  const start = document.createElement('input');
  start.type = 'time';
  start.className = 'period-start';
  start.value = `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;

  const price = document.createElement('input');
  price.type = 'number';
  price.step = '0.01';
  price.placeholder = 'Price (p/kWh)';
  price.className = 'period-price';
  if (period) price.value = period.price / PRICE_SCALE;

  const level = document.createElement('select');
  level.className = 'period-level';
  level.append(new Option('Level: auto', ''));
  PRICE_LEVELS.forEach((label, value) => level.append(new Option(label, String(value))));
  level.value = period?.priceLevel == null ? '' : String(period.priceLevel);

  const description = document.createElement('input');
  description.type = 'text';
  description.placeholder = 'Description (optional)';
  description.className = 'period-description';
  description.value = period?.description ?? '';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn-danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => periodDiv.remove());

  periodDiv.append(start, price, level, description, remove);
  periodsContainer.appendChild(periodDiv);
}

function minutesFromTime(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

async function saveCustomTariff() {
  const name = document.getElementById('tariff-name').value.trim();
  const currency = document.getElementById('tariff-currency').value;
  if (!name) {
    showStatus('Please enter a tariff name', 'error');
    return;
  }

  const periods = [];
  for (const periodDiv of document.querySelectorAll('.tariff-period')) {
    const start = periodDiv.querySelector('.period-start').value;
    const price = periodDiv.querySelector('.period-price').value;
    if (!start || price === '' || !Number.isFinite(Number(price))) {
      showStatus('Every period needs a start time and a price', 'error');
      return;
    }
    const level = periodDiv.querySelector('.period-level').value;
    periods.push({
      startMinutes: minutesFromTime(start),
      price: Math.round(Number(price) * PRICE_SCALE),
      priceLevel: level === '' ? null : Number(level),
      description: periodDiv.querySelector('.period-description').value,
    });
  }
  if (periods.length === 0) {
    showStatus('Add at least one price period', 'error');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/price-server/custom-tariff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, currency, periods }),
    });
    const data = await response.json();
    if (!response.ok) {
      showStatus(`Could not save the tariff: ${data.error}`, 'error');
      return;
    }
    renderCustomTariff(data.tariff);
    showStatus('Custom tariff saved and published by the price server', 'success');
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  }
}

async function loadCustomTariff() {
  try {
    const response = await fetch(`${API_BASE}/price-server/custom-tariff`);
    if (!response.ok) return;
    const { tariff } = await response.json();
    if (tariff) renderCustomTariff(tariff);
  } catch (error) {
    console.error('Failed to load custom tariff:', error);
  }
}

function renderCustomTariff(tariff) {
  document.getElementById('tariff-name').value = tariff.name;
  document.getElementById('tariff-currency').value = tariff.currency;
  document.getElementById('tariff-periods').innerHTML = '';
  tariff.periods.forEach((period) => addTariffPeriod(period));
}

async function clearCustomTariff() {
  if (!confirm('Are you sure you want to clear the custom tariff? The price server will go back to fetched prices.')) return;
  try {
    const response = await fetch(`${API_BASE}/price-server/custom-tariff`, { method: 'DELETE' });
    if (!response.ok) {
      showStatus(`Could not clear the tariff: ${(await response.json()).error}`, 'error');
      return;
    }
    document.getElementById('tariff-name').value = '';
    document.getElementById('tariff-periods').innerHTML = '';
    showStatus('Custom tariff cleared', 'success');
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
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
