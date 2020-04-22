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
  "esri/core/Evented",
  "esri/core/watchUtils",
  "esri/core/promiseUtils",
  "esri/Map",
  "esri/Basemap",
  "esri/views/SceneView",
  "esri/layers/Layer",
  "esri/layers/BaseElevationLayer",
  "esri/layers/ElevationLayer",
  "esri/layers/GraphicsLayer",
  "esri/layers/BaseTileLayer",
  "esri/layers/TileLayer",
  "esri/layers/MapImageLayer",
  "esri/geometry/Point",
  "esri/geometry/Polyline",
  "esri/geometry/Polygon",
  "esri/geometry/Extent",
  "esri/geometry/Mesh",
  "esri/geometry/projection",
  "esri/geometry/SpatialReference",
  "esri/geometry/geometryEngine",
  "esri/geometry/support/meshUtils",
  "esri/Graphic"
], function(calcite, declare, on, domConstruct,
            Evented, watchUtils, promiseUtils, EsriMap, Basemap, SceneView,
            Layer, BaseElevationLayer, ElevationLayer, GraphicsLayer, BaseTileLayer, TileLayer, MapImageLayer,
            Point, Polyline, Polygon, Extent, Mesh, projection, SpatialReference, geometryEngine, meshUtils, Graphic){


  /**
   *
   */
  const ExaggeratedElevationLayer = BaseElevationLayer.createSubclass({

    properties: {
      sourceElevation: null,
      exaggeration: 15.0,
      bottomElevation: -1.0
    },

    load: function(){
      this.addResolvingPromise(this.sourceElevation.load());
    },

    fetchTile: function(level, row, col, options){
      //console.info(this.tileInfo)

      return this.sourceElevation.fetchTile(level, row, col, options).then((elevationData) => {
        if(options && options.signal && options.signal.aborted){
          throw promiseUtils.createAbortError();
        }

        const exaggeration = this.exaggeration;
        const bottomElevation = this.bottomElevation;

        for(let valueIdx = 0; valueIdx < elevationData.values.length; valueIdx++){

          if(elevationData.values[valueIdx] > 0){
            elevationData.values[valueIdx] = (elevationData.values[valueIdx] * exaggeration);
          } else {
            elevationData.values[valueIdx] = bottomElevation;
          }
        }

        return elevationData;
      });
    }
  });


  /**
   *
   */
  const BlendLayer = BaseTileLayer.createSubclass({

    properties: {
      multiplyLayers: null
    },

    load: function(){
      this.multiplyLayers.forEach((layer) => {
        this.addResolvingPromise(layer.load());
      }, this);
    },

    fetchTile: function(level, row, col, options){

      const tilePromises = this.multiplyLayers.map((layer) => {
        return layer.fetchTile(level, row, col, options);
      });

      return promiseUtils.eachAlways(tilePromises).then((results) => {
          if(options && options.signal && options.signal.aborted){
            throw promiseUtils.createAbortError();
          }

          const width = this.tileInfo.size[0];
          const height = this.tileInfo.size[0];
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");

          canvas.width = width;
          canvas.height = height;

          results.forEach((result, resultIdx) => {
            if(resultIdx < (results.length - 1)){

              const image = result.value;
              context.drawImage(image, 0, 0, width, height);

            } else {

              const imageData = context.getImageData(0, 0, width, height);
              const imagePixels = imageData.data;

              const elevationPixels = result.value.values;
              for(let pixelIdx = 0; pixelIdx < elevationPixels.length; pixelIdx++){
                if(elevationPixels[pixelIdx + Math.floor(pixelIdx / width)] < 1.0){
                  imagePixels[(pixelIdx * 4) + 3] = 0;
                }
              }
              context.putImageData(imageData, 0, 0);

            }
          });

          return canvas;
        }
      );
    }
  });


  return declare([Evented], {

    // INITIAL COUNTRY FILTER //
    initialCountryISOCode: "US", // "USA", "ESP" // "US", "ES", "AF",

    themeColor: "#EDEDED",

    surfaceColor: "#004575",
    countryFillColor: "rgba(0,69,117,1.0)",
    countryOutlineColor: "#ffffff",
    wallColor: "#004575",

    /**
     *
     */
    constructor: function(){
      calcite.init();
      this.initialize();
    },

    /**
     *
     */
    initialize: function(){

      // https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer
      // https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/TopoBathy3D/ImageServer

      const defaultElevationLayer = new ElevationLayer({ url: "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer" });
      const exaggeratedElevationLayer = new ExaggeratedElevationLayer({ sourceElevation: defaultElevationLayer });

      const defaultBaseLayer = new TileLayer({ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer" });
      //const defaultReferenceLayer = new TileLayer({ url: "https://server.arcgisonline.com/arcgis/rest/services/Reference/World_Transportation/MapServer" });
      //const blendBasemapLayer = new BlendLayer({ multiplyLayers: [defaultBaseLayer, defaultReferenceLayer, defaultElevationLayer] });
      const blendBasemapLayer = new BlendLayer({ multiplyLayers: [defaultBaseLayer, defaultElevationLayer] });


      this.initializeCountriesLayer().then(({ countriesLayer, countryExtent }) => {

        return this.createSceneView({
          exaggeratedElevationLayer,
          blendBasemapLayer,
          countriesLayer,
          initialExtent: countryExtent
        });

      });

    },

    /**
     *
     * @returns {Promise}
     */
    initializeCountriesLayer: function(){


      // COUNTRY LAYERS INFO //
      const countryLayerInfos = {
        "WORLD_COUNTRIES_GENERALIZED": {
          "ITEM_ID": "2b93b06dc0dc4e809d3c8db5cb96ba69",
          "ISO_FIELD": "ISO",
          "LABEL_FIELD": "Country",
          "AREA_FIELD": "Shape__Area",
          "initialCountryISOCode": "US",
          "useLargestFeature": []
        },
        "WORLD_COUNTRIES": {
          "ITEM_ID": "8de74fd8ba484e0ba2c0af9f32b08a1a",
          "ISO_FIELD": "ISO_2DIGIT",
          "LABEL_FIELD": "NAME",
          "AREA_FIELD": "Shape__Area",
          "initialCountryISOCode": "US",
          "useLargestFeature": ["US", "RU"]
        },
        "WORLD_COUNTRIES_VIZ": {
          "ITEM_ID": "3c7c5f75cc184a4ca89fe9c8c2154da5",
          "ISO_FIELD": "GID_0",
          "LABEL_FIELD": "NAME_0",
          "AREA_FIELD": "Shape__Area",
          "initialCountryISOCode": "USA",
          "useLargestFeature": ["USA", "RUS"]
        }
      };

      // COUNTRY LAYER INFO //
      const countryLayerInfo = countryLayerInfos.WORLD_COUNTRIES;

      // COUNTRY ISO CODE //
      this.initialCountryISOCode = countryLayerInfo.initialCountryISOCode;
      const urlParams = new URLSearchParams(window.location.search);
      if(urlParams.has("countryISO")){
        this.initialCountryISOCode = urlParams.get("countryISO");
      }

      //
      // LOAD COUNTRIES LAYER //
      //
      return Layer.fromPortalItem({ portalItem: { id: countryLayerInfo.ITEM_ID } }).then(countriesLayer => {
        return countriesLayer.load().then(() => {
          //console.info(countriesLayer.fields.map(f=>f.name).join(','));

          countriesLayer.outFields = [countryLayerInfo.ISO_FIELD, countryLayerInfo.LABEL_FIELD, countryLayerInfo.AREA_FIELD];
          countriesLayer.definitionExpression = `${countryLayerInfo.ISO_FIELD} <> '${this.initialCountryISOCode}'`;
          countriesLayer.renderer = {
            type: "simple",
            symbol: {
              type: "simple-fill",
              style: "solid",
              color: this.countryFillColor,
              outline: {
                style: "solid",
                color: this.countryOutlineColor,
                size: 10.0
              }
            }
          };

          const countriesQuery = countriesLayer.createQuery();
          countriesQuery.set({
            outSpatialReference: SpatialReference.WebMercator,
            where: `${countryLayerInfo.ISO_FIELD} = '${this.initialCountryISOCode}'`
          });

          const getCombinedExtent = () => {
            return countriesLayer.queryExtent(countriesQuery).then(extentInfo => {
              return (extentInfo.count > 0) ? extentInfo.extent : null;
            });
          };

          const getLargestExtent = () => {
            countriesQuery.set({
              orderByFields: [`${countryLayerInfo.AREA_FIELD} DESC`]
            });
            return countriesLayer.queryFeatures(countriesQuery).then(countriesFS => {
              if(countriesFS.features.length > 0){
                const countryFeature = countriesFS.features[0];
                return countryFeature.geometry.extent;
              } else {
                return null;
              }
            });
          };

          if(countryLayerInfo.useLargestFeature.includes(this.initialCountryISOCode)){

            return getLargestExtent().then(countryExtent => {
              return { countriesLayer, countryExtent };
            });

          } else {

            return getCombinedExtent().then(countryExtent => {
              return { countriesLayer, countryExtent };
            });

          }
        });
      });

    },

    /**
     *
     * @param countriesLayer
     * @param exaggeratedElevationLayer
     * @param blendBasemapLayer
     * @param initialExtent
     */
    createSceneView: function({ exaggeratedElevationLayer, blendBasemapLayer, countriesLayer, initialExtent }){

      // MAP //
      const map = new EsriMap({
        ground: { layers: [exaggeratedElevationLayer] },
        basemap: new Basemap({ baseLayers: [blendBasemapLayer] }),
        layers: [countriesLayer]
      });


      // VIEW //
      const view = new SceneView({
        container: "view-container",
        map: map,
        viewingMode: "local",
        //clippingArea: initialExtent,
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

        //view.map.ground.opacity = 0.9;
        view.map.ground.surfaceColor = this.surfaceColor;

        if(initialExtent){
          return view.goTo({ target: initialExtent }).then(() => {
            return watchUtils.whenNotOnce(view, "updating").then(() => {
              view.clippingArea = initialExtent;
              return view;
            });
          });
        } else {
          alert(`Could NOT find country with ISO code: ${this.initialCountryISOCode}`);
        }
      });

    }

  });
});
