import { onChange, onClick, runAfterDOM, setInnerText } from "./vendor/crootjs/element.js";

const DATA_URL = "data/714240047.geojson";
const JOIN_RADIUS_METERS = 20;
const SNAP_TOLERANCE_METERS = 2;
const MERGE_TOLERANCE_METERS = 1;

let map;
let routeLayer;
let campusLayer;
let graph;
let places = [];
let needsInitialFit = false;
let tileErrorNotified = false;

export const meters = (a, b) => {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const toRadians = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRadians;
  const dLng = (lng2 - lng1) * toRadians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRadians) * Math.cos(lat2 * toRadians) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const projectOnSegment = (point, a, b) => {
  const midLat = (a[1] + b[1]) / 2;
  const toRadians = Math.PI / 180;
  const kx = 6371000 * toRadians * Math.cos(midLat * toRadians);
  const ky = 6371000 * toRadians;
  const ax = a[0] * kx;
  const ay = a[1] * ky;
  const bx = b[0] * kx;
  const by = b[1] * ky;
  const px = point[0] * kx;
  const py = point[1] * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { t: 0, point: a, distance: meters(point, a) };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const projected = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return { t, point: projected, distance: meters(point, projected) };
};

const segmentIntersection = (a, b, c, d) => {
  const toRadians = Math.PI / 180;
  const kx = 6371000 * toRadians * Math.cos(a[1] * toRadians);
  const ky = 6371000 * toRadians;
  const rx = (b[0] - a[0]) * kx;
  const ry = (b[1] - a[1]) * ky;
  const sx = (d[0] - c[0]) * kx;
  const sy = (d[1] - c[1]) * ky;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qpx = (c[0] - a[0]) * kx;
  const qpy = (c[1] - a[1]) * ky;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t > 0 && t < 1 && u > 0 && u < 1) return t;
  return null;
};

const averagePoint = (coordinates) => {
  const points = coordinates.flat(Infinity).filter(Number.isFinite);
  const pairs = [];
  for (let i = 0; i < points.length; i += 2) pairs.push([points[i], points[i + 1]]);
  if (!pairs.length) return [0, 0];
  return pairs.reduce((total, point) => [total[0] + point[0] / pairs.length, total[1] + point[1] / pairs.length], [0, 0]);
};

export const featurePoint = (feature) => {
  const props = feature.properties || {};
  if (Number.isFinite(props.centroid_lon) && Number.isFinite(props.centroid_lat)) return [props.centroid_lon, props.centroid_lat];
  const geometry = feature.geometry;
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates[0])) {
    const ring = geometry.coordinates[0];
    const openRing = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
    return averagePoint(openRing);
  }
  return averagePoint(geometry.coordinates);
};

export function extractPlaces(features) {
  const unique = new Map();
  features
    .filter((feature) => feature.geometry?.type === "Polygon" && feature.properties?.name)
    .forEach((feature) => {
      const name = feature.properties.name;
      if (!unique.has(name)) unique.set(name, { name, point: featurePoint(feature) });
    });
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "id"));
}

const popup = (feature) => {
  const props = feature.properties || {};
  const title = props.title || props.name || "Bangunan kampus";
  const wrap = document.createElement("div");
  const heading = document.createElement("p");
  heading.className = "popup-title";
  heading.textContent = title;
  wrap.appendChild(heading);
  if (props.description && props.description !== title) {
    const detail = document.createElement("p");
    detail.className = "popup-text";
    detail.textContent = props.description;
    wrap.appendChild(detail);
  }
  return wrap;
};

