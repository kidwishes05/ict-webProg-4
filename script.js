const STORAGE_KEY = 'weather-app-state';
const GEO_ID = 'geo';
const GEO_NAME = 'Текущее местоположение';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const FORECAST_DAYS = 5;
const REQUEST_TIMEOUT = 10000;
const SUGGEST_DELAY = 300;

const WEATHER_CODES = {
  0: ['Ясно', '☀️'],
  1: ['Преимущественно ясно', '🌤️'],
  2: ['Переменная облачность', '⛅'],
  3: ['Пасмурно', '☁️'],
  45: ['Туман', '🌫️'],
  48: ['Изморозь', '🌫️'],
  51: ['Слабая морось', '🌦️'],
  53: ['Морось', '🌦️'],
  55: ['Сильная морось', '🌦️'],
  56: ['Ледяная морось', '🌧️'],
  57: ['Сильная ледяная морось', '🌧️'],
  61: ['Слабый дождь', '🌧️'],
  63: ['Дождь', '🌧️'],
  65: ['Сильный дождь', '🌧️'],
  66: ['Ледяной дождь', '🌧️'],
  67: ['Сильный ледяной дождь', '🌧️'],
  71: ['Слабый снег', '🌨️'],
  73: ['Снег', '🌨️'],
  75: ['Сильный снег', '❄️'],
  77: ['Снежные зёрна', '🌨️'],
  80: ['Слабый ливень', '🌦️'],
  81: ['Ливень', '🌧️'],
  82: ['Сильный ливень', '🌧️'],
  85: ['Слабый снегопад', '🌨️'],
  86: ['Сильный снегопад', '❄️'],
  95: ['Гроза', '⛈️'],
  96: ['Гроза с градом', '⛈️'],
  99: ['Сильная гроза с градом', '⛈️']
};

const state = {
  locations: [],
  activeId: null,
  geoAsked: false,
  locating: false,
  weather: {}
};

let requestCounter = 0;
let suggestTimer = null;
let suggestSeq = 0;
let suggestions = [];
let highlighted = -1;
let selectedCity = null;
let submitting = false;

const refreshBtn = document.getElementById('refresh-btn');
const addBtn = document.getElementById('add-btn');
const tabsEl = document.getElementById('tabs');
const contentEl = document.getElementById('content');
const dialog = document.getElementById('city-dialog');
const form = document.getElementById('city-form');
const noteEl = document.getElementById('dialog-note');
const fieldEl = document.getElementById('city-field');
const input = document.getElementById('city-input');
const list = document.getElementById('suggestions');
const errorEl = document.getElementById('city-error');
const submitBtn = document.getElementById('submit-btn');
const cancelBtn = document.getElementById('cancel-btn');
const geoBtn = document.getElementById('geo-btn');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidLocation(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    isNumber(item.lat) &&
    isNumber(item.lon)
  );
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.locations)) {
      state.locations = saved.locations.filter(isValidLocation);
    }
    state.geoAsked = Boolean(saved.geoAsked);
    const exists = state.locations.some((item) => item.id === saved.activeId);
    if (exists) {
      state.activeId = saved.activeId;
    } else if (state.locations.length) {
      state.activeId = state.locations[0].id;
    }
  } catch (error) {
    state.locations = [];
    state.activeId = null;
  }
}

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        locations: state.locations,
        activeId: state.activeId,
        geoAsked: state.geoAsked
      })
    );
  } catch (error) {
    return;
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchForecast(location) {
  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
    wind_speed_unit: 'ms',
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS)
  });
  const data = await fetchJson(FORECAST_URL + '?' + params.toString());
  if (!data || !data.current || !data.daily || !Array.isArray(data.daily.time)) {
    throw new Error('Некорректный ответ сервера');
  }
  return data;
}

async function loadWeather(location) {
  const token = ++requestCounter;
  state.weather[location.id] = { status: 'loading', token };
  render();
  try {
    const data = await fetchForecast(location);
    const entry = state.weather[location.id];
    if (!entry || entry.token !== token) {
      return;
    }
    state.weather[location.id] = { status: 'success', data, updatedAt: new Date(), token };
  } catch (error) {
    const entry = state.weather[location.id];
    if (!entry || entry.token !== token) {
      return;
    }
    state.weather[location.id] = { status: 'error', token };
  }
  render();
}

