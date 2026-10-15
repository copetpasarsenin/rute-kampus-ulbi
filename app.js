import { onClick, runAfterDOM, setInnerText } from "./vendor/crootjs/element.js";

const DATA_URL = "data/714240047.geojson";
const JOIN_RADIUS_METERS = 20;
let map;
let routeLayer;
let campusLayer;
let graph;
let places = [];

const meters = (a, b) => {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const toRadians = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRadians;
  const dLng = (lng2 - lng1) * toRadians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRadians) * Math.cos(lat2 * toRadians) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const averagePoint = (coordinates) => {
  const points = coordinates.flat(Infinity).filter(Number.isFinite);
  const pairs = [];
  for (let i = 0; i < points.length; i += 2) pairs.push([points[i], points[i + 1]]);
  return pairs.reduce((total, point) => [total[0] + point[0] / pairs.length, total[1] + point[1] / pairs.length], [0, 0]);
};

const featurePoint = (feature) => {
  const props = feature.properties || {};
  if (Number.isFinite(props.centroid_lon) && Number.isFinite(props.centroid_lat)) return [props.centroid_lon, props.centroid_lat];
  const geometry = feature.geometry;
  return geometry.type === "Point" ? geometry.coordinates : averagePoint(geometry.coordinates);
};

const popup = (feature) => {
  const props = feature.properties || {};
  const title = props.title || props.name || "Bangunan kampus";
  const detail = props.description && props.description !== title ? `<p class="popup-text">${props.description}</p>` : "";
  return `<p class="popup-title">${title}</p>${detail}`;
};

function buildGraph(features) {
  const lines = features.filter((feature) => feature.geometry?.type === "LineString").map((feature) => feature.geometry.coordinates);
  const points = lines.flat();
  const parent = points.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  let offset = 0;
  lines.forEach((line) => {
    for (let index = 1; index < line.length; index += 1) join(offset + index - 1, offset + index);
    offset += line.length;
  });
  points.forEach((point, index) => points.slice(0, index).forEach((other, otherIndex) => {
    if (meters(point, other) <= JOIN_RADIUS_METERS) join(index, otherIndex);
  }));
  const groups = new Map();
  points.forEach((point, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) || []), point]);
  });
  const roots = [...groups.keys()];
  const nodeByRoot = new Map(roots.map((root, index) => [root, index]));
  const nodes = roots.map((root) => ({ point: averagePoint(groups.get(root)), edges: [] }));
  const connect = (from, to) => {
    if (from === to || nodes[from].edges.some((edge) => edge.to === to)) return;
    const distance = meters(nodes[from].point, nodes[to].point);
    nodes[from].edges.push({ to, distance });
    nodes[to].edges.push({ to: from, distance });
  };
  offset = 0;
  lines.forEach((line) => {
    for (let index = 1; index < line.length; index += 1) {
      connect(nodeByRoot.get(find(offset + index - 1)), nodeByRoot.get(find(offset + index)));
    }
    offset += line.length;
  });
  return { nodes };
}

function nearestNode(point) {
  return graph.nodes.reduce((best, node, index) => {
    const distance = meters(point, node.point);
    return distance < best.distance ? { index, distance } : best;
  }, { index: -1, distance: Infinity });
}

function shortestPath(from, to) {
  const distances = Array(graph.nodes.length).fill(Infinity);
  const previous = Array(graph.nodes.length).fill(-1);
  const pending = new Set(graph.nodes.map((_, index) => index));
  distances[from] = 0;
  while (pending.size) {
    const current = [...pending].reduce((best, index) => distances[index] < distances[best] ? index : best, pending.values().next().value);
    if (current === to || distances[current] === Infinity) break;
    pending.delete(current);
    graph.nodes[current].edges.forEach((edge) => {
      if (!pending.has(edge.to)) return;
      const total = distances[current] + edge.distance;
      if (total < distances[edge.to]) [distances[edge.to], previous[edge.to]] = [total, current];
    });
  }
  if (!Number.isFinite(distances[to])) return null;
  const path = [];
  for (let node = to; node >= 0; node = previous[node]) path.unshift(node);
  return { path, distance: distances[to] };
}