export function buildGraph(features) {
  const lines = features
    .filter((feature) => feature.geometry?.type === "LineString" && feature.geometry.coordinates?.length >= 2)
    .map((feature) => feature.geometry.coordinates);
  const rawSegments = [];
  const lineVertices = [];
  lines.forEach((line, lineIndex) => {
    line.forEach((point) => lineVertices.push({ lineIndex, point }));
    for (let i = 1; i < line.length; i += 1) rawSegments.push({ lineIndex, a: line[i - 1], b: line[i] });
  });

  const splitSegments = [];
  rawSegments.forEach((seg) => {
    const splits = [0, 1];
    rawSegments.forEach((other) => {
      if (other.lineIndex === seg.lineIndex) return;
      const t = segmentIntersection(seg.a, seg.b, other.a, other.b);
      if (t !== null) splits.push(t);
    });
    lineVertices.forEach((vertex) => {
      if (vertex.lineIndex === seg.lineIndex) return;
      const proj = projectOnSegment(vertex.point, seg.a, seg.b);
      if (proj.distance <= SNAP_TOLERANCE_METERS && proj.t > 0 && proj.t < 1) {
        if (meters(proj.point, seg.a) > 0.2 && meters(proj.point, seg.b) > 0.2) splits.push(proj.t);
      }
    });
    splits.sort((x, y) => x - y);
    const uniqueSplits = splits.filter((t, idx) => idx === 0 || t - splits[idx - 1] > 1e-6);
    for (let i = 1; i < uniqueSplits.length; i += 1) {
      const t0 = uniqueSplits[i - 1];
      const t1 = uniqueSplits[i];
      const p0 = [seg.a[0] + t0 * (seg.b[0] - seg.a[0]), seg.a[1] + t0 * (seg.b[1] - seg.a[1])];
      const p1 = [seg.a[0] + t1 * (seg.b[0] - seg.a[0]), seg.a[1] + t1 * (seg.b[1] - seg.a[1])];
      splitSegments.push([p0, p1]);
    }
  });

  const nodes = [];
  const nodeFor = (point) => {
    let bestIndex = -1;
    let bestDistance = MERGE_TOLERANCE_METERS;
    nodes.forEach((node, index) => {
      const distance = meters(point, node.point);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      const node = nodes[bestIndex];
      node.members.push(point);
      node.point = averagePoint(node.members);
      return bestIndex;
    }
    nodes.push({ point, members: [point], edges: [] });
    return nodes.length - 1;
  };

  const connect = (from, to) => {
    if (from === to || nodes[from].edges.some((edge) => edge.to === to)) return;
    const distance = meters(nodes[from].point, nodes[to].point);
    nodes[from].edges.push({ to, distance });
    nodes[to].edges.push({ to: from, distance });
  };

  splitSegments.forEach(([a, b]) => connect(nodeFor(a), nodeFor(b)));
  // Refresh edge distances after all cluster centroids settle
  nodes.forEach((node) => {
    node.edges.forEach((edge) => {
      edge.distance = meters(node.point, nodes[edge.to].point);
    });
  });

  const getComponents = () => {
    const visited = new Uint8Array(nodes.length);
    const components = [];
    for (let i = 0; i < nodes.length; i += 1) {
      if (visited[i]) continue;
      const group = [];
      const stack = [i];
      visited[i] = 1;
      while (stack.length) {
        const cur = stack.pop();
        group.push(cur);
        nodes[cur].edges.forEach((edge) => {
          if (!visited[edge.to]) {
            visited[edge.to] = 1;
            stack.push(edge.to);
          }
        });
      }
      components.push(group);
    }
    return components;
  };

  let components = getComponents();
  while (components.length > 1) {
    let best = { distance: JOIN_RADIUS_METERS + 1e-6, from: -1, to: -1 };
    for (let c1 = 0; c1 < components.length; c1 += 1) {
      for (let c2 = c1 + 1; c2 < components.length; c2 += 1) {
        for (const u of components[c1]) {
          for (const v of components[c2]) {
            const distance = meters(nodes[u].point, nodes[v].point);
            if (distance < best.distance) best = { distance, from: u, to: v };
          }
        }
      }
    }
    if (best.from === -1) break;
    connect(best.from, best.to);
    components = getComponents();
  }

  return { nodes: nodes.map(({ point, edges }) => ({ point, edges })) };
}

export function snapToGraph(activeGraph, point) {
  let best = null;
  activeGraph.nodes.forEach((node, u) => {
    if (node.edges.length === 0) {
      const distance = meters(point, node.point);
      if (!best || distance < best.distance) best = { point: node.point, distance, u, v: u, dU: 0, dV: 0 };
      return;
    }
    node.edges.forEach((edge) => {
      if (edge.to <= u) return;
      const v = edge.to;
      const proj = projectOnSegment(point, node.point, activeGraph.nodes[v].point);
      if (!best || proj.distance < best.distance) {
        best = {
          point: proj.point,
          distance: proj.distance,
          u,
          v,
          dU: meters(proj.point, node.point),
          dV: meters(proj.point, activeGraph.nodes[v].point)
        };
      }
    });
  });
  return best;
}

export function shortestPath(activeGraph, startSnap, endSnap) {
  if (!startSnap || !endSnap) return null;
  const baseCount = activeGraph.nodes.length;
  const startNode = baseCount;
  const endNode = baseCount + 1;
  const adj = activeGraph.nodes.map((node) => node.edges.map((edge) => ({ ...edge })));
  adj.push([], []);

  const linkSnap = (virtualIdx, snap) => {
    adj[virtualIdx].push({ to: snap.u, distance: snap.dU });
    adj[snap.u].push({ to: virtualIdx, distance: snap.dU });
    if (snap.v !== snap.u) {
      adj[virtualIdx].push({ to: snap.v, distance: snap.dV });
      adj[snap.v].push({ to: virtualIdx, distance: snap.dV });
    }
  };
  linkSnap(startNode, startSnap);
  linkSnap(endNode, endSnap);

  const sameEdge = (startSnap.u === endSnap.u && startSnap.v === endSnap.v) || (startSnap.u === endSnap.v && startSnap.v === endSnap.u);
  if (sameEdge) {
    const direct = meters(startSnap.point, endSnap.point);
    adj[startNode].push({ to: endNode, distance: direct });
    adj[endNode].push({ to: startNode, distance: direct });
  }

  const totalNodes = baseCount + 2;
  const distances = Array(totalNodes).fill(Infinity);
  const previous = Array(totalNodes).fill(-1);
  const pending = new Set(Array.from({ length: totalNodes }, (_, index) => index));
  distances[startNode] = 0;

  while (pending.size) {
    let current = -1;
    pending.forEach((index) => {
      if (current === -1 || distances[index] < distances[current]) current = index;
    });
    if (current === -1 || current === endNode || distances[current] === Infinity) break;
    pending.delete(current);
    adj[current].forEach((edge) => {
      if (!pending.has(edge.to)) return;
      const total = distances[current] + edge.distance;
      if (total < distances[edge.to]) {
        distances[edge.to] = total;
        previous[edge.to] = current;
      }
    });
  }

  if (!Number.isFinite(distances[endNode])) return null;
  const nodeIds = [];
  for (let cur = endNode; cur >= 0; cur = previous[cur]) nodeIds.unshift(cur);

  const rawPoints = nodeIds.map((id) => {
    if (id === startNode) return startSnap.point;
    if (id === endNode) return endSnap.point;
    return activeGraph.nodes[id].point;
  });
  const pathPoints = rawPoints.filter((point, idx) => idx === 0 || meters(point, rawPoints[idx - 1]) > 0.05);
  return { pathPoints, distance: distances[endNode] };
}

function clearRoute() {
  if (routeLayer) routeLayer.remove();
  routeLayer = null;
}

function drawRoute() {
  if (!places.length || !graph?.nodes?.length) return;
  const origin = places[Number(document.getElementById("origin").value)];
  const destination = places[Number(document.getElementById("destination").value)];
  if (!origin || !destination) return;
  if (origin === destination) {
    clearRoute();
    setInnerText("route-summary", "Pilih titik tujuan yang berbeda.");
    return;
  }

  const startSnap = snapToGraph(graph, origin.point);
  const endSnap = snapToGraph(graph, destination.point);
  const result = shortestPath(graph, startSnap, endSnap);
  if (!result) {
    clearRoute();
    setInnerText("route-summary", "Rute belum terhubung di data jalur saat ini.");
    return;
  }

  clearRoute();
  routeLayer = L.featureGroup().addTo(map);
  if (result.pathPoints.length >= 2) {
    L.polyline(
      result.pathPoints.map(([lng, lat]) => [lat, lng]),
      { color: "#e6562c", weight: 6, opacity: 0.95, lineJoin: "round" }
    ).addTo(routeLayer);
  }
  if (startSnap.distance > 0.5) {
    L.polyline(
      [[origin.point[1], origin.point[0]], [startSnap.point[1], startSnap.point[0]]],
      { color: "#e6562c", weight: 4, opacity: 0.75, dashArray: "6 6" }
    ).addTo(routeLayer);
  }
  if (endSnap.distance > 0.5) {
    L.polyline(
      [[endSnap.point[1], endSnap.point[0]], [destination.point[1], destination.point[0]]],
      { color: "#e6562c", weight: 4, opacity: 0.75, dashArray: "6 6" }
    ).addTo(routeLayer);
  }
  L.circleMarker([origin.point[1], origin.point[0]], {
    radius: 8,
    color: "#fff",
    weight: 3,
    fillColor: "#007a73",
    fillOpacity: 1
  }).bindTooltip(`Berangkat: ${origin.name}`).addTo(routeLayer);
  L.circleMarker([destination.point[1], destination.point[0]], {
    radius: 8,
    color: "#fff",
    weight: 3,
    fillColor: "#e6562c",
    fillOpacity: 1
  }).bindTooltip(`Tujuan: ${destination.name}`).addTo(routeLayer);

  const total = result.distance + startSnap.distance + endSnap.distance;
  setInnerText("route-summary", `${origin.name} ke ${destination.name}: sekitar ${Math.round(total)} m melalui jalur kampus.`);
  map.invalidateSize();
  map.fitBounds(routeLayer.getBounds(), { padding: [45, 45], maxZoom: 19 });
}

function resetRoute() {
  clearRoute();
  setInnerText("route-summary", "Pilih dua lokasi lalu tampilkan rute.");
  if (map && campusLayer) {
    map.invalidateSize();
    map.fitBounds(campusLayer.getBounds(), { padding: [30, 30] });
  }
}

function renderNavigation() {
  const raw = location.hash.replace("#/", "");
  const route = raw === "tentang" ? "tentang" : "peta";
  document.querySelectorAll("[data-view]").forEach((view) => { view.hidden = view.dataset.view !== route; });
  document.querySelectorAll("[data-view-link]").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === route));
  if (route === "peta" && map) {
    setTimeout(() => {
      map.invalidateSize();
      if (needsInitialFit && campusLayer) {
        map.fitBounds(campusLayer.getBounds(), { padding: [30, 30] });
        needsInitialFit = false;
      }
    }, 0);
  }
}

