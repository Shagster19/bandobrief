import { backendReady, supabase, uploadPostMedia } from "./backend.js";

const defaultPoint = { lat: 39.9526, lng: -75.1652, name: "Philadelphia, PA" };

const DATA_ENDPOINTS = {
  uasFacility: "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/FAA_UAS_FacilityMap_Data/FeatureServer/0/query",
  airports: "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services/US_Airport/FeatureServer/0/query",
  nws: "https://api.weather.gov",
  tfr: "https://tfr.faa.gov/",
  notams: "https://notams.aim.faa.gov/notamSearch/"
};

const REQUEST_TIMEOUT = 15000;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

const map = L.map("map", {
  zoomControl: true,
  attributionControl: true,
  preferCanvas: true
}).setView([defaultPoint.lat, defaultPoint.lng], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const markerIcon = L.divIcon({
  className: "",
  html: '<div class="launch-marker"></div>',
  iconSize: [42, 48],
  iconAnchor: [21, 46]
});

const launchMarker = L.marker([defaultPoint.lat, defaultPoint.lng], {
  icon: markerIcon,
  draggable: true,
  zIndexOffset: 1000
}).addTo(map).bindTooltip("PROPOSED LAUNCH", { permanent: true, direction: "top", offset: [0, -43] });

const overlayGroup = L.layerGroup().addTo(map);
const facilityGridGroup = L.layerGroup().addTo(overlayGroup);
const airportGroup = L.layerGroup().addTo(overlayGroup);
const socialGroup = L.layerGroup();
let currentPoint = { ...defaultPoint };
let liveRequestId = 0;
let inspectedPointRequestId = 0;

const radians = value => value * Math.PI / 180;

function distanceMiles(a, b) {
  const earthRadius = 3958.8;
  const latDelta = radians(b.lat - a.lat);
  const lngDelta = radians(b.lng - a.lng);
  const h = Math.sin(latDelta / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lngDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function friendlyCoords(lat, lng) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${ns}\u00a0\u00a0${Math.abs(lng).toFixed(4)}° ${ew}`;
}

function dataUrl(base, params) {
  return `${base}?${new URLSearchParams(params).toString()}`;
}

async function fetchJson(url, options = {}) {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/geo+json, application/json",
          ...(options.headers || {})
        }
      });
      if (!response.ok) throw new Error(`Source returned ${response.status}`);
      const data = await response.json();
      if (data?.error) throw new Error(data.error.message || "Source query failed");
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 450));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function openExternal(url) {
  if (window.Capacitor?.isNativePlatform?.()) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function facilityStyle(feature) {
  const ceiling = Number(feature.properties?.CEILING);
  if (ceiling === 0) {
    return { color: "#c95847", fillColor: "#dc7461", fillOpacity: 0.20, weight: 1.1 };
  }
  return { color: "#26847f", fillColor: "#66aaa3", fillOpacity: 0.10, weight: 0.85 };
}

function drawFacilityGrid(geojson) {
  facilityGridGroup.clearLayers();
  if (!geojson?.features?.length) return;

  L.geoJSON(geojson, {
    style: facilityStyle,
    onEachFeature: (feature, layer) => {
      const properties = feature.properties || {};
      const airport = properties.APT1_NAME || properties.APT1_FAAID || "FAA facility";
      layer.bindTooltip(
        `${properties.CEILING ?? "—"} FT FAA CEILING · ${airport}<br>Informational — not authorization`,
        { sticky: true }
      );
      layer.bindPopup(`
        <strong>${escapeHtml(airport)}</strong><br>
        FAA Facility Map ceiling: <strong>${escapeHtml(properties.CEILING ?? "—")} ft</strong><br>
        ${escapeHtml(properties.AIRSPACE_1 ? `Class ${properties.AIRSPACE_1}` : "Controlled airspace")}<br>
        <small>Informational only — this is not flight authorization.</small>
      `);
    }
  }).addTo(facilityGridGroup);
}

async function loadFacilityData(lat, lng) {
  const pointParams = {
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "CEILING,UNIT,MAP_EFF,LAST_EDIT,APT1_FAAID,APT1_ICAO,APT1_NAME,APT1_LAANC,AIRSPACE_1",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson"
  };

  // Request only the cell beneath the launch pin. Large envelope queries can
  // exhaust the FAA ArcGIS public quota and block the safety-critical point check.
  const pointData = await fetchJson(dataUrl(DATA_ENDPOINTS.uasFacility, pointParams));
  return {
    facility: pointData.features?.[0]?.properties || null,
    gridData: pointData
  };
}

function renderFacility(facility) {
  const statusCard = document.querySelector("#statusCard");
  statusCard.classList.remove("clear", "caution", "restricted");

  if (!facility) {
    statusCard.classList.add("caution");
    document.querySelector("#statusLabel").textContent = "Additional checks required";
    document.querySelector("#statusTitle").textContent = "No FAA Facility Map cell at this pin";
    document.querySelector("#statusDescription").textContent =
      "This does not confirm unrestricted airspace. Check the FAA TFR/NOTAM sources and an approved LAANC provider before flight.";
    document.querySelector("#airspaceClass").textContent = "Outside published UASFM grid";
    document.querySelector("#facilityCeiling").textContent = "No cell";
    document.querySelector("#airspaceDetail").textContent =
      "The FAA publishes Facility Map cells primarily around participating controlled-airspace facilities.";
    return;
  }

  const ceiling = Number(facility.CEILING);
  const airspace = facility.AIRSPACE_1 ? `Class ${facility.AIRSPACE_1}` : "Controlled airspace";
  const airport = facility.APT1_NAME || facility.APT1_FAAID || "FAA facility";
  const effective = facility.MAP_EFF ? ` · effective ${facility.MAP_EFF}` : "";

  document.querySelector("#facilityCeiling").textContent = `${ceiling} ft`;
  document.querySelector("#airspaceClass").textContent = `${airspace} · FAA grid`;
  document.querySelector("#airspaceDetail").textContent = `${airport}${effective}. A Facility Map ceiling is not flight authorization.`;

  if (ceiling === 0) {
    statusCard.classList.add("restricted");
    document.querySelector("#statusLabel").textContent = "FAA grid ceiling 0 ft";
    document.querySelector("#statusTitle").textContent = "Do not launch based on this briefing";
    document.querySelector("#statusDescription").textContent =
      "The published Facility Map cell is 0 ft. Any operation here requires the appropriate FAA process and may require further coordination.";
  } else {
    statusCard.classList.add("caution");
    document.querySelector("#statusLabel").textContent = `${airspace} · authorization required`;
    document.querySelector("#statusTitle").textContent = `FAA grid ceiling ${ceiling} ft`;
    document.querySelector("#statusDescription").textContent =
      "This ceiling is an altitude the FAA may authorize without additional coordination. It is not authorization—submit through LAANC or DroneZone.";
  }
}

async function loadAirportData(lat, lng) {
  const params = {
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: "15",
    units: "esriSRUnit_StatuteMile",
    outFields: "IDENT,NAME,ICAO_ID,TYPE_CODE,OPERSTATUS",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson"
  };
  const data = await fetchJson(dataUrl(DATA_ENDPOINTS.airports, params));
  return (data.features || [])
    .filter(feature => Array.isArray(feature.geometry?.coordinates))
    .map(feature => {
      const [airportLng, airportLat] = feature.geometry.coordinates;
      return {
        ...feature.properties,
        lat: airportLat,
        lng: airportLng,
        distance: distanceMiles({ lat, lng }, { lat: airportLat, lng: airportLng })
      };
    })
    .sort((a, b) => a.distance - b.distance);
}

function titleCase(value) {
  return String(value || "Landing facility")
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function renderAirports(airports) {
  airportGroup.clearLayers();
  const nearest = airports[0];
  if (!nearest) {
    document.querySelector("#airportName").textContent = "No FAA facility found within 15 mi";
    document.querySelector("#airportDistance").textContent = "—";
    document.querySelector("#airportDetail").textContent = "FAA airport query returned no nearby record.";
    return;
  }

  const code = nearest.ICAO_ID || nearest.IDENT || "FAA";
  document.querySelector("#airportName").textContent = `${code} · ${nearest.NAME}`;
  document.querySelector("#airportDistance").textContent = `${nearest.distance.toFixed(1)} mi`;
  document.querySelector("#airportDetail").textContent =
    `${titleCase(nearest.TYPE_CODE)} · ${nearest.OPERSTATUS || "FAA record"} · proximity is not itself a regulatory boundary.`;

  airports.slice(0, 16).forEach(airport => {
    const marker = L.circleMarker([airport.lat, airport.lng], {
      radius: airport === nearest ? 6 : 3.5,
      color: "#173c49",
      fillColor: airport === nearest ? "#d98c27" : "#ffffff",
      fillOpacity: 0.95,
      weight: airport === nearest ? 2 : 1
    });
    marker.bindTooltip(
      `${airport.ICAO_ID || airport.IDENT || "FAA"} · ${airport.NAME}<br>${titleCase(airport.TYPE_CODE)} · ${airport.distance.toFixed(1)} mi`,
      { sticky: true }
    );
    marker.bindPopup(`
      <strong>${escapeHtml(airport.ICAO_ID || airport.IDENT || "FAA")} · ${escapeHtml(airport.NAME)}</strong><br>
      ${escapeHtml(titleCase(airport.TYPE_CODE))} · ${airport.distance.toFixed(1)} mi from your proposed launch point<br>
      <small>${escapeHtml(airport.OPERSTATUS || "FAA record")} — proximity alone is not a regulatory boundary.</small>
    `);
    marker.addTo(airportGroup);
  });
}

async function loadWeatherData(lat, lng) {
  const point = await fetchJson(`${DATA_ENDPOINTS.nws}/points/${lat.toFixed(4)},${lng.toFixed(4)}`);
  const stations = await fetchJson(point.properties.observationStations);
  const stationFeature = stations.features?.[0];
  if (!stationFeature) throw new Error("No NWS observation station found");

  const stationId = stationFeature.properties.stationIdentifier;
  const [observation, alerts] = await Promise.all([
    fetchJson(`${DATA_ENDPOINTS.nws}/stations/${encodeURIComponent(stationId)}/observations/latest`),
    fetchJson(`${DATA_ENDPOINTS.nws}/alerts/active?point=${lat.toFixed(4)},${lng.toFixed(4)}`)
  ]);

  return {
    stationId,
    stationName: stationFeature.properties.name,
    timeZone: point.properties.timeZone,
    observation: observation.properties,
    alerts: alerts.features || []
  };
}

function roundTo(value, precision = 1) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function cloudDescription(amount) {
  return {
    CLR: "Clear",
    SKC: "Sky clear",
    FEW: "Few clouds",
    SCT: "Scattered",
    BKN: "Broken layer",
    OVC: "Overcast",
    VV: "Vertical visibility"
  }[amount] || amount || "No cloud report";
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
}

function solarEvent(date, lat, lng, sunrise, timeZone) {
  const start = Date.UTC(date.year, 0, 0);
  const current = Date.UTC(date.year, date.month - 1, date.day);
  const day = Math.floor((current - start) / 86400000);
  const lngHour = lng / 15;
  const approximate = day + ((sunrise ? 6 : 18) - lngHour) / 24;
  const meanAnomaly = 0.9856 * approximate - 3.289;
  let trueLongitude = meanAnomaly
    + 1.916 * Math.sin(radians(meanAnomaly))
    + 0.02 * Math.sin(radians(2 * meanAnomaly))
    + 282.634;
  trueLongitude = (trueLongitude + 360) % 360;
  let rightAscension = Math.atan(0.91764 * Math.tan(radians(trueLongitude))) * 180 / Math.PI;
  rightAscension = (rightAscension + 360) % 360;
  rightAscension += Math.floor(trueLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
  rightAscension /= 15;
  const sinDeclination = 0.39782 * Math.sin(radians(trueLongitude));
  const cosDeclination = Math.cos(Math.asin(sinDeclination));
  const cosHour = (
    Math.cos(radians(90.833)) - sinDeclination * Math.sin(radians(lat))
  ) / (cosDeclination * Math.cos(radians(lat)));
  if (cosHour > 1 || cosHour < -1) return null;
  let hourAngle = sunrise
    ? 360 - Math.acos(cosHour) * 180 / Math.PI
    : Math.acos(cosHour) * 180 / Math.PI;
  hourAngle /= 15;
  const localMeanTime = hourAngle + rightAscension - 0.06571 * approximate - 6.622;
  const utcHour = ((localMeanTime - lngHour) + 24) % 24;
  const base = Date.UTC(date.year, date.month - 1, date.day);
  const candidates = [-24, 0, 24].map(offset => new Date(base + (utcHour + offset) * 3600000));
  return candidates.find(candidate => {
    const parts = zonedParts(candidate, timeZone);
    return parts.year === date.year && parts.month === date.month && parts.day === date.day;
  }) || candidates[1];
}

function renderDaylight(lat, lng, timeZone) {
  const now = new Date();
  const localDate = zonedParts(now, timeZone);
  const sunrise = solarEvent(localDate, lat, lng, true, timeZone);
  const sunset = solarEvent(localDate, lat, lng, false, timeZone);
  if (!sunrise || !sunset) {
    document.querySelector("#daylightMetric").textContent = "—";
    document.querySelector("#sunsetMetric").textContent = "Solar time unavailable";
    return;
  }

  const formatter = new Intl.DateTimeFormat([], { timeZone, hour: "numeric", minute: "2-digit" });
  if (now < sunrise) {
    const minutes = Math.max(0, Math.round((sunrise - now) / 60000));
    document.querySelector("#daylightMetric").textContent = `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    document.querySelector("#sunsetMetric").textContent = `Sunrise ${formatter.format(sunrise)}`;
  } else if (now < sunset) {
    const minutes = Math.max(0, Math.round((sunset - now) / 60000));
    document.querySelector("#daylightMetric").textContent = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    document.querySelector("#sunsetMetric").textContent = `Sunset ${formatter.format(sunset)}`;
  } else {
    document.querySelector("#daylightMetric").textContent = "Ended";
    document.querySelector("#sunsetMetric").textContent = `Sunset ${formatter.format(sunset)}`;
  }
}

function renderWeather(data, lat, lng) {
  const observation = data.observation;
  const windKmh = observation.windSpeed?.value;
  const gustKmh = observation.windGust?.value;
  const visibilityMeters = observation.visibility?.value;
  const cloud = (observation.cloudLayers || []).find(layer => Number.isFinite(layer.base?.value));
  const windMph = Number.isFinite(windKmh) ? Math.round(windKmh * 0.621371) : null;
  const gustMph = Number.isFinite(gustKmh) ? Math.round(gustKmh * 0.621371) : null;
  const visibilityMiles = Number.isFinite(visibilityMeters) ? roundTo(visibilityMeters / 1609.344, 1) : null;
  const cloudFeet = cloud ? Math.round(cloud.base.value * 3.28084 / 100) * 100 : null;

  document.querySelector("#windMetric").innerHTML = windMph === null ? "—" : `${windMph} <em>mph</em>`;
  document.querySelector("#gustMetric").textContent = gustMph === null ? "No gust report" : `Gusts ${gustMph} mph`;
  document.querySelector("#visibilityMetric").innerHTML =
    visibilityMiles === null ? "—" : `${visibilityMiles} <em>mi</em>`;
  document.querySelector("#visibilityDetail").textContent =
    visibilityMiles === null ? "No visibility report" : visibilityMiles >= 6 ? "Good visibility" : "Reduced visibility";
  document.querySelector("#cloudMetric").innerHTML =
    cloudFeet === null ? "Clear" : `${cloudFeet.toLocaleString()} <em>ft</em>`;
  document.querySelector("#cloudDetail").textContent = cloudDescription(cloud?.amount);

  const observed = new Date(observation.timestamp);
  const formatter = new Intl.DateTimeFormat([], {
    timeZone: data.timeZone,
    hour: "numeric",
    minute: "2-digit"
  });
  document.querySelector("#weatherFreshness").textContent =
    `NWS ${data.stationId} · ${formatter.format(observed)}`;
  renderDaylight(lat, lng, data.timeZone);
  renderWeatherAlerts(data.alerts);
}

function renderWeatherAlerts(alerts) {
  const notice = document.querySelector("#weatherAlertNotice");
  notice.classList.remove("good", "warning", "neutral");
  if (!alerts.length) {
    notice.classList.add("good");
    notice.removeAttribute("data-url");
    document.querySelector("#weatherAlertTitle").textContent = "No active NWS weather alerts";
    document.querySelector("#weatherAlertCount").textContent = "Current";
    document.querySelector("#weatherAlertDetail").textContent =
      "No active National Weather Service alerts were returned for this point.";
    return;
  }

  const alert = alerts[0].properties || {};
  notice.classList.add("warning");
  if (alert.web || alert["@id"]) notice.dataset.url = alert.web || alert["@id"];
  document.querySelector("#weatherAlertTitle").textContent = alert.event || "Active NWS weather alert";
  document.querySelector("#weatherAlertCount").textContent = `${alerts.length} active`;
  document.querySelector("#weatherAlertDetail").textContent =
    (alert.headline || alert.description || "Open the alert for details").slice(0, 150);
}

function setLiveLoading() {
  document.querySelector("#weatherFreshness").textContent = "Loading NWS…";
  document.querySelector("#facilityCeiling").textContent = "…";
  document.querySelector("#airportDistance").textContent = "…";
  document.querySelector("#refreshData").classList.add("loading");
}

async function refreshRealData({ announce = false } = {}) {
  const requestId = ++liveRequestId;
  const { lat, lng } = currentPoint;
  setLiveLoading();

  const results = await Promise.allSettled([
    loadFacilityData(lat, lng),
    loadAirportData(lat, lng),
    loadWeatherData(lat, lng)
  ]);
  if (requestId !== liveRequestId) return;

  const [facilityResult, airportResult, weatherResult] = results;
  let failures = 0;

  if (facilityResult.status === "fulfilled") {
    drawFacilityGrid(facilityResult.value.gridData);
    renderFacility(facilityResult.value.facility);
  } else {
    failures += 1;
    facilityGridGroup.clearLayers();
    const statusCard = document.querySelector("#statusCard");
    statusCard.classList.remove("clear", "restricted");
    statusCard.classList.add("caution");
    document.querySelector("#statusLabel").textContent = "FAA data unavailable";
    document.querySelector("#statusTitle").textContent = "Airspace status could not be checked";
    document.querySelector("#statusDescription").textContent =
      "Do not infer that this location is clear. Use an official FAA source or approved LAANC provider.";
    document.querySelector("#airspaceClass").textContent = "FAA source unavailable";
    document.querySelector("#facilityCeiling").textContent = "Not checked";
    document.querySelector("#airspaceDetail").textContent = "Retry or open the official FAA tools before flight.";
  }

  if (airportResult.status === "fulfilled") {
    renderAirports(airportResult.value);
  } else {
    failures += 1;
    airportGroup.clearLayers();
    document.querySelector("#airportName").textContent = "FAA airport data unavailable";
    document.querySelector("#airportDistance").textContent = "Not checked";
    document.querySelector("#airportDetail").textContent = "Nearby airports and heliports could not be loaded.";
  }

  if (weatherResult.status === "fulfilled") {
    renderWeather(weatherResult.value, lat, lng);
  } else {
    failures += 1;
    document.querySelector("#windMetric").textContent = "—";
    document.querySelector("#gustMetric").textContent = "NWS unavailable";
    document.querySelector("#visibilityMetric").textContent = "—";
    document.querySelector("#visibilityDetail").textContent = "Not checked";
    document.querySelector("#cloudMetric").textContent = "—";
    document.querySelector("#cloudDetail").textContent = "Not checked";
    document.querySelector("#weatherFreshness").textContent = "NWS unavailable";
    const notice = document.querySelector("#weatherAlertNotice");
    notice.classList.remove("good", "warning");
    notice.classList.add("neutral");
    document.querySelector("#weatherAlertTitle").textContent = "NWS alerts unavailable";
    document.querySelector("#weatherAlertCount").textContent = "Not checked";
    document.querySelector("#weatherAlertDetail").textContent =
      "Retry before flight and consult an official weather source.";
  }

  document.querySelector("#refreshData").classList.remove("loading");
  const now = new Date();
  document.querySelector("#briefingTime").textContent =
    `${failures ? "Partial live data" : "Live sources updated"} ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · FAA/NWS`;
  if (announce) {
    showToast(failures ? `${failures} live source${failures > 1 ? "s" : ""} unavailable` : "Live FAA and NWS data refreshed");
  }
}

function updateBriefing(lat, lng, name, moveMap = true) {
  currentPoint = { lat, lng, name: name || "Dropped pin" };

  document.querySelector("#locationName").textContent = name || "Dropped pin";
  document.querySelector("#attachedLocation").textContent = name || "Dropped pin";
  document.querySelector("#coordinateReadout").innerHTML = friendlyCoords(lat, lng);

  launchMarker.setLatLng([lat, lng]);
  if (moveMap) map.flyTo([lat, lng], 12, { duration: 0.7 });
  refreshRealData();
}

function pointInfoContent(lat, lng, facility) {
  const airport = facility?.APT1_NAME || facility?.APT1_FAAID || "No FAA Facility Map cell";
  const ceiling = facility ? `${facility.CEILING ?? "—"} ft` : "No published cell";
  const airspace = facility?.AIRSPACE_1 ? `Class ${facility.AIRSPACE_1}` : "Additional checks required";
  return `
    <div class="map-point-info">
      <strong>Selected map point</strong>
      <span>${friendlyCoords(lat, lng)}</span>
      <p><b>${escapeHtml(airport)}</b><br>${escapeHtml(airspace)} · FAA ceiling: ${escapeHtml(ceiling)}</p>
      <small>Viewing this point does not move your proposed launch marker.</small>
      <button type="button" data-use-inspected-point data-lat="${lat}" data-lng="${lng}">Use as proposed launch point</button>
    </div>`;
}

async function openPointInfo(lat, lng) {
  const requestId = ++inspectedPointRequestId;
  const popup = L.popup({ maxWidth: 275 })
    .setLatLng([lat, lng])
    .setContent("<div class=\"map-point-info\"><strong>Selected map point</strong><p>Loading FAA point information…</p><small>Your proposed launch marker has not moved.</small></div>")
    .openOn(map);
  try {
    const { facility } = await loadFacilityData(lat, lng);
    if (requestId === inspectedPointRequestId) popup.setContent(pointInfoContent(lat, lng, facility));
  } catch {
    if (requestId === inspectedPointRequestId) {
      popup.setContent(`<div class="map-point-info"><strong>Selected map point</strong><span>${friendlyCoords(lat, lng)}</span><p>FAA point information is unavailable right now.</p><small>Your proposed launch marker has not moved.</small><button type="button" data-use-inspected-point data-lat="${lat}" data-lng="${lng}">Use as proposed launch point</button></div>`);
    }
  }
}

map.on("click", event => openPointInfo(event.latlng.lat, event.latlng.lng));

document.querySelector("#map").addEventListener("click", event => {
  const button = event.target.closest("[data-use-inspected-point]");
  if (!button) return;
  updateBriefing(Number(button.dataset.lat), Number(button.dataset.lng), "Dropped pin", false);
  map.closePopup();
  showToast("Proposed launch point updated");
});

launchMarker.on("dragend", event => {
  const point = event.target.getLatLng();
  updateBriefing(point.lat, point.lng, "Dropped pin", false);
});

document.querySelector("#searchForm").addEventListener("submit", async event => {
  event.preventDefault();
  const query = document.querySelector("#locationSearch").value.trim();
  if (!query) return;

  const submitButton = event.currentTarget.querySelector("button");
  const originalText = submitButton.textContent;
  submitButton.textContent = "Searching…";
  submitButton.disabled = true;

  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) throw new Error("Search failed");
    const results = await response.json();
    if (!results.length) {
      showToast("Location not found — try a city or full address");
      return;
    }
    const result = results[0];
    const name = result.display_name.split(",").slice(0, 2).join(",");
    updateBriefing(Number(result.lat), Number(result.lon), name);
  } catch (error) {
    showToast("Search is unavailable right now — drop a pin instead");
  } finally {
    submitButton.textContent = originalText;
    submitButton.disabled = false;
  }
});