function refreshAll() {
  state.locations.forEach((location) => {
    loadWeather(location);
  });
}

function getActiveLocation() {
  return state.locations.find((item) => item.id === state.activeId) || null;
}

function weatherInfo(code) {
  return WEATHER_CODES[code] || ['Нет данных', '❔'];
}

function formatTemp(value) {
  if (!isNumber(value)) {
    return '—';
  }
  const rounded = Math.round(value);
  if (rounded > 0) {
    return '+' + rounded + '°';
  }
  if (rounded < 0) {
    return '−' + Math.abs(rounded) + '°';
  }
  return '0°';
}

function formatWind(value) {
  return isNumber(value) ? Math.round(value) + ' м/с' : '—';
}

function formatPrecipitation(value) {
  if (!isNumber(value)) {
    return '—';
  }
  return String(Math.round(value * 10) / 10).replace('.', ',') + ' мм';
}

function formatHumidity(value) {
  return isNumber(value) ? Math.round(value) + '%' : '—';
}

function parseDate(text) {
  const parts = text.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatTime(date) {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function renderTabs() {
  tabsEl.textContent = '';
  tabsEl.hidden = state.locations.length === 0;
  state.locations.forEach((location) => {
    const isActive = location.id === state.activeId;
    const tab = el('div', isActive ? 'tab is-active' : 'tab');

    const select = el('button', 'tab-select', location.name);
    select.type = 'button';
    select.title = location.region ? location.name + ', ' + location.region : location.name;
    if (isActive) {
      select.setAttribute('aria-current', 'true');
    }
    select.addEventListener('click', () => setActive(location.id));

    const remove = el('button', 'tab-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Удалить: ' + location.name);
    remove.addEventListener('click', () => removeLocation(location.id));

    tab.appendChild(select);
    tab.appendChild(remove);
    tabsEl.appendChild(tab);
  });
}

function buildStatus(message, isError) {
  const box = el('div', isError ? 'status status-error' : 'status');
  box.appendChild(el('p', '', message));
  return box;
}

function buildCurrent(location, entry) {
  const data = entry.data;
  const current = data.current;
  const info = weatherInfo(current.weather_code);

  const card = el('section', 'card');
  card.appendChild(el('h2', 'card-title', location.name));
  if (location.region) {
    card.appendChild(el('p', 'region', location.region));
  }

  const main = el('div', 'current-main');
  const icon = el('span', 'current-icon', info[1]);
  icon.setAttribute('aria-hidden', 'true');
  main.appendChild(icon);
  main.appendChild(el('span', 'current-temp', formatTemp(current.temperature_2m)));
  main.appendChild(el('span', 'current-desc', info[0]));
  card.appendChild(main);

  const details = el('dl', 'details');
  [
    ['Ощущается как', formatTemp(current.apparent_temperature)],
    ['Влажность', formatHumidity(current.relative_humidity_2m)],
    ['Ветер', formatWind(current.wind_speed_10m)]
  ].forEach((pair) => {
    const item = el('div', 'detail');
    item.appendChild(el('dt', '', pair[0]));
    item.appendChild(el('dd', '', pair[1]));
    details.appendChild(item);
  });
  card.appendChild(details);

  card.appendChild(el('p', 'updated', 'Обновлено в ' + formatTime(entry.updatedAt)));
  return card;
}

function buildForecast(entry) {
  const daily = entry.data.daily;
  const card = el('section', 'card');
  card.appendChild(el('h2', 'card-title', 'Прогноз на ' + daily.time.length + ' дней'));

  const days = el('ul', 'days');
  daily.time.forEach((dateText, index) => {
    const date = parseDate(dateText);
    const info = weatherInfo(daily.weather_code[index]);
    let name = capitalize(date.toLocaleDateString('ru-RU', { weekday: 'long' }));
    if (index === 0) {
      name = 'Сегодня';
    } else if (index === 1) {
      name = 'Завтра';
    }

    const item = el('li', 'day');

    const label = el('div', 'day-label');
    label.appendChild(el('div', 'day-name', name));
    label.appendChild(el('div', 'day-date', date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })));
    item.appendChild(label);

    const infoBox = el('div', 'day-info');
    const icon = el('span', 'day-icon', info[1]);
    icon.setAttribute('aria-hidden', 'true');
    infoBox.appendChild(icon);
    const text = el('div', 'day-text');
    text.appendChild(el('div', 'day-desc', info[0]));
    text.appendChild(
      el(
        'div',
        'day-meta',
        'Осадки: ' +
          formatPrecipitation(daily.precipitation_sum[index]) +
          '. Ветер до ' +
          formatWind(daily.wind_speed_10m_max[index])
      )
    );
    infoBox.appendChild(text);
    item.appendChild(infoBox);

    const temp = el('div', 'day-temp');
    temp.appendChild(el('span', 'day-max', formatTemp(daily.temperature_2m_max[index])));
    temp.appendChild(document.createTextNode(' / '));
    temp.appendChild(el('span', 'day-min', formatTemp(daily.temperature_2m_min[index])));
    item.appendChild(temp);

    days.appendChild(item);
  });
  card.appendChild(days);
  return card;
}

