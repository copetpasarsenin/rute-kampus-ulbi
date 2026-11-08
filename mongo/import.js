// Usage: mongosh ulbi mongo/import.js  (env GEOJSON=path)
const fs = require("fs");
const fc = JSON.parse(fs.readFileSync(process.env.GEOJSON || "/data/714240047.geojson", "utf8"));
db.features.drop();
const docs = fc.features.map((f) => ({ name: f.properties?.name ?? null, type: f.geometry.type, properties: f.properties, geometry: f.geometry }));
const r = db.features.insertMany(docs);
db.features.createIndex({ geometry: "2dsphere" });
db.features.createIndex({ name: 1 });
print(`imported ${r.insertedIds ? Object.keys(r.insertedIds).length : 0} / ${fc.features.length}`);
printjson(db.features.aggregate([{ $group: { _id: "$type", n: { $sum: 1 } } }]).toArray());