function drawRoute() {
  const origin = places[Number(document.getElementById("origin").value)];
  const destination = places[Number(document.getElementById("destination").value)];
  if (!origin || !destination) return;
  if (origin === destination) {
    setInnerText("route-summary", "Pilih titik tujuan yang berbeda.");
    return;
  }
  const start = nearestNode(origin.point);
  const end = nearestNode(destination.point);
  const result = shortestPath(start.index, end.index);
  if (!result) {
    setInnerText("route-summary", "Rute belum terhubung di data jalur saat ini.");
    return;
  }
  if (routeLayer) routeLayer.remove();
  const line = [origin.point, ...result.path.map((node) => graph.nodes[node].point), destination.point].map(([lng, lat]) => [lat, lng]);
  routeLayer = L.polyline(line, { color: "#e6562c", weight: 6, opacity: .95, lineJoin: "round" }).addTo(map);
  L.circleMarker([origin.point[1], origin.point[0]], { radius: 8, color: "#fff", weight: 3, fillColor: "#007a73", fillOpacity: 1 }).addTo(routeLayer);
  L.circleMarker([destination.point[1], destination.point[0]], { radius: 8, color: "#fff", weight: 3, fillColor: "#e6562c", fillOpacity: 1 }).addTo(routeLayer);
  map.fitBounds(routeLayer.getBounds(), { padding: [45, 45], maxZoom: 19 });
  const total = result.distance + start.distance + end.distance;
  setInnerText("route-summary", `${origin.name} ke ${destination.name}: sekitar ${Math.round(total)} m melalui jalur kampus.`);
}

function resetRoute() {
  if (routeLayer) routeLayer.remove();
  routeLayer = null;
  map.fitBounds(campusLayer.getBounds(), { padding: [30, 30] });
  setInnerText("route-summary", "Pilih dua lokasi lalu tampilkan rute.");
}

function renderNavigation() {
  const route = location.hash.replace("#/", "") || "peta";
  document.querySelectorAll("[data-view]").forEach((view) => { view.hidden = view.dataset.view !== route; });
  document.querySelectorAll("[data-view-link]").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === route));
  if (route === "peta") setTimeout(() => map?.invalidateSize(), 0);
}

async function start() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`GeoJSON tidak dapat dimuat (${response.status}).`);
  const data = await response.json();
  map = L.map("map", { zoomControl: false });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 22, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
  campusLayer = L.geoJSON(data, {
    style: (feature) => feature.geometry.type === "LineString"
      ? { color: "#506b78", weight: 4, opacity: .8, lineCap: "round" }
      : { color: feature.properties?.stroke || "#7357b5", weight: feature.properties?.["stroke-width"] || 1.5, fillColor: feature.properties?.fill || "#4477cc", fillOpacity: feature.properties?.["fill-opacity"] ?? .4 },
    pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 5, color: "#006c67", fillOpacity: 1 }),
    onEachFeature: (feature, layer) => {
      if (feature.properties?.name || feature.properties?.title) layer.bindPopup(popup(feature));
    }
  }).addTo(map);
  graph = buildGraph(data.features);
  const unique = new Map();
  data.features.filter((feature) => feature.geometry?.type === "Polygon" && feature.properties?.name).forEach((feature) => {
    const name = feature.properties.name;
    if (!unique.has(name)) unique.set(name, { name, point: featurePoint(feature) });
  });
  places = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "id"));
  const options = places.map((place, index) => `<option value="${index}">${place.name}</option>`).join("");
  document.getElementById("origin").innerHTML = options;
  document.getElementById("destination").innerHTML = options;
  document.getElementById("destination").selectedIndex = Math.min(1, places.length - 1);
  map.fitBounds(campusLayer.getBounds(), { padding: [30, 30] });
  setInnerText("route-summary", "Pilih dua lokasi lalu tampilkan rute.");
  tiles.on("tileerror", () => setInnerText("route-summary", "Peta dasar gagal dimuat. Data rute kampus tetap tersedia."));
}

runAfterDOM(() => {
  onClick("route-button", drawRoute);
  onClick("reset-button", resetRoute);
  window.addEventListener("hashchange", renderNavigation);
  renderNavigation();
  start().catch((error) => setInnerText("route-summary", error.message));
});