function renderContent() {
  contentEl.textContent = '';

  if (state.locating) {
    contentEl.appendChild(buildStatus('Определяем ваше местоположение…', false));
    return;
  }

  const location = getActiveLocation();

  if (!location) {
    const box = el('div', 'status');
    box.appendChild(el('p', '', 'Добавьте город, чтобы увидеть прогноз погоды.'));
    const actions = el('div', 'status-actions');
    const addCityBtn = el('button', 'btn btn-primary', 'Добавить город');
    addCityBtn.type = 'button';
    addCityBtn.addEventListener('click', () => openDialog());
    actions.appendChild(addCityBtn);
    if ('geolocation' in navigator) {
      const geoActionBtn = el('button', 'btn', 'Определить местоположение');
      geoActionBtn.type = 'button';
      geoActionBtn.addEventListener('click', () => useGeolocation());
      actions.appendChild(geoActionBtn);
    }
    box.appendChild(actions);
    contentEl.appendChild(box);
    return;
  }

  const entry = state.weather[location.id];

  if (!entry || entry.status === 'loading') {
    contentEl.appendChild(buildStatus('Загрузка прогноза…', false));
    return;
  }

  if (entry.status === 'error') {
    const box = el('div', 'status status-error');
    box.appendChild(el('p', '', 'Не удалось загрузить прогноз. Проверьте подключение к интернету и попробуйте ещё раз.'));
    const retry = el('button', 'btn', 'Повторить');
    retry.type = 'button';
    retry.addEventListener('click', () => loadWeather(location));
    box.appendChild(retry);
    contentEl.appendChild(box);
    return;
  }

  contentEl.appendChild(buildCurrent(location, entry));
  contentEl.appendChild(buildForecast(entry));
}

function updateControls() {
  const loading = Object.keys(state.weather).some((key) => state.weather[key].status === 'loading');
  refreshBtn.disabled = state.locations.length === 0 || state.locating || loading;
}

function render() {
  renderTabs();
  renderContent();
  updateControls();
}

function setActive(id) {
  if (state.activeId === id) {
    return;
  }
  state.activeId = id;
  saveState();
  const entry = state.weather[id];
  render();
  if (!entry) {
    const location = getActiveLocation();
    if (location) {
      loadWeather(location);
    }
  }
}

function removeLocation(id) {
  state.locations = state.locations.filter((item) => item.id !== id);
  delete state.weather[id];
  if (state.activeId === id) {
    state.activeId = state.locations.length ? state.locations[0].id : null;
  }
  saveState();
  render();
}

function addLocation(location) {
  state.locations.push(location);
  state.activeId = location.id;
  saveState();
  loadWeather(location);
}

