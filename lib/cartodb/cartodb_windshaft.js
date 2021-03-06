
var _ = require('underscore')
    , Step       = require('step')
    , Windshaft = require('windshaft')
    , redisPool = new require('redis-mpool')(global.environment.redis)
    // TODO: instanciate cartoData with redisPool
    , cartoData  = require('cartodb-redis')(global.environment.redis)
    , SignedMaps = require('./signed_maps.js')
    , TemplateMaps = require('./template_maps.js')
    , Cache = require('./cache_validator');

var CartodbWindshaft = function(serverOptions) {

    if(serverOptions.cache_enabled) {
        console.log("cache invalidation enabled, varnish on ", serverOptions.varnish_host, ' ', serverOptions.varnish_port);
        Cache.init(serverOptions.varnish_host, serverOptions.varnish_port);
        serverOptions.afterStateChange = function(req, data, callback) {
            Cache.invalidate_db(req.params.dbname, req.params.table);
            callback(null, data);
        }
    }

    serverOptions.beforeStateChange = function(req, callback) {
        var err = null;
        if ( ! req.params.hasOwnProperty('dbuser') ) {
          err = new Error("map state cannot be changed by unauthenticated request!");
        }
        callback(err, req);
    }

    serverOptions.signedMaps = new SignedMaps(redisPool);
    var templateMaps = new TemplateMaps(redisPool, serverOptions.signedMaps);

    // boot
    var ws = new Windshaft.Server(serverOptions);

    // Override getVersion to include cartodb-specific versions
    var wsversion = ws.getVersion;
    ws.getVersion = function() {
      var version = wsversion();
      version.windshaft_cartodb = require('../../package.json').version;
      return version;
    }

    /**
     * Helper to allow access to the layer to be used in the maps infowindow popup.
     */
    ws.get(serverOptions.base_url + '/infowindow', function(req, res){
        ws.doCORS(res);
        Step(
            function(){
                serverOptions.getInfowindow(req, this);
            },
            function(err, data){
                if (err){
                    ws.sendError(res, {error: err.message}, 500, 'GET INFOWINDOW');
                    //res.send({error: err.message}, 500);
                } else {
                    res.send({infowindow: data}, 200);
                }
            }
        );
    });


    /**
     * Helper to allow access to metadata to be used in embedded maps.
     */
    ws.get(serverOptions.base_url + '/map_metadata', function(req, res){
        ws.doCORS(res);
        Step(
            function(){
                serverOptions.getMapMetadata(req, this);
            },
            function(err, data){
                if (err){
                    ws.sendError(res, {error: err.message}, 500, 'GET MAP_METADATA');
                    //res.send(err.message, 500);
                } else {
                    res.send({map_metadata: data}, 200);
                }
            }
        );
    });

    /**
     * Helper API to allow per table tile cache (and sql cache) to be invalidated remotely.
     * TODO: Move?
     */
    ws.del(serverOptions.base_url + '/flush_cache', function(req, res){
        ws.doCORS(res);
        Step(
            function flushCache(){
                serverOptions.flushCache(req, serverOptions.cache_enabled ? Cache : null, this);
            },
            function sendResponse(err, data){
                if (err){
                    ws.sendError(res, {error: err.message}, 500, 'DELETE CACHE');
                    //res.send(500);
                } else {
                    res.send({status: 'ok'}, 200);
                }
            }
        );
    });

    // ---- Template maps interface starts @{

    ws.userByReq = function(req) {
        return serverOptions.userByReq(req);
    }

    var template_baseurl = serverOptions.base_url_notable + '/template';

    // Add a template
    ws.post(template_baseurl, function(req, res) {
      ws.doCORS(res);
      var that = this;
      var response = {};
      var cdbuser = ws.userByReq(req);
      Step(
        function checkPerms(){
            serverOptions.authorizedByAPIKey(req, this);
        },
        function addTemplate(err, authenticated) {
          if ( err ) throw err;
          if (authenticated !== 1) {
            err = new Error("Only authenticated user can create templated maps");
            err.http_status = 401;
            throw err;
          }
          var next = this;
          if ( ! req.headers['content-type'] || req.headers['content-type'].split(';')[0] != 'application/json' )
            throw new Error('template POST data must be of type application/json');
          var cfg = req.body;
          templateMaps.addTemplate(cdbuser, cfg, this);
        },
        function prepareResponse(err, tpl_id){
          if ( err ) throw err;
          // NOTE: might omit "cdbuser" if == dbowner ...
          return { template_id: cdbuser + '@' + tpl_id };
        },
        function finish(err, response){
            if (err){
                response = { error: ''+err };
                var statusCode = 400;
                if ( ! _.isUndefined(err.http_status) ) {
                  statusCode = err.http_status;
                }
                ws.sendError(res, response, statusCode, 'POST TEMPLATE', err.message);
            } else {
              res.send(response, 200);
            }
        }
      );
    });

    // Update a template
    ws.put(template_baseurl + '/:template_id', function(req, res) {
      ws.doCORS(res);
      var that = this;
      var response = {};
      var cdbuser = ws.userByReq(req);
      var template;
      var tpl_id;
      Step(
        function checkPerms(){
            serverOptions.authorizedByAPIKey(req, this);
        },
        function updateTemplate(err, authenticated) {
          if ( err ) throw err;
          if (authenticated !== 1) {
            err = new Error("Only authenticated user can list templated maps");
            err.http_status = 401;
            throw err;
          }
          if ( ! req.headers['content-type'] || req.headers['content-type'].split(';')[0] != 'application/json' )
            throw new Error('template PUT data must be of type application/json');
          template = req.body;
          tpl_id = req.params.template_id.split('@');
          if ( tpl_id.length > 1 ) {
            if ( tpl_id[0] != cdbuser ) {
              err = new Error("Invalid template id '"
                + req.params.template_id + "' for user '" + cdbuser + "'");
              err.http_status = 404;
              throw err;
            }
            tpl_id = tpl_id[1];
          }
          templateMaps.updTemplate(cdbuser, tpl_id, template, this);
        },
        function prepareResponse(err){
          if ( err ) throw err;
          return { template_id: cdbuser + '@' + tpl_id };
        },
        function finish(err, response){
            if (err){
                var statusCode = 400;
                response = { error: ''+err };
                if ( ! _.isUndefined(err.http_status) ) {
                  statusCode = err.http_status;
                }
                ws.sendError(res, response, statusCode, 'PUT TEMPLATE', err.message);
            } else {
              res.send(response, 200);
            }
        }
      );
    });

    // Get a specific template
    ws.get(template_baseurl + '/:template_id', function(req, res) {
      ws.doCORS(res);
      var that = this;
      var response = {};
      var cdbuser = ws.userByReq(req);
      var template;
      var tpl_id;
      Step(
        function checkPerms(){
            serverOptions.authorizedByAPIKey(req, this);
        },
        function updateTemplate(err, authenticated) {
          if ( err ) throw err;
          if (authenticated !== 1) {
            err = new Error("Only authenticated users can get template maps");
            err.http_status = 401;
            throw err;
          }
          tpl_id = req.params.template_id.split('@');
          if ( tpl_id.length > 1 ) {
            if ( tpl_id[0] != cdbuser ) {
              var err = new Error("Cannot get template id '"
                + req.params.template_id + "' for user '" + cdbuser + "'");
              err.http_status = 404;
              throw err;
            }
            tpl_id = tpl_id[1];
          }
          templateMaps.getTemplate(cdbuser, tpl_id, this);
        },
        function prepareResponse(err, tpl_val){
          if ( err ) throw err;
          if ( ! tpl_val ) {
            err = new Error("Cannot find template '" + tpl_id + "' of user '" + cdbuser + "'");
            err.http_status = 404;
            throw err;
          }
          // auth_id was added by ourselves,
          // so we remove it before returning to the user
          delete tpl_val.auth_id;
          return { template: tpl_val };
        },
        function finish(err, response){
            if (err){
                var statusCode = 400;
                response = { error: ''+err };
                if ( ! _.isUndefined(err.http_status) ) {
                  statusCode = err.http_status;
                }
                ws.sendError(res, response, statusCode, 'GET TEMPLATE', err.message);
            } else {
              res.send(response, 200);
            }
        }
      );
    });

    // Delete a specific template
    ws.delete(template_baseurl + '/:template_id', function(req, res) {
      ws.doCORS(res);
      var that = this;
      var response = {};
      var cdbuser = ws.userByReq(req);
      var template;
      var tpl_id;
      Step(
        function checkPerms(){
            serverOptions.authorizedByAPIKey(req, this);
        },
        function updateTemplate(err, authenticated) {
          if ( err ) throw err;
          if (authenticated !== 1) {
            err = new Error("Only authenticated users can delete template maps");
            err.http_status = 401;
            throw err;
          }
          tpl_id = req.params.template_id.split('@');
          if ( tpl_id.length > 1 ) {
            if ( tpl_id[0] != cdbuser ) {
              var err = new Error("Cannot find template id '"
                + req.params.template_id + "' for user '" + cdbuser + "'");
              err.http_status = 404;
              throw err;
            }
            tpl_id = tpl_id[1];
          }
          templateMaps.delTemplate(cdbuser, tpl_id, this);
        },
        function prepareResponse(err, tpl_val){
          if ( err ) throw err;
          return { status: 'ok' };
        },
        function finish(err, response){
            if (err){
                var statusCode = 400;
                response = { error: ''+err };
                if ( ! _.isUndefined(err.http_status) ) {
                  statusCode = err.http_status;
                }
                ws.sendError(res, response, statusCode, 'DELETE TEMPLATE', err.message);
            } else {
              res.send('', 204);
            }
        }
      );
    });

    // Get a list of owned templates 
    ws.get(template_baseurl, function(req, res) {
      ws.doCORS(res);
      var that = this;
      var response = {};
      var cdbuser = ws.userByReq(req);
      Step(
        function checkPerms(){
            serverOptions.authorizedByAPIKey(req, this);
        },
        function listTemplates(err, authenticated) {
          if ( err ) throw err;
          if (authenticated !== 1) {
            err = new Error("Only authenticated user can list templated maps");
            err.http_status = 401;
            throw err;
          }
          templateMaps.listTemplates(cdbuser, this);
        },
        function prepareResponse(err, tpl_ids){
          if ( err ) throw err;
          // NOTE: might omit "cbduser" if == dbowner ...
          var ids = _.map(tpl_ids, function(id) { return cdbuser + '@' + id; })
          return { template_ids: ids };
        },
        function finish(err, response){
            var statusCode = 200;
            if (err){
                response = { error: ''+err };
                if ( ! _.isUndefined(err.http_status) ) {
                  statusCode = err.http_status;
                }
                ws.sendError(res, response, statusCode, 'GET TEMPLATE LIST', err.message);
            } else {
              res.send(response, statusCode);
            }
        }
      );
    });

    ws.setDBParams = function(cdbuser, params, callback) {
      Step(
        function setAuth() {
          serverOptions.setDBAuth(cdbuser, params, this);
        },
        function setConn(err) {
          if ( err ) throw err;
          serverOptions.setDBConn(cdbuser, params, this);
        },
        function finish(err) {
          callback(err);
        }
      );
    };

    // Instantiate a template
    ws.post(template_baseurl + '/:template_id', function(req, res) {
      ws.doCORS(res);
      var that = this;
      var response = {};
      var template;
      var signedMaps = serverOptions.signedMaps;
      var layergroup;
      var layergroupid;
      var fakereq; // used for call to createLayergroup
      var cdbuser = ws.userByReq(req);
      // Format of template_id: [<template_owner>]@<template_id>
      var tpl_id = req.params.template_id.split('@');
      if ( tpl_id.length > 1 ) {
        if ( tpl_id[0] ) cdbuser = tpl_id[0];
        tpl_id = tpl_id[1];
      }
      var auth_token = req.query.auth_token;
      Step(
        function getTemplate(){
          templateMaps.getTemplate(cdbuser, tpl_id, this);
        },
        function checkAuthorized(err, data) {
          if ( err ) throw err;
          if ( ! data ) {
            err = new Error("Template '" + tpl_id + "' of user '" + cdbuser + "' not found");
            err.http_status = 404;
            throw err;
          }
          template = data;
          var cert = templateMaps.getTemplateCertificate(template);
          var authorized = false;
          try {
            // authorizedByCert will throw if unauthorized
            authorized = signedMaps.authorizedByCert(cert, auth_token);
          } catch (err) {
            // we catch to add http_status
            err.http_status = 401;
            throw err;
          }
          if ( ! authorized ) {
            err = new Error('Unauthorized template instanciation');
            err.http_status = 401;
            throw err;
          }
          if ( ! req.headers['content-type'] || req.headers['content-type'].split(';')[0] != 'application/json' )
            throw new Error('template POST data must be of type application/json, it is instead ');
          var template_params = req.body;
          return templateMaps.instance(template, template_params);
        },
        function prepareParams(err, instance){
          if ( err ) throw err;
          layergroup = instance;
          fakereq = { query: {}, params: {}, headers: _.clone(req.headers) };
          ws.setDBParams(cdbuser, fakereq.params, this);
        },
        function createLayergroup(err) {
          if ( err ) throw err;
          ws.createLayergroup(layergroup, fakereq, this);
        },
        function signLayergroup(err, resp) {
          if ( err ) throw err;
          response = resp;
          var signer = cdbuser;
          var map_id = response.layergroupid.split(':')[0]; // dropping last_updated 
          var crt_id = template.auth_id; // check ?
          if ( ! crt_id ) {
            var errmsg = "Template '" + tpl_id + "' of user '" + cdbuser + "' has no signature";
            // Is this really illegal ?
            // Maybe we could just return an unsigned layergroupid
            // in this case...
            err = new Error(errmsg);
            err.http_status = 403; // Forbidden, we refuse to respond to this
            throw err;
          }
          signedMaps.signMap(signer, map_id, crt_id, this);
        },
        function prepareResponse(err) {
          if ( err ) throw err;
          //console.log("Response from createLayergroup: "); console.dir(response);
          // Add the signature part to the token!
          response.layergroupid = cdbuser + '@' + response.layergroupid;
          return response;
        },
        function finish(err, response){
            if (err){
                var statusCode = 400;
                response = { error: ''+err };
                if ( ! _.isUndefined(err.http_status) ) {
                  statusCode = err.http_status;
                }
                ws.sendError(res, response, statusCode, 'POST INSTANCE TEMPLATE', err.message);
            } else {
              res.send(response, 200);
            }
        }
      );
    });


    // ---- Template maps interface ends @}

    return ws;
}

module.exports = CartodbWindshaft;