async function start() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`GeoJSON tidak dapat dimuat (${response.status}).`);
  const data = await response.json();
  map = L.map("map", { zoomControl: false });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 19,
    maxZoom: 22,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  campusLayer = L.geoJSON(data, {
    style: (feature) => feature.geometry.type === "LineString"
      ? { color: "#506b78", weight: 4, opacity: 0.8, lineCap: "round" }
      : { color: feature.properties?.stroke || "#7357b5", weight: feature.properties?.["stroke-width"] || 1.5, fillColor: feature.properties?.fill || "#4477cc", fillOpacity: feature.properties?.["fill-opacity"] ?? 0.4 },
    pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 5, color: "#006c67", fillOpacity: 1 }),
    onEachFeature: (feature, layer) => {
      if (feature.properties?.name || feature.properties?.title) layer.bindPopup(() => popup(feature));
    }
  }).addTo(map);

  graph = buildGraph(data.features);
  places = extractPlaces(data.features);
  const originEl = document.getElementById("origin");
  const destinationEl = document.getElementById("destination");
  originEl.replaceChildren(...places.map((place, index) => new Option(place.name, String(index))));
  destinationEl.replaceChildren(...places.map((place, index) => new Option(place.name, String(index))));
  destinationEl.selectedIndex = Math.min(1, places.length - 1);

  if (document.getElementById("peta").hidden) {
    needsInitialFit = true;
  } else {
    map.fitBounds(campusLayer.getBounds(), { padding: [30, 30] });
  }
  setInnerText("route-summary", "Pilih dua lokasi lalu tampilkan rute.");
  tiles.on("tileerror", () => {
    if (!routeLayer && !tileErrorNotified) {
      tileErrorNotified = true;
      setInnerText("route-summary", "Sebagian peta dasar gagal dimuat. Data rute kampus tetap tersedia.");
    }
  });
}

if (typeof window !== "undefined") {
  runAfterDOM(() => {
    onClick("route-button", drawRoute);
    onClick("reset-button", resetRoute);
    onChange("origin", () => { if (routeLayer) drawRoute(); });
    onChange("destination", () => { if (routeLayer) drawRoute(); });
    window.addEventListener("hashchange", renderNavigation);
    renderNavigation();
    start().catch((error) => setInnerText("route-summary", error.message));
  });
}