function isDuplicate(city) {
  return state.locations.some((item) => {
    if (item.id === city.id) {
      return true;
    }
    return Math.abs(item.lat - city.lat) < 0.01 && Math.abs(item.lon - city.lon) < 0.01;
  });
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      timeout: 10000,
      maximumAge: 300000
    });
  });
}

async function useGeolocation() {
  state.locating = true;
  render();
  let position = null;
  let failure = null;
  try {
    position = await getPosition();
  } catch (error) {
    failure = error;
  }
  state.locating = false;
  state.geoAsked = true;

  if (!position) {
    saveState();
    render();
    const denied = failure && failure.code === 1;
    openDialog(
      denied
        ? 'Доступ к геопозиции отклонён. Укажите город вручную.'
        : 'Не удалось определить местоположение. Укажите город вручную.'
    );
    return;
  }

  const location = {
    id: GEO_ID,
    name: GEO_NAME,
    lat: position.coords.latitude,
    lon: position.coords.longitude
  };
  const index = state.locations.findIndex((item) => item.id === GEO_ID);
  if (index >= 0) {
    state.locations[index] = location;
  } else {
    state.locations.unshift(location);
  }
  state.activeId = GEO_ID;
  saveState();
  loadWeather(location);
}

function toCity(item) {
  const parts = [item.admin1, item.country].filter((part) => part && part !== item.name);
  return {
    id: 'city-' + item.id,
    name: item.name,
    region: parts.join(', '),
    lat: item.latitude,
    lon: item.longitude
  };
}

async function searchCities(query, count) {
  const params = new URLSearchParams({
    name: query,
    count: String(count),
    language: 'ru',
    format: 'json'
  });
  const data = await fetchJson(GEOCODING_URL + '?' + params.toString());
  const results = data && Array.isArray(data.results) ? data.results : [];
  return results
    .filter((item) => !item.feature_code || item.feature_code.startsWith('PPL'))
    .filter((item) => isNumber(item.latitude) && isNumber(item.longitude))
    .map(toCity);
}

function cityLabel(city) {
  return city.region ? city.name + ', ' + city.region : city.name;
}

function showError(text) {
  errorEl.textContent = text;
  errorEl.hidden = false;
  input.classList.add('is-invalid');
  input.setAttribute('aria-invalid', 'true');
}

function clearError() {
  errorEl.textContent = '';
  errorEl.hidden = true;
  input.classList.remove('is-invalid');
  input.removeAttribute('aria-invalid');
}

