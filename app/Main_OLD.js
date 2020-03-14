/*
  Copyright 2017 Esri

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.​
*/

define([
  "calcite",
  "dojo/_base/declare",
  "dojo/on",
  "dojo/dom-construct",
  "esri/core/watchUtils",
  "esri/Map",
  "esri/views/SceneView",
  "esri/layers/Layer",
  "esri/layers/GraphicsLayer",
  "esri/layers/MapImageLayer",
  "esri/geometry/Polygon",
  "esri/geometry/geometryEngine",
  "esri/Graphic"
], function(calcite, declare, on, domConstruct,
            watchUtils, esriMap, SceneView, Layer, GraphicsLayer, MapImageLayer,
            Polygon, geometryEngine, Graphic){

  return declare([], {


    // INITIAL COUNTRY FILTER //
    initialCountryISOCode: "ES",

    // THEME COLOR //
    themeColor: [237, 237, 237, 1.0],

    /**
     *
     */
    constructor: function(){
      calcite.init();
    },

    /**
     *
     */
    initialize: function(){
      // SCENE VIEW //
      return this.initializeView().then(view => {
        // COUNTRIES LAYER //
        return this.initializeCountriesLayer(view);
      });
    },

    /**
     *
     * @returns {*}
     */
    initializeView: function(){

      // const getShiftedSpatialReference = (centralMeridian) => {
      //   return { wkt: `PROJCS["APL Robinson",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Robinson"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${centralMeridian}],UNIT["Meter",1.0]]` };
      // };
      // const centralMeridian = (countryExtent.xmin + ((countryExtent.xmax - countryExtent.xmin) / 2.0));
      // view.spatialReference = getShiftedSpatialReference(centralMeridian);


      // MAP //
      const map = new esriMap({
        ground: "world-topobathymetry",
        basemap: "hybrid",
        //layers: [new MapImageLayer({ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer" })]
      });

      // VIEW //
      const view = new SceneView({
        container: "view-container",
        map: map,
        viewingMode: "local",
        environment: {
          atmosphere: null,
          starsEnabled: false,
          background: {
            type: "color",
            color: this.themeColor
          }
        }
      });

      return view.when(() => {
        return watchUtils.whenNotOnce(view, "updating").then(() => {

          /**
           *
           * @param countryExtent
           */
          this.updateViewClippingArea = (countryExtent) => {

            if(view.viewingMode === "local"){
              view.clippingArea = countryExtent;
            }

            view.goTo({
              target: countryExtent,
              tilt: 40,
              heading: 45
            }, { animate: false });

          };

          return view;
        });
      });
    },

    /**
     *
     * @returns {Promise}
     */
    initializeCountriesLayer: function(view){

      // COUNTRY LAYERS INFO //
      const countryLayerInfos = {
        "WORLD_COUNTRIES_GENERALIZED": {
          "ITEM_ID": "2b93b06dc0dc4e809d3c8db5cb96ba69",
          "ISO_FIELD": "ISO",
          "LABEL_FIELD": "Country"
        },
      };

      // COUNTRY LAYER INFO //
      const countryLayerInfo = countryLayerInfos.WORLD_COUNTRIES_GENERALIZED;

      let countryGeometryByISOCode = null;

      //
      // LOAD COUNTRIES LAYER //
      //
      return Layer.fromPortalItem({ portalItem: { id: countryLayerInfo.ITEM_ID } }).then(countriesLayer => {
        return countriesLayer.load().then(() => {
          countriesLayer.outFields = ["*"];

          // MASK GRAPHIC //
          const maskGraphic = new Graphic({
            symbol: {
              type: "simple-fill",
              color: this.themeColor,
              style: "solid",
              outline: {
                color: this.themeColor,
                style: "solid",
                width: 2.2
              }
            }
          });
          // MASK LAYER //
          const maskLayer = new GraphicsLayer({ graphics: [maskGraphic] });
          view.map.add(maskLayer);

          /**
           *
           * @param countryISOCode
           */
          this.filterByCountryISO = (countryISOCode) => {

            // COUNTRY GEOMETRY //
            const countryGeometry = countryGeometryByISOCode.get(countryISOCode);

            //
            // COUNTRY EXTENT //
            //
            const countryExtent_expanded = countryGeometry.extent.clone().expand(1.1);
            const countryExtent_normalized_parts = countryExtent_expanded.normalize();
            // TODO: IF SPLIT INTO TWO, THEN PICK THE ONE WITH THE LARGER AREA?
            const countryExtent_normalized = (countryExtent_normalized_parts.length > 1) ? countryExtent_normalized_parts[1] : countryExtent_normalized_parts[0];

            // MASK GEOMETRY //
            maskGraphic.geometry = geometryEngine.difference(countryExtent_normalized, countryGeometry);

            // UPDATE CLIPPING AREA //
            this.updateViewClippingArea(countryExtent_normalized);

          };

          // COUNTRY SELECT //
          const countrySelect = domConstruct.create("select");
          view.ui.add(countrySelect, "top-right");
          on(countrySelect, "change", () => {
            this.filterByCountryISO(countrySelect.value);
          });

          // GET ALL COUNTRIES //
          const countriesQuery = countriesLayer.createQuery();
          countriesQuery.set({
            orderByFields: [countryLayerInfo.LABEL_FIELD],
            returnGeometry: true
          });

          countriesLayer.queryFeatures(countriesQuery).then(countriesFS => {
            countryGeometryByISOCode = countriesFS.features.reduce((list, feature) => {

              const isoCode = feature.attributes[countryLayerInfo.ISO_FIELD];
              const countryLabel = feature.attributes[countryLayerInfo.LABEL_FIELD];

              domConstruct.create("option", {
                innerHTML: countryLabel,
                value: isoCode,
                selected: (isoCode === this.initialCountryISOCode)
              }, countrySelect);

              // UNION ALL COUNTRY GEOMETRIES //
              const countryGeometry = list.get(isoCode);
              if(countryGeometry){
                list.set(isoCode, geometryEngine.union([countryGeometry, feature.geometry]));
              } else {
                list.set(isoCode, feature.geometry)
              }

              return list;
            }, new Map());

            // SELECT INITIAL COUNTRY //
            this.filterByCountryISO(countrySelect.value);

          });

          return countriesLayer;
        });
      });

    }

  });
});