document.querySelector("#locateButton").addEventListener("click", async () => {
  showToast("Finding your location…");

  if (window.Capacitor?.isNativePlatform?.()) {
    try {
      const { Geolocation } = await import("@capacitor/geolocation");
      const permission = await Geolocation.requestPermissions({ permissions: ["location"] });
      if (permission.location !== "granted" && permission.coarseLocation !== "granted") {
        showToast("Location permission is needed to center the map");
        return;
      }
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60000
      });
      updateBriefing(position.coords.latitude, position.coords.longitude, "Current location");
      return;
    } catch (error) {
      showToast("Location access was unavailable");
      return;
    }
  }

  if (!navigator.geolocation) {
    showToast("Location access is not available in this browser");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    position => updateBriefing(position.coords.latitude, position.coords.longitude, "Current location"),
    () => showToast("Location access was unavailable"),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
});

let overlaysVisible = true;
document.querySelector("#layersButton").classList.add("active");
document.querySelector("#layersButton").addEventListener("click", event => {
  overlaysVisible = !overlaysVisible;
  if (overlaysVisible) overlayGroup.addTo(map);
  else overlayGroup.removeFrom(map);
  event.currentTarget.classList.toggle("active", overlaysVisible);
  event.currentTarget.setAttribute("aria-pressed", String(overlaysVisible));
  showToast(overlaysVisible ? "FAA Facility Map layers on" : "FAA Facility Map layers off");
});

