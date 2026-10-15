# Rute Kampus ULBI

GitHub Pages statis untuk mencari rute pejalan kaki antar bangunan Kampus ULBI.

- CrootJS dipakai untuk event dan inisialisasi DOM.
- Leaflet menampilkan peta, bangunan, dan polyline jalan.
- `data/714240047.geojson` memuat 43 fitur: 32 bangunan, 10 polyline jalan, dan 1 titik kampus.
- Rute dihitung sepenuhnya di browser dari graf polyline, tanpa API atau backend.

## Jalankan lokal

```sh
python3 -m http.server 4173
```

Buka `http://127.0.0.1:4173/`.

## Catatan data

Polyline dalam GeoJSON memiliki celah kecil. Aplikasi menyambungkan vertex jalur yang berjarak maksimal 20 meter agar segmen survei menjadi satu jaringan navigasi.
