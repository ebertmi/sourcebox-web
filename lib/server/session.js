'use strict';

var events = require('events');

var Promise = require('bluebird');
var _ = require('lodash');
var debug = require('debug')('sourcebox:session');

// sessions that are alive or in the process of being destroyed
var activeSessions = {};

function cleanup(reason) {
  return Promise.all(_.map(activeSessions, function (session) {
    return session._destroy(reason)
      .reflect();
  }));
}

// these events trigger a sandbox creation and call the corresponding
// session.onEVENT method when the sandbox is ready
var boxEvents = [
  'readFile', 'writeFile',
  //'exec',
];

var fsWraps = ['mkdir', 'rm', 'cp', 'ln'];
boxEvents = boxEvents.concat(fsWraps);

function eventToMethod(event) {
  return 'on' + _.capitalize(event);
}

class Session extends events.EventEmitter {
  constructor (server, id) {
    debug('created %s', id);

    super();

    this.id = id;
    this._sockets = {};
    this._server = server;

    activeSessions[id] = this;
  }

  _createBox() {
    if (!this._boxPromise) {
      this._boxPromise = this._server.source.box();
      //this._boxPromise = require('bluebird').reject(new Error('Wedfwqdw'));

      this._boxPromise
        .bind(this)
        .then(function (box) {
          debug('%s created sandbox %s', this.id, box.name);

          this.box = box;
        })
        .catch(function (err) {
          // fatal, couldnt create sandbox
          debug('%s failed to create sandbox: %s', this.id, err.message);
          this._destroy('internal server error');
        });
    }

    return this._boxPromise;
  }

  _bind(socket) {
    socket.on('disconnect', this._onDisconnect.bind(this, socket));

    var self = this;

    boxEvents.forEach(function (event) {
      var fn = self[eventToMethod(event)];

      socket.on(event, function () {
        var args = _.toArray(arguments);
        var callback = args.pop();

        if (!_.isFunction(callback)) {
          // no callback => bad client
          // maybe even disconnect this guy
          return;
        }

        self._createBox()
          .then(function () {
              self.socket = socket;
              return fn.apply(self, args);
          })
          .then(callback.bind(null, null))
          .catch(function (err) {
            callback(err.message);
          });
      });
    });
  }

  addSocket(socket) {
    if (socket.connected) {
      debug ('added socket %s to %s', socket.id, this.id);
      this._sockets[socket.id] = socket;
      this._bind(socket);
      clearTimeout(this.timeout);
    }
  }

  removeSocket(socket) {
    socket = this._sockets[socket.id];

    if (socket) {
      socket.disconnect();
    }
  }

  onReadFile(file) {
    if (!_.isString(file)) {
      debug('%s called readFile with invalid arguments', this.id);
      throw new TypeError('Invalid arguments');
    }

    debug('%s called readFile: file "%s"', this.id, file);

    return this.box.readFile(file, {
      encoding: null, // always send binary
      maxSize: 5 * 1024 * 1024 // 5 MiB
    });
  }

  onWriteFile(file, data, encoding) {
    if (!_.isString(file) || !(Buffer.isBuffer(data) || _.isString(data))) {
      debug('%s called writeFile with invalid arguments', this.id);
      throw new TypeError('Invalid arguments');
    }

    debug('%s called writeFile: file "%s", length: %s', this.id, file, data.length);

    return this.box.writeFile(file, data, {
      encoding
    });
  }

  _onDisconnect(socket) {
    debug('removed %s from %s', socket.id, this.id);
    delete this._sockets[socket.id];

    if (_.isEmpty(this._sockets) && !this._destroyed) {
      var timeout = this._server.sessionTimeout;

      debug('%s will time out in %dms', this.id, timeout);

      this.timeout = setTimeout(function () {
        this._destroy('time out')
          .catch(_.noop);
      }.bind(this), timeout);
    }
  }
  
  _destroy(reason) {
    if (this._destroyed) {
      return this._destroyed;
    }

    debug('destroying %s due to %s', this.id, reason);

    this.emit('destroy');

    _.forEach(this._sockets, function (socket) {
      socket.emit('fatal', reason);
      socket.removeAllListeners();
      socket.disconnect();
    });

    if (this._boxPromise) {
      // we have a sandbox or a sandbox in the process of being created

      this._destroyed = this._boxPromise
        .bind(this)
        .then(function (box) {
          // if it gets created, destroy it

          return box.destroy()
            .bind(this)
            .catch(function (err) {
              debug('%s: failed to destroy box %s: ',
                    this.id, box.name, err.message);
              throw err;
            });
        }, function () {
          // if creation fails there is nothing to destroy

          // the error is already handled earlier
        });
    } else {
      this._destroyed = Promise.bind(this);
    }

    return this._destroyed
      .finally(function () {
        delete activeSessions[this.id];
      });
  }
}

// hmmm, cant do this inside the class block :C

fsWraps.forEach(function (event) {
  var name = eventToMethod(event);

  Session.prototype[name] = function (files, options) {
    debug('%s called %s', this.id, event);
    return this.box[event](files, options);
  };
});


exports.Session = Session;
exports.cleanup = cleanup;
