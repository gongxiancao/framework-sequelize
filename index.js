
var _ = require('lodash'),
  fs = require('fs'),
  Sequelize = require('sequelize'),
  pathUtil = require('path'),
  Promise = require('bluebird');

var connections = {};

function lift (done) {
  var self = this;
  var modelsConfig = self.config.models;
  var defaultConnectionName = modelsConfig.connection;

  // expose Sequelize
  global.Sequelize = Sequelize;

  var modelsPath = self.config.paths.models = pathUtil.join(self.config.paths.root, 'api/models');

  var readdirAsync = Promise.promisify(fs.readdir),
    statAsync = Promise.promisify(fs.stat);

  readdirAsync(modelsPath)
    .then(function (fileNames) {
      var filePaths = _.map(fileNames, function (fileName) {
        return pathUtil.join(modelsPath, fileName);
      });

      return [fileNames, filePaths, Promise.map(filePaths, function (filePath) {
        var extname = pathUtil.extname(filePath);
        if(extname !== '.js') {
          return null;
        }
        return statAsync(filePath);
      })];
    })
    .spread(function (fileNames, filePaths, fileStats) {
      var models = {};
      // get model definitions and connection definitions
      _.each(fileNames, function (fileName, index) {
        var stat = fileStats[index];
        if(!stat || !stat.isFile()) {
          return;
        }

        var filePath = filePaths[index];
        var model = require(filePath);
        var modelName = pathUtil.basename(fileName, '.js');

        models[modelName] = model;
        model.options = model.options || {};

        // cache connection config
        var connectionName = model.options.connection = model.options.connection || defaultConnectionName;
        var connectionConfig = self.config.connections[connectionName];
        if(!connectionConfig) {
          throw new Error('cannot find connection config for ' + connectionName);
        }
        connections[connectionName] = connectionConfig;
      });

      // create used connections
      connections = _.mapValues(connections, function (connectionConfig) {
        var connection = new Sequelize(
          connectionConfig.database,
          connectionConfig.username,
          connectionConfig.password,
          connectionConfig.options);
        if(connectionConfig.sync) {
          connection.sync();
        }
        return connection;
      });

      self.models = _.mapValues(models, function (model, modelName) {
        var connectionName = model.options.connection || defaultConnectionName;
        var modelOptions = _.merge({}, modelsConfig.options, model.options);
        return connections[connectionName].define(modelName.toLowerCase(), model.attributes, modelOptions);
      });
      _.extend(global, self.models);
      return models;
    })
    .then(function (models) {
      _.each(models, function (model, modelName) {
        if(model.associationInitializer) {
          model.associationInitializer();          
        }
      });
    })
    .then(_.ary(done, 0))
    .catch(done);
}

function lower (done) {
  Promise.map(_.values(connections), function (connection) {
    return connection.close();
  }).asCallback(done);
}

module.exports = {
  lift: Promise.promisify(lift),
  lower: Promise.promisify(lower)
};
