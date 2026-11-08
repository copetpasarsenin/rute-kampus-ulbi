import assert from "node:assert/strict";
import fs from "node:fs";
import { buildGraph, extractPlaces, meters, shortestPath, snapToGraph } from "../app.js";

const data = JSON.parse(fs.readFileSync(new URL("../data/714240047.geojson", import.meta.url), "utf8"));
const graph = buildGraph(data.features);
const places = extractPlaces(data.features);

assert.equal(places.length, 24, "Expected 24 unique named buildings");
assert.ok(graph.nodes.length >= 20, `Expected full road graph (>=20 nodes), got ${graph.nodes.length}`);

// Verify every pair of buildings resolves to a connected route
let minDist = Infinity;
let maxDist = 0;
for (let i = 0; i < places.length; i += 1) {
  for (let j = 0; j < places.length; j += 1) {
    if (i === j) continue;
    const startSnap = snapToGraph(graph, places[i].point);
    const endSnap = snapToGraph(graph, places[j].point);
    const result = shortestPath(graph, startSnap, endSnap);
    assert.ok(result, `Missing route: ${places[i].name} -> ${places[j].name}`);
    assert.ok(Number.isFinite(result.distance) && result.distance >= 0);
    assert.ok(result.pathPoints.length >= 1);
    const total = result.distance + startSnap.distance + endSnap.distance;
    minDist = Math.min(minDist, total);
    maxDist = Math.max(maxDist, total);
  }
}

// Same-edge snapping sanity check: two points along the long L2 path shouldn't overshoot to an endpoint
const sameEdgeGraph = buildGraph([
  { type: "Feature", geometry: { type: "LineString", coordinates: [[107.5759, -6.8730], [107.5759, -6.8735]] }, properties: {} }
]);
const s1 = snapToGraph(sameEdgeGraph, [107.57592, -6.8731]);
const s2 = snapToGraph(sameEdgeGraph, [107.57592, -6.8732]);
const sameEdgeRes = shortestPath(sameEdgeGraph, s1, s2);
assert.ok(Math.abs(sameEdgeRes.distance - meters(s1.point, s2.point)) < 0.1, "Same-edge route must go directly along segment");

console.log(`PASS: ${places.length} places, ${graph.nodes.length} graph nodes, ${places.length * (places.length - 1)} routes verified (${Math.round(minDist)}m..${Math.round(maxDist)}m).`);