const FLIGHT_PLANS_KEY = "bandobrief.prototype.flight-plans";
const REVIEW_RECORDS_KEY = "bandobrief.prototype.preflight-reviews";
const planDateInput = document.querySelector("#planDate");
const planTimeInput = document.querySelector("#planTime");
const reviewButton = document.querySelector("#recordReviewButton");
const reviewRecord = document.querySelector("#reviewRecord");

function readLocalList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeLocalList(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { showToast("Could not save on this device"); }
}

function formatPlanDate(date, time) {
  if (!date) return "Date not set";
  const readable = new Date(`${date}T${time || "12:00"}`).toLocaleDateString([], { month: "short", day: "numeric" });
  return `${readable}${time ? ` · ${new Date(`${date}T${time}`).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`;
}

function renderSavedPlans() {
  const plans = readLocalList(FLIGHT_PLANS_KEY);
  const list = document.querySelector("#savedPlanList");
  document.querySelector("#savedPlanCount").textContent = `${plans.length} saved`;
  if (!plans.length) {
    list.innerHTML = '<p class="saved-plan-empty">No saved flight plans yet.</p>';
    return;
  }
  list.innerHTML = plans.map(plan => `
    <article class="saved-plan">
      <div><strong>${escapeHtml(plan.location)}</strong><small>${plan.altitude} ft AGL · ${formatPlanDate(plan.date, plan.time)}</small></div>
      <button type="button" data-delete-plan="${plan.id}" aria-label="Delete saved plan for ${escapeHtml(plan.location)}">Delete</button>
    </article>`).join("");
}

function saveFlightPlan() {
  const altitude = Number(document.querySelector("#planAltitude").value);
  if (!Number.isFinite(altitude) || altitude < 0 || altitude > 400) {
    showToast("Set an altitude between 0 and 400 ft AGL");
    return;
  }
  const plans = readLocalList(FLIGHT_PLANS_KEY);
  plans.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    location: currentPoint.name || "Dropped pin",
    lat: currentPoint.lat,
    lng: currentPoint.lng,
    altitude,
    drone: document.querySelector("#planDrone").value.trim(),
    date: planDateInput.value,
    time: planTimeInput.value,
    notes: document.querySelector("#planNotes").value.trim(),
    savedAt: new Date().toISOString()
  });
  writeLocalList(FLIGHT_PLANS_KEY, plans.slice(0, 12));
  renderSavedPlans();
  showToast("Flight plan saved on this device");
}

function updateChecklistProgress() {
  const boxes = [...document.querySelectorAll(".checklist input")];
  const completed = boxes.filter(box => box.checked).length;
  const allComplete = completed === boxes.length;
  document.querySelector("#checkProgress").textContent = `${completed} of ${boxes.length}`;
  document.querySelector("#progressFill").style.width = `${completed / boxes.length * 100}%`;
  reviewButton.disabled = !allComplete;
  reviewButton.textContent = allComplete ? "Record completed preflight review" : "Complete all checks to record this review";
  if (allComplete) showToast("Preflight checklist complete");
}

function renderLatestReview() {
  const latest = readLocalList(REVIEW_RECORDS_KEY)[0];
  if (!latest) return;
  reviewRecord.hidden = false;
  reviewRecord.textContent = `Last recorded: ${latest.location} · ${new Date(latest.recordedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

document.querySelectorAll(".checklist input").forEach(input => input.addEventListener("change", updateChecklistProgress));
document.querySelector("#saveBriefButton").addEventListener("click", saveFlightPlan);
document.querySelector("#savedPlanList").addEventListener("click", event => {
  const id = event.target.dataset.deletePlan;
  if (!id) return;
  writeLocalList(FLIGHT_PLANS_KEY, readLocalList(FLIGHT_PLANS_KEY).filter(plan => plan.id !== id));
  renderSavedPlans();
  showToast("Saved flight plan deleted");
});
reviewButton.addEventListener("click", () => {
  const reviews = readLocalList(REVIEW_RECORDS_KEY);
  reviews.unshift({ location: currentPoint.name || "Dropped pin", lat: currentPoint.lat, lng: currentPoint.lng, recordedAt: new Date().toISOString() });
  writeLocalList(REVIEW_RECORDS_KEY, reviews.slice(0, 24));
  renderLatestReview();
  showToast("Completed preflight review recorded");
});

const prototypeNow = new Date();
planDateInput.value = prototypeNow.toISOString().slice(0, 10);
planTimeInput.value = prototypeNow.toTimeString().slice(0, 5);
renderSavedPlans();
renderLatestReview();
updateChecklistProgress();

let toastTimer;
function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2300);
}

document.querySelector("#expandNotices").addEventListener("click", () => {
  openExternal(DATA_ENDPOINTS.notams);
});

document.querySelectorAll(".notice").forEach(notice => {
  notice.addEventListener("click", () => {
    if (notice.dataset.url) {
      openExternal(notice.dataset.url);
    }
  });
});

document.querySelector("#refreshData").addEventListener("click", () => refreshRealData({ announce: true }));

const dialog = document.querySelector("#aboutDialog");
document.querySelector("#helpButton").addEventListener("click", () => dialog.showModal());
document.querySelector("#closeDialog").addEventListener("click", () => dialog.close());
document.querySelector("#dialogGotIt").addEventListener("click", () => dialog.close());

const AUTH_SESSION_KEY = "bandobrief.prototype.session";
const authScreen = document.querySelector("#authScreen");
const profileScreen = document.querySelector("#profileScreen");
const accountButton = document.querySelector("#accountButton");
const authTabs = [...document.querySelectorAll("[data-auth-view]")];
const authForms = [...document.querySelectorAll("[data-auth-form]")];

function readPrototypeSession() {
  try {
    const profile = JSON.parse(sessionStorage.getItem(AUTH_SESSION_KEY) || "null");
    if (profile && !profile.guest && !profile.username) {
      const legacyParts = String(profile.name || "").trim().split(/\s+/).filter(Boolean);
      const migratedHandle = normalizePilotHandle(profile.name)
        || normalizePilotHandle(profile.email?.split("@")[0])
        || "pilot";
      return {
        ...profile,
        username: migratedHandle,
        name: migratedHandle,
        firstName: profile.firstName || legacyParts[0] || "",
        lastName: profile.lastName || legacyParts.slice(1).join(" ")
      };
    }
    return profile;
  } catch {
    return null;
  }
}

function savePrototypeSession(profile) {
  try {
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(profile));
  } catch {
    // Account preview still works for this page if storage is unavailable.
  }
}

function normalizePilotHandle(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 24);
}

