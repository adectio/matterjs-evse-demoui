const API_BASE = '/api';
const STORAGE_PREFIX = 'evse-config-';

document.addEventListener('DOMContentLoaded', async () => {
  loadConfigFromStorage();
  await Promise.all([loadCustomTariff(), loadPriceSources()]);
  await refreshSystemStatus();
  // Refresh system status every 30 seconds
  setInterval(refreshSystemStatus, 30 * 1000);
});

function loadConfigFromStorage() {
  // Load UK postcode
  const ukPostcode = localStorage.getItem(STORAGE_PREFIX + 'uk-postcode');
  if (ukPostcode) {
    document.getElementById('uk-postcode').value = ukPostcode;
  }
}

const REGIONS = [
  ['A', 'Eastern England'], ['B', 'East Midlands'], ['C', 'London'], ['D', 'Merseyside and Northern Wales'],
  ['E', 'West Midlands'], ['F', 'North Eastern England'], ['G', 'North Western England'], ['H', 'Southern England'],
  ['J', 'South Eastern England'], ['K', 'South Wales'], ['L', 'South Western England'], ['M', 'Yorkshire'],
  ['N', 'Southern Scotland'], ['P', 'Northern Scotland'],
];

let priceSources = null;

async function loadPriceSources() {
  try {
    const response = await fetch(`${API_BASE}/config/price-source`);
    if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to load price sources');
    priceSources = await response.json();
    renderPriceSources();
  } catch (error) {
    document.getElementById('price-source-options').textContent = `Error: ${error.message}`;
  }
}

function renderPriceSources() {
  const container = document.getElementById('price-source-options');
  container.replaceChildren(
    ...priceSources.tariffs.map(renderTariffSource),
    renderCustomSource(priceSources.customTariff),
  );
}

function sourceOption(id, name, selectable) {
  const option = document.createElement('div');
  option.className = 'price-source-option';
  option.classList.toggle('selected', priceSources.active === id);
  option.classList.toggle('unavailable', !selectable);

  const choice = document.createElement('label');
  choice.className = 'price-source-choice';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'price-source';
  radio.value = id;
  radio.checked = priceSources.active === id;
  radio.disabled = !selectable;
  radio.addEventListener('change', () => {
    for (const element of document.querySelectorAll('.price-source-option')) element.classList.remove('selected');
    option.classList.add('selected');
  });
  const title = document.createElement('span');
  title.className = 'price-source-name';
  title.textContent = name;
  choice.append(radio, title);
  if (priceSources.active === id) {
    const badge = document.createElement('span');
    badge.className = 'price-source-badge';
    badge.textContent = 'Published';
    choice.append(badge);
  }
  option.append(choice);
  return option;
}

function renderTariffSource(tariff) {
  const option = sourceOption(tariff.id, tariff.name, true);

  const status = document.createElement('p');
  status.className = 'price-source-status';
  status.textContent = tariff.fetchedAt
    ? [
        `Fetched ${formatDateTime(tariff.fetchedAt)}`,
        tariff.publishedUntil ? `prices published until ${formatDateTime(tariff.publishedUntil)}` : null,
        tariff.currentPrice !== null ? `now ${(tariff.currentPrice / 100).toFixed(2)}p/kWh` : null,
      ].filter(Boolean).join(' · ')
    : 'Not fetched yet';
  option.append(status);

  const row = document.createElement('div');
  row.className = 'form-row';
  const product = document.createElement('div');
  product.className = 'form-group';
  product.innerHTML = `<label>Product code</label><input type="text" data-tariff="${tariff.id}" data-field="productCode" />`;
  product.querySelector('input').value = tariff.productCode;
  const region = document.createElement('div');
  region.className = 'form-group';
  region.innerHTML = `<label>Region</label><select data-tariff="${tariff.id}" data-field="regionCode"></select>`;
  const select = region.querySelector('select');
  select.append(...REGIONS.map(([code, name]) => new Option(`${code} - ${name}`, code)));
  select.value = tariff.regionCode;
  row.append(product, region);
  option.append(row);
  return option;
}

function renderCustomSource(customTariff) {
  const option = sourceOption('custom', 'Custom time-of-use tariff', customTariff !== null);
  const status = document.createElement('p');
  status.className = 'price-source-status';
  status.textContent = customTariff
    ? `"${customTariff.name}", ${customTariff.periods} period(s) repeating daily`
    : 'No custom tariff saved; create one below';
  option.append(status);
  return option;
}