/*
"WORLD_COUNTRIES": {
  "ITEM_ID": "ac80670eb213440ea5899bbf92a04998",
  "ISO_FIELD": "ISO_CC",
  "LABEL_FIELD": "COUNTRY"
},
//geometryPrecision: 0,
//maxAllowableOffset: 10000,
 */


//const countryExtent_expanded_polygon = Polygon.fromExtent(countryExtent_expanded);

/*normalizeUtils.normalizeCentralMeridian([countryGeometry]).then(normalizedGeometries => {
  const countryGeometry_normalized = normalizedGeometries[0];

  const countryExtent_expanded = countryGeometry.extent.clone().expand(1.2);
  const countryExtent_expanded_polygon = Polygon.fromExtent(countryExtent_expanded);

  const countryExtent_expanded_polygon_normalized = normalizedGeometries[0];


  const countryExtent_clipped = geometryEngine.difference(countryExtent_expanded_polygon_normalized, countryGeometry_normalized);

  //const countryExtent_polygon = Polygon.fromExtent(countryExtent_normalized);
  //const countryExtent_dense = geometryEngine.geodesicDensify(countryExtent_polygon, 500, "kilometers");

  //const countryExtent_dense = geometryEngine.geodesicDensify(normalizedGeometries[0], 500, "kilometers");
  //const countryExtent_dense = geometryEngine.geodesicDensify(countryExtent_polygon, 500, "kilometers");
  //const countryExtent = countryExtent_dense ? countryExtent_dense.extent : countryExtent_expanded;

  //const countryExtent = normalizedGeometries[0];

  //const countryExtent_clipped = geometryEngine.difference(countryExtent, countryGeometry);

  // COUNTRY MASK //
  //maskGraphic.geometry = geometryEngine.difference(countryExtent, countryGeometry);

  const countryExtent = countryExtent_clipped;

  maskGraphic.geometry = countryExtent_clipped;

  // UPDATE CLIPPING AREA //
  this.updateViewClippingArea(countryExtent);

});*/