function publicPilotName(profile) {
  const fullName = [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim();
  return fullName || profile?.username || profile?.name || profile?.email?.split("@")[0] || "Pilot";
}

function pilotHandleLabel(profile) {
  const handle = profile?.username || profile?.name || profile?.email?.split("@")[0] || "pilot";
  return `@${normalizePilotHandle(handle) || "pilot"}`;
}

function applyPilotImage(element, image, fallback) {
  element.textContent = fallback;
  element.classList.toggle("has-photo", Boolean(image));
  element.style.backgroundImage = image ? `url("${image}")` : "";
}

function updateAccountButton(profile) {
  const isPilot = profile && !profile.guest;
  const name = isPilot ? pilotHandleLabel(profile) : "Log in";
  document.querySelector("#accountLabel").textContent = name;
  applyPilotImage(document.querySelector("#accountAvatar"), profile?.avatar, isPilot ? name.trim().charAt(0).toUpperCase() : "P");
  const composerAvatar = document.querySelector(".composer-main .pilot-avatar.self");
  if (composerAvatar) applyPilotImage(composerAvatar, profile?.avatar, isPilot ? name.trim().charAt(0).toUpperCase() : "P");
  accountButton.setAttribute("aria-label", isPilot ? `Account for ${name}` : "Log in or create an account");
}

async function remoteProfileForUser(user) {
  if (!backendReady || !user) return null;
  const { data } = await supabase.from("profiles").select("handle, first_name, last_name, home, drone, hide_exact_location, show_activity").eq("id", user.id).maybeSingle();
  return {
    id: user.id,
    guest: false,
    email: user.email,
    username: data?.handle || normalizePilotHandle(user.user_metadata?.handle || user.email?.split("@")[0]),
    name: data?.handle || normalizePilotHandle(user.user_metadata?.handle || user.email?.split("@")[0]),
    firstName: data?.first_name || "",
    lastName: data?.last_name || "",
    home: data?.home || "",
    drone: data?.drone || "",
    hideExact: data?.hide_exact_location !== false,
    showActivity: data?.show_activity !== false
  };
}

async function hydrateRemoteSession() {
  if (!backendReady) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const profile = await remoteProfileForUser(user);
  savePrototypeSession(profile);
  updateAccountButton(profile);
}

function switchAuthView(view) {
  const isSignup = view === "signup";
  authTabs.forEach(tab => {
    const active = tab.dataset.authView === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  authForms.forEach(form => {
    const active = form.dataset.authForm === view;
    form.hidden = !active;
    form.classList.toggle("active", active);
  });
  document.querySelector("#authTitle").textContent = isSignup ? "Join the pilot community" : "Welcome back";
  document.querySelector("#authSubtitle").textContent = isSignup
    ? "Create a profile for saved briefs, trusted spots, and local pilot connections."
    : "Log in to keep your briefs, spots, and pilot profile together.";
}

function openAuth(view = "login") {
  switchAuthView(view);
  authScreen.hidden = false;
  document.body.classList.add("auth-open");
  const profile = readPrototypeSession();
  if (profile?.email) {
    document.querySelector('#loginForm input[name="email"]').value = profile.email;
  }
  setTimeout(() => {
    authScreen.querySelector(`form[data-auth-form="${view}"] input`)?.focus();
  }, 80);
}

function closeAuth() {
  authScreen.hidden = true;
  document.body.classList.remove("auth-open");
}

function renderPilotProfile(profile) {
  if (!profile || profile.guest) return;
  const username = profile.username || profile.name || profile.email?.split("@")[0] || "pilot";
  const handleLabel = pilotHandleLabel(profile);
  const realName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || "Pilot name not added";
  const initial = username.trim().charAt(0).toUpperCase();
  applyPilotImage(document.querySelector("#profileAvatar"), profile.avatar, initial);
  document.querySelector("#profileName").textContent = handleLabel;
  document.querySelector("#profileHandle").textContent = realName;
  document.querySelector("#profileEmail").textContent = profile.email || "Local pilot profile";
  document.querySelector("#profileHome").textContent = profile.home || "Not added";
  document.querySelector("#profileDrone").textContent = profile.drone || "Not added";
  document.querySelector("#profileHideExact").checked = profile.hideExact !== false;
  document.querySelector("#profileShowActivity").checked = profile.showActivity !== false;
  const communityPrivacy = document.querySelector("#privacyButton");
  const hidesExact = profile.hideExact !== false;
  communityPrivacy.setAttribute("aria-pressed", String(hidesExact));
  communityPrivacy.textContent = hidesExact ? "On" : "Off";
  document.querySelector(".privacy-card").classList.toggle("off", !hidesExact);
  document.querySelector("#profilePostCount").textContent =
    String(document.querySelectorAll("#communityFeed .pilot-avatar.self").length);
}

function openPilotProfile() {
  const profile = readPrototypeSession();
  if (!profile || profile.guest) {
    openAuth("login");
    return;
  }
  renderPilotProfile(profile);
  profileScreen.hidden = false;
  document.body.classList.add("auth-open");
}

function closePilotProfile() {
  profileScreen.hidden = true;
  document.querySelector("#profileEditForm").hidden = true;
  document.querySelector("#profileDetails").hidden = false;
  document.querySelector("#editProfileButton").textContent = "Edit";
  document.body.classList.remove("auth-open");
}

function continueAsGuest() {
  const profile = { guest: true, name: "Guest pilot" };
  savePrototypeSession(profile);
  updateAccountButton(profile);
  closeAuth();
  showToast("Exploring BandoBrief as a guest");
}

authTabs.forEach(tab => tab.addEventListener("click", () => switchAuthView(tab.dataset.authView)));
accountButton.addEventListener("click", () => {
  const profile = readPrototypeSession();
  if (profile && !profile.guest) {
    openPilotProfile();
  } else {
    openAuth("login");
  }
});
document.querySelector("#authClose").addEventListener("click", continueAsGuest);
document.querySelector("#guestButton").addEventListener("click", continueAsGuest);
document.querySelector("#forgotPassword").addEventListener("click", () => {
  showToast("Password recovery will be enabled with the secure account backend");
});

document.querySelectorAll(".password-toggle").forEach(button => {
  button.addEventListener("click", () => {
    const input = button.parentElement.querySelector("input");
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.textContent = reveal ? "Hide" : "Show";
    button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
  });
});

let selectedPilotAvatar = "";
document.querySelector("#pilotAvatarInput").addEventListener("change", event => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  if (!/^(image\/(jpeg|png|webp))$/.test(file.type) || file.size > 10 * 1024 * 1024) {
    event.currentTarget.value = "";
    showToast("Use a JPG, PNG, or WebP image up to 10 MB");
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    selectedPilotAvatar = String(reader.result);
    applyPilotImage(document.querySelector("#pilotPhotoPreview"), selectedPilotAvatar, "P");
  });
  reader.readAsDataURL(file);
});

document.querySelector("#profileAvatarInput").addEventListener("change", event => {
  const file = event.currentTarget.files?.[0];
  const profile = readPrototypeSession();
  if (!file || !profile || profile.guest) return;
  if (!/^(image\/(jpeg|png|webp))$/.test(file.type) || file.size > 10 * 1024 * 1024) {
    event.currentTarget.value = "";
    showToast("Use a JPG, PNG, or WebP image up to 10 MB");
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const updated = { ...profile, avatar: String(reader.result) };
    savePrototypeSession(updated);
    updateAccountButton(updated);
    renderPilotProfile(updated);
    showToast("Profile picture updated");
  });
  reader.readAsDataURL(file);
});

