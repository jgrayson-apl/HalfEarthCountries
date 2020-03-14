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
  "esri/geometry/Polyline",
  "esri/geometry/Polygon",
  "esri/geometry/Mesh",
  "esri/geometry/geometryEngine",
  "esri/geometry/support/meshUtils",
  "esri/Graphic"
], function(calcite, declare, on, domConstruct,
            Evented, watchUtils, promiseUtils, esriMap, Basemap, SceneView,
            Layer, BaseElevationLayer, ElevationLayer, GraphicsLayer, BaseTileLayer, TileLayer,
            Polyline, Polygon, Mesh, geometryEngine, meshUtils, Graphic){


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
    initialCountryISOCode: "ES", // "ES", "AF",

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

      const urlParams = new URLSearchParams(window.location.search);
      if(urlParams.has("countryISO")){
        this.initialCountryISOCode = urlParams.get("countryISO");
      }

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


      // SCENE VIEW //
      return this.initializeView(exaggeratedElevationLayer, blendBasemapLayer).then(view => {

        // ELEVATION SAMPLER //
        this.initializeElevationSampler(view);

        // COUNTRIES LAYER //
        return this.initializeCountriesLayer(view);

      });
    },

    /**
     *
     * @returns {*}
     */
    initializeView: function(exaggeratedElevationLayer, blendBasemapLayer){

      //ground: "world-topobathymetry",  // world-elevation   world-topobathymetry"

      // MAP //
      const map = new esriMap({
        ground: { layers: [exaggeratedElevationLayer] },
        basemap: new Basemap({ baseLayers: [blendBasemapLayer] })
        //ground: "world-elevation",
        //basemap: "hybrid",
        //layers: [blendLayer]
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

        //view.map.ground.opacity = 0.9;
        view.map.ground.surfaceColor = this.surfaceColor;

        return watchUtils.whenNotOnce(view, "updating").then(() => {

          /**
           *
           * @param countryExtent
           */
          this.updateViewClippingArea = async(countryExtent) => {

            if(view.viewingMode === "local"){
              view.clippingArea = countryExtent;
            }

            return view.goTo({ target: countryExtent, tilt: 40, heading: 45 }, { animate: false }).then(() => {
              return watchUtils.whenNotOnce(view, "updating");
            });
          };

          return view;
        });
      });

    },

    /**
     *
     * @param view
     */
    initializeElevationSampler: function(view){

      view.groundView.elevationSampler.on("changed", () => {
        watchUtils.whenNotOnce(view.groundView, "updating").then(() => {
          this.emit("elevation-sampler-changed", {});
        });
      });

      this.interpolateShape = (geometry) => {
        return view.groundView.elevationSampler.queryElevation(geometry);
      };

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
        "WORLD_COUNTRIES": {
          "ITEM_ID": "8de74fd8ba484e0ba2c0af9f32b08a1a",
          "ISO_FIELD": "ISO_2DIGIT",
          "LABEL_FIELD": "NAME"
        },
        "WORLD_COUNTRIES_2": {
          "ITEM_ID": "7d721e9b74bf4b16bd43dfe489a5a533",
          "ISO_FIELD": "ISO_2DIGIT",
          "LABEL_FIELD": "NAME"
        }
      };

      // COUNTRY LAYER INFO //
      const countryLayerInfo = countryLayerInfos.WORLD_COUNTRIES;

      let countryGeometryByISOCode = null;

      const polygonToPolyline = polygon => {
        return new Polyline({
          spatialReference: polygon.spatialReference,
          paths: polygon.rings
        });
      };


      //
      // OCEANS LAYER //
      //
      /*Layer.fromPortalItem({ portalItem: { id: "ad70952edf6248189c9abceb15bb4f3f" } }).then(oceansLayer => {
        oceansLayer.load().then(() => {

          oceansLayer.currentStyleInfo.style.layers.forEach(styleLayer => {
            if(styleLayer.layout.visibility !== "none"){
              //console.info(styleLayer)
              const layoutProperties = oceansLayer.getPaintProperties(styleLayer.id);
              layoutProperties["fill-color"] = this.countryFillColor;
              oceansLayer.setPaintProperties(styleLayer.id, layoutProperties);
            }
          });

          //view.map.layers.add(oceansLayer);
        });
      });*/


      //
      // LOAD COUNTRIES LAYER //
      //
      return Layer.fromPortalItem({ portalItem: { id: countryLayerInfo.ITEM_ID } }).then(countriesLayer => {
        return countriesLayer.load().then(() => {

          countriesLayer.outFields = ["*"];
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
          view.map.layers.add(countriesLayer);

          const meshFillSymbol = {
            type: "fill",
            castShadows: true,
            material: { color: this.wallColor },
            edges: {
              type: "solid",
              color: this.wallColor,
              size: 5.0
            }
          };

          /*const borderGraphic = new Graphic({
            symbol: {
              type: "line-3d",
              symbolLayers: [{
                type: "path",
                anchor: "top",
                profile: "quad",
                profileRotation: "heading",
                castShadows: true,
                cap: "round",
                width: 100,
                height: 10000,
                material: { color: this.wallColor }
              }]
            }
          });*/

          const borderGraphic = new Graphic({
            symbol: {
              type: "mesh-3d",
              symbolLayers: [meshFillSymbol]
            }
          });

          // MASK GRAPHIC //
          /*const maskGraphic = new Graphic({
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
          });*/

          const maskGraphic = new Graphic({
            symbol: {
              type: "mesh-3d",
              symbolLayers: [meshFillSymbol]
            }
          });

          // MASK AND BORDER LAYER //
          const maskLayer = new GraphicsLayer({ graphics: [borderGraphic, maskGraphic] });
          view.map.add(maskLayer);


          const bottomElevation = -200000.0;

          const createNormalizedExtent = extent => {
            const normalized_parts = extent.clone().normalize();
            return (normalized_parts.length > 1) ? normalized_parts[1] : normalized_parts[0];
          };

          const createBorderMesh = (border) => {

            const dim = Math.max(view.extent.width, view.extent.height);
            const borderD = geometryEngine.densify(border, dim / 100, "meters");
            const borderDO = geometryEngine.offset(borderD, -1000, "meters", "round");
            const borderDOZ = this.interpolateShape(borderDO);

            return this.createExtrudedMesh(borderDOZ, bottomElevation);

          };

          /**
           *
           * @param countryISOCode
           */
          let updateId = 0;
          let samplerChangeHandle = null;
          this.filterByCountryISO = async(countryISOCode) => {

            //countriesLayer.definitionExpression = `${countryLayerInfo.ISO_FIELD} <> '${countryISOCode}'`;

            // COUNTRY GEOMETRY //
            //let countryGeometry = countryGeometryByISOCode.get(countryISOCode);

            let { countryExtent_normalized, countryExtentBorder } = countryGeometryByISOCode.get(countryISOCode);

            //countryGeometry = geometryEngine.geodesicDensify(countryGeometry, 1000, "meters");
            //countryGeometry = geometryEngine.geodesicBuffer(countryGeometry, 100, "meters", true);
            // COUNTRY BORDER //
            // const countryBorder = polygonToPolyline(countryGeometry);
            // let countryBorderZ = this.interpolateShape(countryBorder);
            // borderGraphic.geometry = this.createExtrudedMesh(countryBorderZ, bottomElevation);

            // BORDER GRAPHIC //
            //borderGraphic.geometry = this.interpolateShape(countryBorder);

            //
            // COUNTRY EXTENT //
            //

            // const countryExtent = countryGeometry.extent.clone().expand(1.1);
            // const countryExtent_normalized = createNormalizedExtent(countryExtent);

            // const countryExtentPoly = Polygon.fromExtent(countryExtent_normalized);
            // const countryExtentPolyB = geometryEngine.buffer(countryExtentPoly, 500, "meters");
            // const countryExtentBorder = polygonToPolyline(countryExtentPolyB);

            // UPDATE CLIPPING AREA //
            await this.updateViewClippingArea(countryExtent_normalized);

            //borderGraphic.geometry = createBorderMesh(countryExtentBorder);

            // EXTENT MASK //
            //const countryGeometry_buff = geometryEngine.geodesicBuffer(countryGeometry, 1000, "meters", true);
            //const countryExtent_diff = geometryEngine.difference(countryExtent_normalized, countryGeometry);
            //const countryExtent_diff_Z = this.setPolygonZ(countryExtent_diff, bottomElevation);

            // MASK GRAPHIC //
            //let countryMaskElev = this.interpolateShape(countryExtent_diff.clone());
            //let countryMaskElev = this.setPolygonZ(countryExtent_diff.clone(), bottomElevation);

            //let countryMaskMesh = Mesh.createFromPolygon(countryMaskElev);
            //maskGraphic.geometry = countryExtent_diff;
            //maskGraphic.geometry = Mesh.createFromPolygon(countryExtent_diff_Z);
            //maskGraphic.geometry = meshUtils.merge([countryBorderWall, countryMaskMesh]);
            //maskGraphic.geometry = countryBorderWall;

            /*samplerChangeHandle && samplerChangeHandle.remove();
            samplerChangeHandle = this.on("elevation-sampler-changed", () => {
              if(!updateId){
                updateId = setTimeout(() => {
                  updateId = 0;


                  if(!geometryEngine.within(view.extent,countryExtentBorder.extent)){
                    borderGraphic.geometry = createBorderMesh(countryExtentBorder);
                  }

                  //borderGraphic.geometry = this.interpolateShape(countryBorder.clone());
                  //maskGraphic.geometry = countryExtent_diff_Z;
                  //maskGraphic.geometry = Mesh.createFromPolygon(countryExtent_diff_Z);

                  // countryBorderZ = this.interpolateShape(countryBorder);
                  // countryBorderWall = this.createExtrudedMesh(countryBorderZ, bottomElevation);

                  // countryBorderZ = this.interpolateShape(countryBorder);
                  // borderGraphic.geometry = this.createExtrudedMesh(countryBorderZ, bottomElevation);

                  //countryMaskElev = this.interpolateShape(countryExtent_diff.clone());
                  //countryMaskElev = this.setPolygonZ(countryExtent_diff.clone(), bottomElevation);
                  //countryMaskMesh = Mesh.createFromPolygon(countryMaskElev);
                  //maskGraphic.geometry = meshUtils.merge([countryBorderWall, countryMaskMesh]);
                  //maskGraphic.geometry = countryBorderWall;

                }, 0);
              }
            });*/


          };

          // COUNTRY SELECT //
          const countrySelect = domConstruct.create("select");
          // view.ui.add(countrySelect, "top-right");
          // on(countrySelect, "change", () => {
          //   this.filterByCountryISO(countrySelect.value);
          // });

          // GET ALL COUNTRIES //
          const countriesQuery = countriesLayer.createQuery();
          countriesQuery.set({
            //where: "1=1",
            where: `${countryLayerInfo.ISO_FIELD} = '${this.initialCountryISOCode}'`,
            orderByFields: [countryLayerInfo.LABEL_FIELD],
            returnGeometry: true,
            geometryPrecision: 0,
            maxAllowableOffset: 10000
          });

          countriesLayer.queryFeatures(countriesQuery).then(countriesFS => {
            countryGeometryByISOCode = countriesFS.features.reduce((list, feature, featureIdx) => {

              const isoCode = feature.attributes[countryLayerInfo.ISO_FIELD];
              //const countryLabel = feature.attributes[countryLayerInfo.LABEL_FIELD];

              /* domConstruct.create("option", {
                 innerHTML: countryLabel,
                 value: isoCode,
                 selected: (isoCode === this.initialCountryISOCode)
               }, countrySelect);*/


              const countryExtent_normalized = createNormalizedExtent(feature.geometry.extent.clone().expand(1.1));
              const countryExtentPoly = Polygon.fromExtent(countryExtent_normalized);
              //const countryExtentPoly = geometryEngine.buffer(countryExtent_normalized, 500, "meters");
              const countryExtentBorder = polygonToPolyline(countryExtentPoly);

              // UNION ALL COUNTRY GEOMETRIES //
              /*const countryGeometry = list.get(isoCode);
              if(countryGeometry){
                list.set(isoCode, geometryEngine.union([countryGeometry, feature.geometry]));
              } else {
                list.set(isoCode, feature.geometry)
              }*/

              list.set(isoCode, { countryExtent_normalized, countryExtentBorder });

              return list;
            }, new Map());

            // SELECT INITIAL COUNTRY //
            //this.filterByCountryISO(countrySelect.value);
            this.filterByCountryISO(this.initialCountryISOCode);

          });

          return countriesLayer;
        });
      });

    },

    /**
     *
     * @param polygon
     * @param newZ
     * @returns {*}
     */
    setPolygonZ: function(polygon, newZ){

      polygon.hasZ = true;

      polygon.rings = polygon.rings.map(ring => {
        return ring.map(coords => {
          return coords.concat(newZ);
        });
      });

      return polygon;
    },


    /**
     * https://github.com/jkieboom/devsummit-palm-springs-2018/blob/master/demos/tectonic/js/PlateBoundaryLayer.ts
     *
     * Create an extruded mesh geometry along the line. This method
     * assumes the line has z-values that coincide with the ground
     * surface.
     *
     * @param line the line.
     * @param height
     */
    createExtrudedMesh: function(line, height){

      const meshes = line.paths.map(path => {
        return this._createExtrudedMesh(path, line.spatialReference, height);
      });

      return meshUtils.merge(meshes);
    },

    /**
     * https://github.com/jkieboom/devsummit-palm-springs-2018/blob/master/demos/tectonic/js/PlateBoundaryLayer.ts
     *
     * Create an extruded mesh geometry along the line path. This method
     * assumes the line has z-values that coincide with the ground
     * surface.
     *
     * @param path
     * @param spatialReference
     * @param height
     */
    _createExtrudedMesh: function(path, spatialReference, height){

      const position = this.createExtrudedPositionAttribute(path, height);

      const nSegments = (path.length - 1);
      const faces = new Uint32Array(nSegments * 2 * 3);
      let facePtr = 0;
      let vertexPtr = 0;

      // Create two triangle faces between each consecutive
      // pair of vertices in the line.
      for(let segmentIdx = 0; segmentIdx < nSegments; segmentIdx++){
        faces[facePtr++] = vertexPtr;
        faces[facePtr++] = vertexPtr + 3;
        faces[facePtr++] = vertexPtr + 1;

        faces[facePtr++] = vertexPtr;
        faces[facePtr++] = vertexPtr + 2;
        faces[facePtr++] = vertexPtr + 3;

        vertexPtr += 2;
      }

      return new Mesh({
        vertexAttributes: { position },
        components: [{ faces }],
        spatialReference: spatialReference
      });
    },

    /**
     * https://github.com/jkieboom/devsummit-palm-springs-2018/blob/master/demos/tectonic/js/PlateBoundaryLayer.ts
     *
     * Create the extruded vertex position attribute for
     * a given line path. The line is expected to have z-values
     * that coincide with the ground surface. The line is
     * extruded upwards by [height](#height).
     *
     * @param path
     * @param height
     */
    createExtrudedPositionAttribute: function(path, height){

      const position = new Float64Array(path.length * 2 * 3);
      let positionPtr = 0;

      for(let coordsIdx = 0; coordsIdx < path.length; coordsIdx++){
        position[positionPtr++] = path[coordsIdx][0];
        position[positionPtr++] = path[coordsIdx][1];
        position[positionPtr++] = path[coordsIdx][2];

        position[positionPtr++] = path[coordsIdx][0];
        position[positionPtr++] = path[coordsIdx][1];
        position[positionPtr++] = height; //path[coordsIdx][2] + height;
      }

      return position;
    }

  });
});


/*
"WORLD_COUNTRIES": {
  "ITEM_ID": "7d721e9b74bf4b16bd43dfe489a5a533",
  "ISO_FIELD": "ISO_2DIGIT",
  "LABEL_FIELD": "NAME"
},
//geometryPrecision: 0,
//maxAllowableOffset: 10000,
 */

