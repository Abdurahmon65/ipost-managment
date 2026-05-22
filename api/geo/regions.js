// Simplified Uzbekistan region polygons. Coarse bounding-box-like polygons —
// for production replace with GADM v4.1 → mapshaper -simplify 5% → upload here.
//
// Each feature has properties.key matching branch.regionKey.

export const UZ_REGIONS_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    { type:'Feature', properties:{ key:'tashkent', name_ru:'Ташкент', name_en:'Tashkent', name_uz:'Toshkent' },
      geometry:{ type:'Polygon', coordinates:[[[69.13,41.20],[69.43,41.20],[69.43,41.42],[69.13,41.42],[69.13,41.20]]] } },
    { type:'Feature', properties:{ key:'tashkent_region', name_ru:'Ташкентская область', name_en:'Tashkent region', name_uz:'Toshkent viloyati' },
      geometry:{ type:'Polygon', coordinates:[[[69.00,40.50],[70.80,40.50],[70.80,41.80],[69.00,41.80],[69.00,40.50]]] } },
    { type:'Feature', properties:{ key:'samarkand', name_ru:'Самарканд', name_en:'Samarkand', name_uz:'Samarqand' },
      geometry:{ type:'Polygon', coordinates:[[[65.50,39.20],[68.20,39.20],[68.20,40.50],[65.50,40.50],[65.50,39.20]]] } },
    { type:'Feature', properties:{ key:'bukhara', name_ru:'Бухара', name_en:'Bukhara', name_uz:'Buxoro' },
      geometry:{ type:'Polygon', coordinates:[[[62.50,38.50],[65.50,38.50],[65.50,41.00],[62.50,41.00],[62.50,38.50]]] } },
    { type:'Feature', properties:{ key:'fergana', name_ru:'Фергана', name_en:'Fergana', name_uz:'Fargʻona' },
      geometry:{ type:'Polygon', coordinates:[[[70.50,40.00],[72.60,40.00],[72.60,41.00],[70.50,41.00],[70.50,40.00]]] } },
    { type:'Feature', properties:{ key:'andijan', name_ru:'Андижан', name_en:'Andijan', name_uz:'Andijon' },
      geometry:{ type:'Polygon', coordinates:[[[71.80,40.30],[73.20,40.30],[73.20,41.10],[71.80,41.10],[71.80,40.30]]] } },
    { type:'Feature', properties:{ key:'namangan', name_ru:'Наманган', name_en:'Namangan', name_uz:'Namangan' },
      geometry:{ type:'Polygon', coordinates:[[[70.80,40.80],[72.40,40.80],[72.40,41.60],[70.80,41.60],[70.80,40.80]]] } },
    { type:'Feature', properties:{ key:'qashqadaryo', name_ru:'Кашкадарья', name_en:'Qashqadaryo', name_uz:'Qashqadaryo' },
      geometry:{ type:'Polygon', coordinates:[[[63.50,37.50],[67.50,37.50],[67.50,39.50],[63.50,39.50],[63.50,37.50]]] } },
    { type:'Feature', properties:{ key:'surxondaryo', name_ru:'Сурхандарья', name_en:'Surxondaryo', name_uz:'Surxondaryo' },
      geometry:{ type:'Polygon', coordinates:[[[66.20,37.20],[68.30,37.20],[68.30,38.80],[66.20,38.80],[66.20,37.20]]] } },
    { type:'Feature', properties:{ key:'navoiy', name_ru:'Навои', name_en:'Navoiy', name_uz:'Navoiy' },
      geometry:{ type:'Polygon', coordinates:[[[63.00,39.80],[66.50,39.80],[66.50,42.20],[63.00,42.20],[63.00,39.80]]] } },
    { type:'Feature', properties:{ key:'jizzax', name_ru:'Джизак', name_en:'Jizzax', name_uz:'Jizzax' },
      geometry:{ type:'Polygon', coordinates:[[[66.80,39.80],[69.50,39.80],[69.50,41.20],[66.80,41.20],[66.80,39.80]]] } },
    { type:'Feature', properties:{ key:'sirdaryo', name_ru:'Сырдарья', name_en:'Sirdaryo', name_uz:'Sirdaryo' },
      geometry:{ type:'Polygon', coordinates:[[[68.20,40.00],[69.50,40.00],[69.50,41.00],[68.20,41.00],[68.20,40.00]]] } },
    { type:'Feature', properties:{ key:'xorazm', name_ru:'Хорезм', name_en:'Xorazm', name_uz:'Xorazm' },
      geometry:{ type:'Polygon', coordinates:[[[60.00,41.00],[61.80,41.00],[61.80,42.20],[60.00,42.20],[60.00,41.00]]] } },
    { type:'Feature', properties:{ key:'karakalpak', name_ru:'Каракалпакстан', name_en:'Karakalpakstan', name_uz:'Qoraqalpogʻiston' },
      geometry:{ type:'Polygon', coordinates:[[[55.50,41.00],[62.00,41.00],[62.00,45.50],[55.50,45.50],[55.50,41.00]]] } },
  ]
};

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json(UZ_REGIONS_GEOJSON);
}