document.querySelector("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const email = String(formData.get("email")).trim();
  const password = String(formData.get("password"));
  if (backendReady) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { showToast(error.message); return; }
    const profile = await remoteProfileForUser(data.user);
    savePrototypeSession(profile);
    updateAccountButton(profile);
    event.currentTarget.querySelector('input[name="password"]').value = "";
    closeAuth();
    showToast(`Welcome back, ${profile.name}`);
    return;
  }
  const priorProfile = readPrototypeSession();
  const fallbackHandle = normalizePilotHandle(email.split("@")[0]);
  const matchingProfile = priorProfile?.email === email ? priorProfile : {};
  const savedHandle = matchingProfile.username || matchingProfile.name || "";
  const profile = {
    ...matchingProfile,
    guest: false,
    email,
    username: savedHandle || fallbackHandle,
    name: savedHandle || fallbackHandle
  };
  savePrototypeSession(profile);
  updateAccountButton(profile);
  event.currentTarget.querySelector('input[name="password"]').value = "";
  closeAuth();
  showToast(`Welcome back, ${profile.name}`);
});

document.querySelector("#signupForm").addEventListener("submit", async event => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const pilotHandle = normalizePilotHandle(formData.get("pilotHandle"));
  const email = String(formData.get("email")).trim();
  const password = String(formData.get("password"));
  if (backendReady) {
    if (pilotHandle.length < 3) { showToast("Choose a pilot handle with at least 3 characters"); return; }
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: {
        emailRedirectTo: "https://shagster19.github.io/bandobrief/",
        data: { handle: pilotHandle, first_name: String(formData.get("firstName")).trim(), last_name: String(formData.get("lastName")).trim() }
      }
    });
    if (error) { showToast(error.message); return; }
    if (data.session) {
      const profile = await remoteProfileForUser(data.user);
      savePrototypeSession(profile);
      updateAccountButton(profile);
      closeAuth();
      showToast(`Welcome to BandoBrief, @${pilotHandle}`);
    } else {
      showToast("Check your email to confirm your beta account");
    }
    event.currentTarget.querySelector('input[name="password"]').value = "";
    return;
  }
  const profile = {
    guest: false,
    email,
    username: pilotHandle,
    name: pilotHandle,
    firstName: String(formData.get("firstName")).trim(),
    lastName: String(formData.get("lastName")).trim(),
    avatar: selectedPilotAvatar
  };
  savePrototypeSession(profile);
  updateAccountButton(profile);
  event.currentTarget.querySelector('input[name="password"]').value = "";
  closeAuth();
  selectedPilotAvatar = "";
  applyPilotImage(document.querySelector("#pilotPhotoPreview"), "", "P");
  showToast(`Welcome to BandoBrief, @${pilotHandle}`);
});

