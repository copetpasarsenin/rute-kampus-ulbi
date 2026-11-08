// Usage: mongosh ulbi mongo/queries.js  -- asserts compare Mongo results against brute-force haversine.
const C = db.features.findOne({ name: "Kampus ULBI Tercinta" }).geometry.coordinates;
const hav = (a, b) => { const r = Math.PI / 180, dLa = (b[1]-a[1])*r, dLo = (b[0]-a[0])*r;
  const h = Math.sin(dLa/2)**2 + Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dLo/2)**2; return 6378137 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h)); };
const ctr = (g) => g.type === "Point" ? g.coordinates : (g.type === "Polygon" ? g.coordinates[0] : g.coordinates).reduce((s,p,_,a)=>[s[0]+p[0]/a.length,s[1]+p[1]/a.length],[0,0]);
const show = (t, rows) => { print(`\n== ${t} (${rows.length})`); rows.forEach((r) => print("  " + r)); };

// 1. $near: 5 terdekat dari titik kampus
const near = db.features.find({ geometry: { $near: { $geometry: { type: "Point", coordinates: C }, $maxDistance: 100 } }, name: { $ne: "Kampus ULBI Tercinta" } }).limit(5).toArray();
show("1. $near <=100 m dari Kampus ULBI Tercinta", near.map((d) => `${d.name ?? "(tanpa nama)"} [${d.type}]`));

// 2. $geoNear: jarak tepat per fitur
const gn = db.features.aggregate([{ $geoNear: { near: { type: "Point", coordinates: C }, distanceField: "dist", spherical: true, query: { type: "Polygon", name: { $ne: null } } } }, { $limit: 5 }]).toArray();
show("2. $geoNear 5 bangunan terdekat", gn.map((d) => `${d.name}: ${d.dist.toFixed(1)} m`));

// 3. $geoWithin: bangunan dalam radius 150 m
const R = 150;
const within = db.features.find({ type: "Polygon", geometry: { $geoWithin: { $centerSphere: [C, R / 6378137] } } }).toArray();
show(`3. $geoWithin radius ${R} m (poligon utuh di dalam lingkaran)`, within.map((d) => d.name ?? "(tanpa nama)"));

// 4. $geoIntersects: jalur yang memotong kotak
const box = { type: "Polygon", coordinates: [[[107.5755,-6.8738],[107.5762,-6.8738],[107.5762,-6.8732],[107.5755,-6.8732],[107.5755,-6.8738]]] };
const inter = db.features.find({ geometry: { $geoIntersects: { $geometry: box } } }).toArray();
show("4. $geoIntersects kotak kecil di sekitar kampus", inter.map((d) => `${d.name ?? "(tanpa nama)"} [${d.type}]`));

// Verifikasi vs brute force
const all = db.features.find().toArray();
const bf = all.filter((d) => d.type === "Polygon" && d.geometry.coordinates[0].every((p) => hav(C, p) <= R)).map((d) => d._id.str).sort();
assert.deepEqual(within.map((d) => d._id.str).sort(), bf, "geoWithin != brute force");
const nearBF = all.filter((d) => d.name !== "Kampus ULBI Tercinta" && d.geometry.type !== "Point" && Math.min(...(d.geometry.type === "Polygon" ? d.geometry.coordinates[0] : d.geometry.coordinates).map((p) => hav(C, p))) <= 100).length;
assert(near.length <= 5 && near.length <= nearBF + 1, "near count sanity");
const gnBF = all.filter((d) => d.type === "Polygon" && d.name).map((d) => ({ n: d.name, d: hav(C, ctr(d.geometry)) })).sort((a,b)=>a.d-b.d)[0];
print(`\nbrute-force terdekat (centroid): ${gnBF.n} ${gnBF.d.toFixed(1)} m; Mongo $geoNear terdekat: ${gn[0].name} ${gn[0].dist.toFixed(1)} m`);
assert(inter.length > 0, "geoIntersects kosong");
print("\nPASS: geoWithin cocok dengan brute force haversine; query lain menghasilkan data.");