async function savePriceSource() {
  const active = document.querySelector('input[name="price-source"]:checked')?.value;
  const tariffs = {};
  for (const input of document.querySelectorAll('[data-tariff]')) {
    tariffs[input.dataset.tariff] ??= {};
    tariffs[input.dataset.tariff][input.dataset.field] = input.value.trim();
  }
  try {
    const response = await fetch(`${API_BASE}/config/price-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active, tariffs }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Unable to save the price source');
    priceSources = data;
    renderPriceSources();
    const detail = data.activeSource.detail ? ` (${data.activeSource.detail})` : '';
    showStatus(`Publishing ${data.activeSource.name}${detail}`, 'success');
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  }
}

function formatDateTime(seconds) {
  return new Date(seconds * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
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
  remove.addEventListener('click', () => {
    periodDiv.remove();
    refreshTariffPeriods();
  });

  // Each period runs until the next one starts; shown so the whole day is visible
  const until = document.createElement('span');
  until.className = 'period-until';

  start.addEventListener('change', () => refreshTariffPeriods({ sort: true }));
  price.addEventListener('input', () => refreshTariffPeriods());
  level.addEventListener('change', () => refreshTariffPeriods());

  periodDiv.append(start, until, price, level, description, remove);
  periodsContainer.appendChild(periodDiv);
  refreshTariffPeriods({ sort: true });
}

const LEVEL_COLORS = ['#00a651', '#7cb342', '#fbc02d', '#f57c00', '#d32f2f'];

function formatMinutes(minutes) {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours && rest ? `${hours}h ${rest}m` : hours ? `${hours}h` : `${rest}m`;
}

/** Keep rows in time order, show where each period ends, and redraw the 24-hour timeline */
function refreshTariffPeriods({ sort = false } = {}) {
  const container = document.getElementById('tariff-periods');
  const rows = [...container.querySelectorAll('.tariff-period')].filter((row) => row.querySelector('.period-start').value);
  if (sort) {
    rows.sort((a, b) => minutesFromTime(a.querySelector('.period-start').value) - minutesFromTime(b.querySelector('.period-start').value));
    container.append(...rows);
  }
  const ordered = [...rows].sort(
    (a, b) => minutesFromTime(a.querySelector('.period-start').value) - minutesFromTime(b.querySelector('.period-start').value)
  );

  // Automatic levels split this tariff's price range into five bands, as the price server does
  const prices = ordered.map((row) => Number(row.querySelector('.period-price').value)).filter(Number.isFinite);
  const min = Math.min(...prices);
  const range = Math.max(...prices) - min;
  const levelOf = (row) => {
    const chosen = row.querySelector('.period-level').value;
    if (chosen !== '') return Number(chosen);
    const price = Number(row.querySelector('.period-price').value);
    return !Number.isFinite(price) || range === 0 ? 2 : Math.min(4, Math.floor(((price - min) / range) * 5));
  };

  const timeline = document.getElementById('tariff-timeline');
  timeline.replaceChildren();
  ordered.forEach((row, index) => {
    const startMinutes = minutesFromTime(row.querySelector('.period-start').value);
    const endMinutes = minutesFromTime(ordered[(index + 1) % ordered.length].querySelector('.period-start').value);
    const duration = ordered.length === 1 ? 24 * 60 : (endMinutes - startMinutes + 24 * 60) % (24 * 60) || 24 * 60;
    row.querySelector('.period-until').textContent = `→ ${formatMinutes(endMinutes)} (${formatDuration(duration)})`;

    // The timeline starts at midnight, so a period crossing midnight is drawn in two parts
    const price = row.querySelector('.period-price').value;
    const segments = startMinutes + duration > 24 * 60
      ? [[startMinutes, 24 * 60 - startMinutes], [0, startMinutes + duration - 24 * 60]]
      : [[startMinutes, duration]];
    for (const [segmentStart, segmentMinutes] of segments) {
      const block = document.createElement('span');
      block.style.background = LEVEL_COLORS[levelOf(row)];
      block.style.order = String(segmentStart);
      block.style.width = `${(segmentMinutes / (24 * 60)) * 100}%`;
      block.textContent = price === '' ? '' : `${Number(price)}p`;
      block.title = `${formatMinutes(startMinutes)}–${formatMinutes(endMinutes)}: ${price === '' ? '?' : price}p/kWh`;
      timeline.append(block);
    }
  });
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
    await loadPriceSources();
    showStatus('Custom tariff saved and selected as the price source', 'success');
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
  refreshTariffPeriods({ sort: true });
}

async function clearCustomTariff() {
  if (!confirm('Clear the custom tariff? If it is the selected price source, the price server returns to the dynamic tariff used before.')) return;
  try {
    const response = await fetch(`${API_BASE}/price-server/custom-tariff`, { method: 'DELETE' });
    if (!response.ok) {
      showStatus(`Could not clear the tariff: ${(await response.json()).error}`, 'error');
      return;
    }
    document.getElementById('tariff-name').value = '';
    document.getElementById('tariff-periods').innerHTML = '';
    refreshTariffPeriods();
    await loadPriceSources();
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
  const fetchers = ['octopus', 'edf', 'uk-carbon-intensity'];
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