document.querySelectorAll("[data-profile-close]").forEach(button => {
  button.addEventListener("click", closePilotProfile);
});

document.querySelector("#editProfileButton").addEventListener("click", () => {
  const profile = readPrototypeSession();
  if (!profile || profile.guest) return;
  const form = document.querySelector("#profileEditForm");
  form.elements.pilotHandle.value = profile.username || profile.name || "";
  form.elements.firstName.value = profile.firstName || "";
  form.elements.lastName.value = profile.lastName || "";
  form.elements.home.value = profile.home || "";
  form.elements.drone.value = profile.drone || "";
  document.querySelector("#profileDetails").hidden = true;
  form.hidden = false;
  document.querySelector("#editProfileButton").textContent = "Editing";
  form.elements.pilotHandle.focus();
});

document.querySelector("#cancelProfileEdit").addEventListener("click", () => {
  document.querySelector("#profileEditForm").hidden = true;
  document.querySelector("#profileDetails").hidden = false;
  document.querySelector("#editProfileButton").textContent = "Edit";
});

document.querySelector("#profileEditForm").addEventListener("submit", event => {
  event.preventDefault();
  const profile = readPrototypeSession();
  if (!profile || profile.guest) return;
  const formData = new FormData(event.currentTarget);
  const pilotHandle = normalizePilotHandle(formData.get("pilotHandle"));
  const updated = {
    ...profile,
    username: pilotHandle,
    name: pilotHandle,
    firstName: String(formData.get("firstName")).trim(),
    lastName: String(formData.get("lastName")).trim(),
    home: String(formData.get("home")).trim(),
    drone: String(formData.get("drone")).trim()
  };
  savePrototypeSession(updated);
  updateAccountButton(updated);
  renderPilotProfile(updated);
  event.currentTarget.hidden = true;
  document.querySelector("#profileDetails").hidden = false;
  document.querySelector("#editProfileButton").textContent = "Edit";
  showToast("Pilot profile updated");
});