function hideSuggestions() {
  suggestions = [];
  highlighted = -1;
  list.textContent = '';
  list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function showSuggestionMessage(text) {
  suggestions = [];
  highlighted = -1;
  list.textContent = '';
  const item = el('li', 'suggestion-message', text);
  item.setAttribute('role', 'presentation');
  list.appendChild(item);
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.removeAttribute('aria-activedescendant');
}

function selectCity(city) {
  selectedCity = city;
  input.value = cityLabel(city);
  hideSuggestions();
  clearError();
}

function renderSuggestions() {
  list.textContent = '';
  highlighted = -1;
  suggestions.forEach((city, index) => {
    const item = el('li', 'suggestion');
    item.id = 'suggestion-' + index;
    item.setAttribute('role', 'option');
    item.appendChild(el('div', 'suggestion-name', city.name));
    if (city.region) {
      item.appendChild(el('div', 'suggestion-region', city.region));
    }
    item.addEventListener('click', () => selectCity(city));
    list.appendChild(item);
  });
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.removeAttribute('aria-activedescendant');
}

function setHighlight(index) {
  const items = list.querySelectorAll('.suggestion');
  items.forEach((item) => item.classList.remove('is-highlighted'));
  highlighted = index;
  if (index >= 0 && items[index]) {
    items[index].classList.add('is-highlighted');
    input.setAttribute('aria-activedescendant', items[index].id);
    items[index].scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

async function fetchSuggestions(query) {
  const seq = ++suggestSeq;
  showSuggestionMessage('Поиск…');
  try {
    const cities = await searchCities(query, 15);
    if (seq !== suggestSeq) {
      return;
    }
    suggestions = cities.slice(0, 7);
    if (suggestions.length) {
      renderSuggestions();
    } else {
      showSuggestionMessage('Ничего не найдено');
    }
  } catch (error) {
    if (seq !== suggestSeq) {
      return;
    }
    showSuggestionMessage('Не удалось загрузить список городов');
  }
}

function resetForm() {
  clearTimeout(suggestTimer);
  suggestSeq++;
  selectedCity = null;
  input.value = '';
  clearError();
  hideSuggestions();
}

function openDialog(note) {
  resetForm();
  if (note) {
    noteEl.textContent = note;
    noteEl.hidden = false;
  } else {
    noteEl.textContent = '';
    noteEl.hidden = true;
  }
  const hasGeo = state.locations.some((item) => item.id === GEO_ID);
  geoBtn.hidden = hasGeo || !('geolocation' in navigator);
  if (!dialog.open) {
    dialog.showModal();
  }
  input.focus();
}

function closeDialog() {
  if (dialog.open) {
    dialog.close();
  }
}

input.addEventListener('input', () => {
  selectedCity = null;
  clearError();
  clearTimeout(suggestTimer);
  suggestSeq++;
  const query = input.value.trim();
  if (query.length < 2) {
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(() => fetchSuggestions(query), SUGGEST_DELAY);
});

input.addEventListener('keydown', (event) => {
  const isOpen = !list.hidden && suggestions.length > 0;
  if (event.key === 'ArrowDown' && isOpen) {
    event.preventDefault();
    setHighlight((highlighted + 1) % suggestions.length);
  } else if (event.key === 'ArrowUp' && isOpen) {
    event.preventDefault();
    setHighlight(highlighted <= 0 ? suggestions.length - 1 : highlighted - 1);
  } else if (event.key === 'Enter' && isOpen && highlighted >= 0) {
    event.preventDefault();
    selectCity(suggestions[highlighted]);
  } else if (event.key === 'Escape' && !list.hidden) {
    event.preventDefault();
    hideSuggestions();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) {
    return;
  }
  clearError();
  const query = input.value.trim();
  if (!query) {
    showError('Введите название города');
    return;
  }

  submitting = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Проверка…';
  clearTimeout(suggestTimer);
  suggestSeq++;

  try {
    let city = selectedCity;
    if (!city) {
      hideSuggestions();
      const found = await searchCities(query, 15);
      if (!found.length) {
        showError('Такой город не найден. Проверьте название.');
        return;
      }
      const exact = found.find((item) => item.name.toLowerCase() === query.toLowerCase());
      if (!exact) {
        suggestions = found.slice(0, 7);
        renderSuggestions();
        showError('Выберите город из выпадающего списка.');
        return;
      }
      city = exact;
    }
    if (isDuplicate(city)) {
      showError('Этот город уже добавлен.');
      return;
    }
    addLocation(city);
    closeDialog();
  } catch (error) {
    showError('Не удалось проверить город. Проверьте подключение и попробуйте ещё раз.');
  } finally {
    submitting = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Добавить';
  }
});

cancelBtn.addEventListener('click', closeDialog);

geoBtn.addEventListener('click', () => {
  closeDialog();
  useGeolocation();
});

dialog.addEventListener('click', (event) => {
  if (event.target === dialog) {
    closeDialog();
    return;
  }
  if (!fieldEl.contains(event.target)) {
    hideSuggestions();
  }
});

dialog.addEventListener('cancel', (event) => {
  if (!list.hidden) {
    event.preventDefault();
    hideSuggestions();
  }
});

dialog.addEventListener('close', () => {
  clearTimeout(suggestTimer);
  suggestSeq++;
  hideSuggestions();
});

refreshBtn.addEventListener('click', () => {
  if (state.locations.length) {
    refreshAll();
  }
});

addBtn.addEventListener('click', () => openDialog());

function init() {
  loadState();
  render();
  if (state.locations.length) {
    refreshAll();
  } else if (!state.geoAsked) {
    useGeolocation();
  }
}

init();