["profileHideExact", "profileShowActivity"].forEach(id => {
  document.querySelector(`#${id}`).addEventListener("change", () => {
    const profile = readPrototypeSession();
    if (!profile || profile.guest) return;
    const updated = {
      ...profile,
      hideExact: document.querySelector("#profileHideExact").checked,
      showActivity: document.querySelector("#profileShowActivity").checked
    };
    savePrototypeSession(updated);
    if (id === "profileHideExact") renderPilotProfile(updated);
    showToast("Privacy preference saved for this session");
  });
});

document.querySelector("#signOutButton").addEventListener("click", () => {
  if (backendReady) supabase.auth.signOut();
  try {
    sessionStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    // The visible account state is still reset when storage is unavailable.
  }
  updateAccountButton(null);
  closePilotProfile();
  openAuth("login");
});

hydrateRemoteSession();

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !profileScreen.hidden) closePilotProfile();
});

const viewButtons = [...document.querySelectorAll(".view-switch button")];
const briefView = document.querySelector("#briefView");
const communityView = document.querySelector("#communityView");

viewButtons.forEach(button => {
  button.addEventListener("click", () => {
    const showCommunity = button.dataset.view === "community";
    viewButtons.forEach(item => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });

    briefView.hidden = showCommunity;
    communityView.hidden = !showCommunity;
    briefView.classList.toggle("active", !showCommunity);
    communityView.classList.toggle("active", showCommunity);
    document.body.classList.toggle("community-active", showCommunity);

    if (showCommunity) {
      socialGroup.removeFrom(map);
      loadLiveCommunityPosts();
      showToast("Community is now a full-page view");
    } else {
      socialGroup.removeFrom(map);
      setTimeout(() => map.invalidateSize(), 50);
    }
    history.replaceState(null, "", showCommunity ? "#community" : "#brief");
  });
});

const privacyButton = document.querySelector("#privacyButton");
privacyButton.addEventListener("click", () => {
  const isOn = privacyButton.getAttribute("aria-pressed") === "true";
  privacyButton.setAttribute("aria-pressed", String(!isOn));
  privacyButton.textContent = isOn ? "Off" : "On";
  document.querySelector(".privacy-card").classList.toggle("off", isOn);
  const profile = readPrototypeSession();
  if (profile && !profile.guest) {
    savePrototypeSession({ ...profile, hideExact: !isOn });
  }
  showToast(isOn ? "Spot privacy preview turned off" : "Exact launch pin is hidden");
});

const postInput = document.querySelector("#postInput");
const postButton = document.querySelector("#postButton");
const attachedSpot = document.querySelector("#attachedSpot");
const mediaInput = document.querySelector("#postMediaInput");
const mediaPreview = document.querySelector("#mediaPreview");
let selectedMedia = [];
let spotAttached = false;

function updatePostButton() {
  postButton.disabled = !postInput.value.trim();
}

postInput.addEventListener("input", updatePostButton);

document.querySelector("#attachSpotButton").addEventListener("click", event => {
  spotAttached = !spotAttached;
  attachedSpot.hidden = !spotAttached;
  event.currentTarget.classList.toggle("active", spotAttached);
  document.querySelector("#attachedLocation").textContent = currentPoint.name || "Dropped pin";
});

document.querySelector("#removeSpot").addEventListener("click", () => {
  spotAttached = false;
  attachedSpot.hidden = true;
  document.querySelector("#attachSpotButton").classList.remove("active");
});

document.querySelector("#attachWeatherButton").addEventListener("click", event => {
  event.currentTarget.classList.toggle("active");
  showToast(event.currentTarget.classList.contains("active") ? "Current briefing attached" : "Briefing removed");
});

function renderMediaPreview() {
  mediaPreview.hidden = !selectedMedia.length;
  mediaPreview.replaceChildren();
  selectedMedia.forEach((file, index) => {
    const figure = document.createElement("figure");
    const preview = document.createElement(file.type.startsWith("video/") ? "video" : "img");
    const objectUrl = URL.createObjectURL(file);
    preview.src = objectUrl;
    if (preview.tagName === "VIDEO") { preview.muted = true; preview.playsInline = true; }
    preview.onload = preview.onloadeddata = () => URL.revokeObjectURL(objectUrl);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.addEventListener("click", () => {
      selectedMedia.splice(index, 1);
      renderMediaPreview();
    });
    figure.append(preview, remove);
    mediaPreview.append(figure);
  });
}

document.querySelector("#attachMediaButton").addEventListener("click", () => mediaInput.click());
mediaInput.addEventListener("change", () => {
  const incoming = [...mediaInput.files];
  const invalid = incoming.find(file => !/^(image\/(jpeg|png|webp)|video\/(mp4|quicktime))$/.test(file.type) || file.size > 250 * 1024 * 1024);
  if (invalid) { showToast("Use JPG, PNG, WebP, MP4, or MOV files up to 250 MB"); mediaInput.value = ""; return; }
  selectedMedia = [...selectedMedia, ...incoming].slice(0, 5);
  mediaInput.value = "";
  renderMediaPreview();
});

function makeUserPost(message, media = []) {
  const article = document.createElement("article");
  article.className = "feed-card compact-post";
  article.dataset.category = "nearby following";

  const header = document.createElement("header");
  header.className = "post-author";
  const profile = readPrototypeSession();
  const username = profile && !profile.guest ? profile.username || profile.name || "localpilot" : "guestpilot";
  const displayName = profile && !profile.guest ? pilotHandleLabel(profile) : "@guestpilot";
  const realName = profile && !profile.guest ? publicPilotName(profile) : "Guest pilot";
  header.innerHTML = '<span class="pilot-avatar self"></span><div><strong></strong><p><span class="post-handle"></span> · now · <span>Approximate area</span></p></div><button aria-label="Post options">•••</button>';
  header.querySelector(".pilot-avatar").textContent = displayName.charAt(0).toUpperCase();
  applyPilotImage(header.querySelector(".pilot-avatar"), profile?.avatar, displayName.charAt(0).toUpperCase());
  header.querySelector("strong").textContent = displayName;
  header.querySelector(".post-handle").textContent = realName;

  const copy = document.createElement("p");
  copy.className = "post-copy";
  copy.textContent = message;

  article.append(header, copy);

  if (media.length) {
    const gallery = document.createElement("div");
    gallery.className = "post-media-grid";
    media.forEach(item => {
      const element = document.createElement(item.type?.startsWith("video/") ? "video" : "img");
      element.src = item.url;
      if (element.tagName === "VIDEO") { element.controls = true; element.playsInline = true; }
      else element.alt = "Community post attachment";
      gallery.append(element);
    });
    article.append(gallery);
  }

  if (spotAttached) {
    const tag = document.createElement("div");
    tag.className = "attached-spot";
    tag.innerHTML = `<span>◎</span> Approximate area near <strong></strong>`;
    tag.querySelector("strong").textContent = currentPoint.name || "Dropped pin";
    article.append(tag);
  }

  const footer = document.createElement("footer");
  footer.className = "post-actions";
  footer.innerHTML = `
    <button class="reaction-button" data-count="0" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v11H3V10h4Zm0 9h10.5a2 2 0 0 0 1.9-1.4l1.4-5A2 2 0 0 0 18.9 10H14l.8-3.5A2.8 2.8 0 0 0 12 3l-1 3-4 4v9Z"/></svg>
      <span>0</span>
    </button>
    <button>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2v-10a9 9 0 1 1 18 0Z"/></svg>
      0
    </button>
    <button class="save-post" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4V3Z"/></svg>
      Save
    </button>`;
  article.append(footer);
  return article;
}

function makeLivePost(post) {
  const article = document.createElement("article");
  article.className = "feed-card compact-post";
  article.dataset.category = "nearby";
  article.dataset.livePostId = post.id;
  const handle = post.profiles?.handle || "pilot";
  const displayName = `@${handle}`;
  const realName = [post.profiles?.first_name, post.profiles?.last_name].filter(Boolean).join(" ") || "Pilot";
  const header = document.createElement("header");
  header.className = "post-author";
  header.innerHTML = '<span class="pilot-avatar self"></span><div><strong></strong><p><span class="post-handle"></span> · <span class="post-time"></span></p></div><button aria-label="Post options">•••</button>';
  applyPilotImage(header.querySelector(".pilot-avatar"), "", displayName.charAt(0).toUpperCase());
  header.querySelector("strong").textContent = displayName;
  header.querySelector(".post-handle").textContent = realName;
  header.querySelector(".post-time").textContent = new Date(post.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const copy = document.createElement("p");
  copy.className = "post-copy";
  copy.textContent = post.body;
  article.append(header, copy);
  if (Array.isArray(post.media) && post.media.length) {
    const gallery = document.createElement("div");
    gallery.className = "post-media-grid";
    post.media.forEach(item => {
      const element = document.createElement(item.type?.startsWith("video/") ? "video" : "img");
      element.src = item.url;
      if (element.tagName === "VIDEO") { element.controls = true; element.playsInline = true; }
      else element.alt = "Community post attachment";
      gallery.append(element);
    });
    article.append(gallery);
  }
  if (post.area_label) {
    const area = document.createElement("div");
    area.className = "attached-spot";
    area.innerHTML = '<span>◎</span> Approximate area near <strong></strong>';
    area.querySelector("strong").textContent = post.area_label;
    article.append(area);
  }
  const footer = document.createElement("footer");
  footer.className = "post-actions";
  footer.innerHTML = '<button class="save-post" aria-pressed="false">Save</button>';
  article.append(footer);
  return article;
}

async function loadLiveCommunityPosts() {
  if (!backendReady) return;
  const { data, error } = await supabase
    .from("posts")
    .select("id, body, area_label, media, created_at, profiles!posts_author_id_fkey(handle, first_name, last_name)")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) { console.error(error); return; }
  const feed = document.querySelector("#communityFeed");
  [...data].reverse().forEach(post => {
    if (!feed.querySelector(`[data-live-post-id="${post.id}"]`)) {
      feed.querySelector("#communityEmpty")?.remove();
      feed.prepend(makeLivePost(post));
    }
  });
}

postButton.addEventListener("click", async () => {
  const message = postInput.value.trim();
  if (!message) return;
  const originalText = postButton.textContent;
  postButton.disabled = true;
  postButton.textContent = selectedMedia.length ? "Uploading…" : "Posting…";
  let media = [];
  if (backendReady) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { postButton.textContent = originalText; updatePostButton(); openAuth("login"); showToast("Log in to share with the beta community"); return; }
    try {
      media = await uploadPostMedia(user.id, selectedMedia);
      const { error } = await supabase.from("posts").insert({
        author_id: user.id, body: message, media,
        area_label: spotAttached ? (currentPoint.name || "Approximate area") : null,
        hide_exact_location: document.querySelector("#privacyButton").getAttribute("aria-pressed") === "true"
      });
      if (error) throw error;
    } catch (error) {
      console.error(error);
      postButton.textContent = originalText;
      updatePostButton();
      showToast("Your post could not be published. Try again.");
      return;
    }
  }
  const post = makeUserPost(message, media);
  const feed = document.querySelector("#communityFeed");
  feed.querySelector("#communityEmpty")?.remove();
  feed.prepend(post);
  postInput.value = "";
  selectedMedia = [];
  renderMediaPreview();
  spotAttached = false;
  attachedSpot.hidden = true;
  document.querySelector("#attachSpotButton").classList.remove("active");
  updatePostButton();
  postButton.textContent = originalText;
  updatePostButton();
  showToast(backendReady ? "Your update was shared with the community" : "Your update was added to the prototype feed");
});

document.querySelector(".feed-filters").addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  document.querySelectorAll(".feed-filters button").forEach(item => item.classList.toggle("active", item === button));
  const filter = button.dataset.filter;
  document.querySelectorAll("#communityFeed > article").forEach(card => {
    card.hidden = filter !== "nearby" && !card.dataset.category.split(" ").includes(filter);
  });
});

document.querySelector("#communityFeed").addEventListener("click", event => {
  const reaction = event.target.closest(".reaction-button");
  if (reaction) {
    const active = reaction.getAttribute("aria-pressed") === "true";
    const base = Number(reaction.dataset.count);
    reaction.setAttribute("aria-pressed", String(!active));
    reaction.classList.toggle("active", !active);
    reaction.querySelector("span").textContent = String(base + (active ? 0 : 1));
    return;
  }

  const save = event.target.closest(".save-post");
  if (save) {
    const active = save.getAttribute("aria-pressed") === "true";
    save.setAttribute("aria-pressed", String(!active));
    save.classList.toggle("active", !active);
    save.lastChild.textContent = active ? " Save" : " Saved";
    return;
  }

  const interested = event.target.closest(".interested-button");
  if (interested) {
    interested.classList.toggle("active");
    interested.textContent = interested.classList.contains("active") ? "Going" : "Interested";
    showToast(interested.classList.contains("active") ? "Added to your community plans" : "Removed from your plans");
  }
});

const initialParams = new URLSearchParams(location.search);
const sharedLat = Number(initialParams.get("lat"));
const sharedLng = Number(initialParams.get("lng"));
const hasSharedPoint = Number.isFinite(sharedLat)
  && Number.isFinite(sharedLng)
  && Math.abs(sharedLat) <= 90
  && Math.abs(sharedLng) <= 180;
const initialPoint = hasSharedPoint
  ? { lat: sharedLat, lng: sharedLng, name: initialParams.get("name") || "Shared launch point" }
  : defaultPoint;

updateBriefing(initialPoint.lat, initialPoint.lng, initialPoint.name, hasSharedPoint);

const initialSession = readPrototypeSession();
updateAccountButton(initialSession);
if (!initialSession) {
  setTimeout(() => openAuth("login"), 280);
}

if (location.hash === "#community") {
  document.querySelector('.view-switch button[data-view="community"]').click();
}

if ("serviceWorker" in navigator && import.meta.env?.PROD && !window.Capacitor?.isNativePlatform?.()) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // The app remains usable online if offline support cannot initialize.
    });
  });
}
